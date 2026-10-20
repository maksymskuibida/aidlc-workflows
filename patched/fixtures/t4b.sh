#!/bin/bash
# Beta in a worktree of pj, with a drift commit after land: release → worktree claim → … → finish refusal → accept → cleanup command.
set -uo pipefail
S=$(cd "$(dirname "$0")" && pwd)
V=${AIDLC_FIXTURE_VERSION:-$(cat "$HOME/.local/share/aidlc/active-version")}  # the installed build the fixture drives
export AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1 AIDLC_GH_BIN=$S/fakegh FAKE_GH_DB=$S/fakegh4.json
U=DEMO-3-beta; B=DEMO-3/beta; A=$HOME/.local/share/aidlc/versions/$V/aidlc
R=aidlc/spaces/default/intents/261015-demo-1-uniform-test
step() { echo; echo "##### $*"; }
cd $S/pj || exit 1; git pull -q --ff-only; git -C svc pull -q --ff-only
step "release pi's beta claim from pj (unscoped)"; $A unit release $U
step "worktrees"; git worktree add -q ../pj-wt -b $B origin/main && git -C svc worktree add -q ../../pj-wt/svc -b $B origin/main && git worktree list && git -C svc worktree list
cd $S/pj-wt || exit 1; git config fakegh.repo example/ws; git -C svc config fakegh.repo example/svc
{ $S/pin-here.sh $V || exit 1; }; aidlc engine intent switch 261015-demo-1-uniform-test >/dev/null
step "claim from the worktree"; $A unit claim $U --team pj
step stages; python3 $S/drive3.py $S/pj-wt $U 2>&1 | grep "next  \|notice\|error" | tail -4
step "code PR"; echo "beta feature" >> svc/README.md; git -C svc add -A; git -C svc commit -qm "[DEMO-3] beta"; git -C svc push -q -u origin $B; $A unit pr $U --repo svc
step "merge code PR"; $S/merge_pr.sh $S/svc4.git $B $FAKE_GH_DB example/svc#2 pi
step "commit record"; git add -- $R/construction/$U $R/audit $R/aidlc-state.md; git commit -qm "[DEMO-3] beta: construction record"; git log --oneline -1
step publish; $A unit publish $U | head -c 200; echo
step pin; PIN=$($A unit pin $U); echo "$PIN" | head -c 120; echo
OID=$(echo "$PIN" | python3 -c 'import json,sys;print(json.load(sys.stdin)["pinned_oid"])'); GEN=$(echo "$PIN" | python3 -c 'import json,sys;print(json.load(sys.stdin)["generation"])'); PID=$(echo "$PIN" | python3 -c 'import json,sys;print(json.load(sys.stdin)["pin_id"])')
step bracket
aidlc engine bolt dispatch-event --event MERGE_DISPATCH_INVOKED --slug $U --pinned-oid $OID --attempt-generation $GEN --pin-id $PID --practices-excerpt "PRs only" >/dev/null
aidlc engine bolt dispatch-event --event MERGE_DISPATCH_RETURNED --slug $U --pinned-oid $OID --attempt-generation $GEN --pin-id $PID --strategy pr --target $B --confidence 1 --notes "squash PR" >/dev/null; echo bracketed
step gate; $A unit gate $U --decision approve --user-input "Approve merge of beta" | head -c 160; echo
step land; $A unit land $U; git push -q -u origin $B
step "workspace PR"; $A unit pr $U
step "finish before merge (expect: not merged)"; $A unit finish $U
step "drift: a review fix pushed after land"; echo "review fix" >> $R/construction/$U/code-generation/code-generation-plan.md; git add -A -- $R/construction/$U; git commit -qm "review fix"; git push -q; git log --oneline -1
step "merge workspace PR"; $S/merge_pr.sh $S/wsp4.git $B $FAKE_GH_DB example/ws#2 pi
step "finish (expect: drift refusal)"; $A unit finish $U
step "finish --accept-merged-drift"; $A unit finish $U --accept-merged-drift --user-input "I compared the review fix with the landed head and accept it"
step "after accept"; git branch --show-current; git log --oneline -2; ls aidlc/.aidlc-unit-scope.json 2>&1; grep -c "UNIT_MERGE_DRIFT_ACCEPTED" $R/audit/*.md | grep -v ":0"; cat $S/pr-example_ws-3.md; python3 -c "import json;print(json.load(open('$FAKE_GH_DB'))['example/ws#3']['title'])"
step "merge the follow-up PR"; $S/merge_pr.sh $S/wsp4.git $(git branch --show-current) $FAKE_GH_DB example/ws#3 pi
step "repeat finish (expect: idempotent, same cleanup)"; $A unit finish $U
