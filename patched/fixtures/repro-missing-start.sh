#!/bin/bash
# Reproduce: per-unit stage run without `unit start`, review, Request Changes at the recovery ask → stuck.
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
  print(raw[:400]); sys.exit()
d.pop('conductor_persona',None)
keys=('kind','stage','unit','gate','error','message','ask_type','reason_codes','emitted','recorded')
print({k:str(d.get(k))[:300] for k in keys if d.get(k) is not None})
if d.get('remedies'): print('  remedies:', [(r.get('op'), r.get('executableNow')) for r in d['remedies']])
if d.get('choices'): print('  choices:', [c.get('label') for c in d['choices']])"; }
$S/reset4.sh
cd $S/pi
step claim; aidlc unit claim $U --team pi | j
git switch -c $B >/dev/null 2>&1; git -C svc switch -c $B >/dev/null 2>&1
step "plan approval off"; env -i HOME="$HOME" PATH="$PATH" AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1 AIDLC_TEST_CONFIG_TTY=1 aidlc engine config set guard.plan-approval off 2>&1 | tail -1
step "stages 1-3 normally"; python3 $S/drive3.py $S/pi $U functional-design nfr-requirements nfr-design 2>&1 | grep -v "^ write\|^ start" 
step "next → expect run-stage $ST"; aidlc engine orchestrate next | j
step "write artifacts WITHOUT unit start"; bun $S/write-stage.ts $S/pi $U $ST
step "next → ?"; aidlc engine orchestrate next | j
step "unit complete (expect refused: not active)"; aidlc engine state unit complete --stage $ST --unit $U | j
step "unit start (expect refused: routes an ask)"; aidlc engine state unit start --stage $ST --unit $U | j
step "answer: request-changes"; aidlc engine log answer --stage $ST --checkpoint guard-recovery --details request-changes | j
step "report rejected"; aidlc engine orchestrate report --stage $ST --unit $U --result rejected --user-input 'Request Changes' --reason 'fix the pipeline' | j
step "next → ?"; aidlc engine orchestrate next | j
step "report revised"; aidlc engine orchestrate report --stage $ST --unit $U --result revised | j
step "next → ?"; aidlc engine orchestrate next | j
step "unit start again"; aidlc engine state unit start --stage $ST --unit $U | j
step "redo via report resumed"; aidlc engine orchestrate report --result resumed --choice redo --target $ST --unit $U | j
step "next --stage --unit (expect scoped refusal)"; aidlc engine orchestrate next --stage $ST --unit $U | j
step "audit tail"; grep "^\*\*Event\*\*" $R/audit/*.md | grep -v "b71c3ba870ea" | tail -12
