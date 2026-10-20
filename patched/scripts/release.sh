#!/usr/bin/env bash
# Publish a preview of this fork's main through upstream's Preview Release workflow. The fork runs its
# tests on this machine, not in Actions, so main must have passed a full local run
# (patched/scripts/test-local.sh full) before the release starts; in Actions it then only builds, attests
# and publishes. The first job that fails stops the wait: the run is cancelled and its log named.
# Usage: patched/scripts/release.sh
set -euo pipefail
REPO=${AIDLC_FORK_REPOSITORY:-maksymskuibida/aidlc-workflows}
COMMON=$(cd "$(git rev-parse --git-common-dir)" && pwd)
git fetch --quiet origin main
main=$(git rev-parse --short origin/main)
if ! grep -qxF "$("$(dirname "$0")/test-local.sh" key origin/main)" "$COMMON/aidlc-tested-trees" 2>/dev/null; then
  echo "main ($main) has no full local test run on this machine. Run it first (about 4 hours):" >&2
  echo "  patched/scripts/test-local.sh full origin/main" >&2
  exit 1
fi
run=$(gh api --method POST -H 'X-GitHub-Api-Version: 2026-03-10' \
  "repos/$REPO/actions/workflows/preview-release.yml/dispatches" -f ref=main --jq '.workflow_run_id')
echo "Preview Release of $main: https://github.com/$REPO/actions/runs/$run"
while :; do
  sleep 30
  failed=$(gh api "repos/$REPO/actions/runs/$run/jobs?per_page=100" \
    --jq '.jobs[] | select(.conclusion == "failure" or .conclusion == "timed_out") | "\(.name)\t\(.html_url)"' | head -n 1)
  if [ -n "$failed" ]; then
    printf 'Failed: %s\n' "$failed" | tr '\t' ' ' >&2
    gh run cancel "$run" --repo "$REPO" >/dev/null 2>&1 || true
    echo "Run $run cancelled; nothing was published." >&2
    exit 1
  fi
  read -r status conclusion < <(gh run view "$run" --repo "$REPO" --json status,conclusion --jq '"\(.status) \(.conclusion)"')
  [ "$status" = completed ] || continue
  [ "$conclusion" = success ] || { echo "Run $run ended $conclusion." >&2; exit 1; }
  break
done
gh release list --repo "$REPO" --limit 1
