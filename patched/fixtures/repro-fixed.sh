#!/bin/bash
# Same dead end as repro-missing-start.sh, on the patched build: the revising ask now offers the
# completion; the person's pick records it; the revision finishes; the gate opens. Then the
# own-Unit jump in a scoped checkout, and the start-receipt guard on the next stage.
[ -n "${BASH_VERSION:-}" ] && ! shopt -qo posix 2>/dev/null || exec bash "$0" "$@"  # `sh x.sh` on macOS: its echo unescapes the engine's JSON
set -uo pipefail
S=$(cd "$(dirname "$0")" && pwd)
export AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1 AIDLC_GH_BIN=$S/fakegh FAKE_GH_DB=$S/fakegh4.json
U=DEMO-2-alpha; B=DEMO-2/alpha; ST=infrastructure-design
R=aidlc/spaces/default/intents/261015-demo-1-uniform-test
step() { echo; echo "##### $*"; }
j() { python3 -c "import json,sys
raw=sys.stdin.read(); i=raw.find('{')
try:
  d=json.JSONDecoder().raw_decode(raw[i:])[0]
except Exception:
  print(raw[:500]); sys.exit()
d.pop('conductor_persona',None)
keys=('kind','stage','unit','gate','error','message','ask_type','reason_codes','emitted','recorded')
print({k:str(d.get(k))[:260] for k in keys if d.get(k) is not None})
if d.get('remedies'): print('  remedies:', [(r.get('op'), r.get('executableNow')) for r in d['remedies']])
if d.get('choices'): print('  choices:', [c.get('label') for c in d['choices']])"; }
pick() { bun -e "import {consumeSharedDirectiveAsk} from './.claude/tools/aidlc-lib.ts'; console.log(JSON.stringify({picked: consumeSharedDirectiveAsk(process.cwd(), '$1')}))"; }
$S/reset4.sh
cd $S/pi
step claim; aidlc unit claim $U --team pi | j
git switch -c $B >/dev/null 2>&1; git -C svc switch -c $B >/dev/null 2>&1
step "plan approval off"; env -i HOME="$HOME" PATH="$PATH" AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1 AIDLC_TEST_CONFIG_TTY=1 aidlc engine config set guard.plan-approval off 2>&1 | tail -1
step "stages 1-3 normally"; python3 $S/drive3.py $S/pi $U functional-design nfr-requirements nfr-design 2>&1 | grep "approve\|^---" 
step "next → run-stage $ST"; aidlc engine orchestrate next 2>/dev/null | j
step "write artifacts WITHOUT unit start"; bun $S/write-stage.ts $S/pi $U $ST
step "next → ask"; aidlc engine orchestrate next 2>/dev/null | j
step "report rejected (Request Changes)"; aidlc engine orchestrate report --stage $ST --unit $U --result rejected --user-input 'Request Changes' --reason 'fix the pipeline' 2>/dev/null | j
step "next → ask in revising: expect record-unit-completion offered"; aidlc engine orchestrate next 2>/dev/null | j
step "person picks 1 (Mark this Unit finished)"; pick 1
step "unit complete (expect ok now)"; aidlc engine state unit complete --stage $ST --unit $U | j
step "report revised"; aidlc engine orchestrate report --stage $ST --unit $U --result revised 2>/dev/null | j
step "next → expect gate"; aidlc engine orchestrate next 2>/dev/null | j
step "approve"; aidlc engine orchestrate report --stage $ST --unit $U --result approved --user-input 'Approve' 2>/dev/null | j
step "next → expect run-stage code-generation"; aidlc engine orchestrate next 2>/dev/null | j
step "GUARD: review request for code-generation without unit start (expect refusal naming unit start)"; aidlc engine log review --stage code-generation --reviewer aidlc-architecture-reviewer-agent --unit $U --iteration 1 2>&1 | j
step "unit start code-generation"; aidlc engine state unit start --stage code-generation --unit $U | j
step "OWN-UNIT JUMP: redo accepted then next --stage --unit in the scoped checkout (expect no scope refusal)"; aidlc engine orchestrate report --result resumed --choice redo --target $ST --unit $U 2>/dev/null | j; aidlc engine orchestrate next --stage $ST --unit $U 2>/dev/null | j
step "OTHER-UNIT JUMP still refused"; aidlc engine orchestrate next --stage $ST --unit DEMO-3-beta 2>/dev/null | j
step "audit tail"; grep "^\*\*Event\*\*" $R/audit/*.md | grep -v "b71c3ba870ea" | sed 's/.*Event\*\*: //' | tail -14 | tr '\n' ' '; echo
