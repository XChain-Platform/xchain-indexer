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
 * ISSUE token state: the existing token row (merged into the empty wire fields), the
 * CALLBACK_TICK row, the AMOUNT and LOCK field formats, and the owner, sleep, escrow
 * and lock-once rules that decide who may edit the row at all.
 *
 * Each function runs with `this` bound to the Issue handler (./index.js calls each as
 * fn.call(this, ctx)) and reads and writes the shared context.
 *
 ********************************************************************/

'use strict';

const { normalizeDataValues } = require('../../db/database/normalize.js');
const { exceedsCodePoints }   = require('../../db/column_text.js');

// The issues columns a wire field reaches with no width check of its own, and their widths
// (src/sql/issues.sql, VARCHAR). MIN_DEPTH (VARCHAR(15)) is bounded with its range rule.
const STORED_TEXT_WIDTHS = Object.freeze({
    DECIMALS:         2,
    CALLBACK_BLOCK:   15,
    MINT_START_BLOCK: 15,
    MINT_STOP_BLOCK:  15,
    BRIDGE_CHAINS:    250,
    LOCK_BRIDGE:      1
});

// The TICK row, the lazy distribution probe, the merge into empty PARAMS and the
// CALLBACK_TICK row. Leaves ctx.tokenInfo, ctx.distributionProbe and ctx.cbInfo.
async function loadTokenState(ctx){
    let { data, error, issue, format, batchIssuanceLimitsV2, policyListDetach } = ctx;

    // Get information on the token. Distribution is only needed by changed CALLBACK
    // fields, so defer its holder scan and cache the first result for the whole action.
    let tokenInfo = await this.gatedGetTokenInfo(data['TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX'], error, batchIssuanceLimitsV2);
    let distributionResult;
    let distributionProbe = () => {
        if(distributionResult === undefined)
            distributionResult = data['IS_GENESIS']
                ? false
                : this.indexerDb.isDistributed(data['TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX'], tokenInfo);
        return distributionResult;
    };

    // Populate empty PARAMS with current setting
    if(tokenInfo){
        for(let key in tokenInfo){
            if(this.util.isNull(data[key]))
                data[key] = tokenInfo[key];
        }
    }

    // Read the format-5 `0` sentinel as no list while retaining it in the ISSUE row.
    // Empty fields stay inherited from tokenInfo through the merge above.
    if(policyListDetach && Number(format)===5){
        for(let name of ['ALLOW_LIST', 'BLOCK_LIST'])
            if(String(issue[name])==='0')
                data[name] = null;
    }

    // Get information on CALLBACK_TICK
    let cbInfo = false;
    if(data['CALLBACK_TICK'])
        cbInfo = await this.gatedGetTokenInfo(data['CALLBACK_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX'], error, batchIssuanceLimitsV2);

    Object.assign(ctx, { tokenInfo, distributionProbe, cbInfo });
}

// FORMAT Validations: every AMOUNT field against its tick's decimals, and every LOCK
// field's 0/1 value, both read off the pre-merge wire snapshot.
function validateFieldFormats(ctx){
    let { data, issue, tokenInfo, cbInfo } = ctx;
    let error = ctx.error;

    // FORMAT Validations

    // Set decimal precision for TICK and CALLBACK_TICK
    let tick_decimals     = (!this.util.isNull(tokenInfo) && !this.util.isNull(tokenInfo['DECIMALS'])) ? tokenInfo['DECIMALS'] : data['DECIMALS'],
        callback_decimals = (!this.util.isNull(cbInfo) && !this.util.isNull(cbInfo['DECIMALS'])) ? cbInfo['DECIMALS'] : 0;

    // Verify AMOUNT field formats
    for(let name of this.fieldList['AMOUNT']){
        let value    = issue[name],
            decimals = (name=='CALLBACK_AMOUNT') ? callback_decimals : tick_decimals;
        if(!error && !this.util.isNull(value) && !this.util.isValidAmountFormat(decimals, value, data['BLOCK_TIME']))
            error = "invalid: " + name + " (format)";
    }

    // Verify LOCK field formats
    for(let name of this.fieldList['LOCK']){
        let value = issue[name];
        if(!error && !this.util.isNull(value) && !this.util.isValidLockValue(value))
            error = "invalid: " + name + " (format)";
    };

    ctx.error = storedWidthError.call(this, issue, error);
}

// Every ISSUE writes its issues row from the wire snapshot through normalizeDataValues,
// whatever its verdict, so a stored value longer than its column failed the INSERT on every
// retry: DECIMALS '001', a 16-digit MINT_START_BLOCK, LOCK_BRIDGE '01' or a 251-character
// BRIDGE_CHAINS all pass the rules above. The check reads the very value the writer binds
// (the same normalization, run on a copy), so it refuses exactly the actions that halted
// the block and leaves every recorded verdict as it was.
function storedWidthError(issue, error){
    if(error)
        return error;
    let stored = normalizeDataValues.call({ util: this.util, config: this.config }, issue);
    for(let name in STORED_TEXT_WIDTHS){
        if(exceedsCodePoints(stored[name], STORED_TEXT_WIDTHS[name]))
            return 'invalid: ' + name + ' (length)';
    }
    return error;
}

// General Validations on who may edit the row: SOURCE awake, SOURCE is the owner, the
// ownership is not escrowed, and no set LOCK field is being unset.
async function validateOwnership(ctx){
    let { data, issue, tokenInfo } = ctx;
    let error = ctx.error;

    // General Validations

    // Verify SOURCE is not sleeping. GAS is never put to sleep and there are no lists at
    // genesis, so isActionAllowed is always true during bootstrap; skip the read.
    if(!error && !data['IS_GENESIS'] && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
        error = 'invalid: SOURCE (sleeping)';

    // Verify ISSUE is coming from TICK owner
    if(!error && tokenInfo && tokenInfo['OWNER']!=data['SOURCE'])
        error = 'invalid: issued by another address';

    // Reject any ISSUE that edits an existing tick while its ownership is escrowed
    // (covers v1 description edit, v2 mint params, v3 lock params, v4 callback params,
    // v5 list params, and v0 re-issuance from the existing owner). The escrow itself
    // was opened by a successful ORDER/SWAP/DISPENSER from the same SOURCE; only
    // closing the offer (via cancel/expire/match/sweep) releases this lock.
    if(!error && tokenInfo && !data['IS_GENESIS'] && await this.indexerDb.isOwnershipEscrowed(data['TICK']))
        error = 'invalid: TICK (ownership escrowed)';

    // Verify LOCK fields cannot be changed once enabled/locked.
    //
    // Gate: LOCK_NULL_PRIOR_UNSET makes isValidLock read an absent/NULL prior
    // as unset instead of falling through to "locked". getTokenInfo skips NULL columns
    // when it replays the `issues` rows, so a token whose genesis ISSUE omitted the lock
    // fields arrived here with an undefined prior and every later LOCK was refused with
    // "invalid: <FIELD> (locked)" on a flag that had never been locked. Resolved once for
    // the whole field loop against the processing block: the gate must not be able to
    // differ field to field within one action. Below the flag-day the legacy verdict
    // stands, so from-genesis replay stays byte-identical.
    let lockNullPriorUnset = await this.actions.protocolChanges.isEnabled('LOCK_NULL_PRIOR_UNSET', data['BLOCK_INDEX']);
    for(let name of this.fieldList['LOCK']){
        let value = issue[name];
        if(!error && tokenInfo && !this.util.isNull(value) && !this.util.isValidLock(tokenInfo, issue, name, lockNullPriorUnset))
            error = "invalid: " + name + " (locked)";
    }

    ctx.error = error;
}

module.exports = { loadTokenState, validateFieldFormats, validateOwnership };
