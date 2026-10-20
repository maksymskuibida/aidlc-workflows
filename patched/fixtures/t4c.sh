#!/bin/bash
# A Unit claimed in the clone that ran the earlier phases: that clone's own audit shard is already on
# main. Alpha in pi: pi's shard reaches main first, then claim → stages → code PR → publish → pin →
# bracket → gate → land → workspace PR → finish, then beta is claimed in the same clone. Pin accepts the
# candidate only when it adds one new team shard and leaves the shard main already holds as it is.
# Usage: t4c.sh [aidlc binary for alpha's claim]. Given an engine from before the team shard split
# (an earlier build under ~/.local/share/aidlc/versions/), alpha is claimed on pi's own shard and its
# rows go there, as for a Unit claimed before the fix; publish then splits them out.
set -uo pipefail
S=$(cd "$(dirname "$0")" && pwd)
V=${AIDLC_FIXTURE_VERSION:-$(cat "$HOME/.local/share/aidlc/active-version")}  # the installed build the fixture drives
export AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1 AIDLC_GH_BIN=$S/fakegh FAKE_GH_DB=$S/fakegh4.json
U=DEMO-2-alpha; B=DEMO-2/alpha; A=$HOME/.local/share/aidlc/versions/$V/aidlc
R=aidlc/spaces/default/intents/261015-demo-1-uniform-test
FAIL=0
step() { echo; echo "##### $*"; }
expect() { # expect <label> <substring> <text>
  case "$3" in *"$2"*) echo "   OK   $1";; *) echo "   FAIL $1 (wanted: $2)"; FAIL=$((FAIL+1));; esac; }
refute() { # refute <label> <substring> <text>
  case "$3" in *"$2"*) echo "   FAIL $1 (unwanted: $2)"; FAIL=$((FAIL+1));; *) echo "   OK   $1";; esac; }
human() { T=$S/pi-transcript.jsonl; printf '{"type":"user","cwd":"%s","sessionId":"sim"}\n' "$PWD" > $T
  printf '{"session_id":"sim","transcript_path":"%s","cwd":"%s","hook_event_name":"UserPromptSubmit","prompt":"%s"}' "$T" "$PWD" "$1" | CLAUDE_PROJECT_DIR=$PWD aidlc engine hook record-human-turn >/dev/null 2>&1 || true; }

$S/reset4.sh || exit 1
cd $S/pi || exit 1
step "pi's own shard reaches main, as the earlier phases' rows did"
human "earlier phase work in this clone"
OWN=$(git status --porcelain -- $R/audit | awk '{print $2}' | head -1); echo "   pi's shard: $OWN"
git add -- $OWN && git commit -qm "earlier phases: pi's audit rows" && git push -q origin HEAD:main
BASE_OWN=$(git rev-parse HEAD:$OWN)
CLAIMER=${1:-$A}
step "claim (with $CLAIMER)"; CLAIM=$($CLAIMER unit claim $U --team pi 2>&1); echo "$CLAIM" | head -c 300; echo
BOUND=$(python3 -c "import json;print(json.load(open('aidlc/.aidlc-unit-scope.json')).get('audit_shard',''))" 2>/dev/null)
echo "   alpha's claim-bound shard at claim: $BOUND"
git switch -c $B >/dev/null 2>&1; git -C svc switch -c $B >/dev/null 2>&1
step "plan approval off"; env -i HOME="$HOME" PATH="$PATH" AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1 AIDLC_TEST_CONFIG_TTY=1 aidlc engine config set guard.plan-approval off 2>&1 | tail -1
step stages;       python3 $S/drive3.py $S/pi $U 2>&1 | tail -6
[ -n "${1:-}" ] && expect "a claim from before the fix writes the Unit's rows into pi's own shard" "$U" "$(cat $OWN)"
step "code change + code PR"
echo "alpha feature" >> svc/README.md; git -C svc add -A; git -C svc commit -qm "[DEMO-2] alpha"; git -C svc push -q -u origin $B
$A unit pr $U --repo svc >/dev/null
$S/merge_pr.sh $S/svc4.git $B $FAKE_GH_DB example/svc#1 pj >/dev/null
step "commit record"; git add -- $R/construction/$U $R/audit $R/aidlc-state.md; git commit -qm "[DEMO-2] alpha: construction record"; git log --oneline -1
step publish;      PUB=$($A unit publish $U 2>&1); echo "$PUB" | head -c 300; echo
expect "published" '"published":true' "$PUB"
CAND=$(echo "$PUB" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("candidate_oid",""))' 2>/dev/null)
ADDED=$(git diff --no-renames --name-status origin/main $CAND -- $R/audit 2>/dev/null)
echo "   candidate audit changes vs main:"; echo "$ADDED" | sed 's/^/     /'
expect "candidate adds one team shard" "A	$R/audit/" "$ADDED"
refute "candidate leaves pi's shard as main has it" "M	$OWN" "$ADDED"
expect "pi's shard bytes unchanged in the candidate" "$BASE_OWN" "$(git rev-parse $CAND:$OWN 2>&1)"
step pin;          PIN=$($A unit pin $U 2>&1); echo "$PIN" | head -c 400; echo
expect "pinned" '"pinned_oid"' "$PIN"
refute "no ownership refusal" "violates claimed Unit ownership" "$PIN"
OID=$(echo "$PIN" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["pinned_oid"])' 2>/dev/null); GEN=$(echo "$PIN" | python3 -c 'import json,sys;print(json.load(sys.stdin)["generation"])' 2>/dev/null); PID=$(echo "$PIN" | python3 -c 'import json,sys;print(json.load(sys.stdin)["pin_id"])' 2>/dev/null)
step bracket
aidlc engine bolt dispatch-event --event MERGE_DISPATCH_INVOKED --slug $U --pinned-oid "$OID" --attempt-generation "$GEN" --pin-id "$PID" --practices-excerpt "PRs only" >/dev/null 2>&1
aidlc engine bolt dispatch-event --event MERGE_DISPATCH_RETURNED --slug $U --pinned-oid "$OID" --attempt-generation "$GEN" --pin-id "$PID" --strategy pr --target $B --confidence 1 --notes "squash PR" >/dev/null 2>&1
step gate;         GATE=$($A unit gate $U --decision approve --user-input "Approve merge of alpha" 2>&1); echo "$GATE" | head -c 200; echo
refute "gate accepted" '"error"' "$GATE"
step land;         LAND=$($A unit land $U 2>&1); echo "$LAND" | head -c 200; echo
refute "land accepted" '"error"' "$LAND"
git push -q -u origin $B
step "workspace PR"; $A unit pr $U >/dev/null 2>&1; $S/merge_pr.sh $S/wsp4.git $B $FAKE_GH_DB example/ws#1 pj >/dev/null
step finish;       FIN=$($A unit finish $U 2>&1); echo "$FIN" | head -c 300; echo
expect "finished" '"finished":true' "$FIN"
git fetch -q origin
expect "main keeps pi's shard bytes" "$BASE_OWN" "$(git rev-parse origin/main:$OWN 2>&1)"
step "claim beta in the same clone"; BETA=$($A unit claim DEMO-3-beta --team pi 2>&1); echo "$BETA" | head -c 300; echo
refute "beta claimed" '"error"' "$BETA"
SHARD=$(python3 -c "import json;print(json.load(open('aidlc/.aidlc-unit-scope.json')).get('audit_shard',''))" 2>/dev/null)
echo "   beta's claim-bound shard: $SHARD"
refute "beta's claim starts on a shard main does not hold" "$(basename $OWN)" "$SHARD"
echo; echo "RESULT: $FAIL expectation(s) failed"
exit $FAIL
