'use strict';

const COINS       = ['BTC', 'LTC', 'DOGE', 'TBTC', 'TLTC', 'TDOGE'];
const VALUE_FLOOR = 19;
const FEE_FLOOR   = 20;

function count(chain, coin, key) {
    const v = chain[key];
    if (!Number.isInteger(v) || v < 0) {
        throw new Error(`${coin}.${key} must be a non-negative integer`);
    }
    return v;
}

// Only canonical lengths raise a cap: a zero-padded value is refused by the
// canonical pattern, so longest_valid_* is deliberately ignored.
function priceV1Caps(measurement) {
    const chains = measurement && measurement.chains;
    let value = VALUE_FLOOR;
    let fee   = FEE_FLOOR;
    for (const coin of COINS) {
        const chain = chains && chains[coin];
        if (!chain || typeof chain !== 'object') throw new Error(`missing chain ${coin}`);
        value = Math.max(value, count(chain, coin, 'longest_canonical_value'));
        fee   = Math.max(fee, count(chain, coin, 'longest_canonical_fee'));
    }
    return { value, fee };
}

module.exports = { priceV1Caps };
