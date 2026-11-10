'use strict'

// The explorer's POST preflight and feequote forward `params` up to 390,000
// characters (its mirror of the protocol envelope payload ceiling). The
// indexer's JSON body parser must accept at least that much, otherwise a legal
// large BATCH is refused with 413 before the indexer can judge it. A body far
// above the ceiling must still be refused, and Content-Encoding bodies must
// still answer 415 (inflate: false).

const assert  = require('assert')
const http    = require('http')
const express = require('express')
const sinon   = require('sinon')
const observability = require('../../../src/observability/index.js')
const { installMiddleware, rpcErrorHandler } = require('../../../src/api/middleware.js')
const { fakeIndexer } = require('../../unit/api/rpc/helpers/fake_indexer.js')

const PREFLIGHT_PARAMS_CEILING = 390000

function post(port, body, extraHeaders = {}){
    return new Promise((resolve, reject) => {
        const req = http.request({ agent: false, port, method: 'POST', path: '/', headers: { 'content-type': 'application/json', ...extraHeaders } }, res => {
            let data = ''
            res.on('data', c => { data += c })
            res.on('end', () => resolve({ status: res.statusCode, body: data }))
        })
        req.on('error', reject)
        req.end(body)
    })
}

const actionBody = n => JSON.stringify({ action: 'BATCH', params: 'A'.repeat(n), source: 'rltc1qexample' })

describe('indexer JSON body limit matches the explorer preflight ceiling', () => {
    let server, port

    beforeEach(done => {
        sinon.stub(observability.getLogger(), 'warn')
        sinon.stub(observability.getLogger(), 'error')
        const app = express()
        installMiddleware(app, {
            indexer: fakeIndexer(), CONFIG_ENV: { INDEXER_RATE_LIMIT_RPM: '1000' }, INDEXER_NETWORK: 'regtest',
            INDEXER_API_KEY: 'k1', ALLOW_UNAUTHED: false,
            WRITE_METHODS: new Set(), GATED_EXEC_METHODS: new Set(), FEDERATION_READ_METHODS: new Set()
        })
        app.post('/', (req, res) => res.json({ ok: true }))
        app.use(rpcErrorHandler)
        server = app.listen(0, () => { port = server.address().port; done() })
    })

    afterEach(done => {
        sinon.restore()
        observability._resetObservability()
        server.close(done)
    })

    it('accepts a 150,000-char params body', async () => {
        assert.strictEqual((await post(port, actionBody(150000))).status, 200)
    })

    it('accepts a params body at the preflight ceiling', async () => {
        assert.strictEqual((await post(port, actionBody(PREFLIGHT_PARAMS_CEILING))).status, 200)
    })

    it('still refuses a 2 MB body with 413', async () => {
        assert.strictEqual((await post(port, actionBody(2 * 1024 * 1024))).status, 413)
    })

    it('still answers 415 to a Content-Encoding body', async () => {
        assert.strictEqual((await post(port, '{"a":1}', { 'content-encoding': 'gzip' })).status, 415)
    })
})
