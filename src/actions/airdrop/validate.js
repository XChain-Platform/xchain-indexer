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
 * XChain Platform Action - AIRDROP: validate
 *
 * The TICK, FORMAT, general, LIST and SOURCE validations one AIRDROP
 * leg must pass.
 *
 ********************************************************************/

// Installed onto Airdrop.prototype by airdrop.js; each method runs with `this` bound to the
// handler, exactly as the class method it was.
module.exports = {

    // TICK, FORMAT and general validations for one leg, then the LIST it names
    // (lookupAirdropList). Returns { error, type, list }.
    async validateAirdropLeg(airdrop, tokenInfo, data, error){
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
        if(!error && !this.util.isNull(airdrop['AMOUNT']) && !this.util.isValidAmountFormat(tokenInfo['DECIMALS'], airdrop['AMOUNT'], data['BLOCK_TIME']))
            error = "invalid: AMOUNT (format)";

        // Verify LIST format
        if(!error && !this.util.isNull(airdrop['LIST_ACTION_INDEX']) && !this.util.isNumeric(airdrop['LIST_ACTION_INDEX']))
            error = "invalid: LIST_ACTION_INDEX (format)";

        /*************************************************************
         * General Validations
         ************************************************************/

        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(airdrop['SOURCE'], null, airdrop['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        // Verify TICK is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(null, airdrop['TICK'], airdrop['BLOCK_INDEX']) == false)
            error = 'invalid: TICK (sleeping)';

        // Verify no pipe in MEMO (pipe is field delimiter)
        if(!error && String(airdrop['MEMO']).indexOf('|')!=-1)
            error = 'invalid: MEMO (pipe)';

        // Verify no semicolon in MEMO (semicolon is action delimiter)
        if(!error && String(airdrop['MEMO']).indexOf(';')!=-1)
            error = 'invalid: MEMO (semicolon)';

        // Verify MEMO is shorter than MAX_MEMO_LENGTH
        if(!error && String(airdrop['MEMO']).length > this.config['MAX_MEMO_LENGTH'])
            error = 'invalid: MEMO (length)';

        return this.lookupAirdropList(airdrop, data, error);
    },

    // Look up the LIST the leg names and require a supported type. Returns { error, type, list },
    // with type false and list null when an earlier check already failed the leg.
    async lookupAirdropList(airdrop, data, error){
        // Placeholder for list and list type
        let type = false,
            list = null;

        // Lookup list information
        if(!error){
            type = await this.indexerDb.getListType(airdrop['LIST_ACTION_INDEX']);
            list = await this.indexerDb.getList(airdrop['LIST_ACTION_INDEX'], data['BLOCK_INDEX']);
        }

        // Verify LIST exist
        if(!error && type===false)
            error = 'invalid: LIST (unknown)';

        // Verify LIST type is supported
        if(!error && !this.listTypes.includes(type))
            error = 'invalid: LIST TYPE (unsupported)';

        return { error, type, list };
    },

    // The SOURCE-side checks that run between the recipient expansion and the approval: the
    // TICK's allow/block lists for SOURCE, and a balance that covers one AMOUNT
    async validateAirdropSource(airdrop, tokenInfo, ctx, error){
        // Verify TICK action is allowed from SOURCE (allow/block lists)
        if(!error && await this.indexerDb.isActionAllowed(airdrop['SOURCE'], airdrop['TICK']) == false)
            error = 'invalid: SOURCE (not authorized)';

        // Verify SOURCE has enough balances to cover airdrop AMOUNT
        if(!error && await this.util.hasBalance(ctx.balances, tokenInfo['TICK_ID'], airdrop['AMOUNT']) == false)
            error = 'invalid: insufficient funds';

        return error;
    }
};
