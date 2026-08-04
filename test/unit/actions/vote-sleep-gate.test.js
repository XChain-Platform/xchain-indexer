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
 * test/unit/actions/vote-sleep-gate.test.js
 *
 *  (VOTE-SLEEP-1): VOTE respects the self-sleep gate. All three
 * user-broadcast versions (v0 create, v1 ballot, v3 delegate) must reject a
 * sleeping SOURCE at/after the VOTE_RESPECTS_SLEEP flag-day and preserve the
 * legacy (permissive) acceptance below it; v2 finalize is system-synthesized
 * and stays exempt. The same activation makes v3 validate a set DELEGATE_TO
 * with isCryptoAddress.
 */

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');
const Vote = require('../../../src/actions/vote.js');

// Base58 testnet/regtest-format addresses (shared params), valid on BTC regtest.
const SOURCE_ADDR   = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const DELEGATE_ADDR = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';

describe('VOTE self-sleep gate + DELEGATE_TO validation  @regression @tier1', function () {
    let indexer, actionsCtx, handler;

    beforeEach(function () {
        indexer = createMockIndexer();
        actionsCtx = {
            config:    indexer.config,
            util:      indexer.util,
            mapper:    indexer.mapper,
            decoderDb: indexer.decoderDb,
            indexerDb: indexer.indexerDb,
            protocolChanges: {
                isDefined: sinon.stub().returns(true),
                isEnabled: sinon.stub().resolves(true),
            },
        };
        handler = new Vote(actionsCtx);
        indexer.util.resetLists();

        // Happy-path stubs shared by the create/ballot/delegate paths so the
        // only variable under test is the sleep gate / DELEGATE_TO format.
        indexer.indexerDb.getTokenInfo.resolves({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0, SUPPLY: '1000' });
        indexer.indexerDb.createTicker.resolves(1);
        indexer.indexerDb.getAddressBalances.resolves({ 1: '100' });
        indexer.indexerDb.createPoll           = sinon.stub().resolves();
        indexer.indexerDb.createBallot         = sinon.stub().resolves();
        indexer.indexerDb.createVoteDelegation = sinon.stub().resolves();
        indexer.indexerDb.getPoll = sinon.stub().resolves({
            action_index: 100, poll_status: 'open', end_block: 200, tick_id: 1,
            options: '["yes","no"]', tally_mode: 'approval', max_selections: 1,
        });
    });

    afterEach(function () {
        sinon.restore();
    });

    // Gate stub: VOTE_RESPECTS_SLEEP flips per test; every other change active.
    function gateStub(active) {
        return sinon.stub().callsFake(async (name) =>
            name === 'VOTE_RESPECTS_SLEEP' ? active : true);
    }

    function baseData(overrides = {}) {
        return createBaseData({ ACTION: 'VOTE', BLOCK_INDEX: 100, ACTION_INDEX: 50,
                                SOURCE: SOURCE_ADDR, ...overrides });
    }

    // VERSION|TICK|END_BLOCK|OPTIONS|... (signaling poll, no callback fields)
    const CREATE_PARAMS   = ['0', 'TEST', '200', 'yes,no', '', '', '', '', '', '', '', '', '', '', '', '', '', ''];
    // VERSION|POLL_REF|BALLOT|MEMO
    const BALLOT_PARAMS   = ['1', '100', '0', ''];
    // VERSION|TICK|DELEGATE_TO|MEMO
    function delegateParams(target) { return ['3', 'TEST', target, '']; }

    describe('gate ACTIVE: a sleeping SOURCE is rejected on every user-broadcast version', function () {

        beforeEach(function () {
            actionsCtx.protocolChanges.isEnabled = gateStub(true);
            indexer.indexerDb.isActionAllowed.resolves(false); // SOURCE is sleeping
        });

        it('v0 create → invalid, no poll row, no escrow', async function () {
            const data = baseData({ FORMAT: 0 });
            await handler.parse(CREATE_PARAMS, data, null);
            assert.strictEqual(data.STATUS, 'invalid: SOURCE (sleeping)');
            assert.ok(indexer.indexerDb.createPoll.notCalled, 'no poll row for a sleeping creator');
            assert.ok(indexer.indexerDb.createEscrow.notCalled, 'no GAS moves while the address is frozen');
        });

        it('v1 ballot → invalid, no ballot row', async function () {
            const data = baseData({ FORMAT: 1 });
            await handler.parse(BALLOT_PARAMS, data, null);
            assert.strictEqual(data.STATUS, 'invalid: SOURCE (sleeping)');
            assert.ok(indexer.indexerDb.createBallot.notCalled);
        });

        it('v3 delegate → invalid, no delegation row', async function () {
            const data = baseData({ FORMAT: 3 });
            await handler.parse(delegateParams(DELEGATE_ADDR), data, null);
            assert.strictEqual(data.STATUS, 'invalid: SOURCE (sleeping)');
            assert.ok(indexer.indexerDb.createVoteDelegation.notCalled);
        });

        it('the gate consults isActionAllowed(SOURCE, null, BLOCK_INDEX)', async function () {
            const data = baseData({ FORMAT: 0 });
            await handler.parse(CREATE_PARAMS, data, null);
            assert.ok(indexer.indexerDb.isActionAllowed.calledWith(SOURCE_ADDR, null, 100));
        });

        it('an awake SOURCE stays valid on all three versions', async function () {
            indexer.indexerDb.isActionAllowed.resolves(true);
            for (const [format, params] of [[0, CREATE_PARAMS], [1, BALLOT_PARAMS], [3, delegateParams(DELEGATE_ADDR)]]) {
                const data = baseData({ FORMAT: format });
                await handler.parse(params, data, null);
                assert.strictEqual(data.STATUS, 'valid', 'v' + format + ' must stay valid for an awake source');
            }
        });
    });

    describe('gate INACTIVE: legacy acceptance preserved (byte-identical replay)', function () {

        beforeEach(function () {
            actionsCtx.protocolChanges.isEnabled = gateStub(false);
            indexer.indexerDb.isActionAllowed.resolves(false); // sleeping, but pre-flag-day
        });

        it('v0 create from a sleeping SOURCE stays valid below the flag-day', async function () {
            const data = baseData({ FORMAT: 0 });
            await handler.parse(CREATE_PARAMS, data, null);
            assert.strictEqual(data.STATUS, 'valid');
            assert.ok(indexer.indexerDb.createPoll.calledOnce);
        });

        it('v1 ballot and v3 delegate from a sleeping SOURCE stay valid below the flag-day', async function () {
            for (const [format, params] of [[1, BALLOT_PARAMS], [3, delegateParams(DELEGATE_ADDR)]]) {
                const data = baseData({ FORMAT: format });
                await handler.parse(params, data, null);
                assert.strictEqual(data.STATUS, 'valid', 'v' + format + ' legacy acceptance must be preserved');
            }
        });
    });

    describe('v2 finalize is system-synthesized and exempt from the sleep gate', function () {

        it('finalize never consults isActionAllowed', async function () {
            actionsCtx.protocolChanges.isEnabled = gateStub(true);
            indexer.indexerDb.isActionAllowed.resolves(false);
            indexer.indexerDb.getPoll = sinon.stub().resolves(null); // no-op path is enough
            const data = baseData({ FORMAT: 2, IS_SYNTHETIC: true, POLL_REF: 100 });
            await handler._parseFinalize(data, null);
            assert.ok(indexer.indexerDb.isActionAllowed.notCalled, 'a synthetic finalize must stay exempt');
        });
    });

    describe('v3 DELEGATE_TO isCryptoAddress validation (same activation)', function () {

        it('gate ACTIVE: malformed DELEGATE_TO → invalid, no delegation row', async function () {
            actionsCtx.protocolChanges.isEnabled = gateStub(true);
            const data = baseData({ FORMAT: 3 });
            await handler.parse(delegateParams('notARealAddress'), data, null);
            assert.strictEqual(data.STATUS, 'invalid: DELEGATE_TO (format)');
            assert.ok(indexer.indexerDb.createVoteDelegation.notCalled);
        });

        it('gate ACTIVE: wrong-network DELEGATE_TO (mainnet addr on regtest) → invalid', async function () {
            actionsCtx.protocolChanges.isEnabled = gateStub(true);
            const data = baseData({ FORMAT: 3 });
            await handler.parse(delegateParams('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'), data, null);
            assert.strictEqual(data.STATUS, 'invalid: DELEGATE_TO (format)');
        });

        it('gate ACTIVE: valid regtest DELEGATE_TO → valid, delegation written', async function () {
            actionsCtx.protocolChanges.isEnabled = gateStub(true);
            const data = baseData({ FORMAT: 3 });
            await handler.parse(delegateParams(DELEGATE_ADDR), data, null);
            assert.strictEqual(data.STATUS, 'valid');
            assert.ok(indexer.indexerDb.createVoteDelegation.calledOnce);
        });

        it('gate ACTIVE: blank DELEGATE_TO still clears (format check only applies when set)', async function () {
            actionsCtx.protocolChanges.isEnabled = gateStub(true);
            const data = baseData({ FORMAT: 3 });
            await handler.parse(delegateParams(''), data, null);
            assert.strictEqual(data.STATUS, 'valid');
            assert.ok(indexer.indexerDb.createVoteDelegation.calledOnce, 'a clear (revoke) is still a valid event row');
        });

        it('gate INACTIVE: malformed DELEGATE_TO stays valid (legacy tally-time no-holder behaviour)', async function () {
            actionsCtx.protocolChanges.isEnabled = gateStub(false);
            const data = baseData({ FORMAT: 3 });
            await handler.parse(delegateParams('notARealAddress'), data, null);
            assert.strictEqual(data.STATUS, 'valid');
        });

        it('self-delegation is still rejected ahead of the format check', async function () {
            actionsCtx.protocolChanges.isEnabled = gateStub(true);
            const data = baseData({ FORMAT: 3 });
            await handler.parse(delegateParams(SOURCE_ADDR), data, null);
            assert.strictEqual(data.STATUS, 'invalid: DELEGATE_TO (cannot delegate to self)');
        });
    });

    describe('flag-day registration', function () {

        it('VOTE_RESPECTS_SLEEP is registered as a 2.0.0 gate on the ratified 2026-08-07 anchor', function () {
            const src = fs.readFileSync(
                path.join(__dirname, '..', '..', '..', 'src', 'protocol_changes.js'), 'utf8');
            const m = src.match(/this\.addChange\('VOTE_RESPECTS_SLEEP', '2\.0\.0',(\d+)/);
            assert.ok(m, 'VOTE_RESPECTS_SLEEP must be registered as a 2.0.0 time-gated change');
            assert.strictEqual(parseInt(m[1]), 1786060800,
                'mainnet timestamp must be the ratified coordinated anchor; a divergent value is a fork');
        });
    });
});
