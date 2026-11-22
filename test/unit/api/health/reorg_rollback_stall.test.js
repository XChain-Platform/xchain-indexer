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
 * Unit: /status and the health payload grade a running reorg rollback from its own start,
 * through the real mountStatusRoute and advanceFields over a real indexer instance.
 *
 * A rollback is one transaction inside one poll pass, so no commit and no barrier hold
 * exist while it runs. Timed from the last commit it answered 503 on its first probe,
 * and a stale future-wait deadline from the previous pass made it read as a healthy
 * future-block wait instead. These cases pin the wiring in the callers, where a dropped
 * argument would silently restore either reading.
 */

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert  = require('assert');
const http    = require('http');
const express = require('express');

const XChainIndexer = require('../../../../src/XChainIndexer.js');
const { mountStatusRoute } = require('../../../../src/api/status_endpoint.js');
const { advanceFields } = require('../../../../src/api/health/advance_fields.js');
const Rollback = require('../../../../src/rollback/index.js');

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

// A real indexer level with its decoder whose last commit is 30 minutes old and whose
// previous pass left a future-wait deadline 40 minutes ahead.
function indexerInPass(){
    const now = Date.now();
    const ix = new XChainIndexer();
    ix.indexerDb   = { getLatestBlockIndex: async () => 1000 };
    ix.decoderDb   = { getBlockIndex: async () => 1000 };
    ix.utxoTracker = null;
    ix.lastPollAt  = now;
    ix.decoderReorgHalted = false;
    ix.healthStallGraceMs   = 2 * MIN;
    ix.rollbackGraceMs      = 10 * MIN;
    ix.barrierHoldCeilingMs = 15 * MIN;
    ix.lastBlockCommittedAt = now - 30 * MIN;
    ix.stallReason          = 'price_sync_barrier';
    ix.stallBlock           = 1001;
    ix.stallClearsAt        = now + 40 * MIN;
    ix.futureWaitClearsAt   = { block: 1001, at: ix.stallClearsAt };
    return ix;
}

// The state a rollback leaves for the rest of the pass, entered the way rollback() enters it.
function enterRollback(ix, startedAt){
    Rollback.prototype.markRollbackStall.call({ indexer: ix }, startedAt);
}

let server = null, port = null;

function serve(ix){
    const app = express();
    mountStatusRoute(app, { indexer: ix, XChainIndexer });
    return new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
    });
}

function closeServer(done){
    const s = server;
    server = null;
    s ? s.close(done) : done();
}

describe('GET /status grades a running reorg rollback from its own start', function(){
    afterEach(closeServer);

    it('answers 200 barrier_defer for a rollback that started a second ago after a stale future wait', async function(){
        const ix = indexerInPass();
        enterRollback(ix, Date.now() - 1000);
        await serve(ix);
        const status = await get(port, '/status');
        assert.strictEqual(status.status, 200);
        assert.strictEqual(status.body.waitingOnFutureBlock, false);
        assert.strictEqual(status.body.stallClass, 'barrier_defer');
        assert.strictEqual(status.body.stallClearsAt, null);
        assert.ok(!status.body.notReadyReasons.includes('wedged'));
    });

    it('keeps answering 200 for a rollback running past the stall grace', async function(){
        const ix = indexerInPass();
        enterRollback(ix, Date.now() - 5 * MIN);
        await serve(ix);
        const status = await get(port, '/status');
        assert.strictEqual(status.status, 200);
        assert.strictEqual(status.body.stallClass, 'barrier_defer');
    });

    it('answers 503 for a rollback that outlasts its own grace', async function(){
        const ix = indexerInPass();
        enterRollback(ix, Date.now() - 11 * MIN);
        await serve(ix);
        const status = await get(port, '/status');
        assert.strictEqual(status.status, 503);
        assert.strictEqual(status.body.stallClass, 'wedged');
    });

    it('control: without the rollback start the same state answers 503 from the last commit', async function(){
        const ix = indexerInPass();
        enterRollback(ix, Date.now() - 1000);
        ix.rollbackStartedAt = null;
        await serve(ix);
        const status = await get(port, '/status');
        assert.strictEqual(status.status, 503);
        assert.strictEqual(status.body.stallClass, 'wedged');
    });

    it('control: a stale rollback start does not shield a later barrier stall', async function(){
        const ix = indexerInPass();
        ix.stallClearsAt = null;
        ix.futureWaitClearsAt = null;
        ix.rollbackStartedAt = Date.now() - 1000;
        await serve(ix);
        const status = await get(port, '/status');
        assert.strictEqual(status.status, 503);
        assert.strictEqual(status.body.stallClass, 'wedged');
    });

    it('control: the stale deadline alone still reads as a future-block wait', async function(){
        await serve(indexerInPass());
        const status = await get(port, '/status');
        assert.strictEqual(status.status, 200);
        assert.strictEqual(status.body.stallClass, 'future_block_wait');
    });
});

describe('advanceFields() grades a running reorg rollback from its own start', function(){
    it('reads a fresh rollback as degraded barrier_defer', function(){
        const ix = indexerInPass();
        enterRollback(ix, Date.now() - 1000);
        const fields = advanceFields(ix, Date.now());
        assert.strictEqual(fields.degraded, true);
        assert.strictEqual(fields.waitingOnFutureBlock, false);
        assert.strictEqual(fields.stallClass, 'barrier_defer');
    });

    it('reads a rollback past its own grace as wedged', function(){
        const ix = indexerInPass();
        enterRollback(ix, Date.now() - 11 * MIN);
        const fields = advanceFields(ix, Date.now());
        assert.strictEqual(fields.degraded, false);
        assert.strictEqual(fields.stallClass, 'wedged');
    });
});

describe('a constructed indexer carries the rollback window state', function(){
    it('starts with no rollback running and a rollback grace above the stall grace', function(){
        const ix = new XChainIndexer();
        assert.strictEqual(ix.rollbackStartedAt, null);
        assert.ok(ix.rollbackGraceMs > ix.healthStallGraceMs);
    });
});
