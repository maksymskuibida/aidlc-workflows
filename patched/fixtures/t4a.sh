#!/bin/bash
# Alpha in pi's main checkout: claim → stages → code PR → publish/pin/bracket/gate/land → workspace PR → finish → claim beta.
[ -n "${BASH_VERSION:-}" ] && ! shopt -qo posix 2>/dev/null || exec bash "$0" "$@"  # `sh x.sh` on macOS: its echo unescapes the engine's JSON
set -uo pipefail
S=$(cd "$(dirname "$0")" && pwd)
V=${AIDLC_FIXTURE_VERSION:-$(cat "$HOME/.local/share/aidlc/active-version")}  # the installed build the fixture drives
export AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1 AIDLC_GH_BIN=$S/fakegh FAKE_GH_DB=$S/fakegh4.json
U=DEMO-2-alpha; B=DEMO-2/alpha; A=$HOME/.local/share/aidlc/versions/$V/aidlc
R=aidlc/spaces/default/intents/261015-demo-1-uniform-test
step() { echo; echo "##### $*"; }
cd $S/pi || exit 1
step claim;        $A unit claim $U --team pi
git switch -c $B >/dev/null 2>&1; git -C svc switch -c $B >/dev/null 2>&1
step "plan approval off"; env -i HOME="$HOME" PATH="$PATH" AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1 AIDLC_TEST_CONFIG_TTY=1 aidlc engine config set guard.plan-approval off 2>&1 | tail -2
step stages;       python3 $S/drive3.py $S/pi $U 2>&1 | tail -25
step "code change + code PR"
echo "alpha feature" >> svc/README.md; git -C svc add -A; git -C svc commit -qm "[DEMO-2] alpha"; git -C svc push -q -u origin $B
$A unit pr $U --repo svc
step "merge code PR";  $S/merge_pr.sh $S/svc4.git $B $FAKE_GH_DB example/svc#1 pj
step "commit record";  git add -- $R/construction/$U $R/audit $R/aidlc-state.md; git commit -qm "[DEMO-2] alpha: construction record"; git log --oneline -1; git status --short | head
step publish;      $A unit publish $U | head -c 400; echo
step pin;          PIN=$($A unit pin $U); echo "$PIN" | head -c 300; echo
OID=$(echo "$PIN" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["pinned_oid"])'); GEN=$(echo "$PIN" | python3 -c 'import json,sys;print(json.load(sys.stdin)["generation"])'); PID=$(echo "$PIN" | python3 -c 'import json,sys;print(json.load(sys.stdin)["pin_id"])')
step bracket
aidlc engine bolt dispatch-event --event MERGE_DISPATCH_INVOKED --slug $U --pinned-oid $OID --attempt-generation $GEN --pin-id $PID --practices-excerpt "PRs only" | head -c 200; echo
aidlc engine bolt dispatch-event --event MERGE_DISPATCH_RETURNED --slug $U --pinned-oid $OID --attempt-generation $GEN --pin-id $PID --strategy pr --target $B --confidence 1 --notes "squash PR" | head -c 200; echo
step "gate (PRs from record)"; $A unit gate $U --decision approve --user-input "Approve merge of alpha"
step land;         $A unit land $U
git push -q -u origin $B; git log --oneline -3
step "workspace PR"; $A unit pr $U
step "claim beta before merge (expect: already scoped)"; $A unit claim DEMO-3-beta --team pi
step "merge workspace PR"; $S/merge_pr.sh $S/wsp4.git $B $FAKE_GH_DB example/ws#1 pj
step "claim beta after merge (expect: run finish)"; $A unit claim DEMO-3-beta --team pi
step finish;       $A unit finish $U
step "state after finish"; git branch --show-current; git status --short | head -3; ls aidlc/.aidlc-unit-scope.json 2>&1; git log --oneline -1; git -C svc branch --show-current; git -C svc log --oneline -1; cat aidlc/.aidlc-unit-merges/default/*/$U.json | python3 -c 'import json,sys;d=json.load(sys.stdin);print({k:d.get(k) for k in ("status","landed_head_oid","merge_commit_oid","finished_at")})'
step "claim beta (expect ok)"; $A unit claim DEMO-3-beta --team pi
step "pr bodies"; ls $S/pr-*.md; echo ---; cat $S/pr-example_ws-1.md
