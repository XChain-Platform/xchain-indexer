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
 * XChain Platform Action - SEND: validate
 *
 * The TICK, FORMAT and general validations one SEND leg must pass.
 *
 ********************************************************************/

// Installed onto Send.prototype by index.js; each method runs with `this` bound to the
// handler, exactly as the class method it was.
module.exports = {

    // TICK and FORMAT validations for one leg, then the general ones (validateSendLegAccess).
    // Returns the leg's error; a leg that arrives carrying one keeps it.
    async validateSendLeg(send, tokenInfo, data, ctx, error){
        /*****************************************************************
         * TICK Validations
         ****************************************************************/

        // Validate TICK exists
        if(!error && !tokenInfo)
            error = 'invalid: TICK (unknown)';

        /*************************************************************
         * FORMAT Validations
         ************************************************************/

        // Verify AMOUNT format
        if(!error && !this.util.isNull(send['AMOUNT']) && !this.util.isValidAmountFormat(tokenInfo['DECIMALS'], send['AMOUNT'], data['BLOCK_TIME']))
            error = "invalid: AMOUNT (format)";

        // Verify DESTINATION address format
        if(!error && !this.util.isNull(send['DESTINATION']) && !this.util.isCryptoAddress(send['DESTINATION']))
            error = "invalid: DESTINATION (format)";

        return this.validateSendLegAccess(send, tokenInfo, ctx, error);
    },

    // General validations for one leg: sleeping states, allow/block lists, the MEMO rules and the
    // SOURCE balance. The memo tables on ctx carry each per-tick answer on to the next leg.
    async validateSendLegAccess(send, tokenInfo, ctx, error){
        /*************************************************************
         * General Validations
         ************************************************************/
        // Verify SOURCE is not sleeping (hoisted, byte-identical across legs)
        if(!error && ctx.sourceActionAllowed == false)
            error = 'invalid: SOURCE (sleeping)';

        // Verify TICK is not sleeping (memoized per distinct tick for the tx's BLOCK_INDEX)
        if(!error){
            if(ctx.tickActionAllowed[send['TICK']] === undefined)
                ctx.tickActionAllowed[send['TICK']] = await this.indexerDb.isActionAllowed(null, send['TICK'], send['BLOCK_INDEX']);
            if(ctx.tickActionAllowed[send['TICK']] == false)
                error = 'invalid: TICK (sleeping)';
        }

        // Verify TICK action is allowed from SOURCE (allow/block lists, memoized per distinct tick)
        if(!error){
            if(ctx.sourceTickAllowed[send['TICK']] === undefined)
                ctx.sourceTickAllowed[send['TICK']] = await this.indexerDb.isActionAllowed(send['SOURCE'], send['TICK']);
            if(ctx.sourceTickAllowed[send['TICK']] == false)
                error = 'invalid: SOURCE (not authorized)';
        }

        // Verify TICK action is allowed to DESTINATION (allow/block lists)
        if(!error && await this.indexerDb.isActionAllowed(send['DESTINATION'], send['TICK']) == false)
            error = 'invalid: DESTINATION (not authorized)';

        // Verify no pipe in MEMO (pipe is field delimiter)
        if(!error && String(send['MEMO']).indexOf('|')!=-1)
            error = 'invalid: MEMO (pipe)';

        // Verify no semicolon in MEMO (semicolon is action delimiter)
        if(!error && String(send['MEMO']).indexOf(';')!=-1)
            error = 'invalid: MEMO (semicolon)';

        // Verify MEMO is shorter than MAX_MEMO_LENGTH
        if(!error && String(send['MEMO']).length > this.config['MAX_MEMO_LENGTH'])
            error = 'invalid: MEMO (length)';

        // Verify MEMO if destination address preferences require a memo
        if(!error && ctx.preferences[send['DESTINATION']]['REQUIRE_MEMO']==1 && this.util.isNull(send['MEMO']))
            error = 'invalid: MEMO (required)';

        // Verify SOURCE has enough balances to cover send AMOUNT
        if(!error && !this.util.hasBalance(ctx.balances, tokenInfo['TICK_ID'], send['AMOUNT']))
            error = 'invalid: insufficient funds';

        return error;
    }
};
