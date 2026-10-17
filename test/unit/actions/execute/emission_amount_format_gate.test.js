/*
 * test/unit/actions/execute/emission_amount_format_gate.test.js
 *
 * vm_emission_amount_format_activation: from the activation a contract-emitted amount must be
 * a plain decimal numeral before roundEmissionAmounts rounds it, the shape the user path's
 * amount rule accepts; a loose form refuses the emission. Below it (and with the gate unarmed)
 * the rounding coerces exactly as before: NaN and Infinity to 0, '0x10' to 16, '1e-9' to 0.
 */
'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert  = require('assert');
const Execute = require('../../../../src/actions/execute/index.js');
const Utility = require('../../../../src/utility.js');
const { isPlainAmountText } = require('../../../../src/actions/execute/emission.js');

const ENV = 'XC_VM_EMISSION_AMOUNT_FORMAT_REGTEST_ACTIVATION';
const util = new Utility();

function makeExecute(network){
    const indexerDb = {
        getTickerId: async (tick) => (tick === 'NOPE' ? null : 1),
        getTokenDecimalPrecision: async () => 8,
    };
    return new Execute({ config: { NETWORK: network || 'regtest', COIN: 'BTC', GAS: 'XCHAIN' }, decoderDb: {}, indexerDb, util, mapper: {} });
}

async function round(ex, quantity, blockIndex){
    const params = { tick: 'TKN', quantity };
    await ex.roundEmissionAmounts('SEND', params, blockIndex);
    return params.quantity;
}

const LOOSE = ['NaN', 'Infinity', '0x10', '1e-9', '1.', '.5', '-5', 'abc', '1'.repeat(43)];
const LEGACY = { 'NaN': '0', 'Infinity': '0', '0x10': '16', '1e-9': '0', '1.': '1', '.5': '0.5' };

describe('VM emission amount format gate @regression @tier1', function(){
    let saved;
    beforeEach(() => { saved = process.env[ENV]; });
    afterEach(() => { if(saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved; });

    it('isPlainAmountText accepts plain numerals of any fractional length and refuses the rest', function(){
        for(const t of ['0', '5', '00012', '0.000000005', '1.123456789123456789123', '1'.repeat(42)])
            assert.strictEqual(isPlainAmountText(t), true, t);
        for(const t of LOOSE.concat([' 5', '', '1e+21', '+1']))
            assert.strictEqual(isPlainAmountText(t), false, JSON.stringify(t));
        assert.strictEqual(isPlainAmountText(5), false, 'takes rendered text only');
    });

    it('unarmed on regtest: loose amounts round exactly as before', async function(){
        delete process.env[ENV];
        const ex = makeExecute();
        for(const [q, want] of Object.entries(LEGACY))
            assert.strictEqual(String(await round(ex, q, 10)), want, q);
    });

    it('armed: every loose amount refuses the emission', async function(){
        process.env[ENV] = 'armed';
        const ex = makeExecute();
        for(const q of LOOSE)
            await assert.rejects(round(ex, q, 10), /SEND: invalid: quantity \(format\)/, JSON.stringify(q));
    });

    it('armed: plain amounts still round half-up', async function(){
        process.env[ENV] = 'armed';
        const ex = makeExecute();
        assert.strictEqual(String(await round(ex, '0.000000005', 10)), '0.00000001');
        assert.strictEqual(String(await round(ex, '00012', 10)), '12');
    });

    it('armed: a field the rounding skips (tick unknown locally) reaches its handler untouched', async function(){
        process.env[ENV] = 'armed';
        const params = { tick: 'NOPE', quantity: 'NaN' };
        await makeExecute().roundEmissionAmounts('SEND', params, 10);
        assert.strictEqual(params.quantity, 'NaN');
    });

    it('armed at a height: blocks below it keep the legacy rounding', async function(){
        process.env[ENV] = '100';
        const ex = makeExecute();
        assert.strictEqual(String(await round(ex, 'NaN', 99)), '0');
        await assert.rejects(round(ex, 'NaN', 100), /invalid: quantity \(format\)/);
    });

    it('a call without a block index keeps the legacy rounding', async function(){
        process.env[ENV] = 'armed';
        assert.strictEqual(String(await round(makeExecute(), '0x10')), '16');
    });

    it('mainnet is unarmed and testnet is unarmed below its v0.24.0 height', async function(){
        process.env[ENV] = 'armed';
        assert.strictEqual(String(await round(makeExecute('mainnet'), 'NaN', 1e9)), '0', 'mainnet');
        assert.strictEqual(String(await round(makeExecute('testnet'), 'NaN', 156907)), '0', 'testnet below');
        await assert.rejects(round(makeExecute('testnet'), 'NaN', 156908), /quantity \(format\)/, 'testnet at its height');
    });
});
