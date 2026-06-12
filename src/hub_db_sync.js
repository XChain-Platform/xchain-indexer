/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Indexer - Hub DB Sync Client
 *
 * Maintains a local read-only copy of the hub's price_snapshots and
 * oracle_prices tables. On startup, fetches a snapshot via REST. After
 * bootstrap, subscribes to a WebSocket channel for live row updates.
 *
 * Used in distributed deployments where the indexer is on a different
 * host from the hub. For single-host deployments, the indexer can simply
 * point its hubDb connection directly at the hub's MariaDB instead.
 *
 * Pure Node.js — uses built-in http/https + the `ws` package only when present.
 *
 * Relationship to xchain-sync (deliberately separate, not accidental dup)
 * ----------------------------------------------------------------------
 * xchain-sync solves a superficially similar problem (snapshot-then-stream a
 * MariaDB table) but is a different abstraction: it fans *validated ledger*
 * data DOWNSTREAM from a master to many validator replicas, with Merkle
 * transparency, cross-source hash verification, and rollback. This module
 * pulls oracle config UPSTREAM from the hub (the producer) into a single
 * consumer — the indexer's own hub-DB mirror — and its real payload is the
 * `waitForPriceSyncHeight` consensus barrier wired into the block loop
 * (XChainIndexer.js), NOT the plumbing. The two are kept apart on purpose:
 * xchain-sync's replicatedTables.js excludes price_snapshots as "hub-mirrored"
 * and SnapshotBuilder defers to this file. See review finding e800fdf6.
 *
 * TRIGGER for revisiting: if a THIRD cross-service table (e.g. validator-set
 * or attestation-results) needs the same snapshot-then-stream treatment, do
 * NOT copy this file a third time. Extract the shared mechanics — the
 * subscribe-before-bootstrap ordering handshake, INSERT IGNORE applier,
 * reconnect/re-bootstrap, and retraction-by-known-column — into one small
 * applier library that both this module and the new consumer use. Merging the
 * two services wholesale is the wrong move (different trust direction, and the
 * consensus barrier belongs to the indexer loop, not to a replication fabric).
 *
 ********************************************************************/

const http  = require('http');
const https = require('https');
const url   = require('url');

let WebSocket = null;
try {
    WebSocket = require('ws');
} catch (e) {
    // ws is optional — if not installed, live updates are disabled but bootstrap still works
}

// Maps each mirrored hub table to the column holding the source-chain action_index.
// Used to apply reorg retractions (row:deleted events) against the local copy.
// Kept local (not taken from the wire) so the DELETE never interpolates an
// attacker-supplied column name.
const RETRACTION_COLUMNS = {
    price_snapshots: 'source_action_index',
    oracle_prices:   'action_index'
};

// Tables mirrored for the cross-chain DEX + cross-chain contract calls.
// cross_chain_matches carries finalized, validator-signed matches;
// cross_chain_calls carries quorum-signed XCALL dispatch/result relay rows;
// capability_snapshots carries the block-boundary cross_chain validator set the
// indexer verifies both against. Retraction of cross_chain_matches is two-sided
// (either order leg); cross_chain_calls retracts on its source-chain request —
// both handled specially in _applyRetraction; capability_snapshots are
// immutable history and never retracted.
const CROSS_CHAIN_TABLES = ['cross_chain_matches', 'cross_chain_calls', 'capability_snapshots'];

// Hub federation state tables. state_checkpoints carries quorum-signed per-chain
// state-hash commitments (the explorer/SDK verification source). Append-only,
// never retracted — a reorged height is superseded by a new row with a higher
// checkpoint_seq. Not on any settlement-critical path (no block-loop barrier).
const HUB_STATE_TABLES = ['state_checkpoints'];

class HubDbSync {

    constructor(hubDb, options) {
        this.hubDb     = hubDb;                            // Database instance pointing at the local hub DB
        this.hubUrl    = options.hubUrl   || process.env.HUB_API_URL || '';
        this.apiKey    = options.apiKey   || process.env.HUB_API_KEY || '';
        this.enabled   = !!this.hubUrl && !!this.hubDb;
        this.pollIntervalMs = parseInt(options.pollInterval || process.env.HUB_DB_SYNC_POLL_INTERVAL || '30000');
        this.ws        = null;
        this.running   = false;

        // Highest reference_block present in the local price_snapshots copy. Used by the
        // block-processing sync barrier (waitForPriceSyncHeight) so an indexer does not
        // validate native-coin fees for a block until its local price mirror has caught up
        // to that block — otherwise two operators with different sync states could read a
        // different latest price round and compute a different fee threshold, diverging the
        // ledger. Refreshed after every successful price_snapshots sync.
        this.priceSyncHeight = 0;
        this._priceWaiters   = [];                         // pending waitForPriceSyncHeight() resolvers

        // Highest effective_at present in the local oracle_prices copy. Used by the
        // block-processing sync barrier (waitForOracleSyncTimestamp) so an indexer does not
        // settle FIAT dispensers for a block until its local oracle mirror has caught up to
        // that block's time — otherwise two operators with different sync states could read a
        // different set of effective oracle prices in reverseOraclePriceMatch() and settle a
        // FIAT dispenser at a different amount, diverging the ledger. Refreshed after every
        // successful oracle_prices sync. Unlike price_snapshots (foundational on BTC),
        // oracle_prices is optional — a deployment with no FIAT oracles never populates it, so
        // this stays null and the barrier must treat that as "nothing to wait on" (see
        // _oracleSyncSatisfied) rather than stalling every block forever.
        this.oracleSyncTimestamp = null;                   // null = mirror's max effective_at not yet known
        this.oracleBootstrapped  = false;                  // true once the mirror has been read at least once
        this._oracleWaiters      = [];                     // pending waitForOracleSyncTimestamp() resolvers

        // Highest effective_time present in the local cross_chain_matches copy. The
        // cross-chain settlement pass uses waitForMatchSync(block_time) so an indexer does
        // not settle a block until its match mirror has caught up to that block's time —
        // otherwise two operators of the same chain could settle a cross-chain match at
        // different blocks, diverging that chain's ledger. Mirrors oracleSyncTimestamp:
        // a NULL max (empty mirror) is valid and means "no cross-chain matches to wait on".
        this.matchSyncTimestamp = null;
        this.matchBootstrapped  = false;
        this._matchWaiters      = [];

        // Highest effective_time present in the local cross_chain_calls copy — the
        // XCALL relay's equivalent of the match barrier. The injection/callback
        // passes use waitForCallSync(block_time) so an indexer never applies a
        // block until its call mirror has caught up to that block's time. Same
        // NULL-is-valid semantics and watermark escape as the match barrier
        // (#1984 class: a quiet table must never freeze the tip).
        this.callSyncTimestamp = null;
        this.callBootstrapped  = false;
        this._callWaiters      = [];

        // Coin this indexer settles for (e.g. 'LTC'). Used to scope the snapshot-presence
        // barrier to matches this chain will actually settle. See waitForSnapshotSync.
        this.coin = options.coin || null;

        // Pending waitForSnapshotSync() resolvers. Unlike the match barrier (a cached
        // scalar max(effective_time)), snapshot-presence is set-dependent — a match can
        // only be settled once the capability_snapshots row set for its snapshot_block is
        // mirrored — so satisfaction is recomputed by a live query per evaluation rather
        // than tracked as a scalar. Gating block advancement on it (defer-and-retry, like
        // the match barrier) keeps every operator settling a match at the same height even
        // if the snapshot mirrors in after the match. See _snapshotSyncSatisfied.
        this._snapshotWaiters   = [];

        // Stream-position watermark — the hub's "you have received everything I
        // produced up to ts" signal, carried by the WS heartbeat ({type:'watermark'}),
        // the ready message, and REST snapshot responses. This is what lets the
        // barriers below distinguish "my mirror is BEHIND the hub" (must defer —
        // settling now could fork the ledger) from "no new rows exist anywhere"
        // (must proceed — deferring deadlocks the chain). The previous row-content
        // watermarks (MAX(effective_at)/MAX(effective_time)) could not make that
        // distinction: the first sparse row armed the barrier and the tip deferred
        // forever until the NEXT row arrived (review items #1984/#1986, live-repro'd
        // on the origin-host/test-host testbed 2026-06-09).
        //
        // Grace margins (seconds) cover rows whose effective time can precede their
        // insertion into the stream: oracle first-publishes are effective at their
        // action's block_time (source-chain indexing lag → retroactive arrival; see
        // the PriceAggregator retroactivity finding for the protocol-level fix),
        // price rounds finalize via PBFT some time after their anchor block, and
        // matches are stamped with the hub's wall clock (skew only).
        this.streamWatermark      = 0;
        this.priceWatermarkGraceS  = parseInt(options.priceWatermarkGraceS  || process.env.HUB_SYNC_PRICE_GRACE_S  || '600');
        this.oracleWatermarkGraceS = parseInt(options.oracleWatermarkGraceS || process.env.HUB_SYNC_ORACLE_GRACE_S || '600');
        this.matchWatermarkGraceS  = parseInt(options.matchWatermarkGraceS  || process.env.HUB_SYNC_MATCH_GRACE_S  || '120');

        // Watermark advancement is gated on a completed bootstrap: WS heartbeats
        // certify only what was delivered ON THE SOCKET, so until the REST
        // bootstrap has fully drained every mirrored table (rows from before the
        // subscription), a heartbeat must not certify the mirror as caught-up.
        // Reset on disconnect; re-set after the reconnect re-bootstrap drains.
        this._bootstrapDrained = false;
        this._readyWatermark   = null;
    }

    // Advance the stream watermark (monotonic) and re-evaluate every pending
    // barrier waiter — a watermark advance can satisfy any of them.
    _advanceWatermark(ts) {
        ts = Number(ts);
        if (!Number.isFinite(ts) || ts <= this.streamWatermark) return;
        this.streamWatermark = ts;
        this._releasePriceWaiters();
        this._releaseOracleWaiters();
        this._releaseMatchWaiters();
        this._releaseCallWaiters();
    }

    // Start: open WebSocket and await the hub's ready acknowledgement (confirming
    // the subscription is registered), then bootstrap from REST snapshots. This
    // order ensures no rows can be broadcast between the snapshot response and our
    // subscription becoming active. Rows that arrive via the stream during the
    // bootstrap window are harmless duplicates — _applyRow uses INSERT IGNORE.
    async start() {
        if (!this.enabled) {
            console.log('HubDbSync: disabled (no hub URL or no local hub DB connection)');
            return;
        }
        this.running = true;

        if (WebSocket) {
            // Subscribe first so no row is missed between the REST snapshot and
            // when the hub registers us as a subscriber.
            try {
                await this._connectWebSocket();
            } catch (err) {
                console.warn('HubDbSync: WebSocket not ready before bootstrap:', err);
                // Continue — bootstrap still runs; _scheduleReconnect is already queued
            }
        } else {
            console.warn('HubDbSync: ws package not available, falling back to periodic polling');
        }

        // Bootstrap each tracked table after the subscription is confirmed active
        await this._bootstrapAll();

        if (!WebSocket) {
            this._startPolling();
        }
    }

    // Bootstrap every mirrored table. When ALL of them fully drain (each REST
    // snapshot returned fewer rows than its page limit and applied cleanly),
    // the mirror provably holds everything the hub had at the OLDEST of the
    // per-table response watermarks — advance the stream watermark to it and
    // open the heartbeat gate.
    //
    // A partial drain leaves the gate closed and SCHEDULES A RETRY. The retry is
    // load-bearing in WS mode: there is no poll loop while the socket is healthy,
    // so without it one failed table would freeze the watermark at 0 until the
    // next reconnect — which on a stable connection is never (prod incident
    // 2026-06-11: BTC mainnet deferred every tip block in 60s loops because the
    // single-page bootstrap could not drain a >10k-row price_snapshots table and
    // nothing ever re-attempted it).
    async _bootstrapAll() {
        if (this._bootstrapping) return;                     // reconnect + retry timer may overlap
        this._bootstrapping = true;
        try {
            let marks = [];
            let allDrained = true;
            for (let table of ['price_snapshots', 'oracle_prices'].concat(CROSS_CHAIN_TABLES, HUB_STATE_TABLES)) {
                try {
                    let mark = await this._bootstrapTable(table);
                    if (mark === null) allDrained = false;
                    else marks.push(mark);
                } catch (err) {
                    allDrained = false;
                    console.warn('HubDbSync: ' + table + ' bootstrap failed:', err);
                }
            }
            if (allDrained && marks.length > 0) {
                this._bootstrapDrained = true;
                this._advanceWatermark(Math.min.apply(null, marks));
            } else if (this.running) {
                console.warn('HubDbSync: bootstrap partial — retrying in ' + this.pollIntervalMs + 'ms (heartbeat gate stays closed)');
                setTimeout(() => {
                    if (this.running && !this._bootstrapDrained) this._bootstrapAll();
                }, this.pollIntervalMs);
            }
        } finally {
            this._bootstrapping = false;
        }
    }

    stop() {
        this.running = false;
        if (this.ws) {
            try { this.ws.close(); } catch (e) { /* ignore */ }
            this.ws = null;
        }
    }

    // Bootstrap: fetch a full snapshot of the table from the hub and apply it.
    // If the hub supplied max_ids in the ready message, runs a supplemental
    // catch-up fetch for any IDs between the snapshot ceiling and hub_ready_max_id
    // that may have arrived while the REST round-trip was in flight.
    // Returns the snapshot response's stream watermark when this table fully
    // drained (page not full, every row applied), or null otherwise — the caller
    // (_bootstrapAll) only advances the global watermark once every table drains.
    async _bootstrapTable(table) {
        const PAGE_LIMIT = 10000;
        const MAX_PAGES  = 1000;                             // runaway backstop (10M rows)
        // Determine the highest existing ID in the local copy so we only fetch newer rows
        let lastId = 0;
        try {
            let rows = await this.hubDb.doQuery('SELECT MAX(id) AS max_id FROM ' + table);
            if (rows.length > 0 && rows[0].max_id) lastId = Number(rows[0].max_id);
        } catch (e) {
            // Table may not exist yet — bootstrap starts at 0
        }

        // Page until a SHORT page. The previous single-fetch version treated any
        // full page as "not drained" and never fetched the rest — on a hub table
        // larger than one page (prod price_snapshots: 13k+ rounds) the drain was
        // structurally impossible, so the heartbeat gate never opened and the
        // stream watermark froze at 0 (the 2026-06-11 tip-deferral incident).
        let applied = 0;
        let applyErrors = 0;
        let lastPageCount = 0;
        let watermark = null;
        for (let page = 0; page < MAX_PAGES; page++) {
            let path = '/hub-db/snapshot/' + table + '?since_id=' + lastId + '&limit=' + PAGE_LIMIT;
            let result = await this._httpGet(path);
            if (!result || !Array.isArray(result.rows)) return null;

            for (let row of result.rows) {
                try {
                    await this._applyRow(table, row);
                    applied++;
                } catch (err) {
                    applyErrors++;
                    console.warn('HubDbSync: failed to apply row in ' + table + ':', err);
                }
                // Advance the cursor unconditionally — a row that failed to apply is
                // counted in applyErrors (gate stays closed; retry re-fetches it).
                let rowId = Number(row.id);
                if (Number.isFinite(rowId) && rowId > lastId) lastId = rowId;
            }
            lastPageCount = result.rows.length;
            // The LAST page's watermark is the hub's most recent "complete through ts"
            // statement covering everything fetched so far.
            if (Number.isFinite(Number(result.watermark))) watermark = Number(result.watermark);
            if (result.rows.length < PAGE_LIMIT) break;      // short page = drained
        }
        console.log('HubDbSync: bootstrapped ' + applied + ' rows into ' + table);

        // Defense-in-depth: if the hub told us its max_id at subscription time and our
        // local copy is still behind that ceiling, the REST snapshot window may have
        // missed rows that arrived right before the snapshot was served. Issue a targeted
        // catch-up for that narrow gap. Rows already local are ignored (INSERT IGNORE).
        let hubReadyMaxId = this._readyMaxIds && this._readyMaxIds[table];
        if (hubReadyMaxId) {
            let localRows = [];
            try {
                localRows = await this.hubDb.doQuery('SELECT MAX(id) AS max_id FROM ' + table);
            } catch (e) { /* ignore */ }
            let localMax = (localRows.length > 0 && localRows[0].max_id) ? Number(localRows[0].max_id) : 0;
            if (localMax < hubReadyMaxId) {
                console.log('HubDbSync: gap detected in ' + table + ' (local=' + localMax +
                            ' hub_ready=' + hubReadyMaxId + '), fetching catch-up rows');
                try {
                    let catchUpPath = '/hub-db/snapshot/' + table + '?since_id=' + localMax + '&limit=10000';
                    let catchUp = await this._httpGet(catchUpPath);
                    if (catchUp && Array.isArray(catchUp.rows)) {
                        for (let row of catchUp.rows) {
                            try { await this._applyRow(table, row); } catch (e) { /* ignore */ }
                        }
                    }
                } catch (err) {
                    console.warn('HubDbSync: catch-up fetch failed for ' + table + ':', err);
                }
            }
        }

        if (table === 'price_snapshots')     await this._refreshPriceSyncHeight();
        if (table === 'oracle_prices')       await this._refreshOracleSyncTimestamp();
        if (table === 'cross_chain_matches') await this._refreshMatchSyncTimestamp();
        if (table === 'cross_chain_calls')   await this._refreshCallSyncTimestamp();
        // A new match/call (new required snapshot_block) or an arriving snapshot can change
        // snapshot-presence — re-evaluate the snapshot barrier on any cross-chain table.
        if (CROSS_CHAIN_TABLES.indexOf(table) !== -1) await this._releaseSnapshotWaiters();

        // Fully drained only if the final page wasn't full and everything applied.
        let fullyDrained = lastPageCount < PAGE_LIMIT && applyErrors === 0;
        if (!fullyDrained) return null;
        return watermark !== null ? watermark : 0;
    }

    // Recompute the highest finalized price block present in the local price_snapshots
    // copy and release any barrier waiters that are now satisfied. Called after every
    // successful sync of the table (bootstrap, poll, live insert, reorg retraction).
    async _refreshPriceSyncHeight() {
        let height = 0;
        try {
            let rows = await this.hubDb.doQuery(
                "SELECT MAX(reference_block) AS h FROM price_snapshots WHERE status = 'finalized'"
            );
            if (rows.length > 0 && rows[0].h !== null) height = Number(rows[0].h);
        } catch (e) {
            return;                                         // table not ready yet — leave height untouched
        }
        this.priceSyncHeight  = height;
        this.priceBootstrapped = true;                      // mirror read successfully at least once
        this._releasePriceWaiters();
    }

    // Whether the price mirror is caught up enough to safely process a block at
    // (blockHeight, blockTime). Two satisfied cases:
    //   1. A finalized round anchored at or past this height is local — every round
    //      eligible at this height is therefore local (rows arrive id-ordered).
    //   2. The hub's stream watermark has passed this block's time plus a grace
    //      margin covering PBFT finalization lag — the hub has told us everything
    //      it produced through that instant, so the set of rounds at or before this
    //      height is FINAL (a round anchored ≤ H is finalized within grace of
    //      time(H); none can appear later). This is what lets a fresh distributed
    //      BTC indexer bootstrap on a chain with no rounds yet (#1986) and lets
    //      the tip proceed deterministically through an oracle round gap, while a
    //      genuinely-behind mirror (hub unreachable → watermark frozen) still
    //      defers. blockTime may be absent (legacy callers) — then only case 1.
    _priceSyncSatisfied(blockHeight, blockTime) {
        if (this.priceSyncHeight >= blockHeight) return true;
        if (this.priceBootstrapped && Number.isFinite(blockTime) &&
            this.streamWatermark >= blockTime + this.priceWatermarkGraceS) return true;
        return false;
    }

    // Resolve any pending waiters whose target is now covered.
    _releasePriceWaiters() {
        if (this._priceWaiters.length === 0) return;
        let stillWaiting = [];
        for (let w of this._priceWaiters) {
            if (this._priceSyncSatisfied(w.height, w.blockTime)) {
                clearTimeout(w.timer);
                w.resolve(this.priceSyncHeight);
            } else {
                stillWaiting.push(w);
            }
        }
        this._priceWaiters = stillWaiting;
    }

    // Block-processing sync barrier. Resolves once the local price_snapshots copy holds a
    // finalized round anchored at reference_block >= blockHeight (i.e. this node has caught
    // up to the hub for that block, so every round eligible at this block is already local).
    // Rejects after timeoutMs so the caller can DEFER the block and retry — never validate
    // native-coin fees against a stale local mirror.
    //
    // Price rounds are anchored to the oracle reference chain's block height (reference_block),
    // so this comparison is only meaningful for an indexer whose own chain IS that reference
    // chain. Callers on other chains must not gate on this — see XChainIndexer.
    waitForPriceSyncHeight(blockHeight, timeoutMs, blockTime) {
        blockHeight = Number(blockHeight);
        blockTime   = Number(blockTime);
        // Nothing to wait on when sync is disabled (single-host: the local hub DB is the hub
        // itself, always current) or the target is not a finite height.
        if (!this.enabled || !Number.isFinite(blockHeight)) return Promise.resolve(this.priceSyncHeight);
        if (this._priceSyncSatisfied(blockHeight, blockTime)) return Promise.resolve(this.priceSyncHeight);

        let ms = parseInt(timeoutMs);
        if (!Number.isFinite(ms) || ms <= 0) ms = 60000;
        return new Promise((resolve, reject) => {
            let waiter = { height: blockHeight, blockTime: blockTime, resolve: resolve, timer: null };
            waiter.timer = setTimeout(() => {
                this._priceWaiters = this._priceWaiters.filter(w => w !== waiter);
                reject(new Error('price sync barrier timed out after ' + ms + 'ms waiting for block ' +
                                 blockHeight + ' (price mirror at ' + this.priceSyncHeight +
                                 ', stream watermark at ' + this.streamWatermark + ')'));
            }, ms);
            this._priceWaiters.push(waiter);
        });
    }

    // Recompute the highest effective_at present in the local oracle_prices copy and release
    // any barrier waiters that are now satisfied. Called after every successful sync of the
    // table (bootstrap, poll, live insert, reorg retraction). A NULL max (empty mirror) is a
    // valid result — it means this deployment has no oracle prices, which oracleBootstrapped
    // distinguishes from "not synced yet".
    async _refreshOracleSyncTimestamp() {
        let ts = null;
        try {
            let rows = await this.hubDb.doQuery('SELECT MAX(effective_at) AS ts FROM oracle_prices');
            if (rows.length > 0 && rows[0].ts !== null) ts = Number(rows[0].ts);
        } catch (e) {
            return;                                         // table not ready yet — leave state untouched
        }
        this.oracleSyncTimestamp = ts;                      // number, or null when the mirror holds no oracle prices
        this.oracleBootstrapped  = true;                    // we have successfully read the mirror at least once
        this._releaseOracleWaiters();
    }

    // Whether the local oracle mirror is caught up enough to safely settle a block at blockTime.
    // Two distinct "satisfied" cases:
    //   1. The mirror has been read and holds no oracle prices at all — nothing to gate on.
    //   2. The mirror holds prices whose newest effective_at is at or past this block's time,
    //      so every price effective at or before blockTime is already local.
    _oracleSyncSatisfied(blockTime) {
        if (this.oracleBootstrapped && this.oracleSyncTimestamp === null) return true;
        if (this.oracleSyncTimestamp !== null && this.oracleSyncTimestamp >= blockTime) return true;
        // Stream watermark: the hub has sent us every row it produced through
        // blockTime + grace, so the set of prices effective at or before this
        // block is final — quiet oracles must not stall the chain (#1984). The
        // grace margin covers first-publish rows arriving after their (retro-
        // active) effective_at; see the PriceAggregator retroactivity finding.
        if (this.oracleBootstrapped && this.streamWatermark >= blockTime + this.oracleWatermarkGraceS) return true;
        return false;
    }

    // Resolve any pending waiters whose target time is now covered.
    _releaseOracleWaiters() {
        if (this._oracleWaiters.length === 0) return;
        let stillWaiting = [];
        for (let w of this._oracleWaiters) {
            if (this._oracleSyncSatisfied(w.ts)) {
                clearTimeout(w.timer);
                w.resolve(this.oracleSyncTimestamp);
            } else {
                stillWaiting.push(w);
            }
        }
        this._oracleWaiters = stillWaiting;
    }

    // Block-processing sync barrier for FIAT dispenser settlement. Resolves once the local
    // oracle_prices copy holds every price effective at or before this block's median time
    // (block_time), so reverseOraclePriceMatch() reads the same effective price set on every
    // indexer. Rejects after timeoutMs so the caller can DEFER the block and retry — never
    // settle a FIAT dispenser against a stale local oracle mirror.
    //
    // Oracle prices are keyed by wall-clock effective_at (not a chain block height), so unlike
    // waitForPriceSyncHeight this comparison is meaningful — and required — on every chain.
    // Resolves immediately when sync is disabled (single-host: the local hub DB is the hub
    // itself, always current) or when the mirror is known to hold no oracle prices at all.
    waitForOracleSyncTimestamp(blockTime, timeoutMs) {
        blockTime = Number(blockTime);
        if (!this.enabled || !Number.isFinite(blockTime)) return Promise.resolve(this.oracleSyncTimestamp);
        if (this._oracleSyncSatisfied(blockTime))          return Promise.resolve(this.oracleSyncTimestamp);

        let ms = parseInt(timeoutMs);
        if (!Number.isFinite(ms) || ms <= 0) ms = 60000;
        return new Promise((resolve, reject) => {
            let waiter = { ts: blockTime, resolve: resolve, timer: null };
            waiter.timer = setTimeout(() => {
                this._oracleWaiters = this._oracleWaiters.filter(w => w !== waiter);
                reject(new Error('oracle sync barrier timed out after ' + ms + 'ms waiting for block_time ' +
                                 blockTime + ' (oracle mirror at ' + this.oracleSyncTimestamp + ')'));
            }, ms);
            this._oracleWaiters.push(waiter);
        });
    }

    // Apply a row to the local hub DB (INSERT IGNORE to keep idempotent).
    // Columns are FILTERED to the local mirror table's schema: the hub may serve
    // columns the mirror deliberately does not carry (e.g. state_checkpoints'
    // hub-side anchor_txid audit column — see src/sql/state_checkpoints.sql), and
    // the hub side can gain columns before this indexer updates. Without the
    // filter, one new hub column turns every mirrored insert for that table into
    // ER_BAD_FIELD_ERROR and silently kills the mirror (fleet incident 2026-06-11:
    // anchor_txid landed with the ANCHOR rollout and stopped all state_checkpoints
    // mirroring). Unknown columns are dropped, never errors.
    async _applyRow(table, row) {
        let allowed = await this._localColumns(table);
        let cols = Object.keys(row).filter(c => allowed.has(c));
        if (cols.length === 0) return;
        let placeholders = cols.map(() => '?').join(', ');
        let query = 'INSERT IGNORE INTO ' + table + ' (' + cols.join(', ') + ') VALUES (' + placeholders + ')';
        let args = cols.map(c => row[c]);
        await this.hubDb.doQuery(query, args);
    }

    // Local mirror table columns, cached per table for the process lifetime.
    // Table names come only from the fixed internal mirror lists (the
    // price_snapshots/oracle_prices pair, CROSS_CHAIN_TABLES, HUB_STATE_TABLES),
    // never from hub input.
    async _localColumns(table) {
        if (!this._localColumnCache) this._localColumnCache = {};
        if (!this._localColumnCache[table]) {
            let rows = await this.hubDb.doQuery('SHOW COLUMNS FROM ' + table);
            this._localColumnCache[table] = new Set((rows || []).map(r => r.Field));
        }
        return this._localColumnCache[table];
    }

    // Apply a reorg retraction to the local hub DB copy. The hub deletes price
    // rows seeded from rolled-back PRICE actions; we mirror that delete so this
    // indexer stops reading prices that were never finalized on-chain.
    // event: { table, source_chain, from_action_index }
    async _applyRetraction(event) {
        let from = Number(event.from_action_index);
        if (!Number.isFinite(from)) return;                    // malformed — ignore
        // cross_chain_matches is two-sided: a match is retracted when EITHER order leg on
        // the reorged chain was rolled back. The settlement pass then rolls back any leg it
        // already applied for that match (its cross_chain_settlements row drops with the block).
        if (event.table === 'cross_chain_matches') {
            await this.hubDb.doQuery(
                'DELETE FROM cross_chain_matches WHERE (a_chain = ? AND a_action_index >= ?) OR (b_chain = ? AND b_action_index >= ?)',
                [event.source_chain, from, event.source_chain, from]);
            await this._refreshMatchSyncTimestamp();
            return;
        }
        // cross_chain_calls retracts on its source-chain request (the XCALL v0 row
        // that was reorged away). Both phases drop — a dispatch whose request
        // vanished must never produce an execution or a callback here.
        if (event.table === 'cross_chain_calls') {
            await this.hubDb.doQuery(
                'DELETE FROM cross_chain_calls WHERE source_chain = ? AND source_action_index >= ?',
                [event.source_chain, from]);
            await this._refreshCallSyncTimestamp();
            return;
        }
        let column = RETRACTION_COLUMNS[event.table];
        if (!column) return;                                   // unknown table — ignore
        let query = 'DELETE FROM ' + event.table + ' WHERE source_chain = ? AND ' + column + ' >= ?';
        await this.hubDb.doQuery(query, [event.source_chain, from]);
    }

    // ── Cross-chain match sync barrier (mirrors the oracle_prices barrier) ──────

    // Recompute the highest effective_time present in the local cross_chain_matches copy
    // (finalized only) and release satisfied waiters. A NULL max (empty mirror) is valid.
    async _refreshMatchSyncTimestamp() {
        let ts = null;
        try {
            let rows = await this.hubDb.doQuery(
                "SELECT MAX(effective_time) AS ts FROM cross_chain_matches WHERE status = 'finalized'");
            if (rows.length > 0 && rows[0].ts !== null) ts = Number(rows[0].ts);
        } catch (e) {
            return;                                             // table not ready yet
        }
        this.matchSyncTimestamp = ts;
        this.matchBootstrapped  = true;
        this._releaseMatchWaiters();
    }

    _matchSyncSatisfied(blockTime) {
        if (this.matchBootstrapped && this.matchSyncTimestamp === null) return true;
        if (this.matchSyncTimestamp !== null && this.matchSyncTimestamp >= blockTime) return true;
        // Stream watermark: matches are stamped with the hub's wall clock at
        // finalization and broadcast immediately, so a watermark past this
        // block's time (plus clock-skew grace) means every match effective at
        // or before it is already local. Without this, the FIRST finalized
        // cross-chain match anywhere froze every distributed replica on every
        // chain until the next match arrived (#1984, live-repro'd: an LTC⇄DOGE
        // match stalled the BTC replica for 6+ cycles).
        if (this.matchBootstrapped && this.streamWatermark >= blockTime + this.matchWatermarkGraceS) return true;
        return false;
    }

    _releaseMatchWaiters() {
        if (this._matchWaiters.length === 0) return;
        let stillWaiting = [];
        for (let w of this._matchWaiters) {
            if (this._matchSyncSatisfied(w.ts)) {
                clearTimeout(w.timer);
                w.resolve(this.matchSyncTimestamp);
            } else {
                stillWaiting.push(w);
            }
        }
        this._matchWaiters = stillWaiting;
    }

    // Block-processing barrier for the cross-chain settlement pass. Resolves once the local
    // cross_chain_matches copy holds every match effective at or before this block's time, so
    // every operator of this chain settles the same matches at the same block. Rejects after
    // timeoutMs so the caller can DEFER the block and retry — never settle against a stale
    // match mirror. Resolves immediately when sync is disabled or the mirror holds no matches.
    waitForMatchSync(blockTime, timeoutMs) {
        blockTime = Number(blockTime);
        if (!this.enabled || !Number.isFinite(blockTime)) return Promise.resolve(this.matchSyncTimestamp);
        if (this._matchSyncSatisfied(blockTime))           return Promise.resolve(this.matchSyncTimestamp);

        let ms = parseInt(timeoutMs);
        if (!Number.isFinite(ms) || ms <= 0) ms = 60000;
        return new Promise((resolve, reject) => {
            let waiter = { ts: blockTime, resolve: resolve, timer: null };
            waiter.timer = setTimeout(() => {
                this._matchWaiters = this._matchWaiters.filter(w => w !== waiter);
                reject(new Error('match sync barrier timed out after ' + ms + 'ms waiting for block_time ' +
                                 blockTime + ' (match mirror at ' + this.matchSyncTimestamp + ')'));
            }, ms);
            this._matchWaiters.push(waiter);
        });
    }

    // ── Cross-chain call sync barrier (mirrors the match barrier exactly) ──────

    async _refreshCallSyncTimestamp() {
        let ts = null;
        try {
            let rows = await this.hubDb.doQuery(
                "SELECT MAX(effective_time) AS ts FROM cross_chain_calls WHERE status = 'finalized'");
            if (rows.length > 0 && rows[0].ts !== null) ts = Number(rows[0].ts);
        } catch (e) {
            return;                                             // table not ready yet
        }
        this.callSyncTimestamp = ts;
        this.callBootstrapped  = true;
        this._releaseCallWaiters();
    }

    _callSyncSatisfied(blockTime) {
        if (this.callBootstrapped && this.callSyncTimestamp === null) return true;
        if (this.callSyncTimestamp !== null && this.callSyncTimestamp >= blockTime) return true;
        // Stream watermark escape: calls are stamped with the hub's wall clock at
        // finalization and broadcast immediately (same producer pattern as
        // matches), so a watermark past this block's time plus the grace means
        // every relay row effective at/before it is already local. Without this
        // the FIRST cross-chain call anywhere would freeze every replica until
        // the next one arrived (the #1984 bug class).
        if (this.callBootstrapped && this.streamWatermark >= blockTime + this.matchWatermarkGraceS) return true;
        return false;
    }

    _releaseCallWaiters() {
        if (this._callWaiters.length === 0) return;
        let stillWaiting = [];
        for (let w of this._callWaiters) {
            if (this._callSyncSatisfied(w.ts)) {
                clearTimeout(w.timer);
                w.resolve(this.callSyncTimestamp);
            } else {
                stillWaiting.push(w);
            }
        }
        this._callWaiters = stillWaiting;
    }

    // Block-processing barrier for the cross-chain call passes. Resolves once the local
    // cross_chain_calls copy holds every relay row effective at or before this block's
    // time, so every operator injects/delivers the same calls at the same block. Rejects
    // after timeoutMs so the caller can DEFER the block and retry.
    waitForCallSync(blockTime, timeoutMs) {
        blockTime = Number(blockTime);
        if (!this.enabled || !Number.isFinite(blockTime)) return Promise.resolve(this.callSyncTimestamp);
        if (this._callSyncSatisfied(blockTime))            return Promise.resolve(this.callSyncTimestamp);

        let ms = parseInt(timeoutMs);
        if (!Number.isFinite(ms) || ms <= 0) ms = 60000;
        return new Promise((resolve, reject) => {
            let waiter = { ts: blockTime, resolve: resolve, timer: null };
            waiter.timer = setTimeout(() => {
                this._callWaiters = this._callWaiters.filter(w => w !== waiter);
                reject(new Error('call sync barrier timed out after ' + ms + 'ms waiting for block_time ' +
                                 blockTime + ' (call mirror at ' + this.callSyncTimestamp + ')'));
            }, ms);
            this._callWaiters.push(waiter);
        });
    }

    // ── Cross-chain capability-snapshot presence barrier ───────────────────────
    // Companion to the match barrier. A match is only settleable once the cross_chain
    // capability snapshot at its snapshot_block has mirrored in — cross_settle verifies
    // the match's signatures against that snapshot. If it is absent, cross_settle would
    // skip the match while the block advances, so the match settles at whatever later
    // block the snapshot first appears locally — a per-operator-variable height that
    // diverges the ledger. This barrier defers the block (never advancing) until every
    // cross-chain match effective at/before this block's time, for this coin, has its
    // snapshot present — so all operators settle each match at the same height.
    //
    // Scope is PRESENCE only (≥1 snapshot row for the block). Deterministic quorum-N
    // under partial snapshot arrival is a separate, narrower concern sealed by the
    // multi-node design (see cross_settle's N-handling); in the happy path the hub
    // broadcasts the snapshot rows before the match row, so presence implies the set.

    // True when sync is disabled, or when every finalized match effective at/before
    // blockTime for this coin has its cross_chain snapshot mirrored locally. A query
    // error (table not ready) reads as NOT satisfied so the barrier waits rather than
    // letting a block settle against a missing snapshot.
    async _snapshotSyncSatisfied(blockTime) {
        if (!this.enabled) return true;
        blockTime = Number(blockTime);
        if (!Number.isFinite(blockTime)) return true;
        try {
            // Any finalized, effective match (for this coin) whose snapshot_block has no
            // mirrored cross_chain capability_snapshots row → not yet satisfied. coin is
            // optional: without it, fall back to a (safe) superset over all chains.
            let coinClause = this.coin ? 'AND (m.a_chain = ? OR m.b_chain = ?)' : '';
            let args = this.coin ? [blockTime, this.coin, this.coin] : [blockTime];
            let missing = await this.hubDb.doQuery(
                "SELECT 1 FROM cross_chain_matches m " +
                "WHERE m.status = 'finalized' AND m.effective_time <= ? " + coinClause + " " +
                "AND NOT EXISTS (SELECT 1 FROM capability_snapshots s " +
                "                WHERE s.snapshot_block = m.snapshot_block AND s.capability = 'cross_chain') " +
                "LIMIT 1", args);
            if (missing.length > 0) return false;
            // Same presence rule for XCALL relay rows this chain will act on
            // (dispatches targeting it + results it originated) — xexec.js /
            // xcall.processResult verify signatures against these snapshots.
            let callClause = this.coin ? 'AND (c.target_chain = ? OR c.source_chain = ?)' : '';
            let callArgs = this.coin ? [blockTime, this.coin, this.coin] : [blockTime];
            let missingCalls = await this.hubDb.doQuery(
                "SELECT 1 FROM cross_chain_calls c " +
                "WHERE c.status = 'finalized' AND c.effective_time <= ? " + callClause + " " +
                "AND NOT EXISTS (SELECT 1 FROM capability_snapshots s " +
                "                WHERE s.snapshot_block = c.snapshot_block AND s.capability = 'cross_chain') " +
                "LIMIT 1", callArgs);
            return missingCalls.length === 0;
        } catch (e) {
            return false;                                      // table not ready → wait, don't advance
        }
    }

    async _releaseSnapshotWaiters() {
        if (this._snapshotWaiters.length === 0) return;
        let stillWaiting = [];
        for (let w of this._snapshotWaiters) {
            if (await this._snapshotSyncSatisfied(w.ts)) {
                clearTimeout(w.timer);
                w.resolve(true);
            } else {
                stillWaiting.push(w);
            }
        }
        this._snapshotWaiters = stillWaiting;
    }

    // Block-processing barrier: resolves once every effective cross-chain match for this
    // coin has its capability snapshot mirrored. Rejects after timeoutMs so the caller
    // DEFERS the block (counter not advanced) and retries — never settling a match whose
    // snapshot is missing. Resolves immediately when sync is disabled or already satisfied.
    async waitForSnapshotSync(blockTime, timeoutMs) {
        blockTime = Number(blockTime);
        if (!this.enabled || !Number.isFinite(blockTime)) return true;
        if (await this._snapshotSyncSatisfied(blockTime))     return true;

        let ms = parseInt(timeoutMs);
        if (!Number.isFinite(ms) || ms <= 0) ms = 60000;
        return new Promise((resolve, reject) => {
            let waiter = { ts: blockTime, resolve: resolve, timer: null };
            waiter.timer = setTimeout(() => {
                this._snapshotWaiters = this._snapshotWaiters.filter(w => w !== waiter);
                reject(new Error('snapshot sync barrier timed out after ' + ms + 'ms waiting for block_time ' +
                                 blockTime + ' (a cross-chain match is missing its capability snapshot)'));
            }, ms);
            this._snapshotWaiters.push(waiter);
        });
    }

    // Open the WebSocket subscription for live row updates. Returns a Promise that
    // resolves once the hub sends a 'ready' acknowledgement confirming the subscription
    // is registered server-side. start() awaits this before running the REST bootstrap,
    // eliminating the race where rows inserted between the REST response and the upgrade
    // complete were silently dropped. After ready, the connection stays open and
    // processes live events. Rejects if the socket closes before ready is received.
    _connectWebSocket() {
        return new Promise((resolve, reject) => {
            if (!WebSocket || !this.running) {
                return reject(new Error('WebSocket unavailable or sync stopped'));
            }
            let parsed = url.parse(this.hubUrl);
            let wsScheme = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
            let wsUrl = wsScheme + '//' + parsed.host + '/hub-db/subscribe';

            let headers = {};
            if (this.apiKey) headers['Authorization'] = 'Bearer ' + this.apiKey;

            let ws;
            try {
                ws = new WebSocket(wsUrl, { headers: headers });
            } catch (e) {
                console.warn('HubDbSync: WebSocket connect failed:', e);
                this._scheduleReconnect();
                return reject(e);
            }
            this.ws = ws;

            // Resolved once either ready or an error fires — prevents double-settle
            let settled = false;
            const settle = (fn, val) => {
                if (settled) return;
                settled = true;
                fn(val);
            };

            ws.on('open', () => {
                console.log('HubDbSync: WebSocket connected to ' + wsUrl);
            });

            ws.on('message', async (data) => {
                try {
                    let event = JSON.parse(data.toString());
                    if (event.type === 'ready') {
                        // Hub has registered our subscription. Capture hub-side max IDs
                        // (included by HubDbBroadcaster for gap detection after bootstrap).
                        if (event.max_ids && typeof event.max_ids === 'object') {
                            this._readyMaxIds = event.max_ids;
                        }
                        // NOTE: the ready watermark is NOT advanced here — at this point
                        // the REST bootstrap has not run, so rows the hub produced before
                        // this subscription may not be local yet. Bootstrap responses
                        // carry their own watermark (advanced only on a full drain).
                        if (event.watermark) this._readyWatermark = Number(event.watermark);
                        settle(resolve, event);
                        return;
                    }
                    if (event.type === 'watermark') {
                        // Stream-position heartbeat: every row event produced up to ts has
                        // been delivered on this socket. Safe to advance only once the
                        // bootstrap has drained (rows from before the subscription).
                        if (this._bootstrapDrained) this._advanceWatermark(event.ts);
                        return;
                    }
                    if (event.type === 'row:inserted' && event.table && event.row) {
                        await this._applyRow(event.table, event.row);
                        if (event.table === 'price_snapshots')     await this._refreshPriceSyncHeight();
                        if (event.table === 'oracle_prices')       await this._refreshOracleSyncTimestamp();
                        if (event.table === 'cross_chain_matches') await this._refreshMatchSyncTimestamp();
                        if (event.table === 'cross_chain_calls')   await this._refreshCallSyncTimestamp();
                        if (CROSS_CHAIN_TABLES.indexOf(event.table) !== -1) await this._releaseSnapshotWaiters();
                    } else if (event.type === 'row:deleted' && event.table) {
                        await this._applyRetraction(event);
                        if (event.table === 'price_snapshots')     await this._refreshPriceSyncHeight();
                        if (event.table === 'oracle_prices')       await this._refreshOracleSyncTimestamp();
                        if (event.table === 'cross_chain_matches') await this._refreshMatchSyncTimestamp();
                        if (event.table === 'cross_chain_calls')   await this._refreshCallSyncTimestamp();
                        if (event.table === 'cross_chain_matches' || event.table === 'cross_chain_calls') await this._releaseSnapshotWaiters();
                    }
                } catch (err) {
                    console.warn('HubDbSync: failed to handle WebSocket message:', err);
                }
            });

            ws.on('close', () => {
                console.log('HubDbSync: WebSocket disconnected, reconnecting in 5s');
                this.ws = null;
                // Rows produced while disconnected won't arrive on the socket —
                // close the heartbeat gate (and freeze the watermark) until the
                // reconnect re-bootstrap has drained the gap.
                this._bootstrapDrained = false;
                settle(reject, new Error('WebSocket closed before ready'));
                this._scheduleReconnect();
            });

            ws.on('error', (err) => {
                console.warn('HubDbSync: WebSocket error:', err.message);
                // close fires after error and will call _scheduleReconnect
                settle(reject, err);
            });
        });
    }

    _scheduleReconnect() {
        if (!this.running) return;
        setTimeout(async () => {
            if (!this.running) return;

            // Await the hub's ready acknowledgement before re-bootstrapping, for the
            // same reason as start(): no row must fall in the gap between the REST
            // snapshot and the subscription becoming active on the hub side.
            try {
                await this._connectWebSocket();
            } catch (err) {
                // _connectWebSocket already queued another _scheduleReconnect via the
                // close handler — nothing more to do here.
                return;
            }

            // Re-bootstrap to fill in rows missed while disconnected. _bootstrapTable
            // uses the local max-ID as since_id, so it fetches only genuinely-missing
            // rows; re-receives are harmless thanks to INSERT IGNORE in _applyRow.
            // A full drain re-opens the heartbeat gate and advances the watermark.
            await this._bootstrapAll();
        }, 5000);
    }

    // Polling fallback when ws is not available. Snapshot responses carry the
    // hub's stream watermark, so poll-mode mirrors get the same liveness
    // semantics as the WS heartbeat (at poll-interval granularity).
    _startPolling() {
        let poll = async () => {
            if (!this.running) return;
            try {
                await this._bootstrapAll();
            } catch (err) {
                console.warn('HubDbSync: poll error:', err);
            }
            if (this.running) setTimeout(poll, this.pollIntervalMs);
        };
        setTimeout(poll, this.pollIntervalMs);
    }

    // Make a JSON GET request to the hub
    _httpGet(path) {
        return new Promise((resolve, reject) => {
            let parsed = url.parse(this.hubUrl);
            let isHttps = parsed.protocol === 'https:';
            let lib = isHttps ? https : http;
            let opts = {
                hostname: parsed.hostname,
                port:     parsed.port || (isHttps ? 443 : 80),
                path:     path,
                method:   'GET',
                headers:  {},
                timeout:  30000
            };
            if (this.apiKey) opts.headers['x-api-key'] = this.apiKey;

            let req = lib.request(opts, (res) => {
                let body = '';
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        return reject(new Error('HTTP ' + res.statusCode));
                    }
                    try {
                        resolve(JSON.parse(body));
                    } catch (e) {
                        reject(new Error('invalid JSON: ' + e.message));
                    }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(new Error('Request timeout')); });
            req.end();
        });
    }
}

module.exports = HubDbSync;
