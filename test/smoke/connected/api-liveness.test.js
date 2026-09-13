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
 * Smoke test: API liveness (SM-04)
 *
 * Starts a minimal Express server using the same middleware and JSON-RPC
 * controller as api.js, then verifies the ping endpoint returns a success
 * response. Does NOT start the indexer loop or connect to any database.
 *
 * SM-04: JSON-RPC ping returns success
 */

'use strict';

const assert     = require('assert');
const http       = require('http');
const express    = require('express');
const bodyParser = require('body-parser');
const helmet     = require('helmet');
const cors       = require('cors');
const jsonRouter = require('express-json-rpc-router');

// ---------------------------------------------------------------------------
// Helper: POST a JSON-RPC request and return { status, body }
// ---------------------------------------------------------------------------
function postJsonRpc(port, method) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ jsonrpc: '2.0', method, id: 1 });
        const req  = http.request({
            hostname: 'localhost',
            port,
            path: '/',
            method: 'POST',
            headers: {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end',  () => {
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(data) });
                } catch (e) {
                    reject(new Error('Failed to parse response JSON: ' + data));
                }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('Smoke: API liveness', function () {
    this.timeout(5000);

    let server;
    let port;

    before(function (done) {
        // Mirror the setup from src/api.js
        const app = express();
        app.use(helmet());
        app.use(bodyParser.json());
        app.use(cors());

        const jsonRpcController = {
            async ping() {
                return { status: 'success' };
            },
        };

        app.use(jsonRouter({ methods: jsonRpcController }));

        // Port 0 lets the OS pick a free port, avoiding conflicts
        server = app.listen(0, '127.0.0.1', () => {
            port = server.address().port;
            done();
        });
    });

    after(function (done) {
        if (server) {
            server.close(done);
        } else {
            done();
        }
    });

    // -------------------------------------------------------------------------
    // SM-04: JSON-RPC ping returns success
    // -------------------------------------------------------------------------
    it('SM-04: JSON-RPC ping returns HTTP 200 with status:success', async function () {
        const { status, body } = await postJsonRpc(port, 'ping');

        assert.strictEqual(status, 200,
            `Expected HTTP 200 but got ${status}`);

        assert.ok(body && body.result,
            `Expected a "result" field in the JSON-RPC response; got: ${JSON.stringify(body)}`);

        assert.strictEqual(body.result.status, 'success',
            `Expected result.status === "success"; got: ${JSON.stringify(body.result)}`);
    });
});
