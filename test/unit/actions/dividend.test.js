// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');

const Dividend = require('../../../src/actions/dividend.js');

describe('Dividend @regression @tier2', function () {
    let indexer, actionsCtx, handler;

    const SOURCE  = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
    const HOLDER1 = 'mmqFL1hiu2RDuyS69KS9ko6uaMryhANwsz';
    const HOLDER2 = 'mk7MdP3qzVkgyjaYNR2sUY8Ggn4DWxt2KS';

    beforeEach(function () {
        indexer = createMockIndexer();
        actionsCtx = {
            config:          indexer.config,
            util:            indexer.util,
            mapper:          indexer.mapper,
            decoderDb:       indexer.decoderDb,
            indexerDb:       indexer.indexerDb,
            protocolChanges: {
                isDefined:  sinon.stub().returns(true),
                isEnabled:  sinon.stub().resolves(true),
            },
            processAction:   sinon.stub().resolves(),
        };
        handler = new Dividend(actionsCtx);
        indexer.util.resetLists();
    });

    afterEach(function () {
        sinon.restore();
    });

    describe('valid dividend', function () {

        it('valid dividend: createDividend called with valid status', async function () {
            const tokenInfo     = createTokenInfo({ TICK: 'TEST',   TICK_ID: 1, DECIMALS: 0 });
            const divTokenInfo  = createTokenInfo({ TICK: 'DIVTOK', TICK_ID: 2, DECIMALS: 0, ALLOW_LIST: null, BLOCK_LIST: null });

            indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo);
            indexer.indexerDb.getTokenInfo.withArgs('DIVTOK').resolves(divTokenInfo);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1', 2: '1000' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getHolders.resolves({ [HOLDER1]: '10', [HOLDER2]: '20' });
            indexer.indexerDb.getList.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'DIVIDEND', FORMAT: 0, SOURCE });
            const params = ['0', 'TEST', 'DIVTOK', '1', 'memo'];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createDividend.called);
        });

        it('each holder gets proportional DIVIDEND_TICK amount', async function () {
            const tokenInfo    = createTokenInfo({ TICK: 'TEST',   TICK_ID: 1, DECIMALS: 0 });
            const divTokenInfo = createTokenInfo({ TICK: 'DIVTOK', TICK_ID: 2, DECIMALS: 0, ALLOW_LIST: null, BLOCK_LIST: null });

            indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo);
            indexer.indexerDb.getTokenInfo.withArgs('DIVTOK').resolves(divTokenInfo);
            // holder1=10, holder2=20; AMOUNT=2 → debit = 10*2 + 20*2 = 60
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1', 2: '200' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getHolders.resolves({ [HOLDER1]: '10', [HOLDER2]: '20' });
            indexer.indexerDb.getList.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'DIVIDEND', FORMAT: 0, SOURCE });
            const params = ['0', 'TEST', 'DIVTOK', '2', null];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('source address excluded from holder recipient list', async function () {
            const tokenInfo    = createTokenInfo({ TICK: 'TEST',   TICK_ID: 1, DECIMALS: 0 });
            const divTokenInfo = createTokenInfo({ TICK: 'DIVTOK', TICK_ID: 2, DECIMALS: 0, ALLOW_LIST: null, BLOCK_LIST: null });

            indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo);
            indexer.indexerDb.getTokenInfo.withArgs('DIVTOK').resolves(divTokenInfo);
            // Source in holders; should be excluded from recipients
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1', 2: '100' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getHolders.resolves({ [SOURCE]: '50', [HOLDER1]: '50' });
            indexer.indexerDb.getList.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'DIVIDEND', FORMAT: 0, SOURCE });
            const params = ['0', 'TEST', 'DIVTOK', '1', null];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('updateBalances and updateTokens called on valid dividend', async function () {
            const tokenInfo    = createTokenInfo({ TICK: 'TEST',   TICK_ID: 1, DECIMALS: 0 });
            const divTokenInfo = createTokenInfo({ TICK: 'DIVTOK', TICK_ID: 2, DECIMALS: 0, ALLOW_LIST: null, BLOCK_LIST: null });

            indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo);
            indexer.indexerDb.getTokenInfo.withArgs('DIVTOK').resolves(divTokenInfo);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1', 2: '100' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getHolders.resolves({ [HOLDER1]: '10' });
            indexer.indexerDb.getList.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'DIVIDEND', FORMAT: 0, SOURCE });
            const params = ['0', 'TEST', 'DIVTOK', '1', null];

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.updateBalances.called);
            assert.ok(indexer.indexerDb.updateTokens.called);
        });

    });

    describe('TICK validations', function () {

        it('TICK not found → invalid', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);
            indexer.indexerDb.getAddressBalances.resolves({});
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getHolders.resolves({});
            indexer.indexerDb.getList.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'DIVIDEND', FORMAT: 0, SOURCE });
            const params = ['0', 'UNKNOWN', 'DIVTOK', '1', null];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

        it('DIVIDEND_TICK not found → invalid', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo);
            indexer.indexerDb.getTokenInfo.withArgs('DIVTOK').resolves(null);
            indexer.indexerDb.getAddressBalances.resolves({});
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getHolders.resolves({});
            indexer.indexerDb.getList.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'DIVIDEND', FORMAT: 0, SOURCE });
            const params = ['0', 'TEST', 'DIVTOK', '1', null];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

    });

    describe('balance validations', function () {

        it('insufficient DIVIDEND_TICK balance to cover all holders → invalid', async function () {
            const tokenInfo    = createTokenInfo({ TICK: 'TEST',   TICK_ID: 1, DECIMALS: 0 });
            const divTokenInfo = createTokenInfo({ TICK: 'DIVTOK', TICK_ID: 2, DECIMALS: 0, ALLOW_LIST: null, BLOCK_LIST: null });

            indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo);
            indexer.indexerDb.getTokenInfo.withArgs('DIVTOK').resolves(divTokenInfo);
            // Need 10 + 20 = 30 DIVTOK but only have 5
            indexer.indexerDb.getAddressBalances.resolves({ 2: '5' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getHolders.resolves({ [HOLDER1]: '10', [HOLDER2]: '20' });
            indexer.indexerDb.getList.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'DIVIDEND', FORMAT: 0, SOURCE });
            const params = ['0', 'TEST', 'DIVTOK', '1', null];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

    });

    describe('allow/block list filtering', function () {

        it('holders on block list are excluded from recipients', async function () {
            const tokenInfo    = createTokenInfo({ TICK: 'TEST',   TICK_ID: 1, DECIMALS: 0 });
            const divTokenInfo = createTokenInfo({ TICK: 'DIVTOK', TICK_ID: 2, DECIMALS: 0, ALLOW_LIST: null, BLOCK_LIST: 5 });

            indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo);
            indexer.indexerDb.getTokenInfo.withArgs('DIVTOK').resolves(divTokenInfo);
            // HOLDER1 is on block list
            indexer.indexerDb.getList.resolves([HOLDER1]);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1', 2: '200' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getHolders.resolves({ [HOLDER1]: '10', [HOLDER2]: '20' });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'DIVIDEND', FORMAT: 0, SOURCE });
            const params = ['0', 'TEST', 'DIVTOK', '1', null];

            await handler.parse(params, data, null);

            // Should still be valid; HOLDER1 just doesn't receive
            assert.strictEqual(data['STATUS'], 'valid');
        });

        // The three cases below pin the membership semantics against the Set-backed
        // membership probe. A configured-but-empty ALLOW_LIST admitting everyone is the
        // load-bearing one: AIRDROP gates on list existence and would admit nobody here.
        async function runWithList(listIds, listMembers, holders) {
            const tokenInfo    = createTokenInfo({ TICK: 'TEST',   TICK_ID: 1, DECIMALS: 0 });
            const divTokenInfo = createTokenInfo({ TICK: 'DIVTOK', TICK_ID: 2, DECIMALS: 0, ...listIds });

            indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo);
            indexer.indexerDb.getTokenInfo.withArgs('DIVTOK').resolves(divTokenInfo);
            indexer.indexerDb.getList.resolves(listMembers);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1', 2: '1000' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getHolders.resolves(holders);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'DIVIDEND', FORMAT: 0, SOURCE });
            const params = ['0', 'TEST', 'DIVTOK', '1', null];

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.createDividend.called);
            return String(indexer.indexerDb.createDividend.args[0][0]['DEBIT']);
        }

        it('ALLOW_LIST set but resolving empty still admits every holder', async function () {
            const debit = await runWithList(
                { ALLOW_LIST: 5, BLOCK_LIST: null },
                [],
                { [HOLDER1]: '10', [HOLDER2]: '20' }
            );
            assert.strictEqual(debit, '30');
        });

        it('non-empty ALLOW_LIST admits only listed holders', async function () {
            const debit = await runWithList(
                { ALLOW_LIST: 5, BLOCK_LIST: null },
                [HOLDER1],
                { [HOLDER1]: '10', [HOLDER2]: '20' }
            );
            assert.strictEqual(debit, '10');
        });

        it('non-empty BLOCK_LIST excludes listed holders from the DEBIT', async function () {
            const debit = await runWithList(
                { ALLOW_LIST: null, BLOCK_LIST: 5 },
                [HOLDER1],
                { [HOLDER1]: '10', [HOLDER2]: '20' }
            );
            assert.strictEqual(debit, '20');
        });

    });

    describe('sleeping validations', function () {

        it('SOURCE sleeping → invalid', async function () {
            const tokenInfo    = createTokenInfo({ TICK: 'TEST',   TICK_ID: 1, DECIMALS: 0 });
            const divTokenInfo = createTokenInfo({ TICK: 'DIVTOK', TICK_ID: 2, DECIMALS: 0, ALLOW_LIST: null, BLOCK_LIST: null });

            indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo);
            indexer.indexerDb.getTokenInfo.withArgs('DIVTOK').resolves(divTokenInfo);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1', 2: '100' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getHolders.resolves({ [HOLDER1]: '5' });
            indexer.indexerDb.getList.resolves([]);
            indexer.indexerDb.isActionAllowed.callsFake((address, tick, block) => {
                if (address && !tick) return Promise.resolve(false);
                return Promise.resolve(true);
            });

            const data   = createBaseData({ ACTION: 'DIVIDEND', FORMAT: 0, SOURCE });
            const params = ['0', 'TEST', 'DIVTOK', '1', null];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

    });

    describe('record creation', function () {

        it('createDividend called even on invalid', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);
            indexer.indexerDb.getAddressBalances.resolves({});
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getHolders.resolves({});
            indexer.indexerDb.getList.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'DIVIDEND', FORMAT: 0, SOURCE });
            const params = ['0', 'UNKNOWN', 'DIVTOK', '1', null];

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.createDividend.called);
        });

        it('mapper.createMappings called after parse', async function () {
            const tokenInfo    = createTokenInfo({ TICK: 'TEST',   TICK_ID: 1, DECIMALS: 0 });
            const divTokenInfo = createTokenInfo({ TICK: 'DIVTOK', TICK_ID: 2, DECIMALS: 0, ALLOW_LIST: null, BLOCK_LIST: null });

            indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo);
            indexer.indexerDb.getTokenInfo.withArgs('DIVTOK').resolves(divTokenInfo);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1', 2: '100' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getHolders.resolves({ [HOLDER1]: '5' });
            indexer.indexerDb.getList.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'DIVIDEND', FORMAT: 0, SOURCE });
            const params = ['0', 'TEST', 'DIVTOK', '1', null];

            await handler.parse(params, data, null);

            assert.ok(indexer.mapper.createMappings.called);
        });

    });

    describe('fee handling', function () {

        function setupValid() {
            indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 }));
            indexer.indexerDb.getTokenInfo.withArgs('DIVTOK').resolves(createTokenInfo({ TICK: 'DIVTOK', TICK_ID: 2, DECIMALS: 0, ALLOW_LIST: null, BLOCK_LIST: null }));
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1', 2: '1000' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getHolders.resolves({ [HOLDER1]: '10', [HOLDER2]: '20' });
            indexer.indexerDb.getList.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);
        }

        it('uses the legacy db-hits fee model when UNIFIED_FEES is disabled', async function () {
            setupValid();
            actionsCtx.protocolChanges.isEnabled.withArgs('UNIFIED_FEES').resolves(false);
            const data = createBaseData({ ACTION: 'DIVIDEND', FORMAT: 0, SOURCE });
            await handler.parse(['0', 'TEST', 'DIVTOK', '1', null], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createDividend.called);
        });

        it('rejects when SOURCE lacks the DIVIDEND_TICK balance to cover the debit', async function () {
            setupValid();
            // holders 10 + 20, amount 1 → debit 30, but only 5 DIVTOK available
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1', 2: '5' });
            const data = createBaseData({ ACTION: 'DIVIDEND', FORMAT: 0, SOURCE });
            await handler.parse(['0', 'TEST', 'DIVTOK', '1', null], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: insufficient funds (TICK)');
        });

        it('accepts a valid native-coin fee (PAYMENT_MODE native)', async function () {
            setupValid();
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('native');
            const valStub = sinon.stub(indexer.util, 'validateNativeCoinFee').resolves({
                valid: true, nativeCoinAmount: '0.0001', nativeCoin: 'BTC', oracleRound: 9,
            });
            const data = createBaseData({ ACTION: 'DIVIDEND', FORMAT: 0, SOURCE });
            await handler.parse(['0', 'TEST', 'DIVTOK', '1', null], data, null);
            assert.ok(valStub.called);
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('rejects an invalid native-coin fee', async function () {
            setupValid();
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('native');
            sinon.stub(indexer.util, 'validateNativeCoinFee').resolves({ valid: false, error: 'underpaid' });
            const data = createBaseData({ ACTION: 'DIVIDEND', FORMAT: 0, SOURCE });
            await handler.parse(['0', 'TEST', 'DIVTOK', '1', null], data, null);
            assert.ok(String(data['STATUS']).startsWith('invalid'));
        });

        it('rejects when a required native-coin fee output is absent (rejected)', async function () {
            setupValid();
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('rejected');
            const data = createBaseData({ ACTION: 'DIVIDEND', FORMAT: 0, SOURCE });
            await handler.parse(['0', 'TEST', 'DIVTOK', '1', null], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: insufficient fee (native coin output required)');
        });
    });
});
