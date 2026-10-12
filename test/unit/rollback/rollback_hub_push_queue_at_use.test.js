// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer } = require('../../fixtures/mocks');

const Rollback = require('../../../src/rollback/index.js');

// XChainIndexer builds Rollback in buildBlockModules() and only later creates the
// hub-push queue in startBackgroundServices(), so these tests attach the queue AFTER
// construction, in that same order, and expect the retraction block to quiesce it.

function hubClientFailingPrice(order){
    return {
        enabled: true,
        retractPriceRange: sinon.stub().callsFake(async () => { order.push('retract'); throw new Error('hub down'); }),
        retractXcallRange: sinon.stub().resolves(),
        retractMatchRange: sinon.stub().resolves(),
        retractBridgeRange: sinon.stub().resolves()
    };
}

describe('Rollback hub-push queue resolved at use @regression @tier3', function () {
    it('pauses and resumes a queue the indexer attaches after Rollback is constructed', async function () {
        const order = [];
        const idx = createMockIndexer({ hubClient: hubClientFailingPrice(order) });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        idx.indexerDb.enqueueHubPush = sinon.stub().resolves();
        delete idx.hubPushQueue;
        const rb = new Rollback(idx);
        idx.util.resetLists();
        const queue = {
            pause:  sinon.stub().callsFake(async () => { order.push('pause'); }),
            resume: sinon.stub().callsFake(() => { order.push('resume'); })
        };
        idx.hubPushQueue = queue;
        idx.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        idx.indexerDb.doQuery.resolves([]);
        await assert.doesNotReject(() => rb.rollback(100));
        assert.strictEqual(queue.pause.callCount, 1, 'pause called once');
        assert.strictEqual(queue.resume.callCount, 1, 'resume called once');
        assert.deepStrictEqual(order, ['pause', 'retract', 'resume']);
    });

    it('still attempts live retraction delivery when no queue is ever attached', async function () {
        const order = [];
        const hubClient = hubClientFailingPrice(order);
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        idx.indexerDb.enqueueHubPush = sinon.stub().resolves();
        delete idx.hubPushQueue;
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        idx.indexerDb.doQuery.resolves([]);
        await assert.doesNotReject(() => rb.rollback(100));
        assert.ok(hubClient.retractPriceRange.calledOnce, 'live price retraction attempted');
        assert.deepStrictEqual(order, ['retract']);
    });
});
