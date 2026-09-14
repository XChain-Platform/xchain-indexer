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
 * DISPENSER handler part: VALIDATION.
 *
 * The TICK/COIN/FIAT rules, the general rules that run before the authority gates
 * the entry keeps, and the edit-time rules that run after them. Each block is the
 * original code moved whole and is called from parse() in the order it ran inline.
 *
 ********************************************************************/

'use strict';

const dispenserCaps = require('../../dispenser_caps_activation.js');

// Installed onto Dispenser.prototype by dispenser.js; each method runs with `this`
// bound to the handler, exactly as the inline code it was.
module.exports = {

    // TICK / COIN / FIAT validations (format 0 only, except where noted).
    async validateTickCoinFiat(ctx){
    let { data, error, format, giveTokenInfo, getTokenInfo } = ctx;

        // Validate GIVE_COIN is valid
        if(!error && format==0 && !this.config['COINS'].includes(data['GIVE_COIN']))
            error = 'invalid: GIVE_COIN (unsupported COIN network)';

        // Validate GET_COIN is valid
        if(!error && format==0 && !this.config['COINS'].includes(data['GET_COIN']))
            error = 'invalid: GET_COIN (unsupported COIN network)';

        // validate GIVE_COIN network is current COIN network
        if(!error && format==0 && this.config['COIN']!=data['GIVE_COIN'])
            error = "invalid: GIVE_COIN (network)";

        // validate GET_COIN network is current COIN network
        // TODO: cross-chain dispensers (GET_COIN != GIVE_COIN) are not currently wired; this guard enforces same-chain only
        if(!error && format==0 && this.config['COIN']!=data['GET_COIN'])
            error = "invalid: GET_COIN (network)";

        // Validate GIVE_TICK exists
        if(!error && format==0 && !giveTokenInfo)
            error = 'invalid: GIVE_TICK (unknown)';

        // Validate GET_TICK exists
        if(!error && format==0 && !this.util.isNull(data['GET_TICK']) && !getTokenInfo)
            error = 'invalid: GET_TICK (unknown)';

        // Validate FIAT_CODE is valid
        if(!error && format==0 && !this.util.isNull(data['FIAT_CODE']) && this.util.isNull(this.config['FIATS'][data['FIAT_CODE']]))
            error = 'invalid: FIAT_CODE (unsupported FIAT)';

        // Validate FIAT_CODE and FIAT_AMOUNT are both provided or both empty
        // Exception: when ORACLE_ADDRESS is set, the oracle provides the price so FIAT_AMOUNT is optional/ignored
        let usingOracle = !this.util.isNull(data['ORACLE_ADDRESS']);
        if(!error && format==0 && !this.util.isNull(data['FIAT_CODE']) && this.util.isNull(data['FIAT_AMOUNT']) && !usingOracle)
            error = 'invalid: FIAT_AMOUNT (required when FIAT_CODE is set without ORACLE_ADDRESS)';
        if(!error && format==0 && this.util.isNull(data['FIAT_CODE']) && !this.util.isNull(data['FIAT_AMOUNT']))
            error = 'invalid: FIAT_CODE (required when FIAT_AMOUNT is set)';

        // ORACLE_ADDRESS rules: only valid for FIAT-denominated dispensers, must be a valid crypto address
        if(!error && format==0 && usingOracle && this.util.isNull(data['FIAT_CODE']))
            error = 'invalid: FIAT_CODE (required when ORACLE_ADDRESS is set)';
        if(!error && format==0 && usingOracle && !this.util.isCryptoAddress(data['ORACLE_ADDRESS']))
            error = 'invalid: ORACLE_ADDRESS (format)';

    ctx.data = data;
    ctx.error = error;
    },

    // General validations that run BEFORE the GET_ADDRESS permission gate and the
    // owner-authority gate, both of which the entry keeps.
    async validateGeneralRules(ctx){
    let { data, error, format } = ctx;

        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        // Verify TICK is not sleeping
        if(!error && format==0 && await this.indexerDb.isActionAllowed(null, data['GIVE_TICK'], data['BLOCK_INDEX']) == false)
            error = 'invalid: TICK (sleeping)';

        // Verify no pipe in MEMO (pipe is field delimiter)
        if(!error && !this.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf('|')!=-1)
            error = 'invalid: MEMO (pipe)';

        // Verify no semicolon in MEMO (semicolon is action delimiter)
        if(!error && !this.util.isNull(data['MEMO']) && String(data['MEMO']).indexOf(';')!=-1)
            error = 'invalid: MEMO (semicolon)';

        // Verify MEMO is shorter than MAX_MEMO_LENGTH
        if(!error && String(data['MEMO']).length > this.config['MAX_MEMO_LENGTH'])
            error = 'invalid: MEMO (length)';

        // Verify TICK action is allowed from SOURCE (allow/block lists)
        if(!error && format==0 && await this.indexerDb.isActionAllowed(data['SOURCE'], data['GIVE_TICK']) == false)
            error = 'invalid: SOURCE (not authorized)';

        // Verify TICK action is allowed from GET_ADDRESS (allow/block lists)
        if(!error && format==0 && await this.indexerDb.isActionAllowed(data['GET_ADDRESS'], data['GIVE_TICK']) == false)
            error = 'invalid: GET_ADDRESS (not authorized)';

    ctx.data = data;
    ctx.error = error;
    },

    // Edit-time rules that run AFTER the authority gates: the ownership-escrow rule
    // and the MAX_REFILLS cap, both gated with the dispenser-family cohort.
    async validateDispenserEditRules(ctx){
    let { data, error, format, dispenserInfo } = ctx;

        // An ownership dispenser never holds balance escrow, on edit as on create.
        // isOwnershipGive is format-0 only, so a format-2 edit of an ownership
        // dispenser fell through as an ordinary refill: it debited GIVE_ESCROW
        // (below) while both terminal paths take the GIVE_OWNERSHIP branch that
        // credits nothing back (dispenser_close.js / dispenser_expire.js), stranding
        // the balance and breaking deposit = dispensed + remaining + refunded.
        // Mirrors the create-time rule verbatim rather than widening
        // isOwnershipGive, which would route these edits through the create-time
        // ownership block and wrongly reject expiration-only or list-only edits on
        // its isOwnershipEscrowed check. Gated with the dispenser-family cohort,
        // like MAX_REFILLS below, so replay below the flag-day stays byte-identical.
        if(!error && format==2 && Number(dispenserInfo['GIVE_OWNERSHIP']||0)==1 &&
           !this.util.isNull(data['GIVE_ESCROW']) &&
           dispenserCaps.isDispenserCapsActive(data['BLOCK_TIME'], this.config['NETWORK']))
            error = "invalid: GIVE_ESCROW (must be empty when GIVE_OWNERSHIP=1)";

        // MAX_REFILLS cap (see dispenser_caps_activation.js). A refill is a
        // format-2 DISPENSER_EDIT that tops up GIVE_ESCROW; each refill resets the
        // dispense count (derived since the last refill in dispense.js), and the 6th
        // refill is rejected (Counterparty parity). Rate/give-quantity are inherently
        // unchanged (format-2 edits carry only give_escrow/expiration/lists, never
        // give_amount/get_amount) and owner authority is enforced above. Gated with the
        // dispenser-family cohort so historical replay stays byte-identical below it.
        if(!error && format==2 && !this.util.isNull(data['GIVE_ESCROW']) &&
           this.util.bcgt(data['GIVE_ESCROW'], 0) &&
           dispenserCaps.isDispenserCapsActive(data['BLOCK_TIME'], this.config['NETWORK'])){
            let refills = await this.indexerDb.getDispenserRefillCount(data['DISPENSER_ACTION_INDEX']);
            if(refills >= this.config['MAX_REFILLS'])
                error = 'invalid: MAX_REFILLS (dispenser refill limit reached)';
        }

    ctx.data = data;
    ctx.error = error;
    },

    // Expiration, the LIST fields, and the GIVE_ESCROW balance check that debits
    // `balances` for the settlement below.
    async validateExpirationListsAndEscrow(ctx){
    let { data, error, isOwnershipGive, giveTokenInfo, balances } = ctx;

        // Validate that EXPIRATION is greater than current BLOCK_TIME
        if(!error && !this.util.isNull(data['EXPIRATION']) && this.util.bclte(data['EXPIRATION'], data['BLOCK_TIME']))
            error = "invalid: EXPIRATION (past)";

        // Validate LIST fields (ALLOW_LIST / BLOCK_LIST)
        if(!error){
            for(let name of this.config['LIST_FIELDS']){
                // Only check a LIST field that was actually set to a list ID
                if(!error && !this.util.isNull(data[name]) && this.util.isNumeric(data[name])){
                    // Get LIST type and information
                    let type = await this.indexerDb.getListType(data[name]);

                    // Verify LIST exist
                    if(!error && type===false)
                        error = 'invalid: ' + name + ' (unknown)';

                    // Verify LIST type is supported
                    if(!error && !this.listTypes.includes(type))
                        error = 'invalid: ' + name + ' (unsupported)';
                }
            }
        }

        // Verify SOURCE has enough balances to cover GIVE_ESCROW (skip for ownership: no balance to escrow)
        if(!error && !isOwnershipGive && !this.util.isNull(data['GIVE_ESCROW']) && !this.util.hasBalance(balances, giveTokenInfo['TICK_ID'], data['GIVE_ESCROW']))
            error = 'invalid: insufficient funds (GIVE_ESCROW)';

        // Adjust balances to reduce by dispenser GIVE_ESCROW (skip for ownership)
        if(!error && !isOwnershipGive && !this.util.isNull(data['GIVE_ESCROW']))
            balances = this.util.debitBalances(balances, giveTokenInfo['TICK_ID'], data['GIVE_ESCROW']);

    ctx.data = data;
    ctx.error = error;
    ctx.balances = balances;
    },
};

