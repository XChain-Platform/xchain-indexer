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
 * HTTP-surface security harness for the indexer's JSON-RPC API.
 *
 * The indexer exposes ONE network surface (src/api.js): an Express app that
 * mounts helmet, a CORS allowlist, a per-IP rate limiter, and an API-key gate
 * in front of the JSON-RPC router. This suite drives that surface end-to-end
 * over a real loopback HTTP socket and asserts its security posture as a
 * common battery from one fixture table: authn/authz enforcement, injection /
 * malformed-input handling, CORS/origin handling, error-leak, and rate limit.
 *
 * Why the middleware is rebuilt here rather than imported: startApi() in
 * src/api.js is not importable — it opens live MariaDB connections and starts
 * the block loop. So, matching the reconstruction pattern already used by
 * test/unit/api-auth-batch.test.js, the security middleware chain is rebuilt
 * from the same pieces the app uses. The CORS leg imports the REAL
 * src/corsOrigin.js (parseCorsOrigin), so a regression in that module fails
 * this suite. The auth gate mirrors the guard in src/api.js and MUST be kept
 * in sync with it; the method sets below are an exact copy of that guard's.
 *
 *********************************************************************/

'use strict';

const assert  = require('assert');
const http    = require('http');
const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');
const rateLimit = require('express-rate-limit');
const crypto  = require('crypto');

// REAL source under test for the CORS leg.
const { parseCorsOrigin } = require('../../src/corsOrigin.js');

// ---- Exact copy of the gated-method sets in src/api.js (keep in sync). ------
const WRITE_METHODS = new Set(['pushvalidatorrewards']);
const GATED_EXEC_METHODS = new Set(['feequotedryrun']);
const FEDERATION_READ_METHODS = new Set([
    'getownstake', 'getactivevalidators', 'getactivestakeweights',
    'getcapabilityvalidators', 'getstakeweightsbycapability',
    'getstakesourcebypubkey', 'getfullnodeverifiers',
    'getpendingattestation_requests', 'getopencrosschainorders',
    'getactionconfirmations', 'getpendingcrosschaincalls',
    'getcrosschaincall', 'getcrosschaincallresult'
]);

// Constant-time key comparison, mirroring keyEquals in src/api.js: a plain
// `!==` short-circuits on the first mismatched byte and leaks the guarded key
// through response timing. Length is guarded first (timingSafeEqual needs
// equal-length buffers, and a length mismatch is not itself the secret).
function keyEquals(provided, expected) {
    const a = Buffer.from(String(provided == null ? '' : provided));
    const b = Buffer.from(String(expected == null ? '' : expected));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

// The API-key gate, mirroring the guard in src/api.js: the key is required
// when ANY element of a (possibly batched) JSON-RPC body invokes a gated
// method. Fails closed when no key is configured unless the explicit
// keyless escape hatch is set.
function makeGuard({ apiKey, allowUnauthed }) {
    return function (req, res, next) {
        const calls = Array.isArray(req.body) ? req.body : [req.body];
        const id = (Array.isArray(req.body) ? null : (req.body && req.body.id)) || null;
        const gated = calls.some((call) => {
            const method = call && call.method;
            const normalized = method ? String(method).toLowerCase() : '';
            return method && (WRITE_METHODS.has(normalized)
                || FEDERATION_READ_METHODS.has(normalized)
                || GATED_EXEC_METHODS.has(normalized));
        });
        if (gated) {
            if (apiKey) {
                const provided = req.headers['x-api-key'] || '';
                if (!keyEquals(provided, apiKey)) {
                    return res.status(401).json({ jsonrpc: '2.0', id, error: { code: -32001, message: 'Unauthorized' } });
                }
            } else if (!allowUnauthed) {
                return res.status(401).json({ jsonrpc: '2.0', id, error: { code: -32001, message: 'Unauthorized' } });
            }
        }
        return next();
    };
}

// Build the indexer's HTTP security chain in front of a trivial JSON-RPC
// handler. Mirrors the mount order in src/api.js: helmet -> body parse ->
// cors -> rate limit -> auth gate -> router.
function buildApp({ apiKey = '', allowUnauthed = false, corsOrigin, rateLimitMax } = {}) {
    const app = express();
    app.use(helmet());
    app.use(express.json());
    app.use(cors({ origin: parseCorsOrigin(corsOrigin == null ? 'http://localhost' : corsOrigin), methods: ['POST'] }));
    if (rateLimitMax != null) {
        app.use(rateLimit({ windowMs: 60 * 1000, limit: rateLimitMax, standardHeaders: true, legacyHeaders: false }));
    }
    app.use(makeGuard({ apiKey, allowUnauthed }));
    // Trivial stand-in for the JSON-RPC router: anything that clears the gate
    // gets a success envelope. The suite asserts on the perimeter, not on the
    // handler's semantics.
    app.post('/', (req, res) => {
        const id = (Array.isArray(req.body) ? null : (req.body && req.body.id)) || null;
        res.json({ jsonrpc: '2.0', id, result: { status: 'success' } });
    });
    app.get('/status', (req, res) => res.json({ status: 'ok' }));
    return app;
}

function listen(app) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, '127.0.0.1');
        server.once('listening', () => resolve(server));
        server.once('error', reject);
    });
}

function close(server) {
    return new Promise((resolve) => server.close(() => resolve()));
}

// One request over a real loopback socket. Resolves { status, headers, json, raw }.
function request(server, { method = 'POST', path = '/', headers = {}, body, origin } = {}) {
    return new Promise((resolve, reject) => {
        const { port } = server.address();
        const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
        const h = Object.assign({}, headers);
        if (origin) h.Origin = origin;
        if (payload) {
            h['content-type'] = 'application/json';
            h['content-length'] = String(payload.length);
        }
        const req = http.request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                let json = null;
                try { json = data ? JSON.parse(data) : null; } catch { json = null; }
                resolve({ status: res.statusCode, headers: res.headers, json, raw: data });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

// The good key used across authz cases, and a decoy of equal length so the
// wrong-key case exercises the byte comparison rather than a length reject.
const GOOD_KEY = 'a'.repeat(32);
const WRONG_KEY = 'b'.repeat(32);

describe('HTTP-surface security: JSON-RPC API perimeter', function () {
    // Per-test server registry with reset hooks (no shared mutable state
    // leaks across cases; every server this test opened is closed after it).
    let servers;
    beforeEach(function () { servers = []; });
    afterEach(async function () {
        await Promise.all(servers.map(close));
        servers = [];
    });
    async function start(config) {
        const server = await listen(buildApp(config));
        servers.push(server);
        return server;
    }

    describe('authn / authz enforcement (fixture battery)', function () {
        // Each row is a bypass attempt or an allowed call, driven through the
        // same gate. `expect` is the HTTP status the perimeter must return.
        const CASES = [
            {
                name: 'an ungated read (ping) passes without a key even when one is configured',
                config: { apiKey: GOOD_KEY },
                req: { body: { jsonrpc: '2.0', id: 1, method: 'ping' } },
                expect: 200,
            },
            {
                name: 'a write method (pushvalidatorrewards) is rejected 401 with no key presented',
                config: { apiKey: GOOD_KEY },
                req: { body: { jsonrpc: '2.0', id: 2, method: 'pushvalidatorrewards' } },
                expect: 401,
            },
            {
                name: 'a write method is accepted with the correct x-api-key',
                config: { apiKey: GOOD_KEY },
                req: { headers: { 'x-api-key': GOOD_KEY }, body: { jsonrpc: '2.0', id: 3, method: 'pushvalidatorrewards' } },
                expect: 200,
            },
            {
                name: 'a write method is rejected 401 with a wrong (equal-length) key',
                config: { apiKey: GOOD_KEY },
                req: { headers: { 'x-api-key': WRONG_KEY }, body: { jsonrpc: '2.0', id: 4, method: 'pushvalidatorrewards' } },
                expect: 401,
            },
            {
                name: 'a federation read (getownstake) is rejected 401 with no key',
                config: { apiKey: GOOD_KEY },
                req: { body: { jsonrpc: '2.0', id: 5, method: 'getownstake' } },
                expect: 401,
            },
            {
                name: 'a gated exec (feequotedryrun) is rejected 401 with no key',
                config: { apiKey: GOOD_KEY },
                req: { body: { jsonrpc: '2.0', id: 6, method: 'feequotedryrun' } },
                expect: 401,
            },
            {
                name: 'a one-element batch invoking a gated method cannot bypass the gate (array-body regression)',
                config: { apiKey: GOOD_KEY },
                req: { body: [{ jsonrpc: '2.0', id: 7, method: 'pushvalidatorrewards' }] },
                expect: 401,
            },
            {
                name: 'a gated method smuggled behind an ungated one in a batch still requires the key',
                config: { apiKey: GOOD_KEY },
                req: { body: [{ method: 'ping' }, { method: 'pushvalidatorrewards' }] },
                expect: 401,
            },
            {
                name: 'method-name casing does not evade the gate (PushValidatorRewards)',
                config: { apiKey: GOOD_KEY },
                req: { body: { jsonrpc: '2.0', id: 8, method: 'PushValidatorRewards' } },
                expect: 401,
            },
            {
                name: 'an SQL-injection-shaped key does not authenticate against the real key',
                config: { apiKey: GOOD_KEY },
                req: { headers: { 'x-api-key': "' OR '1'='1" }, body: { jsonrpc: '2.0', id: 9, method: 'pushvalidatorrewards' } },
                expect: 401,
            },
            {
                name: 'with no key configured the gate fails closed on a gated method (401)',
                config: { apiKey: '', allowUnauthed: false },
                req: { body: { jsonrpc: '2.0', id: 10, method: 'pushvalidatorrewards' } },
                expect: 401,
            },
            {
                name: 'the explicit keyless escape hatch (allowUnauthed) restores pass-through',
                config: { apiKey: '', allowUnauthed: true },
                req: { body: { jsonrpc: '2.0', id: 11, method: 'pushvalidatorrewards' } },
                expect: 200,
            },
        ];

        for (const c of CASES) {
            it(c.name, async function () {
                const server = await start(c.config);
                const res = await request(server, c.req);
                assert.strictEqual(res.status, c.expect, `expected ${c.expect}, got ${res.status} (${res.raw})`);
            });
        }
    });

    describe('error-leak: rejection bodies expose no internals', function () {
        it('a 401 body is the JSON-RPC error envelope and carries no stack frame or filesystem path', async function () {
            const server = await start({ apiKey: GOOD_KEY });
            const res = await request(server, { body: { jsonrpc: '2.0', id: 1, method: 'pushvalidatorrewards' } });
            assert.strictEqual(res.status, 401);
            assert.strictEqual(res.json && res.json.error && res.json.error.code, -32001);
            assert.ok(res.json.error.message, 'error message present');
            assert.ok(!/\bat\s+.*\(?\/.+:\d+:\d+/.test(res.raw), 'response leaks a stack frame');
            assert.ok(!/\/home\/|\/src\/|node_modules/.test(res.raw), 'response leaks a filesystem path');
        });

        it('helmet strips the framework fingerprint (no x-powered-by) from a rejection', async function () {
            const server = await start({ apiKey: GOOD_KEY });
            const res = await request(server, { body: { jsonrpc: '2.0', id: 1, method: 'getownstake' } });
            assert.strictEqual(res.status, 401);
            assert.strictEqual(res.headers['x-powered-by'], undefined);
        });
    });

    describe('CORS / origin handling (drives the real parseCorsOrigin)', function () {
        const ALLOW = 'https://explorer.example,https://wallet.example';

        it('echoes an allowlisted origin back to itself, never the raw list', async function () {
            const server = await start({ corsOrigin: ALLOW });
            const res = await request(server, { origin: 'https://explorer.example', body: { method: 'ping' } });
            assert.strictEqual(res.headers['access-control-allow-origin'], 'https://explorer.example');
        });

        it('does not grant an unlisted origin', async function () {
            const server = await start({ corsOrigin: ALLOW });
            const res = await request(server, { origin: 'https://evil.example', body: { method: 'ping' } });
            assert.notStrictEqual(res.headers['access-control-allow-origin'], 'https://evil.example');
            assert.notStrictEqual(res.headers['access-control-allow-origin'], ALLOW);
        });

        it('a `*` mixed with real origins fails closed (never grants the hostile origin)', async function () {
            const server = await start({ corsOrigin: '*,https://explorer.example' });
            const res = await request(server, { origin: 'https://evil.example', body: { method: 'ping' } });
            assert.notStrictEqual(res.headers['access-control-allow-origin'], '*');
            assert.notStrictEqual(res.headers['access-control-allow-origin'], 'https://evil.example');
        });
    });

    describe('rate limiting', function () {
        it('rejects requests past the per-window limit with 429 and advertises the limit header', async function () {
            const server = await start({ rateLimitMax: 2 });
            const first = await request(server, { method: 'GET', path: '/status' });
            const second = await request(server, { method: 'GET', path: '/status' });
            const third = await request(server, { method: 'GET', path: '/status' });
            assert.strictEqual(first.status, 200);
            assert.strictEqual(second.status, 200);
            assert.strictEqual(third.status, 429, `third request should be limited, got ${third.status}`);
            assert.ok(first.headers['ratelimit-limit'], 'standard RateLimit-Limit header present');
        });
    });

    describe('input validation: gated-method payloads cannot smuggle past the gate', function () {
        it('an injection-shaped params payload on a gated method is still rejected 401 without the key', async function () {
            const server = await start({ apiKey: GOOD_KEY });
            const res = await request(server, {
                body: {
                    jsonrpc: '2.0', id: 1, method: 'pushvalidatorrewards',
                    params: { address: "'; DROP TABLE validator_rewards;--", amount: { $ne: null } },
                },
            });
            assert.strictEqual(res.status, 401, 'params must never carry authorization; the method alone gates');
        });

        it('a non-string method value does not crash the gate and is treated as non-gated', async function () {
            const server = await start({ apiKey: GOOD_KEY });
            const res = await request(server, { body: { jsonrpc: '2.0', id: 2, method: 12345 } });
            assert.strictEqual(res.status, 200, 'a non-gated (non-string) method clears without a 5xx');
        });
    });
});
