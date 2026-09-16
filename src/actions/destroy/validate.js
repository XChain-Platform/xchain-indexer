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
 * DESTROY validation, per leg: the TICK rules (including the two bridge supply-path
 * closures), then the FORMAT and General rules, in the order the handler has always
 * applied them. Each takes the verdict so far and returns the verdict after its rules.
 *
 * Runs with `this` bound to the Destroy handler (./index.js calls each as
 * fn.call(this, ...)), so it reads the handler's own config, util and indexerDb.
 *
 ********************************************************************/

'use strict';

// TICK validations for one leg: the tick exists, and it is not a supply the bridge owns.
function validateLegTick(destroy, tokenInfo, error){
    /*****************************************************************
     * TICK Validations
     ****************************************************************/
    // Validate TICK exists
    if(!error && !tokenInfo)
        error = 'invalid: TICK (unknown)';

    // ── Bridge supply-path closures ───────────────────────────────────────────────
    //
    // DESTROY lowers a token's SUPPLY with no counterpart anywhere else, which is
    // exactly the wrong verb for a supply that is the shadow of an escrow balance
    // held on another chain. Burned here, the escrow on the origin chain would be
    // stranded forever and the bridge invariant (escrow >= supply) would read a
    // permanent surplus nobody can redeem. Both refusals name the action that DOES
    // have a counterpart leg: XBRIDGE v1 for XCHAIN, v4 for a bridged copy.
    //
    // UNCONDITIONAL, not activation-keyed. Neither refusal can move a
    // historical verdict: no off-BTC XCHAIN row exists to destroy (every broadcast
    // ISSUE of the gas tick off BTC is refused), and no `<ORIGIN>.<NAME>` row can
    // exist before the bridge creates one, because the parent gate refuses any child
    // of a coin root that does not exist and the roots are measured absent on every
    // live chain. An unconditional rule also cannot be mis-ordered against the block
    // at which the bridge first creates such a row.
    if(!error && String(destroy['TICK']).toUpperCase()==String(this.config['GAS']).toUpperCase() && this.config['COIN']!='BTC')
        error = 'invalid: TICK (use XBRIDGE v1)';

    if(!error && this.util.parseBridgedTick(destroy['TICK']))
        error = 'invalid: TICK (use XBRIDGE v4)';

    return error;
}

// FORMAT and General validations for one leg: the AMOUNT format, the sleep flags, the
// MEMO rules, the allow/block lists and the SOURCE balance still left for this leg.
async function validateLegRules(destroy, tokenInfo, balances, data, error){
    /*************************************************************
     * FORMAT Validations
     ************************************************************/
    // Verify AMOUNT format
    if(!error && !this.util.isNull(destroy['AMOUNT']) && !this.util.isValidAmountFormat(tokenInfo['DECIMALS'], destroy['AMOUNT'], data['BLOCK_TIME']))
        error = "invalid: AMOUNT (format)";

    /*************************************************************
     * General Validations
     ************************************************************/
    // Verify SOURCE is not sleeping
    if(!error && await this.indexerDb.isActionAllowed(destroy['SOURCE'], null, destroy['BLOCK_INDEX']) == false)
        error = 'invalid: SOURCE (sleeping)';

    // Verify TICK is not sleeping
    if(!error && await this.indexerDb.isActionAllowed(null, destroy['TICK'], destroy['BLOCK_INDEX']) == false)
        error = 'invalid: TICK (sleeping)';

    // Verify no pipe in MEMO (pipe is field delimiter)
    if(!error && String(destroy['MEMO']).indexOf('|')!=-1)
        error = 'invalid: MEMO (pipe)';

    // Verify no semicolon in MEMO (semicolon is action delimiter)
    if(!error && String(destroy['MEMO']).indexOf(';')!=-1)
        error = 'invalid: MEMO (semicolon)';

    // Verify MEMO is shorter than MAX_MEMO_LENGTH
    if(!error && String(destroy['MEMO']).length > this.config['MAX_MEMO_LENGTH'])
        error = 'invalid: MEMO (length)';

    // Verify TICK action is allowed from SOURCE (allow/block lists)
    if(!error && await this.indexerDb.isActionAllowed(destroy['SOURCE'], destroy['TICK']) == false)
        error = 'invalid: SOURCE (not authorized)';

    // Verify SOURCE has enough balances to cover destroy
    if(!error && !this.util.hasBalance(balances, tokenInfo['TICK_ID'], destroy['AMOUNT']))
        error = 'invalid: insufficient funds';

    return error;
}

module.exports = { validateLegTick, validateLegRules };
