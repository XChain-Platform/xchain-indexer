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
 * test/unit/actions/stake/vote_invariants.test/settlement_exact.test.js
 *
 * vote_settlement_exact_activation on the VOTE create and ballot paths. Armed (regtest,
 * genesis) a create refuses a DEPOSIT or GAS_ESCROW with more than 8 decimal places,
 * the places its escrow locks and releases at, and a ballot is refused once its poll
 * is no longer open. Unarmed (the committed mainnet and testnet rows) both paths
 * accept exactly what they accepted before the row existed.
 */

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createBaseData } = require('../../../../fixtures/mocks');
const { stubGate } = require('../../../../helpers/gate_modules.js');
const { freshVote } = require('./helpers/vote_fixtures.js');

const KEY = 'vote_settlement_exact_activation.VOTE_SETTLEMENT_EXACT_ACTIVATION';

let indexer, actionsCtx, handler, ledger;

function freshHandler() {
    ({ indexer, actionsCtx, handler } = freshVote());
    indexer.indexerDb.getTokenInfo.resolves({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 8, SUPPLY: '1000' });
    indexer.indexerDb.createTicker.resolves(1);
    indexer.indexerDb.getAddressBalances.resolves({ 1: '100' });
    indexer.indexerDb.getContract = sinon.stub().resolves({ action_index: 5, code: 'module.exports={onResult:function(){}}', status_id: 1 });
    indexer.indexerDb.getStatusString = sinon.stub().resolves('valid');
    indexer.indexerDb.createPoll = sinon.stub().resolves();
    indexer.indexerDb.createBallot = sinon.stub().resolves();
    ledger = sinon.stub(indexer.util, 'processTransactionLedgerChanges').resolves();
    indexer.indexerDb.updateBalances = sinon.stub().resolves();
    indexer.indexerDb.updateTokens = sinon.stub().resolves();
}

// VOTE v0 fields after VERSION: TICK|END_BLOCK|OPTIONS|MAX_SELECTIONS|TALLY_MODE|
// WEIGHT_MODE|QUORUM|MIN_VOTERS|MIN_VOTE_BALANCE|DECIDE_THRESHOLD|QUESTION|DEPOSIT|
// CALLBACK_CONTRACT|CALLBACK_METHOD|CALLBACK_PARAMS|CALLBACK_ON|GAS_ESCROW
function createParams({ deposit = '', gasEscrow = '' } = {}) {
    const binding = gasEscrow !== '';
    return ['0', 'TEST', '200', 'yes,no', '', '', '', binding ? '0.1' : '', binding ? '1' : '', '', '', '', deposit,
            binding ? '5' : '', binding ? 'onResult' : '', '', '', gasEscrow];
}

async function runCreate(params, blockIndex = 100) {
    const data = createBaseData({ ACTION: 'VOTE', FORMAT: 0, BLOCK_INDEX: blockIndex, ACTION_INDEX: 50, SOURCE: 'creatorAddr' });
    await handler.parse(params, data, null);
    return data;
}

// The amount the create locked in escrow, or null when it locked nothing.
function lockedAmount() {
    if (!ledger.called) return null;
    const escrows = ledger.firstCall.args[4];
    return escrows[0][1];
}

function openPoll(overrides = {}) {
    return { action_index: 40, tick_id: 1, end_block: 200, poll_status: 'open',
             options: '["yes","no"]', max_selections: 1, tally_mode: 'approval', ...overrides };
}

async function runBallot(poll, blockIndex = 150) {
    indexer.indexerDb.getPoll = sinon.stub().resolves(poll);
    const data = createBaseData({ ACTION: 'VOTE', FORMAT: 1, BLOCK_INDEX: blockIndex, ACTION_INDEX: 60, SOURCE: 'voterAddr' });
    await handler.parse(['1', '40', '0', ''], data, null);
    return data;
}

// Armed create cases: the DEPOSIT and GAS_ESCROW precision rule.
function registerArmedCreateCases() {
    it('refuses a 9-dp DEPOSIT and locks nothing', async function () {
        const data = await runCreate(createParams({ deposit: '0.123456789' }));
        assert.strictEqual(data.STATUS, 'invalid: DEPOSIT (more than 8 decimal places)');
        assert.strictEqual(lockedAmount(), null);
        assert.deepStrictEqual(indexer.indexerDb.createPoll.firstCall.args[1], { inert: true });
    });

    it('refuses a DEPOSIT whose exponent form carries a 9th decimal place', async function () {
        const data = await runCreate(createParams({ deposit: '1e-9' }));
        assert.strictEqual(data.STATUS, 'invalid: DEPOSIT (more than 8 decimal places)');
    });

    it('accepts an 8-dp DEPOSIT and locks it unchanged', async function () {
        const data = await runCreate(createParams({ deposit: '0.12345678' }));
        assert.strictEqual(data.STATUS, 'valid');
        assert.strictEqual(String(lockedAmount()), '0.12345678');
    });

    it('accepts a DEPOSIT whose digits past the 8th are zeros', async function () {
        const data = await runCreate(createParams({ deposit: '1.500000000' }));
        assert.strictEqual(data.STATUS, 'valid');
        assert.strictEqual(String(lockedAmount()), '1.5');
    });

    it('refuses a 9-dp GAS_ESCROW on a binding poll', async function () {
        const data = await runCreate(createParams({ gasEscrow: '0.123456789' }));
        assert.strictEqual(data.STATUS, 'invalid: GAS_ESCROW (more than 8 decimal places)');
        assert.strictEqual(lockedAmount(), null);
    });

    it('accepts an 8-dp GAS_ESCROW on a binding poll', async function () {
        const data = await runCreate(createParams({ gasEscrow: '0.12345678' }));
        assert.strictEqual(data.STATUS, 'valid');
        assert.strictEqual(String(lockedAmount()), '0.12345678');
    });
}

// Armed ballot cases: a poll that is no longer open takes no ballot.
function registerArmedBallotCases() {
    it('refuses a ballot on a poll finalized early, before its END_BLOCK', async function () {
        const data = await runBallot(openPoll({ poll_status: 'finalized' }));
        assert.strictEqual(data.STATUS, 'invalid: poll closed');
        assert.ok(indexer.indexerDb.createBallot.notCalled);
    });

    it('refuses a ballot on a poll that failed its gates early', async function () {
        const data = await runBallot(openPoll({ poll_status: 'failed_quorum' }));
        assert.strictEqual(data.STATUS, 'invalid: poll closed');
    });

    it('accepts a ballot on an open poll inside its window', async function () {
        const data = await runBallot(openPoll());
        assert.strictEqual(data.STATUS, 'valid');
        assert.ok(indexer.indexerDb.createBallot.calledOnce);
    });
}

// Unarmed cases on one network's committed row: every input is accepted as before the row.
function registerUnarmedCases(network) {
    beforeEach(function () { indexer.config.NETWORK = network; });

    it('accepts a 9-dp DEPOSIT and locks it at 8 dp, as before the row', async function () {
        const data = await runCreate(createParams({ deposit: '0.123456789' }));
        assert.strictEqual(data.STATUS, 'valid');
        assert.strictEqual(String(lockedAmount()), '0.12345679');
    });

    it('accepts a 9-dp GAS_ESCROW on a binding poll, as before the row', async function () {
        const data = await runCreate(createParams({ gasEscrow: '0.123456789' }));
        assert.strictEqual(data.STATUS, 'valid');
    });

    it('accepts a ballot on a poll finalized early, as before the row', async function () {
        const data = await runBallot(openPoll({ poll_status: 'finalized' }));
        assert.strictEqual(data.STATUS, 'valid');
        assert.ok(indexer.indexerDb.createBallot.calledOnce);
    });
}

// Height cases: the row is read at the create's or the ballot's own block.
function registerHeightCases() {
    // Arm at 150 so each case reads the row at its own action's block.
    beforeEach(function () {
        stubGate(sinon, KEY, false).callsFake((key, network, coin, height) => height >= 150);
    });

    it('reads the create block: 149 accepts a 9-dp DEPOSIT, 150 refuses it', async function () {
        assert.strictEqual((await runCreate(createParams({ deposit: '0.123456789' }), 149)).STATUS, 'valid');
        assert.strictEqual((await runCreate(createParams({ deposit: '0.123456789' }), 150)).STATUS,
            'invalid: DEPOSIT (more than 8 decimal places)');
    });

    it('reads the ballot block: 149 accepts a ballot on a finalized poll, 150 refuses it', async function () {
        assert.strictEqual((await runBallot(openPoll({ poll_status: 'finalized' }), 149)).STATUS, 'valid');
        assert.strictEqual((await runBallot(openPoll({ poll_status: 'finalized' }), 150)).STATUS, 'invalid: poll closed');
    });
}

describe('VOTE settlement exact activation: create and ballot @regression @tier1', function () {
    beforeEach(freshHandler);
    afterEach(() => sinon.restore());

    describe('armed (regtest from genesis)', function () {
        registerArmedCreateCases();
        registerArmedBallotCases();
    });
    for (const network of ['mainnet', 'testnet'])
        describe('unarmed (' + network + ' committed row)', function () { registerUnarmedCases(network); });
    describe('activation height', registerHeightCases);
});
