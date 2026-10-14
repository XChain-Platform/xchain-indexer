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
 * Unit: the /status wedge verdict measures its no-progress window from the later of
 * the last commit and the current block's barrier hold, through the real
 * mountStatusRoute and advanceFields over a real indexer instance.
 *
 * On a chain with ~20 minute blocks nearly every barrier wait begins long after the
 * previous commit, so measuring from the commit alone answered 503 the moment a
 * healthy wait began. The hold record's `since` gives each held block its own grace,
 * while a hold that outlasts the grace with no commit still answers 503. These cases
 * pin the wiring in the callers, which is where a dropped argument would silently
 * restore the old window.
 */

'use strict';

const assert  = require('assert');
const http    = require('http');
const express = require('express');

const XChainIndexer = require('../../../src/XChainIndexer.js');
const { mountStatusRoute } = require('../../../src/api/status_endpoint.js');
const { advanceFields } = require('../../../src/api/health/advance_fields.js');

const MIN   = 60 * 1000;
const GRACE = 2 * MIN;

function get(port, path){
    return new Promise((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port, path }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
                catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

// A real indexer level with its decoder, last committed 21 minutes ago, with block
// 1001 deferred at the attest response barrier. `holdSince` is the hold record's
// instant, or null for no recorded hold.
function heldIndexer(holdSince){
    let now = Date.now();
    let ix = new XChainIndexer();
    ix.indexerDb   = { getLatestBlockIndex: async () => 1000 };
    ix.decoderDb   = { getBlockIndex: async () => 1000 };
    ix.utxoTracker = null;
    ix.lastPollAt  = now;
    ix.healthStallGraceMs   = GRACE;
    ix.barrierHoldCeilingMs = 15 * MIN;
    ix.lastBlockCommittedAt = now - 21 * MIN;
    ix.stallReason          = 'attest_response_sync_barrier';
    ix.stallClearsAt        = null;
    ix.barrierHold = (holdSince == null) ? null
        : { block: 1001, reason: 'attest_response_sync_barrier', since: now - holdSince, notified: false };
    return ix;
}

let server = null, port = null;

function serve(ix){
    let app = express();
    mountStatusRoute(app, { indexer: ix, XChainIndexer });
    return new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
    });
}

function closeServer(done){
    let s = server;
    server = null;
    s ? s.close(done) : done();
}

describe('GET /status wedge window starts at the barrier hold', function(){
    afterEach(closeServer);

    it('answers 200 for a 60 s barrier wait after a 21 minute commit gap', async function(){
        await serve(heldIndexer(60 * 1000));
        let status = await get(port, '/status');
        assert.strictEqual(status.status, 200);
        assert.strictEqual(status.body.stallClass, 'barrier_defer');
        assert.strictEqual(status.body.ready, true);
        let ready = await get(port, '/ready');
        assert.strictEqual(ready.status, 200);
    });

    it('answers 503 for a block held 5 minutes with no commit', async function(){
        await serve(heldIndexer(5 * MIN));
        let status = await get(port, '/status');
        assert.strictEqual(status.status, 503);
        assert.strictEqual(status.body.stallClass, 'wedged');
        assert.ok(status.body.notReadyReasons.includes('wedged'));
        let ready = await get(port, '/ready');
        assert.strictEqual(ready.status, 503);
    });

    it('answers 503 with no recorded hold, measuring from the last commit as before', async function(){
        await serve(heldIndexer(null));
        let status = await get(port, '/status');
        assert.strictEqual(status.status, 503);
        assert.strictEqual(status.body.stallClass, 'wedged');
    });
});

describe('advanceFields() wedge window starts at the barrier hold', function(){
    it('reads a fresh hold as degraded, not wedged', function(){
        let ix = heldIndexer(60 * 1000);
        let fields = advanceFields(ix, Date.now());
        assert.strictEqual(fields.degraded, true);
        assert.strictEqual(fields.stallClass, 'barrier_defer');
    });

    it('reads a 5 minute hold as wedged', function(){
        let ix = heldIndexer(5 * MIN);
        let fields = advanceFields(ix, Date.now());
        assert.strictEqual(fields.degraded, false);
        assert.strictEqual(fields.stallClass, 'wedged');
    });
});
