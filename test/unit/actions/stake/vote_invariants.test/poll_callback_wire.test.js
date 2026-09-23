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
 * test/unit/actions/stake/vote_invariants.test/poll_callback_wire.test.js
 *
 * The binding-poll finalization wire against its exported declaration:
 * POLL_CALLBACK_FIXED_SLOTS, then POLL_CALLBACK_TICK_SLOT while
 * VOTE_POLL_TICK_VISIBLE is active, then the poll's CALLBACK_PARAMS, and
 * nothing else. Contract templates (xchain-contracts treasury.arm) pin their
 * callback arity to that declaration, so a slot the builder adds without it
 * would brick every deployed consumer while both suites stay green.
 */

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createBaseData } = require('../../../../fixtures/mocks');
const { freshVote, poll } = require('./helpers/vote_fixtures.js');
const {
    POLL_CALLBACK_FIXED_SLOTS, POLL_CALLBACK_TICK_SLOT
} = require('../../../../../src/actions/vote/binding_callback.js');

// Distinct per-slot values, so a reordered or renamed fixed slot cannot pass by coincidence.
const RESULT = { poll_status: 'finalized', winning_option: 2, total_counted_weight: '15', total_voters: 3, quorum_met: true, min_voters_met: false };
const EXPECTED_BY_SLOT = {
    pollIndex: '100', status: 'finalized', winningOption: '2', totalWeight: '15',
    totalVoters: '3', quorumMet: '1', minVotersMet: '0'
};

let indexer, actionsCtx, handler, executeStub;

function freshHandler() {
    ({ indexer, actionsCtx, handler, executeStub } = freshVote());
}

// Finalize one binding poll and return the callbackArgs the EXECUTE received.
async function finalizeWire({ tickVisible, callbackParams }) {
    actionsCtx.protocolChanges.isEnabled = sinon.stub().callsFake(async (name) =>
        name === 'VOTE_POLL_TICK_VISIBLE' ? tickVisible : true);
    indexer.indexerDb.getTicker = sinon.stub().resolves('GOVTOK');
    const p = poll({
        poll_status: 'open', callback_contract_index: 5, callback_method: 'onResult',
        callback_params: callbackParams, callback_on: 'pass', tick_id: 9,
    });
    indexer.indexerDb.getPoll = sinon.stub().resolves(p);
    indexer.indexerDb.finalizePoll = sinon.stub().resolves(RESULT);
    indexer.indexerDb.createActionIndex = sinon.stub().resolves(200);

    const data = createBaseData({ ACTION: 'VOTE', FORMAT: 2, ACTION_INDEX: null, IS_SYNTHETIC: true });
    await handler.parse(['2', '100'], data, null);
    assert.ok(executeStub.parse.calledOnce, 'the binding callback fired');
    // actionParams = [VERSION, contract, method, ...callbackArgs]
    return executeStub.parse.firstCall.args[0].slice(3);
}

describe('Vote invariants (escrow conservation + callback metering) @regression @tier1', function () {
    beforeEach(freshHandler);
    afterEach(() => sinon.restore());

    describe('binding-poll callback wire matches its exported slot declaration', function () {

        it('the declaration is a frozen list of distinct slot names, with the tick slot outside it', function () {
            assert.ok(Object.isFrozen(POLL_CALLBACK_FIXED_SLOTS), 'fixed slots are frozen');
            assert.ok(POLL_CALLBACK_FIXED_SLOTS.length > 0, 'fixed slots are declared');
            assert.ok(POLL_CALLBACK_FIXED_SLOTS.every(s => typeof s === 'string' && s !== ''), 'every slot is named');
            assert.strictEqual(new Set(POLL_CALLBACK_FIXED_SLOTS).size, POLL_CALLBACK_FIXED_SLOTS.length, 'slot names are distinct');
            assert.strictEqual(typeof POLL_CALLBACK_TICK_SLOT, 'string');
            assert.ok(!POLL_CALLBACK_FIXED_SLOTS.includes(POLL_CALLBACK_TICK_SLOT), 'the tick slot is not a fixed slot');
        });

        it('gate ACTIVE: fixed slots in declared order, then the tick, then exactly the developer params', async function () {
            const args = await finalizeWire({ tickVisible: true, callbackParams: '["devA","devB"]' });
            const fixed = POLL_CALLBACK_FIXED_SLOTS.length;

            assert.strictEqual(args.length, fixed + 1 + 2, 'total length is fixed slots + tick + CALLBACK_PARAMS');
            assert.deepStrictEqual(args.slice(0, fixed), POLL_CALLBACK_FIXED_SLOTS.map(s => EXPECTED_BY_SLOT[s]));
            assert.strictEqual(args[fixed], 'GOVTOK', POLL_CALLBACK_TICK_SLOT + ' follows the fixed slots');
            assert.deepStrictEqual(args.slice(fixed + 1), ['devA', 'devB']);
        });

        it('gate ACTIVE with one CALLBACK_PARAM: the single-id consumer shape arrives at fixed + 2', async function () {
            const args = await finalizeWire({ tickVisible: true, callbackParams: '["7"]' });

            assert.strictEqual(args.length, POLL_CALLBACK_FIXED_SLOTS.length + 2);
            assert.strictEqual(args[args.length - 1], '7', 'the proposal id is the last slot');
        });

        it('gate INACTIVE: fixed slots in declared order, then exactly the developer params, no tick', async function () {
            const args = await finalizeWire({ tickVisible: false, callbackParams: '["devA","devB"]' });
            const fixed = POLL_CALLBACK_FIXED_SLOTS.length;

            assert.strictEqual(args.length, fixed + 2, 'total length is fixed slots + CALLBACK_PARAMS');
            assert.deepStrictEqual(args.slice(0, fixed), POLL_CALLBACK_FIXED_SLOTS.map(s => EXPECTED_BY_SLOT[s]));
            assert.deepStrictEqual(args.slice(fixed), ['devA', 'devB']);
        });

        it('no CALLBACK_PARAMS: the wire is the fixed slots plus the tick and nothing after', async function () {
            const args = await finalizeWire({ tickVisible: true, callbackParams: null });

            assert.strictEqual(args.length, POLL_CALLBACK_FIXED_SLOTS.length + 1);
        });
    });
});
