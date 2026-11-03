'use strict'

// The per-IP limiter's 429 must carry the same JSON-RPC error envelope as every
// other refusal (400, 413, 415), never express-rate-limit's default text/html
// string. Drives the real installMiddleware stack with a small limit.

const assert  = require('assert')
const http    = require('http')
const express = require('express')
const sinon   = require('sinon')
const observability = require('../../../src/observability/index.js')
const { installMiddleware, rpcErrorHandler } = require('../../../src/api/middleware.js')
const { fakeIndexer } = require('../../unit/api/rpc/helpers/fake_indexer.js')

const LIMIT = 3

function post(port, body){
    return new Promise((resolve, reject) => {
        const req = http.request({ agent: false, port, method: 'POST', path: '/', headers: { 'content-type': 'application/json' } }, res => {
            let data = ''
            res.on('data', c => { data += c })
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
        })
        req.on('error', reject)
        req.end(body)
    })
}

function assertJsonRefusal(r){
    assert.strictEqual(r.status, 429)
    assert.match(r.headers['content-type'], /application\/json/)
    const body = JSON.parse(r.body)
    assert.deepStrictEqual(Object.keys(body).sort(), ['error', 'id', 'jsonrpc'])
    assert.strictEqual(body.jsonrpc, '2.0')
    assert.strictEqual(body.id, null)
    assert.strictEqual(body.error.code, -32600)
    assert.strictEqual(typeof body.error.message, 'string')
    assert.ok(body.error.message.length > 0)
    assert.ok(r.headers['retry-after'] !== undefined, 'Retry-After kept')
    assert.ok(r.headers['ratelimit-limit'] !== undefined, 'RateLimit-Limit kept')
    assert.ok(r.headers['ratelimit-remaining'] !== undefined, 'RateLimit-Remaining kept')
    assert.ok(r.headers['ratelimit-reset'] !== undefined, 'RateLimit-Reset kept')
}

describe('rate-limit refusal carries the JSON-RPC envelope', () => {
    let server, port

    beforeEach(done => {
        sinon.stub(observability.getLogger(), 'warn')
        sinon.stub(observability.getLogger(), 'error')
        const app = express()
        installMiddleware(app, {
            indexer: fakeIndexer(), CONFIG_ENV: { INDEXER_RATE_LIMIT_RPM: String(LIMIT) }, INDEXER_NETWORK: 'regtest',
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

    it('answers the first over-limit valid POST with a JSON 429', async () => {
        const ok = '{"jsonrpc":"2.0","id":1,"method":"x","params":[]}'
        for(let i = 0; i < LIMIT; i++) assert.strictEqual((await post(port, ok)).status, 200)
        assertJsonRefusal(await post(port, ok))
    })

    it('answers an over-limit malformed body with the same JSON 429', async () => {
        for(let i = 0; i < LIMIT; i++) assert.strictEqual((await post(port, '{')).status, 400)
        assertJsonRefusal(await post(port, '{'))
    })
})
