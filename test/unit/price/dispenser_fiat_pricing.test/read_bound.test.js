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
 * dispenser_fiat_pricing_activation, the price read bound.
 *
 * A FIAT settlement reads every validator round stamped inside the window ending at the
 * block's time. BTC lets a later block carry an earlier stamp, so a round anchored above
 * the block can be stamped below its time: a live node whose mirror stopped at the round
 * before settles at one price, and a resync holding the later round settles at another.
 * Armed, the read is bound the way the fee read and the VM preload are bound, by
 * reference_block on BTC and by the signed admission height elsewhere, so both mirrors
 * select the same rounds. Each case runs the real statement on two sqlite mirrors.
 *
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert  = require('assert');
const sinon   = require('sinon');
const Utility = require('../../../../src/utility.js');
const { stubGate } = require('../../../helpers/gate_modules.js');
const { priceStore, withArming } = require('./helpers/price_store.js');

const T = (h) => 1700000000 + h * 600;
const B = 4;
const WINDOW = 86400;
const ORACLE = 'oracleAddress111';

// Round 2 anchors BTC block 5 and is stamped after block 4; round 3 anchors block 6 but
// carries an earlier stamp, inside block 4's window. The live node held rounds 1 and 2
// when it settled block 4; a resync holds all three.
const R1 = { round: 1, pair: 'BTC/USD', price: '60000.00000000', ref: 1, ts: T(1) - 100 };
const R2 = { round: 2, pair: 'BTC/USD', price: '30000.00000000', ref: 5, ts: T(B) + 60 };
const R3 = { round: 3, pair: 'BTC/USD', price: '90000.00000000', ref: 6, ts: T(B) - 60 };
const LIVE   = [R1, R2];
const RESYNC = [R1, R2, R3];

function util(coin, network){
    let u = new Utility();
    u.config['COIN'] = coin;
    u.config['NETWORK'] = network || 'regtest';
    return u;
}

async function modeAUnits(rows){
    let m = await util('BTC').reversePriceMatch('0.00010000', '1.00', 'BTC/USD', T(B), WINDOW, priceStore('BTC', rows), B);
    return m ? m.units : 0;
}

async function modeBUnits(rows){
    let oracle = { addr: ORACLE, chain: 'BTC', coin: 'BTC', tick: 'ZERO', fiat: 'USD', value: '1.00000000', eff: T(B) - 10, ai: 77 };
    let m = await util('BTC').reverseOraclePriceMatch('0.00010000', ORACLE, 'BTC', 'ZERO', 'USD', T(B), WINDOW,
        priceStore('BTC', rows.concat([oracle])), 'BTC', B);
    return m ? m.units : 0;
}

describe('dispenser_fiat_pricing_activation: price read bound @regression @tier1', function () {

    it('unarmed, the live node and the resync settle Mode A at different prices (the replay case)', async function () {
        await withArming(undefined, async () => {
            assert.notStrictEqual(await modeAUnits(LIVE), await modeAUnits(RESYNC),
                'below the gate the read stays unbounded, so the inversion still forks');
        });
    });

    it('armed, a Mode A dispense settles the same on the live node and the resync', async function () {
        await withArming('armed', async () => {
            let live = await modeAUnits(LIVE), resync = await modeAUnits(RESYNC);
            assert.strictEqual(resync, live, 'the round anchored above the block is not readable');
            assert.strictEqual(live, 6, '0.0001 BTC at round 1 (60000 USD) buys six 1.00 USD fills');
        });
    });

    it('armed, the validator price behind a Mode B oracle quote is bound the same way', async function () {
        await withArming('armed', async () => {
            assert.strictEqual(await modeBUnits(RESYNC), await modeBUnits(LIVE));
            assert.strictEqual(await modeBUnits(LIVE), 6);
        });
    });

    it('armed, a create judged only on a round anchored above the block has no settlement price', async function () {
        let dispenser = { FIAT: 'USD', ORACLE_ADDRESS: null, GIVE_COIN: 'BTC', GIVE_TICK: 'ZERO', GET_COIN: 'BTC' };
        let gap = (u) => u.findSettlementPriceGap(dispenser, T(B), WINDOW, priceStore('BTC', [R3]), B);
        await withArming(undefined, async () => assert.strictEqual(await gap(util('BTC')), null));
        await withArming('armed', async () => assert.strictEqual(await gap(util('BTC')),
            'invalid: FIAT_CODE (no price snapshot in the settlement window)'));
    });

    // LTC testnet at a height where the mirror-admission consumer gate is armed (and the
    // landed-batch bound is not); this gate is armed there for the one case by stubGate.
    it('armed on a non-reference chain in the admission era, the read binds on the signed admission height', async function () {
        const H = 4903400, t = T(B);
        let rows = [
            { round: 1, pair: 'LTC/USD', price: '60000.00000000', ts: t - 1000, admitLtc: H - 10 },
            { round: 2, pair: 'LTC/USD', price: '90000.00000000', ts: t - 60, admitLtc: H + 1 },
        ];
        let units = async () => (await util('LTC', 'testnet').reversePriceMatch('0.00010000', '1.00', 'LTC/USD', t, WINDOW,
            priceStore('LTC', rows, 'testnet'), H)).units;
        assert.strictEqual(await units(), 9, 'unarmed on testnet: round 2 is read by its stamp');
        stubGate(sinon, 'dispenser_fiat_pricing_activation.DISPENSER_FIAT_PRICING_ACTIVATION', true);
        try {
            assert.strictEqual(await units(), 6, 'round 2 is admitted above this block, so it is not readable here');
        } finally { sinon.restore(); }
    });
});

describe('dispenser_fiat_pricing_activation: landed-batch clause on the bounded read @regression @tier1', function () {

    // Round 2 is the newer round, but its batch has not landed (batch_block_time 0). Where
    // price_fee_batch_landed_activation binds, the fee read refuses such a round, and so does
    // the armed FIAT read; the landed row is armed here for the one case by stubGate.
    it('armed with the landed-batch row active, a round whose batch has not landed is not read', async function () {
        let rows = [
            { round: 1, pair: 'BTC/USD', price: '60000.00000000', ref: 1, ts: T(B) - 900, bbt: T(B) - 100 },
            { round: 2, pair: 'BTC/USD', price: '90000.00000000', ref: 2, ts: T(B) - 300, bbt: 0 },
        ];
        let units = async () => (await util('BTC').reversePriceMatch('0.00010000', '1.00', 'BTC/USD', T(B), WINDOW,
            priceStore('BTC', rows), B)).units;
        await withArming('armed', async () => {
            assert.strictEqual(await units(), 9, 'landed row inert: the newest round is read');
            stubGate(sinon, 'price_fee_batch_landed_activation.PRICE_FEE_BATCH_LANDED_ACTIVATION', true);
            try {
                assert.strictEqual(await units(), 6, 'landed row active: only the round whose batch landed');
            } finally { sinon.restore(); }
        });
    });
});
