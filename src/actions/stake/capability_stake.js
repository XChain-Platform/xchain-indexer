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
 * STAKE v1/v2: capability staking. XCHAIN-only, BTC-only, qualifies for the
 * four built-in protocol capabilities by amount; v1 creates a stake, v2 tops
 * one up.
 *
 * The parts are the phases the handler always had, in the order it ran them: wire
 * fields, the chain, AMOUNT and SIGNING_PUBKEY shape, the v1 free-key rule or the
 * v2 top-up owner rule, funds and sleep, activation, then settlement. The order is
 * consensus (every read that interns an id must happen on every node), so it does
 * not change here.
 *
 * Every function is called with the handler as `this`, the way
 * contract_stake.js is.
 *
 ********************************************************************/

'use strict';

const gateRegistry = require('../../consensus/gate_registry');

const { getLogger } = require('../../observability/index.js');

/**
 * The v1/v2 entry, reached from Stake.parse once FORMAT is known and is not 3.
 *
 * @param {Array<string>} params - the raw wire fields, VERSION first
 * @param {Object}        data   - the action row under construction
 * @param {string|null}   error  - a verdict an earlier gate already reached
 * @param {number}        format - the wire VERSION, 1 or 2
 * @returns {Promise<void>}
 */
async function parseCapabilityStake(params, data, error, format){

    // Extract params (v1/v2 capability staking)
    data['AMOUNT']         = params[1];
    data['SIGNING_PUBKEY'] = params[2];

    // Convert NUMBER fields from string value to number value
    if(!error)
        data = this.util.setNumberFormats(data);

    error = validateCapabilityWire.call(this, data, error);

    /*****************************************************************
     * Format-Specific Stake Validation
     ****************************************************************/
    if(!error && format === 1)
        error = await validateFreeKey.call(this, data);

    if(!error && format === 2)
        error = await validateTopUpOwner.call(this, data);

    /*****************************************************************
     * Balance Validations
     ****************************************************************/
    let gas = this.config['GAS'];
    let tokenInfo = await this.indexerDb.getTokenInfo(gas, data['BLOCK_INDEX'], data['ACTION_INDEX']);
    let balances  = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);

    // Verify SOURCE has sufficient XCHAIN balance for AMOUNT
    if(!error && tokenInfo && !this.util.hasBalance(balances, tokenInfo['TICK_ID'], data['AMOUNT']))
        error = 'invalid: insufficient funds (STAKE)';

    // Verify SOURCE is not sleeping
    if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
        error = 'invalid: SOURCE (sleeping)';

    /*****************************************************************
     * Activation Calculation
     ****************************************************************/
    let staking = this.config['STAKING'];
    let activationDelay = (staking && staking['ACTIVATION_DELAY_BLOCKS']) ? staking['ACTIVATION_DELAY_BLOCKS'] : this.config['ACTIVATION_DELAY_BLOCKS'];
    data['ACTIVATION_BLOCK'] = parseInt(data['BLOCK_INDEX']) + activationDelay;
    data['VERSION'] = format;

    await settleCapabilityStake.call(this, data, gas, format, error);
}

/**
 * The wire-only checks: chain, AMOUNT shape and sign, SIGNING_PUBKEY presence and shape.
 * No database read, so a refused shape never interns an id.
 *
 * @param {Object}      data  - the action row; reads COIN, AMOUNT, SIGNING_PUBKEY
 * @param {string|null} error - the verdict so far
 * @returns {string|null} the verdict after these checks
 */
function validateCapabilityWire(data, error){

    /*****************************************************************
     * Chain Restriction
     ****************************************************************/
    // STAKE is BTC-only
    if(!error && data['COIN'] !== 'BTC')
        error = 'invalid: ACTION (BTC only)';

    /*****************************************************************
     * AMOUNT Validations
     ****************************************************************/
    // AMOUNT must be a positive 8-decimal string
    if(!error && (this.util.isNull(data['AMOUNT']) || !/^[0-9]+(\.[0-9]{1,8})?$/.test(String(data['AMOUNT']))))
        error = 'invalid: AMOUNT (format)';
    // Verify AMOUNT is greater than zero (an empty stake would bond nothing)
    if(!error && !this.util.bcgt(data['AMOUNT'], '0'))
        error = 'invalid: AMOUNT (must be greater than 0)';

    /*****************************************************************
     * SIGNING_PUBKEY Validations
     ****************************************************************/

    // Verify SIGNING_PUBKEY is provided
    if(!error && this.util.isNull(data['SIGNING_PUBKEY']))
        error = 'invalid: SIGNING_PUBKEY (required)';

    // Verify SIGNING_PUBKEY is 64 hex characters (Ed25519)
    if(!error && !/^[0-9a-fA-F]{64}$/.test(String(data['SIGNING_PUBKEY'])))
        error = 'invalid: SIGNING_PUBKEY (format)';

    return error;
}

/**
 * v1 (new stake): the pubkey must be FREE of every stake and delegation that holds it.
 * Called only while no verdict has been reached.
 *
 * @param {Object} data - the action row; reads SIGNING_PUBKEY, BLOCK_INDEX, COIN
 * @returns {Promise<string|null>} the verdict, or null when the key is free
 */
async function validateFreeKey(data){

    let error = null;

    // v1 (new stake): the pubkey must be FREE. Which rows count as holding it is
    // the one thing the stake-key-reuse flag day moves; the verdict string is
    // identical on both sides, so only the admitted set changes.
    //
    // At/after the gate a key is free when EVERY valid stakes row it has ever held
    // is deactivated AND past cooldown, so a key that unstaked voluntarily or that
    // ROLLCALL evicted can stake again. Rows that are active, pending activation,
    // or deactivated but still inside cooldown still hold it.
    //
    // Below the gate the legacy predicate runs byte for byte: blockIndex=null,
    // which in db.js drops the whole activation/deactivation clause and so refuses
    // any pubkey with a valid stakes row EVER. That null is also why the armed
    // branch cannot simply pass the real block to the same mode: the legacy
    // predicate's activation filter would hide a freshly-staked, not-yet-activated
    // row, so the armed branch selects its own query mode instead
    // (the stake_key_reuse_activation row's note records the whole argument).
    let anyStake;
    if(gateRegistry.activeAt('stake_key_reuse_activation.STAKE_KEY_REUSE_ACTIVATION', this.config['NETWORK'], data['COIN'], data['BLOCK_INDEX'], null))
        anyStake = await this.indexerDb.getActiveStakeByPubkey(data['SIGNING_PUBKEY'], data['BLOCK_INDEX'], {reuseBlockingOnly: true});
    else
        anyStake = await this.indexerDb.getActiveStakeByPubkey(data['SIGNING_PUBKEY'], null);
    if(anyStake)
        error = 'invalid: SIGNING_PUBKEY (already in use)';

    // ... and must not be held by an active (or pending-activation)
    // delegation (mirrors the DELEGATE v0 collision rule so a key can
    // never be both a stake key and a delegated key, because the effective
    // signer set would double-resolve it).
    if(!error){
        let existingDelegation = await this.indexerDb.getDelegationByPubkey(data['SIGNING_PUBKEY'], data['BLOCK_INDEX']);
        if(existingDelegation)
            error = 'invalid: SIGNING_PUBKEY (already delegated)';
    }

    return error;
}

/**
 * v2 (top-up): the pubkey must have an active stake, and SOURCE must own it.
 * Called only while no verdict has been reached.
 *
 * @param {Object} data - the action row; reads SIGNING_PUBKEY, BLOCK_INDEX, SOURCE
 * @returns {Promise<string|null>} the verdict, or null when SOURCE may top up
 */
async function validateTopUpOwner(data){

    let error = null;

    // v2 (top-up): pubkey MUST have an active stake owned by SOURCE
    let activeStake = await this.indexerDb.getActiveStakeByPubkey(
        data['SIGNING_PUBKEY'], data['BLOCK_INDEX']
    );
    if(!activeStake){
        error = 'invalid: SIGNING_PUBKEY (no active stake to top up)';
    } else {
        let sourceId = await this.indexerDb.getAddressId(data['SOURCE']);
        if(sourceId === null || Number(sourceId) !== Number(activeStake.source_id))
            error = 'invalid: SOURCE (does not own this stake)';
    }

    return error;
}

/**
 * Write the verdict, the stakes row and the ledger effect of a valid v1/v2 stake.
 *
 * @param {Object}      data   - the action row; writes STATUS
 * @param {string}      gas    - the GAS tick the bond is taken in
 * @param {number}      format - the wire VERSION, 1 or 2 (picks the log label)
 * @param {string|null} error  - the verdict every check above reached
 * @returns {Promise<void>}
 */
async function settleCapabilityStake(data, gas, format, error){

    // Determine final status
    let status = (error) ? error : 'valid';
    data['STATUS'] = status;

    // Print status message
    let label = (format === 2) ? 'STAKE topup' : 'STAKE';
    getLogger().info("\t " + label + " : amount=" + this.util.logAmount(data['AMOUNT']) + ' : pubkey=' + String(data['SIGNING_PUBKEY']).substring(0, 16) + '... : ' + data['STATUS']);

    // Create record in stakes table
    await this.indexerDb.createStake(data);

    // Store the SOURCE and GAS tick in addresses list
    this.util.addAddressTicker(data['SOURCE'], gas);

    // Array of credits, debits, and escrows
    let credits = [],
        debits  = [],
        escrows = [];

    // If valid, debit the stake amount from SOURCE
    if(status == 'valid'){
        // A capability bond is LOCKED, not destroyed - same rule as a contract stake and
        // as every ORDER, SWAP, DISPENSER and BET before it. The debit takes the bond out
        // of spendable balance, the escrow row holds it, and the pair is net-zero on
        // `ledger = credits - debits + escrows`, so total supply does not move.
        debits.push([gas, data['AMOUNT'], data['SOURCE']]);
        escrows.push([gas, data['AMOUNT'], data['SOURCE']]);
    }

    // Process any transaction ledger changes (credits / debits)
    await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits, escrows);

    // Get a list of tickers & addresses
    let tickers   = this.util.getTickersList(),
        addresses = Object.keys(this.util.getAddressesList());

    // Update address balances and token supply
    await this.indexerDb.updateBalances(addresses);
    await this.indexerDb.updateTokens(tickers);

    // Create action mappings
    await this.mapper.createMappings(data);
}

module.exports = {
    parseCapabilityStake
};
