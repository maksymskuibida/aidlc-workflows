#!/bin/bash
# merge_pr.sh <bare-remote> <branch> <db> <owner/repo#n> <reviewer> [--no-update-db]
# Squash-merges <branch> into main of the bare remote (as GitHub would) and
# marks the fake pull request MERGED + APPROVED.
set -euo pipefail
remote=$1; branch=$2; db=$3; key=$4; reviewer=$5
tmp=$(mktemp -d)
git clone -q "$remote" "$tmp/m"
cd "$tmp/m"
git -c user.name=github -c user.email=noreply@github.com merge --squash "origin/$branch" >/dev/null
git -c user.name=github -c user.email=noreply@github.com commit -qm "$(git log -1 --format=%s origin/$branch) (${key##*#})"
git push -q origin main
oid=$(git rev-parse HEAD)
cd /; rm -rf "$tmp"
python3 - "$db" "$key" "$oid" "$reviewer" <<'PY'
import json, sys, datetime
db_path, key, oid, reviewer = sys.argv[1:]
db = json.load(open(db_path))
rec = db[key]
rec.update({'state': 'MERGED', 'mergedAt': datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
            'mergeCommit': {'oid': oid}, 'reviewDecision': 'APPROVED',
            'latestReviews': [{'state': 'APPROVED', 'author': {'login': reviewer}}]})
json.dump(db, open(db_path, 'w'), indent=1)
print(f'merged {key} as {oid[:10]}')
PY
