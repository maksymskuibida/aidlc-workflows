#!/bin/bash
# One Unit through Code Generation with plan approval and reviews ON, in the engine's own order, then
# three revisions: the reviewer returns findings, the person requests changes at the real gate, the
# engine re-asks the plan, the session fixes, reviews, completes, reopens the gate. The plan-approval
# hook is invoked on a code edit and on the gate reopen inside every round. Ends with the Unit approved.
set -uo pipefail
S=$(cd "$(dirname "$0")" && pwd)
export AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1 AIDLC_GH_BIN=$S/fakegh FAKE_GH_DB=$S/fakegh4.json
U=DEMO-2-alpha; B=DEMO-2/alpha; REV=aidlc-architecture-reviewer-agent; ST=code-generation
R=aidlc/spaces/default/intents/261015-demo-1-uniform-test
FAIL=0
step() { echo; echo "##### $*"; }
expect() { # expect <label> <substring> <text>
  case "$3" in *"$2"*) echo "   OK   $1";; *) echo "   FAIL $1 (wanted: $2)"; FAIL=$((FAIL+1));; esac; }
j() { python3 -c "import json,sys
raw=sys.stdin.read(); i=raw.find('{')
try:
  d=json.JSONDecoder().raw_decode(raw[i:])[0]
except Exception:
  print(raw[:600]); sys.exit()
d.pop('conductor_persona',None)
keys=('kind','stage','unit','gate','gate_only','build_settled','plan_approval','plan_note','error','message','ask_type','reason_codes','emitted','recorded','agent_work','raw','rc')
print({k:str(d.get(k))[:230] for k in keys if d.get(k) is not None})
if d.get('remedies'): print('  remedies:', [(r.get('op'), r.get('executableNow')) for r in d['remedies']])
if d.get('choices'): print('  choices:', [c.get('label') for c in d['choices']])"; }
nxt() { python3 $S/next.py next 2>/dev/null; }
human() { # the person types $1: the engine's own hook records the turn and the reply to the open question
  sleep 1; T=$S/pi-transcript.jsonl; printf '{"type":"user","cwd":"%s","sessionId":"sim"}\n' "$PWD" > $T
  printf '{"session_id":"sim","transcript_path":"%s","cwd":"%s","hook_event_name":"UserPromptSubmit","prompt":"%s"}' "$T" "$PWD" "$1" | CLAUDE_PROJECT_DIR=$PWD aidlc engine hook record-human-turn >/dev/null 2>&1 || true; }
approve_plan() { Q=$R/construction/$U/$ST/code-generation-questions.md; human "Approve Plan"; python3 - "$Q" <<'PY'
import re,sys; p=sys.argv[1]; t=open(p).read()
t=re.sub(r'^\[Answer\]:.*$','[Answer]: Approve Plan',t,count=1,flags=re.M) if re.search(r'^\[Answer\]:',t,re.M) else t.rstrip('\n')+'\n[Answer]: Approve Plan\n'
open(p,'w').write(t)
PY
aidlc engine log answer --stage $ST --checkpoint plan-approval --questions-file $Q --details 'Approve Plan' --unit $U 2>&1; }
review() { # $1 iteration $2 verdict
  OUT=$(aidlc engine log review --stage $ST --reviewer $REV --unit $U --iteration $1 2>&1); echo "$OUT" | j
  RF=$(echo "$OUT" | python3 -c "import json,sys; raw=sys.stdin.read(); i=raw.find('{'); d=json.loads(raw[i:]) if i>=0 else {}; print(d.get('reviewFile',''))"); [ -n "$RF" ] || return
  printf '## Review\n\n**Verdict:** %s\n**Reviewer:** %s\n**Date:** 2026-10-18\n**Iteration:** %s\n**Verdict Dictated:** no\n\n### Findings\n\n| ID | Severity | Location | Finding | Required action | Status |\n|---|---|---|---|---|---|\n| R-01 | Minor | svc/README.md | wording | fix | New |\n' "$2" "$REV" "$1" > "$RF"
  aidlc engine log review --stage $ST --reviewer $REV --unit $U --iteration $1 --verdict $2 2>&1 | j; }
hook() { # hook bash <command> | hook write <abs path> → prints decision
  T=$S/pi-transcript.jsonl; printf '{"type":"user","cwd":"%s","sessionId":"sim"}\n' "$PWD" > $T
  if [ "$1" = write ]; then P=$(printf '{"session_id":"sim","transcript_path":"%s","cwd":"%s","hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"%s","content":"x"}}' "$T" "$PWD" "$2"); else P=$(printf '{"session_id":"sim","transcript_path":"%s","cwd":"%s","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"%s"}}' "$T" "$PWD" "$2"); fi
  echo "$P" | CLAUDE_PROJECT_DIR=$PWD aidlc engine hook guard-tool-call >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] && echo allowed || echo "blocked($rc)"; }
$S/reset4.sh
cd $S/pi
step claim; aidlc unit claim $U --team pi | j
git switch -c $B >/dev/null 2>&1; git -C svc switch -c $B >/dev/null 2>&1
step "stages 1-4 normally"; python3 $S/drive3.py $S/pi $U functional-design nfr-requirements nfr-design infrastructure-design 2>&1 | grep "approve\|^---"
step "reviews on"; env -i HOME="$HOME" PATH="$PATH" AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1 AIDLC_TEST_CONFIG_TTY=1 aidlc engine config set review adversarial 2>&1 | tail -1
step "next → body for the Unit, with the steps note"; D=$(nxt); echo "$D" | j; expect "steps note names unit start first" "unit start --stage code-generation --unit $U" "$D"
step "(1) unit start"; aidlc engine state unit start --stage $ST --unit $U | j
step "(3) plan + code; next → plan question; approve"; bun $S/write-stage.ts $S/pi $U $ST >/dev/null; echo "alpha feature" >> svc/README.md; printf '{"stage":"%s","unit":"%s","version":1,"writes":[{"path":"svc/README.md"}]}' $ST $U > $R/construction/$U/$ST/source-manifest.json; D=$(nxt); echo "$D" | j; expect "plan question" "plan-approval" "$D"; approve_plan | j
step "next → body approved; (4) review READY with findings; (5) complete; (6) next → gate"; nxt | j; review 1 READY; aidlc engine state unit complete --stage $ST --unit $U | j; D=$(nxt); echo "$D" | j; expect "gate presented" '"gate":true' "$D"
step "PROBE: raw next after completion"; python3 $S/next.py next 2>&1 | head -c 2500; echo
step "PROBE: report rejected; raw next"; human "Request Changes: fix R-01"; aidlc engine orchestrate report --stage $ST --unit $U --result rejected --user-input 'Request Changes' --reason 'fix R-01' 2>/dev/null | j; python3 $S/next.py next 2>&1 | head -c 3000; echo
step "PROBE: unit start; append a plan step; next"; aidlc engine state unit start --stage $ST --unit $U | j; printf '\n### Step 9: Review fixes\n- [ ] R-01: fix the wording in svc/README.md\n' >> $R/construction/$U/$ST/code-generation-plan.md; python3 $S/next.py next 2>&1 | head -c 2500; echo
step "PROBE: approve plan; next"; approve_plan | j; python3 $S/next.py next 2>&1 | head -c 1500; echo
step "PROBE: hook code edit after approval"; hook write "$PWD/svc/x.py"
