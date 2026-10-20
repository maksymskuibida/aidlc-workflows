#!/bin/bash
# A team Unit's step skipped for that Unit, and its last step followed by its landing (strategy merge,
# one repository, reviews on). Alpha in worktree pj-wa runs Functional Design, NFR Requirements and NFR
# Design; the person skips Infrastructure Design for alpha while it is alpha's step in progress, and
# alpha's walk goes on to Code Generation with no gate for the skipped step. The Code Generation gate
# and its approval name alpha's landing, not Build and Test. pj pins the candidate (the skipped step
# counts by its UNIT_SKIPPED receipt: no documents, review or gate), gates and lands it.
set -uo pipefail
S=$(cd "$(dirname "$0")" && pwd)
AV=${AIDLC_FIXTURE_VERSION:-$(cat "$HOME/.local/share/aidlc/active-version")}  # the installed build the fixture drives
export AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1 AIDLC_GH_BIN=$S/fakegh FAKE_GH_DB=$S/fakegh4.json
U=DEMO-2-alpha; B=DEMO-2/alpha; V=DEMO-3-beta; A=$HOME/.local/share/aidlc/versions/$AV/aidlc
R=aidlc/spaces/default/intents/261015-demo-1-uniform-test; REV=aidlc-architecture-reviewer-agent
FAIL=0
step() { echo; echo "##### $*"; }
expect() { case "$3" in *"$2"*) echo "   OK   $1";; *) echo "   FAIL $1 (wanted: $2)"; FAIL=$((FAIL+1));; esac; }
refute() { case "$3" in *"$2"*) echo "   FAIL $1 (unwanted: $2)"; FAIL=$((FAIL+1));; *) echo "   OK   $1";; esac; }
human() { T=$S/pj-transcript.jsonl; printf '{"type":"user","cwd":"%s","sessionId":"sim"}\n' "$PWD" > $T
  printf '{"session_id":"sim","transcript_path":"%s","cwd":"%s","hook_event_name":"UserPromptSubmit","prompt":"%s"}' "$T" "$PWD" "$1" | CLAUDE_PROJECT_DIR=$PWD aidlc engine hook record-human-turn >/dev/null 2>&1 || true; }
cfg() { env -i HOME="$HOME" PATH="$PATH" AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1 AIDLC_TEST_CONFIG_TTY=1 aidlc engine config set "$@" 2>&1 | tail -1; }
json() { python3 -c "import json,sys; raw=sys.stdin.read(); i=raw.find('{'); print(json.loads(raw[i:]).get('$1','') if i>=0 else '')" 2>/dev/null; }
review() { # $1 stage: request at the iteration the engine names, the reviewer's file, READY
  local N=1 OUT RF
  OUT=$(aidlc engine log review --stage $1 --reviewer $REV --unit $U --iteration $N 2>&1)
  case "$OUT" in *"next iteration is "*) N=$(echo "$OUT" | sed -E 's/.*next iteration is ([0-9]+).*/\1/'); OUT=$(aidlc engine log review --stage $1 --reviewer $REV --unit $U --iteration $N 2>&1);; esac
  RF=$(echo "$OUT" | json reviewFile)
  [ -n "$RF" ] || { echo "   FAIL $1 review request: $(echo "$OUT" | head -c 200)"; FAIL=$((FAIL+1)); return; }
  printf '## Review\n\n**Verdict:** READY\n**Reviewer:** %s\n**Date:** 2026-10-19\n**Iteration:** %s\n**Verdict Dictated:** no\n\n### Findings\n\nNo findings.\n' "$REV" "$N" > "$RF"
  OUT=$(aidlc engine log review --stage $1 --reviewer $REV --unit $U --iteration $N --verdict READY 2>&1)
  case "$OUT" in *REVIEW_COMPLETED*) ;; *) echo "   FAIL $1 review verdict: $(echo "$OUT" | head -c 200)"; FAIL=$((FAIL+1));; esac; }
stage() { # $1 stage: start, documents, review, complete, the per-stage gate approved
  aidlc engine state unit start --stage $1 --unit $U >/dev/null 2>&1
  bun $S/write-stage.ts $PWD $U $1 >/dev/null
  if [ $1 = code-generation ]; then # the code lives in the workspace repository itself
    mkdir -p app; echo "alpha feature" >> app/alpha.txt
    printf '{"stage":"%s","unit":"%s","version":1,"writes":[{"path":"app/alpha.txt"}]}' $1 $U > $R/construction/$U/$1/source-manifest.json
    python3 $S/next.py next >/dev/null 2>&1; python3 $S/next.py next >/dev/null 2>&1
  fi
  review $1
  aidlc engine state unit complete --stage $1 --unit $U >/dev/null 2>&1
  python3 $S/next.py next >/dev/null 2>&1
  human "Approve"
  aidlc engine orchestrate report --stage $1 --unit $U --result awaiting-approval >/dev/null 2>&1
  local G; G=$(aidlc engine orchestrate report --stage $1 --unit $U --result approved --user-input Approve 2>&1)
  case "$G" in *'"kind":"done"'*|*'"kind": "done"'*) echo "   $1 approved";; *) echo "   FAIL $1 gate: $(echo "$G" | grep -v 'bolt_dag is missing' | head -c 400)"; FAIL=$((FAIL+1));; esac; }


U_STAGES="functional-design nfr-requirements nfr-design"
for w in pj-wa; do [ -d $S/pj ] && git -C $S/pj worktree remove --force $S/$w 2>/dev/null; rm -rf $S/$w; done
$S/reset4.sh || exit 1
cd $S/pj || exit 1
step "one repository, reviews on, on main"
python3 - aidlc/spaces/default/intents/intents.json <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
for i in d: i.pop("repos", None)
json.dump(d, open(p, "w"), indent=2); open(p, "a").write("\n")
PY
cfg review adversarial
git add -- aidlc/spaces/default/intents/intents.json $R/aidlc-state.md && git commit -qm "one repository; reviews on" && git push -q origin HEAD:main

step "worktree pj-wa claims alpha"
git worktree add -q $S/pj-wa -b $B main
cd $S/pj-wa || exit 1
{ $S/pin-here.sh $AV || exit 1; }
aidlc engine intent switch 261015-demo-1-uniform-test >/dev/null 2>&1
CLAIM=$($A unit claim $U --team wa 2>&1); echo "$CLAIM" | head -c 200; echo
refute "alpha claimed" '"error"' "$CLAIM"
cfg guard.plan-approval off >/dev/null

step "the first three steps, each reviewed and approved"
python3 $S/next.py next >/dev/null 2>&1
for ST in $U_STAGES; do stage $ST; python3 $S/next.py next >/dev/null 2>&1; done

step "Infrastructure Design is alpha's step in progress; the person skips it for alpha"
D=$(python3 $S/next.py next 2>&1); echo "   next: $(echo "$D" | head -c 160)"
expect "the step in progress is Infrastructure Design for alpha" "infrastructure-design $U" "$(echo "$D" | json stage) $(echo "$D" | json unit)"
echo "   Current Stage here: $(grep -m1 'Current Stage' $R/aidlc-state.md)"
aidlc engine state unit start --stage infrastructure-design --unit $U >/dev/null 2>&1
human "skip infrastructure design for alpha"
SK=$(aidlc engine orchestrate report --stage infrastructure-design --unit $U --result skipped --reason "the person asked to skip it" 2>&1); echo "   $(echo "$SK" | head -c 260)"
expect "the skip is recorded for alpha only" "for unit \\\"$U\\\" only" "$SK"
refute "not refused" "Cannot skip" "$SK"

step "alpha goes on to Code Generation; its gate names alpha's landing"
D=$(python3 $S/next.py next 2>&1)
expect "next is Code Generation for alpha, not a gate for the skipped step" "code-generation" "$(echo "$D" | json stage)"
aidlc engine state unit start --stage code-generation --unit $U >/dev/null 2>&1
bun $S/write-stage.ts $PWD $U code-generation >/dev/null
mkdir -p app; echo "alpha feature" >> app/alpha.txt
printf '{"stage":"%s","unit":"%s","version":1,"writes":[{"path":"app/alpha.txt"}]}' code-generation $U > $R/construction/$U/code-generation/source-manifest.json
python3 $S/next.py next >/dev/null 2>&1; python3 $S/next.py next >/dev/null 2>&1
review code-generation
aidlc engine state unit complete --stage code-generation --unit $U >/dev/null 2>&1
GATE_STEP=$(python3 $S/next.py next 2>&1)
expect "the gate's next_stage is alpha's landing" "landing Unit $U" "$(echo "$GATE_STEP" | json next_stage)"
human "Approve"
OPEN=$(aidlc engine orchestrate report --stage code-generation --unit $U --result awaiting-approval 2>&1)
echo "   $(echo "$OPEN" | tail -1 | head -c 300)"
expect "the reply that opens the gate names alpha's landing" "landing Unit $U" "$(echo "$OPEN" | tail -1 | json next_stage)"
APP=$(aidlc engine orchestrate report --stage code-generation --unit $U --result approved --user-input Approve 2>&1); echo "   $(echo "$APP" | head -c 260)"
expect "the approval says next gives the steps that land alpha" "the steps that land it" "$APP"
refute "Build and Test is not next for alpha" "Build and Test" "$(echo "$GATE_STEP" | json next_stage) $(echo "$OPEN" | tail -1 | json next_stage)"
git add -- app $R/construction/$U $R/audit $R/aidlc-state.md; git commit -qm "[DEMO-2] alpha: code and construction record"; git log --oneline -1

step "publish from pj-wa"; PUB=$($A unit publish $U 2>&1); echo "$PUB" | head -c 200; echo
expect "published" '"published":true' "$PUB"

step "pin, bracket (strategy merge, target main), gate and land from pj"
cd $S/pj || exit 1
PIN=$($A unit pin $U 2>&1); echo "$PIN" | head -c 300; echo
expect "pinned" '"pinned_oid"' "$PIN"
refute "no incomplete evidence for the skipped step" "evidence is incomplete" "$PIN"
refute "no missing Infrastructure Design document" "missing required artifact" "$PIN"
OID=$(echo "$PIN" | json pinned_oid); GEN=$(echo "$PIN" | json generation); PID=$(echo "$PIN" | json pin_id)
aidlc engine bolt dispatch-event --event MERGE_DISPATCH_INVOKED --slug $U --pinned-oid "$OID" --attempt-generation "$GEN" --pin-id "$PID" --practices-excerpt "Units land with a local merge into main from the main checkout; no pull requests" >/dev/null 2>&1
RET=$(aidlc engine bolt dispatch-event --event MERGE_DISPATCH_RETURNED --slug $U --pinned-oid "$OID" --attempt-generation "$GEN" --pin-id "$PID" --strategy merge --target main --confidence 1 --notes "local merge into main" 2>&1)
refute "dispatch recorded" '"error"' "$RET"
human "Approve merge of alpha"
GATE=$($A unit gate $U --decision approve --user-input "Approve merge of alpha" 2>&1); echo "$GATE" | head -c 200; echo
refute "gate accepted" '"error"' "$GATE"
LAND=$($A unit land $U 2>&1); echo "$LAND" | head -c 200; echo
refute "land accepted" '"error"' "$LAND"
git push -q origin main; git fetch -q origin
expect "main has the code" "app/alpha.txt" "$(git ls-tree -r --name-only origin/main -- app 2>/dev/null)"
expect "one UNIT_MERGED on main" "1" "$(git grep -c 'Event\*\*: UNIT_MERGED' origin/main -- $R/audit | awk -F: '{s+=$NF} END{print s}')"
expect "main carries alpha's UNIT_SKIPPED" "UNIT_SKIPPED" "$(git grep -h 'Event\*\*: UNIT_SKIPPED' origin/main -- $R/audit)"
refute "alpha's row on main has no open step" "[ ]" "$(git show origin/main:$R/aidlc-state.md | grep "| $U | wa |" || echo '[ ] no row owned by wa')"
echo "   main state row: $(git show origin/main:$R/aidlc-state.md | grep "| $U |")"
echo; echo "RESULT: $FAIL expectation(s) failed"
exit $FAIL
