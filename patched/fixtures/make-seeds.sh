#!/bin/bash
# Build the seed repositories reset4.sh clones: seed4 (the workspace: one intent in Construction,
# team-owned, per-stage gates, Units DEMO-2-alpha and DEMO-3-beta, no Unit started) and svcseed4
# (the service repository the intent names). Their files live in templates/; the workspace's engine
# shell is not stored, it is generated here by the installed engine at the pinned version.
# Usage: make-seeds.sh [version, default the installed build]   (reset4.sh runs it when a seed is
# missing or was built by another build)
set -euo pipefail
S=$(cd "$(dirname "$0")" && pwd)
VERSION=${1:-$(cat "$HOME/.local/share/aidlc/active-version")}
cd $S
# Built under temporary names and moved into place only once complete, so a run that stops
# part way (aidlc refused, the machine-wide lock held) leaves no half-built seed behind.
rm -rf seed4.tmp svcseed4.tmp
seed() { # seed <dir> <template> <message>
  git init -q -b main $1
  git -C $1 config user.name seed; git -C $1 config user.email seed@example.test
  cp -R templates/$2/. $1/
  git -C $1 add -A && git -C $1 commit -q -m "$3"
}
seed svcseed4.tmp svc "service"
seed seed4.tmp ws "workspace records"
# templates/ws/.aidlc-version pins the engine; a different version is written there first.
[ "$(cat seed4.tmp/.aidlc-version)" = "$VERSION" ] || { echo "$VERSION" > seed4.tmp/.aidlc-version; git -C seed4.tmp commit -q -am "pin $VERSION"; }
# Another session's aidlc may hold the machine-wide transaction lock for a moment: wait for it.
out=""
for try in 1 2 3 4 5 6 7 8 9 10; do
  out=$(cd seed4.tmp && AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1 aidlc config --harness claude --yes 2>&1) && break
  case "$out" in *"another AI-DLC mutation holds"*) sleep 3;; *) echo "make-seeds: aidlc config failed: $out" >&2; exit 1;; esac
done
[ -d seed4.tmp/.claude ] || { echo "make-seeds: aidlc config left no shell: $out" >&2; exit 1; }
git -C seed4.tmp add -A && git -C seed4.tmp commit -q -m "engine shell $VERSION"
rm -rf seed4 svcseed4 && mv svcseed4.tmp svcseed4 && mv seed4.tmp seed4
echo "seeds: $(git -C seed4 log --oneline -1) / $(git -C svcseed4 log --oneline -1)"
