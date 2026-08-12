/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * Give-side decimal grid on the cross-chain book (/#3146).
 *
 * The hub quantizes every cross-chain fill on the grid reported here and DECLINES a
 * match when it is absent, so what this stamping gets wrong the hub either settles
 * wrong or refuses to settle at all. Four properties, each of which was a real
 * decision rather than an accident:
 *
 *   1. the value comes from getTokenInfo (the same authority order_match.js uses),
 *      not from a re-derived tokens.decimals read;
 *   2. a tick with no token row - a native-coin give side - falls back to this
 *      chain's COIN_DECIMALS, mirroring order_match's own ternary;
 *   3. getTokenInfo is never called for a tick with no id, because it would INTERN
 *      one (createTicker inserts), and an out-of-band index-id assignment on a read
 *      path offsets the deterministic counter behind wire ^<id> references and the
 *      index-map state-hash class (#5052);
 *   4. 0 decimals survives as 0. It is a real grid (indivisible/NFT ticks), and any
 *      falsy-coercing shortcut turns it into the COIN_DECIMALS fallback, which is
 *      exactly the mis-quantization the hub refuses to guess at.
 *********************************************************************/

'use strict';

const assert = require('assert');
const { stampGiveDecimals } = require('../../src/crossChainOfferDecimals');

// Minimal util stand-in: only isNull is used, with the same semantics as src/utility.js.
const util = { isNull: (v) => (v === null || v === undefined) };

// A db double whose token table is a plain map of tick -> DECIMALS (null models a token
// whose decimals column is NULL). Records every call so the caching and the
// no-interning property are observable rather than assumed.
function makeDb(tokens) {
    return {
        tickerCalls: [],
        tokenCalls:  [],
        async getTickerId(tick) {
            this.tickerCalls.push(tick);
            return Object.prototype.hasOwnProperty.call(tokens, tick) ? 42 : null;
        },
        async getTokenInfo(tick, blockIndex) {
            this.tokenCalls.push({ tick, blockIndex });
            if (!Object.prototype.hasOwnProperty.call(tokens, tick)) return false;
            return { TICK: tick, DECIMALS: tokens[tick] };
        }
    };
}

const offer = (give_tick) => ({ action_index: 1, give_tick, give_amount: '10' });

describe('cross-chain book give_decimals stamping (#3145/#3146) @regression @tier1', function () {

    it('reports the token DECIMALS getTokenInfo resolves', async function () {
        const db = makeDb({ LTCT: 8, NFT: 0, ODD: 3 });
        const offers = [offer('LTCT'), offer('NFT'), offer('ODD')];
        await stampGiveDecimals(db, util, 8, offers, 500);
        assert.deepStrictEqual(offers.map(o => o.give_decimals), [8, 0, 3]);
    });

    it('keeps 0 as 0 rather than collapsing it into the COIN_DECIMALS fallback', async function () {
        // The whole reason the hub does not guess: a 0-decimal tick settling at 8dp
        // would propose a fractional quantity for an indivisible token.
        const db = makeDb({ NFT: 0 });
        const offers = [offer('NFT')];
        await stampGiveDecimals(db, util, 8, offers, 500);
        assert.strictEqual(offers[0].give_decimals, 0);
    });

    it('falls back to COIN_DECIMALS for a give side with no token (native coin)', async function () {
        const db = makeDb({});
        const offers = [offer(null), offer('')];
        await stampGiveDecimals(db, util, 8, offers, 500);
        assert.deepStrictEqual(offers.map(o => o.give_decimals), [8, 8]);
        assert.deepStrictEqual(db.tokenCalls, [],
            'a tick-less give side must not reach getTokenInfo at all');
    });

    it('falls back rather than emitting null when getTokenInfo answers with no DECIMALS', async function () {
        // getTokenInfo already normalizes a NULL decimals column to 0 upstream (db.js
        // `(!isNull(row.decimals)) ? parseInt(row.decimals) : 0`), so this models the
        // residual case only: an answer carrying no DECIMALS at all. What matters is that
        // the offer never leaves here with null/NaN, which the hub reads as "no grid" and
        // refuses to match on.
        const db = makeDb({ OLD: null });
        const offers = [offer('OLD')];
        await stampGiveDecimals(db, util, 8, offers, 500);
        assert.strictEqual(offers[0].give_decimals, 8);
    });

    it('never calls getTokenInfo for an unknown tick, because that would intern an id', async function () {
        // #5052: getTokenInfo -> createTicker INSERTS index_tickers for an unknown tick.
        // On this federation read path that offsets the deterministic dense id counter.
        const db = makeDb({ LTCT: 8 });
        const offers = [offer('NEVER_ISSUED')];
        await stampGiveDecimals(db, util, 8, offers, 500);
        assert.deepStrictEqual(db.tickerCalls, ['NEVER_ISSUED'], 'the id is looked up');
        assert.deepStrictEqual(db.tokenCalls, [], 'and getTokenInfo is then skipped');
        assert.strictEqual(offers[0].give_decimals, 8, 'the offer still gets a usable grid');
    });

    it('looks a tick up once per page however many offers share it', async function () {
        const db = makeDb({ LTCT: 8, DOGT: 2 });
        const offers = [offer('LTCT'), offer('DOGT'), offer('LTCT'), offer('LTCT'), offer('DOGT')];
        await stampGiveDecimals(db, util, 8, offers, 500);
        assert.deepStrictEqual(offers.map(o => o.give_decimals), [8, 2, 8, 8, 2]);
        assert.strictEqual(db.tokenCalls.length, 2, 'one lookup per DISTINCT tick');
        assert.strictEqual(db.tickerCalls.length, 2);
    });

    it('resolves at the tip the response is pinned to', async function () {
        // Every other field in the response reflects `latest`; a grid read at a
        // different height would describe a different view of the same book.
        const db = makeDb({ LTCT: 8 });
        await stampGiveDecimals(db, util, 8, [offer('LTCT')], 961000);
        assert.strictEqual(db.tokenCalls[0].blockIndex, 961000);
    });

    it('is a no-op on an empty or missing book', async function () {
        const db = makeDb({});
        assert.deepStrictEqual(await stampGiveDecimals(db, util, 8, [], 500), []);
        await stampGiveDecimals(db, util, 8, null, 500);   // must not throw
    });
});
