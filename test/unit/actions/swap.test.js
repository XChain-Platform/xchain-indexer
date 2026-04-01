process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');

const Swap = require('../../../src/actions/swap.js');

const VALID_GET_ADDRESS = '1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev';

describe('Swap action handler @regression @tier2', function () {
    let indexer, actionsCtx, handler;

    beforeEach(function () {
        indexer = createMockIndexer();
        actionsCtx = {
            config: indexer.config,
            util: indexer.util,
            mapper: indexer.mapper,
            decoderDb: indexer.decoderDb,
            indexerDb: indexer.indexerDb,
            protocolChanges: {
                isDefined: sinon.stub().returns(true),
                isEnabled: sinon.stub().resolves(true),
            },
            processAction: sinon.stub().resolves(),
        };
        handler = new Swap(actionsCtx);
        indexer.util.resetLists();

        // Default token infos for GIVE and GET
        const giveToken = createTokenInfo({ TICK: 'GIVE', TICK_ID: 1, DECIMALS: 0 });
        const getToken  = createTokenInfo({ TICK: 'GET',  TICK_ID: 2, DECIMALS: 0 });
        indexer.indexerDb.getTokenInfo.callsFake(async (tick) => {
            if (tick === 'GIVE') return giveToken;
            if (tick === 'GET')  return getToken;
            return null;
        });

        // Give source enough balance (includes fee tick id 99)
        indexer.indexerDb.getAddressBalances.resolves({ 1: '1000', 2: '1000', 99: '1000' });
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.getTickerId.resolves(99);
    });

    function makeCreateParams(giveTick, giveAmt, getTick, getAmt, expiration, memo) {
        return ['0', 'BTC', giveTick, String(giveAmt), 'BTC', getTick, String(getAmt), '', String(expiration || ''), '', '', memo || ''];
    }

    function makeCancelParams(swapActionIndex, memo) {
        return ['1', String(swapActionIndex), memo || ''];
    }

    function makeEditParams(swapActionIndex, expiration, memo) {
        return ['2', String(swapActionIndex), String(expiration || ''), '', '', memo || ''];
    }

    const FUTURE_EXPIRATION = 9999999999;

    // ─── Create swap (format 0) ───────────────────────────────────────

    it('creates a valid swap', async function () {
        const data = createBaseData({ ACTION: 'SWAP', FORMAT: 0, BLOCK_TIME: 1700000000 });
        const params = makeCreateParams('GIVE', '10', 'GET', '5', FUTURE_EXPIRATION, '');
        await handler.parse(params, data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('calls processAction(SWAP_MATCH) after a valid create', async function () {
        const data = createBaseData({ ACTION: 'SWAP', FORMAT: 0, BLOCK_TIME: 1700000000 });
        const params = makeCreateParams('GIVE', '10', 'GET', '5', FUTURE_EXPIRATION, '');
        await handler.parse(params, data, null);
        assert.ok(actionsCtx.processAction.calledWith('SWAP_MATCH'));
    });

    it('rejects GIVE_COIN not in accepted coins', async function () {
        const data = createBaseData({ ACTION: 'SWAP', FORMAT: 0, BLOCK_TIME: 1700000000 });
        const params = ['0', 'XYZ', 'GIVE', '10', 'BTC', 'GET', '5', '', String(FUTURE_EXPIRATION), '', '', ''];
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('GIVE_COIN'), `Expected GIVE_COIN error, got: ${data['STATUS']}`);
    });

    it('rejects GET_COIN not in accepted coins', async function () {
        const data = createBaseData({ ACTION: 'SWAP', FORMAT: 0, BLOCK_TIME: 1700000000 });
        const params = ['0', 'BTC', 'GIVE', '10', 'ETH', 'GET', '5', '', String(FUTURE_EXPIRATION), '', '', ''];
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('GET_COIN'), `Expected GET_COIN error, got: ${data['STATUS']}`);
    });

    it('rejects when GIVE_TICK does not exist', async function () {
        indexer.indexerDb.getTokenInfo.resolves(null);
        const data = createBaseData({ ACTION: 'SWAP', FORMAT: 0, BLOCK_TIME: 1700000000 });
        const params = makeCreateParams('UNKNOWN', '10', 'UNKNOWN', '5', FUTURE_EXPIRATION, '');
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('GIVE_TICK') || data['STATUS'].includes('GET_TICK'), `Expected tick error, got: ${data['STATUS']}`);
    });

    it('rejects when SOURCE has insufficient balance', async function () {
        // Return zero balances
        indexer.indexerDb.getAddressBalances.resolves({});
        const data = createBaseData({ ACTION: 'SWAP', FORMAT: 0, BLOCK_TIME: 1700000000 });
        const params = makeCreateParams('GIVE', '100', 'GET', '5', FUTURE_EXPIRATION, '');
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('insufficient'), `Expected insufficient funds error, got: ${data['STATUS']}`);
    });

    it('rejects EXPIRATION in the past', async function () {
        const data = createBaseData({ ACTION: 'SWAP', FORMAT: 0, BLOCK_TIME: 1700000000 });
        const params = makeCreateParams('GIVE', '10', 'GET', '5', 1000000, ''); // past timestamp
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('EXPIRATION'), `Expected EXPIRATION error, got: ${data['STATUS']}`);
    });

    // ─── Cancel swap (format 1) ───────────────────────────────────────

    it('cancels a valid open swap', async function () {
        const swapInfo = {
            ACTION_INDEX: 10,
            SOURCE: '1SourceAddressXXXXXXXXXXXXXXXYs6gYt',
            SWAP_STATUS: 'open',
            GIVE_TICK: 'GIVE', GIVE_AMOUNT: '10', GIVE_REMAINING: '10',
            GET_TICK: 'GET',   GET_AMOUNT: '5',
            GET_COIN: 'BTC', GIVE_COIN: 'BTC',
            GET_ADDRESS: '1SourceAddressXXXXXXXXXXXXXXXYs6gYt',
            ALLOW_LIST: null, BLOCK_LIST: null,
        };
        indexer.indexerDb.getSwapInfo.resolves(swapInfo);
        const data = createBaseData({ ACTION: 'SWAP', FORMAT: 1 });
        const params = makeCancelParams(10, '');
        await handler.parse(params, data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('rejects cancel when swap is not open', async function () {
        const swapInfo = {
            ACTION_INDEX: 10,
            SOURCE: '1SourceAddressXXXXXXXXXXXXXXXYs6gYt',
            SWAP_STATUS: 'complete',
            GIVE_TICK: 'GIVE', GIVE_AMOUNT: '10', GET_TICK: 'GET', GET_AMOUNT: '5',
            ALLOW_LIST: null, BLOCK_LIST: null,
        };
        indexer.indexerDb.getSwapInfo.resolves(swapInfo);
        const data = createBaseData({ ACTION: 'SWAP', FORMAT: 1 });
        const params = makeCancelParams(10, '');
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('SWAP_ACTION_INDEX'), `Expected swap not open error, got: ${data['STATUS']}`);
    });

    it('rejects cancel when SOURCE is not the swap owner', async function () {
        const swapInfo = {
            ACTION_INDEX: 10,
            SOURCE: '1DifferentOwnerXXXXXXXXXXXXXXXXXXXX',
            SWAP_STATUS: 'open',
            GIVE_TICK: 'GIVE', GIVE_AMOUNT: '10', GET_TICK: 'GET', GET_AMOUNT: '5',
            ALLOW_LIST: null, BLOCK_LIST: null,
        };
        indexer.indexerDb.getSwapInfo.resolves(swapInfo);
        const data = createBaseData({ ACTION: 'SWAP', FORMAT: 1 });
        const params = makeCancelParams(10, '');
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('SOURCE'), `Expected SOURCE not owner error, got: ${data['STATUS']}`);
    });

    // ─── Edit swap (format 2) ─────────────────────────────────────────

    it('edits a valid open swap expiration', async function () {
        const swapInfo = {
            ACTION_INDEX: 10,
            SOURCE: '1SourceAddressXXXXXXXXXXXXXXXYs6gYt',
            SWAP_STATUS: 'open',
            GIVE_TICK: 'GIVE', GIVE_AMOUNT: '10', GIVE_REMAINING: '10',
            GET_TICK: 'GET',   GET_AMOUNT: '5',
            GET_COIN: 'BTC', GIVE_COIN: 'BTC',
            GET_ADDRESS: '1SourceAddressXXXXXXXXXXXXXXXYs6gYt',
            ALLOW_LIST: null, BLOCK_LIST: null,
            EXPIRATION: 1000000,
        };
        indexer.indexerDb.getSwapInfo.resolves(swapInfo);
        const data = createBaseData({ ACTION: 'SWAP', FORMAT: 2, BLOCK_TIME: 1700000000 });
        const params = makeEditParams(10, FUTURE_EXPIRATION, '');
        await handler.parse(params, data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    // ─── SOURCE sleeping check ────────────────────────────────────────

    it('rejects when SOURCE is sleeping (format 0)', async function () {
        indexer.indexerDb.isActionAllowed.resolves(false);
        const data = createBaseData({ ACTION: 'SWAP', FORMAT: 0, BLOCK_TIME: 1700000000 });
        const params = makeCreateParams('GIVE', '10', 'GET', '5', FUTURE_EXPIRATION, '');
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('SOURCE') || data['STATUS'].includes('TICK'), `Expected sleeping error, got: ${data['STATUS']}`);
    });
});
