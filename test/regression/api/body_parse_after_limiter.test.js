'use strict'

// A POST whose JSON body fails to parse (400) or exceeds the body limit (413)
// errors inside the body parser. If the parser is mounted ahead of the per-IP
// limiter, those requests are never counted and never refused with 429. These
// tests drive the real installMiddleware stack.

const assert  = require('assert')
const http    = require('http')
const net     = require('net')
const express = require('express')
const sinon   = require('sinon')
const observability = require('../../../src/observability/index.js')
const { installMiddleware, rpcErrorHandler, JSON_BODY_LIMIT_BYTES } = require('../../../src/api/middleware.js')
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

// body-parser answers an oversize POST only after it has drained the upload, so
// the counted requests send the whole body. The limiter's 429 is sent without
// reading the upload and the server then closes, and a large unread upload turns
// that close into a reset that can discard the response. So the refused request
// declares the same length but sends only a stub, which the limiter never reads.
// Socket errors are ignored; the verdict is the status line and headers.
function postDeclaredOversize(port, bodyBytes, sendBody){
    return new Promise((resolve, reject) => {
        let raw = ''
        let done = false
        const finish = () => {
            if(done) return
            done = true
            clearTimeout(timer)
            sock.destroy()
            const sep = raw.indexOf('\r\n\r\n')
            if(sep < 0) return reject(new Error('no response, got: ' + raw.slice(0, 200)))
            const head = raw.slice(0, sep).split('\r\n')
            const status = Number(head[0].split(' ')[1])
            const headers = {}
            for(const line of head.slice(1)){
                const i = line.indexOf(':')
                if(i > 0) headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim()
            }
            resolve({ status, headers, body: raw.slice(sep + 4) })
        }
        const timer = setTimeout(finish, 5000)
        const sock = net.connect(port, '127.0.0.1', () => {
            sock.write('POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: ' + bodyBytes + '\r\n\r\n')
            sock.write(sendBody ? Buffer.alloc(bodyBytes, 0x61) : 'aaaa')
        })
        sock.setEncoding('utf8')
        sock.on('data', c => {
            raw += c
            // The response is complete once headers and the declared body arrived.
            const sep = raw.indexOf('\r\n\r\n')
            if(sep >= 0){
                const m = /content-length:\s*(\d+)/i.exec(raw.slice(0, sep))
                if(m && raw.length - sep - 4 >= Number(m[1])) finish()
            }
        })
        sock.on('error', () => {})
        sock.on('close', finish)
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
        const bodyBytes = JSON_BODY_LIMIT_BYTES + 64 * 1024
        const res = []
        for(let i = 0; i < LIMIT + 1; i++) res.push(await postDeclaredOversize(port, bodyBytes, i < LIMIT))
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
