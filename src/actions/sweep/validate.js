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
 * SWEEP validation: resolve a compacted DESTINATION reference, check the wire
 * flags and MEMO, and apply the per-flag defaults. Every check runs only while
 * no earlier one has failed, so the first failure is the status recorded.
 *
 ********************************************************************/

// Installed onto Sweep.prototype by sweep.js; each method runs with `this` bound to
// the handler, exactly as the parse() code it came from.
module.exports = {

    // Resolve a compacted ^<id> DESTINATION back to its canonical address before
    // validation/use (see resolveAddressRefChecked). At/after the reference-resolution
    // flag-day an unresolvable reference is a hard reject; below it the value is left
    // as-is and rejected by isCryptoAddress.
    // Returns the error, set here only when the reference does not resolve.
    async resolveSweepDestination(data, error){
        if(!error){
            let destRef = await this.indexerDb.resolveAddressRefChecked(data['DESTINATION'], data['BLOCK_INDEX']);
            data['DESTINATION'] = destRef.value;
            if(destRef.rejected)
                error = 'invalid: DESTINATION (unresolvable ^id)';
        }
        return error;
    },

    // Check DESTINATION and the 0/1 wire flags, then default every flag left unset.
    // Returns the error; the defaults are applied whether or not a check failed.
    validateSweepFormat(data, error){
        /*****************************************************************
         * FORMAT Validations
         ****************************************************************/
        // DESTINATION is mandatory. A null/empty DESTINATION skips the format check below and
        // sweeps every SOURCE balance into a NULL-address credit: createLedgerChangeRecord writes
        // the credit with address_id=NULL, but updateBalances skips NULL addresses, so SOURCE's
        // balances row is decremented with no matching credit row - the balances sum falls short
        // of the unchanged token supply and the per-block sanityCheck throws SanityError, halting
        // the indexer fleet-wide from one crafted tx (and OWNERSHIPS=1 would also deed ownership to
        // a NULL owner). Reject it up front. Ungated: current behaviour is a chain HALT (no block
        // commits), so there is no committed valid ledger for this to fork against.
        if(!error && this.util.isNull(data['DESTINATION']))
            error = "invalid: DESTINATION (null)";

        // Verify DESTINATION address format
        if(!error && !this.util.isNull(data['DESTINATION']) && !this.util.isCryptoAddress(data['DESTINATION']))
            error = "invalid: DESTINATION (format)";

        // Verify BALANCES format is valid (0 or 1)
        if(!error && !this.util.isNull(data['BALANCES']) && !this.util.isValidValue(data['BALANCES'],[0,1]))
            error = "invalid: BALANCES (format)";

        // Verify OWNERSHIPS format is valid (0 or 1)
        if(!error && !this.util.isNull(data['OWNERSHIPS']) && !this.util.isValidValue(data['OWNERSHIPS'],[0,1]))
            error = "invalid: OWNERSHIP (format)";

        // Verify ORDERS format is valid (0 or 1)
        if(!error && !this.util.isNull(data['ORDERS']) && !this.util.isValidValue(data['ORDERS'],[0,1]))
            error = "invalid: ORDERS (format)";

        // Verify SWAPS format is valid (0 or 1)
        if(!error && !this.util.isNull(data['SWAPS']) && !this.util.isValidValue(data['SWAPS'],[0,1]))
            error = "invalid: SWAPS (format)";

        // Verify DISPENSERS format is valid (0 or 1)
        if(!error && !this.util.isNull(data['DISPENSERS']) && !this.util.isValidValue(data['DISPENSERS'],[0,1]))
            error = "invalid: DISPENSERS (format)";

        // Set default values for BALANCES, OWNERSHIPS, and per-offer-type close flags
        data['BALANCES']   = (!this.util.isNull(data['BALANCES']))   ? data['BALANCES']   : 1;
        data['OWNERSHIPS'] = (!this.util.isNull(data['OWNERSHIPS'])) ? data['OWNERSHIPS'] : 1;
        data['ORDERS']     = (!this.util.isNull(data['ORDERS']))     ? data['ORDERS']     : 0;
        data['SWAPS']      = (!this.util.isNull(data['SWAPS']))      ? data['SWAPS']      : 0;
        data['DISPENSERS'] = (!this.util.isNull(data['DISPENSERS'])) ? data['DISPENSERS'] : 0;
        return error;
    },

    // SOURCE must not be sleeping and MEMO must fit the wire. Returns the error.
    async validateSweepGeneral(data, error){
        /*****************************************************************
         * General Validations
         ****************************************************************/

        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        // Verify no pipe in MEMO (pipe is field delimiter)
        if(!error && !this.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf('|')!=-1)
            error = 'invalid: MEMO (pipe)';

        // Verify no semicolon in MEMO (semicolon is action delimiter)
        if(!error && !this.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf(';')!=-1)
            error = 'invalid: MEMO (semicolon)';

        // Verify MEMO is shorter than MAX_MEMO_LENGTH
        if(!error && String(data['MEMO']).length > this.config['MAX_MEMO_LENGTH'])
            error = 'invalid: MEMO (length)';

        // TODO: Verify sweep is allowed to new address (ALLOW_LIST & BLOCK_LIST)
        // TODO: Verify sweep is allowed on each TICK (SLEEP)
        return error;
    }
};
