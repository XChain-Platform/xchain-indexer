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
 * With inflate off, body-parser answers 415 to any Content-Encoding body and
 * never runs a decompressor, so the runtime Brotli and gzip decoders are not
 * reachable from an indexer API request; a plain JSON-RPC POST is still served.
 *********************************************************************/

'use strict'

const assert  = require('assert')
const http    = require('http')
const zlib    = require('zlib')
const express = require('express')
const sinon   = require('sinon')
const observability = require('../../../../src/observability/index.js')
const { installMiddleware } = require('../../../../src/api/middleware.js')
const { fakeIndexer } = require('../rpc/helpers/fake_indexer.js')

function post(port, body, encoding){
    return new Promise((resolve, reject) => {
        const headers = { 'content-type': 'application/json' }
        if (encoding) headers['content-encoding'] = encoding
        const req = http.request({ agent: false, port, method: 'POST', path: '/', headers }, res => {
            let data = ''
            res.on('data', c => { data += c })
            res.on('end', () => resolve({ status: res.statusCode, body: data }))
        })
        req.on('error', reject)
        req.end(body)
    })
}

const PLAIN = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} })

describe('api refuses compressed request bodies through installMiddleware', () => {
    let server, port, decode

    beforeEach(done => {
        sinon.stub(observability.getLogger(), 'warn')
        sinon.stub(observability.getLogger(), 'error')
        // A decompressor call would mean the body reached the runtime decoders.
        decode = [
            sinon.spy(zlib, 'createBrotliDecompress'),
            sinon.spy(zlib, 'createGunzip'),
            sinon.spy(zlib, 'createInflate'),
        ]
        const app = express()
        installMiddleware(app, {
            indexer: fakeIndexer(), CONFIG_ENV: {}, INDEXER_NETWORK: 'regtest',
            INDEXER_API_KEY: 'k1', ALLOW_UNAUTHED: false,
            WRITE_METHODS: new Set(), GATED_EXEC_METHODS: new Set(), FEDERATION_READ_METHODS: new Set()
        })
        app.post('/', (req, res) => res.json({ ok: true, method: req.body && req.body.method }))
        server = app.listen(0, () => { port = server.address().port; done() })
    })

    afterEach(done => {
        sinon.restore()
        observability._resetObservability()
        server.close(done)
    })

    it('answers a Brotli-encoded body with 415 and never decompresses it', async () => {
        const res = await post(port, zlib.brotliCompressSync(Buffer.from(PLAIN)), 'br')
        assert.strictEqual(res.status, 415)
        for (const spy of decode) assert.strictEqual(spy.called, false, spy.name)
    })

    it('answers a gzip-encoded body with 415 and never decompresses it', async () => {
        const res = await post(port, zlib.gzipSync(Buffer.from(PLAIN)), 'gzip')
        assert.strictEqual(res.status, 415)
        for (const spy of decode) assert.strictEqual(spy.called, false, spy.name)
    })

    it('still serves a plain JSON-RPC POST', async () => {
        const res = await post(port, PLAIN)
        assert.strictEqual(res.status, 200)
        assert.strictEqual(JSON.parse(res.body).method, 'ping')
    })
})
