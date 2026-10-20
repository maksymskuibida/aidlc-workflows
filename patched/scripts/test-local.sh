#!/usr/bin/env bash
# Run this fork's tests on this machine, in place of GitHub Actions (the fork's test workflows are off so
# they spend no Actions minutes). Tests run against one commit, checked out in a temporary worktree, so
# what is tested is exactly what is pushed or released, whatever the working tree holds.
#
#   patched/scripts/test-local.sh fast <commit> [<base>]   checks, smoke, and the test files changed since <base>
#   patched/scripts/test-local.sh full <commit>            checks plus the smoke, unit and integration tiers (4 h+)
#   patched/scripts/test-local.sh key <commit>             the key a full pass is recorded under
#
# fast is what the pre-push hook runs on a push to main. full is what a push to main and a release need: a
# pass is recorded in the repository's aidlc-tested-trees under the commit's tree without patched/ (the
# fork's notes and scripts, which no test reads), so a rebase or a notes change keeps it. Test files that fail on this machine whatever the change are listed in
# patched/known-local-failures.txt; full fails only on a failure outside that list.
set -euo pipefail
usage="usage: test-local.sh fast|full|key <commit> [<base>]"
MODE=${1:?$usage}
COMMIT=$(git rev-parse --verify "${2:?$usage}^{commit}")
BASE=${3:-}
ROOT=$(git rev-parse --show-toplevel)
COMMON=$(cd "$(git rev-parse --git-common-dir)" && pwd)
KEY=$(git ls-tree "$COMMIT" | awk -F '\t' '$2 != "patched"' | git mktree)
if [ "$MODE" = key ]; then echo "$KEY"; exit 0; fi
KNOWN="$ROOT/patched/known-local-failures.txt"
WT=$(mktemp -d "${TMPDIR:-/tmp}/aidlc-test-local.XXXXXX")
cleanup() { git -C "$ROOT" worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "$WT"; }
trap cleanup EXIT
git -C "$ROOT" worktree add --quiet --detach "$WT" "$COMMIT"
cd "$WT"
# Inside a Claude Code session the engine adds session notices that tests parse as output.
unset CLAUDE_CODE_SESSION_ID CLAUDECODE
# A hook run from a linked worktree exports an absolute GIT_DIR; kept, it points every git command the
# tests run at this clone instead of their own fixture repositories (a fixture's git init made it bare).
# shellcheck disable=SC2046 # one name per word, split on purpose
unset $(git rev-parse --local-env-vars)

step() { printf '\n== %s\n' "$1"; }
step "install"
bun install --frozen-lockfile >/dev/null
step "checks: package, determinism, typecheck, lint"
bun run check >check.log 2>&1 || { tail -n 40 check.log >&2; echo "bun run check failed." >&2; exit 1; }

case "$MODE" in
  fast)
    step "smoke tier"
    bash tests/run-tests.sh --smoke | tail -n 2
    [ -n "$BASE" ] || exit 0
    for level in unit integration; do
      # Test file names are letters, digits, dots, dashes and underscores; only the dots need escaping.
      changed=$(git diff --name-only --diff-filter=AM "$BASE" "$COMMIT" -- "tests/$level/*.test.ts" |
        sed 's|.*/||; s|\.test\.ts$||; s|\.|\\.|g' | paste -sd '|' -)
      [ -n "$changed" ] || continue
      step "$level test files changed since $(git rev-parse --short "$BASE")"
      bash tests/run-tests.sh "--$level" --filter "^($changed)\.test\.ts$" | tail -n 2
    done
    ;;
  full)
    step "smoke, unit and integration tiers"
    # The Mac must not sleep mid-run: a file that sleeps through its deadline fails as a timeout. A file
    # that fails is retried once on its own, as the merge queue does.
    keep_awake=(); command -v caffeinate >/dev/null && keep_awake=(caffeinate -i)
    ${keep_awake[@]+"${keep_awake[@]}"} bash tests/run-tests.sh --ci --verbose --file-retries 1 >run.log 2>&1 || true
    logs=$(sed -n 's/^Verbose mode: logging to //p' run.log | head -n 1)
    [ -f "$logs/summary.txt" ] || { tail -n 20 run.log >&2; echo "No test summary was written." >&2; exit 1; }
    sed -n '/^Totals:/,$p' "$logs/summary.txt"
    # The summary names a file by its basename without .test.ts (integration-<name> where a unit file shares it).
    failed=$(awk '/^Per-file results:/{f=1; next} /^Totals:/{f=0} f && $2 == "FAIL" {print $1}' "$logs/summary.txt" | sort -u)
    known=$(grep -vE '^[[:space:]]*(#|$)' "$KNOWN" 2>/dev/null | awk '{print $1}' | sort -u || true)
    new=$(comm -23 <(printf '%s\n' "$failed" | sed '/^$/d') <(printf '%s\n' "$known" | sed '/^$/d'))
    fixed=$(comm -13 <(printf '%s\n' "$failed" | sed '/^$/d') <(printf '%s\n' "$known" | sed '/^$/d'))
    [ -z "$fixed" ] || printf '\nListed in patched/known-local-failures.txt but passed now (take them off the list):\n%s\n' "$fixed"
    if [ -n "$new" ]; then
      rm -rf "$COMMON/aidlc-last-full-run"; cp -R "$logs" "$COMMON/aidlc-last-full-run" 2>/dev/null || true
      printf '\nFailed, and not a known local failure:\n%s\nLogs: %s\n' "$new" "$COMMON/aidlc-last-full-run" >&2
      exit 1
    fi
    printf '%s\n' "$KEY" >>"$COMMON/aidlc-tested-trees"
    printf '\nFull local run passed for %s.\n' "$(git rev-parse --short "$COMMIT")"
    ;;
  *) echo "$usage" >&2; exit 2 ;;
esac
