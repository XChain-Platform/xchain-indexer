#!/usr/bin/env bash
#
# Refresh (or check) the vendored copy of xchain-vm used by the indexer.
#
# The indexer depends on xchain-vm via "file:./xchain-vm" (see package.json): a copy
# staged inside this repo so the Docker build context is self-contained. In a normal
# rollout, xchain-node re-clones that copy fresh on every `update` (ModuleService
# buildAndUp), so dev/prod/test images are never stale. This script covers the one
# case xchain-node does NOT: a developer running the indexer's unit tests in-place,
# where a leftover ./xchain-vm from a prior run can drift behind the canonical sibling
# and redden test/unit/consensus-params.test.js (CONSENSUS_VERSION mismatch).
#
# Source of truth: the canonical sibling checkout ../xchain-vm (override with
# XCHAIN_VM_SOURCE). This is a LOCAL DEV convenience only; it is not part of the
# build/rollout path.
#
# Usage:
#   bin/vendor-vm.sh           # refresh ./xchain-vm from the sibling, then verify
#   bin/vendor-vm.sh fix       # same as above (explicit)
#   bin/vendor-vm.sh check     # verify version + src/ content match; non-zero exit on drift (no writes)
#
# Requires Node 22 for the isolated-vm native build (see the Dockerfile note).

set -euo pipefail

INDEXER_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${XCHAIN_VM_SOURCE:-$INDEXER_ROOT/../xchain-vm}"
DEST="$INDEXER_ROOT/xchain-vm"
MODE="${1:-fix}"

# Read CONSENSUS_VERSION straight from the frozen export so the check never needs to
# load isolated-vm. Empty if the file/const is missing.
vm_version() {
    grep -oE "CONSENSUS_VERSION = '[^']+'" "$1/src/consensus-runtime.js" 2>/dev/null \
        | grep -oE "'[^']+'" | tr -d "'" || true
}

# Per-file sha1 manifest of the consensus surface (src/** + package.json, which
# carries the frozen math-library pins), sorted for stable comparison. The version
# string alone CANNOT detect drift: the 2026-07 incident shipped vendored copies
# missing two consensus gates (STATE_KEY_NUL, METERING_EVAL_ORDER) while still
# declaring the same CONSENSUS_VERSION.
if command -v sha1sum >/dev/null 2>&1; then SHA1=sha1sum; else SHA1="shasum -a 1"; fi
tree_manifest() {
    ( cd "$1" && { find src -type f; echo package.json; } | LC_ALL=C sort | xargs $SHA1 )
}

if [ ! -d "$SRC/src" ]; then
    # A drift-guard context (bin/ci-all.sh, the CI drift-guards job) checked out
    # the canonical sibling on purpose; a missing SRC there means the guard is
    # about to green-by-skip, so fail closed instead.
    if [ -n "${XCHAIN_REQUIRE_SIBLINGS:-}" ]; then
        echo "vendor-vm: canonical source not found at $SRC and XCHAIN_REQUIRE_SIBLINGS is set; refusing to skip." >&2
        exit 1
    fi
    echo "vendor-vm: canonical source not found at $SRC" >&2
    echo "vendor-vm: this is expected in a standalone checkout (no monorepo sibling)." >&2
    echo "vendor-vm: in that case the build pipeline (xchain-node) stages xchain-vm; nothing to do here." >&2
    # Not an error for a standalone checkout: leave any staged copy untouched.
    exit 0
fi

SRC_VER="$(vm_version "$SRC")"
DEST_VER="$(vm_version "$DEST")"

if [ "$MODE" = "check" ]; then
    echo "vendor-vm: canonical=${SRC_VER:-<none>} vendored=${DEST_VER:-<none>}"
    if [ -z "$DEST_VER" ]; then
        echo "vendor-vm: no vendored xchain-vm found at $DEST. Run 'npm run vendor:vm' to stage it." >&2
        exit 1
    fi
    if [ "$SRC_VER" != "$DEST_VER" ]; then
        echo "vendor-vm: DRIFT - vendored CONSENSUS_VERSION ($DEST_VER) != canonical ($SRC_VER)." >&2
        echo "vendor-vm: run 'npm run vendor:vm' to refresh the in-place copy." >&2
        exit 1
    fi
    # A matching version is necessary but NOT sufficient: compare src/ content hashes
    # so a same-version stale copy fails closed.
    SRC_MAN="$(tree_manifest "$SRC")"
    DEST_MAN="$(tree_manifest "$DEST")"
    if [ "$SRC_MAN" != "$DEST_MAN" ]; then
        echo "vendor-vm: DRIFT - vendored src/ content differs from canonical (CONSENSUS_VERSION matches, bytes do not):" >&2
        diff <(printf '%s\n' "$SRC_MAN") <(printf '%s\n' "$DEST_MAN") >&2 || true
        echo "vendor-vm: run 'npm run vendor:vm' to refresh the in-place copy." >&2
        exit 1
    fi
    echo "vendor-vm: in sync (version + src/ content hash)."
    exit 0
fi

echo "vendor-vm: refreshing $DEST from $SRC (canonical CONSENSUS_VERSION=${SRC_VER:-<none>})"

# Mirror the canonical source over the vendored copy. Exclude the same dirs xchain-node
# strips when staging (node_modules/.git/test/bench/reports). node_modules is preserved
# in DEST via the exclude so an already-built isolated-vm is reused when deps are
# unchanged; the npm install below reconciles it if package.json moved.
rsync -a --delete \
    --exclude 'node_modules' \
    --exclude '.git' \
    --exclude 'test' \
    --exclude 'bench' \
    --exclude 'reports' \
    "$SRC/" "$DEST/"

echo "vendor-vm: reconciling dependencies (rebuilds isolated-vm only if changed)..."
( cd "$DEST" && npm install --no-audit --no-fund )

NEW_VER="$(vm_version "$DEST")"
if [ "$NEW_VER" != "$SRC_VER" ]; then
    echo "vendor-vm: ERROR - after refresh vendored version ($NEW_VER) still != canonical ($SRC_VER)" >&2
    exit 1
fi
if [ "$(tree_manifest "$DEST")" != "$(tree_manifest "$SRC")" ]; then
    echo "vendor-vm: ERROR - after refresh vendored src/ content still differs from canonical" >&2
    exit 1
fi
echo "vendor-vm: done. vendored xchain-vm now at CONSENSUS_VERSION=$NEW_VER (src/ content verified)"
