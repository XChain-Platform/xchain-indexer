'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const bodyParser = require('body-parser');
const jsonRouter = require('express-json-rpc-router');
const { buildRpcController } = require('../../../../src/api/rpc/index.js');
const { fakeIndexer } = require('./helpers/fake_indexer.js');

const DECLARED = [
    'ping', 'health', 'getownstake', 'getlatestblock', 'getblockhashes', 'feequote', 'oraclefeequote',
    'preflight', 'feeschedule', 'getactivevalidators', 'getactivestakeweights', 'getcapabilityvalidators',
    'getfullnodeverifiers', 'getstakeweightsbycapability', 'getpendingattestation_requests',
    'getrelayedattestation_requests', 'getopencrosschainorders', 'getbetfeeds', 'getbetfeed', 'getbets',
    'getpendingbridgetransfers', 'getbridgetransfer', 'getbridgebalances', 'getbridgeescrowproof',
    'gettokenpolicy', 'getappliedpolicy', 'getlistat', 'getsharedlists', 'getsharedlist',
    'getpendingcrosschaincalls', 'getcrosschaincallresult', 'getpricebatches', 'getpricebatchpayload',
    'getattestbatches', 'getactionconfirmations', 'getanchoraction', 'getrollcallsigners',
    'getanchorconfirmations', 'getarchiveanchor', 'getreorghistory', 'getstakesourcebypubkey',
    'getrollcalls', 'getrollcallabsences', 'getcapabilitystakeproof'
];

function controller(){
    return buildRpcController({
        indexer: fakeIndexer(),
        liveness: { indexerRunning: true, indexerError: null },
        ENABLE_DRYRUN: false,
        rollcallManifestHash: () => null
    });
}

async function call(methods, method){
    const app = express();
    app.use(bodyParser.json());
    app.use(jsonRouter({ methods }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const response = await fetch('http://127.0.0.1:' + server.address().port + '/', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method })
        });
        return await response.json();
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

describe('JSON-RPC prototype method dispatch', function(){
    this.timeout(10000);

    for(const method of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__', '__defineGetter__']){
        it('rejects ' + method + ' as an undeclared method', async function(){
            const body = await call(controller(), method);
            assert.strictEqual(body.error && body.error.code, -32601, JSON.stringify(body));
            assert.strictEqual(Object.prototype.hasOwnProperty.call(body, 'result'), false);
        });
    }

    it('still dispatches a declared method', async function(){
        const body = await call(controller(), 'ping');
        assert.deepStrictEqual(body.result, { status: 'success' });
    });

    it('exposes exactly the declared methods on a prototype-free table', function(){
        const methods = controller();
        assert.strictEqual(Object.getPrototypeOf(methods), null);
        assert.deepStrictEqual(Object.keys(methods).sort(), DECLARED.slice().sort());
    });
});
