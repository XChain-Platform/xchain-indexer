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

const Callback = require('../../../src/actions/callback.js');

describe('Callback @regression @tier3', function () {
    let indexer, actionsCtx, handler;

    const OWNER   = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
    const OTHER   = '1OtherAddressXXXXXXXXXXXXXXXXVtKwXp';
    const HOLDER1 = 'mmqFL1hiu2RDuyS69KS9ko6uaMryhANwsz';
    const HOLDER2 = 'mk7MdP3qzVkgyjaYNR2sUY8Ggn4DWxt2KS';

    function makeTokenInfo(overrides = {}) {
        return createTokenInfo({
            TICK: 'TEST',
            TICK_ID: 1,
            OWNER,
            DECIMALS: 0,
            LOCK_CALLBACK: 0,
            CALLBACK_BLOCK: 90,
            CALLBACK_TICK: 'CBTEST',
            CALLBACK_AMOUNT: '1',
            ...overrides,
        });
    }

    function makeCallbackTokenInfo(overrides = {}) {
        return createTokenInfo({
            TICK: 'CBTEST',
            TICK_ID: 2,
            DECIMALS: 0,
            ALLOW_LIST: null,
            BLOCK_LIST: null,
            ...overrides,
        });
    }

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
        handler = new Callback(actionsCtx);
        indexer.util.resetLists();
    });

    afterEach(function () {
        sinon.restore();
    });

    describe('valid callback', function () {

        it('owner can callback: createCallback called with valid status', async function () {
            const tokenInfo   = makeTokenInfo();
            const cbTokenInfo = makeCallbackTokenInfo();

            indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo);
            indexer.indexerDb.getTokenInfo.withArgs('CBTEST').resolves(cbTokenInfo);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1', 2: '100' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getHolders.resolves({ [HOLDER1]: '10', [HOLDER2]: '20' });
            indexer.indexerDb.getList.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data = createBaseData({ ACTION: 'CALLBACK', FORMAT: 0, SOURCE: OWNER, BLOCK_INDEX: 100 });
            const params = ['0', 'TEST', 'memo'];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createCallback.called);
        });

        it('holders receive CALLBACK_TICK credits', async function () {
            const tokenInfo   = makeTokenInfo();
            const cbTokenInfo = makeCallbackTokenInfo();

            indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo);
            indexer.indexerDb.getTokenInfo.withArgs('CBTEST').resolves(cbTokenInfo);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1', 2: '200' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getHolders.resolves({ [HOLDER1]: '10', [HOLDER2]: '20' });
            indexer.indexerDb.getList.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data = createBaseData({ ACTION: 'CALLBACK', FORMAT: 0, SOURCE: OWNER, BLOCK_INDEX: 100 });
            const params = ['0', 'TEST', null];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.updateBalances.called);
        });

        it('source not in holders: no debit for source', async function () {
            const tokenInfo   = makeTokenInfo();
            const cbTokenInfo = makeCallbackTokenInfo();

            indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo);
            indexer.indexerDb.getTokenInfo.withArgs('CBTEST').resolves(cbTokenInfo);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1', 2: '50' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            // holders list includes source; source should be skipped
            indexer.indexerDb.getHolders.resolves({ [OWNER]: '100', [HOLDER1]: '50' });
            indexer.indexerDb.getList.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data = createBaseData({ ACTION: 'CALLBACK', FORMAT: 0, SOURCE: OWNER, BLOCK_INDEX: 100 });
            const params = ['0', 'TEST', null];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
        });

    });

    describe('authorization checks', function () {

        it('non-owner cannot callback → invalid', async function () {
            const tokenInfo   = makeTokenInfo({ OWNER });
            const cbTokenInfo = makeCallbackTokenInfo();

            indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo);
            indexer.indexerDb.getTokenInfo.withArgs('CBTEST').resolves(cbTokenInfo);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1', 2: '100' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getHolders.resolves({ [HOLDER1]: '10' });
            indexer.indexerDb.getList.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data = createBaseData({ ACTION: 'CALLBACK', FORMAT: 0, SOURCE: OTHER, BLOCK_INDEX: 100 });
            const params = ['0', 'TEST', null];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

        it('LOCK_CALLBACK set → invalid', async function () {
            const tokenInfo   = makeTokenInfo({ LOCK_CALLBACK: 1 });
            const cbTokenInfo = makeCallbackTokenInfo();

            indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo);
            indexer.indexerDb.getTokenInfo.withArgs('CBTEST').resolves(cbTokenInfo);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1', 2: '100' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getHolders.resolves({});
            indexer.indexerDb.getList.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data = createBaseData({ ACTION: 'CALLBACK', FORMAT: 0, SOURCE: OWNER, BLOCK_INDEX: 100 });
            const params = ['0', 'TEST', null];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

    });

    describe('CALLBACK_BLOCK validations', function () {

        it('CALLBACK_BLOCK > current block → invalid (not yet reached)', async function () {
            const tokenInfo   = makeTokenInfo({ CALLBACK_BLOCK: 200 });  // future block
            const cbTokenInfo = makeCallbackTokenInfo();

            indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo);
            indexer.indexerDb.getTokenInfo.withArgs('CBTEST').resolves(cbTokenInfo);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1', 2: '100' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getHolders.resolves({});
            indexer.indexerDb.getList.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data = createBaseData({ ACTION: 'CALLBACK', FORMAT: 0, SOURCE: OWNER, BLOCK_INDEX: 100 });
            const params = ['0', 'TEST', null];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

        it('CALLBACK_BLOCK === current block → valid', async function () {
            const tokenInfo   = makeTokenInfo({ CALLBACK_BLOCK: 100 });
            const cbTokenInfo = makeCallbackTokenInfo();

            indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo);
            indexer.indexerDb.getTokenInfo.withArgs('CBTEST').resolves(cbTokenInfo);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1', 2: '100' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getHolders.resolves({ [HOLDER1]: '5' });
            indexer.indexerDb.getList.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data = createBaseData({ ACTION: 'CALLBACK', FORMAT: 0, SOURCE: OWNER, BLOCK_INDEX: 100 });
            const params = ['0', 'TEST', null];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
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

            const data = createBaseData({ ACTION: 'CALLBACK', FORMAT: 0, SOURCE: OWNER, BLOCK_INDEX: 100 });
            const params = ['0', 'UNKNOWN', null];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

        it('CALLBACK_TICK not found → invalid', async function () {
            const tokenInfo = makeTokenInfo({ CALLBACK_TICK: 'MISSING' });
            indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo);
            indexer.indexerDb.getTokenInfo.withArgs('MISSING').resolves(null);
            indexer.indexerDb.getAddressBalances.resolves({});
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getHolders.resolves({});
            indexer.indexerDb.getList.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data = createBaseData({ ACTION: 'CALLBACK', FORMAT: 0, SOURCE: OWNER, BLOCK_INDEX: 100 });
            const params = ['0', 'TEST', null];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

    });

    describe('balance validations', function () {

        it('insufficient CALLBACK_TICK balance → invalid', async function () {
            const tokenInfo   = makeTokenInfo({ CALLBACK_AMOUNT: '100' });
            const cbTokenInfo = makeCallbackTokenInfo();

            indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo);
            indexer.indexerDb.getTokenInfo.withArgs('CBTEST').resolves(cbTokenInfo);
            // SOURCE only has 5 CBTEST but needs 100 * holders
            indexer.indexerDb.getAddressBalances.resolves({ 2: '5' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getHolders.resolves({ [HOLDER1]: '10', [HOLDER2]: '20' });
            indexer.indexerDb.getList.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data = createBaseData({ ACTION: 'CALLBACK', FORMAT: 0, SOURCE: OWNER, BLOCK_INDEX: 100 });
            const params = ['0', 'TEST', null];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

    });

    describe('record creation', function () {

        it('createCallback called even on invalid', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);
            indexer.indexerDb.getAddressBalances.resolves({});
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getHolders.resolves({});
            indexer.indexerDb.getList.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data = createBaseData({ ACTION: 'CALLBACK', FORMAT: 0, SOURCE: OWNER, BLOCK_INDEX: 100 });
            const params = ['0', 'UNKNOWN', null];

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.createCallback.called);
        });

        it('mapper.createMappings called after parse', async function () {
            const tokenInfo   = makeTokenInfo();
            const cbTokenInfo = makeCallbackTokenInfo();

            indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo);
            indexer.indexerDb.getTokenInfo.withArgs('CBTEST').resolves(cbTokenInfo);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1', 2: '100' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getHolders.resolves({ [HOLDER1]: '5' });
            indexer.indexerDb.getList.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data = createBaseData({ ACTION: 'CALLBACK', FORMAT: 0, SOURCE: OWNER, BLOCK_INDEX: 100 });
            const params = ['0', 'TEST', null];

            await handler.parse(params, data, null);

            assert.ok(indexer.mapper.createMappings.called);
        });

    });

    // The default suite covers XCHAIN-balance fee deduction; these drive the
    // native-coin payment-mode branch (detectFeePaymentMode → 'native'/'rejected').

    describe('native-coin fee payment', function () {

        function setupValid() {
            indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(makeTokenInfo());
            indexer.indexerDb.getTokenInfo.withArgs('CBTEST').resolves(makeCallbackTokenInfo());
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1', 2: '100' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getHolders.resolves({ [HOLDER1]: '10', [HOLDER2]: '20' });
            indexer.indexerDb.getList.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);
        }

        it('accepts a valid native-coin fee (PAYMENT_MODE native)', async function () {
            setupValid();
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('native');
            const valStub = sinon.stub(indexer.util, 'validateNativeCoinFee').resolves({
                valid: true, nativeCoinAmount: '0.0001', nativeCoin: 'BTC', oracleRound: 7,
            });
            const data = createBaseData({ ACTION: 'CALLBACK', FORMAT: 0, SOURCE: OWNER, BLOCK_INDEX: 100 });
            await handler.parse(['0', 'TEST', null], data, null);
            assert.ok(valStub.called);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createCallback.called);
        });

        it('rejects an invalid native-coin fee (validation.valid=false)', async function () {
            setupValid();
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('native');
            sinon.stub(indexer.util, 'validateNativeCoinFee').resolves({ valid: false, error: 'underpaid' });
            const data = createBaseData({ ACTION: 'CALLBACK', FORMAT: 0, SOURCE: OWNER, BLOCK_INDEX: 100 });
            await handler.parse(['0', 'TEST', null], data, null);
            assert.ok(String(data['STATUS']).startsWith('invalid'));
        });

        it('rejects when native-coin output is required but absent (rejected)', async function () {
            setupValid();
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('rejected');
            const data = createBaseData({ ACTION: 'CALLBACK', FORMAT: 0, SOURCE: OWNER, BLOCK_INDEX: 100 });
            await handler.parse(['0', 'TEST', null], data, null);
            assert.ok(String(data['STATUS']).startsWith('invalid'));
        });
    });

    describe('validation guards', function () {

        function setup(tokenOverrides = {}, cbOverrides = {}) {
            indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(makeTokenInfo(tokenOverrides));
            indexer.indexerDb.getTokenInfo.withArgs('CBTEST').resolves(makeCallbackTokenInfo(cbOverrides));
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1', 2: '100' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getHolders.resolves({ [HOLDER1]: '10', [HOLDER2]: '20' });
            indexer.indexerDb.getList.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);
        }

        async function run(params, dataOverrides = {}) {
            const data = createBaseData({ ACTION: 'CALLBACK', FORMAT: 0, SOURCE: OWNER, BLOCK_INDEX: 100, ...dataOverrides });
            await handler.parse(params, data, null);
            return data;
        }

        it('rejects when LOCK_CALLBACK is set', async function () {
            setup({ LOCK_CALLBACK: 1 });
            const data = await run(['0', 'TEST', null]);
            assert.strictEqual(data['STATUS'], 'invalid: LOCK_CALLBACK');
        });

        it('rejects when the TICK ownership is escrowed', async function () {
            setup();
            indexer.indexerDb.isOwnershipEscrowed.resolves(true);
            const data = await run(['0', 'TEST', null]);
            assert.strictEqual(data['STATUS'], 'invalid: TICK (ownership escrowed)');
        });

        it('rejects a malformed CALLBACK_BLOCK', async function () {
            setup({ CALLBACK_BLOCK: '9.5' });
            const data = await run(['0', 'TEST', null]);
            assert.strictEqual(data['STATUS'], 'invalid: CALLBACK_BLOCK (format)');
        });

        it('rejects a malformed CALLBACK_AMOUNT', async function () {
            setup({ CALLBACK_AMOUNT: '1.5' }); // CBTEST DECIMALS=0 → fractional invalid
            const data = await run(['0', 'TEST', null]);
            assert.strictEqual(data['STATUS'], 'invalid: CALLBACK_AMOUNT (format)');
        });

        it('rejects when SOURCE is sleeping', async function () {
            setup();
            indexer.indexerDb.isActionAllowed.callsFake(async (addr) => addr !== OWNER);
            const data = await run(['0', 'TEST', null]);
            assert.strictEqual(data['STATUS'], 'invalid: SOURCE (sleeping)');
        });

        it('rejects when the TICK is sleeping', async function () {
            setup();
            indexer.indexerDb.isActionAllowed.callsFake(async (addr, tick) => tick !== 'TEST');
            const data = await run(['0', 'TEST', null]);
            assert.strictEqual(data['STATUS'], 'invalid: TICK (sleeping)');
        });

        it('rejects when the CALLBACK_TICK is sleeping', async function () {
            setup();
            indexer.indexerDb.isActionAllowed.callsFake(async (addr, tick) => tick !== 'CBTEST');
            const data = await run(['0', 'TEST', null]);
            assert.strictEqual(data['STATUS'], 'invalid: CALLBACK_TICK (sleeping)');
        });

        it('rejects when CALLBACK_BLOCK is in the future', async function () {
            setup({ CALLBACK_BLOCK: 200 }); // > BLOCK_INDEX 100
            const data = await run(['0', 'TEST', null]);
            assert.strictEqual(data['STATUS'], 'invalid: CALLBACK_BLOCK (block index)');
        });

        it('rejects a MEMO containing a pipe', async function () {
            setup();
            const data = await run(['0', 'TEST', 'a|b']);
            assert.strictEqual(data['STATUS'], 'invalid: MEMO (pipe)');
        });

        it('rejects a MEMO containing a semicolon', async function () {
            setup();
            const data = await run(['0', 'TEST', 'a;b']);
            assert.strictEqual(data['STATUS'], 'invalid: MEMO (semicolon)');
        });

        it('rejects a MEMO exceeding MAX_MEMO_LENGTH', async function () {
            setup();
            const data = await run(['0', 'TEST', 'x'.repeat(5000)]);
            assert.strictEqual(data['STATUS'], 'invalid: MEMO (length)');
        });
    });

    describe('holder allow/block list filtering', function () {

        function setup(cbOverrides) {
            indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(makeTokenInfo());
            indexer.indexerDb.getTokenInfo.withArgs('CBTEST').resolves(makeCallbackTokenInfo(cbOverrides));
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1', 2: '100' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            // include the SOURCE as a holder to drive the source-skip branch too
            indexer.indexerDb.getHolders.resolves({ [OWNER]: '5', [HOLDER1]: '10', [HOLDER2]: '20' });
            indexer.indexerDb.isActionAllowed.resolves(true);
        }

        it('excludes holders not on the CALLBACK_TICK ALLOW_LIST', async function () {
            setup({ ALLOW_LIST: 70 });
            indexer.indexerDb.getList.callsFake(async (id) => (id === 70 ? [HOLDER1] : []));
            const data = createBaseData({ ACTION: 'CALLBACK', FORMAT: 0, SOURCE: OWNER, BLOCK_INDEX: 100 });
            await handler.parse(['0', 'TEST', null], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            // only HOLDER1 should be credited (HOLDER2 filtered out)
            const credited = indexer.indexerDb.createCredit.getCalls().map(c => c.args[3]);
            assert.ok(credited.includes(HOLDER1));
            assert.ok(!credited.includes(HOLDER2));
        });

        it('excludes holders on the CALLBACK_TICK BLOCK_LIST', async function () {
            setup({ BLOCK_LIST: 71 });
            indexer.indexerDb.getList.callsFake(async (id) => (id === 71 ? [HOLDER2] : []));
            const data = createBaseData({ ACTION: 'CALLBACK', FORMAT: 0, SOURCE: OWNER, BLOCK_INDEX: 100 });
            await handler.parse(['0', 'TEST', null], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            const credited = indexer.indexerDb.createCredit.getCalls().map(c => c.args[3]);
            assert.ok(!credited.includes(HOLDER2));
        });
    });

    it('falls back to a generic message when native fee fails without error text', async function () {
        indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(makeTokenInfo());
        indexer.indexerDb.getTokenInfo.withArgs('CBTEST').resolves(makeCallbackTokenInfo());
        indexer.indexerDb.getAddressBalances.resolves({ 1: '1', 2: '100' });
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.getHolders.resolves({ [HOLDER1]: '10' });
        indexer.indexerDb.getList.resolves([]);
        indexer.indexerDb.isActionAllowed.resolves(true);
        sinon.stub(indexer.util, 'detectFeePaymentMode').returns('native');
        sinon.stub(indexer.util, 'validateNativeCoinFee').resolves({ valid: false }); // no .error
        const data = createBaseData({ ACTION: 'CALLBACK', FORMAT: 0, SOURCE: OWNER, BLOCK_INDEX: 100 });
        await handler.parse(['0', 'TEST', null], data, null);
        assert.strictEqual(data['STATUS'], 'invalid: native coin fee validation failed');
    });
});
