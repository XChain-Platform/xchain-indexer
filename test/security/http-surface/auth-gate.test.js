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
 * Root http-surface security suite: the REAL middleware stack of src/api.js,
 * booted and driven over HTTP.
 *
 * What makes this suite different from test/unit/api-auth-batch.test.js is the
 * subject. That file re-declares the gate (its own WRITE_METHODS /
 * FEDERATION_READ_METHODS sets and a plain `!==` key compare) and drives the
 * copy, so it asserts nothing about the shipped code and has already drifted
 * from it: the shipped FEDERATION_READ_METHODS set grew three entries
 * (getrelayedattestation_requests, getanchoraction, getreorghistory) and the
 * shipped compare became the constant-time keyEquals, and the mirror caught
 * neither. This suite imports src/api.js itself, so drift is impossible by
 * construction.
 *
 * src/api.js self-starts (it calls startApi() at load, exits on missing env,
 * and never exports the app), which is why every earlier attempt mirrored it.
 * The boot harness below defeats that without touching production code: a
 * Module._load hook swaps THREE modules and nothing else -
 *   - `dotenv`          -> a no-op, so the suite never reads the operator's
 *                          real .env and can assert the unset-key case
 *   - `./XChainIndexer` -> a stub, so no database connection is opened
 *   - `express`         -> the real express, wrapped only to capture the app
 *                          and the server handle app.listen() otherwise drops
 * Everything under test - helmet, cors, express-rate-limit, the API-key gate,
 * the JSON-RPC router - is the shipped code, unmocked. INDEXER_API_PORT=0 gives
 * each boot an ephemeral port, so the suite is safe to run concurrently.
 *
 * Layer coverage: auth-gate fail-closed, batch smuggling, rate-limit 429 and
 * helmet headers. The cors layer is covered by test/unit/corsOrigin.test.js,
 * which drives the real middleware the same way, and is not duplicated here.
 *
 *********************************************************************/

'use strict'

const assert = require('assert')
const path   = require('path')
const Module = require('module')

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const API_PATH  = path.join(REPO_ROOT, 'src', 'api.js')

// api.js exits at load unless every database variable is present. They are
// placeholders: XChainIndexer is stubbed, so nothing ever dials them.
const DB_ENV = [
    'DECODER_DB_HOST', 'DECODER_DB_PORT', 'DECODER_DB_NAME', 'DECODER_DB_USER', 'DECODER_DB_PASS',
    'INDEXER_DB_HOST', 'INDEXER_DB_PORT', 'INDEXER_DB_NAME', 'INDEXER_DB_USER', 'INDEXER_DB_PASS'
]

// Every env var a boot may set, so each boot starts from a known state rather
// than inheriting the previous scenario's key.
const OWNED_ENV = DB_ENV.concat([
    'INDEXER_API_PORT', 'INDEXER_API_KEY', 'INDEXER_ALLOW_UNAUTHENTICATED',
    'INDEXER_RATE_LIMIT_RPM', 'CORS_ORIGIN', 'INDEXER_NETWORK', 'METRICS_ENABLED'
])

// This file runs inside the same mocha process as the rest of the unit tier, so
// a boot's env writes would otherwise outlive it and reach whatever runs next.
const ENV_BEFORE = OWNED_ENV.map(key => [key, process.env[key]])
function restoreEnv () {
    for (const [key, value] of ENV_BEFORE) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    }
}

// Stands in for the live indexer. startApi() constructs one and calls start();
// the security layers all sit in front of the router, so the pending promise
// keeps the fake "running" for the life of the boot without any I/O.
class StubIndexer {
    constructor () { this.indexerDb = null; this.lastBlockCommittedAt = null }
    async start () { return new Promise(() => {}) }
}

const realExpress = require('express')
const originalLoad = Module._load
let captured = null

// Installed once for the whole file and removed in the root after(); scoping it
// per boot would leave the hook live across the awaited listen callback.
function installHook () {
    Module._load = function (request, parent, isMain) {
        if (request === 'dotenv') return { config () { return { parsed: {} } } }
        if (request === './XChainIndexer') return StubIndexer
        if (request === 'express') {
            const wrapped = function (...args) {
                const app = realExpress(...args)
                const listen = app.listen.bind(app)
                app.listen = (...listenArgs) => {
                    const server = listen(...listenArgs)
                    if (captured) captured.server = server
                    return server
                }
                return app
            }
            // express carries statics (Router, json, static, ...) that api.js and
            // its middleware reach for; the wrapper must keep them.
            Object.assign(wrapped, realExpress)
            return wrapped
        }
        return originalLoad.apply(this, arguments)
    }
}

/**
 * Boot the real API on an ephemeral port under the given environment.
 *
 * The gate's key and escape hatch are module-level consts in api.js, read once
 * at evaluation, so a scenario that changes them must re-evaluate the module:
 * the cache entry is dropped before every boot.
 */
async function bootApi (env = {}) {
    for (const key of OWNED_ENV) delete process.env[key]
    for (const key of DB_ENV) process.env[key] = 'unused-by-this-suite'
    process.env.INDEXER_API_PORT = '0'
    for (const [key, value] of Object.entries(env)) process.env[key] = value

    captured = {}
    delete require.cache[require.resolve(API_PATH)]
    require(API_PATH)

    const deadline = Date.now() + 4000
    while (!captured.server) {
        if (Date.now() > deadline) throw new Error('api.js did not listen within 4s')
        await new Promise(resolve => setTimeout(resolve, 5))
    }

    const server = captured.server
    const port = server.address().port
    return {
        port,
        async post (body, headers = {}) {
            const res = await fetch(`http://127.0.0.1:${port}/`, {
                method: 'POST',
                headers: Object.assign({ 'content-type': 'application/json' }, headers),
                body: JSON.stringify(body)
            })
            const text = await res.text()
            let json = null
            try { json = JSON.parse(text) } catch { /* non-JSON body is itself the assertion subject */ }
            return { status: res.status, headers: res.headers, body: json, text }
        },
        close () { return new Promise(resolve => server.close(resolve)) }
    }
}

// Undo everything a boot changed outside this file: the module hook, the env,
// and the cached api.js evaluation (which holds the stubbed indexer).
function teardownHarness () {
    Module._load = originalLoad
    restoreEnv()
    captured = null
    delete require.cache[require.resolve(API_PATH)]
}

// A representative from each gated set, so a set that loses its gating is
// caught rather than only the write path.
const GATED_WRITE      = 'pushvalidatorrewards'
const GATED_FEDERATION = 'getactivevalidators'
const GATED_EXEC       = 'feequotedryrun'
const PUBLIC_METHOD    = 'ping'

const KEY = 'harness-api-key'

// Unauthorized is the JSON-RPC -32001 error AND no dispatch: the gate returns
// before next(), so a rejected call must carry no `result` at all.
function assertUnauthorized (res) {
    assert.strictEqual(res.status, 401, `expected 401, got ${res.status}: ${res.text}`)
    assert.ok(res.body && res.body.error, `expected a JSON-RPC error body, got ${res.text}`)
    assert.strictEqual(res.body.error.code, -32001)
    assert.strictEqual(res.body.result, undefined, 'a rejected call must never reach the handler')
}

// Passing the gate is asserted as "not the gate's rejection", never as a
// specific payload: past the gate the call reaches the real handler, whose
// answer depends on parameters and DB state this suite deliberately has none of.
function assertPassedGate (res) {
    assert.strictEqual(res.status, 200, `expected the gate to pass the call, got ${res.status}: ${res.text}`)
    const code = res.body && res.body.error && res.body.error.code
    assert.notStrictEqual(code, -32001, `call was rejected by the auth gate: ${res.text}`)
}

describe('indexer http-surface security: API-key gate on the real app', function () {

    before(installHook)
    after(teardownHarness)

    describe('with INDEXER_API_KEY configured', function () {
        let api
        before(async function () { api = await bootApi({ INDEXER_API_KEY: KEY }) })
        after(async function () { if (api) await api.close() })

        it('rejects a write method sent with no key', async function () {
            assertUnauthorized(await api.post({ jsonrpc: '2.0', method: GATED_WRITE, id: 1 }))
        })

        it('rejects a federation read sent with no key', async function () {
            assertUnauthorized(await api.post({ jsonrpc: '2.0', method: GATED_FEDERATION, id: 2 }))
        })

        it('rejects a gated exec method sent with no key', async function () {
            assertUnauthorized(await api.post({ jsonrpc: '2.0', method: GATED_EXEC, id: 3 }))
        })

        it('rejects a wrong key', async function () {
            assertUnauthorized(await api.post({ jsonrpc: '2.0', method: GATED_WRITE, id: 4 }, { 'x-api-key': 'not-the-key' }))
        })

        it('rejects a key that is a prefix of the real one', async function () {
            assertUnauthorized(await api.post({ jsonrpc: '2.0', method: GATED_WRITE, id: 5 }, { 'x-api-key': KEY.slice(0, -1) }))
        })

        it('passes a write method carrying the correct key', async function () {
            assertPassedGate(await api.post({ jsonrpc: '2.0', method: GATED_WRITE, id: 6 }, { 'x-api-key': KEY }))
        })

        it('passes a federation read carrying the correct key', async function () {
            assertPassedGate(await api.post({ jsonrpc: '2.0', method: GATED_FEDERATION, id: 7 }, { 'x-api-key': KEY }))
        })

        it('leaves a public method ungated', async function () {
            const res = await api.post({ jsonrpc: '2.0', method: PUBLIC_METHOD, id: 8 })
            assert.strictEqual(res.status, 200)
            assert.deepStrictEqual(res.body.result, { status: 'success' })
        })

        it('matches the gated method name case-insensitively', async function () {
            assertUnauthorized(await api.post({ jsonrpc: '2.0', method: GATED_WRITE.toUpperCase(), id: 9 }))
        })

        // The regression this whole gate was rewritten for: express-json-rpc-router
        // dispatches every element of an array body, so reading req.body.method
        // (undefined for an array) let a one-element batch forge spendable
        // validator_rewards rows unauthenticated.
        it('rejects a gated call smuggled inside a one-element batch', async function () {
            assertUnauthorized(await api.post([{ jsonrpc: '2.0', method: GATED_WRITE, id: 10 }]))
        })

        it('rejects a gated call mixed into a batch of public calls', async function () {
            assertUnauthorized(await api.post([
                { jsonrpc: '2.0', method: PUBLIC_METHOD, id: 11 },
                { jsonrpc: '2.0', method: GATED_FEDERATION, id: 12 }
            ]))
        })

        it('passes a gated batch carrying the correct key', async function () {
            const res = await api.post([{ jsonrpc: '2.0', method: GATED_WRITE, id: 13 }], { 'x-api-key': KEY })
            assert.strictEqual(res.status, 200)
            assert.ok(!res.text.includes('-32001'), `batch was rejected by the auth gate: ${res.text}`)
        })

        it('leaves a public-only batch ungated', async function () {
            const res = await api.post([{ jsonrpc: '2.0', method: PUBLIC_METHOD, id: 14 }])
            assert.strictEqual(res.status, 200)
            assert.ok(!res.text.includes('-32001'), res.text)
        })
    })

    // The property that keeps a keyless deployment from being an open reward
    // mint: absence of configuration denies, it does not allow.
    describe('with no key configured and no escape hatch (fail closed)', function () {
        let api
        before(async function () { api = await bootApi({}) })
        after(async function () { if (api) await api.close() })

        it('rejects a write method', async function () {
            assertUnauthorized(await api.post({ jsonrpc: '2.0', method: GATED_WRITE, id: 1 }))
        })

        it('rejects a gated exec method', async function () {
            assertUnauthorized(await api.post({ jsonrpc: '2.0', method: GATED_EXEC, id: 2 }))
        })

        it('rejects a gated batch', async function () {
            assertUnauthorized(await api.post([{ jsonrpc: '2.0', method: GATED_FEDERATION, id: 3 }]))
        })

        it('names the escape hatch in the rejection so an operator can act on it', async function () {
            const res = await api.post({ jsonrpc: '2.0', method: GATED_WRITE, id: 4 })
            assert.match(res.body.error.message, /INDEXER_ALLOW_UNAUTHENTICATED/)
        })

        it('still serves public methods', async function () {
            const res = await api.post({ jsonrpc: '2.0', method: PUBLIC_METHOD, id: 5 })
            assert.deepStrictEqual(res.body.result, { status: 'success' })
        })
    })

    describe('with INDEXER_ALLOW_UNAUTHENTICATED=true (keyless regtest)', function () {
        let api
        before(async function () { api = await bootApi({ INDEXER_ALLOW_UNAUTHENTICATED: 'true' }) })
        after(async function () { if (api) await api.close() })

        it('passes a keyless write method', async function () {
            assertPassedGate(await api.post({ jsonrpc: '2.0', method: GATED_WRITE, id: 1 }))
        })

        it('passes a keyless gated batch', async function () {
            const res = await api.post([{ jsonrpc: '2.0', method: GATED_FEDERATION, id: 2 }])
            assert.strictEqual(res.status, 200)
            assert.ok(!res.text.includes('-32001'), res.text)
        })
    })

    // Only 'true' opens the hatch: a truthy-looking value must still fail closed,
    // since the check is a string comparison an operator can easily miss.
    describe('with INDEXER_ALLOW_UNAUTHENTICATED=1 (not the literal true)', function () {
        let api
        before(async function () { api = await bootApi({ INDEXER_ALLOW_UNAUTHENTICATED: '1' }) })
        after(async function () { if (api) await api.close() })

        it('still fails closed', async function () {
            assertUnauthorized(await api.post({ jsonrpc: '2.0', method: GATED_WRITE, id: 1 }))
        })
    })
})

describe('indexer http-surface security: rate limit and response headers', function () {

    before(installHook)
    after(teardownHarness)

    // A tiny window budget so the 429 is reached in four requests rather than
    // the 600-per-minute default.
    describe('per-IP rate limit', function () {
        let api
        before(async function () { api = await bootApi({ INDEXER_RATE_LIMIT_RPM: '3' }) })
        after(async function () { if (api) await api.close() })

        it('429s once the per-window budget is spent', async function () {
            const statuses = []
            for (let i = 0; i < 4; i++) {
                const res = await api.post({ jsonrpc: '2.0', method: PUBLIC_METHOD, id: i })
                statuses.push(res.status)
            }
            assert.deepStrictEqual(statuses, [200, 200, 200, 429], `unexpected status sequence ${statuses}`)
        })

        it('advertises the budget with standard headers and not legacy ones', async function () {
            const res = await api.post({ jsonrpc: '2.0', method: PUBLIC_METHOD, id: 99 })
            assert.strictEqual(res.headers.get('ratelimit-limit'), '3')
            assert.strictEqual(res.headers.get('x-ratelimit-limit'), null, 'legacyHeaders is false')
        })
    })

    describe('helmet', function () {
        let api
        before(async function () { api = await bootApi({ INDEXER_API_KEY: KEY }) })
        after(async function () { if (api) await api.close() })

        it('sets nosniff on a normal response', async function () {
            const res = await api.post({ jsonrpc: '2.0', method: PUBLIC_METHOD, id: 1 })
            assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff')
        })

        it('denies framing', async function () {
            const res = await api.post({ jsonrpc: '2.0', method: PUBLIC_METHOD, id: 2 })
            assert.strictEqual(String(res.headers.get('x-frame-options')).toUpperCase(), 'SAMEORIGIN')
        })

        it('does not advertise the server framework', async function () {
            const res = await api.post({ jsonrpc: '2.0', method: PUBLIC_METHOD, id: 3 })
            assert.strictEqual(res.headers.get('x-powered-by'), null)
        })

        it('sets the headers on a rejected call too', async function () {
            const res = await api.post({ jsonrpc: '2.0', method: GATED_WRITE, id: 4 })
            assert.strictEqual(res.status, 401)
            assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff')
        })
    })
})
