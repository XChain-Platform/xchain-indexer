process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');

const Callback = require('../../../src/actions/callback.js');

describe('Callback', function () {
    let indexer, actionsCtx, handler;

    const OWNER   = '1SourceAddressXXXXXXXXXXXXXXXYs6gYt';
    const OTHER   = '1OtherAddressXXXXXXXXXXXXXXXXVtKwXp';
    const HOLDER1 = '1HolderOneXXXXXXXXXXXXXXXXXXXY7vAZ';
    const HOLDER2 = '1HolderTwoXXXXXXXXXXXXXXXXXXXWqp6Q';

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

    // ─── Valid path ───────────────────────────────────────────────────

    describe('valid callback', function () {

        it('owner can callback — createCallback called with valid status', async function () {
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

        it('source not in holders — no debit for source', async function () {
            const tokenInfo   = makeTokenInfo();
            const cbTokenInfo = makeCallbackTokenInfo();

            indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo);
            indexer.indexerDb.getTokenInfo.withArgs('CBTEST').resolves(cbTokenInfo);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1', 2: '50' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            // holders list includes source — source should be skipped
            indexer.indexerDb.getHolders.resolves({ [OWNER]: '100', [HOLDER1]: '50' });
            indexer.indexerDb.getList.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data = createBaseData({ ACTION: 'CALLBACK', FORMAT: 0, SOURCE: OWNER, BLOCK_INDEX: 100 });
            const params = ['0', 'TEST', null];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
        });

    });

    // ─── Invalid: authorization ───────────────────────────────────────

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

    // ─── Invalid: block index ─────────────────────────────────────────

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

    // ─── Invalid: TICK not found ──────────────────────────────────────

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

    // ─── Invalid: insufficient balance ───────────────────────────────

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

    // ─── createCallback always called ────────────────────────────────

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
});
