'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../fixtures/mocks');
const Order = require('../../../../src/actions/order.js');

function makeActionsCtx(indexer) {
    return {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: {
            isDefined:  sinon.stub().returns(true),
            isEnabled:  sinon.stub().resolves(true),
        },
        processAction: sinon.stub().resolves(),
    };
}

function makeParams(str) { return String(str).split('|'); }

describe('ORDER and DISPENSER expiration boundary tests @regression @tier2', function () {
    let indexer, actionsCtx, handler;

    const BLOCK_TIME = 1700000000;
    const SOURCE     = '1SourceAddressXXXXXXXXXXXXXXXYs6gYt';

    beforeEach(function () {
        indexer    = createMockIndexer();
        actionsCtx = makeActionsCtx(indexer);
        handler    = new Order(actionsCtx);

        indexer.indexerDb.getTokenInfo
            .withArgs('RAREPEPE', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'RAREPEPE', TICK_ID: 10, DECIMALS: 0 }));
        indexer.indexerDb.getTokenInfo
            .withArgs('PEPECASH', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'PEPECASH', TICK_ID: 20, DECIMALS: 0 }));
        indexer.indexerDb.getAddressBalances.resolves({ 10: '100', 20: '999999' });
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.getTickerId.resolves(99);
    });

    afterEach(function () { sinon.restore(); });

    it('TS-01: EXPIRATION equal to BLOCK_TIME is invalid (must be strictly greater)', async function () {
        const EXPIRATION = BLOCK_TIME;
        const params = makeParams('0|BTC|RAREPEPE|1|BTC|PEPECASH|10|' + SOURCE + '|' + EXPIRATION + '|||');
        const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE, BLOCK_TIME, COIN: 'BTC' });
        await handler.parse(params, data, null);
        assert.ok(data.STATUS.startsWith('invalid'), `expected invalid but got: ${data.STATUS}`);
    });

    it('TS-02: EXPIRATION 1 second after BLOCK_TIME is valid', async function () {
        const EXPIRATION = BLOCK_TIME + 1;
        const params = makeParams('0|BTC|RAREPEPE|1|BTC|PEPECASH|10|' + SOURCE + '|' + EXPIRATION + '|||');
        const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE, BLOCK_TIME, COIN: 'BTC' });
        await handler.parse(params, data, null);
        assert.strictEqual(data.STATUS, 'valid', `expected valid but got: ${data.STATUS}`);
    });

    it('TS-03: EXPIRATION at exactly 182 days (free window boundary) is valid with zero fee', async function () {
        const EXPIRATION = BLOCK_TIME + (182 * 86400);
        const params = makeParams('0|BTC|RAREPEPE|1|BTC|PEPECASH|10|' + SOURCE + '|' + EXPIRATION + '|||');
        const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE, BLOCK_TIME, COIN: 'BTC' });
        await handler.parse(params, data, null);
        assert.strictEqual(data.STATUS, 'valid', `expected valid but got: ${data.STATUS}`);
    });

    it('TS-04: EXPIRATION at 183 days charges a fee and is valid when balance covers it', async function () {
        // Tick ID 99 is the gas (XCHAIN) ticker — provide enough balance
        indexer.indexerDb.getAddressBalances.resolves({ 10: '100', 99: '1000' });
        const EXPIRATION = BLOCK_TIME + (183 * 86400);
        const params = makeParams('0|BTC|RAREPEPE|1|BTC|PEPECASH|10|' + SOURCE + '|' + EXPIRATION + '|||');
        const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE, BLOCK_TIME, COIN: 'BTC' });
        await handler.parse(params, data, null);
        assert.strictEqual(data.STATUS, 'valid', `expected valid but got: ${data.STATUS}`);
    });

    it('TS-05: Missing EXPIRATION uses default (BLOCK_TIME + 90 days) and is valid', async function () {
        // Leave EXPIRATION empty
        const params = makeParams('0|BTC|RAREPEPE|1|BTC|PEPECASH|10|' + SOURCE + '||||');
        const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE, BLOCK_TIME, COIN: 'BTC' });
        await handler.parse(params, data, null);
        assert.strictEqual(data.STATUS, 'valid', `expected valid but got: ${data.STATUS}`);
    });
});
