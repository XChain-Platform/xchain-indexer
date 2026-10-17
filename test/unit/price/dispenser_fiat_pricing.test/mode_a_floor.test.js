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
 * dispenser_fiat_pricing_activation, the Mode A fill count.
 *
 * The documented rule is floor(COIN_AMOUNT x price / FIAT_AMOUNT). Unarmed the matcher
 * rounds FIAT_AMOUNT / price half-up at 18 dp and divides by it, which under-credits an
 * exact payment (three fills paid, two credited) and over-credits a large one by
 * thousands. Armed, every count below must equal the rule computed in BigInt rationals.
 *
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert  = require('assert');
const Utility = require('../../../../src/utility.js');
const { withArming } = require('./helpers/price_store.js');

const NOW = 1790000000;
const WINDOW = 86400;

// A decimal string as an integer scaled by 10^d.
function scaled(s, d){
    let [i, f = ''] = String(s).split('.');
    return BigInt(i) * 10n ** BigInt(d) + BigInt((f + '0'.repeat(d)).slice(0, d));
}

// floor(coin x price / fiat) with coin and price at 8 dp and fiat at 2 dp, exactly.
function documentedFills(coin, price, fiat){
    return (scaled(coin, 8) * scaled(price, 8)) / (scaled(fiat, 2) * 10n ** 14n);
}

async function fills(coin, price, fiat, blockIndex){
    let u = new Utility();
    u.config['COIN'] = 'BTC';
    u.config['NETWORK'] = 'regtest';
    let db = { async getPricesInTimeRange(){ return [{ price, roundNumber: 1, timestamp: NOW - 60 }]; } };
    let m = await u.reversePriceMatch(coin, fiat, 'BTC/USD', NOW, WINDOW, db, blockIndex);
    return m ? BigInt(m.units) : 0n;
}

describe('dispenser_fiat_pricing_activation: Mode A floor rule @regression @tier1', function () {

    it('unarmed, an exact three-fill payment is credited two (the replay case)', async function () {
        await withArming(undefined, async () => assert.strictEqual(await fills('0.00020000', '15000.00000000', '1.00', 10), 2n));
    });

    it('armed, an exact three-fill payment is credited three', async function () {
        await withArming('armed', async () => assert.strictEqual(await fills('0.00020000', '15000.00000000', '1.00', 10), 3n));
    });

    it('armed, a large payment is credited the documented count, not thirty-three over it', async function () {
        await withArming('armed', async () => assert.strictEqual(
            await fills('37.40324987', '18136844.63500977', '0.01', 10), 67837693173n));
    });

    it('armed, every count across prices, fiat amounts and fill boundaries is the floor rule', async function () {
        let seed = 7;
        const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
        let prices = ['15000.00000000', '16000000.00000000'];
        for (let i = 0; i < 25; i++) prices.push((60000 + rnd() * 60000).toFixed(8), (1e7 + rnd() * 1e8).toFixed(8), (3 + rnd() * 1000).toFixed(8));
        let fiats = ['0.01', '0.07', '1.00', '9.99', '99999.99'];
        let wrong = [];
        await withArming('armed', async () => {
            for (const price of prices) for (const fiat of fiats) for (const k of [1n, 3n, 12345n, 9876543n]){
                // The smallest whole-satoshi payment covering k fills, and one satoshi less.
                let p = scaled(price, 8), f = scaled(fiat, 2);
                let cmin = (k * f * 10n ** 14n + p - 1n) / p;
                for (const c of [cmin, cmin - 1n]){
                    if (c <= 0n) continue;
                    let coin = (c / 100000000n) + '.' + String(c % 100000000n).padStart(8, '0');
                    let got = await fills(coin, price, fiat, 10), want = documentedFills(coin, price, fiat);
                    if (got !== want) wrong.push({ coin, price, fiat, got: String(got), want: String(want) });
                }
            }
        });
        assert.deepStrictEqual(wrong.slice(0, 5), [], wrong.length + ' counts differ from floor(COIN x price / FIAT)');
    });

    it('armed, a caller that supplies no block index keeps the unarmed count', async function () {
        await withArming('armed', async () => assert.strictEqual(await fills('0.00020000', '15000.00000000', '1.00', undefined), 2n));
    });
});
