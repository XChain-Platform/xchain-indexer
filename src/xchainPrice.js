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
 *
 * XCHAIN price derivation from platform-realized fills 
 *
 * XCHAIN cannot be priced by the hub's exchange feeds: it is listed nowhere, its
 * supply is 0 and its mint is disabled. But every native-coin protocol fee needs
 * an XCHAIN/USD price (utility.getFeeOraclePrices requires it alongside
 * <COIN>/USD), so without one, fee-bearing actions on LTC and DOGE are unpayable.
 *
 * This module derives XCHAIN/BTC from the only places XCHAIN actually changes
 * hands: DEX fills (order_matches) and dispenses. The USD leg is applied by the
 * caller from the federation's own BTC/USD in the same round.
 *
 * Spec: claude/specs/XCHAIN_PRICE_DERIVATION_SPEC.md (§4 formula, §5 threat model)
 *
 * PURE. No DB, no clock, no config. The caller selects the fill set for a window
 * anchored to the round's BTC reference height (with the §4 confirmation buffer,
 * so reorg-mutable fills are excluded); this file only does arithmetic, so it is
 * exactly reproducible on every node given the same inputs. That is the whole
 * point: unlike an exchange quote, an on-chain fill set is identical for every
 * validator.
 *
 * ROUNDING IS A CONSENSUS PARAMETER. Every helper used here is the indexer's own
 * bcmath, which rounds HALF-UP (verified: bcdiv('2','3',8) = 0.66666667, and
 * 0.000000025 formats to 0.00000003). It is NOT half-even. A second
 * implementation that assumed banker's rounding would disagree at exactly the
 * .5 boundary, which for a fee input is a fork, so the mode is stated here and
 * pinned by test rather than left to the reader.
 *
 ********************************************************************/

'use strict';

// Winsorization band around the reference rate, as a multiplicative factor. A
// fill's rate is clamped into [ref/B, ref*B] before it is weighed. B = 2 is
// log-symmetric (half to double) and is the recommended default pending the
// spec's D4 sign-off on the final constants.
const WINSOR_BAND_FACTOR = '2';

// Working precision for rates. The published price is 8dp (satoshi); rates are
// carried at 18dp so a chain of them is not biased by mid-computation truncation,
// matching computeNativeFeeBand's discipline in utility.js.
const RATE_PRECISION = 18;
const PRICE_PRECISION = 8;

// A fill is usable only when BOTH sides are strictly positive. A zero XCHAIN side
// would make the rate infinite; a zero coin side is a giveaway whose rate is 0.
// Neither is a price, and both are trivially cheap to manufacture, so they are
// dropped before anything else looks at them. (Winsorization would clamp such a
// fill to a band edge and still let its weight count, which is the opposite of
// what we want for a record that carries no price information at all.)
function isUsableFill(util, fill) {
    if (!fill) return false;
    let x = fill.xchainAmount;
    let c = fill.coinAmount;
    if (x === undefined || x === null || c === undefined || c === null) return false;
    try {
        return util.bcgt(x, '0') && util.bcgt(c, '0');
    } catch (e) {
        return false;   // unparseable amount: not a fill we can price
    }
}

/**
 * Derive the XCHAIN/BTC rate from a set of realized fills.
 *
 * @param {object} util    an xchain-indexer Utility instance (bcmath helpers)
 * @param {Array}  fills   [{ xchainAmount, coinAmount, ... }] for the caller's
 *                         window. Amounts are decimal strings. Extra fields
 *                         (venue, actionIndex, blockIndex) are ignored here and
 *                         exist for the caller's own logging.
 * @param {string} refRate the last finalized XCHAIN/BTC rate, which anchors the
 *                         winsorization band. REQUIRED: see the null note below.
 * @param {object} [opts]  { bandFactor } to override the band.
 * @returns {object|null}  null when no usable fill survives or no reference is
 *   available (the caller then holds the previous value or the bootstrap).
 *   Otherwise { rate, usedCount, clampedCount, droppedCount, totalXchain,
 *   refRate, lower, upper } with `rate` an 8dp decimal string: BTC per XCHAIN.
 */
function deriveXchainRate(util, fills, refRate, opts = {}) {
    if (!Array.isArray(fills) || fills.length === 0) return null;

    // No reference means nothing anchors the band, and an unanchored average of a
    // thin market is precisely the shape an attacker can set to anything (§5: a
    // self-dispense of a huge amount for one satoshi has maximal weight at
    // near-zero cost). Fail closed to the caller's bootstrap instead. In practice
    // a reference always exists: the bootstrap price supplies it for the first
    // derived round, and the move clamp applies to that first print like any other.
    if (!refRate) return null;
    try {
        if (!util.bcgt(refRate, '0')) return null;
    } catch (e) {
        return null;
    }

    let band  = opts.bandFactor || WINSOR_BAND_FACTOR;
    let lower = util.bcdiv(refRate, band, RATE_PRECISION);
    let upper = util.bcmul(refRate, band, RATE_PRECISION);

    let usable = fills.filter((f) => isUsableFill(util, f));
    let droppedCount = fills.length - usable.length;
    if (usable.length === 0) return null;

    // Winsorized volume-weighted average:
    //
    //     sum(wrate(f) * xchain(f)) / sum(xchain(f))
    //
    // For a fill INSIDE the band, wrate(f) * xchain(f) is exactly coin(f), because
    // wrate(f) = coin(f)/xchain(f). So an in-band fill contributes its coin amount
    // with NO division and therefore no per-fill rounding at all. Only a clamped
    // fill needs a multiply, and there the band edge is the intended value rather
    // than the fill's own. This keeps the common path exact, which is what makes
    // the result bit-identical across nodes rather than merely close.
    //
    // (The unwinsorized identity sum(coin)/sum(xchain) does NOT hold once any fill
    // is clamped, which is the price of the §5 defence and is worth paying.)
    let totalXchain = '0';
    let numerator   = '0';
    let clampedCount = 0;

    for (let f of usable) {
        let rate = util.bcdiv(f.coinAmount, f.xchainAmount, RATE_PRECISION);
        let contribution;
        if (util.bclt(rate, lower)) {
            contribution = util.bcmul(lower, f.xchainAmount, RATE_PRECISION);
            clampedCount++;
        } else if (util.bcgt(rate, upper)) {
            contribution = util.bcmul(upper, f.xchainAmount, RATE_PRECISION);
            clampedCount++;
        } else {
            contribution = f.coinAmount;    // exact, no division
        }
        numerator   = util.bcadd(numerator, contribution, RATE_PRECISION);
        totalXchain = util.bcadd(totalXchain, f.xchainAmount, RATE_PRECISION);
    }

    if (!util.bcgt(totalXchain, '0')) return null;

    let rate = util.bcdiv(numerator, totalXchain, PRICE_PRECISION);
    if (!util.bcgt(rate, '0')) return null;   // rounded away to zero: not a usable price

    return {
        rate:         util.bcformat(rate, PRICE_PRECISION),
        usedCount:    usable.length,
        clampedCount: clampedCount,
        droppedCount: droppedCount,
        totalXchain:  util.bcformat(totalXchain, PRICE_PRECISION),
        refRate:      util.bcformat(refRate, PRICE_PRECISION),
        lower:        util.bcformat(lower, PRICE_PRECISION),
        upper:        util.bcformat(upper, PRICE_PRECISION),
    };
}

/**
 * Convert a published XCHAIN/USD back into XCHAIN/BTC terms, which is what the
 * winsorization band is applied in (§4: "the same BTC/USD converts the last
 * finalized price into the winsorization reference, so the band is applied in the
 * units the fills are quoted in").
 *
 * @returns {string|null} 18dp XCHAIN/BTC, or null if either input is unusable.
 */
function referenceRateFromUsd(util, lastXchainUsd, btcUsdPrice) {
    if (!lastXchainUsd || !btcUsdPrice) return null;
    try {
        if (!util.bcgt(lastXchainUsd, '0') || !util.bcgt(btcUsdPrice, '0')) return null;
        return util.bcdiv(lastXchainUsd, btcUsdPrice, RATE_PRECISION);
    } catch (e) {
        return null;
    }
}

/**
 * Apply the USD leg. Kept separate so the on-chain half stays independently
 * testable and so the caller supplies BTC/USD from the round it is already
 * building.
 *
 * @returns {string|null} 8dp XCHAIN/USD, or null if either input is unusable.
 */
function toUsd(util, xchainBtcRate, btcUsdPrice) {
    if (!xchainBtcRate || !btcUsdPrice) return null;
    try {
        if (!util.bcgt(xchainBtcRate, '0') || !util.bcgt(btcUsdPrice, '0')) return null;
        return util.bcformat(util.bcmul(xchainBtcRate, btcUsdPrice, PRICE_PRECISION), PRICE_PRECISION);
    } catch (e) {
        return null;
    }
}

module.exports = {
    deriveXchainRate,
    referenceRateFromUsd,
    toUsd,
    WINSOR_BAND_FACTOR,
    RATE_PRECISION,
    PRICE_PRECISION,
};
