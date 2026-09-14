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
 * test/unit/actions/vote_invariants.test.js
 *
 * Regression coverage for the four VOTE governance invariants that had zero
 * tests: escrow conservation in settleDeposit
 * (including idempotency) and binding-callback firing/metering. Delegation
 * precedence and quadratic/dust-floor weighting are covered separately in
 * test/unit/votes_tally_invariants.test.js.
 *
 * This file holds the escrow-conservation and binding-callback blocks. The
 * three flag days (VOTE_POLL_TICK_VISIBLE, VOTE_BINDING_MINIMUMS and
 * VOTE_CALLBACK_TIMELOCK) live beside it in vote_invariants.test/, each opening
 * the same describe title so every full test title is unchanged;
 * vote_invariants.test/helpers/vote_fixtures.js builds the mock handler and the
 * poll row they share.
 */

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createBaseData } = require('../../fixtures/mocks');
const { freshVote, poll } = require('./vote_invariants.test/helpers/vote_fixtures.js');

let indexer, handler, executeStub, gas, donate1;

function freshHandler() {
    ({ indexer, handler, executeStub, gas, donate1 } = freshVote());
}

function restoreStubs() {
    sinon.restore();
}

describe('Vote invariants (escrow conservation + callback metering) @regression @tier1', function () {
    beforeEach(freshHandler);
    afterEach(restoreStubs);

    describe('_settleDeposit escrow conservation', function () {
        it('finalized win: refunds the whole hold (deposit + gas_escrow) to the creator, net zero', async function () {
            const p    = poll();
            const data = createBaseData({ ACTION: 'VOTE', FORMAT: 2, ACTION_INDEX: 100 });

            await handler.settleDeposit(p, data, 'finalized');

            assert.ok(indexer.indexerDb.createEscrow.calledOnce, 'one combined escrow release row');
            const [, escTick, escAmount, escAddr] = indexer.indexerDb.createEscrow.firstCall.args;
            assert.strictEqual(escTick, gas);
            assert.strictEqual(Number(String(escAmount)), -120, 'negative escrow releases the full 100+20 hold');
            assert.strictEqual(escAddr, 'creatorAddr');

            // Conservation: credits issued must sum to exactly the released hold (120),
            // all routed to the creator on a real (non-failed_quorum) outcome.
            const creditSum = indexer.indexerDb.createCredit.getCalls()
                .reduce((sum, c) => sum + Number(String(c.args[2])), 0);
            assert.strictEqual(creditSum, 120, 'credits must conserve the released escrow exactly');
            for (const c of indexer.indexerDb.createCredit.getCalls())
                assert.strictEqual(c.args[3], 'creatorAddr', 'refund case: every credit leg goes to the creator');

            assert.ok(indexer.indexerDb.setPollDepositResolved.calledOnceWith(100, 'refunded'));
        });

        it('failed_quorum: forfeits the DEPOSIT to DONATE1 but still refunds gas_escrow to the creator, net zero', async function () {
            const p    = poll();
            const data = createBaseData({ ACTION: 'VOTE', FORMAT: 2, ACTION_INDEX: 100 });

            await handler.settleDeposit(p, data, 'failed_quorum');

            const [, , escAmount] = indexer.indexerDb.createEscrow.firstCall.args;
            assert.strictEqual(Number(String(escAmount)), -120, 'the full 100+20 hold is still released');

            const credits = indexer.indexerDb.createCredit.getCalls().map(c => c.args);
            const toDonate = credits.filter(c => c[3] === donate1);
            const toCreator = credits.filter(c => c[3] === 'creatorAddr');
            assert.strictEqual(toDonate.length, 1, 'the deposit leg forfeits to DONATE1');
            assert.strictEqual(Number(String(toDonate[0][2])), 100, 'exactly the deposit amount is forfeited');
            assert.strictEqual(toCreator.length, 1, 'the gas_escrow leg still refunds the creator');
            assert.strictEqual(Number(String(toCreator[0][2])), 20, 'exactly the gas_escrow amount refunds');

            const creditSum = credits.reduce((sum, c) => sum + Number(String(c[2])), 0);
            assert.strictEqual(creditSum, 120, 'forfeit + refund legs still conserve the released escrow exactly');

            assert.ok(indexer.indexerDb.setPollDepositResolved.calledOnceWith(100, 'forfeited'));
        });
    });
});

describe('Vote invariants (escrow conservation + callback metering) @regression @tier1', function () {
    beforeEach(freshHandler);
    afterEach(restoreStubs);

    describe('_settleDeposit escrow conservation', function () {
        it('idempotent: a poll whose deposit is already resolved is a no-op on a reprocessed finalize', async function () {
            const p    = poll({ deposit_resolved: 'refunded' });
            const data = createBaseData({ ACTION: 'VOTE', FORMAT: 2, ACTION_INDEX: 100 });

            await handler.settleDeposit(p, data, 'finalized');

            assert.ok(indexer.indexerDb.createEscrow.notCalled, 'no double release of an already-resolved deposit');
            assert.ok(indexer.indexerDb.createCredit.notCalled);
            assert.ok(indexer.indexerDb.setPollDepositResolved.notCalled);
        });
    });
});

describe('Vote invariants (escrow conservation + callback metering) @regression @tier1', function () {
    beforeEach(freshHandler);
    afterEach(restoreStubs);

    describe('_settleDeposit escrow conservation', function () {
        it('no-op when the poll carried zero deposit and zero gas_escrow', async function () {
            const p    = poll({ deposit_amount: '0', gas_escrow: '0' });
            const data = createBaseData({ ACTION: 'VOTE', FORMAT: 2, ACTION_INDEX: 100 });

            await handler.settleDeposit(p, data, 'finalized');

            assert.ok(indexer.indexerDb.createEscrow.notCalled);
            assert.ok(indexer.indexerDb.setPollDepositResolved.notCalled);
        });
    });
});

function bindingPoll(overrides = {}) {
    return poll({
        callback_contract_index: 5, callback_method: 'onResult',
        callback_params: '[]', callback_on: 'pass',
        ...overrides,
    });
}

function stubFinalize(pollRow, result) {
    indexer.indexerDb.getPoll = sinon.stub().resolves(pollRow);
    indexer.indexerDb.finalizePoll = sinon.stub().resolves(result);
    indexer.indexerDb.createActionIndex = sinon.stub().resolves(200);
}

describe('Vote invariants (escrow conservation + callback metering) @regression @tier1', function () {
    beforeEach(freshHandler);
    afterEach(restoreStubs);

    describe('binding-callback firing / metering (VOTE v2 finalize)', function () {
        it("CALLBACK_ON='pass': fires exactly once on a finalized win, calling the target contract method via EXECUTE", async function () {
            const p = bindingPoll({ poll_status: 'open' });
            stubFinalize(p, { poll_status: 'finalized', winning_option: 1, total_counted_weight: '15', total_voters: 2, quorum_met: true, min_voters_met: true });

            const data = createBaseData({ ACTION: 'VOTE', FORMAT: 2, ACTION_INDEX: null, IS_SYNTHETIC: true });
            await handler.parse(['2', '100'], data, null);

            assert.strictEqual(executeStub.parse.callCount, 1, 'callback must fire exactly once');
            const [actionParams] = executeStub.parse.firstCall.args;
            assert.strictEqual(actionParams[1], 5, 'targets the poll\'s callback_contract_index');
            assert.strictEqual(actionParams[2], 'onResult', 'invokes the poll\'s callback_method');
            assert.strictEqual(actionParams[3], '100', 'poll index is the first callback arg');
            assert.strictEqual(actionParams[4], 'finalized', 'terminal status is passed through');
            assert.strictEqual(actionParams[5], '1', 'winning_option is passed through');
            assert.ok(indexer.indexerDb.setPollCallbackIndex.calledOnceWith(100, 200));
        });

        it("CALLBACK_ON='pass': does NOT fire on failed_quorum", async function () {
            const p = bindingPoll({ poll_status: 'open', callback_on: 'pass' });
            stubFinalize(p, { poll_status: 'failed_quorum', winning_option: null, total_counted_weight: '0', total_voters: 0, quorum_met: false, min_voters_met: false });

            const data = createBaseData({ ACTION: 'VOTE', FORMAT: 2, ACTION_INDEX: null, IS_SYNTHETIC: true });
            await handler.parse(['2', '100'], data, null);

            assert.ok(executeStub.parse.notCalled, "'pass' must not fire when the poll failed quorum");
            assert.ok(indexer.indexerDb.setPollCallbackIndex.notCalled);
        });

        it("CALLBACK_ON='always': fires on failed_quorum too, still exactly once", async function () {
            const p = bindingPoll({ poll_status: 'open', callback_on: 'always' });
            stubFinalize(p, { poll_status: 'failed_quorum', winning_option: null, total_counted_weight: '0', total_voters: 0, quorum_met: false, min_voters_met: false });

            const data = createBaseData({ ACTION: 'VOTE', FORMAT: 2, ACTION_INDEX: null, IS_SYNTHETIC: true });
            await handler.parse(['2', '100'], data, null);

            assert.strictEqual(executeStub.parse.callCount, 1, "'always' must fire even on a failed poll");
            const [actionParams] = executeStub.parse.firstCall.args;
            assert.strictEqual(actionParams[4], 'failed_quorum');
        });
    });
});

describe('Vote invariants (escrow conservation + callback metering) @regression @tier1', function () {
    beforeEach(freshHandler);
    afterEach(restoreStubs);

    describe('binding-callback firing / metering (VOTE v2 finalize)', function () {
        // footgun pin: the binding-poll callback EXECUTE is emitted as a
        // fee-skipped, protocol-ceiling run whose gas is NOT drawn from or bounded
        // by the poll's GAS_ESCROW. The emission carries IS_EMISSION (execute.js
        // skipFee) and deliberately omits VM_GAS_LIMIT, so execute.js falls back to
        // GAS_CEILING rather than an escrow-derived ceiling; gas_escrow always
        // refunds in full (see settleDeposit tests). This locks the documented
        // deferred-metering behavior (ATTEST parity): a future fix that ties the
        // callback's gas ceiling to gas_escrow must set VM_GAS_LIMIT here and will
        // break this test on purpose.
        it('callback EXECUTE is fee-skipped and NOT metered against gas_escrow (IS_EMISSION, no VM_GAS_LIMIT, runs as the contract)', async function () {
            const p = bindingPoll({ poll_status: 'open', gas_escrow: '20' });
            stubFinalize(p, { poll_status: 'finalized', winning_option: 1, total_counted_weight: '15', total_voters: 2, quorum_met: true, min_voters_met: true });

            const data = createBaseData({ ACTION: 'VOTE', FORMAT: 2, ACTION_INDEX: null, IS_SYNTHETIC: true });
            await handler.parse(['2', '100'], data, null);

            assert.strictEqual(executeStub.parse.callCount, 1, 'callback fires exactly once');
            const [, emissionData] = executeStub.parse.firstCall.args;
            const contractRef = 'C:' + indexer.config['CHAIN'] + ':5';
            assert.strictEqual(emissionData.IS_EMISSION, true,
                'IS_EMISSION routes execute.js into its skipFee branch (no gas debit from any wallet)');
            assert.ok(!('VM_GAS_LIMIT' in emissionData),
                'no VM_GAS_LIMIT is passed: execute.js uses the protocol GAS_CEILING, so the callback gas is NOT bounded by gas_escrow');
            assert.strictEqual(emissionData.SOURCE, contractRef,
                'the callback runs AS the target contract, not the poll creator');
            assert.strictEqual(emissionData.FEE_PAYER, contractRef,
                'FEE_PAYER is the contract, not the creator whose gas_escrow is the poll deposit');
            assert.strictEqual(emissionData.EMITTER, data['ACTION_INDEX'],
                'emitted by the finalizing v2 action');
        });

        it('a throwing callback rolls back only its own effects; the poll result still stands (no un-finalize)', async function () {
            const p = bindingPoll({ poll_status: 'open' });
            stubFinalize(p, { poll_status: 'finalized', winning_option: 0, total_counted_weight: '10', total_voters: 1, quorum_met: true, min_voters_met: true });
            executeStub.parse.rejects(new Error('callback reverted'));

            const data = createBaseData({ ACTION: 'VOTE', FORMAT: 2, ACTION_INDEX: null, IS_SYNTHETIC: true });
            await assert.doesNotReject(() => handler.parse(['2', '100'], data, null),
                'a reverting callback must not propagate and un-finalize the poll');

            assert.ok(indexer.indexerDb.rollbackToSavepoint.calledOnce, 'only the callback\'s savepoint is rolled back');
            assert.ok(indexer.indexerDb.releaseSavepoint.notCalled, 'the savepoint is not released on failure');
            assert.ok(indexer.indexerDb.setPollCallbackIndex.notCalled, 'no callback index recorded for a failed injection');
        });
    });
});
