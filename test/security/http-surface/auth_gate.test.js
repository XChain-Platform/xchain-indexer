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
 * What makes this suite different from test/unit/api_auth_batch.test.js is the
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
 * The boot harness in auth_gate.test/helpers/api_boot.js defeats that without
 * touching production code: a Module._load hook swaps THREE modules and
 * nothing else -
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
 * helmet headers. The cors layer is covered by test/unit/cors_origin.test.js,
 * which drives the real middleware the same way, and is not duplicated here.
 * The rate-limit and helmet cases run from auth_gate.test/rate_limit_headers.test.js
 * through the same harness.
 *
 *********************************************************************/

'use strict'

const assert = require('assert')
const {
    installHook, teardownHarness, bootApi, assertUnauthorized, assertPassedGate,
    GATED_FEDERATION, GATED_EXEC, PUBLIC_METHOD, RETIRED_WRITE, KEY
} = require('./auth_gate.test/helpers/api_boot.js')

// The gate scenarios are consecutive sibling blocks under one suite title, each
// installing and removing the harness itself, so every full test title is the
// same one the suite has always reported while no describe callback outgrows
// the structure limit.
describe('indexer http-surface security: API-key gate on the real app', function () {

    before(installHook)
    after(teardownHarness)

    describe('with INDEXER_API_KEY configured', function () {
        let api
        before(async function () { api = await bootApi({ INDEXER_API_KEY: KEY }) })
        after(async function () { if (api) await api.close() })

        it('rejects a federation read sent with no key', async function () {
            assertUnauthorized(await api.post({ jsonrpc: '2.0', method: GATED_FEDERATION, id: 2 }))
        })

        it('rejects a gated exec method sent with no key', async function () {
            assertUnauthorized(await api.post({ jsonrpc: '2.0', method: GATED_EXEC, id: 3 }))
        })

        it('rejects a wrong key', async function () {
            assertUnauthorized(await api.post({ jsonrpc: '2.0', method: GATED_FEDERATION, id: 4 }, { 'x-api-key': 'not-the-key' }))
        })

        it('rejects a key that is a prefix of the real one', async function () {
            assertUnauthorized(await api.post({ jsonrpc: '2.0', method: GATED_FEDERATION, id: 5 }, { 'x-api-key': KEY.slice(0, -1) }))
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
            assertUnauthorized(await api.post({ jsonrpc: '2.0', method: GATED_FEDERATION.toUpperCase(), id: 9 }))
        })
    })
})

describe('indexer http-surface security: API-key gate on the real app', function () {

    before(installHook)
    after(teardownHarness)

    // The batch cases of the keyed scenario, on a keyed app of their own.
    describe('with INDEXER_API_KEY configured', function () {
        let api
        before(async function () { api = await bootApi({ INDEXER_API_KEY: KEY }) })
        after(async function () { if (api) await api.close() })

        // The regression this whole gate was rewritten for: express-json-rpc-router
        // dispatches every element of an array body, so reading req.body.method
        // (undefined for an array) let a one-element batch forge spendable
        // validator_rewards rows unauthenticated.
        it('rejects a gated call smuggled inside a one-element batch', async function () {
            assertUnauthorized(await api.post([{ jsonrpc: '2.0', method: GATED_FEDERATION, id: 10 }]))
        })

        it('rejects a gated call mixed into a batch of public calls', async function () {
            assertUnauthorized(await api.post([
                { jsonrpc: '2.0', method: PUBLIC_METHOD, id: 11 },
                { jsonrpc: '2.0', method: GATED_FEDERATION, id: 12 }
            ]))
        })

        it('passes a gated batch carrying the correct key', async function () {
            const res = await api.post([{ jsonrpc: '2.0', method: GATED_FEDERATION, id: 13 }], { 'x-api-key': KEY })
            assert.strictEqual(res.status, 200)
            assert.ok(!res.text.includes('-32001'), `batch was rejected by the auth gate: ${res.text}`)
        })

        it('leaves a public-only batch ungated', async function () {
            const res = await api.post([{ jsonrpc: '2.0', method: PUBLIC_METHOD, id: 14 }])
            assert.strictEqual(res.status, 200)
            assert.ok(!res.text.includes('-32001'), res.text)
        })
    })
})

describe('indexer http-surface security: API-key gate on the real app', function () {

    before(installHook)
    after(teardownHarness)

    // PUSH-ANCHOR endgame: the last write method is gone from the surface, not
    // merely gated or stubbed. Asserted over the real app so a re-registration
    // anywhere (controller, gate list, a middleware that answers early) shows up
    // as a live method rather than as a passing source-text grep.
    describe('the retired pushvalidatorrewards rail', function () {
        let keyed, keyless
        before(async function () {
            keyed = await bootApi({ INDEXER_API_KEY: KEY })
        })
        after(async function () {
            if (keyed) await keyed.close()
            if (keyless) await keyless.close()
        })

        it('is not dispatched: an unauthenticated call gets method-not-found, never a result', async function () {
            const res = await keyed.post({ jsonrpc: '2.0', method: RETIRED_WRITE, id: 1 })
            assert.strictEqual(res.status, 200, `the method is no longer gated, so no 401: ${res.text}`)
            assert.strictEqual(res.body && res.body.result, undefined,
                'a retired rail must never answer with a result')
            assert.strictEqual(res.body && res.body.error && res.body.error.code, -32601,
                `expected JSON-RPC method-not-found, got: ${res.text}`)
        })

        it('is not dispatched even when the caller holds the API key', async function () {
            // The forge vector was an insider-held key. With the method gone the key
            // buys nothing on this name.
            const res = await keyed.post({ jsonrpc: '2.0', method: RETIRED_WRITE, id: 2 }, { 'x-api-key': KEY })
            assert.strictEqual(res.body && res.body.result, undefined)
            assert.strictEqual(res.body && res.body.error && res.body.error.code, -32601, res.text)
        })

        it('cannot be smuggled into a batch alongside a public call', async function () {
            const res = await keyed.post([
                { jsonrpc: '2.0', method: PUBLIC_METHOD, id: 3 },
                { jsonrpc: '2.0', method: RETIRED_WRITE, id: 4 }
            ])
            assert.strictEqual(res.status, 200)
            assert.ok(res.text.includes('-32601'), `the retired element must be method-not-found: ${res.text}`)
        })

        it('stays undispatchable on a keyless node with the escape hatch open', async function () {
            // The worst case for a retired write: no key configured AND the keyless
            // hatch open, i.e. the gate waves everything through. Removal has to hold
            // on its own, without the perimeter.
            keyless = await bootApi({ INDEXER_ALLOW_UNAUTHENTICATED: 'true' })
            const res = await keyless.post({ jsonrpc: '2.0', method: RETIRED_WRITE, id: 5 })
            assert.strictEqual(res.body && res.body.result, undefined,
                'a keyless node must not dispatch the retired rail either')
            assert.strictEqual(res.body && res.body.error && res.body.error.code, -32601, res.text)
        })
    })
})

describe('indexer http-surface security: API-key gate on the real app', function () {

    before(installHook)
    after(teardownHarness)

    // The property that keeps a keyless deployment from being an open reward
    // mint: absence of configuration denies, it does not allow.
    describe('with no key configured and no escape hatch (fail closed)', function () {
        let api
        before(async function () { api = await bootApi({}) })
        after(async function () { if (api) await api.close() })

        it('rejects a federation read', async function () {
            assertUnauthorized(await api.post({ jsonrpc: '2.0', method: GATED_FEDERATION, id: 1 }))
        })

        it('rejects a gated exec method', async function () {
            assertUnauthorized(await api.post({ jsonrpc: '2.0', method: GATED_EXEC, id: 2 }))
        })

        it('rejects a gated batch', async function () {
            assertUnauthorized(await api.post([{ jsonrpc: '2.0', method: GATED_FEDERATION, id: 3 }]))
        })

        it('names the escape hatch in the rejection so an operator can act on it', async function () {
            const res = await api.post({ jsonrpc: '2.0', method: GATED_FEDERATION, id: 4 })
            assert.match(res.body.error.message, /INDEXER_ALLOW_UNAUTHENTICATED/)
        })

        it('still serves public methods', async function () {
            const res = await api.post({ jsonrpc: '2.0', method: PUBLIC_METHOD, id: 5 })
            assert.deepStrictEqual(res.body.result, { status: 'success' })
        })
    })
})

describe('indexer http-surface security: API-key gate on the real app', function () {

    before(installHook)
    after(teardownHarness)

    describe('with INDEXER_ALLOW_UNAUTHENTICATED=true (keyless regtest)', function () {
        let api
        before(async function () { api = await bootApi({ INDEXER_ALLOW_UNAUTHENTICATED: 'true' }) })
        after(async function () { if (api) await api.close() })

        it('passes a keyless federation read', async function () {
            assertPassedGate(await api.post({ jsonrpc: '2.0', method: GATED_FEDERATION, id: 1 }))
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
            assertUnauthorized(await api.post({ jsonrpc: '2.0', method: GATED_FEDERATION, id: 1 }))
        })
    })
})
