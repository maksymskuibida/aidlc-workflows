#!/bin/bash
# Strategy merge, the way a one-repository project runs it: one main checkout (pj, on main, never
# scoped) and a git worktree of it per Unit, code and records in the same repository, reviews on.
# Alpha in worktree pj-wa: that worktree's own audit shard is on main first (it ran earlier phases, as
# in 0012's case), every stage is reviewed (0013) and approved per stage, and the code goes into the
# workspace itself, so no service pull request. The worktree publishes; pj pins, brackets the dispatch
# with --strategy merge --target main, gates, lands and pushes main. Beta, which needs alpha, is tried
# in a second worktree pj-wb before the land (refused) and after it (claimed).
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

for w in pj-wa pj-wb; do [ -d $S/pj ] && git -C $S/pj worktree remove --force $S/$w 2>/dev/null; rm -rf $S/$w; done
$S/reset4.sh || exit 1
cd $S/pj || exit 1
step "one repository (the intent names no code repository), reviews on, on main, before any claim"
python3 - aidlc/spaces/default/intents/intents.json <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
for i in d: i.pop("repos", None)
json.dump(d, open(p, "w"), indent=2); open(p, "a").write("\n")
PY
cfg review adversarial
git add -- aidlc/spaces/default/intents/intents.json $R/aidlc-state.md && git commit -qm "one repository; reviews on" && git push -q origin HEAD:main

step "worktree pj-wa for alpha; its own shard reaches main, as the earlier phases' rows did"
git worktree add -q $S/pj-wa -b $B main
cd $S/pj-wa || exit 1
{ $S/pin-here.sh $AV || exit 1; }   # every worktree registers itself, as the project README says
aidlc engine intent switch 261015-demo-1-uniform-test >/dev/null 2>&1
human "earlier phase work in this worktree"
OWN=$(git status --porcelain -- $R/audit | awk '{print $2}' | head -1); echo "   pj-wa's shard: $OWN"
[ -n "$OWN" ] && git add -- $OWN && git commit -qm "earlier phases: pj-wa's audit rows" && git push -q origin HEAD:main
BASE_OWN=$(git rev-parse HEAD:$OWN 2>/dev/null)
git -C $S/pj pull -q --ff-only

step "claim alpha in pj-wa"; CLAIM=$($A unit claim $U --team wa 2>&1); echo "$CLAIM" | head -c 240; echo
refute "alpha claimed" '"error"' "$CLAIM"
cfg guard.plan-approval off >/dev/null
SHARD=$R/audit/$(python3 -c "import json;print(json.load(open('aidlc/.aidlc-unit-scope.json'))['audit_shard'])" 2>/dev/null)
echo "   alpha's claim-bound shard: $SHARD"
refute "alpha's shard is not the one main already holds" "$OWN" "$SHARD"

step "every stage with its review"
python3 $S/next.py next >/dev/null 2>&1
for ST in functional-design nfr-requirements nfr-design infrastructure-design code-generation; do stage $ST; python3 $S/next.py next >/dev/null 2>&1; done
expect "review records are git-ignored here, as in every project" ".aidlc-engine" "$(git check-ignore -v $R/.aidlc-engine/reviews 2>&1)"
git add -- app $R/construction/$U $R/audit $R/aidlc-state.md; git commit -qm "[DEMO-2] alpha: code and construction record"; git log --oneline -1

step "publish from pj-wa"; PUB=$($A unit publish $U 2>&1); echo "$PUB" | head -c 260; echo
expect "published" '"published":true' "$PUB"
CAND=$(echo "$PUB" | json candidate_oid)
expect "the candidate carries the code" "app/alpha.txt" "$(git ls-tree -r --name-only $CAND -- app 2>/dev/null)"
expect "the candidate carries the Unit's review records" "$R/.aidlc-engine/reviews/" "$(git ls-tree -r --name-only $CAND -- $R/.aidlc-engine 2>/dev/null)"
[ -n "$BASE_OWN" ] && expect "pj-wa's shard bytes unchanged in the candidate" "$BASE_OWN" "$(git rev-parse $CAND:$OWN 2>&1)"
echo "   pj-wa after publish: $(git status --short | wc -l | tr -d ' ') changed path(s)"

step "beta in a second worktree before alpha lands (expect: refused, it needs alpha)"
git -C $S/pj worktree add -q $S/pj-wb -b DEMO-3/beta main
cd $S/pj-wb || exit 1; { $S/pin-here.sh $AV || exit 1; }; aidlc engine intent switch 261015-demo-1-uniform-test >/dev/null 2>&1
EARLY=$($A unit claim $V --team wb 2>&1); RC=$?; echo "   rc=$RC $(echo "$EARLY" | head -c 300)"
[ $RC -ne 0 ] && echo "   OK   beta refused before alpha lands" || { echo "   FAIL beta claimed before alpha landed"; FAIL=$((FAIL+1)); }

step "pin, bracket (strategy merge, target main), gate and land from the main checkout pj"
cd $S/pj || exit 1; git status --short | head -5
PIN=$($A unit pin $U 2>&1); echo "$PIN" | head -c 300; echo
expect "pinned" '"pinned_oid"' "$PIN"
refute "no incomplete evidence" "evidence is incomplete" "$PIN"
refute "no ownership refusal" "violates claimed Unit ownership" "$PIN"
OID=$(echo "$PIN" | json pinned_oid); GEN=$(echo "$PIN" | json generation); PID=$(echo "$PIN" | json pin_id)
aidlc engine bolt dispatch-event --event MERGE_DISPATCH_INVOKED --slug $U --pinned-oid "$OID" --attempt-generation "$GEN" --pin-id "$PID" --practices-excerpt "Units land with a local merge into main from the main checkout; no pull requests" >/dev/null 2>&1
RET=$(aidlc engine bolt dispatch-event --event MERGE_DISPATCH_RETURNED --slug $U --pinned-oid "$OID" --attempt-generation "$GEN" --pin-id "$PID" --strategy merge --target main --confidence 1 --notes "local merge into main" 2>&1)
refute "dispatch recorded" '"error"' "$RET"
refute "a merge landing asks nothing about a pull request" "merge_gate" "$RET"
human "Approve merge of alpha"
GATE=$($A unit gate $U --decision approve --user-input "Approve merge of alpha" 2>&1); echo "$GATE" | head -c 200; echo
refute "gate accepted" '"error"' "$GATE"
LAND=$($A unit land $U 2>&1); echo "$LAND" | head -c 300; echo
refute "land accepted" '"error"' "$LAND"
git log --oneline -4
git push -q origin main; git fetch -q origin
expect "main has the code" "app/alpha.txt" "$(git ls-tree -r --name-only origin/main -- app 2>/dev/null)"
refute "alpha's row on main has an owner and no open stage" "[ ]" "$(git show origin/main:$R/aidlc-state.md | grep "| $U | wa |" || echo '[ ] no row owned by wa')"
expect "one UNIT_MERGED on main" "1" "$(git grep -c 'Event\*\*: UNIT_MERGED' origin/main -- $R/audit | awk -F: '{s+=$NF} END{print s}')"
refute "main never receives review records" "$R/.aidlc-engine/" "$(git ls-tree -r --name-only origin/main -- $R 2>/dev/null)"
[ -n "$BASE_OWN" ] && expect "main keeps pj-wa's shard bytes" "$BASE_OWN" "$(git rev-parse origin/main:$OWN 2>&1)"
refute "the main checkout is not scoped" "unit-scope" "$(ls aidlc/.aidlc-unit-scope.json 2>&1 | grep -v 'No such')"
echo "   main state row: $(git show origin/main:$R/aidlc-state.md | grep "| $U |")"
echo "   main checkout after land: $(git status --short | wc -l | tr -d ' ') changed path(s)"

step "alpha's worktree after the land"
cd $S/pj-wa || exit 1; ST=$($A unit status 2>&1); echo "$ST" | head -c 400; echo

step "beta in pj-wb after alpha lands (expect: claimed)"
cd $S/pj-wb || exit 1; git merge -q --ff-only origin/main 2>&1 | head -2
BETA=$($A unit claim $V --team wb 2>&1); echo "$BETA" | head -c 300; echo
refute "beta claimed" '"error"' "$BETA"
echo; echo "RESULT: $FAIL expectation(s) failed"
exit $FAIL
