#!/bin/sh
# Publish a preview of this fork's main: run upstream's Preview Release workflow and,
# unless --full-suite is given, cancel the Full Suite run it starts. That suite's live
# jobs need upstream's credentials, so in this fork they fail, and the release waits for
# the whole suite before it publishes; the builds, install and update tests still gate it.
# Usage: patched/scripts/release.sh [--full-suite]
set -eu
REPO=${AIDLC_FORK_REPOSITORY:-maksymskuibida/aidlc-workflows}
gh workflow run preview-release.yml --repo "$REPO" --ref main
sleep 10
run=$(gh run list --repo "$REPO" --workflow preview-release.yml --limit 1 --json databaseId -q '.[0].databaseId')
echo "Preview Release: https://github.com/$REPO/actions/runs/$run"
if [ "${1:-}" != --full-suite ]; then
  suite=""
  while [ -z "$suite" ]; do
    sleep 30
    suite=$(gh run list --repo "$REPO" --workflow full-suite.yml --event workflow_dispatch --limit 1 \
      --json databaseId,createdAt,status -q '.[] | select(.status != "completed") | .databaseId')
    [ "$(gh run view "$run" --repo "$REPO" --json status -q .status)" = completed ] && break
  done
  [ -n "$suite" ] && gh run cancel "$suite" --repo "$REPO" && echo "Full Suite run $suite cancelled"
fi
gh run watch "$run" --repo "$REPO" --interval 60 --exit-status
gh release list --repo "$REPO" --limit 1
