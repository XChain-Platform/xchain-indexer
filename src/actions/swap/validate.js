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
 * SWAP validity checks, in the order parse() runs them: coins and ticks,
 * amount and field formats, token ownership escrow, the general SOURCE,
 * MEMO and SWAP_ACTION_INDEX checks, the ALLOW_LIST / BLOCK_LIST fields,
 * and the GIVE_AMOUNT balance reservation. Each keeps the first verdict
 * already reached and only looks further while there is none.
 *
 ********************************************************************/

// Coins and ticks: both COIN networks supported, GIVE on this network, the GIVE tick
// known, cross-chain enabled, and a local GET tick known.
function validateTickAndCoin(handler, st){
    let { format, data, isCrossChain, crossChainEnabled, giveTokenInfo, getTokenInfo } = st;
    let error = st.error;

    // Validate GIVE_COIN is valid
    if(!error && format==0 && !handler.config['COINS'].includes(data['GIVE_COIN']))
        error = 'invalid: GIVE_COIN (unsupported COIN network)';

    // Validate GET_COIN is valid
    if(!error && format==0 && !handler.config['COINS'].includes(data['GET_COIN']))
        error = 'invalid: GET_COIN (unsupported COIN network)';

    // validate GIVE_COIN network is current COIN network
    if(!error && format==0 && handler.config['COIN']!=data['GIVE_COIN'])
        error = "invalid: GIVE_COIN (network)";

    // Validate GIVE_TICK exists
    if(!error && format==0 && !giveTokenInfo)
        error = 'invalid: GIVE_TICK (unknown)';

    // Cross-chain swaps require the CROSS_CHAIN_DEX protocol change to be active
    if(!error && isCrossChain && !crossChainEnabled)
        error = 'invalid: GET_COIN (cross-chain not enabled)';

    // Validate GET_TICK exists (local validation only; a cross-chain GET_TICK is
    // validated by the xchain-hub federation, so skip the local existence check)
    if(!error && format==0 && !isCrossChain && !getTokenInfo)
        error = 'invalid: GET_TICK (unknown)';

    st.error = error;
}

// Formats: GIVE_AMOUNT and GET_AMOUNT against their token decimals, GET_ADDRESS presence
// and shape on its network, and an EXPIRATION the expiration column can hold.
function validateFormats(handler, st){
    let { format, data, giveTokenInfo, getTokenInfo } = st;
    let error = st.error;

    // Verify GIVE_AMOUNT format
    if(!error && format==0 && !handler.util.isNull(data['GIVE_AMOUNT']) && giveTokenInfo && !handler.util.isValidAmountFormat(giveTokenInfo['DECIMALS'], data['GIVE_AMOUNT'], data['BLOCK_TIME']))
        error = "invalid: GIVE_AMOUNT (format)";

    // Verify GET_AMOUNT format
    if(!error && format==0 && !handler.util.isNull(data['GET_AMOUNT']) && getTokenInfo && !handler.util.isValidAmountFormat(getTokenInfo['DECIMALS'], data['GET_AMOUNT'], data['BLOCK_TIME']))
        error = "invalid: GET_AMOUNT (format)";

    // Verify GET_ADDRESS is given if COIN network differs from GET_COIN network
    if(!error && format==0 && handler.config['COIN']!=data['GET_COIN'] && handler.util.isNull(data['GET_ADDRESS']))
        error = "invalid: GET_ADDRESS";

    // Verify GET_ADDRESS is valid for the given GET_COIN network
    if(!error && format==0 && !handler.util.isNull(data['GET_ADDRESS']) && !handler.util.isCryptoAddress(data['GET_ADDRESS'], data['GET_COIN']))
        error = "invalid: GET_ADDRESS (format)";

    // Validate that EXPIRATION is an integer
    if(!error && !handler.util.isNull(data['EXPIRATION']) && (!handler.util.isNumeric(data['EXPIRATION']) || !handler.util.isInteger(data['EXPIRATION'])))
        error = "invalid: EXPIRATION (format)";

    // Reject an EXPIRATION the expiration column cannot represent. Without this a
    // payload that is otherwise VALID normalizes to expiration NULL for storage, i.e.
    // an escrow that never expires, which is a worse outcome than rejecting it.
    if(!error && !handler.util.isNull(data['EXPIRATION']) &&
       handler.util.exceedsUnsignedColumn(data['EXPIRATION'], handler.config['INTEGER_FIELDS']['EXPIRATION']))
        error = "invalid: EXPIRATION (format)";

    st.error = error;
}

// Token ownership escrow (format 0 only): the flags are 0 or 1, a seller of ownership
// owns an unescrowed known tick, and a bidder for ownership names a known local tick.
async function validateOwnership(handler, st){
    let { format, data, isOwnershipGive, isOwnershipGet, giveTokenInfo, getTokenInfo } = st;
    let error = st.error;

    // GIVE_OWNERSHIP / GET_OWNERSHIP must be 0 or 1
    if(!error && format==0 && ![0,1].includes(data['GIVE_OWNERSHIP']))
        error = "invalid: GIVE_OWNERSHIP (format)";
    // Verify GET_OWNERSHIP is 0 or 1
    if(!error && format==0 && ![0,1].includes(data['GET_OWNERSHIP']))
        error = "invalid: GET_OWNERSHIP (format)";

    // Selling ownership: GIVE_AMOUNT must be empty, GIVE_TICK must be a known tick,
    // SOURCE must currently own it, and the tick's ownership must not already be escrowed.
    if(!error && isOwnershipGive){
        if(!handler.util.isNull(data['GIVE_AMOUNT']))
            error = "invalid: GIVE_AMOUNT (must be empty when GIVE_OWNERSHIP=1)";
        else if(!giveTokenInfo)
            error = "invalid: GIVE_TICK (unknown)";
        else if(giveTokenInfo['OWNER'] != data['SOURCE'])
            error = "invalid: SOURCE (not GIVE_TICK owner)";
        else if(await handler.indexerDb.isOwnershipEscrowed(data['GIVE_TICK']))
            error = "invalid: GIVE_TICK (ownership already escrowed)";
    }

    // Bidding for ownership: GET_AMOUNT must be empty. GET_TICK existence is only verifiable
    // on the current chain; cross-chain GET_TICK validation lives in xchain-hub.
    if(!error && isOwnershipGet){
        if(!handler.util.isNull(data['GET_AMOUNT']))
            error = "invalid: GET_AMOUNT (must be empty when GET_OWNERSHIP=1)";
        else if(data['GET_COIN']==handler.config['COIN'] && !getTokenInfo)
            error = "invalid: GET_TICK (unknown)";
    }

    st.error = error;
}

// General checks: SOURCE and TICK awake, MEMO free of delimiters and short enough, SOURCE
// authorized for the tick, the cancelled or edited swap known, owned and open, and an
// EXPIRATION still in the future.
async function validateGeneral(handler, st){
    let { format, data, swapInfo } = st;
    let error = st.error;

    // Verify SOURCE is not sleeping
    if(!error && await handler.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
        error = 'invalid: SOURCE (sleeping)';

    // Verify TICK is not sleeping
    if(!error && format==0 && await handler.indexerDb.isActionAllowed(null, data['GIVE_TICK'], data['BLOCK_INDEX']) == false)
        error = 'invalid: TICK (sleeping)';

    // Verify no pipe in MEMO (pipe is field delimiter)
    if(!error && !handler.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf('|')!=-1)
        error = 'invalid: MEMO (pipe)';

    // Verify no semicolon in MEMO (semicolon is action delimiter)
    if(!error && !handler.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf(';')!=-1)
        error = 'invalid: MEMO (semicolon)';

    // Verify MEMO is shorter than MAX_MEMO_LENGTH
    if(!error && String(data['MEMO']).length > handler.config['MAX_MEMO_LENGTH'])
        error = 'invalid: MEMO (length)';

    // Verify TICK action is allowed from SOURCE (allow/block lists)
    if(!error && format==0 && await handler.indexerDb.isActionAllowed(data['SOURCE'], data['GIVE_TICK']) == false)
        error = 'invalid: SOURCE (not authorized)';

    // Validate SWAP_ACTION_INDEX is valid SWAP
    if(!error && (format==1 || format==2) && !swapInfo)
        error = 'invalid: SWAP_ACTION_INDEX (unknown)';

    // Verify SOURCE address is owner of the SWAP_ACTION_INDEX swap
    if(!error && (format==1 || format==2) && data['SOURCE']!=swapInfo['SOURCE'])
        error = 'invalid: SOURCE (not owner)';

    // Validate SWAP_ACTION_INDEX is valid SWAP with a status of open
    if(!error && (format==1 || format==2) && swapInfo['SWAP_STATUS']!='open')
        error = 'invalid: SWAP_ACTION_INDEX (swap not open)';

    // Validate that EXPIRATION is greater than current BLOCK_TIME
    if(!error && !handler.util.isNull(data['EXPIRATION']) && handler.util.bclte(data['EXPIRATION'], data['BLOCK_TIME']))
        error = "invalid: EXPIRATION (past)";

    st.error = error;
}

// The ALLOW_LIST / BLOCK_LIST fields: a numeric list id must name a known LIST of a type
// this action accepts.
async function validateLists(handler, st){
    let { data } = st;
    let error = st.error;

    // Validate LIST fields (ALLOW_LIST / BLOCK_LIST)
    if(!error){
        for(let name of handler.config['LIST_FIELDS']){
            // Only look up and validate this list field when it holds a numeric list id
            if(!error && !handler.util.isNull(data[name]) && handler.util.isNumeric(data[name])){
                // Get LIST type and information
                let type = await handler.indexerDb.getListType(data[name]);

                // Verify LIST exist
                if(!error && type===false)
                    error = 'invalid: ' + name + ' (unknown)';

                // Verify LIST type is supported
                if(!error && !handler.listTypes.includes(type))
                    error = 'invalid: ' + name + ' (unsupported)';
            }
        }
    }

    st.error = error;
}

// Reserve GIVE_AMOUNT out of SOURCE's balances, so the fee check that follows sees what
// is left once the swap's escrow is taken.
function reserveGiveAmount(handler, st){
    let { format, data, isOwnershipGive, giveTokenInfo } = st;
    let error    = st.error;
    let balances = st.balances;

    // Verify SOURCE has enough balances to cover GIVE_AMOUNT (skip for ownership; no balance to escrow)
    if(!error && format==0 && !isOwnershipGive && !handler.util.hasBalance(balances, giveTokenInfo['TICK_ID'], data['GIVE_AMOUNT']))
        error = 'invalid: insufficient funds (GIVE_AMOUNT)';

    // Adjust balances to reduce by SWAP GIVE_AMOUNT (skip for ownership)
    if(!error && format==0 && !isOwnershipGive)
        balances = handler.util.debitBalances(balances, giveTokenInfo['TICK_ID'], data['GIVE_AMOUNT']);

    st.error    = error;
    st.balances = balances;
}

module.exports = { validateTickAndCoin, validateFormats, validateOwnership, validateGeneral, validateLists, reserveGiveAmount };
