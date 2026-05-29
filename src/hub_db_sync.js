/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
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
    }

    // Start: bootstrap from REST snapshots, then subscribe to live updates
    async start() {
        if (!this.enabled) {
            console.log('HubDbSync: disabled (no hub URL or no local hub DB connection)');
            return;
        }
        this.running = true;

        // Bootstrap each tracked table
        try {
            await this._bootstrapTable('price_snapshots');
        } catch (err) {
            console.warn('HubDbSync: price_snapshots bootstrap failed:', err.message);
        }
        try {
            await this._bootstrapTable('oracle_prices');
        } catch (err) {
            console.warn('HubDbSync: oracle_prices bootstrap failed:', err.message);
        }

        // Subscribe to WebSocket live updates if available
        if (WebSocket) {
            this._connectWebSocket();
        } else {
            console.warn('HubDbSync: ws package not available, falling back to periodic polling');
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

    // Bootstrap: fetch a full snapshot of the table from the hub and apply it
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
                console.warn('HubDbSync: failed to apply row in ' + table + ':', err.message);
            }
        }
        console.log('HubDbSync: bootstrapped ' + applied + ' rows into ' + table);
        if (table === 'price_snapshots') await this._refreshPriceSyncHeight();
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
        let column = RETRACTION_COLUMNS[event.table];
        if (!column) return;                                   // unknown table — ignore
        let from = Number(event.from_action_index);
        if (!Number.isFinite(from)) return;                    // malformed — ignore
        let query = 'DELETE FROM ' + event.table + ' WHERE source_chain = ? AND ' + column + ' >= ?';
        await this.hubDb.doQuery(query, [event.source_chain, from]);
    }

    // Open the WebSocket subscription for live row updates
    _connectWebSocket() {
        if (!WebSocket || !this.running) return;
        let parsed = url.parse(this.hubUrl);
        let wsScheme = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
        let wsUrl = wsScheme + '//' + parsed.host + '/hub-db/subscribe';

        let headers = {};
        if (this.apiKey) headers['Authorization'] = 'Bearer ' + this.apiKey;

        try {
            this.ws = new WebSocket(wsUrl, { headers: headers });
        } catch (e) {
            console.warn('HubDbSync: WebSocket connect failed:', e.message);
            this._scheduleReconnect();
            return;
        }

        this.ws.on('open', () => {
            console.log('HubDbSync: WebSocket connected to ' + wsUrl);
        });

        this.ws.on('message', async (data) => {
            try {
                let event = JSON.parse(data.toString());
                if (event.type === 'row:inserted' && event.table && event.row) {
                    await this._applyRow(event.table, event.row);
                    if (event.table === 'price_snapshots') await this._refreshPriceSyncHeight();
                } else if (event.type === 'row:deleted' && event.table) {
                    await this._applyRetraction(event);
                    if (event.table === 'price_snapshots') await this._refreshPriceSyncHeight();
                }
            } catch (err) {
                console.warn('HubDbSync: failed to handle WebSocket message:', err.message);
            }
        });

        this.ws.on('close', () => {
            console.log('HubDbSync: WebSocket disconnected, reconnecting in 5s');
            this.ws = null;
            this._scheduleReconnect();
        });

        this.ws.on('error', (err) => {
            console.warn('HubDbSync: WebSocket error:', err.message);
        });
    }

    _scheduleReconnect() {
        if (!this.running) return;
        setTimeout(async () => {
            if (!this.running) return;
            this._connectWebSocket();

            // Re-bootstrap after reconnecting. The WebSocket subscription only
            // delivers rows broadcast after we resubscribe; any rows the hub
            // inserted while we were disconnected would otherwise be missing
            // permanently. _bootstrapTable uses the local max-ID as since_id, so
            // this fetches only genuinely-missing rows (re-receives are harmless
            // thanks to INSERT IGNORE in _applyRow).
            try {
                await this._bootstrapTable('price_snapshots');
            } catch (err) {
                console.warn('HubDbSync: price_snapshots re-bootstrap failed:', err.message);
            }
            try {
                await this._bootstrapTable('oracle_prices');
            } catch (err) {
                console.warn('HubDbSync: oracle_prices re-bootstrap failed:', err.message);
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
            } catch (err) {
                console.warn('HubDbSync: poll error:', err.message);
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
