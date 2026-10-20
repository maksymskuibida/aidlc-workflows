#!/bin/bash
# A team run's Code Generation dead end: no start, ask, Request Changes, completion picked while
# revising with no review for the new attempt → REVIEW_EVIDENCE_MISSING. Patched: the review
# request is offered and executable; the verdict lands; the revision finishes; the gate opens.
# Also: the start guard at the first engine touch (a question) and its stand-aside.
[ -n "${BASH_VERSION:-}" ] && ! shopt -qo posix 2>/dev/null || exec bash "$0" "$@"  # `sh x.sh` on macOS: its echo unescapes the engine's JSON
set -uo pipefail
S=$(cd "$(dirname "$0")" && pwd)
export AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1 AIDLC_GH_BIN=$S/fakegh FAKE_GH_DB=$S/fakegh4.json
U=DEMO-2-alpha; B=DEMO-2/alpha; ST=infrastructure-design; REV=aidlc-architecture-reviewer-agent
R=aidlc/spaces/default/intents/261015-demo-1-uniform-test
step() { echo; echo "##### $*"; }
j() { python3 -c "import json,sys
raw=sys.stdin.read(); i=raw.find('{')
try:
  d=json.JSONDecoder().raw_decode(raw[i:])[0]
except Exception:
  print(raw[:500]); sys.exit()
d.pop('conductor_persona',None)
keys=('kind','stage','unit','gate','error','message','ask_type','reason_codes','emitted','recorded','reviewFile')
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
step "GUARD at first touch: log decision without unit start (expect refusal naming unit start)"; aidlc engine log decision --stage $ST --unit $U --decision "probe question" 2>&1 | j
step "unit start now (expect ok: run-stage routed, no artifacts yet)"; aidlc engine state unit start --stage $ST --unit $U | j
step "log decision after start (expect ok)"; aidlc engine log decision --stage $ST --unit $U --decision "probe question" 2>&1 | j
step "--- now the team-run shape: a fresh Unit's stage without start ---"
step "write artifacts; next → ask"; bun $S/write-stage.ts $S/pi $U $ST >/dev/null; aidlc engine state unit complete --stage $ST --unit $U | j
step "next → gate; approve; next → code-generation"; aidlc engine orchestrate next 2>/dev/null | j; aidlc engine orchestrate report --stage $ST --unit $U --result approved --user-input Approve 2>/dev/null | j; aidlc engine orchestrate next 2>/dev/null | j
ST=code-generation
step "code-generation: write artifacts WITHOUT start; next → ask"; bun $S/write-stage.ts $S/pi $U $ST >/dev/null; aidlc engine orchestrate next 2>/dev/null | j
step "request-review (stand-aside) + verdict READY"; OUT=$(aidlc engine log review --stage $ST --reviewer $REV --unit $U --iteration 1 2>&1); echo "$OUT" | j; RF=$(echo "$OUT" | python3 -c "import json,sys; raw=sys.stdin.read(); print(json.loads(raw[raw.find('{'):])['reviewFile'])"); printf '## Review\n\n**Verdict:** READY\n**Reviewer:** %s\n**Date:** 2026-10-17\n**Iteration:** 1\n**Verdict Dictated:** no\n\n### Findings\n\nNo blocking findings.\n' "$REV" > "$RF"; aidlc engine log review --stage $ST --reviewer $REV --unit $U --iteration 1 --verdict READY 2>&1 | j
step "next → ask (completion missing) ; Request Changes → rejected"; aidlc engine orchestrate next 2>/dev/null | j; aidlc engine orchestrate report --stage $ST --unit $U --result rejected --user-input 'Request Changes' --reason 'fix R-01' 2>/dev/null | j
step "next → ask in revising; pick 1 (Mark finished); complete"; aidlc engine orchestrate next 2>/dev/null | j; pick 1; aidlc engine state unit complete --stage $ST --unit $U | j
step "next → EXPECT ask REVIEW_EVIDENCE_MISSING with request-review executable, no redo-jump"; aidlc engine orchestrate next 2>/dev/null | j
step "carry out: request review iteration 1 of the new attempt + verdict"; OUT=$(aidlc engine log review --stage $ST --reviewer $REV --unit $U --iteration 1 2>&1); echo "$OUT" | j; RF=$(echo "$OUT" | python3 -c "import json,sys; raw=sys.stdin.read(); print(json.loads(raw[raw.find('{'):])['reviewFile'])"); printf '## Review\n\n**Verdict:** READY\n**Reviewer:** %s\n**Date:** 2026-10-17\n**Iteration:** 1\n**Verdict Dictated:** no\n\n### Findings\n\nNo blocking findings.\n' "$REV" > "$RF"; aidlc engine log review --stage $ST --reviewer $REV --unit $U --iteration 1 --verdict READY 2>&1 | j
step "next → ? (finish-revision executable or gate)"; aidlc engine orchestrate next 2>/dev/null | j
step "report revised; next → expect gate; approve; next"; aidlc engine orchestrate report --stage $ST --unit $U --result revised 2>/dev/null | j; aidlc engine orchestrate next 2>/dev/null | j; aidlc engine orchestrate report --stage $ST --unit $U --result approved --user-input Approve 2>/dev/null | j; aidlc engine orchestrate next 2>/dev/null | j
