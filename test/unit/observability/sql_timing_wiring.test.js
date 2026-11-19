/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Indexer - SQL timing production wiring
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');
const Module = require('module');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const API_PATH = path.join(REPO_ROOT, 'src', 'api.js');
const DB_PATH = path.join(REPO_ROOT, 'src', 'db', 'index.js');
const CONFIG_PATH = path.join(REPO_ROOT, 'src', 'config.js');
const REQUIRED_DB_ENV = [
    'DECODER_DB_HOST', 'DECODER_DB_PORT', 'DECODER_DB_NAME', 'DECODER_DB_USER', 'DECODER_DB_PASS',
    'INDEXER_DB_HOST', 'INDEXER_DB_PORT', 'INDEXER_DB_NAME', 'INDEXER_DB_USER', 'INDEXER_DB_PASS'
];
const OWNED_ENV = REQUIRED_DB_ENV.concat([
    'INDEXER_API_PORT', 'INDEXER_API_KEY', 'INDEXER_COIN', 'INDEXER_NETWORK', 'METRICS_ENABLED',
    'SQL_TIMING_ENABLED', 'SQL_TIMING_URL', 'SQL_TIMING_KEY', 'SQL_TIMING_PROJECT',
    'SQL_TIMING_REQUEST_RATE', 'SQL_TIMING_STATEMENT_RATE', 'SQL_TIMING_INTERVAL_MS'
]);

function postJson(port, body) {
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const request = http.request({
            host: '127.0.0.1', port, method: 'POST', path: '/', agent: false,
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
        }, (response) => {
            let text = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { text += chunk; });
            response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
        });
        request.on('error', reject);
        request.end(payload);
    });
}

async function waitForTimingRequest(readRequest) {
    const deadline = Date.now() + 5000;
    while (!readRequest()) {
        if (Date.now() > deadline) throw new Error('SQL timing sender did not flush within 5s');
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    return readRequest();
}

describe('SQL timing production wiring', function () {
    let originalLoad;
    let originalFetch;
    let envBefore;
    let signalListeners;
    let server;
    let timingRequest;
    let rawPool;

    before(function () {
        envBefore = OWNED_ENV.map(key => [key, process.env[key]]);
        signalListeners = {
            SIGTERM: process.listeners('SIGTERM'),
            SIGINT: process.listeners('SIGINT')
        };
        for (const key of OWNED_ENV) delete process.env[key];
        for (const key of REQUIRED_DB_ENV) process.env[key] = 'unused-by-wiring-test';
        Object.assign(process.env, {
            INDEXER_API_PORT: '0',
            INDEXER_API_KEY: 'wiring-gate-key',
            INDEXER_COIN: 'BTC',
            INDEXER_NETWORK: 'regtest',
            METRICS_ENABLED: '0',
            SQL_TIMING_ENABLED: '1',
            SQL_TIMING_URL: 'https://timing.test/intake',
            SQL_TIMING_KEY: 'wiring-test-key',
            SQL_TIMING_PROJECT: 'xchain-platform',
            SQL_TIMING_REQUEST_RATE: '1',
            SQL_TIMING_STATEMENT_RATE: '0',
            SQL_TIMING_INTERVAL_MS: '5'
        });

        rawPool = { query: async () => ({ rows: [] }) };
        originalFetch = global.fetch;
        global.fetch = async (url, options) => {
            timingRequest = { url: String(url), options };
            return { status: 200, body: { cancel: async () => {} } };
        };

        const observability = require('../../../src/observability');
        observability.installSqlTiming(null, {
            service: 'xchain-indexer', env: process.env
        });

        const realExpress = require('express');
        originalLoad = Module._load;
        Module._load = function loadWiringDependency(request, parent, isMain) {
            if (request === 'dotenv' && parent && parent.filename === API_PATH)
                return { config: () => ({ parsed: {} }) };
            if (request === 'mariadb' && parent && parent.filename === DB_PATH)
                return { createPool: () => rawPool };
            if (request === './XChainIndexer' && parent && parent.filename === API_PATH) {
                return class StubIndexer {
                    constructor() {
                        this.config = {};
                        this.util = {};
                        const Database = require(DB_PATH);
                        this.indexerDb = new Database('host', 3306, 'db', 'user', 'pass', this);
                        this.lastBlockCommittedAt = null;
                    }
                    async start() { return new Promise(() => {}); }
                };
            }
            if (request === './api/rpc' && parent && parent.filename === API_PATH) {
                return {
                    buildRpcController: ctx => ({
                        timedprobe: async () => {
                            await ctx.indexer.indexerDb.pool.query('SELECT 1');
                            return { ok: true };
                        }
                    })
                };
            }
            if (request === 'express' && parent && parent.filename === API_PATH) {
                const wrapped = function wrappedExpress(...args) {
                    const app = realExpress(...args);
                    const listen = app.listen.bind(app);
                    app.listen = (...listenArgs) => {
                        server = listen(...listenArgs);
                        return server;
                    };
                    return app;
                };
                Object.assign(wrapped, realExpress);
                return wrapped;
            }
            return originalLoad.call(this, request, parent, isMain);
        };
    });

    after(async function () {
        if (server) await new Promise(resolve => server.close(resolve));
        Module._load = originalLoad;
        global.fetch = originalFetch;
        for (const signal of Object.keys(signalListeners)) {
            for (const listener of process.listeners(signal)) {
                if (!signalListeners[signal].includes(listener)) process.removeListener(signal, listener);
            }
        }
        for (const [key, value] of envBefore) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        const observability = require('../../../src/observability');
        observability._resetObservability();
        delete require.cache[API_PATH];
        delete require.cache[DB_PATH];
        delete require.cache[CONFIG_PATH];
    });

    it('emits the RPC route with the wrapped pool query count', async function () {
        delete require.cache[API_PATH];
        delete require.cache[DB_PATH];
        delete require.cache[CONFIG_PATH];
        require(API_PATH);
        assert.ok(server, 'the production API must listen');
        if (!server.listening) await new Promise(resolve => server.once('listening', resolve));

        const response = await postJson(server.address().port, {
            jsonrpc: '2.0', method: 'timedprobe', params: {}, id: 7
        });
        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(response.body, { jsonrpc: '2.0', result: { ok: true }, id: 7 });

        const shipped = await waitForTimingRequest(() => timingRequest);
        const lines = shipped.options.body.trim().split('\n').map(line => JSON.parse(line));
        assert.strictEqual(lines.length, 1);
        assert.strictEqual(lines[0].route, 'POST /xchain-indexer/rpc/timedprobe');
        assert.strictEqual(lines[0].query_count, 1);
        assert.strictEqual(shipped.url, 'https://timing.test/intake');

        // Keep inherited names out of the wrapped method table.
        const inherited = await postJson(server.address().port, {
            jsonrpc: '2.0', method: 'constructor', params: {}, id: 8
        });
        assert.strictEqual(inherited.body.error && inherited.body.error.code, -32601);
        assert.ok(!('result' in inherited.body));
    });
});
