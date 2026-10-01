'use strict';

const assert = require('assert');

const {
    TICK_COIN_PREFIX_REFUSAL,
    tickCoinPrefixNeedsProbe,
} = require('../../../../src/utility/tick_coin_prefix_rule.js');

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
