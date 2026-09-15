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
 * XChain Indexer - Hub DB Sync Client: table bootstrap, the verdict
 *
 * What runs after a table's last page: the rebuilt-source content probe, the
 * ready-ceiling catch-up, the price mirror bound's held predecessors and its
 * acceptance check, the floor the barriers police, the reconciliation passes,
 * and the arming of the table's barrier once it has provably drained in full.
 * The price bound's own horizon and floor policing live here too.
 *
 * Part of the hub-mirror client (src/hub/hub_db_sync.js), which installs the
 * methods here onto HubDbSync.prototype. Vendored byte-identical into
 * xchain-explorer by bin/sync-hub-mirror-client.sh: edit the xchain-indexer copy.
 *
 ********************************************************************/

const { getLogger } = require('../../../observability/index.js');
const { HUB_SCHEMA_VERSION } = require('../../hub_schema_version');
const { CROSS_CHAIN_TABLES, FULL_REPAGE_TABLES } = require('../mirror_tables.js');
const { PRICE_MIRROR_MIN_PRE_HORIZON_ROUNDS, PRICE_MIRROR_LOOKBACK_GROWTH,
        PRICE_MIRROR_LOOKBACK_MAX_S } = require('../mirror_bounds.js');

module.exports = {

    // THE HALF A COMPARISON OF IDS ALONE CANNOT SEE.
    //
    // The ceiling fence above catches a replaced id space only while the local cursor
    // sits ABOVE what the hub advertises. Once a rebuilt source has re-grown onto the
    // retired ids, both sides agree on every id and disagree only on what those ids
    // MEAN, and no comparison of ids can reach that. Nothing purges, the id-parity
    // INSERT IGNORE apply drops each incoming row against the stale one holding its id,
    // and the mirror serves the retired rows forever while every service reports healthy
    // (state_checkpoints readers take MAX(checkpoint_seq), which a retired row wins).
    //
    // Content is the signal that does reach it, on the tables named in
    // REBUILT_SOURCE_IDENTITY_COLUMNS: they are append-only and id-parity, so a hub row
    // at id N whose natural key differs from local id N is a CONTRADICTION, not an
    // absence. That distinction is the whole warrant for the delete, and it is the one
    // purgeForeignNetworkRows draws: a filtered endpoint, a paging hole or a partial
    // drain can each make a valid row look UNSERVED, and none of them can fabricate a
    // conflicting row at an id the source itself served.
    //
    // WHY HERE, AFTER A DRAIN THAT FETCHED NOTHING, rather than before the drain. A
    // zero-row drain is the mirror claiming to be level with its source, which is both
    // the cheapest moment to ask the question (one small page-1 request per bootstrap
    // of two small tables, and none at all while a mirror is still catching up) and the
    // exact symptom this defect presents: a stranded mirror draining zero rows on every
    // attempt with no other signal. A mirror still behind its source defers the check to
    // the bootstrap that finds it level, which is the next reconnect at the latest.
    //
    // Returns true when a purge actually removed rows, which is the one outcome that
    // changes what a re-page would find and so the one that sends the caller around again.
    async probeRebuiltSource(drain) {
        let table = drain.table;
        if (!(drain.fetched === 0 && drain.applyErrors === 0 && drain.lastId > 0 && !drain.afterRebuiltPurge)) return false;
        let clash = await this.detectRebuiltSourceByContent(table, drain.scope, drain.lastId);
        if (!clash) return false;
        getLogger().warn('HubDbSync: ' + table + ' id ' + clash.id + ' holds ' + clash.column + '=' +
            clash.local + ' locally while the hub serves ' + clash.hub + ' at that id. This table is ' +
            'append-only and id-parity, so one id cannot mean two rows: the source id space has been ' +
            'replaced and re-grown onto the retired ids (a rebuilt hub database). Clearing the mirror ' +
            'for this scope and re-paging from 0.');
        let removed = await this.purgeRebuiltSourceRows(table, drain.scope, drain.lastId, drain.readyCeiling,
            'id ' + clash.id + ' carries ' + clash.column + '=' + clash.local + ' locally while the hub ' +
            'serves ' + clash.hub + ' at that id');
        // Only a purge that actually removed rows changes what a re-page would find;
        // without one the retry would drain the same zero rows and probe again.
        return removed > 0;
    },

    // Defense-in-depth: if the hub told us its max_id at subscription time and our
    // local copy is still behind that ceiling, the REST snapshot window may have
    // missed rows that arrived right before the snapshot was served. Issue a targeted
    // catch-up for that narrow gap. Rows already local are ignored (INSERT IGNORE).
    // Skip the catch-up when the page loop already hit a hole (applyErrors>0): the table is
    // not drained regardless, and fetching past the hole would only widen it.
    // The FULL_REPAGE_TABLES are exempt: they always re-page from 0 (which already
    // covers the window this catch-up exists for), and their since_id=MAX(id) compare
    // is either meaningless (capability_snapshots' locally-assigned ids) or blind to the
    // in-place upgrades this catch-up would otherwise try to chase (#2491).
    async catchUpToReadyCeiling(drain) {
        let table = drain.table;
        let hubReadyMaxId = this._readyMaxIds && this._readyMaxIds[table];
        if (!(hubReadyMaxId && drain.applyErrors === 0 && !FULL_REPAGE_TABLES.includes(table))) return;
        // Same network scope as the cursor read: an unscoped MAX(id) here compares a
        // foreign hub's id against this hub's ceiling and reaches the opposite verdict
        // about whether a gap exists.
        let localMax = await this.localMaxId(table, drain.scope);
        if (!(localMax < hubReadyMaxId)) return;
        getLogger().info('HubDbSync: gap detected in ' + table + ' (local=' + localMax +
                    ' hub_ready=' + hubReadyMaxId + '), fetching catch-up rows');
        try {
            let catchUpPath = '/hub-db/snapshot/' + table + '?since_id=' + localMax + '&limit=10000';
            let catchUp = await this.httpGet(catchUpPath);
            if (catchUp && Array.isArray(catchUp.rows)) await this.applyCatchUpPage(drain, catchUp);
        } catch (err) {
            getLogger().warn('HubDbSync: catch-up fetch failed for ' + table + ':', err);
        }
    },

    // Apply one catch-up page under the page loop's own rules.
    async applyCatchUpPage(drain, catchUp) {
        let table = drain.table;
        // Same schema fail-closed as the page loop: a mismatched catch-up page
        // could drop a consensus-relevant column, so refuse it and mark the
        // table not-drained (CATCHUP-SCHEMA-BYPASS-1).
        if (catchUp.schema_version != null && catchUp.schema_version !== HUB_SCHEMA_VERSION) {
            getLogger().error('HubDbSync: catch-up schema_version ' + catchUp.schema_version +
                ' != local ' + HUB_SCHEMA_VERSION + ' for ' + table + '; skipping catch-up');
            drain.applyErrors++;
            return;
        }
        for (let row of catchUp.rows) {
            // Count a swallowed catch-up apply error: leaving it silent left a
            // hole while the gate still opened (CATCHUP-SCHEMA-BYPASS-1).
            try { await this.applyRow(table, row); }
            catch (e) {
                drain.applyErrors++;
                getLogger().warn('HubDbSync: catch-up apply failed for ' + table + ':', e);
            }
        }
    },

    // Apply the per-pair predecessors the bound declined, for the pairs this drain kept
    // no finalized row for at all (see pricePairHeld above). CONDITIONAL on purpose: a
    // pair with a retained finalized row already answers getPrice exactly as a full
    // mirror does, and applying more than the gap needs would give the bound away. Only
    // on a complete re-page, because only then has every row the hub holds been weighed,
    // and a failure here fails the drain closed the same way a page apply does. Applying
    // out of page order leaves no cursor hole: price_snapshots is a FULL_REPAGE table,
    // so the cursor restarts at 0 on the next drain and carries nothing forward.
    // priceSkipped is deliberately NOT decremented - it is the count of rows the bound
    // declined at decision time, and it drives the floor the barriers police, which must
    // keep claiming the mirror may lack rounds below priceFloor.
    // Returns the drain's fullyDrained verdict, cleared by a failed apply.
    async applyHeldPricePredecessors(drain, fullyDrained) {
        if (!(fullyDrained && drain.priceHorizon > 0 && drain.pricePairHeld && drain.pricePairHeld.size > 0)) return fullyDrained;
        for (let [pair, row] of drain.pricePairHeld) {
            if (drain.pricePairCovered.has(pair)) continue;
            try {
                await this.applyRow(drain.table, row);
                drain.applied++;
            } catch (err) {
                drain.applyErrors++;
                getLogger().warn('HubDbSync: failed to apply the held predecessor row for ' +
                    pair + ' in ' + drain.table + ':', err);
                return false;
            }
        }
        return fullyDrained;
    },

    // Mirror-bound acceptance check. The lookback is a SPAN IN SECONDS but the constraint it
    // has to satisfy is a COUNT OF ROUNDS (getOracleDataForVM's window), and only the
    // hub's own data says how many rounds a span holds - a deployment on a longer round
    // interval fits far fewer. So the drain measures what it actually kept and refuses to
    // certify a table it cut too thin: widen the span and report not-drained, which leaves
    // the barrier shut and sends bootstrapAll around again (a re-page is idempotent -
    // every apply is an INSERT IGNORE/ODKU on the natural key). Past the ceiling the bound
    // gives up entirely and the next drain mirrors the table in full, because a bounded
    // mirror that cannot prove its own depth is worth less than a slow one.
    // Returns false when the drain was refused.
    acceptPriceMirrorBound(drain, fullyDrained) {
        if (!(fullyDrained && drain.priceHorizon > 0 &&
              drain.preHorizonRetained.size < drain.preHorizonServed.size &&
              drain.preHorizonRetained.size < PRICE_MIRROR_MIN_PRE_HORIZON_ROUNDS)) return true;
        let widened = this._priceMirrorLookbackS * PRICE_MIRROR_LOOKBACK_GROWTH;
        if (widened > PRICE_MIRROR_LOOKBACK_MAX_S) {
            this._priceMirrorBoundDisabled = true;        // full mirror from here on
            getLogger().warn('HubDbSync: price mirror bound gave up after reaching its ' +
                PRICE_MIRROR_LOOKBACK_MAX_S + 's ceiling with only ' + drain.preHorizonRetained.size +
                ' pre-horizon round(s); the next drain mirrors price_snapshots in full');
        } else {
            this._priceMirrorLookbackS = widened;
            getLogger().warn('HubDbSync: price mirror bound kept only ' + drain.preHorizonRetained.size +
                ' of the ' + drain.preHorizonServed.size + ' round(s) the hub holds below the horizon, ' +
                'short of the ' + PRICE_MIRROR_MIN_PRE_HORIZON_ROUNDS + ' a consensus read can ' +
                'reach; widening the lookback to ' + widened + 's and re-draining');
        }
        this._priceMirrorFloorTs = 0;
        return false;
    },

    // The floor the barriers police (see notePriceMirrorFloor). Set only on a drain that
    // both bounded something and passed the check above; a full drain clears it.
    notePriceFloorAfterDrain(drain, fullyDrained) {
        if (drain.table === 'price_snapshots' && fullyDrained) {
            this._priceMirrorFloorTs = (drain.priceSkipped > 0) ? drain.priceFloor : 0;
            // A drain that bounded nothing IS the full mirror the re-floor was waiting for.
            if (drain.priceSkipped === 0) this._priceMirrorRefloor = false;
        }
    },

    // The reconciliation passes a complete re-page warrants.
    async reconcileAfterDrain(drain, fullyDrained) {
        // Reconcile the retractions the bootstrap can never re-deliver (#3211). Only after a
        // COMPLETE re-page: a partial drain has not seen every row the hub holds, so a
        // "missing" match may simply be on a page we never fetched.
        if (fullyDrained && drain.servedMatchIds) await this.reconcileRetractedMatches(drain.servedMatchIds, drain.maxServedId);

        // Clear the capability snapshots this hub does not hold (#1837). Same COMPLETE-re-page
        // precondition as the two passes above, and ordered BEFORE the barrier re-evaluation
        // in the block below so releaseSnapshotWaiters judges the cleaned table.
        if (fullyDrained && drain.servedSnapshotKeys)
            await this.reconcileForeignCapabilitySnapshots(drain.servedSnapshotKeys, drain.snapshotKeysComplete,
                                                            drain.maxServedSnapshotBlock, drain.snapshotPreDrainMaxId);
    },

    // Only arm this table's barrier state once it FULLY drained. The per-table refresh
    // sets <x>Bootstrapped = true and caches its scalar; on a PARTIAL drain (rows fetched
    // but thrown on apply, so the local table is empty or holed) that would arm the
    // barrier's empty-mirror NULL fast path and the `ts >= blockTime` content path -
    // NEITHER of which is gated on the global stream watermark - and the oracle/match/call
    // barriers would open against an incomplete mirror and fork (BOOTSTRAP-FLAG-PARTIAL-DRAIN;
    // unlike the price-height barrier, which has no empty fast path and safely DEFERS). A
    // partial drain returns null below, so bootstrapAll retries with the gate shut. The
    // reconnect self-heal (refreshAllSyncHeights) still refreshes from a complete local
    // mirror on its own path; this only withholds arming on an incomplete bootstrap.
    // Returns false when the price replay reported the table not-drained after all.
    async armBarriersAfterDrain(drain) {
        let table = drain.table;
        // Pass armBootstrap=true: this is the only path allowed to arm the
        // per-barrier <x>Bootstrapped flags, because only here has the table
        // fully drained. The refreshers otherwise default arming to
        // _bootstrapDrained so reconnect / live-row refreshes cannot arm from
        // a holed mirror (see #1788).
        if (table === 'price_snapshots') {
            // Clear the rounds this hub does not hold BEFORE the buffered replay and
            // before the height refresh. Ordering is load-bearing in both directions:
            // every live round that arrived during the drain is still BUFFERED (not
            // applied), so the pass cannot mistake one for a foreign row; and the
            // refresh below must read the cleaned table, or the barrier arms off a
            // height the mirror is about to lose.
            await this.reconcileForeignPriceRounds(drain.servedPriceKeys, drain.priceKeysComplete, drain.maxServedRound);
            if (!(await this.replayDrainedPriceEvents())) return false;
            await this.refreshPriceSyncHeight();
        }
        if (table === 'oracle_prices')       await this.refreshOracleSyncTimestamp(true);
        if (table === 'cross_chain_matches') await this.refreshMatchSyncTimestamp(true);
        if (table === 'cross_chain_calls')   await this.refreshCallSyncTimestamp(true);
        if (table === 'bridge_transfers')    await this.refreshBridgeSyncTimestamp(true);
        if (table === 'policy_snapshots')    await this.refreshPolicySyncTimestamp(true);
        // A new match/call (new required snapshot_block) or an arriving snapshot can change
        // snapshot-presence: re-evaluate the snapshot barrier on any cross-chain table.
        if (CROSS_CHAIN_TABLES.indexOf(table) !== -1) await this.releaseSnapshotWaiters();
        return true;
    },

    // Replay the live rounds buffered during this drain (#2422),
    // serialized through the message chain: every already-received
    // event is guaranteed buffered ahead of this task and no new
    // event can interleave mid-flush; the task flips _priceDrained
    // before the next event task runs, so the live apply path
    // resumes exactly at the replay boundary with no ordering gap.
    // A failed or disconnect-raced flush reports the table
    // not-drained (return null) so bootstrapAll retries from the
    // still-contiguous local max, the same fail-closed contract as
    // the page loop (BOOTSTRAP-HOLE-1).
    async replayDrainedPriceEvents() {
        let flushed = false;
        let epoch = this._wsEpoch;
        this._msgChain = this._msgChain.then(async () => {
            flushed = await this.flushPendingPriceEvents();
            if (flushed && epoch === this._wsEpoch) this._priceDrained = true;
            else flushed = false;
        });
        await this._msgChain;
        return flushed;
    },

    // The unix-second horizon for this drain's price_snapshots bound, or 0 when
    // the whole table is to be mirrored. 0 on every path that cannot PROVE a horizon: no
    // consumer hook (the explorer's display mirror), a hook that throws or returns a
    // non-positive/non-finite value, or a bound this instance has already given up on.
    // Fail-open is the only safe direction here: a wrong horizon costs a mirror that is
    // short of what a consensus read needs, and no drain is worth that.
    async resolvePriceMirrorHorizon() {
        if (!this.getPriceMirrorHorizon || this._priceMirrorBoundDisabled) return 0;
        let horizon;
        try {
            horizon = await this.getPriceMirrorHorizon();
        } catch (e) {
            getLogger().warn('HubDbSync: price mirror horizon unavailable (' + e.message +
                '); mirroring price_snapshots in full');
            return 0;
        }
        horizon = Number(horizon);
        if (!Number.isFinite(horizon) || horizon <= 0) return 0;
        // A horizon at or below the lookback would put the floor at/below zero, which is
        // every row there has ever been: no bound, and say so rather than pretending to one.
        if (horizon <= this._priceMirrorLookbackS) return 0;
        return horizon;
    },

    // Police the floor of a bounded price mirror. The bound is derived from the
    // OLDEST block this node expected to process; if it is ever asked to gate a block older
    // than that, the premise is gone - the mirror is missing rounds that block's price reads
    // can select, and a read against it would answer differently from a peer holding the
    // history. So abandon the bound, shut BOTH price barriers (and only those - the
    // oracle/match/call mirrors are complete and must keep serving), and re-mirror the table
    // in full. Fail-closed: blocks defer while the re-drain runs rather than settling against
    // a mirror that is knowingly short. Idempotent - the first call clears the floor, so the
    // re-drain is scheduled once however many waiters trip it.
    notePriceMirrorFloor(blockTime) {
        if (!(this._priceMirrorFloorTs > 0)) return;
        blockTime = Number(blockTime);
        if (!Number.isFinite(blockTime) || blockTime <= 0) return;
        if (blockTime >= this._priceMirrorFloorTs) return;
        getLogger().error('HubDbSync: block time ' + blockTime + ' is below the bounded price mirror floor ' +
            this._priceMirrorFloorTs + ' - this node is processing blocks older than the history its ' +
            'price mirror holds. Abandoning the bound and re-mirroring price_snapshots in full ' +
            '(blocks defer until it drains).');
        this._priceMirrorBoundDisabled = true;
        this._priceMirrorFloorTs       = 0;
        this._priceMirrorRefloor       = true;
        if (this.running) {
            Promise.resolve()
                .then(() => this.bootstrapAll())
                .catch(err => getLogger().warn('HubDbSync: full price re-mirror failed to start:', err));
        }
    },
};
