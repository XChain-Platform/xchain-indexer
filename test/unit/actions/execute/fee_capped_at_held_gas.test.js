/*
 * test/unit/actions/execute/fee_capped_at_held_gas.test.js
 *
 * execute_fee_cap_activation. An EXECUTE is admitted on the VM_EXECUTE_BASE floor and metered
 * against the protocol ceiling, so its metered fee can exceed the caller's GAS. From the
 * activation the settled debit is capped at the caller's held balance (floored at zero), the
 * run's outcome and metered gas stand, and the debit never drives the balance negative. Below it
 * the full metered fee is debited and no balance is read: a later action in the same block can
 * re-credit the caller, and the state commitment reads end-of-block nets, so such a block
 * commits with the uncapped debit and must replay the same.
 */
'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert  = require('assert');
const settle  = require('../../../../src/actions/execute/settle.js');
const Utility = require('../../../../src/utility.js');

const ENV = 'XC_EXECUTE_FEE_CAP_REGTEST_ACTIVATION';
const TICK_ID = 7;

// The handler `this` settleExecution runs with: a real Utility for the amount math, the
// ledger write captured instead of applied, and the caller's held balances served from `held`.
function handler(held, network){
    const util = new Utility();
    const debits = [];
    util.processTransactionLedgerChanges = async (db, data, c, d) => { debits.push(...d); };
    util.getTickersList = () => [];
    util.getAddressesList = () => ({});
    util.addAddressTicker = () => {};
    const executions = [];
    let reads = 0;
    return {
        debits, executions, reads: () => reads,
        util,
        config: { GAS_PRICE: '0.00001', NETWORK: network || 'regtest', COIN: 'BTC' },
        mapper: { createMappings: async () => {} },
        indexerDb: {
            getAddressBalances: async () => { reads++; return held; },
            createContractExecution: async (row) => { executions.push(row); },
            updateBalances: async () => {},
            updateTokens: async () => {},
        },
    };
}

function ctx(over){
    return Object.assign({
        data: { SOURCE: 'caller', ACTION_INDEX: 5, BLOCK_INDEX: 3, METHOD: 'burn', CONTRACT_ACTION_INDEX: 2 },
        error: null, skipFee: false, feePaymentMode: 2,
        tokenInfo: { TICK_ID }, gas: 'XCHAIN',
        gasUsed: 1000000, execCeiling: 1000000, nestedGasUnused: 0,
        vmError: 'out_of_resource: gas limit exceeded', emittedCount: 0,
    }, over || {});
}

async function debitFor(held, over, network){
    const h = handler(held, network);
    const c = ctx(over);
    await settle.settleExecution.call(h, c);
    return { h, c, debit: h.debits.length ? h.util.bcstr(h.debits[0][1]) : null };
}

describe('EXECUTE fee cap gate @regression @tier1', function(){
    let saved;
    beforeEach(() => { saved = process.env[ENV]; });
    afterEach(() => { if(saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved; });

    it('unarmed: the full metered fee is debited and no balance is read', async function(){
        delete process.env[ENV];
        const { h, debit } = await debitFor({ [TICK_ID]: '0.02' });
        assert.strictEqual(debit, '10');
        assert.strictEqual(h.reads(), 0);
    });

    it('armed: a run metered past the caller\'s balance debits only the balance', async function(){
        process.env[ENV] = 'armed';
        const { h, c, debit } = await debitFor({ [TICK_ID]: '0.02' });
        assert.strictEqual(debit, '0.02', 'metered 10 XCHAIN, held 0.02');
        assert.strictEqual(c.data.STATUS, 'out_of_resource', 'the outcome stands');
        assert.strictEqual(h.executions[0].GAS_USED, 1000000, 'the record keeps the metered gas');
    });

    // The verifier's v_neg_gas_recredit block: the caller holds 0.02, overspends, and a SEND
    // later in the same block credits it 20. The end-of-block net is what the state commitment
    // reads, so develop commits 10.02; the armed cap commits 20.
    it('a same-block re-credit ends at 10.02 unarmed (as develop) and 20 armed', async function(){
        const endOfBlock = (debit) => new Utility().bcstr(new Utility().bcadd(new Utility().bcsub('0.02', debit, 8), '20', 8));
        delete process.env[ENV];
        assert.strictEqual(endOfBlock((await debitFor({ [TICK_ID]: '0.02' })).debit), '10.02');
        process.env[ENV] = 'armed';
        assert.strictEqual(endOfBlock((await debitFor({ [TICK_ID]: '0.02' })).debit), '20');
    });
});

describe('EXECUTE fee cap gate: armed edges @regression @tier1', function(){
    let saved;
    beforeEach(() => { saved = process.env[ENV]; });
    afterEach(() => { if(saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved; });

    it('armed: no GAS left, or no gas row at all, is billed zero', async function(){
        process.env[ENV] = 'armed';
        assert.strictEqual((await debitFor({ [TICK_ID]: '0' })).debit, '0');
        assert.strictEqual((await debitFor({})).debit, '0');
    });

    it('armed: a covered fee is billed in full', async function(){
        process.env[ENV] = 'armed';
        assert.strictEqual((await debitFor({ [TICK_ID]: '50' }, { gasUsed: 600, vmError: null })).debit, '0.006');
    });

    it('armed at a height: blocks below it debit the full fee', async function(){
        process.env[ENV] = '4';
        assert.strictEqual((await debitFor({ [TICK_ID]: '0.02' }, { data: { SOURCE: 'caller', ACTION_INDEX: 5, BLOCK_INDEX: 3 } })).debit, '10');
        assert.strictEqual((await debitFor({ [TICK_ID]: '0.02' }, { data: { SOURCE: 'caller', ACTION_INDEX: 5, BLOCK_INDEX: 4 } })).debit, '0.02');
    });

    it('inactive (mainnet unarmed, testnet below its armed height): the full metered fee is debited', async function(){
        process.env[ENV] = 'armed';
        for(const net of ['mainnet', 'testnet'])
            assert.strictEqual((await debitFor({ [TICK_ID]: '0.02' }, null, net)).debit, '10', net);
    });

    it('native-coin payment, a system-injected run and a refused EXECUTE never read or debit GAS', async function(){
        process.env[ENV] = 'armed';
        for(const over of [{ feePaymentMode: 1 }, { skipFee: true }, { error: 'invalid: insufficient funds (GAS)' }]){
            const { h } = await debitFor(null, over);
            assert.strictEqual(h.debits.length, 0);
            assert.strictEqual(h.reads(), 0);
        }
    });
});
