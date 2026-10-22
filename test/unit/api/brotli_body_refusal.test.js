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
 * The indexer API answers 415 to any request whose Content-Encoding names br,
 * in any case and at any position in the list, before the JSON body parser
 * runs, so the runtime Brotli decoder is never reachable from a request body.
 *********************************************************************/

'use strict'

const assert  = require('assert')
const http    = require('http')
const zlib    = require('zlib')
const express = require('express')
const sinon   = require('sinon')
const observability = require('../../../src/observability/index.js')
const { installMiddleware, refuseBrotliBody } = require('../../../src/api/middleware.js')
const { fakeIndexer } = require('./rpc/helpers/fake_indexer.js')

function post(port, body, encoding){
    return new Promise((resolve, reject) => {
        const headers = { 'content-type': 'application/json' }
        if (encoding !== undefined) headers['content-encoding'] = encoding
        const req = http.request({ agent: false, port, method: 'POST', path: '/', headers }, res => {
            let data = ''
            res.on('data', c => { data += c })
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
        })
        req.on('error', reject)
        req.end(body)
    })
}

const PLAIN = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} })

function buildApp(){
    const app = express()
    installMiddleware(app, {
        indexer: fakeIndexer(), CONFIG_ENV: {}, INDEXER_NETWORK: 'regtest',
        INDEXER_API_KEY: 'k1', ALLOW_UNAUTHED: false,
        WRITE_METHODS: new Set(), GATED_EXEC_METHODS: new Set(), FEDERATION_READ_METHODS: new Set()
    })
    app.post('/', (req, res) => res.json({ ok: true, method: req.body && req.body.method }))
    return app
}

describe('api refuses Brotli-encoded request bodies before the body parser', () => {
    let server, port, brotli

    beforeEach(done => {
        sinon.stub(observability.getLogger(), 'warn')
        sinon.stub(observability.getLogger(), 'error')
        // A call here would mean the body reached the runtime Brotli decoder.
        brotli = sinon.spy(zlib, 'createBrotliDecompress')
        server = buildApp().listen(0, () => { port = server.address().port; done() })
    })

    afterEach(done => {
        sinon.restore()
        observability._resetObservability()
        server.close(done)
    })

    for (const encoding of ['br', 'BR', 'gzip, br']) {
        it(`answers Content-Encoding "${encoding}" with 415 and never decodes the body`, async () => {
            const res = await post(port, zlib.brotliCompressSync(Buffer.from(PLAIN)), encoding)
            assert.strictEqual(res.status, 415)
            assert.strictEqual(res.headers['accept-encoding'], 'identity, gzip, deflate')
            assert.strictEqual(brotli.called, false)
        })
    }

    it('answers 415 to an undecodable br body, so no parser saw it first', async () => {
        const res = await post(port, Buffer.from('not brotli at all'), 'br')
        assert.strictEqual(res.status, 415)
        assert.strictEqual(brotli.called, false)
    })

    it('still serves a JSON-RPC POST with Content-Encoding identity', async () => {
        const res = await post(port, PLAIN, 'identity')
        assert.strictEqual(res.status, 200)
        assert.strictEqual(JSON.parse(res.body).method, 'ping')
    })

    it('still serves a JSON-RPC POST with no Content-Encoding header', async () => {
        const res = await post(port, PLAIN)
        assert.strictEqual(res.status, 200)
        assert.strictEqual(JSON.parse(res.body).method, 'ping')
    })
})

describe('the Brotli refusal mounts ahead of every body parser', () => {
    it('is the first layer installMiddleware adds, before the JSON parser', () => {
        const names = buildApp().router.stack.map(layer => layer.name)
        const guard = names.indexOf(refuseBrotliBody.name)
        const parser = names.indexOf('jsonParser')
        assert.strictEqual(guard, 0, names.join(','))
        assert.ok(parser > guard, names.join(','))
        observability._resetObservability()
    })
})
