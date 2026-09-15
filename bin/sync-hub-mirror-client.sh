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
# Vendored set: the client entry (hub_db_sync.js) and its parts directory
# (hub_db_sync/, every .js under it, subdirectories included: the entry installs
# them onto its prototype and resolves nothing outside the set), the
# schema-version lockstep constant (hub_schema_version.js), the dependency-free
# modules the client requires by relative path (price_batching_floor_activation.js;
# a consumer without them fails at require on boot), and the mirror-table SQL
# twins the client's ensureTables() creates for consumers without their own
# schema machinery (the explorer's copies land under src/sql/hub-mirror/ so they
# are obviously not the explorer's own tables).
#
# The parts directory is synced as a SET, not file by file: --check compares
# every part on both sides AND refuses a part present on only one side, so a
# part added here and forgotten in the consumer, or one deleted here and left
# behind there, fails the check rather than boarding the consumer as a stray.
#
# The vendored copies MIRROR THE CANONICAL DIRECTORY DEPTH, which is why there
# are two client sets below. hub_db_sync.js lives at src/hub/ and reaches its
# dependency-free modules with ../, so a consumer that flattened it into src/
# would resolve those requires one directory above its own src/ and fail at
# boot. HUB_FILES therefore land in <service>/src/hub/ and DEP_FILES, which the
# client reaches with ../, land in <service>/src/.
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

HUB_FILES="hub_db_sync.js hub_schema_version.js"
HUB_DIRS="hub_db_sync"
DEP_FILES="price_batching_floor_activation.js mirror_admission_activation.js"
SQL_FILES="price_snapshots.sql oracle_prices.sql cross_chain_matches.sql cross_chain_calls.sql capability_snapshots.sql state_checkpoints.sql anchor_reward_attestations.sql attestation_responses.sql bridge_transfers.sql policy_snapshots.sql"
SERVICES="xchain-explorer"

CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

drift=0
for svc in $SERVICES; do
    dest="$ROOT/$svc/src"
    hubdest="$dest/hub"
    sqldest="$dest/sql/hub-mirror"
    for f in $HUB_FILES; do
        if [ "$CHECK" -eq 1 ]; then
            if ! cmp -s "$SRC/hub/$f" "$hubdest/$f"; then
                echo "DRIFT: $svc/src/hub/$f differs from canonical xchain-indexer/src/hub/$f"
                drift=1
            fi
        else
            mkdir -p "$hubdest"
            cp "$SRC/hub/$f" "$hubdest/$f"
        fi
    done
    for d in $HUB_DIRS; do
        # The relative paths of every part on each side, sorted, so the two sets can be
        # compared as text and a one-sided part is named rather than passed over.
        canon_parts="$(cd "$SRC/hub/$d" && find . -type f -name '*.js' | sort)"
        if [ "$CHECK" -eq 1 ]; then
            if [ ! -d "$hubdest/$d" ]; then
                echo "DRIFT: $svc/src/hub/$d/ is missing (canonical xchain-indexer/src/hub/$d/ has $(echo "$canon_parts" | wc -l | tr -d ' ') parts)"
                drift=1
                continue
            fi
            local_parts="$(cd "$hubdest/$d" && find . -type f -name '*.js' | sort)"
            if [ "$canon_parts" != "$local_parts" ]; then
                echo "DRIFT: $svc/src/hub/$d/ holds a different part set from canonical xchain-indexer/src/hub/$d/:"
                diff <(echo "$canon_parts") <(echo "$local_parts") | sed 's/^/    /'
                drift=1
            fi
            for p in $canon_parts; do
                if [ -f "$hubdest/$d/$p" ] && ! cmp -s "$SRC/hub/$d/$p" "$hubdest/$d/$p"; then
                    echo "DRIFT: $svc/src/hub/$d/${p#./} differs from canonical xchain-indexer/src/hub/$d/${p#./}"
                    drift=1
                fi
            done
        else
            # Replace the whole directory so a part retired here does not linger there.
            rm -rf "$hubdest/$d"
            mkdir -p "$hubdest/$d"
            (cd "$SRC/hub/$d" && find . -type f -name '*.js' -print0 | while IFS= read -r -d '' p; do
                mkdir -p "$hubdest/$d/$(dirname "$p")"
                cp "$SRC/hub/$d/$p" "$hubdest/$d/$p"
            done)
        fi
    done
    for f in $DEP_FILES; do
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
# hub_schema_version.js is not vendored FROM the hub (the indexer's copy above
# is the canonical file synced OUT to consumers); the hub keeps its own,
# independent source file at xchain-hub/src/hub_schema_version.js, and both
# MUST declare the same HUB_SCHEMA_VERSION value or a hub upgrade can silently
# fork the ledger (see that file's own header comment). A byte-cmp would be
# too strict here (the two files carry different repo headers by design), so
# this extracts just the numeric constant from each side and compares values.
if [ "$CHECK" -eq 1 ]; then
    HUB_VERSION_FILE="$ROOT/xchain-hub/src/hub_schema_version.js"
    if [ -f "$HUB_VERSION_FILE" ]; then
        indexer_ver="$(grep -oE 'HUB_SCHEMA_VERSION = [0-9]+' "$SRC/hub/hub_schema_version.js" | grep -oE '[0-9]+$')"
        hub_ver="$(grep -oE 'HUB_SCHEMA_VERSION = [0-9]+' "$HUB_VERSION_FILE" | grep -oE '[0-9]+$')"
        if [ -z "$indexer_ver" ] || [ -z "$hub_ver" ]; then
            echo "DRIFT: could not extract HUB_SCHEMA_VERSION from indexer and/or hub source; check both files by hand."
            drift=1
        elif [ "$indexer_ver" != "$hub_ver" ]; then
            echo "DRIFT: xchain-indexer HUB_SCHEMA_VERSION ($indexer_ver) != xchain-hub HUB_SCHEMA_VERSION ($hub_ver)"
            drift=1
        fi
    else
        echo "NOTE: xchain-hub/src/hub_schema_version.js not found at $HUB_VERSION_FILE; skipping indexer<->hub lockstep check (hub repo not checked out alongside indexer)."
    fi
fi

if [ "$CHECK" -eq 1 ]; then
    [ "$drift" -eq 0 ] && echo "OK: all vendored hub-mirror client copies are byte-identical to canonical." || exit 1
else
    echo "Synced canonical hub-mirror client into: $SERVICES"
fi
