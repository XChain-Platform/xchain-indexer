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
const { createMockIndexer } = require('../../../fixtures/mocks');

const Rollback = require('../../../../src/rollback/index.js');

// Part of the Rollback suite whose entry is test/unit/rollback.test.js: the hub
// retraction signals for prices, cross-chain calls and DEX matches, their durable
// write-ahead rows, the generation fence and the hub-push quiesce, plus the
// transaction wrapping of a successful rollback. The suite title is the entry's,
// so every full test title is unchanged.

let indexer, rollback;

describe('Rollback @regression @tier3', function () {
    beforeEach(function () {
        indexer = createMockIndexer();
        // Rollback itself deliberately holds NO protocolChanges handle (see the constructor:
        // there is no unambiguous local height to gate on mid-unwind). The stub stands in for
        // the shared indexer surface the modules a rollback drives read off it.
        indexer.protocolChanges = {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        };
        rollback = new Rollback(indexer);
        indexer.util.resetLists();
    });

    // ─── Hub price retraction signal ──────────────────────────────────

    it('signals the hub to retract prices for the rolled-back range', async function () {
        const hubClient = { enabled: true, retractPriceRange: sinon.stub().resolves(), retractXcallRange: sinon.stub().resolves(), retractMatchRange: sinon.stub().resolves(), retractBridgeRange: sinon.stub().resolves() };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        const rb = new Rollback(idx);
        idx.util.resetLists();
        // First query returns an action_index so the rollback has an orphaned range
        idx.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        idx.indexerDb.doQuery.resolves([]);
        await rb.rollback(100);
        assert.ok(hubClient.retractPriceRange.calledOnce, 'expected retractPriceRange to be called once');
        assert.strictEqual(hubClient.retractPriceRange.firstCall.args[0], rb.config['COIN']);
        assert.strictEqual(hubClient.retractPriceRange.firstCall.args[1], 50);
    });

    it('does NOT signal the hub when there are no actions in the rolled-back range', async function () {
        const hubClient = { enabled: true, retractPriceRange: sinon.stub().resolves(), retractXcallRange: sinon.stub().resolves(), retractMatchRange: sinon.stub().resolves(), retractBridgeRange: sinon.stub().resolves() };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.resolves([]); // no action_index found
        await rb.rollback(100);
        assert.ok(hubClient.retractPriceRange.notCalled, 'expected no retraction when range is empty');
    });

    it('does not throw when the hub retraction fails (best-effort)', async function () {
        const hubClient = { enabled: true, retractPriceRange: sinon.stub().rejects(new Error('hub unreachable')), retractXcallRange: sinon.stub().resolves(), retractMatchRange: sinon.stub().resolves(), retractBridgeRange: sinon.stub().resolves() };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        idx.indexerDb.doQuery.resolves([]);
        await assert.doesNotReject(() => rb.rollback(100));
        assert.ok(idx.indexerDb.commitTransaction.calledOnce, 'local rollback should still commit');
    });
});

describe('Rollback @regression @tier3', function () {
    beforeEach(function () {
        indexer = createMockIndexer();
        // Rollback itself deliberately holds NO protocolChanges handle (see the constructor:
        // there is no unambiguous local height to gate on mid-unwind). The stub stands in for
        // the shared indexer surface the modules a rollback drives read off it.
        indexer.protocolChanges = {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        };
        rollback = new Rollback(indexer);
        indexer.util.resetLists();
    });

    it('leaves the durable write-ahead price_retraction row when the live RPC fails (HUB-RETRACT-2)', async function () {
        const hubClient = { enabled: true, retractPriceRange: sinon.stub().rejects(new Error('hub unreachable')), retractXcallRange: sinon.stub().resolves(), retractMatchRange: sinon.stub().resolves(), retractBridgeRange: sinon.stub().resolves() };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        // Distinct ids per staged row so we can tell which was delivered.
        let n = 0; idx.indexerDb.enqueueHubPushTx = sinon.stub().callsFake(async () => ++n);
        idx.indexerDb.markHubPushDelivered = sinon.stub().resolves();
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        idx.indexerDb.doQuery.resolves([]);
        await assert.doesNotReject(() => rb.rollback(100));
        // The retraction was write-ahead-staged (durable) as a closed-range price_retraction row.
        const priceStage = idx.indexerDb.enqueueHubPushTx.getCalls().find(c => c.args[0] === 'price_retraction');
        assert.ok(priceStage, 'a durable price_retraction row must be write-ahead-staged');
        assert.strictEqual(priceStage.args[1].coin, rb.config['COIN']);
        assert.strictEqual(priceStage.args[1].action_index, 50);
        // Its row (id 1) must NOT be marked delivered, since the live RPC failed - it stays for the queue.
        assert.ok(!idx.indexerDb.markHubPushDelivered.getCalls().some(c => c.args[0] === 1),
            'a failed live delivery must leave the durable row for HubPushQueue');
    });

    // ─── Closed-range deferred retraction + quiesce (items 5296/5297) ──

    it('write-aheads the durable retraction with last_action_index = MAX of the rolled-back range (closed range)', async function () {
        const hubClient = { enabled: true, retractPriceRange: sinon.stub().rejects(new Error('hub unreachable')), retractXcallRange: sinon.stub().resolves(), retractMatchRange: sinon.stub().resolves(), retractBridgeRange: sinon.stub().resolves() };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);   // firstActionIndex
        idx.indexerDb.doQuery.onSecondCall().resolves([{ last_action_index: 75 }]); // MAX(action_index)
        idx.indexerDb.doQuery.resolves([]);
        await assert.doesNotReject(() => rb.rollback(100));
        const payload = idx.indexerDb.enqueueHubPushTx.getCalls().find(c => c.args[0] === 'price_retraction').args[1];
        assert.strictEqual(payload.action_index, 50);
        assert.strictEqual(payload.last_action_index, 75, 'durable write-ahead retraction must carry the closed-range ceiling');
        // The durable payload also carries the pre-bump generation fence (item 5308); the mock bump
        // returns 1, so the pre-bump value is 0.
        assert.strictEqual(payload.retraction_generation, 0, 'durable write-ahead retraction must carry the generation fence');
    });
});

describe('Rollback @regression @tier3', function () {
    beforeEach(function () {
        indexer = createMockIndexer();
        // Rollback itself deliberately holds NO protocolChanges handle (see the constructor:
        // there is no unambiguous local height to gate on mid-unwind). The stub stands in for
        // the shared indexer surface the modules a rollback drives read off it.
        indexer.protocolChanges = {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        };
        rollback = new Rollback(indexer);
        indexer.util.resetLists();
    });

    it('keeps the LIVE retraction open-ended (no ceiling) so it never under-deletes the orphaned range', async function () {
        const hubClient = { enabled: true, retractPriceRange: sinon.stub().resolves(), retractXcallRange: sinon.stub().resolves(), retractMatchRange: sinon.stub().resolves(), retractBridgeRange: sinon.stub().resolves() };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        idx.indexerDb.doQuery.onSecondCall().resolves([{ last_action_index: 75 }]);
        idx.indexerDb.doQuery.resolves([]);
        await rb.rollback(100);
        // Live call passes (coin, from, null, retractionGeneration): the ceiling is intentionally
        // omitted (open-ended), but the generation fence (item 5308) IS threaded. The mock bump
        // returns 1, so the pre-bump retraction generation is 0.
        assert.strictEqual(hubClient.retractPriceRange.firstCall.args[1], 50);
        assert.strictEqual(hubClient.retractPriceRange.firstCall.args[2], null, 'no closed-range ceiling on the live retraction');
        assert.strictEqual(hubClient.retractPriceRange.firstCall.args[3], 0, 'pre-bump generation threaded as the fence');
    });

    it('bumps the push generation once at rollback start and threads the PRE-bump value (item 5308)', async function () {
        const hubClient = { enabled: true, retractPriceRange: sinon.stub().resolves(), retractXcallRange: sinon.stub().resolves(), retractMatchRange: sinon.stub().resolves(), retractBridgeRange: sinon.stub().resolves() };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        idx.indexerDb.bumpPushGeneration = sinon.stub().resolves(6);   // post-bump generation 6 => pre-bump 5
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        idx.indexerDb.doQuery.resolves([]);
        await rb.rollback(100);
        assert.ok(idx.indexerDb.bumpPushGeneration.calledOnce, 'generation bumped exactly once');
        assert.strictEqual(idx.indexerDb.bumpPushGeneration.firstCall.args[0], rb.config['COIN']);
        // All four range retractions carry the pre-bump generation (5) as the fence.
        assert.strictEqual(hubClient.retractPriceRange.firstCall.args[3], 5);
        assert.strictEqual(hubClient.retractXcallRange.firstCall.args[3], 5);
        assert.strictEqual(hubClient.retractMatchRange.firstCall.args[3], 5);
        assert.strictEqual(hubClient.retractBridgeRange.firstCall.args[3], 5);
    });
});

describe('Rollback @regression @tier3', function () {
    beforeEach(function () {
        indexer = createMockIndexer();
        // Rollback itself deliberately holds NO protocolChanges handle (see the constructor:
        // there is no unambiguous local height to gate on mid-unwind). The stub stands in for
        // the shared indexer surface the modules a rollback drives read off it.
        indexer.protocolChanges = {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        };
        rollback = new Rollback(indexer);
        indexer.util.resetLists();
    });

    it('quiesces the hub-push queue around the retraction block (pause before, resume after, even on throw)', async function () {
        const order = [];
        const hubPushQueue = {
            pause:  sinon.stub().callsFake(() => order.push('pause')),
            resume: sinon.stub().callsFake(() => order.push('resume'))
        };
        // A failing live retraction must still resume() via the finally.
        const hubClient = {
            enabled: true,
            retractPriceRange: sinon.stub().callsFake(async () => { order.push('retract'); throw new Error('hub down'); }),
            retractXcallRange: sinon.stub().resolves(),
            retractMatchRange: sinon.stub().resolves(),
            retractBridgeRange: sinon.stub().resolves()
        };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        idx.indexerDb.enqueueHubPush = sinon.stub().resolves();
        idx.hubPushQueue = hubPushQueue;   // captured by the Rollback constructor
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        idx.indexerDb.doQuery.resolves([]);
        await assert.doesNotReject(() => rb.rollback(100));
        assert.ok(hubPushQueue.pause.calledOnce && hubPushQueue.resume.calledOnce, 'pause + resume each called once');
        assert.ok(order.indexOf('pause') < order.indexOf('retract'), 'pause precedes retraction');
        assert.ok(order.indexOf('retract') < order.indexOf('resume'), 'resume follows retraction');
    });

    // ─── Hub XCALL (cross_chain_calls) retraction signal ──────────────

    it('signals the hub to retract cross-chain calls for the rolled-back range', async function () {
        const hubClient = { enabled: true, retractPriceRange: sinon.stub().resolves(), retractXcallRange: sinon.stub().resolves(), retractMatchRange: sinon.stub().resolves(), retractBridgeRange: sinon.stub().resolves() };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        idx.indexerDb.doQuery.resolves([]);
        await rb.rollback(100);
        assert.ok(hubClient.retractXcallRange.calledOnce, 'expected retractXcallRange to be called once');
        assert.strictEqual(hubClient.retractXcallRange.firstCall.args[0], rb.config['COIN']);
        assert.strictEqual(hubClient.retractXcallRange.firstCall.args[1], 50);
    });
});

describe('Rollback @regression @tier3', function () {
    beforeEach(function () {
        indexer = createMockIndexer();
        // Rollback itself deliberately holds NO protocolChanges handle (see the constructor:
        // there is no unambiguous local height to gate on mid-unwind). The stub stands in for
        // the shared indexer surface the modules a rollback drives read off it.
        indexer.protocolChanges = {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        };
        rollback = new Rollback(indexer);
        indexer.util.resetLists();
    });

    it('does NOT signal the hub for XCALL retraction when the range is empty', async function () {
        const hubClient = { enabled: true, retractPriceRange: sinon.stub().resolves(), retractXcallRange: sinon.stub().resolves(), retractMatchRange: sinon.stub().resolves(), retractBridgeRange: sinon.stub().resolves() };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.resolves([]);
        await rb.rollback(100);
        assert.ok(hubClient.retractXcallRange.notCalled, 'expected no XCALL retraction when range is empty');
    });

    it('does not throw when the hub XCALL retraction fails (best-effort); local rollback still commits', async function () {
        const hubClient = { enabled: true, retractPriceRange: sinon.stub().resolves(), retractXcallRange: sinon.stub().rejects(new Error('hub unreachable')), retractMatchRange: sinon.stub().resolves(), retractBridgeRange: sinon.stub().resolves() };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        idx.indexerDb.doQuery.resolves([]);
        await assert.doesNotReject(() => rb.rollback(100));
        assert.ok(idx.indexerDb.commitTransaction.calledOnce, 'local rollback should still commit');
    });

    // ─── Hub DEX (cross_chain_matches) retraction signal ──────────────

    it('signals the hub to retract cross-chain matches for the rolled-back range', async function () {
        const hubClient = { enabled: true, retractPriceRange: sinon.stub().resolves(), retractXcallRange: sinon.stub().resolves(), retractMatchRange: sinon.stub().resolves(), retractBridgeRange: sinon.stub().resolves() };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        idx.indexerDb.doQuery.resolves([]);
        await rb.rollback(100);
        assert.ok(hubClient.retractMatchRange.calledOnce, 'expected retractMatchRange to be called once');
        assert.strictEqual(hubClient.retractMatchRange.firstCall.args[0], rb.config['COIN']);
        assert.strictEqual(hubClient.retractMatchRange.firstCall.args[1], 50);
    });
});

describe('Rollback @regression @tier3', function () {
    beforeEach(function () {
        indexer = createMockIndexer();
        // Rollback itself deliberately holds NO protocolChanges handle (see the constructor:
        // there is no unambiguous local height to gate on mid-unwind). The stub stands in for
        // the shared indexer surface the modules a rollback drives read off it.
        indexer.protocolChanges = {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        };
        rollback = new Rollback(indexer);
        indexer.util.resetLists();
    });

    it('does NOT signal the hub for DEX match retraction when the range is empty', async function () {
        const hubClient = { enabled: true, retractPriceRange: sinon.stub().resolves(), retractXcallRange: sinon.stub().resolves(), retractMatchRange: sinon.stub().resolves(), retractBridgeRange: sinon.stub().resolves() };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.resolves([]);
        await rb.rollback(100);
        assert.ok(hubClient.retractMatchRange.notCalled, 'expected no DEX match retraction when range is empty');
    });

    it('does not throw when the hub DEX match retraction fails (best-effort); local rollback still commits', async function () {
        const hubClient = { enabled: true, retractPriceRange: sinon.stub().resolves(), retractXcallRange: sinon.stub().resolves(), retractMatchRange: sinon.stub().rejects(new Error('hub unreachable')), retractBridgeRange: sinon.stub().resolves() };
        const idx = createMockIndexer({ hubClient });
        idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
        const rb = new Rollback(idx);
        idx.util.resetLists();
        idx.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        idx.indexerDb.doQuery.resolves([]);
        await assert.doesNotReject(() => rb.rollback(100));
        assert.ok(idx.indexerDb.commitTransaction.calledOnce, 'local rollback should still commit');
    });

    // ─── Transaction wrapping ─────────────────────────────────────────

    it('calls beginTransaction at the start of rollback', async function () {
        // Return no action_indexes so the DELETE phase is minimal
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        assert.ok(indexer.indexerDb.beginTransaction.calledOnce);
    });

    it('calls commitTransaction on success', async function () {
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        assert.ok(indexer.indexerDb.commitTransaction.calledOnce);
    });

    it('does NOT call rollbackTransaction on success', async function () {
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        assert.ok(indexer.indexerDb.rollbackTransaction.notCalled);
    });
});
