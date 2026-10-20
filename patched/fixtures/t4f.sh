#!/bin/bash
# The main checkout of a team project while every Unit is claimed elsewhere or blocked, and a fresh
# worktree of it, the way a one-repository project with its own space runs (desktop-app worktrees).
# The intent lives in space demo-space, not "default". Alpha is claimed in worktree pj-wa (branch
# DEMO-2/alpha) and one stage is done there; beta needs alpha, so it is blocked.
# - pj's `next`: says nothing runs from this checkout and where alpha is worked (owner, worktree path,
#   branch), never "main may resume the normal Construction walk"; its board marks alpha as claimed
#   (owner, attempt) although main's own row is untouched.
# - pj with the workflow parked by the person, who comes back: the board, no unpark, pj left clean.
# - pj-wc, a fresh detached worktree of pj (no cursors): finds space demo-space and the intent.
[ -n "${BASH_VERSION:-}" ] && ! shopt -qo posix 2>/dev/null || exec bash "$0" "$@"  # `sh x.sh` on macOS: its echo unescapes the engine's JSON
set -uo pipefail
S=$(cd "$(dirname "$0")" && pwd)
AV=${AIDLC_FIXTURE_VERSION:-$(cat "$HOME/.local/share/aidlc/active-version")}  # the installed build the fixture drives
export AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1 AIDLC_GH_BIN=$S/fakegh FAKE_GH_DB=$S/fakegh4.json
U=DEMO-2-alpha; B=DEMO-2/alpha; V=DEMO-3-beta; A=$HOME/.local/share/aidlc/versions/$AV/aidlc
I=261015-demo-1-uniform-test; R=aidlc/spaces/demo-space/intents/$I
FAIL=0
step() { echo; echo "##### $*"; }
expect() { case "$3" in *"$2"*) echo "   OK   $1";; *) echo "   FAIL $1 (wanted: $2)"; FAIL=$((FAIL+1));; esac; }
refute() { case "$3" in *"$2"*) echo "   FAIL $1 (unwanted: $2)"; FAIL=$((FAIL+1));; *) echo "   OK   $1";; esac; }
human() { T=$S/pj-transcript.jsonl; printf '{"type":"user","cwd":"%s","sessionId":"sim"}\n' "$PWD" > $T
  printf '{"session_id":"sim","transcript_path":"%s","cwd":"%s","hook_event_name":"UserPromptSubmit","prompt":"%s"}' "$T" "$PWD" "$1" | CLAUDE_PROJECT_DIR=$PWD aidlc engine hook record-human-turn >/dev/null 2>&1 || true; }
field() { python3 -c "import json,sys; raw=sys.stdin.read(); i=raw.find('{'); d=json.loads(raw[i:]) if i>=0 else {}; print(d.get('$1',''))" 2>/dev/null; }

for w in pj-wa pj-wc; do [ -d $S/pj ] && git -C $S/pj worktree remove --force $S/$w 2>/dev/null; rm -rf $S/$w; done
$S/reset4.sh || exit 1
cd $S/pj || exit 1
step "one repository, the intent in space demo-space"
python3 - aidlc/spaces/default/intents/intents.json <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
for i in d: i.pop("repos", None)
json.dump(d, open(p, "w"), indent=2); open(p, "a").write("\n")
PY
git mv aidlc/spaces/default aidlc/spaces/demo-space
git commit -qam "one repository; the intent in space demo-space" && git push -q origin HEAD:main
aidlc engine space switch demo-space >/dev/null 2>&1; aidlc engine intent switch $I >/dev/null 2>&1
expect "pj lists the intent in demo-space" "$I" "$(aidlc engine intent list 2>&1)"

step "the person parks the work in pj, before any Unit is claimed"
human "stop here for today"
PARK=$(aidlc engine orchestrate park --person-asked 2>&1); echo "   $(echo "$PARK" | head -c 160)"
refute "parked" '"error"' "$PARK"
git add -A -- aidlc && git commit -qm "parked" && git push -q origin HEAD:main

step "alpha claimed in worktree pj-wa, functional design done there"
git worktree add -q $S/pj-wa -b $B main
cd $S/pj-wa || exit 1
{ $S/pin-here.sh $AV || exit 1; }
aidlc engine space switch demo-space >/dev/null 2>&1; aidlc engine intent switch $I >/dev/null 2>&1
CLAIM=$($A unit claim $U --team wa 2>&1); echo "   $(echo "$CLAIM" | head -c 200)"
refute "alpha claimed" '"error"' "$CLAIM"
python3 $S/next.py next >/dev/null 2>&1
aidlc engine state unit start --stage functional-design --unit $U >/dev/null 2>&1
bun $S/write-stage.ts $PWD $U functional-design >/dev/null
aidlc engine state unit complete --stage functional-design --unit $U >/dev/null 2>&1
echo "   pj-wa's row: $(grep "| $U |" $R/aidlc-state.md)"
WA=$(cd $S/pj-wa && pwd -P)

step "the main checkout pj: next, twice"
cd $S/pj || exit 1
N1=$(python3 $S/next.py next); N2=$(python3 $S/next.py next)
M=$(echo "$N1" | field message); echo "$M" | sed -n '/^## Next Actions/,$p' | sed 's/^/   | /'
expect "the same answer on every call" "$N1" "$N2"
refute "no walk to resume is offered" "main may resume the normal Construction walk" "$M"
expect "nothing runs from this checkout" "Nothing runs from this checkout" "$M"
expect "alpha's worktree is named" "$WA" "$M"
expect "alpha's branch is named" "$B" "$M"
expect "alpha's owner is named" "\`$U\` is claimed by wa" "$M"
ROW=$(echo "$M" | grep "^| $U " | head -1); echo "   board row: $ROW"
expect "the board marks alpha as claimed, with its attempt" "claimed by wa, attempt 1" "$ROW"
refute "the main state file is not changed for it" "claimed by" "$(grep "| $U |" $R/aidlc-state.md)"
SNAP=$(aidlc engine orchestrate team-board --snapshot 2>&1)
expect "the snapshot board marks alpha the same way" "claimed by wa, attempt 1" "$(echo "$SNAP" | grep "^| $U ")"

step "pj, parked by the person before the claims, who comes back: the board, nothing unparked, pj clean"
human "let's continue"
git add -A -- aidlc && git commit -qm "the person's turn" >/dev/null
BACK=$(python3 $S/next.py next); echo "   $(echo "$BACK" | head -c 200)"
refute "no unpark is asked in the main checkout" "unpark" "$BACK"
expect "the dispatcher board answers" "Team Construction Dispatcher" "$BACK"
refute "pj left clean (state and audit)" "aidlc" "$(git status --short -- aidlc)"
RES=$(python3 $S/next.py next --resume); echo "   --resume: $(echo "$RES" | head -c 200)"
expect "--resume in the main checkout answers with the board too" "Team Construction Dispatcher" "$RES"

step "pj-wc, a fresh detached worktree of pj (no cursors)"
git worktree add -q --detach $S/pj-wc main
cd $S/pj-wc || exit 1
{ $S/pin-here.sh $AV || exit 1; }
LIST=$(aidlc engine intent list 2>&1); echo "$LIST" | head -4 | sed 's/^/   | /'
expect "pj-wc lists the intent" "$I" "$LIST"
refute "pj-wc does not read an empty default space" 'No intents in space "default"' "$LIST"
SP=$(aidlc engine space list 2>&1); echo "$SP" | head -4 | sed 's/^/   | /'
expect "pj-wc's active space is demo-space" "demo-space" "$(echo "$SP" | grep -i 'active\|\*')"
NX=$(python3 $S/next.py next); echo "   next: $(echo "$NX" | head -c 200)"
refute "pj-wc's next finds the intent" "No intents in space" "$NX"
refute "pj-wc's next has an active intent" "no active intent" "$NX"
echo; echo "RESULT: $FAIL expectation(s) failed"
exit $FAIL
