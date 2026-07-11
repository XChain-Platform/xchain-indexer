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
 * test/unit/actions/vote-invariants.test.js
 *
 * Regression coverage for the four VOTE governance invariants that had zero
 * tests (review finding #149): escrow conservation in _settleDeposit
 * (including idempotency) and binding-callback firing/metering. Delegation
 * precedence and quadratic/dust-floor weighting are covered separately in
 * test/unit/votes-tally-invariants.test.js.
 */

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');
const Vote = require('../../../src/actions/vote.js');

describe('Vote invariants (escrow conservation + callback metering) @regression @tier1', function () {
    let indexer, actionsCtx, handler, executeStub, gas, donate1;

    beforeEach(function () {
        indexer = createMockIndexer();
        gas     = indexer.config['GAS'];
        donate1 = indexer.config['ADDRESS']['DONATE1'];

        executeStub = { parse: sinon.stub().resolves() };
        actionsCtx = {
            config:        indexer.config,
            util:          indexer.util,
            mapper:        indexer.mapper,
            decoderDb:     indexer.decoderDb,
            indexerDb:     indexer.indexerDb,
            actionExecute: executeStub,
        };
        handler = new Vote(actionsCtx);
        indexer.util.resetLists();
        indexer.indexerDb.createSavepoint      = sinon.stub().resolves('sp1');
        indexer.indexerDb.releaseSavepoint     = sinon.stub().resolves();
        indexer.indexerDb.rollbackToSavepoint  = sinon.stub().resolves();
        indexer.indexerDb.setPollCallbackIndex = sinon.stub().resolves();
        indexer.indexerDb.getAddressById       = sinon.stub().resolves('creatorAddr');
        indexer.indexerDb.setPollDepositResolved = sinon.stub().resolves();
    });

    afterEach(function () {
        sinon.restore();
    });

    function poll(overrides = {}) {
        return {
            action_index: 100, deposit_amount: '100', gas_escrow: '20',
            deposit_resolved: null, deposit_address_id: 7,
            callback_contract_index: null, callback_on: 'pass', callback_method: null,
            ...overrides,
        };
    }

    describe('_settleDeposit escrow conservation', function () {

        it('finalized win: refunds the whole hold (deposit + gas_escrow) to the creator, net zero', async function () {
            const p    = poll();
            const data = createBaseData({ ACTION: 'VOTE', FORMAT: 2, ACTION_INDEX: 100 });

            await handler._settleDeposit(p, data, 'finalized');

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

            await handler._settleDeposit(p, data, 'failed_quorum');

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

        it('idempotent: a poll whose deposit is already resolved is a no-op on a reprocessed finalize', async function () {
            const p    = poll({ deposit_resolved: 'refunded' });
            const data = createBaseData({ ACTION: 'VOTE', FORMAT: 2, ACTION_INDEX: 100 });

            await handler._settleDeposit(p, data, 'finalized');

            assert.ok(indexer.indexerDb.createEscrow.notCalled, 'no double release of an already-resolved deposit');
            assert.ok(indexer.indexerDb.createCredit.notCalled);
            assert.ok(indexer.indexerDb.setPollDepositResolved.notCalled);
        });

        it('no-op when the poll carried zero deposit and zero gas_escrow', async function () {
            const p    = poll({ deposit_amount: '0', gas_escrow: '0' });
            const data = createBaseData({ ACTION: 'VOTE', FORMAT: 2, ACTION_INDEX: 100 });

            await handler._settleDeposit(p, data, 'finalized');

            assert.ok(indexer.indexerDb.createEscrow.notCalled);
            assert.ok(indexer.indexerDb.setPollDepositResolved.notCalled);
        });
    });

    describe('binding-callback firing / metering (VOTE v2 finalize)', function () {

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
