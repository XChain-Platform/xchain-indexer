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
 * test/unit/actions/stake/vote_invariants.test/callback_timelock.test.js
 *
 * The VOTE_CALLBACK_TIMELOCK flag day: the delay between a poll finalizing and
 * its binding callback running, at create, at finalize and in the due sweep.
 * Part of the VOTE invariant suite; see ../vote_invariants.test.js, whose
 * describe title each block here repeats so every full test title is unchanged.
 */

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createBaseData } = require('../../../../fixtures/mocks');
const { freshVote } = require('./helpers/vote_fixtures.js');

let indexer, actionsCtx, handler, executeStub;

function freshHandler() {
    ({ indexer, actionsCtx, handler, executeStub } = freshVote());
}

function restoreStubs() {
    sinon.restore();
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

describe('Vote invariants (escrow conservation + callback metering) @regression @tier1', function () {
    beforeEach(freshHandler);
    afterEach(restoreStubs);

    describe('VOTE_CALLBACK_TIMELOCK flag-day (/ finalize→callback timelock)', function () {
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
    });
});

describe('Vote invariants (escrow conservation + callback metering) @regression @tier1', function () {
    beforeEach(freshHandler);
    afterEach(restoreStubs);

    describe('VOTE_CALLBACK_TIMELOCK flag-day (/ finalize→callback timelock)', function () {
        describe('v2 finalize deferral', function () {

            it('delay > 0: the callback is DEFERRED (due block stamped, no EXECUTE injected at finalize)', async function () {
                const p = terminalPoll({ callback_delay_blocks: 25 });
                stubFinalize(p, WIN);

                await handler.parseFinalize(finalizeData(), null);

                assert.ok(indexer.indexerDb.setPollCallbackDue.calledOnceWith(100, 185), 'due block = finalize block 160 + 25');
                assert.ok(executeStub.parse.notCalled, 'no EXECUTE in the finalization block');
                assert.ok(indexer.indexerDb.setPollCallbackIndex.notCalled, 'not marked fired');
            });

            it('delay null/0: the callback fires immediately at finalize (legacy path)', async function () {
                const p = terminalPoll({ callback_delay_blocks: null });
                stubFinalize(p, WIN);

                await handler.parseFinalize(finalizeData(), null);

                assert.ok(executeStub.parse.calledOnce, 'immediate EXECUTE injection');
                assert.ok(indexer.indexerDb.setPollCallbackDue.notCalled);
            });
        });
    });
});

describe('Vote invariants (escrow conservation + callback metering) @regression @tier1', function () {
    beforeEach(freshHandler);
    afterEach(restoreStubs);

    describe('VOTE_CALLBACK_TIMELOCK flag-day (/ finalize→callback timelock)', function () {
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
