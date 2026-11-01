'use strict';

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const sinon = require('sinon');
const observability = require('../../../src/observability/index.js');
const { rpcErrorHandler } = require('../../../src/api/middleware.js');

function buildApp(){
    const app = express();
    app.use(bodyParser.json({ limit: '100kb' }));
    app.post('/throw', () => { throw new Error('private failure marker'); });
    app.post('/', (req, res) => res.json({ ok: true }));
    app.use(rpcErrorHandler);
    return app;
}

async function post(app, route, body){
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const response = await fetch('http://127.0.0.1:' + server.address().port + route, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body
        });
        return {
            status: response.status,
            type: response.headers.get('content-type') || '',
            text: await response.text()
        };
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

function assertCleanRpcError(response, status, code){
    assert.strictEqual(response.status, status);
    assert.match(response.type, /application\/json/);
    const body = JSON.parse(response.text);
    assert.deepStrictEqual(body, {
        jsonrpc: '2.0', error: { code, message: body.error.message }, id: null
    });
    for(const marker of ['Error', 'node_modules', 'body-parser', ' at ', 'private failure marker'])
        assert.strictEqual(response.text.includes(marker), false, response.text);
}

describe('JSON-RPC terminal error handler', function(){
    let error;

    beforeEach(function(){
        sinon.stub(observability.getLogger(), 'warn');
        error = sinon.stub(observability.getLogger(), 'error');
    });

    afterEach(function(){ sinon.restore(); });

    it('maps malformed JSON to a parse error', async function(){
        assertCleanRpcError(await post(buildApp(), '/', '{"jsonrpc":'), 400, -32700);
    });

    it('maps oversized JSON to an invalid request', async function(){
        const body = JSON.stringify({ pad: 'x'.repeat(110000) });
        assertCleanRpcError(await post(buildApp(), '/', body), 413, -32600);
    });

    for(const body of ['null', '"text"']){
        it('maps non-object JSON ' + body + ' to a parse error', async function(){
            assertCleanRpcError(await post(buildApp(), '/', body), 400, -32700);
        });
    }

    it('maps thrown application errors to an internal error and logs once', async function(){
        assertCleanRpcError(await post(buildApp(), '/throw', '{}'), 500, -32603);
        assert.strictEqual(error.calledOnce, true);
    });

    it('is mounted after the JSON-RPC router in the production app', function(){
        const source = fs.readFileSync(path.join(__dirname, '../../../src/api.js'), 'utf8');
        assert.ok(source.indexOf('app.use(rpcErrorHandler)') > source.indexOf('app.use(jsonRouter('));
    });
});
