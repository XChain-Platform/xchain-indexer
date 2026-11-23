// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict'

// Drive the real middleware stack over HTTP so the selected budget, bucket
// isolation, authentication fallback, and public response are graded together.

const assert  = require('assert')
const express = require('express')
const sinon   = require('sinon')
const observability = require('../../../src/observability/index.js')
const { installMiddleware } = require('../../../src/api/middleware.js')
const { fakeIndexer } = require('../../unit/api/rpc/helpers/fake_indexer.js')

const KEY_A = 'validator-alpha-secret'
const KEY_B = 'validator-bravo-secret'
const INVALID_KEY = 'invalid-caller-secret'

async function serve ({ ipLimit = 2, keyedLimit = 2 } = {}) {
    const app = express()
    installMiddleware(app, {
        indexer: fakeIndexer(),
        CONFIG_ENV: {
            INDEXER_RATE_LIMIT_RPM: String(ipLimit),
            INDEXER_RATE_LIMIT_KEYED_RPM: String(keyedLimit)
        },
        INDEXER_NETWORK: 'regtest',
        INDEXER_API_KEY: KEY_A + ',' + KEY_B,
        ALLOW_UNAUTHED: false,
        WRITE_METHODS: new Set(),
        GATED_EXEC_METHODS: new Set(),
        FEDERATION_READ_METHODS: new Set(['private'])
    })
    app.post('/', (req, res) => res.json({ ok: true }))
    const server = await new Promise(resolve => {
        const listening = app.listen(0, () => resolve(listening))
    })
    const port = server.address().port
    return {
        async post (key, method = 'ping') {
            const headers = { 'content-type': 'application/json' }
            if(key !== undefined) headers['x-api-key'] = key
            const response = await fetch(`http://127.0.0.1:${port}/`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method })
            })
            return { status: response.status, headers: response.headers, text: await response.text() }
        },
        close () { return new Promise(resolve => server.close(resolve)) }
    }
}

describe('authenticated caller rate limits @regression @tier1', function () {
    let api
    let warn
    let error

    beforeEach(function () {
        warn = sinon.stub(observability.getLogger(), 'warn')
        error = sinon.stub(observability.getLogger(), 'error')
    })

    afterEach(async function () {
        if(api) await api.close()
        api = null
        sinon.restore()
        observability._resetObservability()
    })

    it('gives two valid keys on one IP independent keyed budgets', async function () {
        api = await serve({ ipLimit: 9, keyedLimit: 2 })
        assert.deepStrictEqual([
            (await api.post(KEY_A)).status,
            (await api.post(KEY_A)).status,
            (await api.post(KEY_B)).status,
            (await api.post(KEY_B)).status
        ], [200, 200, 200, 200])
        const exhaustedA = await api.post(KEY_A)
        const exhaustedB = await api.post(KEY_B)
        assert.strictEqual(exhaustedA.status, 429)
        assert.strictEqual(exhaustedB.status, 429)
        assert.strictEqual(exhaustedA.headers.get('ratelimit-limit'), '2')
        assert.strictEqual(exhaustedB.headers.get('ratelimit-limit'), '2')
    })

    it('keeps missing and invalid keys in the shared client IP bucket', async function () {
        api = await serve({ ipLimit: 2, keyedLimit: 9 })
        assert.strictEqual((await api.post(undefined)).status, 200)
        assert.strictEqual((await api.post(INVALID_KEY)).status, 200)
        const exhaustedIp = await api.post(undefined)
        assert.strictEqual(exhaustedIp.status, 429)
        assert.strictEqual(exhaustedIp.headers.get('ratelimit-limit'), '2')
        const validCaller = await api.post(KEY_A)
        assert.strictEqual(validCaller.status, 200)
        assert.strictEqual(validCaller.headers.get('ratelimit-limit'), '9')
    })

    it('never includes a configured or presented key in logs or responses', async function () {
        api = await serve({ ipLimit: 3, keyedLimit: 1 })
        const accepted = await api.post(KEY_A, 'private')
        const keyedRefusal = await api.post(KEY_A, 'private')
        const authRefusal = await api.post(INVALID_KEY, 'private')
        assert.strictEqual(accepted.status, 200)
        assert.strictEqual(keyedRefusal.status, 429)
        assert.strictEqual(authRefusal.status, 401)

        const visible = [accepted.text, keyedRefusal.text, authRefusal.text]
            .concat(warn.args, error.args)
            .flat(Infinity)
            .map(String)
            .join('\n')
        for(const key of [KEY_A, KEY_B, INVALID_KEY])
            assert.strictEqual(visible.includes(key), false, 'a key reached visible output')
    })
})
