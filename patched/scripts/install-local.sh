#!/bin/sh
# Build this checkout (the fork's main, or a branch of it) and install it on this machine
# as a local test build, to run the fixtures before a release. A local build never takes a
# release's number: give it one from .900 up, e.g. 2.11.2-preview.20261021.901.
# Usage: patched/scripts/install-local.sh <version>
set -eu
VERSION=${1:?usage: install-local.sh <version, e.g. 2.11.2-preview.20261021.901>}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
bun install --frozen-lockfile
AIDLC_BUILD_VERSION="$VERSION" bun scripts/package.ts
AIDLC_BUILD_VERSION="$VERSION" bun scripts/build-binaries.ts --target native
AIDLC_BUILD_VERSION="$VERSION" bun scripts/package-release.ts --output build/release
# A local build has no provenance; the installer checks the checksums only when it cannot
# verify an attestation (AIDLC_GH_BIN=/nonexistent).
printf 'aidlc-local-build-provenance-placeholder\n' > build/release/aidlc-release.intoto.jsonl
INSTALLED="$HOME/.local/share/aidlc/versions/$VERSION"
[ -d "$INSTALLED" ] && mv "$INSTALLED" "$INSTALLED.replaced-$(date +%Y%m%d%H%M%S)"
(cd build/release && AIDLC_GH_BIN=/nonexistent sh install.sh --from "$PWD" --yes)
aidlc version
