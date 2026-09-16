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
 * Boot harness for the root http-surface security suites: the Module._load
 * hook, the env bookkeeping, bootApi() and the gate assertions both suites share.
 *
 * The API-key gate suite (test/security/http-surface/auth_gate.test.js) and the
 * rate-limit and header suite beside it (../rate_limit_headers.test.js) boot the
 * real src/api.js through this one harness. Why the hook swaps exactly three
 * modules, and why the suites drive the shipped app rather than a copy of the
 * gate, is the header of auth_gate.test.js.
 *
 *********************************************************************/

'use strict'

const assert = require('assert')
const path   = require('path')
const Module = require('module')
const { requireWithFreshConfig } = require('../../../../helpers/fresh_config.js')

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..')
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
 * at evaluation from src/config.js's load-time CONFIG_ENV snapshot, so a scenario
 * that changes them must re-evaluate both: every boot loads api.js together with
 * a fresh config.js.
 */
async function bootApi (env = {}) {
    for (const key of OWNED_ENV) delete process.env[key]
    for (const key of DB_ENV) process.env[key] = 'unused-by-this-suite'
    process.env.INDEXER_API_PORT = '0'
    for (const [key, value] of Object.entries(env)) process.env[key] = value

    captured = {}
    requireWithFreshConfig(API_PATH)

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

// A representative from each NON-EMPTY gated set, so a set that loses its gating
// is caught. WRITE_METHODS has no member to represent: `pushvalidatorrewards`
// was its only one and the PUSH-ANCHOR endgame retired the method outright, so
// every case that would drive a write method drives the federation-read
// representative instead, and the retired name is asserted separately below as
// ungated + method-not-found.
const GATED_FEDERATION = 'getactivevalidators'
const GATED_EXEC       = 'feequotedryrun'
const PUBLIC_METHOD    = 'ping'
const RETIRED_WRITE    = 'pushvalidatorrewards'

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

module.exports = {
    installHook, teardownHarness, bootApi, assertUnauthorized, assertPassedGate,
    GATED_FEDERATION, GATED_EXEC, PUBLIC_METHOD, RETIRED_WRITE, KEY
}
