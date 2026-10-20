#!/bin/bash
# A team Unit with reviews on, landed through strategy pr. Alpha in pi: every stage gets its review
# (written to the git-ignored review record, as in a real project), Functional Design is reopened once
# with a row in the shape the engine wrote before reopen rows carried the claim's attempt generation and
# then once more by this engine, and the Unit is then published, pinned, gated, landed and finished. Pin must count every review
# (their records travel in the candidate) and read every receipt against the floor it was stamped with.
set -uo pipefail
S=$(cd "$(dirname "$0")" && pwd)
V=${AIDLC_FIXTURE_VERSION:-$(cat "$HOME/.local/share/aidlc/active-version")}  # the installed build the fixture drives
export AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1 AIDLC_GH_BIN=$S/fakegh FAKE_GH_DB=$S/fakegh4.json
U=DEMO-2-alpha; B=DEMO-2/alpha; A=$HOME/.local/share/aidlc/versions/$V/aidlc
R=aidlc/spaces/default/intents/261015-demo-1-uniform-test; REV=aidlc-architecture-reviewer-agent
FAIL=0
step() { echo; echo "##### $*"; }
expect() { case "$3" in *"$2"*) echo "   OK   $1";; *) echo "   FAIL $1 (wanted: $2)"; FAIL=$((FAIL+1));; esac; }
refute() { case "$3" in *"$2"*) echo "   FAIL $1 (unwanted: $2)"; FAIL=$((FAIL+1));; *) echo "   OK   $1";; esac; }
human() { T=$S/pi-transcript.jsonl; printf '{"type":"user","cwd":"%s","sessionId":"sim"}\n' "$PWD" > $T
  printf '{"session_id":"sim","transcript_path":"%s","cwd":"%s","hook_event_name":"UserPromptSubmit","prompt":"%s"}' "$T" "$PWD" "$1" | CLAUDE_PROJECT_DIR=$PWD aidlc engine hook record-human-turn >/dev/null 2>&1 || true; }
review() { # $1 stage: request at the iteration the engine names, the reviewer's file, READY
  local N=1 OUT RF
  OUT=$(aidlc engine log review --stage $1 --reviewer $REV --unit $U --iteration $N 2>&1)
  case "$OUT" in *"next iteration is "*) N=$(echo "$OUT" | sed -E 's/.*next iteration is ([0-9]+).*/\1/'); OUT=$(aidlc engine log review --stage $1 --reviewer $REV --unit $U --iteration $N 2>&1);; esac
  RF=$(echo "$OUT" | python3 -c "import json,sys; raw=sys.stdin.read(); i=raw.find('{'); d=json.loads(raw[i:]) if i>=0 else {}; print(d.get('reviewFile',''))")
  [ -n "$RF" ] || { echo "   FAIL $1 review request: $(echo "$OUT" | head -c 200)"; FAIL=$((FAIL+1)); return; }
  printf '## Review\n\n**Verdict:** READY\n**Reviewer:** %s\n**Date:** 2026-10-18\n**Iteration:** %s\n**Verdict Dictated:** no\n\n### Findings\n\nNo findings.\n' "$REV" "$N" > "$RF"
  OUT=$(aidlc engine log review --stage $1 --reviewer $REV --unit $U --iteration $N --verdict READY 2>&1)
  case "$OUT" in *REVIEW_COMPLETED*) ;; *) echo "   FAIL $1 review verdict: $(echo "$OUT" | head -c 200)"; FAIL=$((FAIL+1));; esac; }
stage() { # $1 stage: start, documents, review, complete, the per-stage gate approved
  aidlc engine state unit start --stage $1 --unit $U >/dev/null 2>&1
  bun $S/write-stage.ts $S/pi $U $1 >/dev/null
  if [ $1 = code-generation ]; then # the code itself and the files it wrote; next records the plan (approval off)
    echo "alpha feature" >> svc/README.md
    printf '{"stage":"%s","unit":"%s","version":1,"writes":[{"path":"svc/README.md"}]}' $1 $U > $R/construction/$U/$1/source-manifest.json
    python3 $S/next.py next >/dev/null 2>&1; python3 $S/next.py next >/dev/null 2>&1
  fi
  review $1
  aidlc engine state unit complete --stage $1 --unit $U >/dev/null 2>&1
  python3 $S/next.py next >/dev/null 2>&1
  human "Approve"
  aidlc engine orchestrate report --stage $1 --unit $U --result awaiting-approval >/dev/null 2>&1
  local G; G=$(aidlc engine orchestrate report --stage $1 --unit $U --result approved --user-input Approve 2>&1)
  # A reopen row from before reopens carried the gate's scope reopens no per-stage gate: the stage stays approved.
  case "$G" in *'"kind":"done"'*|*'"kind": "done"'*) echo "   $1 approved";; *"is already approved"*) echo "   $1 still approved (the old reopen row reopened no gate)";; *) echo "   FAIL $1 gate: $(echo "$G" | grep -v 'bolt_dag is missing' | head -c 400)"; FAIL=$((FAIL+1));; esac; }

$S/reset4.sh || exit 1
cd $S/pi || exit 1
step "reviews on for the work, on main, before any claim"
env -i HOME="$HOME" PATH="$PATH" AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1 AIDLC_TEST_CONFIG_TTY=1 aidlc engine config set review adversarial 2>&1 | tail -1
git add -- $R/aidlc-state.md && git commit -qm "reviews on" && git push -q origin HEAD:main
step claim; $A unit claim $U --team pi | head -c 160; echo
git switch -c $B >/dev/null 2>&1; git -C svc switch -c $B >/dev/null 2>&1
env -i HOME="$HOME" PATH="$PATH" AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1 AIDLC_TEST_CONFIG_TTY=1 aidlc engine config set guard.plan-approval off >/dev/null 2>&1
SHARD=$R/audit/$(python3 -c "import json;print(json.load(open('aidlc/.aidlc-unit-scope.json'))['audit_shard'])")
step "Functional Design with its review"; python3 $S/next.py next >/dev/null 2>&1; stage functional-design
step "an unstamped reopen of Functional Design, the shape the engine wrote before reopen rows carried the generation"
sleep 1; TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '\n## Gate Rejected\n**Timestamp**: %s\n**Event**: GATE_REJECTED\n**Stage**: functional-design\n**Gate Stages**: functional-design\n**Gate Scope**: unit-end\n**Unit**: %s\n**Reopen**: change\n**User Input**: Request Changes\n**Feedback**: Reopened Functional Design for unit %s for a change.\n\n---\n' "$TS" "$U" "$U" >> $SHARD
step "then a reopen with this engine (a stamped row), as followed the old ones in a real Unit"
sleep 1; aidlc engine jump reopen --target functional-design --stages functional-design --units $U 2>&1 | tail -1 | head -c 160; echo
step "every stage with its review"
python3 $S/next.py next >/dev/null 2>&1
for ST in functional-design nfr-requirements nfr-design infrastructure-design code-generation; do stage $ST; python3 $S/next.py next >/dev/null 2>&1; done
expect "review records are git-ignored here, as in every project" ".aidlc-engine" "$(git check-ignore -v $R/.aidlc-engine/reviews 2>&1)"
step "code PR"
git -C svc add -A; git -C svc commit -qm "[DEMO-2] alpha"; git -C svc push -q -u origin $B
$A unit pr $U --repo svc >/dev/null
$S/merge_pr.sh $S/svc4.git $B $FAKE_GH_DB example/svc#1 pj >/dev/null
git add -- $R/construction/$U $R/audit $R/aidlc-state.md; git commit -qm "[DEMO-2] alpha: construction record"
step publish; PUB=$($A unit publish $U 2>&1); echo "$PUB" | head -c 260; echo
expect "published" '"published":true' "$PUB"
CAND=$(echo "$PUB" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("candidate_oid",""))' 2>/dev/null)
expect "the candidate carries the Unit's review records" "$R/.aidlc-engine/reviews/" "$(git ls-tree -r --name-only $CAND -- $R/.aidlc-engine 2>/dev/null)"
expect "the candidate carries the unstamped reopen" "**Timestamp**: $TS" "$(git show $CAND:$SHARD 2>/dev/null | grep -B1 'Event\*\*: GATE_REJECTED')"
step pin; PIN=$($A unit pin $U 2>&1); echo "$PIN" | head -c 300; echo
expect "pinned" '"pinned_oid"' "$PIN"
refute "no incomplete evidence" "evidence is incomplete" "$PIN"
OID=$(echo "$PIN" | python3 -c 'import json,sys;print(json.load(sys.stdin)["pinned_oid"])' 2>/dev/null); GEN=$(echo "$PIN" | python3 -c 'import json,sys;print(json.load(sys.stdin)["generation"])' 2>/dev/null); PID=$(echo "$PIN" | python3 -c 'import json,sys;print(json.load(sys.stdin)["pin_id"])' 2>/dev/null)
step "bracket, gate, land"
aidlc engine bolt dispatch-event --event MERGE_DISPATCH_INVOKED --slug $U --pinned-oid "$OID" --attempt-generation "$GEN" --pin-id "$PID" --practices-excerpt "PRs only" >/dev/null 2>&1
aidlc engine bolt dispatch-event --event MERGE_DISPATCH_RETURNED --slug $U --pinned-oid "$OID" --attempt-generation "$GEN" --pin-id "$PID" --strategy pr --target $B --confidence 1 --notes "squash PR" >/dev/null 2>&1
GATE=$($A unit gate $U --decision approve --user-input "Approve merge of alpha" 2>&1); refute "gate accepted" '"error"' "$GATE"
LAND=$($A unit land $U 2>&1); echo "$LAND" | head -c 200; echo; refute "land accepted" '"error"' "$LAND"
git push -q -u origin $B
step "workspace PR, finish"
$A unit pr $U >/dev/null 2>&1; $S/merge_pr.sh $S/wsp4.git $B $FAKE_GH_DB example/ws#1 pj >/dev/null
FIN=$($A unit finish $U 2>&1); echo "$FIN" | head -c 200; echo; expect "finished" '"finished":true' "$FIN"
git fetch -q origin
refute "main never receives review records" "$R/.aidlc-engine/" "$(git ls-tree -r --name-only origin/main -- $R 2>/dev/null)"
echo; echo "RESULT: $FAIL expectation(s) failed"
exit $FAIL
