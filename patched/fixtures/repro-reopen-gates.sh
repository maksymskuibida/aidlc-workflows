#!/bin/bash
# The scoped reopen, through its gates, on the checkout repro-cycle.sh leaves behind (an approved,
# team-owned Unit on the per-stage rhythm, reviews on). From the Unit's own checkout,
# `--stage functional-design` prints the unpark and the reopen with every later step; after them each
# reopened step runs from its own `unit start`, gets its review, and asks its own approval before the
# next step is routed. Before patch 0008 carried the per-stage scope, the reopened steps ran with no
# gate of their own and the next step followed straight on.
set -uo pipefail
S=$(cd "$(dirname "$0")" && pwd)
export AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1 AIDLC_GH_BIN=$S/fakegh FAKE_GH_DB=$S/fakegh4.json
U=DEMO-2-alpha; REV=aidlc-architecture-reviewer-agent
FAIL=0
step() { echo; echo "##### $*"; }
expect() { # expect <label> <substring> <text>
  case "$3" in *"$2"*) echo "   OK   $1";; *) echo "   FAIL $1 (wanted: $2)"; FAIL=$((FAIL+1));; esac; }
field() { python3 -c "import json,sys; d=json.loads(sys.stdin.read() or '{}'); v=d.get('$1'); print('' if v is None else json.dumps(v) if not isinstance(v,str) else v)"; }
nxt() { python3 $S/next.py "$@" 2>/dev/null; }
human() { # the person types $1: the engine's own hook records the turn
  sleep 1; T=$S/pi-transcript.jsonl; printf '{"type":"user","cwd":"%s","sessionId":"sim"}\n' "$PWD" > $T
  printf '{"session_id":"sim","transcript_path":"%s","cwd":"%s","hook_event_name":"UserPromptSubmit","prompt":"%s"}' "$T" "$PWD" "$1" | CLAUDE_PROJECT_DIR=$PWD aidlc engine hook record-human-turn >/dev/null 2>&1 || true; }
review() { # $1 stage: request at the iteration the engine names, write the reviewer's file, record READY
  N=1
  OUT=$(aidlc engine log review --stage $1 --reviewer $REV --unit $U --iteration $N 2>&1)
  case "$OUT" in *"next iteration is "*) N=$(echo "$OUT" | sed -E 's/.*next iteration is ([0-9]+).*/\1/'); OUT=$(aidlc engine log review --stage $1 --reviewer $REV --unit $U --iteration $N 2>&1);; esac
  RF=$(echo "$OUT" | python3 -c "import json,sys; raw=sys.stdin.read(); i=raw.find('{'); d=json.loads(raw[i:]) if i>=0 else {}; print(d.get('reviewFile',''))")
  expect "$1 review requested" "REVIEW_REQUESTED" "$OUT"; [ -n "$RF" ] || return
  printf '## Review\n\n**Verdict:** READY\n**Reviewer:** %s\n**Date:** 2026-10-18\n**Iteration:** %s\n**Verdict Dictated:** no\n\n### Findings\n\nNo findings.\n' "$REV" "$N" > "$RF"
  expect "$1 review recorded" "REVIEW_COMPLETED" "$(aidlc engine log review --stage $1 --reviewer $REV --unit $U --iteration $N --verdict READY 2>&1)"; }

[ -d $S/pi ] || { echo "run repro-cycle.sh first: it leaves the approved Unit's checkout fixtures/pi"; exit 2; }
cd $S/pi
step "next --stage functional-design → the unpark and the reopen with every later step"
D=$(nxt next --stage functional-design); MSG=$(echo "$D" | field message); echo "   $MSG" | cut -c1-300
expect "reopen printed" "jump reopen --target functional-design --stages functional-design,nfr-requirements" "$MSG"
step "run the printed commands"
echo "$MSG" | grep -oE '`aidlc engine (state unpark|jump reopen[^`]*)`' | tr -d '`' | while read -r CMD; do echo "   \$ $CMD"; $CMD 2>&1 | tail -1; done
expect "rejection carries the per-stage scope" "**Gate Scope**: per-stage" "$(grep -h -B1 -A6 'Event\*\*: GATE_REJECTED' aidlc/spaces/default/intents/*/audit/*.md | tail -9)"
for ST in functional-design nfr-requirements; do
  step "$ST: next → the Unit's pass"; D=$(nxt next); echo "   $(echo "$D" | field kind) $(echo "$D" | field stage) gate=$(echo "$D" | field gate)"
  expect "$ST routed" "\"stage\": \"$ST\"" "$D"
  step "$ST: unit start, documents, review, unit complete"
  expect "$ST started" "UNIT_STARTED" "$(aidlc engine state unit start --stage $ST --unit $U 2>&1)"
  bun $S/write-stage.ts $S/pi $U $ST >/dev/null
  review $ST
  expect "$ST completed" "UNIT_COMPLETED" "$(aidlc engine state unit complete --stage $ST --unit $U 2>&1)"
  step "$ST: next → its own approval"; D=$(nxt next); echo "   $(echo "$D" | field kind) $(echo "$D" | field stage) gate=$(echo "$D" | field gate) unit_gate=$(echo "$D" | field unit_gate)"
  expect "$ST gate presented" '"gate": true' "$D"; expect "$ST is a per-stage Unit gate" '"unit_gate": "per-stage"' "$D"
  human "Approve"
  aidlc engine orchestrate report --stage $ST --unit $U --result awaiting-approval >/dev/null 2>&1
  expect "$ST approved" '"kind": "done"' "$(aidlc engine orchestrate report --stage $ST --unit $U --result approved --user-input Approve 2>&1 | python3 -c "import json,sys; raw=sys.stdin.read(); i=raw.find('{'); print(json.dumps(json.loads(raw[i:])) if i>=0 else raw)")"
done
step "next → NFR Design, the third reopened step"; D=$(nxt next); echo "   $(echo "$D" | field kind) $(echo "$D" | field stage) gate=$(echo "$D" | field gate)"
expect "nfr-design routed" '"stage": "nfr-design"' "$D"
echo; echo "RESULT: $FAIL expectation(s) failed"
exit $FAIL
