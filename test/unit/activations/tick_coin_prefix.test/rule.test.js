// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');

const {
    TICK_COIN_PREFIX_REFUSAL,
    tickCoinPrefixNeedsProbe,
} = require('../../../../src/utility/list_tick/tick_coin_prefix_rule.js');

const COINS = ['BTC', 'LTC', 'DOGE'];

function needsProbe(tick, isGenesis = false, isTopLevel = true){
    return tickCoinPrefixNeedsProbe({ tick, isGenesis, isTopLevel, coins: COINS });
}

describe('ISSUE coin-prefix rule', function(){
    it('exports the reserved ticker refusal', function(){
        assert.strictEqual(TICK_COIN_PREFIX_REFUSAL, 'invalid: TICK (reserved)');
    });

    it('probes configured and reserved future coin roots', function(){
        for(let tick of ['BTC:FOO', 'doge:X', 'ETH:FOO'])
            assert.strictEqual(needsProbe(tick), true, tick);
    });

    it('does not probe suffixes, partial roots, empty roots or caret ticks', function(){
        for(let tick of ['FOO:BTC', 'BTCX:FOO', ':FOO', '^5'])
            assert.strictEqual(needsProbe(tick), false, tick);
    });

    it('does not probe genesis or non-top-level ticks', function(){
        assert.strictEqual(needsProbe('BTC:FOO', true, true), false);
        assert.strictEqual(needsProbe('BTC:FOO', false, false), false);
    });
});
