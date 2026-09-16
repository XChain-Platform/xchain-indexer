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
// bridge_transfers retraction signal, wired beside the price, XCALL and DEX ones in
// hub_retractions.test.js. An orphaned XBRIDGE lock whose transfer stays 'finalized'
// on the hub would mint on the destination chain from a lock no longer on this chain,
// so the rollback has to stage and deliver a fourth range retraction identically.

// A rollback over a mock indexer whose hub client answers every retraction rail.
function makeBridgeRollback(hubClientOverrides){
    const hubClient = Object.assign({
        enabled: true,
        retractPriceRange:  sinon.stub().resolves(),
        retractXcallRange:  sinon.stub().resolves(),
        retractMatchRange:  sinon.stub().resolves(),
        retractBridgeRange: sinon.stub().resolves()
    }, hubClientOverrides || {});
    const idx = createMockIndexer({ hubClient });
    idx.protocolChanges = { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) };
    const rb = new Rollback(idx);
    idx.util.resetLists();
    return { hubClient, idx, rb };
}

// The first read is the lowest orphaned action_index, the second its MAX (the closed-range ceiling).
function orphanRange(idx, first, last){
    idx.indexerDb.doQuery.onFirstCall().resolves([{ action_index: first }]);
    if(last !== undefined) idx.indexerDb.doQuery.onSecondCall().resolves([{ last_action_index: last }]);
    idx.indexerDb.doQuery.resolves([]);
}

describe('Rollback @regression @tier3', function () {

    // ─── Hub bridge (bridge_transfers) retraction signal ──────────────

    it('signals the hub to retract bridge transfers for the rolled-back range (live: open-ended, generation-fenced)', async function () {
        const { hubClient, idx, rb } = makeBridgeRollback();
        orphanRange(idx, 158, 159);
        await rb.rollback(2660);
        assert.ok(hubClient.retractBridgeRange.calledOnce, 'expected retractBridgeRange to be called once');
        // The mock bump returns 1, so the pre-bump generation threaded as the fence is 0.
        assert.deepStrictEqual(hubClient.retractBridgeRange.firstCall.args, [rb.config['COIN'], 158, null, 0],
            'live bridge retraction is open-ended and carries the pre-bump generation, like the other three');
    });

    it('write-aheads a durable closed-range bridge_retraction row beside the other three, inside the tx', async function () {
        const { idx, rb } = makeBridgeRollback();
        orphanRange(idx, 158, 159);
        await rb.rollback(2660);
        const stage = idx.indexerDb.enqueueHubPushTx.getCalls().find(c => c.args[0] === 'bridge_retraction');
        assert.ok(stage, 'a durable bridge_retraction row must be write-ahead-staged');
        assert.deepStrictEqual(stage.args[1], { coin: rb.config['COIN'], action_index: 158, last_action_index: 159, retraction_generation: 0 });
        const matchStage = idx.indexerDb.enqueueHubPushTx.getCalls().find(c => c.args[0] === 'match_retraction');
        assert.deepStrictEqual(stage.args[1], matchStage.args[1], 'same closed range and generation as the match retraction');
        assert.ok(stage.calledBefore(idx.indexerDb.commitTransaction.getCall(0)), 'staged inside the transaction (before commit)');
    });

    it('does NOT signal the hub for bridge retraction when the range is empty', async function () {
        const { hubClient, idx, rb } = makeBridgeRollback();
        idx.indexerDb.doQuery.resolves([]);
        await rb.rollback(100);
        assert.ok(hubClient.retractBridgeRange.notCalled, 'expected no bridge retraction when range is empty');
        assert.ok(!idx.indexerDb.enqueueHubPushTx.getCalls().some(c => c.args[0] === 'bridge_retraction'),
            'no range means no durable row either');
    });
});

describe('Rollback @regression @tier3', function () {

    it('leaves the durable bridge_retraction row for HubPushQueue when the live RPC fails; local rollback still commits', async function () {
        const { idx, rb } = makeBridgeRollback({ retractBridgeRange: sinon.stub().rejects(new Error('hub unreachable')) });
        orphanRange(idx, 158);
        await assert.doesNotReject(() => rb.rollback(2660));
        assert.ok(idx.indexerDb.commitTransaction.calledOnce, 'local rollback should still commit');
        const stage = idx.indexerDb.enqueueHubPushTx.getCalls().find(c => c.args[0] === 'bridge_retraction');
        const bridgeId = await stage.returnValue;
        assert.ok(!idx.indexerDb.markHubPushDelivered.getCalls().some(c => c.args[0] === bridgeId),
            'a failed live bridge delivery must leave the durable row for HubPushQueue');
        // The sibling rows delivered fine and were dropped, so the failure is isolated to its own row.
        assert.ok(idx.indexerDb.markHubPushDelivered.getCalls().length >= 3, 'the other three retractions still drop their rows');
    });

    it('drops the durable bridge_retraction row once the live RPC succeeds', async function () {
        const { idx, rb } = makeBridgeRollback();
        orphanRange(idx, 158);
        await rb.rollback(2660);
        const stage = idx.indexerDb.enqueueHubPushTx.getCalls().find(c => c.args[0] === 'bridge_retraction');
        const bridgeId = await stage.returnValue;
        assert.ok(idx.indexerDb.markHubPushDelivered.getCalls().some(c => c.args[0] === bridgeId),
            'a delivered bridge retraction drops its durable row');
    });

    it('never purges a durable bridge_retraction row on a deeper nested reorg', async function () {
        const { idx, rb } = makeBridgeRollback();
        orphanRange(idx, 158);
        await rb.rollback(2660);
        const purge = idx.indexerDb.doQuery.getCalls().find(c => /DELETE FROM pending_hub_pushes/.test(String(c.args[0])));
        assert.ok(purge, 'the generic purge must still run');
        assert.match(String(purge.args[0]), /NOT IN \([^)]*'bridge_retraction'[^)]*\)/,
            'a deeper reorg purging this row would strand a finalized transfer whose lock is no longer on chain');
    });
});
