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
 * Root http-surface security suite, rate limit and response headers: the per-IP
 * rate limit and the helmet headers of the REAL middleware stack of src/api.js,
 * booted and driven over HTTP through ./helpers/api_boot.js. The API-key gate
 * cases, and the reasoning behind the boot harness, are in
 * test/security/http-surface/auth_gate.test.js.
 *
 *********************************************************************/

'use strict'

const assert = require('assert')
const { installHook, teardownHarness, bootApi, GATED_FEDERATION, PUBLIC_METHOD, KEY } = require('./helpers/api_boot.js')

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
            const res = await api.post({ jsonrpc: '2.0', method: GATED_FEDERATION, id: 4 })
            assert.strictEqual(res.status, 401)
            assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff')
        })
    })
})
