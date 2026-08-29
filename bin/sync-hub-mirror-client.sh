#!/usr/bin/env bash
#
# Copyright © 2025–2026 Dankest, LLC
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Sync the canonical hub-DB mirror client from xchain-indexer/src (the proven
# consumer of the hub's /hub-db snapshot+subscribe feed) into each consuming
# service's vendored copy. Services build into independent containers without
# sibling repos, so each bundles a byte-identical copy; this script keeps them
# in sync (same pattern as xchain-hub/bin/sync-coins.sh for the coin registry).
#
# Vendored set: the client (hub_db_sync.js), the schema-version lockstep
# constant (hub-schema-version.js), and the mirror-table SQL twins the
# client's ensureTables() creates for consumers without their own schema
# machinery (the explorer's copies land under src/sql/hub-mirror/ so they are
# obviously not the explorer's own tables).
#
# Usage:
#   sync-hub-mirror-client.sh           Copy canonical -> every consumer (overwrites vendored copies).
#   sync-hub-mirror-client.sh --check   Verify every vendored copy is byte-identical; exit 1 on drift.
#                                       Use in CI so a drifted/forgotten copy fails the build.
#
set -euo pipefail

# Repo root is two levels up from this script (xchain-indexer/bin -> xchain-indexer -> root).
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/../src"
ROOT="$(cd "$HERE/../.." && pwd)"

CLIENT_FILES="hub_db_sync.js hub-schema-version.js"
SQL_FILES="price_snapshots.sql oracle_prices.sql cross_chain_matches.sql cross_chain_calls.sql capability_snapshots.sql state_checkpoints.sql anchor_reward_attestations.sql"
SERVICES="xchain-explorer"

CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

drift=0
for svc in $SERVICES; do
    dest="$ROOT/$svc/src"
    sqldest="$dest/sql/hub-mirror"
    for f in $CLIENT_FILES; do
        if [ "$CHECK" -eq 1 ]; then
            if ! cmp -s "$SRC/$f" "$dest/$f"; then
                echo "DRIFT: $svc/src/$f differs from canonical xchain-indexer/src/$f"
                drift=1
            fi
        else
            mkdir -p "$dest"
            cp "$SRC/$f" "$dest/$f"
        fi
    done
    for f in $SQL_FILES; do
        if [ "$CHECK" -eq 1 ]; then
            if ! cmp -s "$SRC/sql/$f" "$sqldest/$f"; then
                echo "DRIFT: $svc/src/sql/hub-mirror/$f differs from canonical xchain-indexer/src/sql/$f"
                drift=1
            fi
        else
            mkdir -p "$sqldest"
            cp "$SRC/sql/$f" "$sqldest/$f"
        fi
    done
done

# ---- indexer <-> hub HUB_SCHEMA_VERSION lockstep check ----------------------
# hub-schema-version.js is not vendored FROM the hub (the indexer's copy above
# is the canonical file synced OUT to consumers); the hub keeps its own,
# independent source file at xchain-hub/src/hub-schema-version.js, and both
# MUST declare the same HUB_SCHEMA_VERSION value or a hub upgrade can silently
# fork the ledger (see that file's own header comment). A byte-cmp would be
# too strict here (the two files carry different repo headers by design), so
# this extracts just the numeric constant from each side and compares values.
if [ "$CHECK" -eq 1 ]; then
    HUB_VERSION_FILE="$ROOT/xchain-hub/src/hub-schema-version.js"
    if [ -f "$HUB_VERSION_FILE" ]; then
        indexer_ver="$(grep -oE 'HUB_SCHEMA_VERSION = [0-9]+' "$SRC/hub-schema-version.js" | grep -oE '[0-9]+$')"
        hub_ver="$(grep -oE 'HUB_SCHEMA_VERSION = [0-9]+' "$HUB_VERSION_FILE" | grep -oE '[0-9]+$')"
        if [ -z "$indexer_ver" ] || [ -z "$hub_ver" ]; then
            echo "DRIFT: could not extract HUB_SCHEMA_VERSION from indexer and/or hub source; check both files by hand."
            drift=1
        elif [ "$indexer_ver" != "$hub_ver" ]; then
            echo "DRIFT: xchain-indexer HUB_SCHEMA_VERSION ($indexer_ver) != xchain-hub HUB_SCHEMA_VERSION ($hub_ver)"
            drift=1
        fi
    else
        echo "NOTE: xchain-hub/src/hub-schema-version.js not found at $HUB_VERSION_FILE; skipping indexer<->hub lockstep check (hub repo not checked out alongside indexer)."
    fi
fi

if [ "$CHECK" -eq 1 ]; then
    [ "$drift" -eq 0 ] && echo "OK: all vendored hub-mirror client copies are byte-identical to canonical." || exit 1
else
    echo "Synced canonical hub-mirror client into: $SERVICES"
fi
