// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// The price retraction names the round window of every valid PRICE batch a reorg rolls
// back. A hub that finalized every round of a batch itself holds no row stored from it,
// so the window is the only way that hub can find the rounds whose landing clock the
// batch stamped. Read in the read phase (the purge deletes the prices rows), staged in
// the durable price_retraction row, sent on the live delivery, forwarded by the queue
// drain and put on the wire by HubClient.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer } = require('../../../fixtures/mocks');
const Rollback = require('../../../../src/rollback/index.js');
const HubClient = require('../../../../src/hub/hub_client.js');
const HubPushQueue = require('../../../../src/hub/hub_push_queue.js');
const { makeIndexer, makeRow } = require('../../hub/hub_push_queue.test/helpers/fixtures.js');

const BATCH_ROWS = [
    { action_index: 52, batch_first_round: '200', batch_last_round: '201' },
    { action_index: 60, batch_first_round: 202, batch_last_round: 205 }
];
const WINDOWS = [{ first_round: 200, last_round: 201 }, { first_round: 202, last_round: 205 }];

function hubClientStub(rejectPrice) {
    return {
        enabled: true,
        retractPriceRange: rejectPrice ? sinon.stub().rejects(new Error('hub unreachable')) : sinon.stub().resolves(),
        retractXcallRange: sinon.stub().resolves(),
        retractMatchRange: sinon.stub().resolves(),
        retractBridgeRange: sinon.stub().resolves()
    };
}

// A rolled-back range [50, 75] whose prices rows hold `batchRows`.
function rollbackOver(hubClient, batchRows) {
    const idx = createMockIndexer({ hubClient });
    idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
    const rb = new Rollback(idx);
    idx.util.resetLists();
    let reads = [];
    idx.indexerDb.doQuery.callsFake(async (sql, args) => {
        sql = String(sql);
        if (/last_action_index/.test(sql)) return [{ last_action_index: 75 }];
        if (/^SELECT\s+a\.action_index\s+FROM\s+actions a/.test(sql)) return [{ action_index: 50 }];
        if (/FROM prices/.test(sql) && /batch_first_round/.test(sql) && /action_index >= \?/.test(sql)) {
            reads.push(['prices', args]);
            return batchRows;
        }
        return [];
    });
    return { idx, rb, reads };
}

function priceStage(idx) {
    const call = idx.indexerDb.enqueueHubPushTx.getCalls().find(c => c.args[0] === 'price_retraction');
    return call && call.args[1];
}

describe('Rollback price retraction batch windows @regression @tier3', function () {
    afterEach(function () { sinon.restore(); });

    it('reads the rolled-back PRICE batch windows before the purge and stages them on the price retraction only', async function () {
        const hubClient = hubClientStub(false);
        const { idx, rb, reads } = rollbackOver(hubClient, BATCH_ROWS);
        await rb.rollback(100);

        assert.ok(reads.some(r => Array.isArray(r) && r[0] === 'prices' && r[1][0] === 50),
            'the batch window read binds the first rolled-back action');
        assert.deepStrictEqual(priceStage(idx).batches, WINDOWS);
        for (const t of ['xcall_retraction', 'match_retraction', 'bridge_retraction']) {
            const payload = idx.indexerDb.enqueueHubPushTx.getCalls().find(c => c.args[0] === t).args[1];
            assert.ok(!('batches' in payload), t + ' carries no batch windows');
        }
        // The live delivery sends the same windows, open-ended and generation-fenced as before.
        const args = hubClient.retractPriceRange.firstCall.args;
        assert.strictEqual(args[1], 50);
        assert.strictEqual(args[2], null);
        assert.deepStrictEqual(args[4], WINDOWS);
    });

    it('stages no batches key when the rolled-back range holds no PRICE batch', async function () {
        const hubClient = hubClientStub(false);
        const { idx, rb } = rollbackOver(hubClient, []);
        await rb.rollback(100);
        assert.ok(!('batches' in priceStage(idx)));
        assert.strictEqual(hubClient.retractPriceRange.firstCall.args[4], undefined);
    });

    it('keeps the windows on the durable row when the live delivery fails, and the queue drain forwards them', async function () {
        const hubClient = hubClientStub(true);
        const { idx, rb } = rollbackOver(hubClient, BATCH_ROWS);
        await rb.rollback(100);
        const payload = priceStage(idx);
        assert.deepStrictEqual(payload.batches, WINDOWS);

        const indexer = makeIndexer();
        const q = new HubPushQueue(indexer);
        await q.attempt(makeRow({ id: 31, push_type: 'price_retraction', payload: JSON.stringify(payload) }));
        assert.deepStrictEqual(indexer.hubClient.retractPriceRange.firstCall.args,
            ['BTC', 50, 75, payload.retraction_generation, WINDOWS]);
    });

    it('HubClient puts the windows on pushpricereorg, and omits an empty list', async function () {
        const c = new HubClient('http://hub.example.com', '');
        const callStub = sinon.stub(c, 'call').resolves({});
        await c.retractPriceRange('DOGE', 50, 75, 3, WINDOWS);
        assert.strictEqual(callStub.firstCall.args[0], 'pushpricereorg');
        assert.deepStrictEqual(callStub.firstCall.args[1].batches, WINDOWS);
        await c.retractPriceRange('DOGE', 50, 75, 3, []);
        assert.ok(!('batches' in callStub.secondCall.args[1]));
    });
});
