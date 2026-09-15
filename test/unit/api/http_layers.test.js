/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * The HTTP layers src/api.js mounts off its context: the API-key gate
 * (src/api/auth_gate.js), the middleware stack (src/api/middleware.js) and the
 * GET /status route (src/api/status_endpoint.js). Each is driven through a real
 * Express app on an ephemeral port with the shipped module, not a copy, so the
 * shapes asserted here are the ones production serves. The complete boot,
 * with every layer in the entry's order, is test/security/http-surface/.
 */

'use strict';

const assert  = require('assert');
const express = require('express');
const sinon   = require('sinon');

const observability = require('../../../src/observability/index.js');
const XChainIndexer = require('../../../src/XChainIndexer');
const { keyEquals, apiKeyGate } = require('../../../src/api/auth_gate.js');
const { installMiddleware } = require('../../../src/api/middleware.js');
const { mountStatusRoute } = require('../../../src/api/status_endpoint.js');
const { recordingView, fakeIndexer } = require('./rpc/helpers/fake_indexer.js');

const SETS = {
    WRITE_METHODS: new Set([]),
    GATED_EXEC_METHODS: new Set(['feequotedryrun']),
    FEDERATION_READ_METHODS: new Set(['getactivevalidators'])
};

// Serve `app` on an ephemeral port for the life of one test.
async function serve(app) {
    const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
    const port = server.address().port;
    return {
        async post(body, headers = {}) {
            const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST',
                headers: Object.assign({ 'content-type': 'application/json' }, headers), body: JSON.stringify(body) });
            return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
        },
        async get(path) {
            const res = await fetch(`http://127.0.0.1:${port}${path}`);
            return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
        },
        close: () => new Promise(resolve => server.close(resolve))
    };
}

describe('API-key gate (src/api/auth_gate.js) @regression @tier1', function () {
    it('keyEquals compares in constant time over equal lengths and refuses a length mismatch', function () {
        assert.strictEqual(keyEquals('secret', 'secret'), true);
        assert.strictEqual(keyEquals('secret', 'secreT'), false);
        assert.strictEqual(keyEquals('secret', 'secrets'), false);
        assert.strictEqual(keyEquals(null, ''), true, 'a null provided reads as the empty string');
        assert.strictEqual(keyEquals(undefined, 'x'), false);
    });

    // Drive the shipped gate with fake req/res: `next` records pass-through, the
    // response records the refusal shape.
    function run(gate, body, headers = {}) {
        let passed = false, status = null, payload = null;
        const res = { status(s) { status = s; return this; }, json(p) { payload = p; return this; } };
        gate({ body, headers }, res, () => { passed = true; });
        return { passed, status, payload };
    }

    it('with a key configured, refuses a gated method anywhere in a batch without the key and passes it with', function () {
        const gate = apiKeyGate(Object.assign({ INDEXER_API_KEY: 'k1', ALLOW_UNAUTHED: false }, SETS));
        assert.deepStrictEqual(run(gate, { id: 7, method: 'getactivevalidators' }),
            { passed: false, status: 401, payload: { jsonrpc: '2.0', id: 7, error: { code: -32001, message: 'Unauthorized' } } });
        const smuggled = run(gate, [{ method: 'ping' }, { method: 'FeeQuoteDryRun' }]);
        assert.strictEqual(smuggled.status, 401, 'a gated method inside a batch, in any case, needs the key');
        assert.strictEqual(smuggled.payload.id, null, 'a batch refusal carries a null id');
        assert.strictEqual(run(gate, { method: 'getactivevalidators' }, { 'x-api-key': 'k1' }).passed, true);
        assert.strictEqual(run(gate, { method: 'getactivevalidators' }, { 'x-api-key': 'k2' }).status, 401);
        assert.strictEqual(run(gate, { method: 'ping' }).passed, true, 'an open method never needs the key');
        assert.strictEqual(run(gate, undefined).passed, true, 'a bodiless request is not a gated call');
    });

    it('without a key, fails closed unless the keyless escape hatch is set', function () {
        const closed = apiKeyGate(Object.assign({ INDEXER_API_KEY: '', ALLOW_UNAUTHED: false }, SETS));
        const refused = run(closed, { id: 1, method: 'getactivevalidators' });
        assert.strictEqual(refused.status, 401);
        assert.match(refused.payload.error.message, /requires INDEXER_API_KEY, or set INDEXER_ALLOW_UNAUTHENTICATED=true/);
        assert.strictEqual(run(closed, { method: 'ping' }).passed, true);
        const open = apiKeyGate(Object.assign({ INDEXER_API_KEY: '', ALLOW_UNAUTHED: true }, SETS));
        assert.strictEqual(run(open, [{ method: 'getactivevalidators' }]).passed, true);
    });
});

describe('middleware stack (src/api/middleware.js) @regression @tier1', function () {
    let served;
    // installMiddleware wires the process-wide observability sink, so each case
    // resets it or the next suite in file order inherits this one's sink.
    afterEach(async function () {
        sinon.restore();
        if (served) await served.close();
        served = null;
        observability._resetObservability();
    });

    function appWith(CONFIG_ENV, gate = { INDEXER_API_KEY: 'k1', ALLOW_UNAUTHED: false }) {
        const app = express();
        installMiddleware(app, Object.assign({ indexer: fakeIndexer(), CONFIG_ENV, INDEXER_NETWORK: 'regtest' }, gate, SETS));
        app.post('/', (req, res) => res.json({ echoed: req.body }));
        return app;
    }

    it('mounts helmet, the JSON body parser, CORS from the parsed allowlist and the rate limit headers', async function () {
        served = await serve(appWith({ CORS_ORIGIN: 'https://a.example, https://b.example', INDEXER_RATE_LIMIT_RPM: '5' }));
        const res = await served.post({ method: 'ping' }, { origin: 'https://b.example' });
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(res.body, { echoed: { method: 'ping' } }, 'the JSON body reached the handler parsed');
        assert.strictEqual(res.headers.get('access-control-allow-origin'), 'https://b.example');
        assert.ok(res.headers.get('x-content-type-options'), 'helmet is mounted');
        assert.strictEqual(res.headers.get('ratelimit-limit'), '5');
        assert.strictEqual(res.headers.get('x-ratelimit-limit'), null, 'legacy headers are off');
        const hostile = await served.post({ method: 'ping' }, { origin: 'https://evil.example' });
        assert.strictEqual(hostile.headers.get('access-control-allow-origin'), null, 'an unlisted origin gets no grant');
    });

    it('defaults CORS to localhost and the limit to 600 when unset, and gates AFTER the parse', async function () {
        served = await serve(appWith({}));
        const res = await served.post({ method: 'ping' }, { origin: 'http://localhost' });
        assert.strictEqual(res.headers.get('access-control-allow-origin'), 'http://localhost');
        assert.strictEqual(res.headers.get('ratelimit-limit'), '600');
        const gated = await served.post({ id: 3, method: 'getactivevalidators' });
        assert.strictEqual(gated.status, 401);
        assert.deepStrictEqual(gated.body, { jsonrpc: '2.0', id: 3, error: { code: -32001, message: 'Unauthorized' } });
        const keyed = await served.post({ id: 3, method: 'getactivevalidators' }, { 'x-api-key': 'k1' });
        assert.strictEqual(keyed.status, 200);
    });

    it('leaves /metrics unregistered while METRICS_ENABLED is off', async function () {
        served = await serve(appWith({}));
        assert.strictEqual((await served.get('/metrics')).status, 404);
    });
});

// A status-route indexer double at one tip.
// The decoder tip is a raw-handle read (the decoder DB opens no block transaction).
function indexerAt(view, extra = {}) {
    const indexer = fakeIndexer(Object.assign({
        view, lastDecoderBlock: 118, isSynced: () => false, stallReason: null,
        lastBlockCommittedAt: Date.now(), healthStallGraceMs: 60000, stallClearsAt: null,
        lastHubConfigFetchAt: null, hubDbSync: null
    }, extra));
    indexer.decoderDb.getBlockIndex = async () => 120;
    return indexer;
}

describe('GET /status route (src/api/status_endpoint.js) @regression @tier1', function () {
    let served;
    // installMiddleware wires the process-wide observability sink, so each case
    // resets it or the next suite in file order inherits this one's sink.
    afterEach(async function () {
        sinon.restore();
        if (served) await served.close();
        served = null;
        observability._resetObservability();
    });

    it('answers 200 with the committed height, the in-flight block, the decoder tip and the lag', async function () {
        const indexer = indexerAt(recordingView({ getLatestBlockIndex: 100 }));
        indexer.indexerDb.transactionConnection = {};
        indexer.indexerDb.blockIndex = 101;
        const app = express();
        mountStatusRoute(app, { indexer, XChainIndexer });
        served = await serve(app);
        const res = await served.get('/status');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.indexerBlock, 100);
        assert.strictEqual(res.body.inFlightBlock, 101);
        assert.strictEqual(res.body.decoderBlock, 120);
        assert.strictEqual(res.body.lag, 20);
        assert.strictEqual(res.body.isSynced, false);
        assert.strictEqual(res.body.hubMirror.configured, false);
        // The committed height came off apiView(), never the raw handle.
        assert.deepStrictEqual(indexer.indexerDb.apiView().calls, [['getLatestBlockIndex']]);
    });

    it('answers 503 with a null height when the indexer database is unreachable', async function () {
        const indexer = indexerAt(recordingView({ getLatestBlockIndex: () => { throw new Error('ECONNREFUSED'); } }));
        const app = express();
        mountStatusRoute(app, { indexer, XChainIndexer });
        served = await serve(app);
        const res = await served.get('/status');
        assert.strictEqual(res.status, 503);
        assert.strictEqual(res.body.indexerBlock, null);
        assert.strictEqual(res.body.lag, null);
    });

    it('answers 503 for a WEDGED stall but 200 for a stall still inside its grace window', async function () {
        sinon.stub(observability.getLogger(), 'warn');
        const stalled = indexerAt(recordingView({ getLatestBlockIndex: 100 }),
            { stallReason: 'price barrier', lastBlockCommittedAt: Date.now() - 10, healthStallGraceMs: 60000 });
        let app = express();
        mountStatusRoute(app, { indexer: stalled, XChainIndexer });
        served = await serve(app);
        const grace = await served.get('/status');
        assert.strictEqual(grace.status, 200);
        assert.strictEqual(grace.body.stallReason, 'price barrier');
        await served.close();
        const wedged = indexerAt(recordingView({ getLatestBlockIndex: 100 }),
            { stallReason: 'price barrier', lastBlockCommittedAt: Date.now() - 600000, healthStallGraceMs: 60000 });
        app = express();
        mountStatusRoute(app, { indexer: wedged, XChainIndexer });
        served = await serve(app);
        assert.strictEqual((await served.get('/status')).status, 503);
    });
});
