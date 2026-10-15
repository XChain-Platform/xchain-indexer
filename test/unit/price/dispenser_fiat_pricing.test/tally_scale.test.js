/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * dispenser_fiat_pricing_activation, the shared coin-payment tally.
 *
 * One coin payment to an address shared by several dispensers buys floor(COIN x price /
 * FIAT) fills in total. Unarmed the tally drains at 8 dp, so a Mode A fill costing under
 * half a satoshi drains nothing and the next dispenser prices against the whole payment
 * again. Armed, the fill cost accrues exactly, so the dispensers together credit what the
 * payment buys and no more. The case: two JPY 0.01 dispensers, the first with one fill
 * left, paid 10 satoshis at 15500000.12345678 BTC/JPY, which buys 155 fills.
 *
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert   = require('assert');
const Utility  = require('../../../../src/utility.js');
const Dispense = require('../../../../src/actions/dispense/index.js');
const { withArming } = require('./helpers/price_store.js');

const ADDRESS = 'dispenserAddress11111111111';
const BLOCK_TIME = 1786838400;
const PRICE = '15500000.12345678';

function dispenserRow(actionIndex, remaining){
    return {
        ACTION_INDEX: actionIndex, SOURCE: 'dispenserOwner', GET_ADDRESS: ADDRESS,
        GET_COIN: 'BTC', GET_TICK: 'BTC', GET_AMOUNT: '0', GIVE_COIN: 'BTC', GIVE_TICK: 'ZERO',
        GIVE_AMOUNT: '1', GIVE_REMAINING: remaining, GIVE_OWNERSHIP: 0, FIAT: 'JPY',
        FIAT_AMOUNT: '0.01', ORACLE_ADDRESS: null, ALLOW_LIST: null, BLOCK_LIST: null
    };
}

// A DISPENSE over two Mode A dispensers behind one address; returns the dispense rows.
async function settle(payment){
    let util = new Utility();
    util.config['COIN'] = 'BTC';
    util.config['NETWORK'] = 'regtest';
    util.processTransactionLedgerChanges = async () => {};
    let rows = { 600: dispenserRow(600, '1'), 601: dispenserRow(601, '100000') };
    let created = [];
    let indexerDb = {
        findMatchingDispensers:      async () => [600, 601],
        getDispenserInfo:            async (coin, actionIndex) => Object.assign({}, rows[actionIndex]),
        getClosedDispenserAtAddress: async () => null,
        deleteActionIndex:           async () => {},
        createActionIndex:           async () => 42,
        getTokenInfo:                async () => null,
        getList:                     async () => [],
        createDispense:              async (d) => { created.push(Object.assign({}, d)); },
        updateBalances:              async () => {},
        getDispenserDispenseCount:   async () => 0,
        getPricesInTimeRange:        async () => [{ price: PRICE, roundNumber: 1, timestamp: BLOCK_TIME - 100 }]
    };
    let actions = {
        config: util.config, decoderDb: {}, indexerDb, util,
        mapper: { createMappings: async () => {} },
        protocolChanges: { isEnabled: async () => true },
        processAction: async () => {}
    };
    await new Dispense(actions).parse(null, {
        ACTION_INDEX: 1, BLOCK_INDEX: 100, BLOCK_TIME, TX_INDEX: 7, COIN: 'BTC', COIN_TICK: 'BTC',
        SOURCE: 'buyerAddress', COIN_AMOUNT: payment, COIN_DESTINATION: ADDRESS
    }, false);
    return created.map(d => ({ status: d['STATUS'], give: String(d['GIVE_AMOUNT']), get: String(d['GET_AMOUNT']) }));
}

const total = (rows) => rows.reduce((n, r) => n + (r.status === 'valid' ? Number(r.give) : 0), 0);

describe('dispenser_fiat_pricing_activation: shared coin-payment tally @regression @tier1', function () {

    it('unarmed, a sub-satoshi first fill drains nothing and the payment buys 156 (the replay case)', async function () {
        let rows = await withArming(undefined, () => settle('0.00000010'));
        assert.deepStrictEqual(rows.map(r => r.give), ['1', '155']);
        assert.strictEqual(rows[0].get, '0.00000000', 'the first fill is recorded as free');
    });

    it('armed, the two dispensers together credit the 155 fills the payment buys', async function () {
        let rows = await withArming('armed', () => settle('0.00000010'));
        assert.deepStrictEqual(rows.map(r => r.status), ['valid', 'valid']);
        assert.deepStrictEqual(rows.map(r => r.give), ['1', '154'], 'the second dispenser prices what is left');
        assert.strictEqual(total(rows), 155);
    });

    it('armed, the recorded costs are the fills bought and never sum past the payment', async function () {
        let rows = await withArming('armed', () => settle('0.00000010'));
        assert.ok(Number(rows[0].get) > 0, 'the sub-satoshi fill is charged, not recorded as free: ' + rows[0].get);
        let sum = new Utility().bcadd(rows[0].get, rows[1].get, 18);
        assert.ok(!new Utility().bcgt(sum, '0.00000010'), 'charged ' + String(sum) + ' out of 0.00000010');
    });

    // The charge is the one rounding the tally takes, and it rounds UP: a charge rounded down
    // leaves the next dispenser a sliver of payment the buyer already spent.
    it('armed, every recorded charge covers the fiat value of the fills it bought', async function () {
        let rows = await withArming('armed', () => settle('0.00000010'));
        const scaled = (v, d) => { let [i, f = ''] = String(v).split('.'); return BigInt(i) * 10n ** BigInt(d) + BigInt((f + '0'.repeat(d)).slice(0, d)); };
        for (const r of rows){
            // charge x price >= fills x 0.01 JPY, in integers: charge at 18 dp, price at 8 dp.
            let covered = scaled(r.get, 18) * scaled(PRICE, 8) * 100n >= BigInt(r.give) * 10n ** 26n;
            assert.ok(covered, r.give + ' fills charged ' + r.get + ' at ' + PRICE + ' JPY is under their 0.01 JPY each');
        }
    });
});
