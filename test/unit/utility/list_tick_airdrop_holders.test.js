/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const {
    collectTickHolders,
} = require('../../../src/utility/list_tick/airdrop_holders.js');

const ITEMS = ['FOO', 'BTC:^5', 'BTC:NOPE', 'DOGE:PEPE'];
const COINS = ['BTC', 'LTC', 'DOGE'];

function fakeReads(){
    let holderReads = [];
    let tickerIdReads = [];
    let holders = {
        FOO: { a1: 1, a2: 1 },
        '^5': { a2: 1, a3: 1 },
    };

    return {
        holderReads,
        tickerIdReads,
        getHolders: async (tick) => {
            holderReads.push(tick);
            return holders[tick] === undefined ? null : holders[tick];
        },
        getTickerId: async (tick) => {
            tickerIdReads.push(tick);
            return tick === '^5' ? 5 : null;
        },
    };
}

describe('AIRDROP ticker-list holder collection', function(){
    it('reads bare and resolvable own-coin ticks when armed', async function(){
        let reads = fakeReads();
        let recipients = await collectTickHolders(ITEMS, {
            active: true,
            coin: 'BTC',
            coins: COINS,
            getTickerId: reads.getTickerId,
            getHolders: reads.getHolders,
        });

        assert.deepStrictEqual([...recipients], ['a1', 'a2', 'a3']);
        assert.deepStrictEqual(reads.holderReads, ['FOO', '^5']);
        assert.deepStrictEqual(reads.tickerIdReads, ['^5', 'NOPE']);
    });

    it('reads every item as written and no ticker ids when unarmed', async function(){
        let reads = fakeReads();
        let recipients = await collectTickHolders(ITEMS, {
            active: false,
            coin: 'BTC',
            coins: COINS,
            getTickerId: reads.getTickerId,
            getHolders: reads.getHolders,
        });

        assert.deepStrictEqual([...recipients], ['a1', 'a2']);
        assert.deepStrictEqual(reads.holderReads, ITEMS);
        assert.deepStrictEqual(reads.tickerIdReads, []);
    });

    it('adds nothing for a null or undefined holders answer', async function(){
        for(let answer of [null, undefined]){
            let recipients = await collectTickHolders(['EMPTY'], {
                active: false,
                getHolders: async () => answer,
            });
            assert.deepStrictEqual([...recipients], []);
        }
    });

    it('rejects invalid dependencies before making any read', async function(){
        let calls = 0;
        let getHolders = async () => {
            calls++;
            return {};
        };
        await assert.rejects(
            collectTickHolders(null, { active: false, getHolders }),
            TypeError
        );
        await assert.rejects(
            collectTickHolders(ITEMS, { active: false, getHolders: null }),
            TypeError
        );
        await assert.rejects(
            collectTickHolders(ITEMS, {
                active: true,
                coin: 'BTC',
                coins: COINS,
                getHolders,
            }),
            TypeError
        );

        assert.strictEqual(calls, 0);
    });
});
