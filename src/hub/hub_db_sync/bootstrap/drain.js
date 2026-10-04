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
 * XChain Indexer - Hub DB Sync Client: table bootstrap, the drain
 *
 * One table's REST bootstrap: opening the drain (column cache, network scope,
 * the id cursor and the hub-ceiling fence), the page loop, and the drain state
 * every later step reads. The per-row flush lives in flush.js and the passes
 * that run after the last page in verdict.js; bootstrapTable here is the one
 * caller that strings them together.
 *
 * Part of the hub-mirror client (src/hub/hub_db_sync.js), which installs the
 * methods here onto HubDbSync.prototype. Vendored byte-identical into
 * xchain-explorer by bin/sync-hub-mirror-client.sh: edit the xchain-indexer copy.
 *
 ********************************************************************/

const { getLogger } = require('../../../observability/index.js');
const { HUB_SCHEMA_VERSION } = require('../../hub_schema_version');
const { CROSS_CHAIN_TABLES } = require('../mirror_tables.js');
const { sanitizeHeights } = require('../watermark_config.js');

const PAGE_LIMIT = 10000;
const MAX_PAGES  = 1000;                             // runaway backstop (10M rows)

module.exports = {

    // Bootstrap: fetch a full snapshot of the table from the hub and apply it.
    // If the hub supplied max_ids in the ready message, runs a supplemental
    // catch-up fetch for any IDs between the snapshot ceiling and hub_ready_max_id
    // that may have arrived while the REST round-trip was in flight.
    // Returns the snapshot response's stream watermark when this table fully
    // drained (page not full, every row applied), or null otherwise; the caller
    // (bootstrapAll) only advances the global watermark once every table drains.
    async bootstrapTable(table) {
        let connectionEpoch = this._wsEpoch;
        let selectorRevision = this._selectorRevision;
        let drain = await this.openTableDrain(table);
        if (drain === null) return null;
        if (connectionEpoch !== this._wsEpoch ||
            selectorRevision !== this._selectorRevision) return null;
        if (!(await this.pageTableDrain(drain))) return null;
        if (drain.connectionEpoch !== this._wsEpoch ||
            drain.selectorRevision !== this._selectorRevision) return null;
        getLogger().info('HubDbSync: bootstrapped ' + drain.applied + ' rows into ' + table +
            (drain.priceSkipped > 0 ? ' (' + drain.priceSkipped + ' row(s) below the ' + drain.priceFloor +
                ' mirror floor left unapplied)' : ''));
        // One line per foreign chain this drain refused rows from, rather than one per row:
        // a hub database that outlived a venue re-genesis serves its whole relic table.
        this.reportRefusedChainRows(table);
        this.reportRefusedNetworkRows(table);
        await this.catchUpToReadyCeiling(drain);
        if (drain.connectionEpoch !== this._wsEpoch ||
            drain.selectorRevision !== this._selectorRevision) return null;

        // Fully drained only if the final page wasn't full and everything applied.
        let fullyDrained = drain.lastPageCount < PAGE_LIMIT && drain.applyErrors === 0;
        fullyDrained = await this.applyHeldPricePredecessors(drain, fullyDrained);
        if (!this.acceptPriceMirrorBound(drain, fullyDrained)) return null;
        this.notePriceFloorAfterDrain(drain, fullyDrained);
        await this.reconcileAfterDrain(drain, fullyDrained);
        if (drain.connectionEpoch !== this._wsEpoch ||
            drain.selectorRevision !== this._selectorRevision) return null;
        if (fullyDrained && !(await this.armBarriersAfterDrain(drain))) return null;
        if (drain.connectionEpoch !== this._wsEpoch ||
            drain.selectorRevision !== this._selectorRevision) return null;

        if (!fullyDrained) return null;
        return drain.watermark !== null ? drain.watermark : 0;
    },

    // Open one table's drain: prime the column cache, prove the network scope and clear
    // what falls outside it, resolve the cursor, and build the accounting the page loop
    // and every pass after it share. Null when the table is not ready, which the caller
    // reports as "not drained" so bootstrapAll retries.
    async openTableDrain(table) {
        // Prime (and validate) the local column cache once, up front. If the mirror
        // table does not exist yet, localColumns throws (it refuses to cache an empty
        // column set); bail as "not drained" so bootstrapAll schedules a retry once
        // the indexer's verifyTables() has created it. Doing this here (rather than
        // letting each row fail in applyRow) avoids a SHOW COLUMNS storm + a misleading
        // "bootstrapped N rows" log when the whole page silently no-ops. Self-heals the
        // cold-start race without a process restart.
        try {
            await this.localColumns(table);
        } catch (e) {
            getLogger().warn('HubDbSync: ' + table + ' not ready for bootstrap (' + e.message + '), will retry');
            return null;
        }

        // Clear anything the mirror holds for a network other than the one it serves,
        // BEFORE the cursor below is read from it, and keep the resolved scope for every
        // id read in this bootstrap. Null scope means the scope could not be proven, and
        // then nothing is deleted and every read stays unscoped (see mirrorNetworkScope).
        let scope = await this.mirrorNetworkScope(table);
        if (scope) await this.purgeForeignNetworkRows(table, scope);

        let cursor = await this.resolveDrainCursor(table, scope);
        let drain = await this.newDrainAccounting(table, scope, cursor);
        await this.newPriceBoundState(drain);
        return drain;
    },

    // Where the page loop starts reading. The position is the highest wire id read from
    // this connection, never a local mirror id.
    async resolveDrainCursor(table, scope) {
        let lastId = Number(this._drainPositions[table]);
        if (!Number.isFinite(lastId) || lastId < 0) lastId = 0;
        // Retractions are absent from this endpoint, so only a re-page from zero can prove
        // which matches the hub currently serves. An incremental page cannot distinguish a
        // retracted old match from one below its cursor.
        if (table === 'cross_chain_matches') {
            lastId = 0;
            this._drainPositions[table] = 0;
        }
        let readyCeiling = (this._readyMaxIds && this._readyMaxIds[table] != null)
            ? Number(this._readyMaxIds[table]) : NaN;
        lastId = await this.restartCursorAboveHubCeiling(table, scope, lastId, readyCeiling);
        return { lastId: lastId, readyCeiling: readyCeiling };
    },

    // A position above the source's advertised ceiling cannot belong to its current id
    // space. Reset the position only. Content-keyed local rows remain valid and no id-space
    // observation authorizes deleting them.
    async restartCursorAboveHubCeiling(table, scope, lastId, readyCeiling) {
        if (lastId > 0 && Number.isFinite(readyCeiling) && lastId > readyCeiling) {
            getLogger().warn('HubDbSync: ' + table + ' drain position ' + lastId +
                ' sits above the hub ceiling ' + readyCeiling + '; re-paging from 0');
            this._drainPositions[table] = 0;
            return 0;
        }
        return lastId;
    },

    // The drain's shared accounting: the page counters, the served-row sets the
    // reconciliation passes read, and the progress reporter's clock. One object, so the
    // flush and every pass after the last page read and advance the same state the loop
    // does, exactly as the closures they replaced did.
    async newDrainAccounting(table, scope, cursor) {
        let drain = {
            table: table, scope: scope,
            lastId: cursor.lastId, readyCeiling: cursor.readyCeiling,
            connectionEpoch: this._wsEpoch,
            selectorRevision: this._selectorRevision,
            fullTable: cursor.lastId === 0,
            // Page until a SHORT page. The previous single-fetch version treated any
            // full page as "not drained" and never fetched the rest. On a hub table
            // larger than one page (prod price_snapshots: 13k+ rounds) the drain was
            // structurally impossible, so the heartbeat gate never opened and the
            // stream watermark froze at 0 (the 2026-06-11 tip-deferral incident).
            applied: 0, applyErrors: 0, lastPageCount: 0, watermark: null,
            // cross_chain_matches only: the ODKU converges every mutation the hub can SERVE, but
            // the bootstrap endpoint filters `status <> 'retracted'` (hub api.js), so a match the
            // hub retracted while this mirror was disconnected is simply ABSENT from every page -
            // there is no row to converge against, and the stale local copy keeps settling
            // forever. Collect what the full re-page did serve so the reconciliation pass below
            // can close that half of #3211.
            servedMatchIds: (table === 'cross_chain_matches') ? new Set() : null,
            matchDrainHubUrl: (table === 'cross_chain_matches') ? this.hubUrl : null,
            // price_snapshots only: the same problem with the opposite cause. Its snapshot
            // endpoint is UNFILTERED (hub api.js: SELECT * ... WHERE id > ?), so a complete
            // re-page is the hub's whole table, which makes "the hub does not hold this round
            // as finalized" provable from the drain alone. Nothing else can prove it here: the
            // table carries no `network` column, so mirrorNetworkScope returns null and BOTH
            // purges above are structurally unreachable for it. Collect the finalized
            // (round_number, coin_pair) keys the hub actually served so the pass below can
            // clear what it did not. See reconcileForeignPriceRounds.
            servedPriceKeys:   (table === 'price_snapshots') ? new Set() : null,
            priceKeysComplete: true,
            maxServedRound:    0,
            // capability_snapshots only: the same problem as price_snapshots, arrived at by the
            // same route. Its snapshot endpoint is UNFILTERED too (hub api.js: SELECT * ...
            // WHERE id > ?), so a complete re-page is the hub's whole table; it carries no
            // `network` column, so mirrorNetworkScope returns null and BOTH purges above are
            // structurally unreachable for it. Collect the natural keys the hub
            // actually served so the pass after the drain can clear what it did not, and record
            // where the local id space stood BEFORE this drain so that pass can only ever judge
            // rows that predate it. See reconcileForeignCapabilitySnapshots.
            servedSnapshotKeys:    (table === 'capability_snapshots') ? new Set() : null,
            snapshotKeysComplete:  true,
            maxServedSnapshotBlock: 0,
        };
        drain.matchPreDrainRows = (table === 'cross_chain_matches')
            ? await this.snapshotFinalizedMatches() : null;
        // The local ids are AUTO_INCREMENT and locally assigned (applyRow strips the wire
        // id), so a row inserted while this drain runs - a live WS event, or this drain's own
        // apply - necessarily carries an id above this mark. Reading it here, before the first
        // page is applied, is what lets the reconciliation exempt those rows without needing a
        // buffer like the price path's.
        drain.snapshotPreDrainMaxId = (table === 'capability_snapshots') ? await this.localMaxId(table, scope) : 0;
        this.newDrainProgress(drain);
        return drain;
    },

    // Progress counter. `fetched` counts every row the hub served this drain, which is
    // the number that has to be seen moving on a cold start even where `applied` lags
    // behind it. The hub states its own MAX(id) per table in the subscription ready
    // message, so where that is known the line also carries how far through the id
    // space this drain has reached.
    newDrainProgress(drain) {
        drain.fetched        = 0;
        drain.pagesFetched   = 0;
        drain.drainStartedAt = Date.now();
        drain.lastProgressAt = drain.drainStartedAt;
        // Rows held back for the batch, in wire order (see flushPendingRows).
        drain.pending        = [];
    },

    // price_snapshots only: the bootstrap bound. `priceHorizon` is the block
    // time of the oldest block this consumer can still process, 0 when no bound applies.
    // `priceFloor` is how far below it this drain reaches. Rows older than the floor are
    // SERVED (so every warrant that rests on the drain having seen the hub's whole table
    // - the reconciliation below above all - is untouched) but not APPLIED.
    async newPriceBoundState(drain) {
        let priceHorizon = (drain.table === 'price_snapshots') ? await this.resolvePriceMirrorHorizon() : 0;
        drain.priceHorizon = priceHorizon;
        drain.priceFloor   = (priceHorizon > 0) ? (priceHorizon - this._priceMirrorLookbackS) : 0;
        // Distinct FINALIZED rounds below the horizon the hub served, and how many of them
        // this drain kept. Finalized-only because that is the exact set every consensus read
        // filters on, so it is what the acceptance check below must measure.
        drain.preHorizonServed   = (priceHorizon > 0) ? new Set() : null;
        drain.preHorizonRetained = (priceHorizon > 0) ? new Set() : null;
        drain.priceSkipped       = 0;
        // Per-PAIR predecessor retention. The two sets above are keyed on round_number with
        // every coin_pair pooled, which is the right shape for getPriceAtRound's round window
        // and the wrong one for getPrice: db.getOracleDataForVM builds `prices` from a per-pair
        // MAX(round_number) join with NO time filter, so a pair whose newest finalized row sits
        // below the floor is present on a full mirror and absent from a bounded one, for the
        // same block. At/after the stale-round visibility height that difference is VM-visible
        // (full mirror: {price:null, roundNumber, timestamp, stale:true}; bounded mirror: no
        // entry at all, so getPrice answers null), and a contract branching on it commits
        // divergent state. So hold each pair's newest bound-out FINALIZED row and apply it
        // after the drain when that pair kept nothing else - the pair's latest-price answer
        // then matches a full mirror's, which is the reference behavior here.
        drain.pricePairHeld    = (priceHorizon > 0) ? new Map() : null;
        drain.pricePairCovered = (priceHorizon > 0) ? new Set() : null;
    },

    // Log the drain's progress, throttled to bootstrapProgressMs. A drain that finishes
    // inside one interval stays silent, so nothing changes for the small mirrored tables.
    reportDrainProgress(drain) {
        if (!(this.bootstrapProgressMs > 0)) return;
        let now = Date.now();
        if ((now - drain.lastProgressAt) < this.bootstrapProgressMs) return;   // short drains stay silent
        drain.lastProgressAt = now;
        let elapsedS = Math.max(1, Math.round((now - drain.drainStartedAt) / 1000));
        let ceiling  = Number(this._readyMaxIds && this._readyMaxIds[drain.table]);
        let share    = (Number.isFinite(ceiling) && ceiling > 0 && drain.lastId > 0)
                         ? ' (~' + Math.min(99, Math.floor((drain.lastId / ceiling) * 100)) + '% of the hub id space)'
                         : '';
        getLogger().info('HubDbSync: bootstrapping ' + drain.table + ': ' + drain.fetched + ' row(s) fetched, ' +
            drain.applied + ' applied, page ' + drain.pagesFetched + ', through id ' + drain.lastId + share +
            ', ' + elapsedS + 's elapsed (' + Math.round(drain.fetched / elapsedS) + ' rows/s)');
    },

    // The page loop. Returns false when a page could not be judged at all (no rows array,
    // or a schema version this build does not mirror), which the caller reports as "not
    // drained" before anything is logged as bootstrapped; true otherwise, with the drain's
    // counters saying how far it got.
    async pageTableDrain(drain) {
        let table = drain.table;
        // One line up front for a table big enough to take a while, so a cold start shows
        // the drain BEGINNING rather than only its result. The counter above then reports
        // every bootstrapProgressMs until it lands.
        let announcedCeiling = Number(this._readyMaxIds && this._readyMaxIds[table]);
        if (Number.isFinite(announcedCeiling) && announcedCeiling > PAGE_LIMIT)
            getLogger().info('HubDbSync: draining ' + table + ' from id ' + drain.lastId +
                ' (the hub reports ' + announcedCeiling + ' as its highest id)');

        for (let page = 0; page < MAX_PAGES; page++) {
            if (drain.connectionEpoch !== this._wsEpoch ||
                drain.selectorRevision !== this._selectorRevision) return false;
            let path = '/hub-db/snapshot/' + table + '?since_id=' + drain.lastId + '&limit=' + PAGE_LIMIT;
            let result = await this.httpGet(path);
            if (drain.connectionEpoch !== this._wsEpoch ||
                drain.selectorRevision !== this._selectorRevision) return false;
            if (!result || !Array.isArray(result.rows)) return false;
            if (!(await this.acceptSnapshotPage(table, result))) return false;

            drain.pagesFetched++;
            for (let row of result.rows) {
                drain.fetched++;
                drain.pending.push({ row: row });
                // Flush on the chunk boundary; a failed flush already stopped at the bad row
                // and left the cursor below it, so this page is over.
                if (drain.pending.length >= this.batchApplyRows && !(await this.flushPendingRows(drain))) break;
            }
            // Whatever the chunk boundary left behind. Skipped after a failure so the
            // already-cleared buffer is not re-walked and the hole is not stepped over.
            if (drain.applyErrors === 0) await this.flushPendingRows(drain);
            drain.lastPageCount = result.rows.length;
            // The LAST page's watermark is the hub's most recent "complete through ts"
            // statement covering everything fetched so far.
            if (Number.isFinite(Number(result.watermark))) drain.watermark = Number(result.watermark);
            // The height watermark rides every snapshot page too, immediately after `count`.
            // Stashed rather than installed: like the seconds watermark it is only true of a
            // mirror that has FULLY drained, and bootstrapAll owns that verdict. Without a
            // carrier here a poll-mode or reconnecting mirror would never establish a
            // baseline at all and would defer every block forever above the activation.
            const pageHeights = sanitizeHeights(result.heights);
            if (pageHeights !== null) this._pendingBootstrapHeights = pageHeights;
            if (drain.applyErrors > 0) break;                // hole hit: stop paging, retry from it
            if (result.rows.length < PAGE_LIMIT) break;      // short page = drained
        }
        return true;
    },

    // The two handshakes every snapshot page passes before a row of it is applied. False
    // refuses the page (and the drain) on a schema version this build does not mirror.
    async acceptSnapshotPage(table, result) {
        // Schema-version handshake: the hub stamps each snapshot page with its
        // mirror schema_version. A mismatch means the hub's row shape differs from
        // what this indexer was built for, so applying these rows could drop a
        // consensus-relevant column and fork the ledger. Fail closed: return "not
        // drained" without applying, so bootstrapAll retries and the barrier stays
        // shut, deferring blocks rather than settling against mismatched mirror data.
        // The != null guard keeps older hubs that send no version working unchanged.
        if (result.schema_version != null && result.schema_version !== HUB_SCHEMA_VERSION) {
            getLogger().error('HubDbSync: hub snapshot schema_version ' + result.schema_version +
                ' != local ' + HUB_SCHEMA_VERSION + ' for ' + table +
                '; refusing to bootstrap. Restart this indexer after upgrading the hub.');
            return false;
        }

        // Chain-identity handshake, before a single row of this page is applied. The
        // three cross-chain snapshot envelopes carry the hub's own btc_chain_id (the
        // block-1 hash of the Bitcoin chain its indexer pushes tips from), which is how
        // a consumer with no Bitcoin chain of its own - a DOGE or LTC indexer, the
        // explorer's display mirror - learns which chain to fence on. A Bitcoin indexer
        // has already set the id 'local' and setExpectedBtcChainId ignores this.
        if (CROSS_CHAIN_TABLES.indexOf(table) !== -1)
            await this.setExpectedBtcChainId(result.btc_chain_id, 'hub');
        return true;
    },
};
