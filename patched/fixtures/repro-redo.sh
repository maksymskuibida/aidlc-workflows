#!/bin/bash
# Same dead end, but the person picks "Start the stage over": the bare stage jump in the scoped
# checkout now means this Unit, and the Unit's stage is run again from the top.
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
keys=('kind','stage','unit','gate','error','message','ask_type','reason_codes','emitted','recorded','narration')
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
step "next → ask in revising"; aidlc engine orchestrate next 2>/dev/null | j
step "person picks 2 (Start the stage over)"; pick 2
step "log answer redo-jump"; aidlc engine log answer --stage $ST --checkpoint guard-recovery --details redo-jump 2>/dev/null | j
step "BARE next --stage (expect: no scope refusal, the Unit's stage from the top)"; aidlc engine orchestrate next --stage $ST 2>/dev/null | j
step "next → ?"; aidlc engine orchestrate next 2>/dev/null | j
step "unit start (expect ok: routed run-stage)"; aidlc engine state unit start --stage $ST --unit $U | j
step "write artifacts + complete"; bun $S/write-stage.ts $S/pi $U $ST >/dev/null; aidlc engine state unit complete --stage $ST --unit $U | j
step "next → expect gate"; aidlc engine orchestrate next 2>/dev/null | j
step "approve"; aidlc engine orchestrate report --stage $ST --unit $U --result approved --user-input 'Approve' 2>/dev/null | j
step "next → expect code-generation"; aidlc engine orchestrate next 2>/dev/null | j
step "every-unit / other-unit / phase jumps still refused"; aidlc engine orchestrate next --stage $ST --every-unit 2>/dev/null | j; aidlc engine orchestrate next --stage $ST --unit DEMO-3-beta 2>/dev/null | j; aidlc engine orchestrate next --phase construction 2>/dev/null | j
step "audit tail"; grep "^\*\*Event\*\*" $R/audit/*.md | grep -v "b71c3ba870ea" | sed 's/.*Event\*\*: //' | grep -v SENSOR | tail -12 | tr '\n' ' '; echo
