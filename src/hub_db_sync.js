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

// Tables mirrored for the cross-chain DEX. cross_chain_matches carries finalized,
// validator-signed matches; capability_snapshots carries the block-boundary
// cross_chain validator set the indexer verifies those matches against. Retraction
// of cross_chain_matches is two-sided (either order leg) — handled specially in
// _applyRetraction; capability_snapshots are immutable history and never retracted.
const CROSS_CHAIN_TABLES = ['cross_chain_matches', 'capability_snapshots'];

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
        try {
            await this._bootstrapTable('price_snapshots');
        } catch (err) {
            console.warn('HubDbSync: price_snapshots bootstrap failed:', err);
        }
        try {
            await this._bootstrapTable('oracle_prices');
        } catch (err) {
            console.warn('HubDbSync: oracle_prices bootstrap failed:', err);
        }
        for (let table of CROSS_CHAIN_TABLES) {
            try {
                await this._bootstrapTable(table);
            } catch (err) {
                console.warn('HubDbSync: ' + table + ' bootstrap failed:', err);
            }
        }

        if (!WebSocket) {
            this._startPolling();
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
    async _bootstrapTable(table) {
        // Determine the highest existing ID in the local copy so we only fetch newer rows
        let lastId = 0;
        try {
            let rows = await this.hubDb.doQuery('SELECT MAX(id) AS max_id FROM ' + table);
            if (rows.length > 0 && rows[0].max_id) lastId = Number(rows[0].max_id);
        } catch (e) {
            // Table may not exist yet — bootstrap starts at 0
        }

        let path = '/hub-db/snapshot/' + table + '?since_id=' + lastId + '&limit=10000';
        let result = await this._httpGet(path);
        if (!result || !Array.isArray(result.rows)) return;

        let applied = 0;
        for (let row of result.rows) {
            try {
                await this._applyRow(table, row);
                applied++;
            } catch (err) {
                console.warn('HubDbSync: failed to apply row in ' + table + ':', err);
            }
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
        this.priceSyncHeight = height;
        this._releasePriceWaiters();
    }

    // Resolve any pending waiters whose target height is now covered.
    _releasePriceWaiters() {
        if (this._priceWaiters.length === 0) return;
        let stillWaiting = [];
        for (let w of this._priceWaiters) {
            if (this.priceSyncHeight >= w.height) {
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
    waitForPriceSyncHeight(blockHeight, timeoutMs) {
        blockHeight = Number(blockHeight);
        // Nothing to wait on when sync is disabled (single-host: the local hub DB is the hub
        // itself, always current) or the target is not a finite height.
        if (!this.enabled || !Number.isFinite(blockHeight)) return Promise.resolve(this.priceSyncHeight);
        if (this.priceSyncHeight >= blockHeight)           return Promise.resolve(this.priceSyncHeight);

        let ms = parseInt(timeoutMs);
        if (!Number.isFinite(ms) || ms <= 0) ms = 60000;
        return new Promise((resolve, reject) => {
            let waiter = { height: blockHeight, resolve: resolve, timer: null };
            waiter.timer = setTimeout(() => {
                this._priceWaiters = this._priceWaiters.filter(w => w !== waiter);
                reject(new Error('price sync barrier timed out after ' + ms + 'ms waiting for block ' +
                                 blockHeight + ' (price mirror at ' + this.priceSyncHeight + ')'));
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

    // Apply a row to the local hub DB (INSERT IGNORE to keep idempotent)
    async _applyRow(table, row) {
        let cols = Object.keys(row);
        let placeholders = cols.map(() => '?').join(', ');
        let query = 'INSERT IGNORE INTO ' + table + ' (' + cols.join(', ') + ') VALUES (' + placeholders + ')';
        let args = cols.map(c => row[c]);
        await this.hubDb.doQuery(query, args);
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
                        settle(resolve, event);
                        return;
                    }
                    if (event.type === 'row:inserted' && event.table && event.row) {
                        await this._applyRow(event.table, event.row);
                        if (event.table === 'price_snapshots')     await this._refreshPriceSyncHeight();
                        if (event.table === 'oracle_prices')       await this._refreshOracleSyncTimestamp();
                        if (event.table === 'cross_chain_matches') await this._refreshMatchSyncTimestamp();
                    } else if (event.type === 'row:deleted' && event.table) {
                        await this._applyRetraction(event);
                        if (event.table === 'price_snapshots')     await this._refreshPriceSyncHeight();
                        if (event.table === 'oracle_prices')       await this._refreshOracleSyncTimestamp();
                        if (event.table === 'cross_chain_matches') await this._refreshMatchSyncTimestamp();
                    }
                } catch (err) {
                    console.warn('HubDbSync: failed to handle WebSocket message:', err);
                }
            });

            ws.on('close', () => {
                console.log('HubDbSync: WebSocket disconnected, reconnecting in 5s');
                this.ws = null;
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
            try {
                await this._bootstrapTable('price_snapshots');
            } catch (err) {
                console.warn('HubDbSync: price_snapshots re-bootstrap failed:', err);
            }
            try {
                await this._bootstrapTable('oracle_prices');
            } catch (err) {
                console.warn('HubDbSync: oracle_prices re-bootstrap failed:', err);
            }
            for (let table of CROSS_CHAIN_TABLES) {
                try {
                    await this._bootstrapTable(table);
                } catch (err) {
                    console.warn('HubDbSync: ' + table + ' re-bootstrap failed:', err);
                }
            }
        }, 5000);
    }

    // Polling fallback when ws is not available
    _startPolling() {
        let poll = async () => {
            if (!this.running) return;
            try {
                await this._bootstrapTable('price_snapshots');
                await this._bootstrapTable('oracle_prices');
                for (let table of CROSS_CHAIN_TABLES) await this._bootstrapTable(table);
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
