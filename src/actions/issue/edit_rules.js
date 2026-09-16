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
 * ISSUE edit rules: fields a set lock freezes, the DESCRIPTION length, the CALLBACK
 * fields once supply is distributed, the ALLOW/BLOCK lists, the mint-window recency
 * checks and the MEMO rules.
 *
 * Each function runs with `this` bound to the Issue handler (./index.js calls each as
 * fn.call(this, ctx)) and reads and writes the shared context.
 *
 ********************************************************************/

'use strict';

// Fields a set LOCK_MAX_SUPPLY, LOCK_MAX_MINT, LOCK_DESCRIPTION or LOCK_CALLBACK freezes,
// and the DESCRIPTION length.
function validateLockedEdits(ctx){
    let { data, tokenInfo } = ctx;
    let error = ctx.error;

    // Verify MAX_SUPPLY can not be changed if LOCK_MAX_SUPPLY is enabled
    if(!error && tokenInfo && tokenInfo['LOCK_MAX_SUPPLY'] && !this.util.isNull(data['MAX_SUPPLY']) && String(data['MAX_SUPPLY']) != String(tokenInfo['MAX_SUPPLY']))
        error = 'invalid: MAX_SUPPLY (locked)';

    // Verify MAX_MINT can not be changed if LOCK_MAX_MINT is enabled
    if(!error && tokenInfo && tokenInfo['LOCK_MAX_MINT'] && !this.util.isNull(data['MAX_MINT']) && String(data['MAX_MINT']) != String(tokenInfo['MAX_MINT']))
        error = 'invalid: MAX_MINT (locked)';

    // Verify DESCRIPTION is under MAX_TOKEN_DESCRIPTION (rejects at exactly 250; effective max is 249 chars)
    if(!error && data['DESCRIPTION'] && String(data['DESCRIPTION']).length >= this.config.MAX_TOKEN_DESCRIPTION)
        error = 'invalid: DESCRIPTION (length)';

    // Verify DESCRIPTION can not be changed if LOCK_DESCRIPTION is enabled
    if(!error && tokenInfo && tokenInfo['LOCK_DESCRIPTION'] && !this.util.isNull(data['DESCRIPTION']) && data['DESCRIPTION'] != tokenInfo['DESCRIPTION'])
        error = 'invalid: DESCRIPTION (locked)';

    // Verify CALLBACK_BLOCK can not be changed if LOCK_CALLBACK is enabled
    if(!error && tokenInfo && tokenInfo['LOCK_CALLBACK'] && !this.util.isNull(data['CALLBACK_BLOCK']) && String(data['CALLBACK_BLOCK']) != String(tokenInfo['CALLBACK_BLOCK']))
        error = 'invalid: CALLBACK_BLOCK (locked)';

    // Verify CALLBACK_TICK can not be changed if LOCK_CALLBACK is enabled
    if(!error && tokenInfo && tokenInfo['LOCK_CALLBACK'] && !this.util.isNull(data['CALLBACK_TICK']) && data['CALLBACK_TICK'] != tokenInfo['CALLBACK_TICK'])
        error = 'invalid: CALLBACK_TICK (locked)';

    // Verify CALLBACK_TICK can not be changed if LOCK_CALLBACK is enabled
    if(!error && tokenInfo && tokenInfo['LOCK_CALLBACK'] && !this.util.isNull(data['CALLBACK_AMOUNT']) && String(data['CALLBACK_AMOUNT']) != String(tokenInfo['CALLBACK_AMOUNT']))
        error = 'invalid: CALLBACK_AMOUNT (locked)';

    ctx.error = error;
}

// The CALLBACK fields a wire ISSUE carries: CALLBACK_BLOCK in the future, and none of
// the three changed once supply is distributed; then the ALLOW/BLOCK list references.
async function validateCallbackAndListFields(ctx){
    let { data, issue, tokenInfo, isDistributed } = ctx;
    let error = ctx.error;

    // Verify CALLBACK_BLOCK is greater than current block index
    if(!error && tokenInfo && !this.util.isNull(issue['CALLBACK_BLOCK']) && this.util.bclt(data['CALLBACK_BLOCK'], data['BLOCK_INDEX']))
        error = 'invalid: CALLBACK_BLOCK (block index)';

    // Verify CALLBACK_BLOCK can not be changed if supply is distributed
    if(!error && !this.util.isNull(issue['CALLBACK_BLOCK']) && tokenInfo && String(data['CALLBACK_BLOCK']) != String(tokenInfo['CALLBACK_BLOCK']) && isDistributed)
        error = 'invalid: CALLBACK_BLOCK (supply distributed)';

    // Verify CALLBACK_TICK can not be changed if supply is distributed
    if(!error && !this.util.isNull(issue['CALLBACK_TICK']) && tokenInfo && data['CALLBACK_TICK'] != tokenInfo['CALLBACK_TICK'] && isDistributed)
        error = 'invalid: CALLBACK_TICK (supply distributed)';

    // // Verify CALLBACK_AMOUNT can not be changed if supply is distributed
    if(!error && !this.util.isNull(issue['CALLBACK_AMOUNT']) && tokenInfo && data['CALLBACK_AMOUNT'] != tokenInfo['CALLBACK_AMOUNT'] && isDistributed)
        error = 'invalid: CALLBACK_AMOUNT (supply distributed)';

    // Verify ALLOW_LIST is a valid list of addresses
    if(!error && !this.util.isNull(data['ALLOW_LIST']) && await this.indexerDb.isValidList(data['ALLOW_LIST'],2) == false)
        error = 'invalid: ALLOW_LIST (bad list)';

    // Verify BLOCK_LIST is a valid list of addresses
    if(!error && !this.util.isNull(data['BLOCK_LIST']) && await this.indexerDb.isValidList(data['BLOCK_LIST'],2) == false)
        error = 'invalid: BLOCK_LIST (bad list)';

    ctx.error = error;
}

// The mint-window recency and ordering checks, then the three MEMO rules.
async function validateMintWindowAndMemo(ctx){
    let { data, issue } = ctx;
    let error = ctx.error;

    // The mint-window recency checks exist to stop an ISSUE from BACKDATING a
    // window, so at/above the ISSUE_INHERITED_MINT_WINDOW activation they apply
    // only to a value the ISSUE explicitly carries on the wire (`issue` is the
    // pre-merge snapshot; the CALLBACK edit checks above detect explicit fields
    // the same way). Below it they also run against values the
    // populate-empty-params merge inherited from the existing token record,
    // which rejects every re-parameterizing ISSUE once the token's mint window
    // has opened (the inherited MINT_START_BLOCK is by then in the past); that
    // legacy behaviour is preserved below the flag day so a from-genesis replay
    // reproduces the historical rejections. An explicitly restated past value is
    // rejected either way.
    let inheritedWindowExempt = await this.actions.protocolChanges.isEnabled('ISSUE_INHERITED_MINT_WINDOW', data['BLOCK_INDEX']);
    let mintStartRecency      = inheritedWindowExempt ? issue['MINT_START_BLOCK'] : data['MINT_START_BLOCK'];
    let mintStopRecency       = inheritedWindowExempt ? issue['MINT_STOP_BLOCK']  : data['MINT_STOP_BLOCK'];

    // Verify MINT_START_BLOCK is greater than or equal to current block
    if(!error && !this.util.isNull(mintStartRecency) && this.util.bcgt(mintStartRecency, 0) && this.util.bclt(mintStartRecency, data['BLOCK_INDEX']))
        error = 'invalid: MINT_START_BLOCK < BLOCK_INDEX';

    // Verify MINT_STOP_BLOCK is greater than or equal to current block
    if(!error && !this.util.isNull(mintStopRecency) && this.util.bcgt(mintStopRecency, 0) && this.util.bclt(mintStopRecency, data['BLOCK_INDEX']))
        error = 'invalid: MINT_STOP_BLOCK < BLOCK_INDEX';

    // Verify MINT_STOP_BLOCK is greater than or equal to MINT_START_BLOCK
    if(!error && !this.util.isNull(data['MINT_STOP_BLOCK']) && this.util.bcgt(data['MINT_START_BLOCK'], 0) && this.util.bcgt(data['MINT_STOP_BLOCK'], 0) && this.util.bclt(data['MINT_STOP_BLOCK'], data['MINT_START_BLOCK']))
        error = 'invalid: MINT_STOP_BLOCK < MINT_START_BLOCK';

    // Verify no pipe in MEMO (pipe is field delimiter)
    if(!error && String(data['MEMO']).indexOf('|')!=-1)
        error = 'invalid: MEMO (pipe)';

    // Verify no semicolon in MEMO (semicolon is action delimiter)
    if(!error && String(data['MEMO']).indexOf(';')!=-1)
        error = 'invalid: MEMO (semicolon)';

    // Verify MEMO is shorter than MAX_MEMO_LENGTH
    if(!error && String(data['MEMO']).length > this.config['MAX_MEMO_LENGTH'])
        error = 'invalid: MEMO (length)';

    ctx.error = error;
}

module.exports = { validateLockedEdits, validateCallbackAndListFields, validateMintWindowAndMemo };
