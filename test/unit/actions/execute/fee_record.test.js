'use strict';

process.env.INDEXER_COIN = process.env.INDEXER_COIN || 'DOGE';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

const assert = require('assert');
const settle = require('../../../../src/actions/execute/settle.js');
const Utility = require('../../../../src/utility.js');

const TICK_ID = 7;

function makeHandler(){
    const util = new Utility();
    const debits = [];
    const executions = [];
    const feeRecords = [];
    util.processTransactionLedgerChanges = async (db, data, credits, rows) => debits.push(...rows);
    util.getTickersList = () => [];
    util.getAddressesList = () => ({});
    util.addAddressTicker = () => {};
    return {
        util, debits, executions, feeRecords,
        config: { GAS_PRICE: '0.00001', GAS: 'XCHAIN', NETWORK: 'mainnet', COIN: 'DOGE' },
        indexerDb: {
            createContractExecution: async row => executions.push(row),
            createFeeRecord: async row => feeRecords.push(Object.assign({}, row, {
                AMOUNT: util.bcstr(row.AMOUNT),
                XCHAIN_AMOUNT: util.bcstr(row.XCHAIN_AMOUNT),
            })),
            updateBalances: async () => {},
            updateTokens: async () => {},
        },
        mapper: { createMappings: async () => {} },
    };
}

function makeCtx(feePaymentMode){
    return {
        data: {
            SOURCE: 'caller', ACTION_INDEX: 10, BLOCK_INDEX: 9,
            CONTRACT_ACTION_INDEX: 2, METHOD: 'run', METHOD_PARAMS: '',
            NATIVE_COIN_AMOUNT: feePaymentMode === 1 ? '0.02500000' : undefined,
            NATIVE_COIN: feePaymentMode === 1 ? 'DOGE' : undefined,
            ORACLE_ROUND: feePaymentMode === 1 ? 41 : undefined,
        },
        error: null, skipFee: false, feePaymentMode,
        tokenInfo: { TICK_ID }, gas: 'XCHAIN',
        gasUsed: 2500, execCeiling: 1000000, nestedGasUnused: 0,
        vmError: null, emittedCount: 0,
    };
}

async function settleMode(feePaymentMode){
    const handler = makeHandler();
    const ctx = makeCtx(feePaymentMode);
    await settle.settleExecution.call(handler, ctx);
    return { handler, ctx };
}

describe('EXECUTE fee history @regression @tier1', function () {
    it('records a native-paid metered fee and its execution payment mode', async function () {
        const { handler } = await settleMode(1);
        assert.strictEqual(handler.feeRecords.length, 1);
        assert.deepStrictEqual(handler.feeRecords[0], {
            ACTION_INDEX: 10, SOURCE: 'caller', TICK: 'XCHAIN', AMOUNT: '0.025', METHOD: 1,
            GAS_COST: 2500, GAS_PRICE: '0.00001', XCHAIN_AMOUNT: '0.025', PAYMENT_MODE: 1,
            NATIVE_COIN_AMOUNT: '0.02500000', NATIVE_COIN: 'DOGE', ORACLE_ROUND: 41,
            FEE_PREFERENCE: 1, FEE_VERSION: 2,
        });
        assert.deepStrictEqual(handler.debits, []);
        assert.strictEqual(handler.executions[0].FEE_PAYMENT_MODE, 1);
    });

    it('records the billed ledger fee without adding a second debit', async function () {
        const { handler } = await settleMode(2);
        assert.strictEqual(handler.feeRecords.length, 1);
        assert.strictEqual(handler.feeRecords[0].AMOUNT, '0.025');
        assert.strictEqual(handler.feeRecords[0].GAS_COST, 2500);
        assert.strictEqual(handler.feeRecords[0].PAYMENT_MODE, 2);
        assert.strictEqual(handler.feeRecords[0].NATIVE_COIN_AMOUNT, null);
        assert.strictEqual(handler.debits.length, 1);
        assert.strictEqual(handler.debits[0][0], 'XCHAIN');
        assert.strictEqual(handler.util.bcstr(handler.debits[0][1]), '0.025');
        assert.strictEqual(handler.debits[0][2], 'caller');
        assert.strictEqual(handler.executions[0].FEE_PAYMENT_MODE, 2);
    });

    it('does not record a fee for a refused or system-injected execution', async function () {
        for(const over of [{ error: 'invalid: refused' }, { skipFee: true }]){
            const handler = makeHandler();
            const ctx = Object.assign(makeCtx(2), over);
            await settle.settleExecution.call(handler, ctx);
            assert.deepStrictEqual(handler.feeRecords, []);
            assert.deepStrictEqual(handler.debits, []);
            assert.strictEqual(handler.executions[0].FEE_PAYMENT_MODE, null);
        }
    });
});
