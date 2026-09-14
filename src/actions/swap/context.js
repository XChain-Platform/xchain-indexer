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
 * SWAP parse state: the VERSION check and wire params, the GIVE and GET
 * token records, the swap's sides (cross-chain GET, ownership escrow),
 * and the swap, balance and fee records every later check reads. The
 * only verdicts reached here are the VERSION and GET_ADDRESS reference
 * checks.
 *
 ********************************************************************/

// Read the wire params under the VERSION format and start the parse state that every
// later part reads and updates.
async function readParams(handler, params, data, error){
    // Validate that format is known
    let format = data['FORMAT'];
    // Verify VERSION is a format this action recognizes
    if(!error && (format===null || handler.formats[format] === undefined ))
        error = 'invalid: VERSION (unknown)';

    // Parse PARAMS using given VERSION format and update transaction data object
    if(!error)
        data = handler.util.setActionParams(data, params, handler.formats, format);

    // Convert NUMBER fields from string value to number value so comparisons are mathematical
    if(!error)
        data = handler.util.setNumberFormats(data);

    // Resolve a compacted ^<id> GET_ADDRESS back to its canonical address before
    // the default-to-SOURCE and validation logic (see resolveAddressRefChecked).
    // At/after the flag-day an unresolvable reference is a hard reject; below it
    // the value is left as-is and rejected by isCryptoAddress.
    if(!error){
        let getRef = await handler.indexerDb.resolveAddressRefChecked(data['GET_ADDRESS'], data['BLOCK_INDEX']);
        data['GET_ADDRESS'] = getRef.value;
        if(getRef.rejected)
            error = 'invalid: GET_ADDRESS (unresolvable ^id)';
    }

    return { format, data, error };
}

// Look up the GIVE token and, when it lives on this COIN network, the GET token.
async function loadTokens(handler, st){
    let { format, data } = st;

    // Get information on the GIVE and GET tokens
    let giveTokenInfo = false;
    let getTokenInfo  = false;
    // Look up the GIVE and GET token records that the checks below rely on
    if(format==0){
        giveTokenInfo = await handler.indexerDb.getTokenInfo(data['GIVE_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
        if(data['GET_COIN']==handler.config['COIN']){
            getTokenInfo = await handler.indexerDb.getTokenInfo(data['GET_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
        }
        // (Cross-chain GET_TICK lives on another COIN network; it cannot be validated
        //  locally. The xchain-hub federation validates it before matching/settlement.)
    }

    Object.assign(st, { giveTokenInfo, getTokenInfo });
}

// Classify the swap's sides: a GET side that settles on another COIN network, and
// ownership escrow on either side.
async function detectSides(handler, st){
    let { format, data } = st;

    // Detect a cross-chain swap (GET side settles on a different COIN network). The GIVE
    // side still escrows locally; matching + settlement are driven by the validator
    // federation (mirror-delivered cross-chain match) rather than the local SWAP_MATCH path.
    let isCrossChain      = (format==0 && !handler.util.isNull(data['GET_COIN']) && data['GET_COIN']!=handler.config['COIN']);
    let crossChainEnabled = isCrossChain ? await handler.actions.protocolChanges.isEnabled('CROSS_CHAIN_DEX', data['BLOCK_INDEX']) : false;

    // Default ownership flags to 0 when omitted; coerce to Number for downstream comparisons
    if(format==0){
        data['GIVE_OWNERSHIP'] = handler.util.isNull(data['GIVE_OWNERSHIP']) ? 0 : Number(data['GIVE_OWNERSHIP']);
        data['GET_OWNERSHIP']  = handler.util.isNull(data['GET_OWNERSHIP'])  ? 0 : Number(data['GET_OWNERSHIP']);
    }
    let isOwnershipGive = (format==0 && data['GIVE_OWNERSHIP']==1);
    let isOwnershipGet  = (format==0 && data['GET_OWNERSHIP']==1);

    Object.assign(st, { isCrossChain, crossChainEnabled, isOwnershipGive, isOwnershipGet });
}

// Load the swap being cancelled or edited, SOURCE balances and preferences and the fees
// object, fill the EXPIRATION and GET_ADDRESS defaults, and snapshot the row the swaps
// table stores.
async function loadRecords(handler, st){
    let { format, data } = st;

    // Get information on the swap by its action_index. Pass null coin (not the local
    // COIN): cancel/edit must locate the swap regardless of its get_coin, or a
    // cross-chain swap (whose get_coin is the counterparty chain) is never found.
    var swapInfo = false;
    if(format==1 || format==2)
        swapInfo = await handler.indexerDb.getSwapInfo(null, data['SWAP_ACTION_INDEX'])

    // Get source address balances and preferences
    let balances    = await handler.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
    let preferences = await handler.indexerDb.getAddressPreferences(data['SOURCE'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

    // Create the fees object
    let fees = await handler.util.createFeesObject(handler.indexerDb, data, preferences);

    // Default GET_ADDRESS to SOURCE address if COIN networks are the same and GET_ADDRESS is not given
    if(handler.config['COIN']==data['GET_COIN'] && handler.util.isNull(data['GET_ADDRESS']))
        data['GET_ADDRESS'] = data['SOURCE'];

    // Set EXPIRATION value if none is given
    if(format==0 && handler.util.isNull(data['EXPIRATION']))
        data['EXPIRATION'] = handler.util.getDefaultExpiration(data['BLOCK_TIME']);

    // Clone the raw data for storage in swap table
    let swap = Object.assign({}, data);

    Object.assign(st, { swapInfo, balances, preferences, fees, swap });
}

module.exports = { readParams, loadTokens, detectSides, loadRecords };
