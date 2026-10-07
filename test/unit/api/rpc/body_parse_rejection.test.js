'use strict'

const assert  = require('assert')
const http    = require('http')
const express = require('express')
const observability = require('../../../../src/observability/index.js')
const { installMiddleware } = require('../../../../src/api/middleware.js')
const { fakeIndexer } = require('../rpc/helpers/fake_indexer.js')

function post(port, body){
    return new Promise((resolve, reject) => {
        const req = http.request({ agent: false, port, method: 'POST', path: '/', headers: { 'content-type': 'application/json' } }, res => {
            let data = ''
            res.on('data', c => { data += c })
            res.on('end', () => resolve({ status: res.statusCode, body: data }))
        })
        req.on('error', reject)
        req.end(body)
    })
}

describe('api body parse rejection through installMiddleware', () => {
    let server, port, calls, restore

    beforeEach(done => {
        calls = { warn: [], error: [] }
        const origWarn = console.warn, origError = console.error
        console.warn  = (...a) => calls.warn.push(a)
        console.error = (...a) => calls.error.push(a)
        restore = () => { console.warn = origWarn; console.error = origError }
        const app = express()
        installMiddleware(app, {
            indexer: fakeIndexer(), CONFIG_ENV: {}, INDEXER_NETWORK: 'regtest',
            INDEXER_API_KEY: 'k1', ALLOW_UNAUTHED: false,
            WRITE_METHODS: new Set(), GATED_EXEC_METHODS: new Set(), FEDERATION_READ_METHODS: new Set()
        })
        app.post('/', (req, res) => res.json({ ok: true }))
        server = app.listen(0, () => { port = server.address().port; done() })
    })

    afterEach(done => {
        restore()
        observability._resetObservability()
        server.close(done)
    })

    it('answers a malformed JSON body with 400 and one warn line, no error log', async () => {
        const res = await post(port, '{"a":')
        assert.strictEqual(res.status, 400)
        assert.deepStrictEqual(calls.error, [])
        assert.strictEqual(calls.warn.length, 1)
        assert.ok(!String(calls.warn[0][0]).includes('\n'))
    })

    it('passes a well-formed body through', async () => {
        const res = await post(port, '{"a":1}')
        assert.strictEqual(res.status, 200)
        assert.strictEqual(calls.warn.length, 0)
    })
})
