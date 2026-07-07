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
# constant (hub-schema-version.js), and the six mirror-table SQL twins the
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
SQL_FILES="price_snapshots.sql oracle_prices.sql cross_chain_matches.sql cross_chain_calls.sql capability_snapshots.sql state_checkpoints.sql"
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

if [ "$CHECK" -eq 1 ]; then
    [ "$drift" -eq 0 ] && echo "OK: all vendored hub-mirror client copies are byte-identical to canonical." || exit 1
else
    echo "Synced canonical hub-mirror client into: $SERVICES"
fi
