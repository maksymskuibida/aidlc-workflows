#!/bin/bash
# Plan approval ON. Reach the live state (revising, review current, completion recorded, run-stage gate),
# show the plan-approval hook blocks `report --result revised` (approval bound to the old attempt),
# re-approve the plan for the new attempt with the engine's own answer, show the hook admits it, finish.
set -uo pipefail
S=$(cd "$(dirname "$0")" && pwd)
export AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1 AIDLC_GH_BIN=$S/fakegh FAKE_GH_DB=$S/fakegh4.json
U=DEMO-2-alpha; B=DEMO-2/alpha; REV=aidlc-architecture-reviewer-agent; ST=code-generation
R=aidlc/spaces/default/intents/261015-demo-1-uniform-test
step() { echo; echo "##### $*"; }
j() { python3 -c "import json,sys
raw=sys.stdin.read(); i=raw.find('{')
try:
  d=json.JSONDecoder().raw_decode(raw[i:])[0]
except Exception:
  print(raw[:700]); sys.exit()
d.pop('conductor_persona',None)
keys=('kind','stage','unit','gate','error','message','ask_type','reason_codes','emitted','recorded','agent_work','checkpoint')
print({k:str(d.get(k))[:300] for k in keys if d.get(k) is not None})
if d.get('remedies'): print('  remedies:', [(r.get('op'), r.get('executableNow')) for r in d['remedies']])
if d.get('choices'): print('  choices:', [c.get('label') for c in d['choices']])"; }
pick() { bun -e "import {consumeSharedDirectiveAsk} from './.claude/tools/aidlc-lib.ts'; console.log(JSON.stringify({picked: consumeSharedDirectiveAsk(process.cwd(), '$1')}))"; }
human() { ts=$(date -u +%Y-%m-%dT%H:%M:%SZ); for f in $R/audit/*.md; do case $f in *b71c3ba870ea*) continue;; esac; printf '## Human Turn\n**Timestamp**: %s\n**Event**: HUMAN_TURN\n**Reply**: %s\n\n---\n' "$ts" "$1" >> "$f"; break; done; }
approve_plan() { Q=$R/construction/$U/$ST/code-generation-questions.md; human "Approve Plan"; python3 - "$Q" <<'PY'
import re,sys; p=sys.argv[1]; t=open(p).read()
t=re.sub(r'^\[Answer\]:.*$','[Answer]: Approve Plan',t,count=1,flags=re.M) if re.search(r'^\[Answer\]:',t,re.M) else t.rstrip('\n')+'\n[Answer]: Approve Plan\n'
open(p,'w').write(t)
PY
aidlc engine log answer --stage $ST --checkpoint plan-approval --questions-file $Q --details 'Approve Plan' --unit $U 2>&1 | j; }
review() { OUT=$(aidlc engine log review --stage $ST --reviewer $REV --unit $U --iteration $1 2>&1); echo "$OUT" | j
  RF=$(echo "$OUT" | python3 -c "import json,sys; raw=sys.stdin.read(); i=raw.find('{'); d=json.loads(raw[i:]) if i>=0 else {}; print(d.get('reviewFile',''))"); [ -n "$RF" ] || return
  printf '## Review\n\n**Verdict:** READY\n**Reviewer:** %s\n**Date:** 2026-10-17\n**Iteration:** %s\n**Verdict Dictated:** no\n\n### Findings\n\n| ID | Severity | Location | Finding | Required action | Status |\n|---|---|---|---|---|---|\n| R-01 | Minor | svc/README.md | nit | fix | New |\n' "$REV" "$1" > "$RF"
  aidlc engine log review --stage $ST --reviewer $REV --unit $U --iteration $1 --verdict READY 2>&1 | j; }
hook() { # simulate PreToolUse Bash on a command through the guard group
  T=$S/pi-transcript.jsonl; printf '{"type":"user","cwd":"%s","sessionId":"sim"}\n' "$PWD" > $T
  printf '{"session_id":"sim","transcript_path":"%s","cwd":"%s","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"%s"}}' "$T" "$PWD" "$1" | CLAUDE_PROJECT_DIR=$PWD aidlc engine hook guard-tool-call 2>&1 | head -c 400; echo " [exit ${PIPESTATUS[1]}]"; }
$S/reset4.sh
cd $S/pi
step claim; aidlc unit claim $U --team pi | j
git switch -c $B >/dev/null 2>&1; git -C svc switch -c $B >/dev/null 2>&1
step "stages 1-4 normally (plan approval stays ON)"; python3 $S/drive3.py $S/pi $U functional-design nfr-requirements nfr-design infrastructure-design 2>&1 | grep "approve\|^---"
step "reviews on"; env -i HOME="$HOME" PATH="$PATH" AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1 AIDLC_TEST_CONFIG_TTY=1 aidlc engine config set review adversarial 2>&1 | tail -1
step "next → code-generation; unit start; write plan+artifacts; next → plan approval ask; approve"; aidlc engine orchestrate next 2>/dev/null | j; aidlc engine state unit start --stage $ST --unit $U | j; bun $S/write-stage.ts $S/pi $U $ST >/dev/null; echo "alpha feature" >> svc/README.md; printf '{"stage":"%s","unit":"%s","version":1,"writes":[{"path":"svc/README.md"}]}' $ST $U > $R/construction/$U/$ST/source-manifest.json; aidlc engine orchestrate next 2>/dev/null | j; approve_plan
step "review 1 READY; complete; next → gate"; review 1; aidlc engine state unit complete --stage $ST --unit $U | j; aidlc engine orchestrate next 2>/dev/null | j
step "Request Changes at the REAL gate → revising; next"; aidlc engine orchestrate report --stage $ST --unit $U --result rejected --user-input 'Request Changes' --reason 'fix R-01' 2>/dev/null | j; aidlc engine orchestrate next 2>/dev/null | j
step "HOOK on a code edit now (expect: blocked, approval for another attempt)"; hook "python3 -c 'open(\"svc/x.py\",\"w\")'"
step "HOOK on report revised (expect: blocked)"; hook "aidlc engine orchestrate report --stage $ST --unit $U --result revised"
step "re-approve the plan for the new attempt (person said Approve Plan)"; approve_plan
step "HOOK on report revised after re-approval (expect: allowed)"; hook "aidlc engine orchestrate report --stage $ST --unit $U --result revised"
step "HOOK on a code edit after re-approval (expect: allowed)"; hook "python3 -c 'open(\"svc/x.py\",\"w\")'"
step "revision: review again, complete, report revised, next → gate, approve"; review 1; aidlc engine state unit start --stage $ST --unit $U | j; aidlc engine state unit complete --stage $ST --unit $U | j; aidlc engine orchestrate report --stage $ST --unit $U --result revised 2>/dev/null | j; aidlc engine orchestrate next 2>/dev/null | j; aidlc engine orchestrate report --stage $ST --unit $U --result approved --user-input Approve 2>/dev/null | j; aidlc engine orchestrate next 2>/dev/null | j
