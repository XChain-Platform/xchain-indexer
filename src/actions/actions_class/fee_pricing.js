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
 * XChain Indexer - Actions class: native-coin fee pricing
 *
 * priceFeeQuote, nativeFeeMandatory, decodeDeployCodeBytes and staticProtocolFee, mixed
 * into Actions.prototype by actions/index.js. Pure pricing and the gas-schedule-only fee
 * for DEPLOY/EXECUTE; nothing here runs a handler or holds the transaction mutex.
 *
 ********************************************************************/

const deploy = require('../deploy/index.js');
const { maxPriceAgeSecondsAt } = require('../../utility/price_age/oracle_price_age.js');
const { usableFeeDestination } = require('../../config/fee_destination.js');

// The zero-fee answer priceFeeQuote returns when there is no protocol fee to price.
function zeroFeeQuote(base){
    return Object.assign(base, {
        valid: true, error: null, oracleRound: 0,
        requiredFeeNative: '0.00000000', requiredFeeSats: 0, requiredFeeSatsExact: '0',
        expectedNative: '0.00000000', minAcceptable: '0.00000000', maxAcceptable: '0.00000000'
    });
}

// A non-BATCH multi-leg AIRDROP past its tally gate pays every leg from ONE output through an
// action NATIVE_FEE_LEDGER: each leg in order judges what earlier legs left against its OWN
// band, then drains at most its expected fee (validateNativeCoinFee, drawNativeFeeOutput). One
// band over the summed fee applies the tolerance once and passes outputs a later leg refuses,
// so the quote replays that draw. The 1-based leg the chain refuses first, or 0.
function firstRefusedLeg(util, paidCoin, legBands){
    let consumed = '0';
    for(let i = 0; i < legBands.length; i++){
        let band = legBands[i];
        let available = util.bcsub(paidCoin, consumed, 8);
        if(util.bclte(available, 0) || util.bclt(available, band.minAcceptable)) return i + 1;
        let attributed = util.bclt(available, band.expectedNative) ? available : band.expectedNative;
        consumed = util.bcformat(util.bcadd(consumed, attributed, 8), 8);
    }
    return 0;
}

// The least output every leg of that draw accepts: the most, over legs, of what the legs before
// it drain (accumulated as the ledger does) plus its own minimum. The chain refuses an emptied
// output outright, so a leg whose minimum rounds to zero still needs one satoshi left.
function inOrderMinimum(util, legBands){
    let consumed = '0', minimum = util.bcnum(0);
    for(let band of legBands){
        let floor = util.bcgt(band.minAcceptable, 0) ? band.minAcceptable : '0.00000001';
        let legMinimum = util.bcadd(consumed, floor, 8);
        if(util.bcgt(legMinimum, minimum)) minimum = legMinimum;
        consumed = util.bcformat(util.bcadd(consumed, band.expectedNative, 8), 8);
    }
    return minimum;
}

// The bands of the AIRDROP legs the probe disclosed that owe a fee, or null when fewer than two
// do: a zero-fee leg draws nothing on chain, and a single charged leg is the summed band itself.
function chargedLegBands(util, nativeFeeLegs, bandOf){
    if(!Array.isArray(nativeFeeLegs)) return null;
    let bands = nativeFeeLegs.filter((fee) => util.bcgt(fee, 0)).map(bandOf);
    return bands.length > 1 ? bands : null;
}

// If the caller supplied a proposed output, judge it against the SAME lower-bound rule the
// on-chain validator enforces: below min for one band, the in-order draw for charged AIRDROP
// legs. Also returns minAcceptable, the least output that rule accepts.
function judgeFeeOutput(util, feeOutputSats, band, legBands){
    let minAcceptable = legBands ? inOrderMinimum(util, legBands) : band.minAcceptable;
    let valid = true, error = null;
    if(feeOutputSats !== undefined && feeOutputSats !== null && String(feeOutputSats) !== ''){
        let paidCoin = util.bcdiv(util.bcnum(feeOutputSats), 100000000, 8);
        let refusedLeg = legBands ? firstRefusedLeg(util, paidCoin, legBands) : 0;
        if(legBands ? refusedLeg : util.bclt(paidCoin, minAcceptable)){
            valid = false;
            error = 'native fee output too small (provided: ' + util.bcformat(paidCoin, 8) +
                    ', min: ' + util.bcformat(minAcceptable, 8) +
                    (refusedLeg ? ', AIRDROP leg ' + refusedLeg + ' of ' + legBands.length + ' refused' : '') + ')';
        }
    }
    return { valid, error, minAcceptable };
}

// The recommended output: the summed band's expected fee, raised to the in-order minimum on the
// rare multi-leg quote where per-leg rounding lifts that minimum above it.
function recommendedOutput(util, band, minAcceptable){
    let native = util.bclt(band.expectedNative, minAcceptable) ? minAcceptable : band.expectedNative;
    return { native: util.bcformat(native, 8), satsExact: util.bcformat(util.bcmul(native, 100000000, 0), 0) };
}

module.exports = {

    // Price an XCHAIN-denominated fee in the native coin via current oracle prices, and
    // (optionally) judge a proposed fee-output amount against the same lower-bound rule the
    // on-chain validator enforces (judgeFeeOutput). `nativeFeeLegs` (optional) is the dry run's
    // per-leg AIRDROP fee disclosure. Pure pricing, shared by computeFeeQuote and
    // computeFeeQuoteDryRun; extends and returns `base`.
    async priceFeeQuote(base, xchainFeeRaw, feeOutputSats, nativeFeeLegs){
        let coin         = this.config['COIN'];
        let toleranceMin = this.util.bcnum(this.config['FEE_TOLERANCE_MIN'] || '0.95');
        let toleranceMax = this.util.bcnum(this.config['FEE_TOLERANCE_MAX'] || '1.10');

        let xchainFee  = this.util.bcnum(xchainFeeRaw == null ? '0' : xchainFeeRaw);
        base.xchainFee = this.util.bcformat(xchainFee, 8);

        // No protocol fee => nothing to pay in native coin.
        if(this.util.bclte(xchainFee, 0)){
            return zeroFeeQuote(base);
        }

        // Value it in native coin via current oracle prices (shared with validateNativeCoinFee).
        let blockIndex         = (base.blockIndex !== undefined && base.blockIndex !== null)
                               ? base.blockIndex : await this.indexerDb.getLatestBlockIndex();
        let maxPriceAgeSeconds = maxPriceAgeSecondsAt(
            this.config, this.config['NETWORK'], coin, blockIndex);
        // Anchor the WHOLE price read (round selection, staleness, flag-day gate) on the
        // quoted block's own time, because that is the single quantity the on-chain check uses
        // (validateNativeCoinFee passes BLOCK_TIME). A pre-flight anchored on the operator's wall
        // clock answers a different question from the chain and disagrees with it in both
        // directions: it calls a pair stale during a reference-chain block drought that the chain
        // would price off the round the next block carries, and on any venue whose chain clock
        // runs ahead of real time the non-BTC time-keyed selection (block_timestamp <= refTime)
        // excludes every round the chain can see, leaving LTC/DOGE quotes structurally dead.
        // Wall clock is the fallback only when the quote carries no usable block time at all.
        let chainTime          = Number(base.blockTime);
        let refTime            = Number.isFinite(chainTime) ? chainTime : Math.floor(Date.now() / 1000);
        let prices = await this.util.getFeeOraclePrices(this.indexerDb, coin, blockIndex, refTime, maxPriceAgeSeconds);
        if(prices.error)
            return Object.assign(base, { valid: false, error: prices.error });

        let bandOf = (fee) => this.util.computeNativeFeeBand(fee, prices.xchainUsdPrice, prices.coinUsdPrice, toleranceMin, toleranceMax);
        let band = bandOf(xchainFee);
        let { valid, error, minAcceptable } = judgeFeeOutput(this.util, feeOutputSats, band,
            chargedLegBands(this.util, nativeFeeLegs, bandOf));
        // Satoshi rounding is dwarfed by the tolerance band, so plain 8-dp formatting is safe.
        let required = recommendedOutput(this.util, band, minAcceptable);

        return Object.assign(base, {
            valid:             valid,
            error:             error,
            oracleRound:       prices.oracleRound,
            xchainUsdPrice:    this.util.bcformat(prices.xchainUsdPrice, 8),
            coinUsdPrice:      this.util.bcformat(prices.coinUsdPrice, 8),
            expectedNative:    this.util.bcformat(band.expectedNative, 8),
            minAcceptable:     this.util.bcformat(minAcceptable, 8),
            maxAcceptable:     this.util.bcformat(band.maxAcceptable, 8),
            requiredFeeNative: required.native,
            requiredFeeSats:   Number(required.satsExact),
            requiredFeeSatsExact: required.satsExact
        });
    },

    // True when this chain has no XCHAIN fee lane, so a protocol fee can ONLY be paid with a
    // native-coin output. Mirrors the runtime rule in utility.detectFeePaymentMode (BTC falls
    // back to an XCHAIN balance debit when no fee output is present; every other coin rejects).
    // test/unit/fees/fee_quote.test/native_fee_mode_parity.test.js fails when the two rules part.
    // Quote side only (the pre-flight's default fee mode and refusal wording): nothing
    // consensus-bearing reads this.
    nativeFeeMandatory(){
        if(!usableFeeDestination(this.config)) return false;
        return this.config['COIN'] !== 'BTC';
    },

    // Decode a DEPLOY's inline CODE_ENCODING to its UTF-8 source byte count, byte-identically to
    // deploy.js (same DEPLOY_BASE64_CODE flag-day gate, same canonical-base64 round-trip, same
    // lenient pre-activation hex). Only the SIZE is wanted, but the decode has to match exactly:
    // codeBytes is multiplied by VM_DEPLOY_PER_BYTE, so a decode that differs from the handler's
    // would quote a fee the chain does not accept. Returns { bytes } or { error } with the
    // handler's own verbatim reject string.
    async decodeDeployCodeBytes(encoded, blockIndex){
        if(this.util.isNull(encoded))
            return { error: 'invalid: CODE_ENCODING (required)' };
        // Bound the decode before doing it: this runs on an unauthenticated endpoint, and no
        // encoding of a legal contract is longer than hex's 2x of MAX_CODE_SIZE. Anything past
        // that is over the size cap whatever it decodes to, so reject it without the work.
        if(String(encoded).length > deploy.MAX_CODE_SIZE * 2)
            return { error: 'invalid: CODE_ENCODING (exceeds max size)' };
        let code = '';
        if(await this.protocolChanges.isEnabled('DEPLOY_BASE64_CODE', blockIndex)){
            try {
                let b64 = String(encoded);
                code = Buffer.from(b64, 'base64').toString('utf8');
                // Buffer.from is lenient; round-trip so non-canonical base64 rejects here the
                // same way it will on-chain instead of being quoted a fee it would forfeit.
                if(Buffer.from(code, 'utf8').toString('base64') !== b64)
                    return { error: 'invalid: CODE_ENCODING (base64 decode failed)' };
            } catch(e){
                return { error: 'invalid: CODE_ENCODING (base64 decode failed)' };
            }
        } else {
            try {
                code = Buffer.from(String(encoded), 'hex').toString('utf8');
            } catch(e){
                return { error: 'invalid: CODE_ENCODING (hex decode failed)' };
            }
        }
        let bytes = Buffer.byteLength(code, 'utf8');
        if(bytes > deploy.MAX_CODE_SIZE)
            return { error: 'invalid: CODE_ENCODING (exceeds max size)' };
        return { bytes: bytes };
    },

    // Gas-schedule-only price for a FEE_QUOTE_STATIC action: the XCHAIN-denominated
    // protocol fee the handler stages BEFORE it enters the VM, which is the amount
    // validateNativeCoinFee checks the native output against. Selects the handler's own
    // gas-cost family per DEPLOY format version, then prices it through util.vmGasCost:
    //   v0/v1 inline   - DEPLOY_INLINE  over decoded code bytes (deploy.js)
    //   v2/v3 chunked  - DEPLOY_CHUNKED, base only; the v4 carriers already paid per-byte (deploy.js)
    //   v4 carrier     - DEPLOY_CARRIER over the carried CODE_PART slice (deploy_chunk.js)
    //   EXECUTE        - EXECUTE base before its native-metered height gate. After the
    //                    gate, computeFeeQuote uses a dry-run estimate instead.
    // The arithmetic itself is NOT reproduced here: it is the single util.vmGasCost each of
    // those handlers calls, so a term added to one is added to this quote too.
    // Returns { gasCost, xchainFee }, { error } for an input the handler would reject outright,
    // or null when the action has no statically knowable fee.
    async staticProtocolFee(action, params, blockIndex){
        let schedule = this.config['GAS_SCHEDULE'] || {};
        let gasCost  = null;

        if(action === 'EXECUTE'){
            gasCost = this.util.vmGasCost(schedule, 'EXECUTE', 0);
        } else if(action === 'DEPLOY'){
            let format = this.util.getFormatVersion(params[0]);
            if(format === 0 || format === 1){
                let decoded = await this.decodeDeployCodeBytes(params[1], blockIndex);
                if(decoded.error) return { error: decoded.error };
                gasCost = this.util.vmGasCost(schedule, 'DEPLOY_INLINE', decoded.bytes);
            } else if(format === 2 || format === 3){
                gasCost = this.util.vmGasCost(schedule, 'DEPLOY_CHUNKED', 0);
            } else if(format === 4){
                // The carrier is billed on the base64 slice as carried, not on decoded bytes.
                gasCost = this.util.vmGasCost(schedule, 'DEPLOY_CARRIER',
                    Buffer.byteLength(String(params[4] == null ? '' : params[4]), 'utf8'));
            } else {
                return { error: 'invalid: VERSION (unknown)' };
            }
        }

        if(gasCost === null || !Number.isFinite(Number(gasCost)))
            return null;
        return { gasCost: gasCost, xchainFee: this.util.bcmul(gasCost, this.config['GAS_PRICE'], 8) };
    }
};
