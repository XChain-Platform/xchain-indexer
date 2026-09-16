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
 * STAKE v3: contract-targeted stake. Separate machinery from v1/v2 capability
 * staking; writes to contract_stakes table and supports any token (not just XCHAIN).
 *
 * The parts are the phases the handler always had, in the order it ran them: wire
 * fields, the target contract and tick, AMOUNT, the top-up owner rule, funds and
 * sleep, the controller guard, then settlement. The order is consensus (every read
 * that interns an id must happen on every node), so it does not change here.
 *
 * Every function is called with the handler as `this`, the way
 * execute/slash_emission.js is.
 *
 ********************************************************************/

'use strict';

const { getLogger } = require('../../observability/index.js');

/**
 * The v3 entry, reached from Stake.parse on FORMAT 3.
 *
 * @param {Array<string>} params - the raw wire fields, VERSION first
 * @param {Object}        data   - the action row under construction
 * @param {string|null}   error  - a verdict an earlier gate already reached
 * @returns {Promise<void>}
 */
async function parseContractStake(params, data, error){

    // Extract params
    data['AMOUNT']                = params[1];
    data['SIGNING_PUBKEY']        = params[2];
    data['TARGET_CONTRACT_INDEX'] = params[3];
    data['TICK']                  = params[4];

    // Convert NUMBER fields from string value to number value
    if(!error)
        data = this.util.setNumberFormats(data);

    error = await validateWireFields.call(this, data, error);

    let targets = await resolveStakeTargets.call(this, data, error);
    error = targets.error;

    error = validateStakeAmount.call(this, data, targets.tickTokenInfo, error);

    error = await validateStakeOwner.call(this, data, error);

    // Balance check: source must hold the TICK amount
    let balances = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
    if(!error && targets.tickTokenInfo && !this.util.hasBalance(balances, targets.tickTokenInfo['TICK_ID'], data['AMOUNT']))
        error = 'invalid: insufficient funds (TICK)';

    // Source must not be sleeping
    if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
        error = 'invalid: SOURCE (sleeping)';

    // Activation delay: each chain sets its own calibrated default in STAKING
    // (BTC 6 / LTC 24 / DOGE 60, roughly 60 min reorg protection per chain)
    let staking = this.config['STAKING'];
    let activationDelay = (staking && staking['ACTIVATION_DELAY_BLOCKS']) ? staking['ACTIVATION_DELAY_BLOCKS'] : this.config['ACTIVATION_DELAY_BLOCKS'];
    data['ACTIVATION_BLOCK'] = parseInt(data['BLOCK_INDEX']) + activationDelay;
    data['VERSION'] = 3;

    let guard = await runStakeControllerGuard.call(this, data, targets.tickTokenInfo, balances, error);

    await settleContractStake.call(this, data, guard.guardFee, guard.error);
}

/**
 * Wire-field presence and shape: AMOUNT, SIGNING_PUBKEY, TARGET_CONTRACT_INDEX, TICK.
 *
 * @param {Object}      data  - the action row; reads the four wire fields
 * @param {string|null} error - the verdict so far
 * @returns {Promise<string|null>} the verdict after these checks
 */
async function validateWireFields(data, error){

    // Basic field presence
    if(!error && (this.util.isNull(data['AMOUNT'])))
        error = 'invalid: AMOUNT (required)';
    // Verify SIGNING_PUBKEY is provided (the key the stake is recorded under)
    if(!error && this.util.isNull(data['SIGNING_PUBKEY']))
        error = 'invalid: SIGNING_PUBKEY (required)';
    // Verify TARGET_CONTRACT_INDEX is provided (a v3 stake must name the contract it is staked against)
    if(!error && this.util.isNull(data['TARGET_CONTRACT_INDEX']))
        error = 'invalid: TARGET_CONTRACT_INDEX (required)';
    // Verify TICK is provided (a v3 stake can lock any token, so it must say which one)
    if(!error && this.util.isNull(data['TICK']))
        error = 'invalid: TICK (required)';

    // SIGNING_PUBKEY format
    if(!error && !/^[0-9a-fA-F]{64}$/.test(String(data['SIGNING_PUBKEY'])))
        error = 'invalid: SIGNING_PUBKEY (format)';

    // TARGET_CONTRACT_INDEX must be a positive integer. At/after the CONTRACT_INDEX_CANONICAL
    // flag-day reject non-canonical leading zeros (/^[1-9]\d*$/, matching deposit/withdraw);
    // below it the legacy /^[0-9]+$/ is preserved for replay/fleet consistency.
    let idxRe = (await this.actions.protocolChanges.isEnabled('CONTRACT_INDEX_CANONICAL', data['BLOCK_INDEX'])) ? /^[1-9]\d*$/ : /^[0-9]+$/;
    if(!error && (!idxRe.test(String(data['TARGET_CONTRACT_INDEX'])) || Number(data['TARGET_CONTRACT_INDEX']) <= 0))
        error = 'invalid: TARGET_CONTRACT_INDEX (format)';

    return error;
}

/**
 * Resolve what the stake targets: the contract it bonds to and the token it locks.
 *
 * @param {Object}      data  - the action row; reads TARGET_CONTRACT_INDEX and TICK
 * @param {string|null} error - the verdict so far
 * @returns {Promise<{contractInfo: (Object|null), tickTokenInfo: (Object|null),
 *                    error: (string|null)}>}
 */
async function resolveStakeTargets(data, error){

    // Look up the target contract: must exist, be valid, and have opted into staking (cooldown_blocks NOT NULL)
    let contractInfo = null;
    if(!error){
        contractInfo = await this.indexerDb.getContract(data['TARGET_CONTRACT_INDEX']);
        if(!contractInfo){
            error = 'invalid: TARGET_CONTRACT_INDEX (unknown)';
        } else {
            let st = await this.indexerDb.getStatusString(contractInfo.status_id);
            if(st !== 'valid')
                error = 'invalid: TARGET_CONTRACT_INDEX (contract not active)';
            else if(contractInfo.cooldown_blocks === null || contractInfo.cooldown_blocks === undefined)
                error = 'invalid: TARGET_CONTRACT_INDEX (contract is not stakeable)';
        }
    }

    // Look up the tick (must exist)
    let tickTokenInfo = null;
    if(!error){
        tickTokenInfo = await this.indexerDb.getTokenInfo(data['TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
        if(!tickTokenInfo)
            error = 'invalid: TICK (unknown)';
    }

    return { contractInfo: contractInfo, tickTokenInfo: tickTokenInfo, error: error };
}

/**
 * AMOUNT validation: positive decimal, precision bounded by the token's decimals.
 * Trailing zeros in the fractional part are tolerated (so '200.00000000' against
 * a 0-decimal token reads as 200, semantically valid).
 *
 * @param {Object}      data          - the action row; reads AMOUNT
 * @param {Object|null} tickTokenInfo - the staked token's row, for DECIMALS
 * @param {string|null} error         - the verdict so far
 * @returns {string|null} the verdict after these checks
 */
function validateStakeAmount(data, tickTokenInfo, error){

    if(!error){
        let amountStr = String(data['AMOUNT']);
        if(!/^[0-9]+(\.[0-9]+)?$/.test(amountStr)){
            error = 'invalid: AMOUNT (format)';
        } else {
            let decimals = (tickTokenInfo && tickTokenInfo['DECIMALS'] !== undefined) ? Number(tickTokenInfo['DECIMALS']) : 8;
            let parts = amountStr.split('.');
            // Strip trailing zeros from fractional part (they add no precision)
            let fracDigits = parts.length > 1 ? parts[1].replace(/0+$/, '').length : 0;
            if(fracDigits > decimals)
                error = 'invalid: AMOUNT (exceeds token decimals)';
        }
    }
    if(!error && !this.util.bcgt(data['AMOUNT'], '0'))
        error = 'invalid: AMOUNT (must be greater than 0)';

    return error;
}

/**
 * Top-up vs. new: if (target, pubkey, tick) already has an active row,
 * it MUST be owned by the same SOURCE (otherwise reject pubkey-collision).
 *
 * @param {Object}      data  - the action row; reads TARGET_CONTRACT_INDEX, SIGNING_PUBKEY, TICK, SOURCE
 * @param {string|null} error - the verdict so far
 * @returns {Promise<string|null>} the verdict after this check
 */
async function validateStakeOwner(data, error){

    if(!error){
        let ownerId = await this.indexerDb.getContractStakeOwner(
            data['TARGET_CONTRACT_INDEX'], data['SIGNING_PUBKEY'], data['TICK']
        );
        if(ownerId !== null){
            let sourceId = await this.indexerDb.getAddressId(data['SOURCE']);
            if(sourceId === null || Number(sourceId) !== Number(ownerId))
                error = 'invalid: SIGNING_PUBKEY (already staked to this contract by another source)';
        }
    }

    return error;
}

/**
 * Controller-bound token: a `stake`-class controller (or the catch-all `all`) on the staked
 * TICK may gate whether the token can be locked into this contract. Runs after all validation,
 * before settlement; SOURCE pays the bounded guard gas (billed in the valid block below).
 * Only the v3 contract-targeted path is gated; v1/v2 capability stakes are XCHAIN-only and
 * are never controller-gated.
 *
 * @param {Object}      data          - the action row
 * @param {Object|null} tickTokenInfo - the staked token's row
 * @param {Object}      balances      - the source's balances, read at this action
 * @param {string|null} error         - the verdict so far
 * @returns {Promise<{guardFee: (string|number), error: (string|null)}>}
 */
async function runStakeControllerGuard(data, tickTokenInfo, balances, error){

    let guardFee = 0;
    if(!error && tickTokenInfo){
        let gasInfo = await this.indexerDb.getTokenInfo(this.config['GAS'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let result  = await this.util.maybeRunControllerGuard(this.actions, this.indexerDb, {
            actionType:  'STAKE',
            tick:        data['TICK'],
            from:        data['SOURCE'],
            amount:      data['AMOUNT'],
            data:        data,
            gasInfo:     gasInfo,
            gasBalances: balances
        });
        if(result.error)
            error = 'invalid: ' + result.error;
        else
            guardFee = result.guardFee;
    }

    // Combined GAS debit: when the staked TICK is the GAS token, the stake AMOUNT and the controller
    // guard-fee BOTH debit GAS, but each was balance-checked independently against the same
    // snapshot, so their sum could exceed the balance and drive GAS negative. Re-verify the
    // COMBINED debit against the single GAS balance. Naturally inert below the CONTROLLER_GUARD
    // flag-day (guardFee is 0 there, so this reduces to the AMOUNT check already done above).
    if(!error && tickTokenInfo && this.util.bcgt(guardFee, 0) && String(data['TICK']) === String(this.config['GAS'])){
        if(!this.util.hasBalance(balances, tickTokenInfo['TICK_ID'], this.util.bcadd(data['AMOUNT'], guardFee, 8)))
            error = 'invalid: insufficient funds (STAKE + guard fee)';
    }

    return { guardFee: guardFee, error: error };
}

/**
 * Write the verdict, the contract_stakes row and the ledger effect of a valid v3 stake.
 *
 * @param {Object}        data     - the action row; writes STATUS
 * @param {string|number} guardFee - the controller guard gas the source pays
 * @param {string|null}   error    - the verdict every check above reached
 * @returns {Promise<void>}
 */
async function settleContractStake(data, guardFee, error){

    let status = (error) ? error : 'valid';
    data['STATUS'] = status;

    getLogger().info("\t STAKE v3 : amount=" + this.util.logAmount(data['AMOUNT']) +
        ' : pubkey=' + String(data['SIGNING_PUBKEY']).substring(0, 16) +
        '... : target=' + data['TARGET_CONTRACT_INDEX'] +
        ' : tick=' + data['TICK'] +
        ' : ' + data['STATUS']);

    // Write the contract_stakes row
    await this.indexerDb.createContractStake(data);

    // Track tickers/addresses for balance reconciliation
    this.util.addAddressTicker(data['SOURCE'], data['TICK']);

    // Array of credits, debits, and escrows
    let credits = [],
        debits  = [],
        escrows = [];
    if(status === 'valid')
        planContractStakeLedger.call(this, data, guardFee, debits, escrows);

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

/**
 * The ledger plan of a valid v3 stake: the locked amount and the burned guard fee.
 *
 * @param {Object}        data     - the action row; reads TICK, AMOUNT, SOURCE
 * @param {string|number} guardFee - the controller guard gas the source pays
 * @param {Array}         debits   - the debit rows to fill
 * @param {Array}         escrows  - the escrow rows to fill
 * @returns {void}
 */
function planContractStakeLedger(data, guardFee, debits, escrows){

    // A stake LOCKS the tokens; it does not destroy them. The debit takes them out of
    // the staker's spendable balance and the matching escrow row holds them, exactly
    // as ORDER and DISPENSER do (order.js:472). The pair is net-zero on
    // `ledger = credits - debits + escrows`, so total supply is unchanged and the
    // staked amount stays inside the equation instead of leaving the system.
    //
    // Before this, the debit stood alone. That did not trip the per-block sanityCheck,
    // and could not: tokens.supply is not independent, getTokenSupply COMPUTES it as
    // credits - debits + escrows, and updateTokens runs right below. So an uncountered
    // debit shrank the ledger, supply followed it down, balances fell by the same
    // debit, and all three sides agreed while the tokens left the system. Measured on
    // testnet, five capability stakes had 125,000 XCHAIN unaccounted for this way.
    debits.push([data['TICK'], data['AMOUNT'], data['SOURCE']]);
    escrows.push([data['TICK'], data['AMOUNT'], data['SOURCE']]);
    // The controller-guard gas is a genuine BURN, so it stays a lone debit with no
    // escrow row: those tokens really are destroyed and supply really should fall.
    if(this.util.bcgt(guardFee, 0)){
        debits.push([this.config['GAS'], guardFee, data['SOURCE']]);
        this.util.addAddressTicker(data['SOURCE'], this.config['GAS']);
    }
}

module.exports = {
    parseContractStake
};
