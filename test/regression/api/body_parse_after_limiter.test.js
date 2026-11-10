'use strict'

// A POST whose JSON body fails to parse (400) or exceeds the body limit (413)
// errors inside the body parser. If the parser is mounted ahead of the per-IP
// limiter, those requests are never counted and never refused with 429. These
// tests drive the real installMiddleware stack.

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

describe('api body parsing runs behind the rate limiter', () => {
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

    it('counts and eventually refuses malformed-JSON POSTs', async () => {
        const res = []
        for(let i = 0; i < LIMIT + 2; i++) res.push(await post(port, '{'))
        for(const r of res.slice(0, LIMIT)) assert.strictEqual(r.status, 400)
        for(const r of res.slice(LIMIT)) assert.strictEqual(r.status, 429)
    })

    it('counts and eventually refuses oversize POSTs, with RateLimit headers on the 413', async () => {
        const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'x', params: ['a'.repeat(600 * 1024)] })
        const res = []
        for(let i = 0; i < LIMIT + 1; i++) res.push(await post(port, big))
        for(const r of res.slice(0, LIMIT)) assert.strictEqual(r.status, 413)
        assert.strictEqual(Number(res[0].headers['ratelimit-remaining']), LIMIT - 1)
        assert.strictEqual(Number(res[1].headers['ratelimit-remaining']), LIMIT - 2)
        assert.strictEqual(res[LIMIT].status, 429)
    })

    it('still parses and routes a well-formed call', async () => {
        const r = await post(port, '{"a":1}')
        assert.strictEqual(r.status, 200)
        assert.deepStrictEqual(JSON.parse(r.body), { ok: true })
    })
})
