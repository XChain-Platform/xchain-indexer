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
            protocolChanges: {
                isDefined: sinon.stub().returns(true),
                isEnabled: sinon.stub().resolves(true),
            },
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

        // footgun pin: the binding-poll callback EXECUTE is emitted as a
        // fee-skipped, protocol-ceiling run whose gas is NOT drawn from or bounded
        // by the poll's GAS_ESCROW. The emission carries IS_EMISSION (execute.js
        // skipFee) and deliberately omits VM_GAS_LIMIT, so execute.js falls back to
        // GAS_CEILING rather than an escrow-derived ceiling; gas_escrow always
        // refunds in full (see _settleDeposit tests). This locks the documented
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

    describe('VOTE_POLL_TICK_VISIBLE flag-day (/ poll electorate TICK to callback)', function () {

        function bindingPoll(overrides = {}) {
            return poll({
                callback_contract_index: 5, callback_method: 'onResult',
                callback_params: '["devA","devB"]', callback_on: 'pass',
                tick_id: 9,
                ...overrides,
            });
        }

        function stubFinalize(pollRow, result) {
            indexer.indexerDb.getPoll = sinon.stub().resolves(pollRow);
            indexer.indexerDb.finalizePoll = sinon.stub().resolves(result);
            indexer.indexerDb.createActionIndex = sinon.stub().resolves(200);
        }

        // Only the tick flag toggles; every sibling flag stays enabled so this
        // isolates the tick slot from the other VOTE gates.
        function gateStub(active) {
            return sinon.stub().callsFake(async (name) =>
                name === 'VOTE_POLL_TICK_VISIBLE' ? active : true);
        }

        const finalizedResult = { poll_status: 'finalized', winning_option: 1, total_counted_weight: '15', total_voters: 2, quorum_met: true, min_voters_met: true };

        it('gate ACTIVE: inserts the resolved electorate TICK after min_voters_met, before the developer params', async function () {
            actionsCtx.protocolChanges.isEnabled = gateStub(true);
            indexer.indexerDb.getTicker = sinon.stub().resolves('GOVTOK');
            const p = bindingPoll({ poll_status: 'open' });
            stubFinalize(p, finalizedResult);

            const data = createBaseData({ ACTION: 'VOTE', FORMAT: 2, ACTION_INDEX: null, IS_SYNTHETIC: true });
            await handler.parse(['2', '100'], data, null);

            assert.ok(indexer.indexerDb.getTicker.calledOnceWith(9), 'tick_id resolved through getTicker');
            const [actionParams] = executeStub.parse.firstCall.args;
            // actionParams = [VERSION, contract, method, ...callbackArgs]; callbackArgs starts at [3]:
            // [3]=pollIndex [4]=status [5]=winning [6]=weight [7]=voters [8]=quorum [9]=min_voters [10]=tick [11..]=dev
            assert.strictEqual(actionParams[3], '100', 'pollIndex');
            assert.strictEqual(actionParams[8], '1', 'quorum_met slot (callbackArgs[5])');
            assert.strictEqual(actionParams[9], '1', 'min_voters_met slot (callbackArgs[6])');
            assert.strictEqual(actionParams[10], 'GOVTOK', 'tick slot immediately follows min_voters_met');
            assert.strictEqual(actionParams[11], 'devA', 'developer params shift one slot right, after the tick');
            assert.strictEqual(actionParams[12], 'devB');
        });

        it('gate INACTIVE: signature is byte-identical to the pre-flag layout (no tick slot, no getTicker read)', async function () {
            actionsCtx.protocolChanges.isEnabled = gateStub(false);
            indexer.indexerDb.getTicker = sinon.stub().resolves('GOVTOK');
            const p = bindingPoll({ poll_status: 'open' });
            stubFinalize(p, finalizedResult);

            const data = createBaseData({ ACTION: 'VOTE', FORMAT: 2, ACTION_INDEX: null, IS_SYNTHETIC: true });
            await handler.parse(['2', '100'], data, null);

            assert.ok(indexer.indexerDb.getTicker.notCalled, 'below the flag-day the tick is never resolved');
            const [actionParams] = executeStub.parse.firstCall.args;
            assert.strictEqual(actionParams[9], '1', 'min_voters_met slot (callbackArgs[6])');
            assert.strictEqual(actionParams[10], 'devA', 'developer params sit at the pre-flag position (no tick slot)');
            assert.strictEqual(actionParams[11], 'devB');
        });

        it('gate ACTIVE with a null electorate tick_id: emits an empty tick slot, still shifting the developer params', async function () {
            actionsCtx.protocolChanges.isEnabled = gateStub(true);
            indexer.indexerDb.getTicker = sinon.stub().resolves('GOVTOK');
            const p = bindingPoll({ poll_status: 'open', tick_id: null });
            stubFinalize(p, finalizedResult);

            const data = createBaseData({ ACTION: 'VOTE', FORMAT: 2, ACTION_INDEX: null, IS_SYNTHETIC: true });
            await handler.parse(['2', '100'], data, null);

            assert.ok(indexer.indexerDb.getTicker.notCalled, 'a null tick_id is not resolved');
            const [actionParams] = executeStub.parse.firstCall.args;
            assert.strictEqual(actionParams[10], '', 'the tick slot is present but empty');
            assert.strictEqual(actionParams[11], 'devA', 'developer params still shift past the empty tick slot');
        });
    });

    describe('VOTE_BINDING_MINIMUMS flag-day (/ BonkDAO-class guard)', function () {

        // Drives the real v0 create path (parse FORMAT 0). Format:
        // VERSION|TICK|END_BLOCK|OPTIONS|MAX_SELECTIONS|TALLY_MODE|WEIGHT_MODE|QUORUM|
        // MIN_VOTERS|MIN_VOTE_BALANCE|DECIDE_THRESHOLD|QUESTION|DEPOSIT|CALLBACK_CONTRACT|
        // CALLBACK_METHOD|CALLBACK_PARAMS|CALLBACK_ON|GAS_ESCROW
        function createParams({ quorum = '', minVoters = '', callbackContract = '5' } = {}) {
            return ['0', 'TEST', '200', 'yes,no', '', '', '', quorum, minVoters, '', '', '', '',
                    callbackContract, 'onResult', '', '', ''];
        }

        function stubCreate() {
            indexer.indexerDb.getTokenInfo.resolves({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0, SUPPLY: '1000' });
            indexer.indexerDb.createTicker.resolves(1);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '100' });
            indexer.indexerDb.getContract = sinon.stub().resolves({ contract_index: 5 });
            indexer.indexerDb.createPoll  = sinon.stub().resolves();
        }

        function gateStub(active) {
            return sinon.stub().callsFake(async (name) =>
                name === 'VOTE_BINDING_MINIMUMS' ? active : true);
        }

        async function runCreate(params) {
            const data = createBaseData({ ACTION: 'VOTE', FORMAT: 0, BLOCK_INDEX: 100, ACTION_INDEX: 50, SOURCE: 'creatorAddr' });
            await handler.parse(params, data, null);
            return data;
        }

        beforeEach(stubCreate);

        it('gate ACTIVE: binding poll without QUORUM → invalid', async function () {
            actionsCtx.protocolChanges.isEnabled = gateStub(true);
            const data = await runCreate(createParams({ quorum: '', minVoters: '3' }));
            assert.strictEqual(data.STATUS, 'invalid: QUORUM (required for a binding poll)');
        });

        it('gate ACTIVE: binding poll without MIN_VOTERS → invalid', async function () {
            actionsCtx.protocolChanges.isEnabled = gateStub(true);
            const data = await runCreate(createParams({ quorum: '0.1', minVoters: '' }));
            assert.strictEqual(data.STATUS, 'invalid: MIN_VOTERS (>= 1 required for a binding poll)');
        });

        it('gate ACTIVE: binding poll with MIN_VOTERS=0 → invalid (an explicit zero is no floor)', async function () {
            actionsCtx.protocolChanges.isEnabled = gateStub(true);
            const data = await runCreate(createParams({ quorum: '0.1', minVoters: '0' }));
            assert.strictEqual(data.STATUS, 'invalid: MIN_VOTERS (>= 1 required for a binding poll)');
        });

        it('gate ACTIVE: binding poll with QUORUM + MIN_VOTERS >= 1 → valid', async function () {
            actionsCtx.protocolChanges.isEnabled = gateStub(true);
            const data = await runCreate(createParams({ quorum: '0.1', minVoters: '3' }));
            assert.strictEqual(data.STATUS, 'valid');
            assert.ok(indexer.indexerDb.createPoll.calledOnce);
        });

        it('gate ACTIVE: signaling poll (no CALLBACK_CONTRACT) stays permissive without either', async function () {
            actionsCtx.protocolChanges.isEnabled = gateStub(true);
            const data = await runCreate(['0', 'TEST', '200', 'yes,no', '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
            assert.strictEqual(data.STATUS, 'valid');
        });

        it('gate INACTIVE: binding poll without QUORUM/MIN_VOTERS stays valid (byte-identical replay)', async function () {
            actionsCtx.protocolChanges.isEnabled = gateStub(false);
            const data = await runCreate(createParams({ quorum: '', minVoters: '' }));
            assert.strictEqual(data.STATUS, 'valid', 'legacy acceptance must be preserved below the flag-day');
        });
    });

    describe('VOTE_CALLBACK_TIMELOCK flag-day (/ finalize→callback timelock)', function () {

        function createParams({ delay = '' } = {}) {
            // VERSION|TICK|END_BLOCK|OPTIONS|MAX_SELECTIONS|TALLY_MODE|WEIGHT_MODE|QUORUM|
            // MIN_VOTERS|MIN_VOTE_BALANCE|DECIDE_THRESHOLD|QUESTION|DEPOSIT|CALLBACK_CONTRACT|
            // CALLBACK_METHOD|CALLBACK_PARAMS|CALLBACK_ON|GAS_ESCROW|CALLBACK_DELAY_BLOCKS
            return ['0', 'TEST', '200', 'yes,no', '', '', '', '0.1', '3', '', '', '', '',
                    '5', 'onResult', '', '', '', delay];
        }

        function stubCreate() {
            indexer.indexerDb.getTokenInfo.resolves({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0, SUPPLY: '1000' });
            indexer.indexerDb.createTicker.resolves(1);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '100' });
            indexer.indexerDb.getContract = sinon.stub().resolves({ contract_index: 5 });
            indexer.indexerDb.createPoll  = sinon.stub().resolves();
        }

        function gateStub(active) {
            return sinon.stub().callsFake(async (name) =>
                name === 'VOTE_CALLBACK_TIMELOCK' ? active : true);
        }

        async function runCreate(params) {
            const data = createBaseData({ ACTION: 'VOTE', FORMAT: 0, BLOCK_INDEX: 100, ACTION_INDEX: 50, SOURCE: 'creatorAddr' });
            await handler.parse(params, data, null);
            return data;
        }

        function terminalPoll(overrides = {}) {
            return {
                action_index: 100, poll_status: 'open', end_block: 150,
                deposit_amount: '0', gas_escrow: '0', deposit_resolved: null, deposit_address_id: null,
                callback_contract_index: 5, callback_method: 'onResult', callback_params: '[]',
                callback_on: 'pass', callback_delay_blocks: null, callback_due_block: null,
                callback_execute_action_index: null, finalized_action_index: null,
                ...overrides,
            };
        }

        describe('v0 create', function () {

            beforeEach(stubCreate);

            it('gate ACTIVE: non-integer CALLBACK_DELAY_BLOCKS → invalid', async function () {
                actionsCtx.protocolChanges.isEnabled = gateStub(true);
                const data = await runCreate(createParams({ delay: 'abc' }));
                assert.strictEqual(data.STATUS, 'invalid: CALLBACK_DELAY_BLOCKS (non-negative integer)');
            });

            it('gate ACTIVE: integer CALLBACK_DELAY_BLOCKS → valid and stored', async function () {
                actionsCtx.protocolChanges.isEnabled = gateStub(true);
                const data = await runCreate(createParams({ delay: '20' }));
                assert.strictEqual(data.STATUS, 'valid');
                assert.strictEqual(data.CALLBACK_DELAY_BLOCKS, '20');
                assert.ok(indexer.indexerDb.createPoll.calledOnce);
            });

            it('gate INACTIVE: CALLBACK_DELAY_BLOCKS is ignored (nulled), poll stays valid like on a legacy node', async function () {
                actionsCtx.protocolChanges.isEnabled = gateStub(false);
                const data = await runCreate(createParams({ delay: '20' }));
                assert.strictEqual(data.STATUS, 'valid');
                assert.strictEqual(data.CALLBACK_DELAY_BLOCKS, null, 'below the flag-day the field must be dropped, not honored');
            });
        });

        describe('v2 finalize deferral', function () {

            function stubFinalize(pollRow, result) {
                indexer.indexerDb.getPoll = sinon.stub().resolves(pollRow);
                indexer.indexerDb.finalizePoll = sinon.stub().resolves(result);
                indexer.indexerDb.createActionIndex = sinon.stub().resolves(200);
                indexer.indexerDb.setPollCallbackDue = sinon.stub().resolves();
            }

            function finalizeData() {
                return createBaseData({ ACTION: 'VOTE', FORMAT: 2, BLOCK_INDEX: 160, BLOCK_TIME: 1000,
                                        POLL_REF: 100, IS_SYNTHETIC: true });
            }

            const WIN = { poll_status: 'finalized', winning_option: 1, total_counted_weight: '15',
                          total_voters: 2, quorum_met: true, min_voters_met: true };

            it('delay > 0: the callback is DEFERRED (due block stamped, no EXECUTE injected at finalize)', async function () {
                const p = terminalPoll({ callback_delay_blocks: 25 });
                stubFinalize(p, WIN);

                await handler._parseFinalize(finalizeData(), null);

                assert.ok(indexer.indexerDb.setPollCallbackDue.calledOnceWith(100, 185), 'due block = finalize block 160 + 25');
                assert.ok(executeStub.parse.notCalled, 'no EXECUTE in the finalization block');
                assert.ok(indexer.indexerDb.setPollCallbackIndex.notCalled, 'not marked fired');
            });

            it('delay null/0: the callback fires immediately at finalize (legacy path)', async function () {
                const p = terminalPoll({ callback_delay_blocks: null });
                stubFinalize(p, WIN);

                await handler._parseFinalize(finalizeData(), null);

                assert.ok(executeStub.parse.calledOnce, 'immediate EXECUTE injection');
                assert.ok(indexer.indexerDb.setPollCallbackDue.notCalled);
            });
        });

        describe('due-callback sweep (processDueCallbacks)', function () {

            it('fires the deferred callback at its due block with the frozen result, and marks it fired', async function () {
                const p = terminalPoll({
                    poll_status: 'finalized', winning_option: 1, total_weight: '15', total_voters: 2,
                    quorum_met: 1, min_voters_met: 1, callback_delay_blocks: 25,
                    callback_due_block: 185, finalized_action_index: 200, resolved_block: 160,
                });
                indexer.indexerDb.getDueCallbackPolls = sinon.stub().resolves([p]);
                indexer.indexerDb.createActionIndex   = sinon.stub().resolves(300);

                await handler.processDueCallbacks(185, 2000);

                assert.ok(executeStub.parse.calledOnce, 'the deferred EXECUTE fires at the due block');
                const [execParams, execData] = executeStub.parse.firstCall.args;
                assert.strictEqual(execParams[1], 5, 'targets the callback contract');
                assert.strictEqual(execParams[2], 'onResult');
                assert.strictEqual(execParams[3], '100', 'poll id arg');
                assert.strictEqual(execParams[4], 'finalized', 'frozen poll_status arg');
                assert.strictEqual(execData.BLOCK_INDEX, 185, 'EXECUTE lands in the due block');
                assert.strictEqual(execData.EMITTER, 200, 'emitted by the finalizing v2');
                assert.ok(indexer.indexerDb.setPollCallbackIndex.calledOnceWith(100, 300));
            });

            it('no-op when nothing is due', async function () {
                indexer.indexerDb.getDueCallbackPolls = sinon.stub().resolves([]);
                await handler.processDueCallbacks(185, 2000);
                assert.ok(executeStub.parse.notCalled);
            });
        });
    });
});
