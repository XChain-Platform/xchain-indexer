'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Swap and dispenser EXPIRATION, ALLOW_LIST and BLOCK_LIST are user-chosen u64
// values: a read above 2^53 must keep its exact decimal string, while a safe
// value still comes back as a Number.

const assert = require('assert');

const swapInfo   = require('../../../../src/db/swaps/swap_info.js');
const dispensers = require('../../../../src/db/dispensers/index.js');

const U64_MAX   = '18446744073709551615';
const ABOVE_53  = '9007199254740993';

const util = {
    isNull: value => value === null || value === undefined || value === '',
    isNumeric: value => value !== null && value !== undefined && /^\d+$/.test(String(value)),
    bcgt: (a, b) => BigInt(a) > BigInt(b),
    bcadd: (a, b) => (BigInt(a) + BigInt(b)).toString(),
    bclt: (a, b) => BigInt(a) < BigInt(b)
};

// A db context whose doQuery answers the edits read with editRows and every
// other read with baseRows.
function ctx(baseRows, editRows, editsTable){
    return {
        util,
        config: { COIN: 'BTC', NETWORK: 'regtest', DISPENSER_LIST_DELAY: 0, LIST_FIELDS: ['ALLOW_LIST', 'BLOCK_LIST'] },
        async doQuery(sql){
            return new RegExp(editsTable).test(sql) ? editRows : baseRows;
        },
        async getDispenserAmountRemaining(){ return '10'; }
    };
}

function bind(db, mod){
    for(const [name, fn] of Object.entries(mod))
        if(typeof fn === 'function') db[name] = fn;
    return db;
}

describe('swap and dispenser u64 reads keep exact values above 2^53', function(){
    describe('swap info', function(){
        it('keeps the base EXPIRATION, ALLOW_LIST and BLOCK_LIST exact and a safe value a Number', async function(){
            const db = bind(ctx([{ action_index: '7', expiration: U64_MAX, allow_list: ABOVE_53, block_list: '5' }], [], 'swap_edits'), swapInfo);
            const swap = await db.getSwapInfo(null, 7);
            assert.strictEqual(swap.EXPIRATION, U64_MAX);
            assert.strictEqual(swap.ALLOW_LIST, ABOVE_53);
            assert.strictEqual(swap.BLOCK_LIST, 5);
            assert.strictEqual(swap.ACTION_INDEX, 7);
        });

        it('folds an edit overlay carrying u64 max as the exact string', async function(){
            const edits = [{ expiration: U64_MAX, allow_list: U64_MAX, block_list: '42' }];
            const db = bind(ctx([{ action_index: '7', expiration: '100', allow_list: null, block_list: null }], edits, 'swap_edits'), swapInfo);
            const edit = await db.getSwapEdits(7);
            assert.deepStrictEqual(edit, { expiration: U64_MAX, allow_list: U64_MAX, block_list: 42 });
            const swap = await db.getSwapInfo(null, 7);
            assert.strictEqual(swap.EXPIRATION, U64_MAX);
            assert.strictEqual(swap.ALLOW_LIST, U64_MAX);
            assert.strictEqual(swap.BLOCK_LIST, 42);
        });
    });

    describe('dispenser info', function(){
        it('keeps the base EXPIRATION, ALLOW_LIST and BLOCK_LIST exact and a safe value a Number', async function(){
            const db = bind(ctx([{ action_index: '9', expiration: U64_MAX, allow_list: '3', block_list: ABOVE_53, give_ownership: '0' }], [], 'dispenser_edits'), dispensers);
            const dispenser = await db.getDispenserInfo('BTC', 9, 1000);
            assert.strictEqual(dispenser.EXPIRATION, U64_MAX);
            assert.strictEqual(dispenser.ALLOW_LIST, 3);
            assert.strictEqual(dispenser.BLOCK_LIST, ABOVE_53);
            assert.strictEqual(dispenser.ACTION_INDEX, 9);
        });

        it('folds an active edit overlay carrying u64 max as the exact string', async function(){
            const edits = [{ expiration: U64_MAX, allow_list: '42', block_list: U64_MAX, block_index: 10, block_time: 500 }];
            const db = bind(ctx([{ action_index: '9', expiration: '100', allow_list: null, block_list: null, give_ownership: '0' }], edits, 'dispenser_edits'), dispensers);
            const edit = await db.getDispenserEdits(9, 1000);
            assert.deepStrictEqual(edit, { expiration: U64_MAX, allow_list: 42, block_list: U64_MAX });
            const dispenser = await db.getDispenserInfo('BTC', 9, 1000);
            assert.strictEqual(dispenser.EXPIRATION, U64_MAX);
            assert.strictEqual(dispenser.ALLOW_LIST, 42);
            assert.strictEqual(dispenser.BLOCK_LIST, U64_MAX);
        });
    });
});
