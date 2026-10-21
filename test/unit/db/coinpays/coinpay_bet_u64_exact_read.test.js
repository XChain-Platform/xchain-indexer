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

// Coinpay EXPIRATION and bet feed DEADLINE, REFUND_WINDOW, EXPIRE_AT,
// ALLOW_LIST and BLOCK_LIST are user-chosen u64 values: a read above 2^53 must
// keep its exact decimal string, while a safe value still comes back as a Number.

const assert = require('assert');

const coinpays = require('../../../../src/db/coinpays/index.js');
const bets     = require('../../../../src/db/bets/index.js');

const U64_MAX  = '18446744073709551615';
const ABOVE_53 = '9007199254740993';

const util = { isNull: value => value === null || value === undefined || value === '' };

function db(rows, mod){
    const ctx = { util, async doQuery(){ return rows; } };
    for(const [name, fn] of Object.entries(mod))
        if(typeof fn === 'function') ctx[name] = fn;
    return ctx;
}

describe('coinpay and bet u64 reads keep exact values above 2^53', function(){
    it('keeps a coinpay obligation EXPIRATION exact at u64 max', async function(){
        const ctx = db([{ action_index: '11', block_index: '200', expiration: U64_MAX, coin_amount: '5' }], coinpays);
        const obligation = await ctx.getCoinpayObligationInfo(11);
        assert.strictEqual(obligation.EXPIRATION, U64_MAX);
        assert.strictEqual(obligation.ACTION_INDEX, 11);
        assert.strictEqual(obligation.BLOCK_INDEX, 200);
    });

    it('reads a safe coinpay EXPIRATION as a Number', async function(){
        const ctx = db([{ action_index: '11', block_index: '200', expiration: '1700000000' }], coinpays);
        const obligation = await ctx.getCoinpayObligationInfo(11);
        assert.strictEqual(obligation.EXPIRATION, 1700000000);
    });

    it('reads a NULL coinpay EXPIRATION as 0, as before', async function(){
        const ctx = db([{ action_index: '11', block_index: '200', expiration: null }], coinpays);
        const obligation = await ctx.getCoinpayObligationInfo(11);
        assert.strictEqual(obligation.EXPIRATION, 0);
    });

    it('keeps an expired coinpay expiration exact and a safe one a Number', async function(){
        const ctx = db([
            { action_index: '11', expiration: U64_MAX },
            { action_index: '12', expiration: '1700000000' }
        ], coinpays);
        const expired = await ctx.getExpiredCoinpayObligations(1800000000, false);
        assert.deepStrictEqual(expired, [
            { action_index: 11, expiration: U64_MAX },
            { action_index: 12, expiration: 1700000000 }
        ]);
    });

    it('keeps bet feed DEADLINE, REFUND_WINDOW, EXPIRE_AT, ALLOW_LIST and BLOCK_LIST exact', async function(){
        const ctx = db([{
            action_index: '21', block_index: '300', deadline: U64_MAX, refund_window: ABOVE_53,
            expire_at: U64_MAX, allow_list: U64_MAX, block_list: ABOVE_53, closed_block: null
        }], bets);
        const feed = await ctx.getBetFeedInfo(21);
        assert.strictEqual(feed.DEADLINE, U64_MAX);
        assert.strictEqual(feed.REFUND_WINDOW, ABOVE_53);
        assert.strictEqual(feed.EXPIRE_AT, U64_MAX);
        assert.strictEqual(feed.ALLOW_LIST, U64_MAX);
        assert.strictEqual(feed.BLOCK_LIST, ABOVE_53);
        assert.strictEqual(feed.ACTION_INDEX, 21);
        assert.strictEqual(feed.CLOSED_BLOCK, null);
    });

    it('reads safe bet feed u64 values as Numbers and keeps NULL lists NULL', async function(){
        const ctx = db([{
            action_index: '21', deadline: '1700000000', refund_window: '600',
            expire_at: '1700000600', allow_list: null, block_list: '7'
        }], bets);
        const feed = await ctx.getBetFeedInfo(21);
        assert.strictEqual(feed.DEADLINE, 1700000000);
        assert.strictEqual(feed.REFUND_WINDOW, 600);
        assert.strictEqual(feed.EXPIRE_AT, 1700000600);
        assert.strictEqual(feed.ALLOW_LIST, null);
        assert.strictEqual(feed.BLOCK_LIST, 7);
    });
});
