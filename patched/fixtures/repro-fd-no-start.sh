#!/bin/bash
# Reproduce: a claimed team Unit (unit-end rhythm) writes Functional Design without `unit start`,
# then requests its review. Does the first-record guard name the start?
[ -n "${BASH_VERSION:-}" ] && ! shopt -qo posix 2>/dev/null || exec bash "$0" "$@"
set -uo pipefail
S=$(cd "$(dirname "$0")" && pwd)
export AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1 AIDLC_GH_BIN=$S/fakegh FAKE_GH_DB=$S/fakegh4.json
U=DEMO-2-alpha; B=DEMO-2/alpha; ST=functional-design; RV=aidlc-architecture-reviewer-agent
R=aidlc/spaces/default/intents/261015-demo-1-uniform-test
step() { echo; echo "##### $*"; }
j() { python3 -c "import json,sys
raw=sys.stdin.read(); i=raw.find('{')
try:
  d=json.JSONDecoder().raw_decode(raw[i:])[0]
except Exception:
  print(raw[:600]); sys.exit()
keys=('kind','stage','unit','gate','error','message','ask_type','reason_codes','emitted','recorded','agent_note')
print({k:str(d.get(k))[:400] for k in keys if d.get(k) is not None})"; }
nx() { local d; d=$(aidlc engine orchestrate next); for _ in 1 2 3 4 5; do r=$(echo "$d" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('receipt','') if d.get('kind')=='load-steering' else '')"); [ -z "$r" ] && break; d=$(aidlc engine orchestrate continue "$r"); done; echo "$d"; }
$S/reset4.sh
cd $S/pi
step "practices branch"; aidlc engine state practices-branch --file org.md --none | j
step claim; aidlc unit claim $U --team pi --rhythm unit-end | j
git switch -c $B >/dev/null 2>&1; git -C svc switch -c $B >/dev/null 2>&1
step "next → expect run-stage $ST $U"; nx | j
step "write $ST WITHOUT unit start"; bun $S/write-stage.ts $S/pi $U $ST
step "review request (the first record) → expect refused, naming unit start"; aidlc engine log review --stage $ST --reviewer $RV --unit $U --iteration 1 | j
step "unit start now → ?"; aidlc engine state unit start --stage $ST --unit $U | j
step "next → ?"; nx | j
step "audit events"; grep -h "^\*\*Event\*\*" $R/audit/*.md .aidlc-engine/audit/*.md $R/.aidlc-engine/audit/*.md 2>/dev/null | tail -8
