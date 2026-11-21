'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

const assert = require('assert');
const fees = require('../../../../src/actions/execute/fees.js');
const runVm = require('../../../../src/actions/execute/run_vm.js');
const settle = require('../../../../src/actions/execute/settle.js');
const Utility = require('../../../../src/utility.js');

const GAS_CEILING = 1000000;
const TICK_ID = 7;
const ENV = 'XC_EXECUTE_NATIVE_METERED_GAS_REGTEST_ACTIVATION';

function makeHandler({ active, mode, paid }){
    const util = new Utility();
    const required = [];
    const debits = [];
    util.detectFeePaymentMode = () => mode;
    util.validateNativeCoinFee = async (data, fee) => {
        required.push(util.bcformat(fee.AMOUNT, 8));
        return util.bcgte(paid, '0.00950000')
            ? { valid: true, nativeCoinAmount: paid, nativeCoin: 'LTC', oracleRound: 3,
                minAcceptableAmount: '0.00950000' }
            : { valid: false, error: 'underpaid' };
    };
    util.processTransactionLedgerChanges = async (db, data, credits, rows) => debits.push(...rows);
    util.getTickersList = () => [];
    util.getAddressesList = () => ({});
    util.addAddressTicker = () => {};
    return {
        required, debits, util,
        config: {
            GAS_SCHEDULE: { VM_EXECUTE_BASE: 1000 }, GAS_PRICE: '0.00001', GAS: 'XCHAIN',
            NETWORK: 'regtest', COIN: 'LTC',
        },
        actions: { protocolChanges: { isEnabled: async () => false } },
        decoderDb: {},
        indexerDb: {
            getTokenInfo: async () => ({ TICK_ID }),
            getAddressBalances: async () => ({ [TICK_ID]: '100' }),
            createContractExecution: async () => {},
            createFeeRecord: async () => {},
            updateBalances: async () => {},
            updateTokens: async () => {},
        },
        mapper: { createMappings: async () => {} },
    };
}

function makeCtx(){
    return {
        data: {
            SOURCE: 'caller', BLOCK_INDEX: 9, ACTION_INDEX: 10,
            CONTRACT_ACTION_INDEX: 2, METHOD: 'run', TX_OUTPUTS: [],
        },
        error: null, skipFee: false, feePaymentMode: 2, tokenInfo: null,
        gasCost: null, fee: null, balances: null, paidGasCeiling: null,
        gasUsed: 500000, execCeiling: GAS_CEILING, nestedGasUnused: 0,
        vmError: null, emittedCount: 0,
    };
}

async function charge(options){
    const before = process.env[ENV];
    if(options.active) process.env[ENV] = '0';
    else delete process.env[ENV];
    try {
        const handler = makeHandler(options);
        const ctx = makeCtx();
        await fees.chargeGasFee.call(handler, ctx, { GAS_CEILING });
        return { handler, ctx };
    } finally {
        if(before === undefined) delete process.env[ENV];
        else process.env[ENV] = before;
    }
}

describe('EXECUTE native metered gas gate @regression @tier1', function () {
    it('keeps the native base fee and verdict before activation', async function () {
        const { handler, ctx } = await charge({ active: false, mode: 'native', paid: '0.01000000' });
        assert.strictEqual(ctx.error, null);
        assert.strictEqual(ctx.gasCost, 1000);
        assert.strictEqual(handler.util.bcformat(ctx.fee, 8), '0.01000000');
        assert.deepStrictEqual(handler.required, ['0.01000000']);
        assert.strictEqual(ctx.paidGasCeiling, null);
    });

    it('lets a base-fee output buy enough budget for a cheap call', async function () {
        const { handler, ctx } = await charge({ active: true, mode: 'native', paid: '0.01000000' });
        assert.strictEqual(ctx.error, null);
        assert.strictEqual(ctx.gasCost, 1000);
        assert.strictEqual(ctx.paidGasCeiling, 1052);
        assert.strictEqual(handler.util.bcformat(ctx.fee, 8), '0.01000000');
        assert.deepStrictEqual(handler.required, ['0.01000000']);
    });

    it('keeps the fee when a native-paid run exhausts its bought budget', async function () {
        const { handler, ctx } = await charge({ active: true, mode: 'native', paid: '0.47500000' });
        assert.strictEqual(ctx.error, null);
        assert.strictEqual(ctx.paidGasCeiling, 50000);
        ctx.contractInfo = null;
        await runVm.runVmExecution.call(handler, ctx, { GAS_CEILING });
        ctx.vmFailed = true;
        ctx.vmError = 'out_of_gas';
        ctx.vmStatus = 'out_of_gas';
        ctx.gasUsed = 50001;
        await settle.settleExecution.call(handler, ctx);
        assert.strictEqual(ctx.data.STATUS, 'out_of_resource');
        assert.strictEqual(ctx.gasBilled, 50000);
        assert.strictEqual(ctx.data.NATIVE_COIN_AMOUNT, '0.47500000');
        assert.deepStrictEqual(handler.debits, [], 'native payment never debits the GAS ledger');
    });

    it('settles when the bought native gas budget covers the run', async function () {
        const { handler, ctx } = await charge({ active: true, mode: 'native', paid: '0.57000000' });
        assert.strictEqual(ctx.paidGasCeiling, 60000);
        ctx.execCeiling = ctx.paidGasCeiling;
        ctx.gasUsed = 50000;
        await settle.settleExecution.call(handler, ctx);
        assert.strictEqual(ctx.data.STATUS, 'valid');
        assert.strictEqual(ctx.gasBilled, 50000);
        assert.strictEqual(ctx.data.NATIVE_COIN_AMOUNT, '0.57000000');
    });

    it('leaves ledger-paid base admission and metered settlement unchanged', async function () {
        const { handler, ctx } = await charge({ active: true, mode: 'xchain', paid: '0' });
        assert.strictEqual(ctx.error, null);
        assert.strictEqual(ctx.feePaymentMode, 2);
        assert.strictEqual(ctx.gasCost, 1000);
        assert.strictEqual(handler.util.bcformat(ctx.fee, 8), '0.01000000');
        assert.deepStrictEqual(handler.required, []);
        assert.strictEqual(ctx.paidGasCeiling, null);
        ctx.gasUsed = 500000;
        await settle.settleExecution.call(handler, ctx);
        assert.strictEqual(ctx.gasBilled, 500000);
        assert.strictEqual(handler.util.bcformat(handler.debits[0][1], 8), '5.00000000');
    });
});
