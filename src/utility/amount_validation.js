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
 * XChain Indexer - Utility: amount and lock validation
 *
 * Consensus validation of amount, fiat and lock wire values, including the
 * amount-representability flag day.
 *
 ********************************************************************/

'use strict';

// The amount-representability flag day. Gates the isValidAmountFormat rule that an
// amount must denote the number the ledger credits, keyed on the processing block's
// consensus timestamp so historical replay below the threshold is byte-identical.
// Required here rather than taken from the entry: nothing purges it together with
// utility.js, so the require cache hands this part the same object the entry would.
const amountRepresentability = require('../amount_representability_activation.js');

// Installed onto Utility.prototype by ../utility.js, non-enumerable; each method runs with
// `this` bound to the Utility instance, exactly as the class method it was.
module.exports = {

    // Validate if a given value is considered valid
    // @value = string or integer or bignumber
    // @valid = string or array of values
    isValidValue(value, valid){
        let valueType = typeof value,
            validType = typeof valid;
        // Convert bignumber objects to their numeric value
        if(valueType=='object' && value !== null && typeof value.toNumber === 'function')
            value = value.toNumber();
        // Convert any numeric string values to integer value
        if(valueType=='string' && this.isNumeric(value))
            value = parseInt(value);
        // Convert a valid string to an array
        if(validType=='string')
            valid = [valid];
        // Only return true for valid values
        if(valid.indexOf(value)!=-1)
            return true;
        return false;
    },

    // Handle validating amount format
    // @param {decimals}  int              The tick's decimal precision
    // @param {amount}    string|number    The amount text as it arrived off the wire
    // @param {blockTime} int   OPTIONAL. The processing block's consensus timestamp
    //                          (data['BLOCK_TIME']). Supplying it opts the call into the
    //                          AMOUNT-REPRESENTABILITY gate below; omitting it keeps the
    //                          legacy text-shape behavior verbatim. Consensus call sites
    //                          MUST pass it. Non-consensus callers (the SDK's client-side
    //                          pre-checks, genesis distribution replay) deliberately do not.
    isValidAmountFormat(decimals, amount, blockTime){
        //<AMOUNT-REPRESENTABILITY> an amount must denote the number that will be
        // credited, not merely look like an amount. isNumeric() below accepts the whole
        // JavaScript number grammar, so '5e-19' passes at 18 decimals (its "fraction" is
        // the 4 characters 'e-19') and then bcadd credits 1e-18 - a DIFFERENT number from
        // the one that was validated - while '1e-1' passes on an indivisible tick and
        // credits 0, and a 43-digit integer passes but overflows the DECIMAL(60,18)
        // aggregation the supply sums cast to. Gated per chain on the block's consensus
        // timestamp (amount_representability_activation.js): below the threshold this is
        // inert and historical replay is byte-identical. Placed FIRST and as an early
        // return false so the gate can only ever reject more than the legacy body, never
        // accept more. NOT yet mirrored in xchain-sdk/src/utils/utility.js, on purpose: a client
        // stricter than consensus forks the acceptance set. See the module header.
        if(!this.isNull(blockTime) &&
           amountRepresentability.isAmountRepresentabilityActive(blockTime, this.config['NETWORK']) &&
           !amountRepresentability.isRepresentableAmount(decimals, this.safeToString(amount)))
            return false;
        //</AMOUNT-REPRESENTABILITY>
        // Reject objects that can't be safely converted to string
        if(amount !== null && amount !== undefined && typeof amount === 'object' && this.safeToString(amount) === null)
            return false;
        // Reject negative amounts
        if(String(amount).startsWith('-'))
            return false;
        // Determine divisibility and default to true
        let divisible   = (parseInt(decimals)==0) ? false : true;
        let parts       = String(amount).split('.');
        let [int, sats] = parts;
        //<MULTI-DOT-REJECT> reject an amount carrying more than one decimal
        // point. Destructuring keeps only the first two segments, so "1.2.3" reads as
        // int="1"/sats="2" and clears the divisible branch below, handing a non-numeric
        // string to the bignumber ledger math. The non-divisible branch already catches it
        // via its int==amount round trip; this guards the divisible one. Mirrored in
        // xchain-sdk/src/utils/utility.js (parity cases in the 15-sdk-parity integration suite).
        if(parts.length > 2)
            return false;
        //</MULTI-DOT-REJECT>
        if(!divisible && this.isNumeric(int) && int==amount)
            return true;
        //<FRACTIONAL-PRECISION-CAP> an amount must not carry more fractional
        // digits than the tick's decimals. The ledger normalizes to the tick precision at
        // write time (createLedgerChangeRecord -> bcadd(amount,0,decimals)), so accepting
        // finer precision here would store an unrounded action amount that diverges from the
        // rounded ledger row (a supply-reconciliation desync). Contract-EMITTED amounts are
        // pre-truncated to the tick decimals in execute.js processEmission before they reach
        // this validator, so this rejects only over-precise user/wire input. Mirrored in
        // xchain-sdk/src/utils/utility.js (parity test in test/unit/utility/utility.test.js).
        if(divisible && this.isNumeric(int) && (this.isNull(sats) || this.isNumeric(sats))){
            if(!this.isNull(sats) && String(sats).length > parseInt(decimals))
                return false;
            return true;
        }
        //</FRACTIONAL-PRECISION-CAP>
        return false;
    },

    // Validate a fiat amount format. Now equivalent to isValidAmountFormat (the precision
    // cap lives there now); kept as a named alias so existing callers and the
    // attest.js FEE_AMOUNT comment remain valid.
    isValidFiatFormat(decimals, amount, blockTime){
        let valid = this.isValidAmountFormat(decimals, amount, blockTime);
        if(valid){
            let [int, sats] = String(amount).split('.');
            if(!this.isNull(sats) && String(sats).length > decimals)
                valid = false;
        }
        return valid;
    },

    // Validate if a lock flag value evaluates to 0 (unlocked) or 1 (locked)
    isValidLockValue(value){
        let type  = typeof value,
            valid = [0,1];
        // Convert any numeric strings to integer value
        if(type=='string' && this.isNumeric(value))
            value = parseInt(value);
        // Only return true for 0/1 values
        if(valid.indexOf(value)!=-1)
            return true;
        return false;
    },

    // Handle validating lock status
    // @param {tokenInfo}       object  Replayed token state, or null when the tick is new
    // @param {data}            object  Parsed ISSUE params carrying the requested lock value
    // @param {lock}            string  Lock field name (LOCK_DESCRIPTION, LOCK_MINT, ...)
    // @param {nullPriorUnset}  bool    LOCK_NULL_PRIOR_UNSET flag-day: treat an
    //                                  absent/NULL prior as unset. Callers on the consensus
    //                                  path MUST resolve this from protocolChanges.isEnabled
    //                                  against the processing block; it defaults to false so
    //                                  legacy replay below the flag-day is byte-identical.
    isValidLock(tokenInfo, data, lock, nullPriorUnset){
        // Get lock VALUE
        let value = data[lock];
        // If we dont have any info on the token, it hasn't been created yet, so all flags are valid
        if(this.isNull(tokenInfo))
            return true;
        // Post-flag-day: a prior of NULL/undefined means the flag was never written, which is
        // the shape getTokenInfo produces whenever the genesis ISSUE omitted the lock fields.
        // Unset is unlocked, so treat it exactly like the "" prior handled just below. Without
        // this branch `undefined`/`null` matches none of the loose-equality tests that follow
        // (undefined=="", undefined==1 and undefined==0 are all false), the function returned
        // false, and the token was permanently unlockable while the read APIs reported it
        // unlocked. Gated because accepting an action that is invalid below the flag day is
        // consensus-relevant.
        if(nullPriorUnset && this.isNull(tokenInfo[lock]))
            return true;
        // If token exists and lock value does not exist yet, its valid
        if(tokenInfo[lock]=="")
            return true;
        // If lock value is not changing, its valid
        if(!this.isNull(value) && tokenInfo[lock]==value)
            return true;
        // If lock is unlocked and we are locking, its valid
        if(!this.isNull(value) && tokenInfo[lock]==0 && value==1)
            return true;
        return false;
    }
};
