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
rm -rf seed4 svcseed4
seed() { # seed <dir> <template> <message>
  git init -q -b main $1
  git -C $1 config user.name seed; git -C $1 config user.email seed@example.test
  cp -R templates/$2/. $1/
  git -C $1 add -A && git -C $1 commit -q -m "$3"
}
seed svcseed4 svc "service"
seed seed4 ws "workspace records"
# templates/ws/.aidlc-version pins the engine; a different version is written there first.
[ "$(cat seed4/.aidlc-version)" = "$VERSION" ] || { echo "$VERSION" > seed4/.aidlc-version; git -C seed4 commit -q -am "pin $VERSION"; }
(cd seed4 && AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1 aidlc config --harness claude --yes >/dev/null)
git -C seed4 add -A && git -C seed4 commit -q -m "engine shell $VERSION"
echo "seeds: $(git -C seed4 log --oneline -1) / $(git -C svcseed4 log --oneline -1)"
