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
const { hasExpectedSchemaVersion, schemaVersionLabel } = require('../schema_version_check.js');
const { sanitizeHeights } = require('../watermark_config.js');

const PAGE_LIMIT = 10000;
const MAX_PAGES  = 1000;                             // runaway backstop (10M rows)
const SNAPSHOT_RETRY_BASE_MS = 1000;
const SNAPSHOT_RETRY_MAX_MS  = 30000;
// Retry one page for two minutes, then yield to scheduled bootstrap before
// watermark-stall recovery forces a full resync.
const SNAPSHOT_RETRY_BUDGET_MS = 120000;
const DRAIN_ABORTED = Symbol('drain-aborted');

// The page-age cap covers retry budget, maximum backoff, request deadline,
// and the flush of a page that arrived.
const BOOTSTRAP_PAGE_AGE_BASE_MS = SNAPSHOT_RETRY_BUDGET_MS + SNAPSHOT_RETRY_MAX_MS;

// Retry failures that can clear without changing the request. Authentication and input
// errors need operator or caller changes, so retrying those would only hide the fault.
function isRetryableSnapshotError(error) {
    let status = Number(error && error.statusCode);
    return !Number.isFinite(status) || status === 429 || status >= 500;
}

module.exports = {

    // Drain and apply one table, including rows appended through its ready ceiling.
    // Return its watermark only after a short final page with no apply errors.
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
        this.certifyTableDrain(drain);
        // A complete page from zero has run this table's reconciliation passes above.
        if (drain.fullTable || drain.floorStart) this.settleRepageOwed(drain);
        this.notePriceRepageFloor(drain);
        return drain.watermark !== null ? drain.watermark : 0;
    },

    // Prime schema and network scope, resolve the wire cursor, and build shared
    // drain accounting. Return null until the table is ready.
    async openTableDrain(table) {
        // Prime the column cache before fetching; a missing table stays undrained
        // for bootstrapAll to retry after schema creation.
        try {
            await this.localColumns(table);
        } catch (e) {
            getLogger().warn('HubDbSync: ' + table + ' not ready for bootstrap (' + e.message + '), will retry');
            return null;
        }

        // Purge rows outside a proven network scope before resolving the cursor.
        // An unproven scope leaves deletion and subsequent reads unscoped.
        let scope = await this.mirrorNetworkScope(table);
        if (scope) await this.purgeForeignNetworkRows(table, scope);

        let cursor = await this.resolveDrainCursor(table, scope);
        let drain = await this.newDrainAccounting(table, scope, cursor);
        await this.newPriceBoundState(drain);
        this.choosePriceRepageStart(drain);
        return drain;
    },

    // Resume from the highest wire id read on this connection, never a local id.
    // Positions stay memory-only so reconnects re-page held rows and reconcile from zero.
    async resolveDrainCursor(table, scope) {
        let lastId = Number(this._drainPositions[table]);
        if (!Number.isFinite(lastId) || lastId < 0) lastId = 0;
        // Re-page matches and any table with an owed re-page from zero because
        // omitted or refused changes may sit below the current cursor.
        if (table === 'cross_chain_matches' || this.repageOwedSeq(table) !== undefined) {
            lastId = 0;
            this._drainPositions[table] = 0;
        }
        let readyCeiling = this.readyCeilingFor(table);
        lastId = await this.restartCursorAboveHubCeiling(table, scope, lastId, readyCeiling);
        return { lastId: lastId, readyCeiling: readyCeiling };
    },

    // The ceiling the hub advertised for a table in its ready frame, or NaN when it named
    // none that can be trusted. Only a non-negative integer counts: a null, a string, a
    // boolean or a negative number must not coerce to a real id and reposition a drain.
    readyCeilingFor(table) {
        let ceiling = this._readyMaxIds ? this._readyMaxIds[table] : undefined;
        return (typeof ceiling === 'number' && Number.isInteger(ceiling) && ceiling >= 0) ? ceiling : NaN;
    },

    // Reset a prior connection's cursor when it exceeds the source's ready ceiling.
    // Keep content rows, and exempt positions read on this connection because the
    // ready ceiling is only a subscription-time snapshot.
    async restartCursorAboveHubCeiling(table, scope, lastId, readyCeiling) {
        if (lastId > 0 && Number.isFinite(readyCeiling) && lastId > readyCeiling &&
            !this.positionReadOnThisConnection(table, lastId)) {
            getLogger().warn('HubDbSync: ' + table + ' drain position ' + lastId +
                ' sits above the hub ceiling ' + readyCeiling + '; re-paging from 0');
            this._drainPositions[table] = 0;
            return 0;
        }
        return lastId;
    },

    // True only when the current position is exactly the id a drain on the current socket
    // last read for this table. Any other writer of the position, or any reconnect since
    // (the epoch bumps on every close), leaves the ceiling check in force.
    positionReadOnThisConnection(table, lastId) {
        let read = this._drainPositionReads ? this._drainPositionReads[table] : undefined;
        return !!read && read.wireId === lastId &&
            typeof read.epoch === 'number' && read.epoch === this._wsEpoch;
    },

    // Build the counters, served-key sets, and progress clock shared by the
    // page loop, flush, and reconciliation passes.
    async newDrainAccounting(table, scope, cursor) {
        let drain = {
            table: table, scope: scope,
            lastId: cursor.lastId, readyCeiling: cursor.readyCeiling,
            connectionEpoch: this._wsEpoch,
            selectorRevision: this._selectorRevision,
            fullTable: cursor.lastId === 0,
            // The owed mark this drain was opened under; only that mark may be settled by it.
            repageSeq: this.repageOwedSeq(table),
            // Continue until a short page; a full page proves more rows may remain.
            applied: 0, applyErrors: 0, lastPageCount: 0, watermark: null,
            // Matches omit retractions from snapshot pages; collect served ids so a
            // complete re-page can mark stale local copies retracted.
            servedMatchIds: (table === 'cross_chain_matches') ? new Set() : null,
            matchDrainHubUrl: (table === 'cross_chain_matches') ? this.hubUrl : null,
            // Price snapshots have an unfiltered feed and no network column; collect
            // served finalized keys so a complete drain can remove foreign rows.
            servedPriceKeys:   (table === 'price_snapshots') ? new Set() : null,
            priceKeysComplete: true,
            maxServedRound:    0,
            minServedRound:    null,   // lowest round served, any status (recordServedRow)
            // Capability snapshots also have an unfiltered feed and no network column;
            // collect served keys and judge only rows predating this drain.
            servedSnapshotKeys:    (table === 'capability_snapshots') ? new Set() : null,
            snapshotKeysComplete:  true,
            maxServedSnapshotBlock: 0,
        };
        drain.matchPreDrainRows = (table === 'cross_chain_matches')
            ? await this.snapshotFinalizedMatches() : null;
        // Capture the local id ceiling before page application so reconciliation
        // exempts rows inserted while this drain is running.
        drain.snapshotPreDrainMaxId = (table === 'capability_snapshots') ? await this.localMaxId(table, scope) : 0;
        await this.newOracleReconcileState(drain, scope);
        this.newDrainProgress(drain);
        return drain;
    },

    // Initialize progress; fetched counts every served row so cold-start progress
    // remains visible while application lags.
    newDrainProgress(drain) {
        drain.fetched        = 0;
        drain.pagesFetched   = 0;
        drain.drainStartedAt = Date.now();
        drain.lastProgressAt = drain.drainStartedAt;
        // Rows held back for the batch, in wire order (see flushPendingRows).
        drain.pending        = [];
    },

    // Bound applied price history below the oldest processable block time.
    // Older rows remain served for complete-drain reconciliation but are not applied.
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
        // Hold each pair's newest finalized row below the floor, then apply it only
        // if no newer row for that pair was retained. This preserves full-mirror
        // latest-price results for bounded mirrors.
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
        let ceiling  = this.readyCeilingFor(drain.table);
        let share    = (Number.isFinite(ceiling) && ceiling > 0 && drain.lastId > 0)
                         ? ' (~' + Math.min(99, Math.floor((drain.lastId / ceiling) * 100)) + '% of the hub id space)'
                         : '';
        getLogger().info('HubDbSync: bootstrapping ' + drain.table + ': ' + drain.fetched + ' row(s) fetched, ' +
            drain.applied + ' applied, page ' + drain.pagesFetched + ', through id ' + drain.lastId + share +
            ', ' + elapsedS + 's elapsed (' + Math.round(drain.fetched / elapsedS) + ' rows/s)');
    },

    // Spread concurrent mirrors across the hub's recovery window while keeping each one
    // on its current page. Retry-After wins when the hub or a proxy supplied one.
    async waitForSnapshotRetry(error, attempt, table, lastId) {
        let retryAfterMs = Number(error && error.retryAfterMs);
        let ceiling = Math.min(SNAPSHOT_RETRY_MAX_MS,
            SNAPSHOT_RETRY_BASE_MS * Math.pow(2, Math.min(attempt, 5)));
        let delayMs = (Number.isFinite(retryAfterMs) && retryAfterMs >= 0)
            ? Math.min(retryAfterMs, SNAPSHOT_RETRY_MAX_MS) : Math.floor((ceiling / 2) + (Math.random() * ceiling / 2));
        getLogger().warn('HubDbSync: ' + table + ' snapshot page after id ' + lastId +
            ' failed (' + ((error && error.message) || error) + '), retrying in ' + delayMs + 'ms');
        // Unref'd so a pending retry never holds a stopping process open.
        await new Promise(resolve => {
            let timer = setTimeout(resolve, delayMs);
            if (timer && typeof timer.unref === 'function') timer.unref();
        });
    },

    // Page with a heartbeat across fetch, retry, and flush. Return false when a
    // page cannot be judged; otherwise counters record how far the drain reached.
    async pageTableDrain(drain) {
        let timer = null;
        if (this.bootstrapProgressMs > 0) {
            timer = setInterval(() => {
                try { this.reportDrainProgress(drain); } catch (e) { /* logging never fails a drain */ }
            }, Math.max(1, Math.ceil(this.bootstrapProgressMs / 2)));
            if (timer && typeof timer.unref === 'function') timer.unref();
        }
        try {
            return await this.pageTableDrainPages(drain);
        } finally {
            if (timer) clearInterval(timer);
            this._bootstrapPageSince = null;
        }
    },

    // Spare an active fetch or flush until its page-age cap; after that, the
    // barrier hold may treat it as wedged and force recovery.
    bootstrapPageSpared(now) {
        if (!this._bootstrapping || !Number.isFinite(this._bootstrapPageSince)) return false;
        let deadlineMs = Number(this.httpDeadlineMs);
        let capMs = BOOTSTRAP_PAGE_AGE_BASE_MS + (Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : 0);
        return (now - this._bootstrapPageSince) < capMs;
    },

    // One page with its retry loop. Returns DRAIN_ABORTED when stop() or a new connection
    // ended the drain while the page was in flight.
    async fetchSnapshotPage(drain, path) {
        let retryStartedMs = Date.now();
        for (let attempt = 0; ; attempt++) {
            try {
                return await this.httpGet(path);
            } catch (error) {
                // stop() and a new connection both end this drain; a poll-mode stop changes
                // no epoch, so the running flag is checked too.
                if (this.running === false || drain.connectionEpoch !== this._wsEpoch ||
                    drain.selectorRevision !== this._selectorRevision) return DRAIN_ABORTED;
                if (!isRetryableSnapshotError(error) ||
                    Date.now() - retryStartedMs >= SNAPSHOT_RETRY_BUDGET_MS) throw error;
                await this.waitForSnapshotRetry(error, attempt, drain.table, drain.lastId);
                if (this.running === false || drain.connectionEpoch !== this._wsEpoch ||
                    drain.selectorRevision !== this._selectorRevision) return DRAIN_ABORTED;
            }
        }
    },

    async pageTableDrainPages(drain) {
        let table = drain.table;
        // One line up front for a table big enough to take a while, so a cold start shows
        // the drain BEGINNING rather than only its result. The counter above then reports
        // every bootstrapProgressMs until it lands.
        let announcedCeiling = this.readyCeilingFor(table);
        if (Number.isFinite(announcedCeiling) && announcedCeiling > PAGE_LIMIT)
            getLogger().info('HubDbSync: draining ' + table + ' from id ' + drain.lastId +
                ' (the hub reports ' + announcedCeiling + ' as its highest id)');

        for (let page = 0; page < MAX_PAGES; page++) {
            if (drain.connectionEpoch !== this._wsEpoch ||
                drain.selectorRevision !== this._selectorRevision) return false;
            let path = '/hub-db/snapshot/' + table + '?since_id=' + drain.lastId + '&limit=' + PAGE_LIMIT;
            this._bootstrapPageSince = Date.now();           // page age, see bootstrapPageSpared
            let result = await this.fetchSnapshotPage(drain, path);
            if (result === DRAIN_ABORTED) return false;
            if (drain.connectionEpoch !== this._wsEpoch ||
                drain.selectorRevision !== this._selectorRevision) return false;
            if (!result || !Array.isArray(result.rows)) {
                this.reportRowlessPage(table, path, result);
                return false;
            }
            if (!(await this.acceptSnapshotPage(table, result))) return false;

            drain.pagesFetched++;
            this._bootstrapProgressTicks = (Number(this._bootstrapProgressTicks) || 0) + 1;
            this._bootstrapPageSince = Date.now();           // the flush is timed on its own
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
            // Stash page heights until bootstrapAll proves every table fully drained;
            // poll and reconnect modes still need this pending baseline.
            const pageHeights = sanitizeHeights(result.heights);
            if (pageHeights !== null) {
                drain.heights = pageHeights;
                this._pendingBootstrapHeights = pageHeights;
            }
            if (drain.applyErrors > 0) break;                // hole hit: stop paging, retry from it
            if (result.rows.length < PAGE_LIMIT) break;      // short page = drained
        }
        return true;
    },

    // Report rowless page shape and table explicitly; the table stays undrained
    // whether the response is an error body or another unexpected envelope.
    reportRowlessPage(table, path, result) {
        let shape;
        let hint = '';
        if (result && result.error) {
            let err = result.error;
            shape = 'an error body: ' + ((err && err.message) ? String(err.message) : JSON.stringify(err));
            hint = '; a hub that does not serve ' + table + ' answers this way, so check the hub build';
        } else if (result && typeof result === 'object') {
            shape = 'keys [' + Object.keys(result).slice(0, 8).join(', ') + ']';
        } else {
            shape = String(result);
        }
        getLogger().warn('HubDbSync: ' + table + ' snapshot page from ' + path + ' carried no rows array (' +
            shape + '); the table stays undrained' + hint);
    },

    // The two handshakes every snapshot page passes before a row of it is applied. False
    // refuses the page (and the drain) on a schema version this build does not mirror.
    async acceptSnapshotPage(table, result) {
        // Fail closed before applying a page whose mirror schema version differs;
        // bootstrap retries while barriers remain shut.
        if (!hasExpectedSchemaVersion(result.schema_version)) {
            getLogger().error('HubDbSync: hub snapshot schema_version ' + schemaVersionLabel(result.schema_version) +
                ' != local ' + HUB_SCHEMA_VERSION + ' for ' + table +
                '; refusing to bootstrap. Restart this indexer after upgrading the hub.');
            return false;
        }

        // Adopt the hub's Bitcoin chain identity for cross-chain tables before
        // applying rows; a Bitcoin indexer's local identity remains authoritative.
        if (CROSS_CHAIN_TABLES.indexOf(table) !== -1)
            await this.setExpectedBtcChainId(result.btc_chain_id, 'hub');
        return true;
    },
};
