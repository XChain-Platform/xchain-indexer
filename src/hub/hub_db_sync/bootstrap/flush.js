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
 * XChain Indexer - Hub DB Sync Client: table bootstrap, the flush
 *
 * Applying the rows a drain page held back: the batch-or-per-row decision, the
 * price mirror bound decided per row, the served-row bookkeeping the
 * reconciliation passes read, and the stop-at-the-first-unappliable-row rule.
 *
 * Part of the hub-mirror client (src/hub/hub_db_sync.js), which installs the
 * methods here onto HubDbSync.prototype. Vendored byte-identical into
 * xchain-explorer by bin/sync-hub-mirror-client.sh: edit the xchain-indexer copy.
 *
 ********************************************************************/

const { getLogger } = require('../../../observability/index.js');
const { PRICE_FINALIZED_KEY_CAP, priceRoundKey, CAPABILITY_SNAPSHOT_KEY_CAP,
        capabilitySnapshotKey } = require('../mirror_bounds.js');

module.exports = {

    // Rows held back for the batch, in wire order. The flush applies them as ONE
    // statement where it can and one at a time where it cannot, then runs the SAME
    // per-row bookkeeping and cursor advance either way - so the drain's accounting,
    // and its stop-at-the-first-unappliable-row rule, are what they were before
    // batching existed, whichever path ran.
    async flushPendingRows(drain) {
        if (drain.pending.length === 0) return true;
        let batch   = drain.pending.map(p => p.row);
        // A batch cannot express a per-row hold, so a drain under the mirror
        // horizon takes the per-row path. Batching is an optimization only, and
        // this is the same fallback a statement the driver rejects already takes.
        let batched = (batch.length > 1 && !(drain.priceHorizon > 0)) ? await this.applyRowsBatched(drain.table, batch) : false;
        let ok      = true;
        for (let entry of drain.pending) {
            if (!(await this.applyPendingRow(drain, entry.row, batched))) { ok = false; break; }
        }
        drain.pending = [];
        this.reportDrainProgress(drain);
        return ok;
    },

    // Apply one held row (or take the batch's word that it landed), keep the drain's
    // accounting, and advance the cursor past it. False stops the page at this row.
    async applyPendingRow(drain, row, batched) {
        let boundOut = this.decidePriceBound(drain, row);
        let refused  = false;
        try {
            if (boundOut) drain.priceSkipped++;
            // A row the chain-identity fence refuses reports false, and is counted
            // out of `applied` below: "bootstrapped N rows" must not include rows
            // this mirror deliberately did not take.
            else if (!batched) refused = ((await this.applyRow(drain.table, row)) === false);
            this.recordServedRow(drain, row);
            if (!boundOut && !refused) drain.applied++;
        } catch (err) {
            drain.applyErrors++;
            getLogger().warn('HubDbSync: failed to apply row in ' + drain.table + ':', err);
            // Stop the page at the FIRST unappliable row. Advancing the cursor past it
            // (here, or by applying a later row in this page and raising the local
            // MAX(id)) would make the next retry's since_id = SELECT MAX(id) skip it
            // forever, and once the retry drains cleanly the heartbeat gate opens over a
            // PERMANENT mirror hole (BOOTSTRAP-HOLE-1). Leaving it (and everything after
            // it) unapplied keeps local MAX(id) below the hole, so the retry re-fetches
            // from it and fails closed until it applies. A persistent bad row wedges this
            // table's barrier (defer) rather than silently forking - the module's
            // fail-closed contract, same as the schema-mismatch path.
            //
            // A batch cannot hide such a row: applyRowsBatched only reports success on a
            // statement the driver accepted, and any other outcome sends every row in the
            // chunk back through this loop one at a time, where the bad one still stops it.
            return false;
        }
        // Advance the cursor only for a row that actually applied - or that the
        // mirror bound deliberately declined, which is equally "handled" and can
        // leave no hole: price_snapshots is a FULL_REPAGE table, so its cursor
        // restarts at 0 on every drain and never carries this position forward.
        let rowId = Number(row.id);
        if (Number.isFinite(rowId) && rowId > drain.lastId) drain.lastId = rowId;
        if (this._bootstrapping) this._bootstrapLastProgressAt = Date.now();
        return true;
    },

    // Decide the bound BEFORE the apply, and record the round on both
    // sides of it. A row with no usable block_timestamp (0/absent) is never
    // bounded out - the bound only ever narrows on evidence. Returns whether the
    // row is bound out; false on every drain that carries no bound.
    decidePriceBound(drain, row) {
        if (!(drain.priceHorizon > 0)) return false;
        let boundOut = false;
        let rowTs = Number(row.block_timestamp);
        if (Number.isFinite(rowTs) && rowTs > 0 && rowTs < drain.priceHorizon) {
            let finalizedRound = (String(row.status) === 'finalized');
            if (finalizedRound) drain.preHorizonServed.add(String(row.round_number));
            if (rowTs < drain.priceFloor) boundOut = true;
            else if (finalizedRound) drain.preHorizonRetained.add(String(row.round_number));
        }
        // Per-pair latest-price coverage, decided on the same pass. A finalized
        // row this drain APPLIES covers its pair whichever side of the horizon it
        // sits on; a finalized row the bound DECLINES becomes that pair's held
        // predecessor candidate, newest round winning, for the pass after the
        // drain to apply when the pair ends up covered by nothing else.
        if (String(row.status) === 'finalized') {
            let pair = String(row.coin_pair);
            if (!boundOut) drain.pricePairCovered.add(pair);
            else {
                let rn   = Number(row.round_number);
                let held = drain.pricePairHeld.get(pair);
                if (Number.isFinite(rn) && (!held || rn > Number(held.round_number)))
                    drain.pricePairHeld.set(pair, row);
            }
        }
        return boundOut;
    },

    // What the hub SERVED, for the reconciliation passes: the natural keys and the
    // ceilings of the three tables whose pages are the only proof of what the hub holds.
    recordServedRow(drain, row) {
        if (drain.servedMatchIds) {
            drain.servedMatchIds.add(String(row.match_id));
            let sid = Number(row.id);
            if (Number.isFinite(sid) && sid > drain.maxServedId) drain.maxServedId = sid;
        }
        if (drain.servedPriceKeys) {
            let rn = Number(row.round_number);
            if (Number.isFinite(rn) && rn > drain.maxServedRound) drain.maxServedRound = rn;
            // Only FINALIZED rows are recorded: every consensus read of this
            // table filters status='finalized' (getLatestPrice, getPrice's
            // MAX(round_number) join, refreshPriceSyncHeight), so that is
            // exactly the set whose contamination is load-bearing, and a hub
            // that serves a round as skipped is stating it holds no finalized
            // row there.
            if (String(row.status) === 'finalized') {
                if (drain.servedPriceKeys.size >= PRICE_FINALIZED_KEY_CAP) drain.priceKeysComplete = false;
                else drain.servedPriceKeys.add(priceRoundKey(row.round_number, row.coin_pair));
            }
        }
        if (drain.servedSnapshotKeys) {
            // Every row the hub SERVED, including one the chain-identity fence
            // refused to apply: the question this set answers is what the hub
            // holds, not what this mirror took from it. A refused relic is
            // reported separately (reportRefusedChainRows) and must not have its
            // local twin deleted on the strength of a fence decision made here.
            let sb = Number(row.snapshot_block);
            if (Number.isFinite(sb) && sb > drain.maxServedSnapshotBlock) drain.maxServedSnapshotBlock = sb;
            if (drain.servedSnapshotKeys.size >= CAPABILITY_SNAPSHOT_KEY_CAP) drain.snapshotKeysComplete = false;
            else drain.servedSnapshotKeys.add(capabilitySnapshotKey(row));
        }
    },
};
