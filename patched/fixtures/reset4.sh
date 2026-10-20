#!/bin/bash
set -euo pipefail
S=$(cd "$(dirname "$0")" && pwd)
V=${AIDLC_FIXTURE_VERSION:-$(cat "$HOME/.local/share/aidlc/active-version")}  # the installed build the fixture drives
cd $S
# The seeds are built from templates/ by the installed engine (git-ignored): when missing, or
# when they were built by another build than the one installed now.
[ -d seed4 ] && [ -d svcseed4 ] && [ "$(cat seed4/.aidlc-version)" = "$V" ] || ./make-seeds.sh "$V"
for w in pj-wt; do [ -d $w ] && git -C pj worktree remove --force $w 2>/dev/null || true; done
rm -rf wsp4.git svc4.git pi pj pj-wt pr-*.md
git clone -q --bare seed4 wsp4.git; git clone -q --bare svcseed4 svc4.git
for c in pi pj; do
  git clone -q wsp4.git $c; git -C $c config user.name $c; git -C $c config user.email $c@example.test; git -C $c config fakegh.repo example/ws
  git clone -q svc4.git $c/svc; git -C $c/svc config user.name $c; git -C $c/svc config user.email $c@example.test; git -C $c/svc config fakegh.repo example/svc
  (cd $c && $S/pin-here.sh $V) || exit 1
  out=$(cd $c && aidlc engine intent switch 261015-demo-1-uniform-test 2>&1) || { echo "reset4: intent switch in $c failed: $out" >&2; exit 1; }
done
echo '{}' > fakegh4.json
echo "reset: $(git -C wsp4.git log --oneline -1 main) / $(git -C svc4.git log --oneline -1 main)"
