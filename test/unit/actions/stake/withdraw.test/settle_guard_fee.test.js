'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const {
    SOURCE, CONTRACT_ADDRESS, TICK, makeData, makeWithdrawContext,
} = require('./helpers/withdraw_context.js');

describe('Withdraw settlement guard fee @regression @tier2', function () {
    let indexer, actionsCtx, handler, data;

    beforeEach(function () {
        ({ indexer, actionsCtx, handler } = makeWithdrawContext());
        data = makeData({ TICK, AMOUNT: '100' });
        sinon.spy(indexer.util, 'processTransactionLedgerChanges');
    });

    afterEach(() => sinon.restore());

    async function settle(status, guardFee) {
        await handler.settleWithdrawal(data, CONTRACT_ADDRESS, status, guardFee);
        return indexer.util.processTransactionLedgerChanges.firstCall.args.slice(2);
    }

    it('adds a GAS debit from SOURCE without a GAS credit', async function () {
        const [credits, debits] = await settle('valid', '7');

        assert.deepStrictEqual(credits, [[TICK, '100', SOURCE]]);
        assert.deepStrictEqual(debits, [
            [TICK, '100', CONTRACT_ADDRESS],
            [indexer.config.GAS, '7', SOURCE],
        ]);
        assert.ok(indexer.util.getTickersList().includes(indexer.config.GAS));
    });

    for(const [label, fee] of [['absent', undefined], ['zero', '0']]){
        it(`keeps today's legs when the fee is ${label}`, async function () {
            const [credits, debits] = await settle('valid', fee);

            assert.deepStrictEqual(credits, [[TICK, '100', SOURCE]]);
            assert.deepStrictEqual(debits, [[TICK, '100', CONTRACT_ADDRESS]]);
        });
    }

    it('keeps invalid settlement free of ledger legs', async function () {
        const [credits, debits] = await settle('invalid: test', '7');

        assert.deepStrictEqual(credits, []);
        assert.deepStrictEqual(debits, []);
    });

    it('keeps the custody guard disabled and the controller guard enabled', async function () {
        assert.strictEqual(await actionsCtx.protocolChanges.isEnabled('CONTROLLER_CUSTODY_GUARD'), false);
        assert.strictEqual(await actionsCtx.protocolChanges.isEnabled('CONTROLLER_GUARD'), true);
    });
});
