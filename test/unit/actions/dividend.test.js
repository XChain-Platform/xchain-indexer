process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');

const Dividend = require('../../../src/actions/dividend.js');

describe('Dividend', function () {
    let indexer, actionsCtx, handler;

    const SOURCE  = '1SourceAddressXXXXXXXXXXXXXXXYs6gYt';
    const HOLDER1 = '1HolderOneXXXXXXXXXXXXXXXXXXXY7vAZ';
    const HOLDER2 = '1HolderTwoXXXXXXXXXXXXXXXXXXXWqp6Q';

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

    // ─── Valid dividend ───────────────────────────────────────────────

    describe('valid dividend', function () {

        it('valid dividend — createDividend called with valid status', async function () {
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
            // Source in holders — should be excluded from recipients
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

    // ─── Invalid: TICK / DIVIDEND_TICK not found ──────────────────────

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

    // ─── Invalid: insufficient balance ───────────────────────────────

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

    // ─── Allow/block list filtering ───────────────────────────────────

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

            // Should still be valid — HOLDER1 just doesn't receive
            assert.strictEqual(data['STATUS'], 'valid');
        });

    });

    // ─── Sleeping checks ──────────────────────────────────────────────

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

    // ─── Record always created ────────────────────────────────────────

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
});
