'use strict'

const assert  = require('assert')
const http    = require('http')
const express = require('express')
const sinon   = require('sinon')
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
    let server, port, warn, error

    beforeEach(done => {
        warn = sinon.stub(observability.getLogger(), 'warn')
        error = sinon.stub(observability.getLogger(), 'error')
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
        sinon.restore()
        observability._resetObservability()
        server.close(done)
    })

    it('answers a malformed JSON body with 400 and one warn line, no error log', async () => {
        const res = await post(port, '{"a":')
        assert.strictEqual(res.status, 400)
        assert.strictEqual(error.called, false)
        assert.strictEqual(warn.calledOnce, true)
        assert.strictEqual(warn.firstCall.args[0], '[api] rejected request body: entity.parse.failed (400)')
        assert.ok(!warn.firstCall.args[0].includes('\n'))
    })

    it('passes a well-formed body through', async () => {
        const res = await post(port, '{"a":1}')
        assert.strictEqual(res.status, 200)
        assert.strictEqual(warn.called, false)
    })
})
