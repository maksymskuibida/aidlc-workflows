#!/bin/bash
# The live team-run sequence with reviews on for Code Generation: artifacts without start → ask →
# review READY under the ask → Request Changes from the ask → completion picked while revising →
# a review owed for the new attempt. Patched: the ask offers that review as the agent's own step.
set -uo pipefail
S=$(cd "$(dirname "$0")" && pwd)
export AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1 AIDLC_GH_BIN=$S/fakegh FAKE_GH_DB=$S/fakegh4.json
U=DEMO-2-alpha; B=DEMO-2/alpha; REV=aidlc-architecture-reviewer-agent
R=aidlc/spaces/default/intents/261015-demo-1-uniform-test
step() { echo; echo "##### $*"; }
j() { python3 -c "import json,sys
raw=sys.stdin.read(); i=raw.find('{')
try:
  d=json.JSONDecoder().raw_decode(raw[i:])[0]
except Exception:
  print(raw[:600]); sys.exit()
d.pop('conductor_persona',None)
keys=('kind','stage','unit','gate','error','message','ask_type','reason_codes','emitted','recorded','agent_work')
print({k:str(d.get(k))[:300] for k in keys if d.get(k) is not None})
if d.get('remedies'): print('  remedies:', [(r.get('op'), r.get('executableNow')) for r in d['remedies']])
if d.get('choices'): print('  choices:', [c.get('label') for c in d['choices']])"; }
pick() { bun -e "import {consumeSharedDirectiveAsk} from './.claude/tools/aidlc-lib.ts'; console.log(JSON.stringify({picked: consumeSharedDirectiveAsk(process.cwd(), '$1')}))"; }
review() { # $1 stage $2 iteration
  OUT=$(aidlc engine log review --stage $1 --reviewer $REV --unit $U --iteration $2 2>&1); echo "$OUT" | j
  RF=$(echo "$OUT" | python3 -c "import json,sys; raw=sys.stdin.read(); i=raw.find('{'); d=json.loads(raw[i:]) if i>=0 else {}; print(d.get('reviewFile',''))")
  [ -n "$RF" ] || return
  printf '## Review\n\n**Verdict:** READY\n**Reviewer:** %s\n**Date:** 2026-10-17\n**Iteration:** %s\n**Verdict Dictated:** no\n\n### Findings\n\n| ID | Severity | Location | Finding | Required action | Status |\n|---|---|---|---|---|---|\n| R-01 | Minor | svc/README.md | nit | fix | New |\n' "$REV" "$2" > "$RF"
  aidlc engine log review --stage $1 --reviewer $REV --unit $U --iteration $2 --verdict READY 2>&1 | j
}
$S/reset4.sh
cd $S/pi
step claim; aidlc unit claim $U --team pi | j
git switch -c $B >/dev/null 2>&1; git -C svc switch -c $B >/dev/null 2>&1
step "plan approval off"; env -i HOME="$HOME" PATH="$PATH" AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1 AIDLC_TEST_CONFIG_TTY=1 aidlc engine config set guard.plan-approval off 2>&1 | tail -1
step "stages 1-4 normally"; python3 $S/drive3.py $S/pi $U functional-design nfr-requirements nfr-design infrastructure-design 2>&1 | grep "approve\|^---"
step "reviews on (adversarial) for the rest"; env -i HOME="$HOME" PATH="$PATH" AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1 AIDLC_TEST_CONFIG_TTY=1 aidlc engine config set review adversarial 2>&1 | tail -1
ST=code-generation
step "next → code-generation"; aidlc engine orchestrate next 2>/dev/null | j
step "write artifacts WITHOUT start; next → ask"; bun $S/write-stage.ts $S/pi $U $ST >/dev/null; echo "alpha feature" >> svc/README.md; printf '{"stage":"%s","unit":"%s","version":1,"writes":[{"path":"svc/README.md"}]}' $ST $U > $R/construction/$U/$ST/source-manifest.json; aidlc engine orchestrate next 2>/dev/null | j
step "review iteration 1 under the ask (stand-aside) → READY"; review $ST 1
step "next → ask (completion missing): expect record-unit-completion + request-changes"; aidlc engine orchestrate next 2>/dev/null | j
step "Request Changes from the ask (as the live session did) → rejected"; aidlc engine log answer --stage $ST --checkpoint guard-recovery --details request-changes 2>&1 | j; aidlc engine orchestrate report --stage $ST --unit $U --result rejected --user-input 'Request Changes' --reason 'fix R-01' 2>/dev/null | j
step "next → revising: expect agent-work ask, start-recovery-review executable"; aidlc engine orchestrate next 2>/dev/null | j
step "carry it out: the recovery review (iteration 1 of the new attempt)"; review $ST 1
step "next → expect agent-work ask: finish-revision executable; carry it out"; aidlc engine orchestrate next 2>/dev/null | j; aidlc engine orchestrate report --stage $ST --unit $U --result revised 2>/dev/null | j
step "next → expect human ask: Mark this Unit finished (no redo-jump); pick; complete"; aidlc engine orchestrate next 2>/dev/null | j; pick 1; aidlc engine state unit complete --stage $ST --unit $U | j
step "next → expect gate; approve; next → Unit complete"; aidlc engine orchestrate next 2>/dev/null | j; aidlc engine orchestrate report --stage $ST --unit $U --result approved --user-input Approve 2>/dev/null | j; aidlc engine orchestrate next 2>/dev/null | j
