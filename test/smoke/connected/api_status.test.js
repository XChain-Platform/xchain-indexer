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
 * Smoke test: REST /status endpoint (lag and sync flag)
 *
 * Starts a minimal Express server mounting the same GET /status route as
 * api.js, backed by a stub indexer, then verifies the endpoint reports the
 * indexer tip, decoder tip, computed lag, and sync flag over a plain GET.
 * Does NOT start the indexer loop or connect to any database.
 *
 * Covers: GET /status exposes quantitative indexer→decoder lag
 *
 * The route, the stub-indexer listener and the GET helper live in
 * api_status.test/helpers/status_app.js; the hubMirror cases of the same route
 * run from api_status.test/hub_mirror.test.js.
 */

'use strict';

const assert     = require('assert');
const { getJson, listen } = require('./api_status.test/helpers/status_app.js');

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
// Consecutive sibling blocks under one suite title, each carrying the suite's
// timeout, so every full test title is the one the suite has always reported
// while no describe callback outgrows the structure limit.
describe('Smoke: REST /status', function () {
    this.timeout(5000);

    // -------------------------------------------------------------------------
    // Lag is computable from the public API surface
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
    // Lag is null (not a misleading number) before the first poll cycle
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
});

describe('Smoke: REST /status', function () {
    this.timeout(5000);

    // -------------------------------------------------------------------------
    // Healthcheck status-code contract. The xchain-node
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
            assert.strictEqual(body.stallClass, 'wedged');
            assert.strictEqual(body.waitingOnFutureBlock, false, 'a wedge is not a future-stamp wait');
        } finally {
            server.close();
        }
    });
});

describe('Smoke: REST /status', function () {
    this.timeout(5000);

    it('SM-05e: GET /status stays 200 with degraded:true when stalled but still advancing', async function () {
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
});

describe('Smoke: REST /status', function () {
    this.timeout(5000);

    // -------------------------------------------------------------------------
    // The testnet4 future-stamped-block steady state. A miner
    // stamping each block ~20 min ahead of wall clock pins lag at ~6 blocks
    // indefinitely, so isSynced is false and degraded is true forever on an indexer
    // that is committing every processable block within milliseconds. /status has to
    // say so distinctly or every monitor reads a permanent fault.
    // -------------------------------------------------------------------------
    it('SM-05g: GET /status marks a future-stamped-block wait distinctly and stays 200', async function () {
        const now = Date.now();
        const futureWait = {
            indexerDb: { async getLatestBlockIndex() { return 148642; } },
            lastDecoderBlock: 148648,
            isSynced() { return false; },
            stallReason: 'anchor_attest_barrier',
            healthStallGraceMs: 120000,
            // last commit is well past the grace window, the shape that used to read as a wedge
            lastBlockCommittedAt: now - 900000,
            // the head block is stamped 16 minutes ahead
            stallClearsAt: now + 960000,
        };
        let { server, port } = await listen(futureWait);
        try {
            const { status, body } = await getJson(port, '/status');
            assert.strictEqual(status, 200, `Expected HTTP 200 during a future-stamp wait but got ${status}`);
            assert.strictEqual(body.waitingOnFutureBlock, true, 'the future-stamp wait must be reported distinctly');
            assert.strictEqual(body.stallClass, 'future_block_wait');
            assert.strictEqual(body.atProcessableTip, true, 'every consensus-processable block is committed');
            assert.strictEqual(body.lag, 6, 'lag pins at ~6 blocks in this steady state');
            // isSynced/degraded keep their existing meanings; the new fields are what
            // separate this from a fault.
            assert.strictEqual(body.isSynced, false);
            assert.strictEqual(body.degraded, true);
            assert.strictEqual(body.stallClearsAt, futureWait.stallClearsAt);
        } finally {
            server.close();
        }
    });
});

describe('Smoke: REST /status', function () {
    this.timeout(5000);

    it('SM-05h: a real barrier defer is NOT reported as a future-stamp wait', async function () {
        const now = Date.now();
        const { server, port } = await listen({
            indexerDb: { async getLatestBlockIndex() { return 959283; } },
            lastDecoderBlock: 959284,
            isSynced() { return false; },
            stallReason: 'price_sync_barrier',
            healthStallGraceMs: 120000,
            lastBlockCommittedAt: now - 5000,
            stallClearsAt: null,
        });
        try {
            const { status, body } = await getJson(port, '/status');
            assert.strictEqual(status, 200);
            assert.strictEqual(body.waitingOnFutureBlock, false);
            assert.strictEqual(body.stallClass, 'barrier_defer');
            assert.strictEqual(body.atProcessableTip, false, 'a mirror-lag defer is not "caught up"');
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
