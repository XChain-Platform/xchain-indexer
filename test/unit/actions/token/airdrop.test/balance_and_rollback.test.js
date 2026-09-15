// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// AIRDROP balance and authorization checks (a sleeping SOURCE or TICK, the
// ledger and mapping writes after parse) and the multi-leg staged-balance
// rollback. Part of the AIRDROP suite; see ../airdrop.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData, createTokenInfo } = require('../../../../fixtures/mocks');
const { freshAirdrop } = require('./helpers/airdrop_fixtures.js');

let indexer, actionsCtx, handler;

describe('Airdrop @regression @tier2', function () {
    beforeEach(function () {
        ({ indexer, actionsCtx, handler } = freshAirdrop());
    });

    afterEach(function () {
        sinon.restore();
    });

    // ─── Balance & Authorization edge cases ──────────────────────────

    describe('balance and authorization checks', function () {
        it('SOURCE sleeping → invalid', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves(['mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM']);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1000' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            // SOURCE is sleeping
            indexer.indexerDb.isActionAllowed.callsFake((address, tick, block) => {
                if (address && !tick) return Promise.resolve(false);
                return Promise.resolve(true);
            });

            const data = createBaseData({ ACTION: 'AIRDROP', FORMAT: 0 });
            const params = ['0', 'TEST', '10', '1', null];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

        it('TICK sleeping → invalid', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves(['mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM']);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1000' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            // Tick is sleeping (address=null, tick='TEST')
            indexer.indexerDb.isActionAllowed.callsFake((address, tick, block) => {
                if (!address && tick) return Promise.resolve(false);
                return Promise.resolve(true);
            });

            const data = createBaseData({ ACTION: 'AIRDROP', FORMAT: 0 });
            const params = ['0', 'TEST', '10', '1', null];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });
    });
});

describe('Airdrop @regression @tier2', function () {
    beforeEach(function () {
        ({ indexer, actionsCtx, handler } = freshAirdrop());
    });

    afterEach(function () {
        sinon.restore();
    });

    describe('balance and authorization checks', function () {
        it('updateBalances and updateTokens called after parse', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves(['mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM']);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1000' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data = createBaseData({ ACTION: 'AIRDROP', FORMAT: 0 });
            const params = ['0', 'TEST', '10', '1', null];

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.updateBalances.called, 'updateBalances should be called');
            assert.ok(indexer.indexerDb.updateTokens.called, 'updateTokens should be called');
        });

        it('mapper.createMappings called after parse', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves(['mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM']);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1000' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data = createBaseData({ ACTION: 'AIRDROP', FORMAT: 0 });
            const params = ['0', 'TEST', '10', '1', null];

            await handler.parse(params, data, null);

            assert.ok(indexer.mapper.createMappings.called, 'createMappings should be called');
        });
    });
});

describe('Airdrop @regression @tier2', function () {
    beforeEach(function () {
        ({ indexer, actionsCtx, handler } = freshAirdrop());
    });

    afterEach(function () {
        sinon.restore();
    });

    describe('balance and authorization checks', function () {
        it('empty recipient list (all filtered by isActionAllowed): no credits generated', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves(['mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM']);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1000' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            // All recipients blocked
            indexer.indexerDb.isActionAllowed.callsFake((address, tick) => {
                // source action checks pass, but recipient check fails
                if (address === 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM') return Promise.resolve(false);
                return Promise.resolve(true);
            });

            const data = createBaseData({ ACTION: 'AIRDROP', FORMAT: 0 });
            const params = ['0', 'TEST', '10', '1', null];

            await handler.parse(params, data, null);

            // Still valid (zero recipients is allowed), createAirdrop still called
            assert.ok(indexer.indexerDb.createAirdrop.called);
        });
    });
});

describe('Airdrop @regression @tier2', function () {
    beforeEach(function () {
        ({ indexer, actionsCtx, handler } = freshAirdrop());
    });

    afterEach(function () {
        sinon.restore();
    });

    // A leg that fails AFTER its TICK debit (e.g. at the fee
    // check) must not leave that debit applied to the shared balances, or the next
    // leg airdropping the same tick is measured against an under-counted balance
    // and wrongly rejected with insufficient TICK instead of its real verdict.
    describe('multi-leg staged-balance rollback', function () {
        it('a fee-failed leg does not consume TICK balance from the next leg', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getTickerId.resolves(9);   // fee/GAS tick id
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves(['mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM']);
            // Enough TEST for ONE full leg (10); not enough GAS for the 50 fee.
            indexer.indexerDb.getAddressBalances.resolves({ 1: '10', 9: '40' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.isActionAllowed.resolves(true);
            sinon.stub(indexer.util, 'getUnifiedTransactionFee').returns({ gasCost: '1', fee: '50' });

            const statuses = [];
            indexer.indexerDb.createAirdrop = sinon.stub().callsFake(async a => { statuses.push(a.STATUS); });

            const data = createBaseData({ ACTION: 'AIRDROP', FORMAT: 2 });
            // FORMAT 2: VERSION|TICK|AMOUNT|LIST|TICK|AMOUNT|LIST|MEMO - same tick both legs.
            const params = ['2', 'TEST', '10', '1', 'TEST', '10', '2', 'memo'];
            await handler.parse(params, data, null);

            assert.strictEqual(statuses.length, 2);
            // Both legs fail at the FEE stage. Before the staged-view fix, leg 1's
            // TICK debit stuck and leg 2 failed 'invalid: insufficient funds (TICK)'.
            assert.strictEqual(statuses[0], 'invalid: insufficient funds (FEE)');
            assert.strictEqual(statuses[1], 'invalid: insufficient funds (FEE)');
        });
    });
});
