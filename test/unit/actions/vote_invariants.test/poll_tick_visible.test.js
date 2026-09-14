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
 * test/unit/actions/vote_invariants.test/poll_tick_visible.test.js
 *
 * The VOTE_POLL_TICK_VISIBLE flag day: whether the poll's electorate TICK
 * reaches the binding callback. Part of the VOTE invariant suite; see
 * ../vote_invariants.test.js, whose describe title each block here repeats so
 * every full test title is unchanged.
 */

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createBaseData } = require('../../../fixtures/mocks');
const { freshVote, poll } = require('./helpers/vote_fixtures.js');

let indexer, actionsCtx, handler, executeStub;

function freshHandler() {
    ({ indexer, actionsCtx, handler, executeStub } = freshVote());
}

function restoreStubs() {
    sinon.restore();
}

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

describe('Vote invariants (escrow conservation + callback metering) @regression @tier1', function () {
    beforeEach(freshHandler);
    afterEach(restoreStubs);

    describe('VOTE_POLL_TICK_VISIBLE flag-day (/ poll electorate TICK to callback)', function () {

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
    });
});

describe('Vote invariants (escrow conservation + callback metering) @regression @tier1', function () {
    beforeEach(freshHandler);
    afterEach(restoreStubs);

    describe('VOTE_POLL_TICK_VISIBLE flag-day (/ poll electorate TICK to callback)', function () {

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
});
