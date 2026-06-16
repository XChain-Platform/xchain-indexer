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
 * Smoke test: REST /status endpoint (SM-05)
 *
 * Starts a minimal Express server mounting the same GET /status route as
 * api.js, backed by a stub indexer, then verifies the endpoint reports the
 * indexer tip, decoder tip, computed lag, and sync flag over a plain GET.
 * Does NOT start the indexer loop or connect to any database.
 *
 * SM-05: GET /status exposes quantitative indexer→decoder lag
 */

'use strict';

const assert     = require('assert');
const http       = require('http');
const express    = require('express');
const helmet     = require('helmet');

// ---------------------------------------------------------------------------
// Helper: GET a path and return { status, body }
// ---------------------------------------------------------------------------
function getJson(port, path) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path,
            method: 'GET',
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
        req.end();
    });
}

// Build an app mounting the same /status handler as src/api.js against the
// supplied stub indexer. Mirrors the api.js route logic (the smoke harness
// reconstructs the route rather than importing api.js, which auto-starts).
function buildApp(indexer) {
    const app = express();
    app.use(helmet());
    app.get('/status', async (req, res) => {
        let indexerBlock = null;
        try {
            if(indexer.indexerDb)
                indexerBlock = await indexer.indexerDb.getLatestBlockIndex();
        } catch (err) {
            // Database unreachable — leave indexerBlock null so lag stays null.
        }
        let decoderBlock = (indexer.lastDecoderBlock != null) ? Number(indexer.lastDecoderBlock) : null;
        res.json({
            indexerBlock: indexerBlock,
            decoderBlock: decoderBlock,
            lag:          (decoderBlock != null && indexerBlock != null)
                            ? decoderBlock - indexerBlock
                            : null,
            isSynced:     indexer.isSynced()
        });
    });
    return app;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('Smoke: REST /status', function () {
    this.timeout(5000);

    function listen(indexer) {
        return new Promise((resolve) => {
            const server = buildApp(indexer).listen(0, '127.0.0.1', () => {
                resolve({ server, port: server.address().port });
            });
        });
    }

    // -------------------------------------------------------------------------
    // SM-05: lag is computable from the public API surface
    // -------------------------------------------------------------------------
    it('SM-05: GET /status reports indexer/decoder tips, lag, and sync flag', async function () {
        const indexer = {
            indexerDb: { async getLatestBlockIndex() { return 120000; } },
            lastDecoderBlock: 120500,
            isSynced() { return false; },
        };
        const { server, port } = await listen(indexer);
        try {
            const { status, body } = await getJson(port, '/status');
            assert.strictEqual(status, 200, `Expected HTTP 200 but got ${status}`);
            assert.strictEqual(body.indexerBlock, 120000, `Expected indexerBlock 120000; got ${JSON.stringify(body)}`);
            assert.strictEqual(body.decoderBlock, 120500, `Expected decoderBlock 120500; got ${JSON.stringify(body)}`);
            assert.strictEqual(body.lag, 500, `Expected lag 500 (decoder − indexer); got ${JSON.stringify(body)}`);
            assert.strictEqual(body.isSynced, false, `Expected isSynced false; got ${JSON.stringify(body)}`);
        } finally {
            server.close();
        }
    });

    // -------------------------------------------------------------------------
    // SM-05b: lag is null (not a misleading number) before the first poll cycle
    // populates lastDecoderBlock
    // -------------------------------------------------------------------------
    it('SM-05b: GET /status reports null lag when the decoder tip is unknown', async function () {
        const indexer = {
            indexerDb: { async getLatestBlockIndex() { return 0; } },
            lastDecoderBlock: null,
            isSynced() { return false; },
        };
        const { server, port } = await listen(indexer);
        try {
            const { status, body } = await getJson(port, '/status');
            assert.strictEqual(status, 200, `Expected HTTP 200 but got ${status}`);
            assert.strictEqual(body.decoderBlock, null, `Expected decoderBlock null; got ${JSON.stringify(body)}`);
            assert.strictEqual(body.lag, null, `Expected lag null when decoder tip unknown; got ${JSON.stringify(body)}`);
        } finally {
            server.close();
        }
    });
});
