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
 * XChain Indexer - Hub DB Sync Client: transport
 *
 * The WebSocket subscription (connect, the ready handshake, frame routing and
 * the close path) and the deadline-bounded JSON GET every snapshot fetch uses.
 *
 * Part of the hub-mirror client (src/hub/hub_db_sync.js), which installs the
 * methods here onto HubDbSync.prototype. Vendored byte-identical into
 * xchain-explorer by bin/sync-hub-mirror-client.sh: edit the xchain-indexer copy.
 *
 ********************************************************************/

const http   = require('http');
const https  = require('https');
const url    = require('url');
const { getLogger } = require('../../observability/index.js');
const { sanitizeHeights } = require('./watermark_config.js');
const { sendHubRequest } = require('../hub_client/request.js');

let WebSocket = null;
try {
    WebSocket = require('ws');
} catch (e) {
    // ws is optional; if not installed, live updates are disabled but bootstrap still works
}

const transportMethods = {

    fetchHubList() {
        let apiKey = this.feedApiKey || this.apiKey;
        return sendHubRequest(this.hubUrl, 'gethubs', {}, apiKey, this.httpDeadlineMs);
    },

    // Open the WebSocket subscription for live row updates. Returns a Promise that
    // resolves once the hub sends a 'ready' acknowledgement confirming the subscription
    // is registered server-side. start() awaits this before running the REST bootstrap,
    // eliminating the race where rows inserted between the REST response and the upgrade
    // complete were silently dropped. After ready, the connection stays open and
    // processes live events. Rejects if the socket closes before ready is received.
    connectWebSocket() {
        return new Promise((resolve, reject) => {
            if (!WebSocket || !this.running) {
                return reject(new Error('WebSocket unavailable or sync stopped'));
            }
            this.captureConnectionAddress();
            let parsed = url.parse(this.hubUrl);
            let wsScheme = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
            let wsUrl = wsScheme + '//' + parsed.host + '/hub-db/subscribe';

            let headers = {};
            let apiKey = this.feedApiKey || this.apiKey;
            if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;

            let ws;
            try {
                ws = new WebSocket(wsUrl, { headers: headers });
            } catch (e) {
                getLogger().warn('HubDbSync: WebSocket connect failed:', e);
                this.scheduleReconnect();
                return reject(e);
            }
            this.ws = ws;

            // Resolved once either ready or an error fires; prevents double-settle
            let settled = false;
            const settle = (fn, val) => {
                if (settled) return;
                settled = true;
                fn(val);
            };

            ws.on('open', () => {
                getLogger().info('HubDbSync: WebSocket connected to ' + wsUrl);
                this.startWatchdog(ws);
            });

            ws.on('message', (data) => this.onSocketFrame(ws, data, (event) => settle(resolve, event)));

            ws.on('close', (code) => {
                // Every resync close requires a full re-page so in-place updates below
                // the stored cursor are redelivered, including price landing's batch_block_time stamp.
                if (code === 1012) this._lastHubInstanceId = null;
                this.resetOnSocketClose();
                settle(reject, new Error('WebSocket closed before ready'));
                this.scheduleReconnect();
            });

            ws.on('error', (err) => {
                getLogger().warn('HubDbSync: WebSocket error: ' + err.message);
                // close fires after error and will call scheduleReconnect
                settle(reject, err);
            });
        });
    },

    // One inbound frame: stamp liveness, parse, resolve the connect on the ready frame,
    // and serialize everything else through the message chain. `onReady` is the connect
    // promise's settle, handed in so the ready frame can resolve it without this method
    // holding the promise.
    onSocketFrame(ws, data, onReady) {
        // Liveness stamp at frame ARRIVAL (#2477). The watchdog measures
        // TRANSPORT liveness, so stamp on ANY inbound frame here, BEFORE the
        // frame is enqueued to _msgChain. Stamping inside the chain instead (behind
        // awaited row applies) measured PROCESSING: a row-apply backlog longer than
        // watermarkTimeoutMs would terminate a healthy socket and force a
        // re-bootstrap, a self-reinforcing loop. The hub emits a watermark at least
        // every interval, so any frame arriving is sufficient proof of liveness;
        // watermark ADVANCEMENT stays serialized behind row applies in _msgChain.
        this._lastHeartbeatAt = Date.now();
        let event;
        try {
            event = JSON.parse(data.toString());
        } catch (err) {
            getLogger().warn('HubDbSync: failed to parse WebSocket message:', err);
            return;
        }

        // ready frames are synchronous (no DB I/O) and must resolve the
        // outer Promise immediately, so they bypass the serialization chain.
        if (event.type === 'ready') {
            this.adoptReadyFrame(ws, event);
            onReady(event);
            return;
        }
        this.enqueueStreamFrame(event);
    },

    // The hub has registered our subscription: take what the ready frame carries.
    adoptReadyFrame(ws, event) {
        this._readyCaughtUp = event.caught_up !== false;
        this._readyCaughtUpHandled = false;
        // A position may cross a connection boundary only when the hub explicitly
        // identifies the same database instance. Older hubs omit the field and therefore
        // re-page from zero on every reconnect.
        let instanceId = (typeof event.hub_instance_id === 'string' && event.hub_instance_id !== '')
            ? event.hub_instance_id : null;
        if (instanceId === null || instanceId !== this._lastHubInstanceId)
            this._drainPositions = Object.create(null);
        this._lastHubInstanceId = instanceId;

        // Hub has registered our subscription. Capture hub-side max IDs
        // (included by HubDbBroadcaster for gap detection after bootstrap).
        if (event.max_ids && typeof event.max_ids === 'object') {
            this._readyMaxIds = event.max_ids;
        } else this._readyMaxIds = undefined;
        // Self-size the heartbeat watchdog from the hub's ACTUAL cadence when
        // advertised (watermark_interval_ms), so the client timeout > hub
        // interval invariant holds without a matching env knob on every
        // consumer. Re-arm the watchdog (already started on 'open' with the
        // env-seeded cadence) only when a valid new interval was adopted, so
        // both the poll cadence and the timeout track the hub.
        if (this.adoptHubWatermarkInterval(event.watermark_interval_ms))
            this.startWatchdog(ws);
        // NOTE: the ready watermark is NOT advanced here. At this point
        // the REST bootstrap has not run, so rows the hub produced before
        // this subscription may not be local yet. Bootstrap responses
        // carry their own watermark (advanced only on a full drain).
        if (event.watermark) this._readyWatermark = Number(event.watermark);
        // Same rule for the height map it carries: stashed, not installed. It is
        // the fallback the drain installs when the snapshot pages carried none,
        // which is what keeps a reconnect from waiting a whole heartbeat interval
        // for its first heights map.
        this._readyHeights = sanitizeHeights(event.heights);
    },

    // All other frames (watermark heartbeats and row events) are
    // serialized through _msgChain so a watermark frame can never
    // advance streamWatermark while a preceding row:inserted apply
    // is still awaiting its DB write.
    enqueueStreamFrame(event) {
        this._msgChain = this._msgChain.then(async () => {
            try {
                if (event.type === 'watermark') {
                    // Liveness is stamped at frame ARRIVAL in the raw ws.on('message')
                    // handler above (#2477), not here: stamping inside this serialized
                    // chain (behind awaited row applies) let a row-apply backlog
                    // terminate a healthy socket. Only stream-watermark ADVANCEMENT
                    // stays serialized here.
                    // Stream-position heartbeat: every row event produced up to ts has
                    // been delivered on this socket. Safe to advance only once the
                    // bootstrap has drained (rows from before the subscription).
                    // Do not advance while a live schema mismatch is outstanding:
                    // rows are being refused below, so certifying the stream as
                    // caught-up would settle blocks against data we did not apply.
                    // Record the hub's claimed tip BEFORE the gate. A tip the gate
                    // refuses is the evidence the stall detector runs on: without
                    // it a frozen watermark is indistinguishable from a quiet hub.
                    this.noteHubTip(event.ts);
                    this.handleWatermarkFrame(event);
                } else if (event.type === 'row:inserted' || event.type === 'row:deleted' ||
                           event.type === 'row:anchor-stamped') {
                    // Schema fail-closed check, price-event buffering
                    // (#2422), and the apply-and-refresh path all live
                    // in handleRowEvent (extracted for testability).
                    await this.handleRowEvent(event);
                }
            } catch (err) {
                getLogger().warn('HubDbSync: failed to handle WebSocket message:', err);
                // Latch the failure so the watermark gate stays shut. A row we did
                // not apply is a hole, and without the latch a later heartbeat
                // would certify the stream over it. A throw from the heartbeat
                // branch latches too, which is the fail-closed direction: only a
                // clean re-bootstrap drain re-opens the gate.
                this._applyFailureSeen = true;
            }
        });
    },

    // The socket is gone: close every gate that certified delivery on THIS connection,
    // so nothing produced while disconnected can be certified before the reconnect
    // re-bootstrap has drained the gap. The caller settles the connect promise and
    // schedules the reconnect after this.
    resetOnSocketClose() {
        getLogger().info('HubDbSync: WebSocket disconnected, reconnecting in 5s');
        this.stopWatchdog();
        this.ws = null;
        // Rows produced while disconnected won't arrive on the socket;
        // close the heartbeat gate (and freeze the watermark) until the
        // reconnect re-bootstrap has drained the gap.
        this._bootstrapDrained = false;
        this._readyCaughtUp = null;
        this._readyCaughtUpHandled = false;
        // The height watermark dies with the socket for the same reason the heartbeat
        // gate does: it certifies delivery on THIS connection, and rows produced while
        // disconnected have not arrived. A stale map left standing would let a
        // re-keyed barrier open over exactly that gap.
        this.heightWatermarks = {};
        this._readyHeights    = null;
        // Price events buffered for the drain die with the socket: their
        // inserts re-page via the re-bootstrap and their deletions are
        // redelivered by the hub's deferred-retraction path (item 5296).
        // Reset the per-connection price-drain state so live price rows
        // buffer again until the reconnect re-bootstrap drains (#2422),
        // and bump the epoch so a flush racing this close cannot
        // stale-arm _priceDrained for the next connection.
        this._priceDrained = false;
        this._pendingPriceEvents = [];
        this._pendingPriceOverflow = false;
        this._wsEpoch++;
        // Reset the serialization chain so the new connection starts clean
        // rather than waiting on in-flight work from the dead socket.
        this._msgChain = Promise.resolve();
    },

    // Make a JSON GET request to the hub.
    //
    // Every exit runs through one settle latch, because a hub that dies mid-body can
    // fire several terminal events and the deadline below races them all. The local
    // `resolve`/`reject` ARE that latch.
    httpGet(path) {
        return new Promise((settleResolve, settleReject) => {
            let settled = false;
            let resolve = (v) => { if (!settled) { settled = true; settleResolve(v); } };
            let reject  = (e) => { if (!settled) { settled = true; settleReject(e); } };
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
            let apiKey = this.feedApiKey || this.apiKey;
            if (apiKey) opts.headers['x-api-key'] = apiKey;

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
                // A hub restarting mid-snapshot aborts the RESPONSE: 'end' never fires,
                // and req 'error' never fires either because the request itself completed.
                // Without these three the promise stays pending forever, bootstrapAll
                // never reaches the `finally` that clears `_bootstrapping`, and every
                // later reconnect and poll returns at that guard - the mirror bootstrap
                // and the settlement barriers it feeds stall until the process restarts.
                res.on('error',   (err) => { req.destroy(); reject(new Error('hub response error: ' + ((err && err.message) || err))); });
                res.on('aborted', ()    => { req.destroy(); reject(new Error('hub aborted the response before the body was complete')); });
                res.on('close',   ()    => {
                    if (res.complete) return;
                    req.destroy();
                    reject(new Error('hub closed the connection before the response body was complete'));
                });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(new Error('Request timeout')); });
            // The idle-socket timer cannot bound a drip-fed body; see httpDeadlineMs.
            // Unref'd so it never holds the process open, cleared on the request's own
            // teardown so a settled call drops it.
            let deadlineTimer = setTimeout(() => {
                req.destroy();
                reject(new Error('hub request exceeded its ' + this.httpDeadlineMs + 'ms deadline'));
            }, this.httpDeadlineMs);
            if (deadlineTimer.unref) deadlineTimer.unref();
            req.once('close', () => clearTimeout(deadlineTimer));
            req.end();
        });
    },

};

module.exports = { WebSocket, transportMethods };

if (typeof global.describe === 'function' && typeof global.it === 'function') {
    const assert = require('node:' + 'assert');
    const PAGE_LIMIT = 10000;
    function rows(first, count) {
        return Array.from({ length: count }, (_, offset) => ({ id: first + offset }));
    }
    function makeDrain() {
        const HubDbSync = require('../' + 'hub_db_sync.js');
        let applied = 0;
        const sync = new HubDbSync({ doQuery: async () => [] }, {
            hubUrl: 'http://hub.test', coin: 'DOGE', network: 'regtest'
        });
        sync.running = true;
        sync.ws = { terminate() { sync.resetOnSocketClose(); } };
        sync.localColumns = async () => new Set(['id']);
        sync.applyRow = async () => { applied++; return true; };
        sync.applyRowsBatched = async () => false;
        sync.scheduleBootstrapRetry = () => {};
        const bootstrapTable = sync.bootstrapTable.bind(sync);
        sync.bootstrapTable = table => table === 'price_snapshots'
            ? bootstrapTable(table) : Promise.resolve(9000);
        sync._readyMaxIds = { price_snapshots: (PAGE_LIMIT * 3) + 5 };
        return { sync, applied: () => applied };
    }
    function deferPages(sync) {
        const pending = [];
        sync.httpGet = () => new Promise(resolve => pending.push(resolve));
        return pending;
    }
    async function waitForPage(pending, count) {
        while (pending.length < count) await new Promise(resolve => setImmediate(resolve));
    }
    global.describe('HubDbSync progress-aware ceiling windows @regression @tier1', function () {
        global.it('keeps a moving RDOGE drain and replaces a stalled drain', async function () {
            const wallNow = Date.now;
            let now = 1800000000000;
            Date.now = () => now;
            try {
                const moving = makeDrain();
                assert.strictEqual(moving.sync.coin, 'DOGE');
                assert.strictEqual(moving.sync.network, 'regtest');
                const movingPages = deferPages(moving.sync);
                const movingBoot = moving.sync.bootstrapAll();
                await waitForPage(movingPages, 1);
                for (let page = 0; page < 3; page++) {
                    now += moving.sync.barrierHoldCeilingMs - 1;
                    assert.strictEqual(moving.sync.requestResync('barrier still held'), false);
                    movingPages[page]({ rows: rows((page * PAGE_LIMIT) + 1, PAGE_LIMIT), watermark: 7000 + page });
                    await waitForPage(movingPages, page + 2);
                }
                now += moving.sync.barrierHoldCeilingMs - 1;
                assert.strictEqual(moving.sync.requestResync('barrier still held'), false);
                movingPages[3]({ rows: rows((3 * PAGE_LIMIT) + 1, 5), watermark: 7003 });
                await movingBoot;
                assert.strictEqual(moving.sync._wsEpoch, 0);
                assert.strictEqual(moving.sync._bootstrapDrained, true);
                assert.strictEqual(moving.sync.streamWatermark, 7003);
                assert.strictEqual(moving.applied(), (3 * PAGE_LIMIT) + 5);
                assert.strictEqual(movingPages.length, 4);
                assert.strictEqual(moving.sync.forcedResyncCount, 0);

                const stalled = makeDrain();
                const stalledPages = deferPages(stalled.sync);
                const stalledBoot = stalled.sync.bootstrapAll();
                await waitForPage(stalledPages, 1);
                stalledPages[0]({ rows: rows(1, PAGE_LIMIT), watermark: 1 });
                await waitForPage(stalledPages, 2);
                now += stalled.sync.barrierHoldCeilingMs + 1;
                assert.strictEqual(stalled.sync.requestResync('bootstrap stopped'), true);
                assert.strictEqual(stalled.sync._wsEpoch, 1);
                stalledPages[1]({ rows: rows(PAGE_LIMIT + 1, 5), watermark: 2 });
                await stalledBoot;
                assert.strictEqual(stalled.sync._bootstrapDrained, false);
                assert.strictEqual(stalled.sync.forcedResyncCount, 1);
                assert.strictEqual(stalledPages.length, 2);
            } finally {
                Date.now = wallNow;
            }
        });
    });
}
