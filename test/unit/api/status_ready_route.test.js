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
 * Unit: GET /status keeps its liveness status code while GET /ready reports
 * readiness, driven through the real mountStatusRoute over a real indexer
 * instance with stub databases and a stub utxo tracker.
 *
 * Two faults read healthy on /status and must read 503 on /ready:
 *   - the indexer is frozen behind a REORG-halted decoder. The decoder tip froze
 *     at the halted height, so `lag` reads 0; only the coin node tip shows how far
 *     behind it is.
 *   - a block held behind a proof barrier past its ceiling, with no commit since a
 *     restart, so stallWedged() (and the 503 the container healthcheck reads)
 *     never fires.
 * /status must stay 200 for both: autoheal restarts on its 503, and a restart
 * fixes neither.
 */

'use strict';

const assert  = require('assert');
const http    = require('http');
const express = require('express');

const XChainIndexer = require('../../../src/XChainIndexer.js');
const { mountStatusRoute } = require('../../../src/api/status_endpoint.js');

const MIN = 60 * 1000;

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

// A real indexer instance whose databases and tracker answer fixed heights.
function stubIndexer({ indexerBlock, decoderBlock, nodeHeight }){
    let indexer = new XChainIndexer();
    indexer.indexerDb   = { getLatestBlockIndex: async () => indexerBlock };
    indexer.decoderDb   = { getBlockIndex: async () => decoderBlock };
    indexer.utxoTracker = (nodeHeight === undefined) ? null
        : { enabled: true, getSyncStatus: async () => ({ node_height: nodeHeight }) };
    indexer.lastPollAt  = Date.now();
    return indexer;
}

// One listener per case, closed after it.
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

describe('GET /status and GET /ready on a healthy indexer', function(){
    afterEach(closeServer);

    it('answers 200 on both for a caught-up indexer, with chainLag beside lag', async function(){
        let ix = stubIndexer({ indexerBlock: 900, decoderBlock: 900, nodeHeight: 900 });
        ix.lastBlockCommittedAt = Date.now() - 5000;
        await serve(ix);
        let status = await get(port, '/status');
        let ready  = await get(port, '/ready');
        assert.strictEqual(status.status, 200);
        assert.strictEqual(ready.status, 200);
        assert.strictEqual(status.body.lag, 0);
        assert.strictEqual(status.body.chainTip, 900);
        assert.strictEqual(status.body.chainTipSource, 'utxo_tracker');
        assert.strictEqual(status.body.chainLag, 0);
        assert.strictEqual(status.body.ready, true);
        assert.deepStrictEqual(status.body.notReadyReasons, []);
    });

    it('keeps every key /status already carried, in order, with the new ones after stallClass', async function(){
        let ix = stubIndexer({ indexerBlock: 10, decoderBlock: 10, nodeHeight: 10 });
        await serve(ix);
        let keys = Object.keys((await get(port, '/status')).body);
        let at = keys.indexOf('stallClass');
        assert.deepStrictEqual(keys.slice(at, at + 11), ['stallClass', 'chainTip', 'chainTipSource', 'chainTipAt',
            'chainLag', 'decoderReorgHalted', 'barrierHoldMs', 'barrierHoldCeilingMs', 'barrierCeilingExceeded',
            'ready', 'notReadyReasons']);
        assert.strictEqual(keys[at + 11], 'lastBlockCommittedAt');
    });
});

describe('GET /status and GET /ready on faults a restart cannot clear', function(){
    afterEach(closeServer);

    it('reports an indexer frozen behind a halted decoder: /status 200 with lag 0, /ready 503', async function(){
        let ix = stubIndexer({ indexerBlock: 5000, decoderBlock: 5000, nodeHeight: 5240 });
        ix.decoderReorgHalted   = true;
        ix.synced               = true;     // level with the decoder's frozen tip
        ix.lastBlockCommittedAt = Date.now() - 20 * 60 * MIN;
        await serve(ix);
        let status = await get(port, '/status');
        assert.strictEqual(status.status, 200, 'liveness is unchanged: a restart cannot clear a REORG_HALT');
        assert.strictEqual(status.body.lag, 0, 'lag keeps its decoder-relative meaning');
        assert.strictEqual(status.body.chainLag, 240);
        assert.strictEqual(status.body.decoderReorgHalted, true);
        assert.strictEqual(status.body.isSynced, false, 'level with a stopped decoder is not synced');
        assert.strictEqual(status.body.stallClass, 'upstream_halted');
        assert.match(status.body.stallReason, /^decoder_reorg_halt:/);
        assert.strictEqual(status.body.ready, false);
        let ready = await get(port, '/ready');
        assert.strictEqual(ready.status, 503);
        assert.deepStrictEqual(ready.body.notReadyReasons, ['decoder_reorg_halt', 'behind_tip_no_commit']);
    });

    it('reports a held block that survived a restart: /status 200, /ready 503 past the ceiling', async function(){
        let ix = stubIndexer({ indexerBlock: 1000, decoderBlock: 4800 });
        let now = Date.now();
        ix.startedAt            = now - 2 * 60 * MIN;
        ix.lastBlockCommittedAt = null;
        ix.stallReason          = 'rollcall_proof_unavailable';
        ix.barrierHoldCeilingMs = 60 * 1000;
        ix.barrierHold          = { block: 1001, reason: 'rollcall_proof_unavailable', since: now - 2 * 60 * MIN, notified: true };
        await serve(ix);
        let status = await get(port, '/status');
        assert.strictEqual(status.status, 200);
        assert.strictEqual(status.body.stallClass, 'rollcall_proof_stuck');
        assert.strictEqual(status.body.stallReason, 'rollcall_proof_unavailable');
        assert.strictEqual(status.body.barrierCeilingExceeded, true);
        assert.ok(status.body.barrierHoldMs >= 2 * 60 * MIN - 1000);
        assert.strictEqual(status.body.chainTip, null, 'no tracker configured, so no chain tip');
        let ready = await get(port, '/ready');
        assert.strictEqual(ready.status, 503);
        assert.deepStrictEqual(ready.body.notReadyReasons, ['barrier_ceiling_exceeded', 'behind_tip_no_commit']);
    });
});
