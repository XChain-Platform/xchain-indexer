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
 **********************************************************************
 * utility.parseBridgedTick: the origin-rooted namespace reader
 * (the token bridge spec sections 3 and 6, its D15).
 *
 * A bridged copy is named `<ORIGIN>.<NAME>` on the destination chain, so
 * `BTC.PEPECASH` read on DOGE is PEPECASH, native to BTC. The helper returns
 * { origin, name } only when all three hold, else null:
 *   - the tick carries EXACTLY one dot (a dotted native name is a subasset,
 *     which milestone 1 refuses at lock time rather than mis-rooting here),
 *   - the prefix names a supported coin,
 *   - that coin is not THIS chain's coin (a row rooted at the local coin is a
 *     subasset of the local reserved root, never a bridged copy).
 *
 * The consensus surface is the null/non-null split: the XBRIDGE v4 burn path
 * and the explorer both key "is this a bridged row" off it, so a tick that
 * parses where it should not would let a burn debit a native row's supply.
 * Case is the sharp edge: every ticker lookup is LOWER(tick) (db.js), so
 * `btc.pepecash` reaches the same row as `BTC.PEPECASH` and must reach the
 * same verdict.
 ********************************************************************/

'use strict';

const assert  = require('assert');
const Utility = require('../../src/utility.js');

function utilFor(coin){
    const prevCoin    = process.env.INDEXER_COIN;
    const prevNetwork = process.env.INDEXER_NETWORK;
    process.env.INDEXER_COIN    = coin;
    process.env.INDEXER_NETWORK = 'regtest';
    const cfg = require('../../src/config.js').getConfig();
    if(prevCoin === undefined) delete process.env.INDEXER_COIN; else process.env.INDEXER_COIN = prevCoin;
    if(prevNetwork === undefined) delete process.env.INDEXER_NETWORK; else process.env.INDEXER_NETWORK = prevNetwork;
    return new Utility(cfg);
}

describe('utility.parseBridgedTick: the origin-rooted bridged-tick reader @regression @tier1', function(){

    it('splits a foreign-rooted tick into its origin and its native name', function(){
        const doge = utilFor('DOGE');
        assert.deepStrictEqual(doge.parseBridgedTick('BTC.PEPECASH'), { origin: 'BTC', name: 'PEPECASH' });
        assert.deepStrictEqual(doge.parseBridgedTick('LTC.FUFU'),     { origin: 'LTC', name: 'FUFU' });

        const btc = utilFor('BTC');
        assert.deepStrictEqual(btc.parseBridgedTick('DOGE.FUFU'), { origin: 'DOGE', name: 'FUFU' });
    });

    it('refuses a tick rooted at THIS chain: that is a local subasset, not a bridged row', function(){
        // `DOGE.FUFU` on DOGE is a subasset of the local reserved DOGE root. Parsing it as
        // bridged would let an XBRIDGE v4 burn debit the supply of a row nothing escrows.
        assert.strictEqual(utilFor('DOGE').parseBridgedTick('DOGE.FUFU'), null);
        assert.strictEqual(utilFor('BTC').parseBridgedTick('BTC.PEPECASH'), null);
        assert.strictEqual(utilFor('LTC').parseBridgedTick('LTC.THING'), null);
    });

    it('refuses a prefix that is not a supported coin', function(){
        const doge = utilFor('DOGE');
        assert.strictEqual(doge.parseBridgedTick('ETH.USDT'), null);
        assert.strictEqual(doge.parseBridgedTick('PEPE.CASH'), null);
        // A bare native name has no root at all.
        assert.strictEqual(doge.parseBridgedTick('PEPECASH'), null);
    });

    it('refuses more than one dot, so a subasset never mis-parses as bridged', function(){
        const doge = utilFor('DOGE');
        // The parent split takes everything before the LAST dot, so BTC.PEPE.CASH would
        // need a BTC.PEPE row the bridge never creates. Milestone 1 refuses it at lock
        // time (D15); here it simply is not a bridged tick.
        assert.strictEqual(doge.parseBridgedTick('BTC.PEPE.CASH'), null);
        assert.strictEqual(doge.parseBridgedTick('BTC.A.B.C'), null);
    });

    it('refuses an empty name and an empty root', function(){
        const doge = utilFor('DOGE');
        assert.strictEqual(doge.parseBridgedTick('BTC.'), null, 'MIN_TICK_LENGTH is 1, so BTC. is no token');
        assert.strictEqual(doge.parseBridgedTick('.PEPECASH'), null);
        assert.strictEqual(doge.parseBridgedTick('.'), null);
    });

    it('folds the root case and returns the canonical upper-case origin', function(){
        // Every ticker lookup is LOWER(tick), so these all reach one row and must reach
        // one verdict. The origin comes back canonical because callers compare it against
        // COINS and build ADDRESS.BRIDGE_<ORIGIN> from it.
        const doge = utilFor('DOGE');
        assert.deepStrictEqual(doge.parseBridgedTick('btc.pepecash'), { origin: 'BTC', name: 'pepecash' });
        assert.deepStrictEqual(doge.parseBridgedTick('Btc.PepeCash'), { origin: 'BTC', name: 'PepeCash' });
        // The local-coin refusal folds case too, or `doge.FUFU` would escape it on DOGE.
        assert.strictEqual(doge.parseBridgedTick('doge.FUFU'), null);
    });

    it('returns the name verbatim, because that is the string the row is looked up by', function(){
        assert.deepStrictEqual(utilFor('DOGE').parseBridgedTick('BTC.pEpE'), { origin: 'BTC', name: 'pEpE' });
    });

    it('takes an explicit local coin, the isCryptoAddress convention', function(){
        // A reader working on behalf of another chain (an explorer panel, a mirror check)
        // passes that chain's coin rather than re-instantiating Utility.
        const doge = utilFor('DOGE');
        assert.strictEqual(doge.parseBridgedTick('BTC.PEPECASH', 'BTC'), null, 'BTC-rooted is local when the caller is BTC');
        assert.deepStrictEqual(doge.parseBridgedTick('DOGE.FUFU', 'BTC'), { origin: 'DOGE', name: 'FUFU' });
        assert.deepStrictEqual(doge.parseBridgedTick('DOGE.FUFU', 'btc'), { origin: 'DOGE', name: 'FUFU' }, 'the caller-supplied coin folds case too');
    });

    it('refuses null, undefined and a non-string without throwing', function(){
        const doge = utilFor('DOGE');
        assert.strictEqual(doge.parseBridgedTick(null), null);
        assert.strictEqual(doge.parseBridgedTick(undefined), null);
        assert.strictEqual(doge.parseBridgedTick(''), null);
        assert.strictEqual(doge.parseBridgedTick(12345), null);
    });

});
