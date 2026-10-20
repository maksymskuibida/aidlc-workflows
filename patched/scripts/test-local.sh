#!/usr/bin/env bash
# Run this fork's tests on this machine, in place of GitHub Actions (the fork's test workflows are off so
# they spend no Actions minutes). Tests run against one commit, checked out in a temporary worktree, so
# what is tested is exactly what is pushed or released, whatever the working tree holds.
#
#   test-local.sh fast <commit> [<base>]             checks, smoke, and the test files changed since <base>
#   test-local.sh full <commit> [options]            checks and every smoke, unit and integration file in
#                                                    parallel, the series' patch tests first (about 1 h 20 min)
#   test-local.sh patches <commit> [--patches 07,12] [--rest] [options]
#                                                    checks and the tests tied to the patches (all, or the
#                                                    ones named); --rest goes on with everything else
#   test-local.sh files <commit> <regex> [options]   checks and the test files whose name matches <regex>
#   test-local.sh plan <commit> [--patches ...]      the queue a run would use, with each patch's tests
#   test-local.sh watch|status|stop [<run-dir>]      follow, show or stop a run (the latest by default)
#   test-local.sh full-serial <commit>               upstream's own runner, one file at a time (8 h+)
#   test-local.sh key <commit>                       the key a full pass is recorded under
#
# options: --workers N (default 8), --stop-on-first, --max-failures N (default 25), --no-check,
#          --real-home (jobs keep $HOME instead of a fresh one per worker)
#
# fast is what the pre-push hook runs on a push to main, unless the tree already has a recorded full pass
# (full ran fast's checks, smoke, unit and integration files, so the hook skips fast then). The hook picks
# <base>: the remote's main on a fast-forward, the commit's merge-base with upstream/main when the push
# rewrites history, so a series move runs only the test files our patches touch. full (or full-serial) is what a push to main and a
# release need: a pass is recorded in the repository's aidlc-tested-trees under the commit's tree without
# patched/ (the fork's notes and scripts, which no test reads), so a rebase or a notes change keeps it. Test
# files that fail on this machine whatever the change are listed in patched/known-local-failures.txt; a run
# fails only on a failure outside that list. Each parallel run writes events.jsonl, summary.txt and the logs
# of every file under .git/aidlc-test-runs/<run>/; RUNBOOK section 1b says how an agent follows one.
set -euo pipefail
usage="usage: test-local.sh fast|full|patches|files|plan|full-serial|key <commit> ... | watch|status|stop [<run-dir>]"
MODE=${1:?$usage}
shift
ROOT=$(git rev-parse --show-toplevel)
COMMON=$(cd "$(git rev-parse --git-common-dir)" && pwd)
RUNS="$COMMON/aidlc-test-runs"
RUNNER="$ROOT/patched/scripts/test-runner.ts"

case "$MODE" in
  watch|status|stop)
    run=${1:-$RUNS/latest}
    [ -f "$run/events.jsonl" ] || { echo "No run at $run." >&2; exit 2; }
    case "$MODE" in
      watch) exec bun "$RUNNER" watch "$run" ;;
      status) cat "$run/status.json" 2>/dev/null || tail -n 1 "$run/events.jsonl" ;;
      stop) touch "$run/STOP"; echo "Asked the run in $run to stop; it ends its running files and writes its summary." ;;
    esac
    exit 0
    ;;
esac

COMMIT=$(git rev-parse --verify "${1:?$usage}^{commit}")
shift
KEY=$(git ls-tree "$COMMIT" | awk -F '\t' '$2 != "patched"' | git mktree)
if [ "$MODE" = key ]; then echo "$KEY"; exit 0; fi
BASE=
[ "$MODE" = fast ] && BASE=${1:-}
ONLY=
if [ "$MODE" = files ]; then ONLY=${1:?usage: test-local.sh files <commit> <regex>}; shift; fi
check=1 runner_args=()
while [ $# -gt 0 ] && [ "$MODE" != fast ]; do
  case "$1" in
    --no-check) check=0 ;;
    --rest) [ "$MODE" = patches ] || { echo "--rest is for patches." >&2; exit 2; }; rest=1 ;;
    --workers|--max-failures|--patches) runner_args+=("$1" "${2:?$1 needs a value}"); shift ;;
    --stop-on-first|--real-home|--keep-workers|--json) runner_args+=("$1") ;;
    *) echo "Unknown option $1. $usage" >&2; exit 2 ;;
  esac
  shift
done
[ "$MODE" = full ] && check=1
[ "$MODE" = patches ] && [ -z "${rest:-}" ] && runner_args+=(--patch-tests-only)
[ -n "$ONLY" ] && runner_args+=(--only "$ONLY")

KNOWN="$ROOT/patched/known-local-failures.txt"
WT=$(mktemp -d "${TMPDIR:-/tmp}/aidlc-test-local.XXXXXX")
cleanup() { git -C "$ROOT" worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "$WT"; git -C "$ROOT" worktree prune; }
trap cleanup EXIT
git -C "$ROOT" worktree add --quiet --detach "$WT" "$COMMIT"
cd "$WT"
# Inside a Claude Code session the engine adds session notices that tests parse as output.
unset CLAUDE_CODE_SESSION_ID CLAUDECODE
# A hook run from a linked worktree exports an absolute GIT_DIR; kept, it points every git command the
# tests run at this clone instead of their own fixture repositories (a fixture's git init made it bare).
# shellcheck disable=SC2046 # one name per word, split on purpose
unset $(git rev-parse --local-env-vars)

if [ "$MODE" = plan ]; then bun "$RUNNER" plan --repo "$WT" ${runner_args[@]+"${runner_args[@]}"}; exit; fi

step() { printf '\n== %s\n' "$1"; }
step "install"
bun install --frozen-lockfile >/dev/null
# fast checks first; a parallel run checks beside its tests (bun run check takes about 7 min) and reports
# a failed check as an event like a failed file.
if [ "$MODE" = fast ] || [ "$MODE" = full-serial ]; then
  step "checks: package, determinism, typecheck, lint"
  bun run check >check.log 2>&1 || { tail -n 40 check.log >&2; echo "bun run check failed." >&2; exit 1; }
elif [ "$check" = 1 ]; then
  runner_args+=(--check)
fi

# The Mac must not sleep mid-run: a file that sleeps through its deadline fails as a timeout.
keep_awake=(); command -v caffeinate >/dev/null && keep_awake=(caffeinate -i)

# Lists the known local failures that passed in a run's summary, and the failures not on the list.
judge() {
  failed=$(awk '/^Per-file results:/{f=1; next} /^Totals:/{f=0} f && $2 == "FAIL" {print $1}' "$1" | sort -u)
  passed=$(awk '/^Per-file results:/{f=1; next} /^Totals:/{f=0} f && $2 == "PASS" {print $1}' "$1" | sort -u)
  known=$(grep -vE '^[[:space:]]*(#|$)' "$KNOWN" 2>/dev/null | awk '{print $1}' | sort -u || true)
  new=$(comm -23 <(printf '%s\n' "$failed" | sed '/^$/d') <(printf '%s\n' "$known" | sed '/^$/d'))
  fixed=$(comm -12 <(printf '%s\n' "$passed" | sed '/^$/d') <(printf '%s\n' "$known" | sed '/^$/d'))
  [ -z "$fixed" ] || printf '\nListed in patched/known-local-failures.txt but passed now (take them off the list):\n%s\n' "$fixed"
}

case "$MODE" in
  fast)
    # A file on the known-local-failures list fails here whatever the change, as in full. The list
    # names an integration file it shares with another tier as integration-<name>.
    tier() {
      local label=$1 level=$2 log failed known new
      shift 2
      log=$(mktemp "${TMPDIR:-/tmp}/aidlc-$level.XXXXXX")
      if ! bash tests/run-tests.sh "--$level" "$@" >"$log" 2>&1; then
        failed=$(sed -n 's/^--- FAIL: \(.*\)\.test\.ts ---$/\1/p' "$log" | sort -u)
        known=$(grep -vE '^[[:space:]]*(#|$)' "$KNOWN" 2>/dev/null | awk '{print $1}' |
          sed "s/^$level-//" | sort -u || true)
        new=$(comm -23 <(printf '%s\n' "$failed" | sed '/^$/d') <(printf '%s\n' "$known" | sed '/^$/d'))
        if [ -z "$failed" ] || [ -n "$new" ]; then
          tail -n 20 "$log" >&2
          echo "$label failed: ${new:-see above}. Log: $log" >&2
          exit 1
        fi
        printf 'Failures, every one a known local failure: %s\n' "$(printf '%s ' $failed)"
      fi
      tail -n 2 "$log"
    }
    step "smoke tier"
    tier "Smoke tier" smoke
    [ -n "$BASE" ] || exit 0
    for level in unit integration; do
      # Test file names are letters, digits, dots, dashes and underscores; only the dots need escaping.
      changed=$(git diff --name-only --diff-filter=AM "$BASE" "$COMMIT" -- "tests/$level/*.test.ts" |
        sed 's|.*/||; s|\.test\.ts$||; s|\.|\\.|g' | paste -sd '|' -)
      [ -n "$changed" ] || continue
      step "$level test files changed since $(git rev-parse --short "$BASE")"
      tier "The $level tier" "$level" --filter "^($changed)\.test\.ts$"
    done
    ;;
  full|patches|files)
    run="$RUNS/$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short "$COMMIT")-$MODE"
    mkdir -p "$run"
    ln -sfn "$run" "$RUNS/latest"
    # Older runs go, newest ten kept.
    find "$RUNS" -mindepth 1 -maxdepth 1 -type d -name '20*' | sort -r | tail -n +11 | xargs rm -rf || true
    step "$MODE run: $run"
    printf 'Follow it:  %s watch %s\nStop it:    %s stop %s\n' "$0" "$run" "$0" "$run"
    status=0
    ${keep_awake[@]+"${keep_awake[@]}"} bun "$RUNNER" run --repo "$WT" --run-dir "$run" --known "$KNOWN" \
      ${runner_args[@]+"${runner_args[@]}"} | tee "$run/runner.log" || status=$?
    [ -f "$run/summary.txt" ] || { echo "No test summary was written." >&2; exit 1; }
    sed -n '/^Totals:/,$p' "$run/summary.txt"
    judge "$run/summary.txt"
    if [ -n "$new" ] || [ "$status" != 0 ]; then
      printf '\nFailed, and not a known local failure:\n%s\nLogs: %s\n' "${new:-(none; the run did not finish)}" "$run" >&2
      exit 1
    fi
    if [ "$MODE" = full ] && grep -q '^Complete: yes' "$run/summary.txt"; then
      printf '%s\n' "$KEY" >>"$COMMON/aidlc-tested-trees"
      printf '\nFull local run passed for %s.\n' "$(git rev-parse --short "$COMMIT")"
    fi
    ;;
  full-serial)
    step "smoke, unit and integration tiers, one file at a time"
    # A file that fails is retried once on its own, as the merge queue does.
    ${keep_awake[@]+"${keep_awake[@]}"} bash tests/run-tests.sh --ci --verbose --file-retries 1 >run.log 2>&1 || true
    logs=$(sed -n 's/^Verbose mode: logging to //p' run.log | head -n 1)
    [ -f "$logs/summary.txt" ] || { tail -n 20 run.log >&2; echo "No test summary was written." >&2; exit 1; }
    sed -n '/^Totals:/,$p' "$logs/summary.txt"
    judge "$logs/summary.txt"
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
