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
 * test/unit/actions/stake/vote_invariants.test/binding_minimums.test.js
 *
 * The VOTE_BINDING_MINIMUMS flag day: the QUORUM and MIN_VOTERS floors a
 * binding poll must carry at creation. Part of the VOTE invariant suite; see
 * ../vote_invariants.test.js, whose describe title each block here repeats so
 * every full test title is unchanged.
 */

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createBaseData } = require('../../../../fixtures/mocks');
const { freshVote } = require('./helpers/vote_fixtures.js');

let indexer, actionsCtx, handler;

function freshHandler() {
    ({ indexer, actionsCtx, handler } = freshVote());
}

function restoreStubs() {
    sinon.restore();
}

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

describe('Vote invariants (escrow conservation + callback metering) @regression @tier1', function () {
    beforeEach(freshHandler);
    afterEach(restoreStubs);

    describe('VOTE_BINDING_MINIMUMS flag-day (/ BonkDAO-class guard)', function () {
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
    });
});

describe('Vote invariants (escrow conservation + callback metering) @regression @tier1', function () {
    beforeEach(freshHandler);
    afterEach(restoreStubs);

    describe('VOTE_BINDING_MINIMUMS flag-day (/ BonkDAO-class guard)', function () {
        beforeEach(stubCreate);

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
});
