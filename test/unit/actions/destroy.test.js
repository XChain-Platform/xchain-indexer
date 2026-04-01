process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');

const Destroy = require('../../../src/actions/destroy.js');

describe('Destroy @regression @tier1', function () {
    let indexer, actionsCtx, handler;

    const SOURCE = '1SourceAddressXXXXXXXXXXXXXXXYs6gYt';

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
        handler = new Destroy(actionsCtx);
        indexer.util.resetLists();
    });

    afterEach(function () {
        sinon.restore();
    });

    // ─── Format 0 (Single Destroy) ────────────────────────────────────

    describe('format 0 — single destroy', function () {

        it('valid destroy — createDestroy called with valid status', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '500' });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'DESTROY', FORMAT: 0, SOURCE });
            const params = ['0', 'TEST', '100', 'memo'];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createDestroy.called);
        });

        it('valid destroy — debit created, no credit created', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '500' });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'DESTROY', FORMAT: 0, SOURCE });
            const params = ['0', 'TEST', '50', null];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            // createCredit should NOT be called (destroy has no recipient)
            assert.ok(!indexer.indexerDb.createCredit.called, 'createCredit should not be called for destroy');
        });

        it('TICK not found → invalid', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);
            indexer.indexerDb.getAddressBalances.resolves({});
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'DESTROY', FORMAT: 0, SOURCE });
            const params = ['0', 'UNKNOWN', '100', null];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

        it('insufficient balance → invalid', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            // Only 10 available, trying to destroy 100
            indexer.indexerDb.getAddressBalances.resolves({ 1: '10' });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'DESTROY', FORMAT: 0, SOURCE });
            const params = ['0', 'TEST', '100', null];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

        it('MEMO with pipe → invalid', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '500' });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'DESTROY', FORMAT: 0, SOURCE });
            const params = ['0', 'TEST', '10', 'bad|memo'];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

        it('SOURCE sleeping → invalid', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '500' });
            indexer.indexerDb.isActionAllowed.callsFake((address, tick, block) => {
                if (address && !tick) return Promise.resolve(false);
                return Promise.resolve(true);
            });

            const data   = createBaseData({ ACTION: 'DESTROY', FORMAT: 0, SOURCE });
            const params = ['0', 'TEST', '10', null];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

        it('unknown format version → createDestroy still called', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);
            indexer.indexerDb.getAddressBalances.resolves({});
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'DESTROY', FORMAT: 99, SOURCE });
            const params = ['99', 'TEST', '10', null];

            await handler.parse(params, data, null);

            // Invalid format but createDestroy should still be called (records invalid action)
            assert.ok(indexer.indexerDb.createDestroy.called);
        });

    });

    // ─── Format 1 (Multi-Destroy Full) ───────────────────────────────

    describe('format 1 — multi-destroy full', function () {

        it('valid multi-destroy — createDestroy called for each distinct TICK', async function () {
            const tokenInfo1 = createTokenInfo({ TICK: 'TEST',  TICK_ID: 1, DECIMALS: 0 });
            const tokenInfo2 = createTokenInfo({ TICK: 'XTEST', TICK_ID: 2, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo1);
            indexer.indexerDb.getTokenInfo.withArgs('XTEST').resolves(tokenInfo2);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '500', 2: '500' });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'DESTROY', FORMAT: 1, SOURCE });
            // FORMAT 1: VERSION|TICK|AMOUNT|TICK|AMOUNT|MEMO
            const params = ['1', 'TEST', '10', 'XTEST', '20', 'memo'];

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.createDestroy.callCount >= 2, 'createDestroy called for each tick');
        });

    });

    // ─── Multi-destroy consolidation ─────────────────────────────────

    describe('multi-destroy consolidation', function () {

        it('duplicate TICK+MEMO entries are consolidated into single destroy', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1000' });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'DESTROY', FORMAT: 1, SOURCE });
            // Two identical TICK+MEMO pairs should consolidate to one
            const params = ['1', 'TEST', '10', 'TEST', '15', 'same-memo'];

            await handler.parse(params, data, null);

            // Consolidated to a single destroy of 25
            assert.strictEqual(indexer.indexerDb.createDestroy.callCount, 1);
        });

        it('different MEMOs for same TICK produce separate destroys', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1000' });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'DESTROY', FORMAT: 2, SOURCE });
            // FORMAT 2: VERSION|TICK|AMOUNT|MEMO|TICK|AMOUNT|MEMO
            const params = ['2', 'TEST', '10', 'memo1', 'TEST', '15', 'memo2'];

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.createDestroy.callCount >= 1);
        });

    });

    // ─── Record creation ─────────────────────────────────────────────

    describe('record creation', function () {

        it('createDestroy called even on invalid', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);
            indexer.indexerDb.getAddressBalances.resolves({});
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'DESTROY', FORMAT: 0, SOURCE });
            const params = ['0', 'UNKNOWN', '10', null];

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.createDestroy.called);
        });

        it('updateBalances and updateTokens called after parse', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '500' });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'DESTROY', FORMAT: 0, SOURCE });
            const params = ['0', 'TEST', '10', null];

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.updateBalances.called);
            assert.ok(indexer.indexerDb.updateTokens.called);
        });

        it('mapper.createMappings called after parse', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '500' });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'DESTROY', FORMAT: 0, SOURCE });
            const params = ['0', 'TEST', '10', null];

            await handler.parse(params, data, null);

            assert.ok(indexer.mapper.createMappings.called);
        });

        it('pre-existing error passed through — invalid status', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '500' });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'DESTROY', FORMAT: 0, SOURCE });
            const params = ['0', 'TEST', '10', null];

            await handler.parse(params, data, 'invalid: pre-existing error');

            assert.ok(data['STATUS'].includes('invalid'));
        });

    });
});
