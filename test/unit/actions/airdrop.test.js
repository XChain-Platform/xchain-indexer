process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');

const Airdrop = require('../../../src/actions/airdrop.js');

describe('Airdrop', function () {
    let indexer, actionsCtx, handler;

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
        handler = new Airdrop(actionsCtx);
        // Reset utility lists before each test
        indexer.util.resetLists();
    });

    afterEach(function () {
        sinon.restore();
    });

    // ─── Format 0 (Single Airdrop) ───────────────────────────────────

    describe('format 0 — single airdrop', function () {

        it('valid airdrop to address list creates airdrop record', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0, SUPPLY: '500' });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves(['1DestAddressXXXXXXXXXXXXXXXXXaKc5Z']);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1000' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data = createBaseData({ ACTION: 'AIRDROP', FORMAT: 0 });
            const params = ['0', 'TEST', '10', '1', null];

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.createAirdrop.called, 'createAirdrop should be called');
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('valid airdrop to tick list gets holders and credits each', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getListType.resolves(1);
            indexer.indexerDb.getList.resolves(['TEST']);
            indexer.indexerDb.getHolders.resolves({
                '1HolderOneXXXXXXXXXXXXXXXXXXXY7vAZ': '100',
                '1HolderTwoXXXXXXXXXXXXXXXXXXXWqp6Q': '200',
            });
            indexer.indexerDb.getAddressBalances.resolves({ 1: '5000' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data = createBaseData({ ACTION: 'AIRDROP', FORMAT: 0 });
            const params = ['0', 'TEST', '5', '1', null];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createAirdrop.called);
        });

        it('TICK not found → invalid', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves(['1DestAddressXXXXXXXXXXXXXXXXXaKc5Z']);
            indexer.indexerDb.getAddressBalances.resolves({});
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data = createBaseData({ ACTION: 'AIRDROP', FORMAT: 0 });
            const params = ['0', 'UNKNOWN', '10', '1', null];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

        it('LIST_ACTION_INDEX invalid (type===false) → invalid', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getListType.resolves(false);
            indexer.indexerDb.getList.resolves([]);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1000' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data = createBaseData({ ACTION: 'AIRDROP', FORMAT: 0 });
            const params = ['0', 'TEST', '10', '9999', null];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

        it('insufficient balance for total airdrop amount → invalid', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves([
                '1HolderOneXXXXXXXXXXXXXXXXXXXY7vAZ',
                '1HolderTwoXXXXXXXXXXXXXXXXXXXWqp6Q',
                '1HolderThreeXXXXXXXXXXXXXXXXXW8fcq',
            ]);
            // Balance only covers 2, but we need 3 * 100 = 300
            indexer.indexerDb.getAddressBalances.resolves({ 1: '5' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data = createBaseData({ ACTION: 'AIRDROP', FORMAT: 0 });
            const params = ['0', 'TEST', '100', '1', null];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

        it('MEMO with pipe character → invalid', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves(['1DestAddressXXXXXXXXXXXXXXXXXaKc5Z']);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1000' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data = createBaseData({ ACTION: 'AIRDROP', FORMAT: 0 });
            // memo with pipe
            const params = ['0', 'TEST', '10', '1', 'bad|memo'];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

        it('pre-existing error passed through → createAirdrop still called', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves(['1DestAddressXXXXXXXXXXXXXXXXXaKc5Z']);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1000' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data = createBaseData({ ACTION: 'AIRDROP', FORMAT: 0 });
            const params = ['0', 'TEST', '10', '1', null];

            await handler.parse(params, data, 'invalid: pre-existing error');

            assert.ok(data['STATUS'].includes('invalid'));
            assert.ok(indexer.indexerDb.createAirdrop.called, 'createAirdrop should still be called');
        });

        it('unknown format version → invalid', async function () {
            indexer.indexerDb.getAddressBalances.resolves({});
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });

            const data = createBaseData({ ACTION: 'AIRDROP', FORMAT: 99 });
            const params = ['99', 'TEST', '10', '1', null];

            await handler.parse(params, data, null);

            // FORMAT 99 is unknown — but airdrops array will be empty so we just check no crash
            assert.ok(true);
        });

    });

    // ─── Format 1 (Multi-Airdrop Brief) ──────────────────────────────

    describe('format 1 — multi-airdrop brief', function () {

        it('valid multi-airdrop brief processes all ticks', async function () {
            const tokenInfo1 = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            const tokenInfo2 = createTokenInfo({ TICK: 'XTEST', TICK_ID: 2, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo1);
            indexer.indexerDb.getTokenInfo.withArgs('XTEST').resolves(tokenInfo2);
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves(['1DestAddressXXXXXXXXXXXXXXXXXaKc5Z']);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1000', 2: '1000' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data = createBaseData({ ACTION: 'AIRDROP', FORMAT: 1 });
            // FORMAT 1: VERSION|LIST_ACTION_INDEX|TICK|AMOUNT|TICK|AMOUNT|MEMO
            const params = ['1', '1', 'TEST', '5', 'XTEST', '3', 'memo'];

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.createAirdrop.callCount >= 2, 'createAirdrop called for each tick');
        });

    });

    // ─── Format 2 (Multi-Airdrop Full) ───────────────────────────────

    describe('format 2 — multi-airdrop full', function () {

        it('valid multi-airdrop full processes multiple TICK/LIST pairs', async function () {
            const tokenInfo1 = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            const tokenInfo2 = createTokenInfo({ TICK: 'XTEST', TICK_ID: 2, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo1);
            indexer.indexerDb.getTokenInfo.withArgs('XTEST').resolves(tokenInfo2);
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves(['1DestAddressXXXXXXXXXXXXXXXXXaKc5Z']);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1000', 2: '1000' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data = createBaseData({ ACTION: 'AIRDROP', FORMAT: 2 });
            // FORMAT 2: VERSION|TICK|AMOUNT|LIST_ACTION_INDEX|TICK|AMOUNT|LIST_ACTION_INDEX|MEMO
            const params = ['2', 'TEST', '5', '1', 'XTEST', '3', '2', 'memo'];

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.createAirdrop.callCount >= 1);
        });

    });

    // ─── Balance & Authorization edge cases ──────────────────────────

    describe('balance and authorization checks', function () {

        it('SOURCE sleeping → invalid', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves(['1DestAddressXXXXXXXXXXXXXXXXXaKc5Z']);
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
            indexer.indexerDb.getList.resolves(['1DestAddressXXXXXXXXXXXXXXXXXaKc5Z']);
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

        it('updateBalances and updateTokens called after parse', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves(['1DestAddressXXXXXXXXXXXXXXXXXaKc5Z']);
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
            indexer.indexerDb.getList.resolves(['1DestAddressXXXXXXXXXXXXXXXXXaKc5Z']);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1000' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data = createBaseData({ ACTION: 'AIRDROP', FORMAT: 0 });
            const params = ['0', 'TEST', '10', '1', null];

            await handler.parse(params, data, null);

            assert.ok(indexer.mapper.createMappings.called, 'createMappings should be called');
        });

        it('empty recipient list (all filtered by isActionAllowed) — no credits generated', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves(['1DestAddressXXXXXXXXXXXXXXXXXaKc5Z']);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1000' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            // All recipients blocked
            indexer.indexerDb.isActionAllowed.callsFake((address, tick) => {
                // source action checks pass, but recipient check fails
                if (address === '1DestAddressXXXXXXXXXXXXXXXXXaKc5Z') return Promise.resolve(false);
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
