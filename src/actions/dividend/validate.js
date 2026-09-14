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
 * XChain Platform Action - DIVIDEND: validate
 *
 * The TICK, FORMAT and general validations a DIVIDEND must pass.
 *
 ********************************************************************/

// Installed onto Dividend.prototype by index.js; each method runs with `this` bound to the
// handler, exactly as the class method it was.
module.exports = {

    // The TICK, FORMAT and general validations. Returns the error; one already set is kept.
    async validateDividend(data, tokenInfo, dividendTokenInfo, error){
        /*****************************************************************
         * TICK Validations
         ****************************************************************/
        // Validate TICK exists
        if(!error && !tokenInfo)
            error = 'invalid: TICK (unknown)';

        // Validate DIVIDEND_TICK exists
        if(!error && !dividendTokenInfo)
            error = 'invalid: DIVIDEND_TICK (unknown)';

        /*****************************************************************
         * FORMAT Validations
         ****************************************************************/
        // Verify AMOUNT format valid for DIVIDEND_TICK
        if(!error && (this.util.isNull(data['AMOUNT']) || !this.util.isValidAmountFormat(dividendTokenInfo['DECIMALS'], data['AMOUNT'], data['BLOCK_TIME'])))
            error = "invalid: AMOUNT (format)";

        /*****************************************************************
         * General Validations
         ****************************************************************/
        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        // Verify TICK is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(null, data['TICK'], data['BLOCK_INDEX']) == false)
            error = 'invalid: TICK (sleeping)';

        // Verify DIVIDEND_TICK is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(null, data['DIVIDEND_TICK'], data['BLOCK_INDEX']) == false)
            error = 'invalid: DIVIDEND_TICK (sleeping)';

        // Verify no pipe in MEMO (pipe is field delimiter)
        if(!error && !this.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf('|')!=-1)
            error = 'invalid: MEMO (pipe)';

        // Verify no semicolon in MEMO (semicolon is action delimiter)
        if(!error && !this.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf(';')!=-1)
            error = 'invalid: MEMO (semicolon)';

        // Verify MEMO is shorter than MAX_MEMO_LENGTH
        if(!error && String(data['MEMO']).length > this.config['MAX_MEMO_LENGTH'])
            error = 'invalid: MEMO (length)';

        return error;
    }
};
