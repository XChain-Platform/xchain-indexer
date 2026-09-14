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
 * DISPENSER handler part: the CONTEXT every later phase reads.
 *
 * Format resolution, param parsing, caret-reference resolution, the dispenser and
 * token lookups, the source balances and preferences, the fees object and the
 * defaults applied before validation. Moved verbatim out of parse(); the reads
 * happen in the same order, which is what the handler call tape pins.
 *
 ********************************************************************/

'use strict';

// Installed onto Dispenser.prototype by dispenser.js; each method runs with `this`
// bound to the handler, exactly as the inline code it was.
module.exports = {

    // Builds the ctx object the rest of parse() threads: every local the phases share,
    // so a phase that reassigns one writes it back for the next.
    async resolveDispenserContext(params, data, error){
        let ctx = { params, data, error, guardFee: 0 };
        await this.resolveDispenserParams(ctx);
        await this.loadDispenserRecords(ctx);
        return ctx;
    },

    // Format check, param parsing, number coercion, caret-reference resolution and
    // the ownership flag default.
    async resolveDispenserParams(ctx){
    let { params, data, error } = ctx;

        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Parse PARAMS using given VERSION format and update transaction data object
        if(!error)
            data = this.util.setActionParams(data, params, this.formats, format);

        // Convert NUMBER fields from string value to number value so comparisons are mathematical 
        if(!error)
            data = this.util.setNumberFormats(data);

        // Resolve compacted ^<id> address references (GET_ADDRESS, ORACLE_ADDRESS)
        // back to their canonical address strings before validation/use. At/after the
        // flag-day an unresolvable reference is a hard reject here; below it the
        // value is left as-is and rejected by the isCryptoAddress checks lower down.
        // ORACLE_ADDRESS is exactly why the resolver has to state the verdict: its
        // format check only runs when `usingOracle` is true, so a malformed reference
        // on a non-oracle dispenser rides straight through the legacy path.
        // See resolveAddressRefChecked / caret_ref_strict_activation.js.
        if(!error){
            let getRef = await this.indexerDb.resolveAddressRefChecked(data['GET_ADDRESS'], data['BLOCK_INDEX']);
            data['GET_ADDRESS'] = getRef.value;
            let oracleRef = await this.indexerDb.resolveAddressRefChecked(data['ORACLE_ADDRESS'], data['BLOCK_INDEX']);
            data['ORACLE_ADDRESS'] = oracleRef.value;
            if(getRef.rejected)
                error = 'invalid: GET_ADDRESS (unresolvable ^id)';
            else if(oracleRef.rejected)
                error = 'invalid: ORACLE_ADDRESS (unresolvable ^id)';
        }

        // Default ownership flag to 0 when omitted; coerce to Number for downstream comparisons
        if(format==0)
            data['GIVE_OWNERSHIP'] = this.util.isNull(data['GIVE_OWNERSHIP']) ? 0 : Number(data['GIVE_OWNERSHIP']);
        let isOwnershipGive = (format==0 && data['GIVE_OWNERSHIP']==1);

    ctx.data = data;
    ctx.error = error;
    ctx.format = format;
    ctx.isOwnershipGive = isOwnershipGive;
    },

    // The dispenser and token rows, the source balances and preferences, the fees
    // object, the GET_ADDRESS and EXPIRATION defaults, and the dispensers-table clone.
    async loadDispenserRecords(ctx){
    let { data, error, format } = ctx;

        // Get information on a dispenser given the COIN network and DISPENSER_ACTION_INDEX
        var dispenserInfo = false;
        if(format==1 || format==2)
            dispenserInfo = await this.indexerDb.getDispenserInfo(this.config['COIN'], data['DISPENSER_ACTION_INDEX'], data['BLOCK_TIME']);

        // Get information on the GIVE and GET tokens
        let info = (format==0) ? data : dispenserInfo;
        let giveTokenInfo = await this.indexerDb.getTokenInfo(info['GIVE_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let getTokenInfo  = false;

        // Get the GET token info if this is the correct COIN network
        if(info['GET_COIN'] == this.config['COIN'] && !this.util.isNull(info['GET_TICK']))
            getTokenInfo = await this.indexerDb.getTokenInfo(info['GET_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Get source address balances and preferences
        let balances    = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let preferences = await this.indexerDb.getAddressPreferences(data['SOURCE'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Create the fees object 
        let fees = await this.util.createFeesObject(this.indexerDb, data, preferences);

        // Default GET_ADDRESS to SOURCE address if COIN networks are the same and GET_ADDRESS is not given
        if(this.config['COIN']==data['GET_COIN'] && this.util.isNull(data['GET_ADDRESS']))
            data['GET_ADDRESS'] = data['SOURCE'];

        // Set default EXPIRATION value if none is given
        if(format==0 && this.util.isNull(data['EXPIRATION']))
            data['EXPIRATION'] = this.util.getDefaultExpiration(data['BLOCK_TIME']);

        // Clone the raw data for storage in dispensers table
        let dispenser = Object.assign({}, data);

    ctx.data = data;
    ctx.error = error;
    ctx.dispenserInfo = dispenserInfo;
    ctx.info = info;
    ctx.giveTokenInfo = giveTokenInfo;
    ctx.getTokenInfo = getTokenInfo;
    ctx.balances = balances;
    ctx.preferences = preferences;
    ctx.fees = fees;
    ctx.dispenser = dispenser;
    },
};

