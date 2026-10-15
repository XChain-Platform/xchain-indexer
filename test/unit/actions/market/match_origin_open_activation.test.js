// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const OrderMatch = require('../../../../src/actions/order_match/index.js');
const SwapMatch = require('../../../../src/actions/swap_match/index.js');
const orderSettle = require('../../../../src/actions/order/settle.js');
const gateRegistry = require('../../../../src/consensus/gate_registry.js');
const { planListRematch } = require('../../../../src/consensus/list_rematch/plan.js');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../fixtures/mocks.js');
const { stubGate } = require('../../../helpers/gate_modules.js');

const GATE = 'match_origin_open_activation.MATCH_ORIGIN_OPEN_ACTIVATION';
const ENV = 'XC_MATCH_ORIGIN_OPEN_REGTEST_ACTIVATION';
const originalEnv = process.env[ENV];

function context(indexer) {
    return {
        config: indexer.config,
        util: indexer.util,
        mapper: indexer.mapper,
        decoderDb: indexer.decoderDb,
        indexerDb: indexer.indexerDb,
        protocolChanges: indexer.protocolChanges,
        processAction: sinon.stub().resolves(),
    };
}

function order(overrides = {}) {
    return {
        ACTION_INDEX: 10,
        SOURCE: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
        GIVE_COIN: 'BTC', GIVE_TICK: 'ALPHA', GIVE_AMOUNT: '10', GIVE_REMAINING: '10',
        GET_COIN: 'BTC', GET_TICK: 'BETA', GET_AMOUNT: '20', GET_REMAINING: '20',
        GIVE_PRICE: '2', GET_PRICE: '0.5',
        GET_ADDRESS: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
        GIVE_OWNERSHIP: 0, GET_OWNERSHIP: 0,
        ALLOW_LIST: null, BLOCK_LIST: null, PAYOUT_LEGS: null,
        ORDER_STATUS: 'open',
        ...overrides,
    };
}

function counterOrder(overrides = {}) {
    return order({
        ACTION_INDEX: 20,
        SOURCE: 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
        GIVE_TICK: 'BETA', GIVE_AMOUNT: '20', GIVE_REMAINING: '20',
        GET_TICK: 'ALPHA', GET_AMOUNT: '10', GET_REMAINING: '10',
        GIVE_PRICE: '0.5', GET_PRICE: '2',
        GET_ADDRESS: 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
        ...overrides,
    });
}

function swap(overrides = {}) {
    return {
        ACTION_INDEX: 30,
        SOURCE: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
        GIVE_COIN: 'BTC', GIVE_TICK: 'ALPHA', GIVE_AMOUNT: '10',
        GET_COIN: 'BTC', GET_TICK: 'BETA', GET_AMOUNT: '20',
        GET_ADDRESS: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
        GIVE_OWNERSHIP: 0, GET_OWNERSHIP: 0,
        ALLOW_LIST: null, BLOCK_LIST: null, PAYOUT_LEGS: null,
        SWAP_STATUS: 'open',
        ...overrides,
    };
}

function counterSwap(overrides = {}) {
    return swap({
        ACTION_INDEX: 40,
        SOURCE: 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
        GIVE_TICK: 'BETA', GIVE_AMOUNT: '20',
        GET_TICK: 'ALPHA', GET_AMOUNT: '10',
        GET_ADDRESS: 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
        ...overrides,
    });
}

function setup() {
    const indexer = createMockIndexer();
    indexer.indexerDb.getTokenInfo.callsFake(async tick => createTokenInfo({
        TICK: tick, DECIMALS: 0, ALLOW_LIST: null, BLOCK_LIST: null,
    }));
    indexer.indexerDb.createActionIndex.resolves(9001);
    return indexer;
}

function restoreEnv() {
    if(originalEnv === undefined) delete process.env[ENV];
    else process.env[ENV] = originalEnv;
}

function listData(blockIndex = 200) {
    return createBaseData({
        ACTION: 'LIST', ACTION_INDEX: 700, BLOCK_INDEX: blockIndex,
        TYPE: 2, STATUS: 'valid', ITEM: ['trigger'],
    });
}

async function runCompletedSwapPlan(active) {
    const indexer = setup();
    const handler = new SwapMatch(context(indexer));
    stubGate(sinon, GATE, active);

    const a = swap({ ACTION_INDEX: 10, GET_ADDRESS: counterSwap().SOURCE });
    const b = counterSwap({ ACTION_INDEX: 20, GET_ADDRESS: a.SOURCE });
    const c = swap({
        ACTION_INDEX: 30,
        SOURCE: 'mnQjKpQXDrZBnKwRCD3dG6yJGrgjLrP3ax',
        GET_ADDRESS: b.SOURCE,
    });
    const offers = new Map([[10, a], [20, b], [30, c]]);
    const statuses = new Map([[10, 'open'], [20, 'open'], [30, 'open']]);
    let nextAction = 9000;
    indexer.indexerDb.createActionIndex.callsFake(async () => nextAction++);
    indexer.indexerDb.getSwapInfo.callsFake(async (coin, actionIndex) => ({
        ...offers.get(actionIndex), SWAP_STATUS: statuses.get(actionIndex),
    }));
    indexer.indexerDb.findSwapMatches.callsFake(async origin => {
        if(origin.ACTION_INDEX === 10) return [{ ...b, SWAP_STATUS: statuses.get(20) }];
        if(origin.ACTION_INDEX === 20) return [{ ...c, SWAP_STATUS: statuses.get(30) }];
        return false;
    });
    indexer.indexerDb.createSwapStatus.callsFake(async (actionIndex, swapIndex, status) => {
        statuses.set(swapIndex, status);
    });

    const plan = planListRematch(listData(), [], [10, 20]);
    for(const step of plan) await handler.parse(null, step.data, null);
    return { indexer, statuses, b };
}

async function runCancelledOrderPlan(active) {
    const indexer = setup();
    const handler = new OrderMatch(context(indexer));
    stubGate(sinon, GATE, active);

    const origin = order();
    const candidate = counterOrder({ GET_ADDRESS: origin.SOURCE });
    const plan = planListRematch(listData(), [origin.ACTION_INDEX], []);

    await orderSettle.settleLedger({
        util: indexer.util,
        indexerDb: indexer.indexerDb,
        config: indexer.config,
    }, {
        format: 1,
        data: createBaseData({ ACTION: 'ORDER', ACTION_INDEX: 800 }),
        isNativeCoinGive: false,
        isOwnershipGive: false,
        orderInfo: origin,
        fees: { AMOUNT: '0' },
        guardFee: '0',
        status: 'valid',
    });

    indexer.indexerDb.getOrderInfo.resolves({ ...origin, ORDER_STATUS: 'cancelled' });
    indexer.indexerDb.findOrderMatches.resolves([candidate]);
    await handler.parse(null, plan[0].data, null);
    return { indexer, origin };
}

describe('MATCH origin-open activation @regression @tier1', function () {
    afterEach(function () {
        sinon.restore();
        restoreEnv();
    });

    it('armed ORDER_MATCH returns before candidate lookup for a cancelled origin', async function () {
        const indexer = setup();
        const handler = new OrderMatch(context(indexer));
        stubGate(sinon, GATE, true);
        indexer.indexerDb.getOrderInfo.resolves(order({ ORDER_STATUS: 'cancelled' }));
        indexer.indexerDb.findOrderMatches.resolves([counterOrder()]);

        await handler.parse(null, createBaseData({
            ACTION: 'ORDER_MATCH', ORDER_ACTION_INDEX: 10, BLOCK_INDEX: 200,
        }), null);

        assert.strictEqual(indexer.indexerDb.findOrderMatches.callCount, 0);
        assert.strictEqual(indexer.indexerDb.createOrderMatch.callCount, 0);
        assert.strictEqual(indexer.indexerDb.createEscrow.callCount, 0);
    });

    it('armed SWAP_MATCH returns before candidate lookup for a completed origin', async function () {
        const indexer = setup();
        const handler = new SwapMatch(context(indexer));
        stubGate(sinon, GATE, true);
        indexer.indexerDb.getSwapInfo.resolves(swap({ SWAP_STATUS: 'complete' }));
        indexer.indexerDb.findSwapMatches.resolves([counterSwap()]);

        await handler.parse(null, createBaseData({
            ACTION: 'SWAP_MATCH', SWAP_ACTION_INDEX: 30, BLOCK_INDEX: 200,
        }), null);

        assert.strictEqual(indexer.indexerDb.findSwapMatches.callCount, 0);
        assert.strictEqual(indexer.indexerDb.createSwapMatch.callCount, 0);
        assert.strictEqual(indexer.indexerDb.createEscrow.callCount, 0);
    });

    it('keeps the terminal-origin settlement path unchanged while the gate is unarmed', async function () {
        const orderRun = await runCancelledOrderPlan(false);
        assert.strictEqual(orderRun.indexer.indexerDb.findOrderMatches.callCount, 1);
        assert.strictEqual(orderRun.indexer.indexerDb.createOrderMatch.callCount, 1);

        sinon.restore();
        const swapRun = await runCompletedSwapPlan(false);
        assert.strictEqual(swapRun.indexer.indexerDb.findSwapMatches.callCount, 2);
        assert.strictEqual(swapRun.indexer.indexerDb.createSwapMatch.callCount, 2);
    });

    it('an armed list plan does not settle a swap completed by its earlier step', async function () {
        const { indexer, statuses } = await runCompletedSwapPlan(true);

        assert.strictEqual(statuses.get(20), 'complete');
        assert.strictEqual(indexer.indexerDb.getSwapInfo.callCount, 2);
        assert.strictEqual(indexer.indexerDb.findSwapMatches.callCount, 1);
        assert.strictEqual(indexer.indexerDb.createSwapMatch.callCount, 1);
    });

    it('the legacy swap plan debits the same completed offer escrow twice', async function () {
        const { indexer, b } = await runCompletedSwapPlan(false);
        const debits = indexer.indexerDb.createEscrow.args
            .map(args => [args[1], String(args[2]), args[3]])
            .filter(([tick, amount, address]) =>
                tick === 'BETA' && amount === '-20' && address === b.SOURCE);

        assert.strictEqual(indexer.indexerDb.createSwapMatch.callCount, 2);
        assert.deepStrictEqual(debits, [
            ['BETA', '-20', b.SOURCE],
            ['BETA', '-20', b.SOURCE],
        ]);
        assert.strictEqual(debits.reduce((sum, row) => sum + Number(row[1]), 0), -40);
    });

    it('an armed stale order plan cannot settle escrow already returned by cancellation', async function () {
        const { indexer, origin } = await runCancelledOrderPlan(true);
        const releases = indexer.indexerDb.createEscrow.args
            .map(args => [args[1], String(args[2]), args[3]])
            .filter(([tick, amount, address]) =>
                tick === 'ALPHA' && amount === '-10' && address === origin.SOURCE);

        assert.strictEqual(indexer.indexerDb.createOrderMatch.callCount, 0);
        assert.deepStrictEqual(releases, [['ALPHA', '-10', origin.SOURCE]]);
    });

    it('the legacy stale order plan settles escrow after the cancellation refund', async function () {
        const { indexer, origin } = await runCancelledOrderPlan(false);
        const releases = indexer.indexerDb.createEscrow.args
            .map(args => [args[1], String(args[2]), args[3]])
            .filter(([tick, amount, address]) =>
                tick === 'ALPHA' && amount === '-10' && address === origin.SOURCE);

        assert.strictEqual(indexer.indexerDb.createOrderMatch.callCount, 1);
        assert.deepStrictEqual(releases, [
            ['ALPHA', '-10', origin.SOURCE],
            ['ALPHA', '-10', origin.SOURCE],
        ]);
    });

    it('arms regtest at the configured boundary and never arms live networks', function () {
        process.env[ENV] = '200';

        assert.strictEqual(gateRegistry.activeAt(GATE, 'regtest', 'BTC', 199, null), false);
        assert.strictEqual(gateRegistry.activeAt(GATE, 'regtest', 'BTC', 200, null), true);
        assert.strictEqual(gateRegistry.activeAt(GATE, 'regtest', 'BTC', 201, null), true);
        assert.strictEqual(gateRegistry.activeAt(GATE, 'mainnet', 'BTC', 999999999, null), false);
        assert.strictEqual(gateRegistry.activeAt(GATE, 'testnet', 'BTC', 999999999, null), false);
    });

    for(const network of ['mainnet', 'testnet']) {
        it(network + ' retains the terminal-origin path even when the regtest lever is armed', async function () {
            process.env[ENV] = 'armed';
            const indexer = setup();
            indexer.config.NETWORK = network;
            const handler = new SwapMatch(context(indexer));
            indexer.indexerDb.getSwapInfo.resolves(swap({ SWAP_STATUS: 'complete' }));
            indexer.indexerDb.findSwapMatches.resolves([counterSwap()]);

            await handler.parse(null, createBaseData({
                ACTION: 'SWAP_MATCH', SWAP_ACTION_INDEX: 30, BLOCK_INDEX: 200,
            }), null);

            assert.strictEqual(indexer.indexerDb.findSwapMatches.callCount, 1);
            assert.strictEqual(indexer.indexerDb.createSwapMatch.callCount, 1);
        });
    }
});
