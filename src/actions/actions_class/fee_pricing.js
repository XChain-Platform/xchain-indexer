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

// The zero-fee answer priceFeeQuote returns when there is no protocol fee to price.
function zeroFeeQuote(base){
    return Object.assign(base, {
        valid: true, error: null, oracleRound: 0,
        requiredFeeNative: '0.00000000', requiredFeeSats: 0,
        expectedNative: '0.00000000', minAcceptable: '0.00000000', maxAcceptable: '0.00000000'
    });
}

// If the caller supplied a proposed output, judge it against the SAME lower-bound rule
// the on-chain validator enforces (validateNativeCoinFee rejects only below min).
function judgeFeeOutput(util, feeOutputSats, band){
    let valid = true, error = null;
    if(feeOutputSats !== undefined && feeOutputSats !== null && String(feeOutputSats) !== ''){
        let paidCoin = util.bcdiv(util.bcnum(feeOutputSats), 100000000, 8);
        if(util.bclt(paidCoin, band.minAcceptable)){
            valid = false;
            error = 'native fee output too small (provided: ' + util.bcformat(paidCoin, 8) +
                    ', min: ' + util.bcformat(band.minAcceptable, 8) + ')';
        }
    }
    return { valid, error };
}

module.exports = {

    // Price an XCHAIN-denominated fee in the native coin via current oracle prices, and
    // (optionally) judge a proposed fee-output amount against the same lower-bound rule the
    // on-chain validator enforces (util.validateNativeCoinFee rejects only below min). Pure
    // pricing, shared by computeFeeQuote and computeFeeQuoteDryRun; extends and returns `base`.
    async priceFeeQuote(base, xchainFeeRaw, feeOutputSats){
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
        let maxPriceAgeSeconds = parseInt(this.config['ORACLE_MAX_PRICE_AGE_SECONDS']) || 1800;
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

        let band = this.util.computeNativeFeeBand(xchainFee, prices.xchainUsdPrice, prices.coinUsdPrice, toleranceMin, toleranceMax);

        // Recommended output (what the client should pay). Satoshi rounding is dwarfed by the
        // tolerance band, so plain 8-dp formatting is safe (only under-MIN risks forfeiture).
        let requiredFeeNative = this.util.bcformat(band.expectedNative, 8);
        let requiredFeeSats   = Number(this.util.bcformat(this.util.bcmul(band.expectedNative, 100000000, 0), 0));

        let { valid, error } = judgeFeeOutput(this.util, feeOutputSats, band);

        return Object.assign(base, {
            valid:             valid,
            error:             error,
            oracleRound:       prices.oracleRound,
            xchainUsdPrice:    this.util.bcformat(prices.xchainUsdPrice, 8),
            coinUsdPrice:      this.util.bcformat(prices.coinUsdPrice, 8),
            expectedNative:    requiredFeeNative,
            minAcceptable:     this.util.bcformat(band.minAcceptable, 8),
            maxAcceptable:     this.util.bcformat(band.maxAcceptable, 8),
            requiredFeeNative: requiredFeeNative,
            requiredFeeSats:   requiredFeeSats
        });
    },

    // True when this chain has no XCHAIN fee lane, so a protocol fee can ONLY be paid with a
    // native-coin output. Mirrors the runtime rule in utility.detectFeePaymentMode (BTC falls
    // back to an XCHAIN balance debit when no fee output is present; every other coin rejects).
    // Message-shaping only: nothing consensus-bearing reads this.
    nativeFeeMandatory(){
        let feeDestination = this.config['ADDRESS'] ? this.config['ADDRESS']['FEE_DESTINATION'] : null;
        if(!feeDestination || feeDestination === 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX') return false;
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
    //   EXECUTE        - EXECUTE base (execute.js; metered gas re-prices only the record)
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
