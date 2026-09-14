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
 *
 * XChain Indexer - Utility: native coin fee
 *
 * The native coin fee band, the two oracle prices it is valued against, and the
 * consensus check of a transaction's fee output.
 *
 ********************************************************************/

'use strict';

const protocolChanges = require('../protocol_changes.js');
const { getLogger } = require('../observability/index.js');
const { CONFIG_ENV } = require('../config.js');
const { findFeeOutput } = require('./fee_output.js');

// Batch-cumulative native-fee accounting (BATCH_ISSUANCE_LIMITS).
//
// TX_OUTPUTS is TRANSACTION-level state that the batch loop preserves across every
// sub-command, and nothing decrements it. So before this, each sub-command judged the
// SAME untouched fee output from zero: a batch of 100 ORDERs paid one ORDER's fee.
// batch.js seeds data['BATCH_VALUE_LEDGER'] (only when the flag is active, and only
// before its baseKeys snapshot so the per-command field clear preserves it); this is
// where the native-fee half of that tally is read, and drawNativeFeeOutput below is where
// it is written.
//
// The key's ABSENCE is both the flag gate and the not-a-batch case: with no ledger
// every line below collapses to the pre-existing behavior, which is exactly what a
// non-BATCH transaction and a pre-flag-day BATCH must still see, byte for byte.
//
// data['FEE_PROBE'] marks the read-only public feequote path. A probe must never read
// or write the ledger: it is a dry run over a synthetic transaction, and letting the
// public quote API mutate consensus state is the sharpest edge here.
function nativeFeeLedger(data){
    return (!data['FEE_PROBE'] && data['BATCH_VALUE_LEDGER'] && typeof data['BATCH_VALUE_LEDGER'] === 'object')
               ? data['BATCH_VALUE_LEDGER'] : null;
}

// Judge what is left of the fee output against the band and, inside a BATCH, draw this
// command's share of the pool. The tail of validateNativeCoinFee, which calls it once the
// output, the oracle prices and the band are all in hand; returns that method's verdict.
function drawNativeFeeOutput(util, ledger, available, paidAmount, band, prices, coin){
    // `available` is `paidAmount` verbatim when no ledger is in play, so the error text
    // is unchanged off the batch path; mid-batch it reports what is actually left rather
    // than the full output, which no longer belongs to this command alone.
    if(util.bclt(available, band.minAcceptable)){
        return { valid: false, error: 'insufficient native coin fee (paid: ' + util.bcformat(available, 8) +
            ', expected: ' + util.bcformat(band.expectedNative, 8) + ', min: ' + util.bcformat(band.minAcceptable, 8) + ')' };
    }

    // Attribute at most ONE command's expected fee to this command and drain the pool by
    // that much. Draining at band.minAcceptable would compound the per-command 0.95x
    // tolerance across the batch: a batch paying N commands' worth would validate ~1.05N
    // commands. Draining at expectedNative makes N commands' worth cover exactly N.
    // Ledger values stay decimal STRINGS at 8dp, accumulated with bcadd, never JS numbers.
    let attributed = paidAmount;
    if(ledger){
        attributed = util.bclt(available, band.expectedNative) ? available : band.expectedNative;
        ledger['nativeFeeConsumed'] = util.bcformat(util.bcadd(ledger['nativeFeeConsumed'], attributed, 8), 8);
    }

    return {
        valid:            true,
        nativeCoinAmount: util.bcformat(attributed, 8),
        nativeCoin:       coin,
        oracleRound:      prices.oracleRound,
        expectedAmount:   util.bcformat(band.expectedNative, 8)
    };
}

// Installed onto Utility.prototype by ../utility.js, non-enumerable; each method runs with
// `this` bound to the Utility instance, exactly as the class method it was.
module.exports = {

    // Pure native-coin fee math, shared by validateNativeCoinFee (the on-chain consensus
    // check) and the read-only feequote pre-flight (Actions.computeFeeQuote). Keeping the
    // arithmetic in one place guarantees a client's output sizing and the validator's
    // acceptance test use identical numbers. USD intermediates are carried at 18-decimal
    // precision so the final native amount isn't biased by mid-computation truncation;
    // native-coin outputs are reported at satoshi (8-decimal) precision.
    // Returns { feeUsd, expectedNative, minAcceptable, maxAcceptable } (all bignumbers).
    computeNativeFeeBand(xchainAmount, xchainUsdPrice, coinUsdPrice, toleranceMin, toleranceMax){
        let feeUsd         = this.bcmul(xchainAmount, xchainUsdPrice, 18);
        let expectedNative = this.bcdiv(feeUsd, coinUsdPrice, 18);
        let minAcceptable  = this.bcmul(expectedNative, toleranceMin, 8);
        let maxAcceptable  = this.bcmul(expectedNative, toleranceMax, 8);
        return { feeUsd, expectedNative, minAcceptable, maxAcceptable };
    },

    // Fetch + validate the two oracle prices a native-coin fee is valued against
    // (COIN/USD and XCHAIN/USD), gated by blockIndex so two nodes see the same price and
    // rejected when staler than maxAgeSeconds relative to refTime. Prefers the local hub DB
    // (where price_snapshots is synced from xchain-hub) when available. Shared by
    // validateNativeCoinFee and computeFeeQuote.
    // Returns { coinUsdPrice, xchainUsdPrice, oracleRound } on success, or { error } on
    // a missing/stale/invalid price.
    // `refTime` anchors ALL THREE time-sensitive decisions here (round selection on non-BTC
    // chains, the staleness guard, and the NATIVE_FEE_PRICE_TIME_GATE flag-day predicate), and
    // every caller must pass a CHAIN-derived time: the consensus caller passes the evaluated
    // block's BLOCK_TIME, the read-only feequote/feeschedule pre-flights pass the quoted (tip)
    // block's time. Anchoring one of those decisions on the operator's wall clock while the
    // chain anchors on block time is a real hazard: it makes a pre-flight disagree with the
    // very check it exists to predict.
    async getFeeOraclePrices(db, coin, blockIndex, refTime, maxAgeSeconds){
        let priceDb;
        if(db.indexer && db.indexer.hubDb){
            priceDb = db.indexer.hubDb;
        } else {
            // No hub DB connection configured; price_snapshots / oracle_prices are read from
            // the indexer's own database instead. This is the intended single-host setup (the
            // local DB holds the synced hub copy). In a distributed deployment it almost always
            // means HUB_DB_HOST / HUB_DB_NAME are unset or misconfigured, in which case fee
            // validation and FIAT settlement run against stale or empty local price data with
            // no error. On mainnet this path only runs when the operator explicitly set
            // INDEXER_ALLOW_LOCAL_PRICE_SOURCE=true (startup otherwise fails closed; see
            // XChainIndexer.start); on testnet/regtest it is the normal single-host case. Warn
            // once so a misconfiguration is still visible in logs.
            priceDb = db;
            if(!this._hubDbFallbackWarned){
                this._hubDbFallbackWarned = true;
                getLogger().warn('WARNING: getFeeOraclePrices: no hub DB configured (HUB_DB_HOST/HUB_DB_NAME unset); ' +
                    'falling back to the local indexer DB for price_snapshots/oracle_prices. ' +
                    'Expected for single-host deployments; on a distributed node this means price data may be ' +
                    'stale or absent. Set HUB_DB_HOST/HUB_DB_NAME, or INDEXER_ALLOW_LOCAL_PRICE_SOURCE=true to ' +
                    'acknowledge an intentional single-host node.');
            }
        }
        // NATIVE_FEE_PRICE_TIME_GATE: price rounds are anchored to BTC
        // heights, so getLatestPrice's reference_block gate only pins a round
        // deterministically on the reference chain itself. On every other chain
        // the gate is vacuous against the local height, so at/after the
        // flag-day selection switches to the round's consensus timestamp vs
        // this block's time (deterministic across nodes and on replay). The
        // block loop enforces the matching time-keyed price barrier
        // (XChainIndexer/hub_db_sync), gated by the SAME shared predicate.
        let network      = this.config['NETWORK'] || CONFIG_ENV.INDEXER_NETWORK;
        // One chain-derived anchor drives the gate, the selection and the staleness guard.
        let selectByTime = (coin !== 'BTC') &&
            protocolChanges.isNativeFeePriceTimeGateActive(network, refTime);
        let opts = { blockTime: refTime, maxAgeSeconds: maxAgeSeconds, selectByTime: selectByTime };

        let coinPriceData = await priceDb.getLatestPrice(coin + '/USD', blockIndex, opts);
        if(!coinPriceData || !coinPriceData.price)
            return { error: 'no current oracle price for ' + coin + '/USD (missing or stale beyond ' + maxAgeSeconds + 's)' };
        let coinUsdPrice = this.bcnum(coinPriceData.price);
        if(this.bclte(coinUsdPrice, 0))
            return { error: 'invalid oracle price for ' + coin + '/USD' };

        let xchainPriceData = await priceDb.getLatestPrice('XCHAIN/USD', blockIndex, opts);
        if(!xchainPriceData || !xchainPriceData.price)
            return { error: 'no current oracle price for XCHAIN/USD (missing or stale beyond ' + maxAgeSeconds + 's)' };
        let xchainUsdPrice = this.bcnum(xchainPriceData.price);
        if(this.bclte(xchainUsdPrice, 0))
            return { error: 'invalid oracle price for XCHAIN/USD' };

        return {
            coinUsdPrice:   coinUsdPrice,
            xchainUsdPrice: xchainUsdPrice,
            oracleRound:    coinPriceData.roundNumber
        };
    },

    // Validate a native coin fee output against oracle price
    // db parameter accepts the indexer DB or hub DB connection; if a hubDb is available
    // on the action context, callers should prefer it (price_snapshots lives in the local hub DB).
    // Returns: { valid, nativeCoinAmount, oracleRound, error }
    async validateNativeCoinFee(data, fees, db, txOutputs){
        let feeDestination = this.config['ADDRESS']['FEE_DESTINATION'];
        let toleranceMin = this.bcnum(this.config['FEE_TOLERANCE_MIN'] || '0.95');
        let toleranceMax = this.bcnum(this.config['FEE_TOLERANCE_MAX'] || '1.10');

        // Find the fee output
        let feeOutput = findFeeOutput(txOutputs, feeDestination);

        if(!feeOutput){
            return { valid: false, error: 'no fee output to FEE_DESTINATION' };
        }

        let paidAmount = this.bcnum(feeOutput.value || feeOutput.amount || 0);
        if(this.bclte(paidAmount, 0)){
            return { valid: false, error: 'fee output has zero value' };
        }

        // Get the XCHAIN fee amount (already calculated by the action handler)
        let xchainAmount = this.bcnum(fees['AMOUNT']);
        if(this.bclte(xchainAmount, 0)){
            // No fee required; accept. A command that owes nothing spends none of the
            // batch fee pool, so this path deliberately reads and writes no ledger, and
            // it stays ABOVE the pool check below: a zero-fee sub-command must not be
            // invalidated because earlier siblings spent the fee output.
            return { valid: true, nativeCoinAmount: '0', oracleRound: 0 };
        }

        // The batch fee pool when this command runs inside a BATCH, else null (nativeFeeLedger).
        let ledger    = nativeFeeLedger(data);
        let available = ledger ? this.bcsub(paidAmount, ledger['nativeFeeConsumed'], 8) : paidAmount;
        if(ledger && this.bclte(available, 0)){
            // Earlier sub-commands spent the whole fee output: to this command the pool
            // looks exactly like an unpaid fee output, and reports itself as one.
            return { valid: false, error: 'fee output has zero value' };
        }

        // Get oracle prices: XCHAIN/USD and COIN/USD.
        // Gate by BLOCK_INDEX so two nodes processing the same block see the same price, and
        // reject silently stale prices against the block's own timestamp (deterministic during
        // consensus replay); see db.getLatestPrice and getFeeOraclePrices.
        let coin = this.config['COIN'] || data['COIN'];
        let maxPriceAgeSeconds = parseInt(this.config['ORACLE_MAX_PRICE_AGE_SECONDS']) || 1800;
        let prices = await this.getFeeOraclePrices(db, coin, data['BLOCK_INDEX'], data['BLOCK_TIME'], maxPriceAgeSeconds);
        if(prices.error){
            return { valid: false, error: prices.error };
        }

        let band = this.computeNativeFeeBand(xchainAmount, prices.xchainUsdPrice, prices.coinUsdPrice, toleranceMin, toleranceMax);
        return drawNativeFeeOutput(this, ledger, available, paidAmount, band, prices, coin);
    }
};
