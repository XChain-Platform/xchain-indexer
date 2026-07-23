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
 * Smoke test: REST /status endpoint (SM-05)
 *
 * Starts a minimal Express server mounting the same GET /status route as
 * api.js, backed by a stub indexer, then verifies the endpoint reports the
 * indexer tip, decoder tip, computed lag, and sync flag over a plain GET.
 * Does NOT start the indexer loop or connect to any database.
 *
 * SM-05: GET /status exposes quantitative indexer→decoder lag
 */

'use strict';

const assert     = require('assert');
const http       = require('http');
const express    = require('express');
const helmet     = require('helmet');

// Standalone copy of src/XChainIndexer.js stallWedged (the smoke harness deliberately
// reconstructs the route rather than importing the module, which pulls in native DB
// deps). The canonical function is unit-tested in test/unit/stall-health.test.js.
function stallWedged(stallReason, lastBlockCommittedAt, graceMs, now){
    if(!stallReason) return false;
    if(lastBlockCommittedAt == null) return false;
    return (now - lastBlockCommittedAt) > graceMs;
}

function getJson(port, path) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path,
            method: 'GET',
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end',  () => {
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(data) });
                } catch (e) {
                    reject(new Error('Failed to parse response JSON: ' + data));
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

// Build an app mounting the same /status handler as src/api.js against the
// supplied stub indexer. Mirrors the api.js route logic (the smoke harness
// reconstructs the route rather than importing api.js, which auto-starts).
function buildApp(indexer) {
    const app = express();
    app.use(helmet());
    app.get('/status', async (req, res) => {
        let indexerBlock = null;
        let indexerDbUnreachable = false;
        try {
            if(indexer.indexerDb)
                indexerBlock = await indexer.indexerDb.getLatestBlockIndex();
        } catch (err) {
            // Database unreachable; leave indexerBlock null so lag stays null.
            indexerDbUnreachable = true;
        }
        let decoderBlock = (indexer.lastDecoderBlock != null) ? Number(indexer.lastDecoderBlock) : null;
        // Same status-code contract as api.js: 503 on DB-unreachable/wedge so the
        // http_get container healthcheck can observe unhealthy; a not-synced catch-up
        // AND a stalled-but-still-advancing barrier defer (degraded) both stay 200 .
        let stalled   = !!indexer.stallReason;
        let wedged    = stallWedged(indexer.stallReason, indexer.lastBlockCommittedAt,
                                    indexer.healthStallGraceMs, Date.now());
        let unhealthy = indexerDbUnreachable || wedged;
        res.status(unhealthy ? 503 : 200).json({
            indexerBlock: indexerBlock,
            decoderBlock: decoderBlock,
            lag:          (decoderBlock != null && indexerBlock != null)
                            ? decoderBlock - indexerBlock
                            : null,
            isSynced:     indexer.isSynced(),
            stallReason:  indexer.stallReason || null,
            degraded:     stalled && !wedged,
            lastBlockCommittedAt: indexer.lastBlockCommittedAt || null
        });
    });
    return app;
}

describe('Smoke: REST /status', function () {
    this.timeout(5000);

    function listen(indexer) {
        return new Promise((resolve) => {
            const server = buildApp(indexer).listen(0, '127.0.0.1', () => {
                resolve({ server, port: server.address().port });
            });
        });
    }

    // -------------------------------------------------------------------------
    // SM-05: lag is computable from the public API surface
    // -------------------------------------------------------------------------
    it('SM-05: GET /status reports indexer/decoder tips, lag, and sync flag', async function () {
        const indexer = {
            indexerDb: { async getLatestBlockIndex() { return 120000; } },
            lastDecoderBlock: 120500,
            isSynced() { return false; },
        };
        const { server, port } = await listen(indexer);
        try {
            const { status, body } = await getJson(port, '/status');
            assert.strictEqual(status, 200, `Expected HTTP 200 but got ${status}`);
            assert.strictEqual(body.indexerBlock, 120000, `Expected indexerBlock 120000; got ${JSON.stringify(body)}`);
            assert.strictEqual(body.decoderBlock, 120500, `Expected decoderBlock 120500; got ${JSON.stringify(body)}`);
            assert.strictEqual(body.lag, 500, `Expected lag 500 (decoder − indexer); got ${JSON.stringify(body)}`);
            assert.strictEqual(body.isSynced, false, `Expected isSynced false; got ${JSON.stringify(body)}`);
        } finally {
            server.close();
        }
    });

    // -------------------------------------------------------------------------
    // SM-05b: lag is null (not a misleading number) before the first poll cycle
    // populates lastDecoderBlock
    // -------------------------------------------------------------------------
    it('SM-05b: GET /status reports null lag when the decoder tip is unknown', async function () {
        const indexer = {
            indexerDb: { async getLatestBlockIndex() { return 0; } },
            lastDecoderBlock: null,
            isSynced() { return false; },
        };
        const { server, port } = await listen(indexer);
        try {
            const { status, body } = await getJson(port, '/status');
            assert.strictEqual(status, 200, `Expected HTTP 200 but got ${status}`);
            assert.strictEqual(body.decoderBlock, null, `Expected decoderBlock null; got ${JSON.stringify(body)}`);
            assert.strictEqual(body.lag, null, `Expected lag null when decoder tip unknown; got ${JSON.stringify(body)}`);
        } finally {
            server.close();
        }
    });

    // -------------------------------------------------------------------------
    // SM-05c/d: healthcheck status-code contract (). The xchain-node
    // http_get probe (wget, exit 0 on any 2xx) relies on /status returning a
    // non-200 when the indexer cannot serve: DB unreachable or stalled -> 503;
    // a healthy initial catch-up (isSynced false) must stay 200.
    // -------------------------------------------------------------------------
    it('SM-05c: GET /status returns 503 when the indexer DB is unreachable', async function () {
        const indexer = {
            indexerDb: { async getLatestBlockIndex() { throw new Error('conn refused'); } },
            lastDecoderBlock: 120500,
            isSynced() { return true; },
        };
        const { server, port } = await listen(indexer);
        try {
            const { status, body } = await getJson(port, '/status');
            assert.strictEqual(status, 503, `Expected HTTP 503 on DB-unreachable but got ${status}`);
            assert.strictEqual(body.indexerBlock, null);
        } finally {
            server.close();
        }
    });

    it('SM-05d: GET /status returns 503 only on a WEDGED stall (no advance in the grace window)', async function () {
        // A set stallReason with no committed block inside the grace window is a genuine
        // wedge -> 503. lastBlockCommittedAt is 10 min stale against a 2 min grace.
        const wedged = {
            indexerDb: { async getLatestBlockIndex() { return 120000; } },
            lastDecoderBlock: 120500,
            isSynced() { return false; },
            stallReason: 'hub-sync barrier timeout',
            healthStallGraceMs: 120000,
            lastBlockCommittedAt: Date.now() - 600000,
        };
        let { server, port } = await listen(wedged);
        try {
            const { status, body } = await getJson(port, '/status');
            assert.strictEqual(status, 503, `Expected HTTP 503 when wedged but got ${status}`);
            assert.strictEqual(body.stallReason, 'hub-sync barrier timeout');
            assert.strictEqual(body.degraded, false, 'a wedge is not degraded');
        } finally {
            server.close();
        }
    });

    it('SM-05e: GET /status stays 200 with degraded:true when stalled but still advancing ', async function () {
        // The BTC-mainnet steady state: the price-sync barrier is deferring the newest block
        // (stallReason set) but a block committed seconds ago, so the counter is advancing.
        const degraded = {
            indexerDb: { async getLatestBlockIndex() { return 959283; } },
            lastDecoderBlock: 959284,
            isSynced() { return false; },
            stallReason: 'price_sync_barrier',
            healthStallGraceMs: 120000,
            lastBlockCommittedAt: Date.now() - 5000,
        };
        let { server, port } = await listen(degraded);
        try {
            const { status, body } = await getJson(port, '/status');
            assert.strictEqual(status, 200, `Expected HTTP 200 while advancing-but-barrier-deferring but got ${status}`);
            assert.strictEqual(body.degraded, true, 'a barrier defer over an advancing counter is degraded');
            assert.strictEqual(body.stallReason, 'price_sync_barrier');
        } finally {
            server.close();
        }
    });

    it('SM-05f: GET /status stays 200 during plain catch-up (no stall)', async function () {
        const { server, port } = await listen({
            indexerDb: { async getLatestBlockIndex() { return 100; } },
            lastDecoderBlock: 120500,
            isSynced() { return false; },
        });
        try {
            const { status, body } = await getJson(port, '/status');
            assert.strictEqual(status, 200, `Expected HTTP 200 during catch-up but got ${status}`);
            assert.strictEqual(body.degraded, false, 'a plain catch-up is not degraded');
        } finally {
            server.close();
        }
    });
});
