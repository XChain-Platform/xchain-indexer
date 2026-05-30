process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Collect = require('../../../src/actions/collect.js');

describe('Collect (COLLECT) @regression @tier3', function () {
    let indexer, actionsCtx, handler;

    const SOURCE = '1SourceAddressXXXXXXXXXXXXXXXYs6gYt';

    function addCollectDbStubs(db) {
        db.getActiveStakeBySource  = sinon.stub().resolves({ stake_index: 1 });
        db.getUnclaimedRewardTotal = sinon.stub().resolves('100');
        db.createRewardClaim       = sinon.stub().resolves();
    }

    beforeEach(function () {
        indexer = createMockIndexer();
        addCollectDbStubs(indexer.indexerDb);
        indexer.indexerDb.isActionAllowed.resolves(true);

        actionsCtx = {
            config:    indexer.config,
            util:      indexer.util,
            mapper:    indexer.mapper,
            decoderDb: indexer.decoderDb,
            indexerDb: indexer.indexerDb,
        };
        handler = new Collect(actionsCtx);
        indexer.util.resetLists();
    });

    afterEach(function () {
        sinon.restore();
    });

    function collectData(overrides = {}) {
        return createBaseData({ ACTION: 'COLLECT', FORMAT: 0, COIN: 'BTC', SOURCE, ...overrides });
    }

    it('valid collect → STATUS valid, reward recorded as AMOUNT', async function () {
        const data = collectData();
        await handler.parse(['0'], data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.strictEqual(data['AMOUNT'], '100');
        assert.ok(indexer.indexerDb.createRewardClaim.calledOnce);
    });

    it('rejects an unknown VERSION', async function () {
        const data = collectData({ FORMAT: 5 });
        await handler.parse(['5'], data, null);
        assert.ok(String(data['STATUS']).includes('VERSION'));
    });

    it('rejects a non-BTC chain (COLLECT is BTC-only)', async function () {
        const data = collectData({ COIN: 'LTC' });
        await handler.parse(['0'], data, null);
        assert.ok(String(data['STATUS']).includes('BTC only'));
    });

    it('rejects when SOURCE has no active stake', async function () {
        indexer.indexerDb.getActiveStakeBySource.resolves(null);
        const data = collectData();
        await handler.parse(['0'], data, null);
        assert.ok(String(data['STATUS']).includes('no active stake'));
    });

    it('rejects when SOURCE is sleeping', async function () {
        indexer.indexerDb.isActionAllowed.resolves(false);
        const data = collectData();
        await handler.parse(['0'], data, null);
        assert.ok(String(data['STATUS']).includes('sleeping'));
    });

    it('rejects when there are no unclaimed rewards', async function () {
        indexer.indexerDb.getUnclaimedRewardTotal.resolves('0');
        const data = collectData();
        await handler.parse(['0'], data, null);
        assert.ok(String(data['STATUS']).includes('no unclaimed rewards'));
    });

    it('records a reward_claims row even on an invalid collect', async function () {
        const data = collectData({ COIN: 'LTC' });
        await handler.parse(['0'], data, null);
        assert.ok(indexer.indexerDb.createRewardClaim.calledOnce);
    });
});
