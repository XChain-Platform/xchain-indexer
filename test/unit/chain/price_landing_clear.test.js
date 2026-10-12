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
 * The price_landing_clear row classifier, the clear-block rule and the decoder scan.
 */

'use strict';

const assert = require('assert');

const { isPriceRow, clearBlock } = require('../../../src/chain/price_landing_clear.js');
const scan = require('../../../src/db/transactions/price_landing_scan.js');

describe('price_landing_clear @regression @tier1', function () {
    describe('isPriceRow', function () {
        it('matches the PRICE action name trimmed and case-insensitively', function () {
            assert.strictEqual(isPriceRow({ data: ' price |2|Z|x' }), true);
            assert.strictEqual(isPriceRow({ data: 'PRICE|0|1' }), true);
        });
        it('does not match other actions or a longer name', function () {
            assert.strictEqual(isPriceRow({ data: 'SEND|1' }), false);
            assert.strictEqual(isPriceRow({ data: 'PRICES|1' }), false);
            assert.strictEqual(isPriceRow({ data: 'SEND|PRICE|1' }), false);
        });
        it('treats an unclassifiable row as a PRICE row', function () {
            assert.strictEqual(isPriceRow(null), true);
            assert.strictEqual(isPriceRow({}), true);
            assert.strictEqual(isPriceRow({ data: null }), true);
        });
    });

    describe('clearBlock', function () {
        it('is the decoder tip when no PRICE row lies above the frontier', function () {
            assert.strictEqual(clearBlock({ delivered: 100, decoderTip: 110, firstPriceBlock: null }), 110);
        });
        it('stops one block short of the first PRICE block', function () {
            assert.strictEqual(clearBlock({ delivered: 100, decoderTip: 110, firstPriceBlock: 104 }), 103);
        });
        it('is the frontier when the PRICE block is the next block', function () {
            assert.strictEqual(clearBlock({ delivered: 100, decoderTip: 110, firstPriceBlock: 101 }), 100);
        });
        it('answers null for incoherent input', function () {
            assert.strictEqual(clearBlock({ delivered: null, decoderTip: 110, firstPriceBlock: null }), null);
            assert.strictEqual(clearBlock({ delivered: 100, decoderTip: NaN, firstPriceBlock: null }), null);
            assert.strictEqual(clearBlock({ delivered: 120, decoderTip: 110, firstPriceBlock: null }), null);
            assert.strictEqual(clearBlock({ delivered: 100, decoderTip: 110, firstPriceBlock: 100 }), null);
        });
    });

    describe('getFirstPriceBlockAfter', function () {
        function dbWith(pages) {
            const calls = [];
            const db = Object.create(scan);
            db.doQueryStrict = async (sql, params) => { calls.push(params); return pages.shift() || []; };
            db.calls = calls;
            return db;
        }

        it('returns the first confirmed PRICE block and skips LIKE false positives', async function () {
            const db = dbWith([[
                { block_index: 101, data: 'SEND|reprice' },
                { block_index: 103, data: 'price|2|Z|x' },
                { block_index: 105, data: 'price|2|Z|y' },
            ]]);
            assert.strictEqual(await db.getFirstPriceBlockAfter(100, 110), 103);
        });
        it('returns null when no candidate is a PRICE row', async function () {
            const db = dbWith([[{ block_index: 101, data: 'SEND|reprice' }]]);
            assert.strictEqual(await db.getFirstPriceBlockAfter(100, 110), null);
        });
        it('counts a NULL payload as a PRICE row', async function () {
            const db = dbWith([[{ block_index: 102, data: null }]]);
            assert.strictEqual(await db.getFirstPriceBlockAfter(100, 110), 102);
        });
        it('pages past a full page of non-PRICE candidates', async function () {
            const full = Array.from({ length: 200 }, () => ({ block_index: 101, data: 'SEND|reprice' }));
            const db = dbWith([full, [{ block_index: 101, data: 'price|1' }]]);
            assert.strictEqual(await db.getFirstPriceBlockAfter(100, 110), 101);
            assert.deepStrictEqual(db.calls.map(c => c[2]), [0, 200]);
        });
        it('does not query an empty range', async function () {
            const db = dbWith([]);
            assert.strictEqual(await db.getFirstPriceBlockAfter(110, 110), null);
            assert.strictEqual(db.calls.length, 0);
        });
    });
});
