'use strict';

const { coinQualifierRoot } = require('../consensus/list_tick_coin.js');

const TICK_COIN_PREFIX_REFUSAL = 'invalid: TICK (reserved)';

function tickCoinPrefixNeedsProbe({ tick, isGenesis, isTopLevel, coins }){
    if(isGenesis || isTopLevel !== true) return false;

    let text = String(tick);
    return !text.startsWith('^') && coinQualifierRoot(text, coins) !== null;
}

module.exports = {
    TICK_COIN_PREFIX_REFUSAL,
    tickCoinPrefixNeedsProbe,
};
