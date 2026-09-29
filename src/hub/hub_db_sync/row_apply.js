/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Indexer - Hub DB Sync Client: row apply
 *
 * Applying one hub-served row to the local mirror: the fences every row passes,
 * the column filter against the local schema, the per-table upsert dispatch, the
 * bootstrap batch path, and the local column cache.
 *
 * Part of the hub-mirror client (src/hub/hub_db_sync.js), which installs the
 * methods here onto HubDbSync.prototype. Vendored byte-identical into
 * xchain-explorer by bin/sync-hub-mirror-client.sh: edit the xchain-indexer copy.
 *
 ********************************************************************/

const { getLogger } = require('../../observability/index.js');
const { CROSS_CHAIN_TABLES } = require('./mirror_tables.js');
const { LOCAL_COLUMN_CACHE_TTL_MS } = require('./mirror_bounds.js');
const { coerceMirrorValue, priceUpsertSql, applyMirrorWrite } = require('./mirror_write.js');
const { mirrorUpsertSql } = require('./row_upserts.js');

module.exports = {

    // Apply a run of price_snapshots rows in ONE multi-row upsert.
    //
    // Returns true only when every row in `rows` landed in that single statement;
    // false means "not applied, use the per-row path", and the caller then applies
    // the same rows through applyRow in order. Never throws for that reason: the
    // decision to batch must never be able to fail a drain that the per-row path
    // would have completed.
    //
    // Applicability is deliberately narrow. price_snapshots only (the one mirrored
    // table large enough for the round-trips to dominate), only when every row
    // presents the identical mirrored column list (so one placeholder tuple is
    // correct for all of them), and only when `status` is among those columns,
    // which is the same condition applyRow's price branch requires before it uses
    // the ODKU upgrade path. Anything else declines.
    //
    // Rows sharing a natural key inside one statement are safe: MariaDB evaluates
    // the ODKU per row against what the statement has already written, and the
    // skipped -> finalized upgrade is keyed on VALUES(status), so a chunk holding
    // both states for one round converges to the same row either order.
    async applyRowsBatched(table, rows) {
        // The chain-identity fence lives in applyRow, the single funnel every applied row
        // passes through. A batch has no per-row verdict, so a CROSS_CHAIN_TABLES row must
        // never travel this path: declining here keeps the three tables on the per-row path
        // where the fence runs, and keeps that true if the batch is ever widened beyond
        // price_snapshots.
        if (CROSS_CHAIN_TABLES.indexOf(table) !== -1) return false;
        if (table !== 'price_snapshots') return false;
        if (this._batchApplyDisabled) return false;
        if (!Array.isArray(rows) || rows.length < 2) return false;

        let allowed;
        try {
            allowed = await this.localColumns(table);
        } catch (e) {
            return false;                                    // not ready: the per-row path reports it
        }

        let cols = Object.keys(rows[0]).filter(c => allowed.has(c));
        if (cols.length === 0 || !cols.includes('status')) return false;
        let signature = cols.join('');

        let args = [];
        for (let row of rows) {
            let rowCols = Object.keys(row).filter(c => allowed.has(c));
            if (rowCols.join('') !== signature) return false;
            for (let c of cols) args.push(coerceMirrorValue(row[c], this.cachedColumnType(table, c)));
        }

        let result;
        try {
            result = await this.hubDb.doQuery(priceUpsertSql(cols, rows.length), args);
        } catch (e) {
            result = null;                                   // treated as "did not land", below
        }
        // doQuery SWALLOWS a query error for a non-transactional statement and returns its
        // `[]` default; a statement that ran comes back as the driver's OK result object.
        // An array (or a throw, or nothing) therefore means this batch did not land, and the
        // caller must re-apply these rows one at a time - where a genuine failure is visible
        // per row and stops the page at the offending row, as it always did.
        if (!result || Array.isArray(result)) {
            if (!this._batchApplyWarned) {
                this._batchApplyWarned = true;
                getLogger().warn('HubDbSync: batched ' + table + ' upsert did not land; falling back to ' +
                    'per-row applies for this drain (set HUB_SYNC_BATCH_APPLY=false to disable batching)');
            }
            return false;
        }
        return true;
    },

    // Apply a row to the local hub DB (INSERT IGNORE to keep idempotent).
    // Columns are FILTERED to the local mirror table's schema: the hub may serve
    // columns the mirror deliberately does not carry (e.g. state_checkpoints'
    // hub-side anchor_txid audit column; see src/sql/state_checkpoints.sql), and
    // the hub side can gain columns before this indexer updates. Without the
    // filter, one new hub column turns every mirrored insert for that table into
    // ER_BAD_FIELD_ERROR and silently kills the mirror (fleet incident 2026-06-11:
    // anchor_txid landed with the ANCHOR rollout and stopped all state_checkpoints
    // mirroring). Unknown columns are dropped, never errors.
    async applyRow(table, row) {
        // Chain-identity fence, first and for every path that applies a row (bootstrap
        // per-row, batch fallback, live event, buffered replay). Returns false so the
        // bootstrap's accounting can tell a refused relic from an applied row; the caller
        // moves its cursor past it either way, since a refusal is not an apply error.
        if (this.refuseForeignChainRow(table, row)) return false;
        // Stake re-derivation fence for capability_snapshots, on the SAME footing as the
        // chain-identity fence above and for the same reason: this is the one mirrored
        // table that arrives with no authentication at all, so a hub that serves a forged
        // validator set is otherwise mirrored verbatim. A BTC node can prove the claim
        // against its own stakes; every other verdict applies the row unchanged.
        if (table === 'capability_snapshots' && await this.refuseUnprovenCapabilitySnapshot(row)) return false;
        let allowed = await this.localColumns(table);
        let cols = Object.keys(row).filter(c => allowed.has(c));
        // capability_snapshots is a NATURAL-KEY mirror (uq_cap_snap: snapshot_block,
        // capability, signing_pubkey, source; no reader keys on id). `source` is the
        // fourth key column on purpose: a key delegated by two sources yields
        // one row per source, and a 3-column key collapses them on INSERT IGNORE and
        // drops the second source. Hub ids are hub-LOCAL
        // (every hub persists these rows independently via an id-less INSERT IGNORE)
        // and AnchorRecovery rebuilds the table id-less too, so a wire id can collide
        // with a locally-assigned PK and INSERT IGNORE would silently drop the row -
        // a permanent mirror hole (#2270). Drop the id and let local AUTO_INCREMENT
        // assign; bootstrapTable pages this table from since_id=0 for the same reason.
        // cross_chain_matches/calls keep hub id parity deliberately (settlement-order key).
        //
        // attestation_responses strips id for the same reason arrived at by a different route.
        // Its ids are hub-LOCAL because the artifact is written more than once: the responsible
        // set reaches quorum on one hub, the result is gossiped to the rest of the federation
        // (ATTEST_RESULT), and every hub that verifies it inserts its OWN row, so two hubs carry
        // different ids for one logical row and a hub failover would re-deliver the same response
        // under a new id. Row identity is the natural key UNIQUE (network, request_id) - which is
        // also what makes the re-delivery a harmless INSERT IGNORE no-op - and no reader keys on
        // id. Keeping a wire id would let it collide with a locally-assigned PK and have INSERT
        // IGNORE silently drop a real response, and a dropped response here is not a stale read:
        // the applier never binds it, the callback never fires on this node alone, and the node
        // forks. FULL_REPAGE_TABLES membership follows directly from this strip.
        if (table === 'capability_snapshots' || table === 'attestation_responses') cols = cols.filter(c => c !== 'id');
        if (cols.length === 0) return;
        let placeholders = cols.map(() => '?').join(', ');
        let args = cols.map(c => coerceMirrorValue(row[c], this.cachedColumnType(table, c)));
        await applyMirrorWrite(this.hubDb, mirrorUpsertSql(table, cols, placeholders), args);
        // The batch link is carried onto the local ATTEST v1 row only once the mirror row
        // holds it (see linkAppliedResponseToBatch for why the STORED value is the one used).
        if (table === 'attestation_responses' && cols.includes('batch_action_index') && row.batch_action_index != null)
            await this.linkAppliedResponseToBatch(row);
    },

    // Carry a stamped batch link onto the local ATTEST v1 row the applier minted for this
    // response. Keyed on the request id, which is the only identifier the two sides share:
    // the batch is parsed on the DOGE indexer and names its responses by request_id, while
    // the v1 row was minted locally on BTC at whatever block the mirror row bound at.
    //
    // The value written is the one now STORED in the mirror rather than the one that just
    // arrived, so the first-stamp-wins rule above decides both copies at once and a second
    // batch claiming the same response cannot move them apart.
    //
    // Best effort by design. Both columns are display links, never consensus inputs, so a
    // failure here must not fail the drain (which would defer blocks); and a response whose
    // v1 has not been applied yet matches no row, which is the case the applier closes by
    // copying the link off the mirror row when it mints the v1.
    //
    // The local indexer connection is reached through the Database back-reference rather than
    // a constructor option, so this file stays the canonical copy other services vendor: the
    // explorer runs this same client against a pool that has no indexer and no attests table,
    // and simply skips the link.
    async linkAppliedResponseToBatch(row) {
        let db = this.hubDb && this.hubDb.indexer && this.hubDb.indexer.indexerDb;
        if (!db || typeof db.setAttestationResponseBatchIndex !== 'function') return;
        try {
            // The request may hold two honest rows (a round finalized under two leader
            // slots differs only in the signed effective_time), so read the one this
            // delivery just stamped rather than whichever the planner returns first.
            let stored = await this.hubDb.doQuery(
                'SELECT batch_action_index FROM attestation_responses WHERE network = ? AND request_id = ? AND effective_time = ? LIMIT 1',
                [String(row.network == null ? '' : row.network), String(row.request_id == null ? '' : row.request_id),
                 Number(row.effective_time)]);
            let linked = (stored && stored[0]) ? stored[0].batch_action_index : null;
            if (linked == null) return;
            await db.setAttestationResponseBatchIndex(row.request_id, linked);
        } catch (e) {
            getLogger().warn('HubDbSync: could not link attestation response ' +
                String(row.request_id) + ' to its on-chain batch:', e);
        }
    },

    // Local mirror table columns, cached per table with a short TTL. Table names
    // come only from the fixed internal mirror lists (the price_snapshots/
    // oracle_prices pair, CROSS_CHAIN_TABLES, HUB_STATE_TABLES), never from hub
    // input. The TTL (vs the former process-lifetime cache) bounds how long a
    // hub-side column rename/addition can keep silently NULLing the mirror: a
    // lifetime cache never re-learned the new column, so a row carrying it was
    // dropped by the applyRow filter until a manual restart. After the TTL the
    // next apply re-reads SHOW COLUMNS and self-heals. A SHOW COLUMNS every few
    // minutes per table is negligible. We do NOT invalidate eagerly on a dropped
    // column because the hub legitimately serves columns the mirror omits by
    // design (see applyRow), which would otherwise trigger a re-fetch storm.
    async localColumns(table) {
        if (!this._localColumnCache) this._localColumnCache = {};
        let entry = this._localColumnCache[table];
        if (!entry || (Date.now() - entry.fetchedAt) > LOCAL_COLUMN_CACHE_TTL_MS) {
            let rows = await this.hubDb.doQuery('SHOW COLUMNS FROM ' + table);
            // doQuery swallows a missing-table error (1146) for non-transactional
            // reads and returns [] instead of throwing. Caching an empty set here
            // would poison the mirror: every applyRow would filter to zero columns
            // and silently no-op, so a table that is merely not-created-yet (startup
            // race with the indexer's verifyTables() on a fresh reset) would never
            // mirror a row until a restart (prod rollout attempt 2026-06-17). A real
            // mirror table always has columns, so an empty result means "not ready":
            // do NOT cache it, and throw so the caller treats this bootstrap as
            // not-drained and retries.
            if (!rows || rows.length === 0)
                throw new Error('local mirror table ' + table + ' not available yet (no columns)');
            // `types` rides along on the SAME SHOW COLUMNS result the column
            // filter is built from, so type-aware value coercion costs no extra
            // query. The return value stays entry.cols: both callers and every
            // test stub of this method treat it as a plain Set of field names.
            entry = this._localColumnCache[table] = {
                cols:      new Set(rows.map(r => r.Field)),
                types:     new Map(rows.map(r => [r.Field, String(r.Type == null ? '' : r.Type).toLowerCase()])),
                fetchedAt: Date.now()
            };
        }
        return entry.cols;
    },

    // Local column TYPE for a table already primed in the column cache. It keys
    // mirror value coercion on the schema instead of on the value's shape.
    // Returns '' (read as "unknown") when the table or column is absent from the
    // cache or the driver served no Type, which keeps the coercion's legacy
    // shape-based fallback in play. Never issues a query: applyRow awaits
    // localColumns for the same table first, so the entry is primed by then,
    // and a test that stubs localColumns simply lands on the fallback.
    cachedColumnType(table, col) {
        let entry = this._localColumnCache && this._localColumnCache[table];
        if (!entry || !entry.types) return '';
        return entry.types.get(col) || '';
    },

};
