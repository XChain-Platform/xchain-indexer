'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const bodyParser = require('body-parser');
const sinon = require('sinon');
const observability = require('../../../src/observability/index.js');
const { rpcErrorHandler, JSON_BODY_LIMIT_BYTES } = require('../../../src/api/middleware.js');

const ADDR = 'bcrt1qz0ly7x9x3cx6z2yfk6ameydzw4n38720vygp6r';
const PREFIX = '3|BTC|' + ADDR + '|';

function buildApp(){
    const app = express();
    // Same parser options as installMiddleware.
    app.use(bodyParser.json({ inflate: false, limit: JSON_BODY_LIMIT_BYTES }));
    app.post('/', (req, res) => res.json({ ok: true, len: req.body.params.params.length }));
    app.use(rpcErrorHandler);
    return app;
}

function forwarded(params){
    return JSON.stringify({
        jsonrpc: '2.0', method: 'preflight',
        params: { action: 'MESSAGE', params, source: ADDR }, id: 1
    });
}

async function post(body){
    const server = http.createServer(buildApp());
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const response = await fetch('http://127.0.0.1:' + server.address().port + '/', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body
        });
        return { status: response.status, text: await response.text() };
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

function pad(unit, total){
    return PREFIX + unit.repeat(Math.ceil((total - PREFIX.length) / unit.length)).slice(0, total - PREFIX.length);
}

describe('JSON body limit vs JSON-escaped legal payloads', function(){
    this.timeout(30000);

    beforeEach(function(){
        sinon.stub(observability.getLogger(), 'warn');
        sinon.stub(observability.getLogger(), 'error');
    });
    afterEach(function(){ sinon.restore(); });

    it('accepts 380,000 chars of newline text (about 570 KB on the wire)', async function(){
        const params = pad('a\n', 380000);
        const body = forwarded(params);
        assert.ok(Buffer.byteLength(body) > 524288);
        const res = await post(body);
        assert.strictEqual(res.status, 200, res.text);
    });

    it('accepts 380,000 chars of quote text', async function(){
        const res = await post(forwarded(pad('a"', 380000)));
        assert.strictEqual(res.status, 200, res.text);
    });

    it('accepts 390,000 control characters (about 2.34 MB on the wire)', async function(){
        const params = PREFIX + '\u0001'.repeat(390000 - PREFIX.length);
        const body = forwarded(params);
        assert.ok(Buffer.byteLength(body) > 2.3 * 1024 * 1024 - 100000);
        const res = await post(body);
        assert.strictEqual(res.status, 200, res.text);
    });

    it('still refuses a body above the ceiling with the clean 413 refusal', async function(){
        const res = await post(forwarded('a'.repeat(JSON_BODY_LIMIT_BYTES + 1024)));
        assert.strictEqual(res.status, 413);
        const parsed = JSON.parse(res.text);
        assert.strictEqual(parsed.error.code, -32600);
        assert.strictEqual(parsed.error.message, 'Request body too large');
    });
});
