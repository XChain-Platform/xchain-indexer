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
 * XChain Platform Action - STAKE
 *
 * Stakes tokens for hub validation (v1/v2 — BTC + XCHAIN only) or against
 * a smart contract (v3 — any chain, any registered token).
 *
 * The protocol does not assign tiers. Capabilities (price, cross_chain,
 * oracle_publish, attestation) auto-qualify when stake amount meets the
 * governance-configured min_stake for each. See:
 *   claude/reports/specs/2026-05-24_capability-staking-model.md
 *
 * FORMATS:
 *   v1 - VERSION|AMOUNT|SIGNING_PUBKEY                                              (create new capability stake)
 *   v2 - VERSION|AMOUNT|SIGNING_PUBKEY                                              (top-up existing capability stake)
 *   v3 - VERSION|AMOUNT|SIGNING_PUBKEY|TARGET_CONTRACT_INDEX|TICK                   (contract-targeted stake, multi-token)
 *
 * Capability staking (v1/v2): XCHAIN-only, qualifies for the four built-in
 * protocol capabilities by amount.
 *
 * Contract staking (v3): any token, targets a specific smart contract that
 * was deployed with cooldown_blocks + slash_destination metadata. New-vs-topup
 * is auto-detected based on whether (target, pubkey, tick) already has an
 * active row owned by the same source.
 *
 ********************************************************************/

class Stake {

    // Handle constructing a class instance
    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        // Define list of known FORMATS
        this.formats = {};
        this.formats[1] = 'VERSION|AMOUNT|SIGNING_PUBKEY';                                       // create new capability stake
        this.formats[2] = 'VERSION|AMOUNT|SIGNING_PUBKEY';                                       // top-up existing capability stake
        this.formats[3] = 'VERSION|AMOUNT|SIGNING_PUBKEY|TARGET_CONTRACT_INDEX|TICK';            // contract-targeted stake (any token)
    }

    // Handle parsing the STAKE transaction
    async parse(params, data, error){

        // Validate that format is known
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined))
            error = 'invalid: VERSION (unknown)';

        // v3 = contract-targeted stake — dispatch to its own handler (separate machinery)
        if(!error && format === 3){
            return await this._parseContractStake(params, data, error);
        }

        // Extract params (v1/v2 capability staking)
        data['AMOUNT']         = params[1];
        data['SIGNING_PUBKEY'] = params[2];

        // Convert NUMBER fields from string value to number value
        if(!error)
            data = this.util.setNumberFormats(data);

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

        /*****************************************************************
         * Format-Specific Stake Validation
         ****************************************************************/

        if(!error && format === 1){
            // v1 (new stake): pubkey must NOT already have any valid stake row
            // (pass blockIndex=null so the activation-window doesn't hide a
            // freshly-staked pubkey that hasn't activated yet)
            let anyStake = await this.indexerDb.getActiveStakeByPubkey(data['SIGNING_PUBKEY'], null);
            if(anyStake)
                error = 'invalid: SIGNING_PUBKEY (already in use)';

            // ... and must not be held by an active (or pending-activation)
            // delegation — mirrors the DELEGATE v0 collision rule so a key can
            // never be both a stake key and a delegated key (the effective
            // signer set would double-resolve it).
            if(!error){
                let existingDelegation = await this.indexerDb.getDelegationByPubkey(data['SIGNING_PUBKEY'], data['BLOCK_INDEX']);
                if(existingDelegation)
                    error = 'invalid: SIGNING_PUBKEY (already delegated)';
            }
        }

        if(!error && format === 2){
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
        }

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

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        // Print status message
        let label = (format === 2) ? 'STAKE topup' : 'STAKE';
        console.log("\t " + label + " : amount=" + data['AMOUNT'] + ' : pubkey=' + String(data['SIGNING_PUBKEY']).substring(0, 16) + '... : ' + data['STATUS']);

        // Create record in stakes table
        await this.indexerDb.createStake(data);

        // Store the SOURCE and GAS tick in addresses list
        this.util.addAddressTicker(data['SOURCE'], gas);

        // Array of credits and debits
        let credits = [],
            debits  = [];

        // If valid, debit the stake amount from SOURCE
        if(status == 'valid')
            debits.push([gas, data['AMOUNT'], data['SOURCE']]);

        // Process any transaction ledger changes (credits / debits)
        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits);

        // Get a list of tickers & addresses
        let tickers   = this.util.getTickersList(),
            addresses = Object.keys(this.util.getAddressesList());

        // Update address balances and token supply
        await this.indexerDb.updateBalances(addresses);
        await this.indexerDb.updateTokens(tickers);

        // Create action mappings
        await this.mapper.createMappings(data);
    }

    // STAKE v3 — contract-targeted stake. Separate machinery from v1/v2 capability
    // staking; writes to contract_stakes table and supports any token (not just XCHAIN).
    async _parseContractStake(params, data, error){

        // Extract params
        data['AMOUNT']                = params[1];
        data['SIGNING_PUBKEY']        = params[2];
        data['TARGET_CONTRACT_INDEX'] = params[3];
        data['TICK']                  = params[4];

        if(!error)
            data = this.util.setNumberFormats(data);

        // Basic field presence
        if(!error && (this.util.isNull(data['AMOUNT'])))
            error = 'invalid: AMOUNT (required)';
        if(!error && this.util.isNull(data['SIGNING_PUBKEY']))
            error = 'invalid: SIGNING_PUBKEY (required)';
        if(!error && this.util.isNull(data['TARGET_CONTRACT_INDEX']))
            error = 'invalid: TARGET_CONTRACT_INDEX (required)';
        if(!error && this.util.isNull(data['TICK']))
            error = 'invalid: TICK (required)';

        // SIGNING_PUBKEY format
        if(!error && !/^[0-9a-fA-F]{64}$/.test(String(data['SIGNING_PUBKEY'])))
            error = 'invalid: SIGNING_PUBKEY (format)';

        // TARGET_CONTRACT_INDEX must be a positive integer
        if(!error && (!/^[0-9]+$/.test(String(data['TARGET_CONTRACT_INDEX'])) || Number(data['TARGET_CONTRACT_INDEX']) <= 0))
            error = 'invalid: TARGET_CONTRACT_INDEX (format)';

        // Look up the target contract — must exist, be valid, and have opted into staking (cooldown_blocks NOT NULL)
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

        // Look up the tick — must exist
        let tickTokenInfo = null;
        if(!error){
            tickTokenInfo = await this.indexerDb.getTokenInfo(data['TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
            if(!tickTokenInfo)
                error = 'invalid: TICK (unknown)';
        }

        // AMOUNT validation — positive decimal, precision bounded by the token's decimals.
        // Trailing zeros in the fractional part are tolerated (so '200.00000000' against
        // a 0-decimal token reads as 200, semantically valid).
        if(!error){
            let amountStr = String(data['AMOUNT']);
            if(!/^[0-9]+(\.[0-9]+)?$/.test(amountStr)){
                error = 'invalid: AMOUNT (format)';
            } else {
                let decimals = (tickTokenInfo && tickTokenInfo['DECIMALS'] !== undefined) ? Number(tickTokenInfo['DECIMALS']) : 8;
                let parts = amountStr.split('.');
                // Strip trailing zeros from fractional part — they don't add precision
                let fracDigits = parts.length > 1 ? parts[1].replace(/0+$/, '').length : 0;
                if(fracDigits > decimals)
                    error = 'invalid: AMOUNT (exceeds token decimals)';
            }
        }
        if(!error && !this.util.bcgt(data['AMOUNT'], '0'))
            error = 'invalid: AMOUNT (must be greater than 0)';

        // Top-up vs. new — if (target, pubkey, tick) already has an active row,
        // it MUST be owned by the same SOURCE (otherwise reject pubkey-collision).
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

        // Balance check — source must hold the TICK amount
        let balances = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        if(!error && tickTokenInfo && !this.util.hasBalance(balances, tickTokenInfo['TICK_ID'], data['AMOUNT']))
            error = 'invalid: insufficient funds (TICK)';

        // Source must not be sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        // Activation delay — each chain sets its own calibrated default in STAKING (BTC 6 / LTC 24 / DOGE 60, ~60 min reorg protection per chain)
        let staking = this.config['STAKING'];
        let activationDelay = (staking && staking['ACTIVATION_DELAY_BLOCKS']) ? staking['ACTIVATION_DELAY_BLOCKS'] : this.config['ACTIVATION_DELAY_BLOCKS'];
        data['ACTIVATION_BLOCK'] = parseInt(data['BLOCK_INDEX']) + activationDelay;
        data['VERSION'] = 3;

        // Controller-bound token: a `stake`-class controller (or the catch-all `all`) on the staked
        // TICK may gate whether the token can be locked into this contract. Runs after all validation,
        // before settlement; SOURCE pays the bounded guard gas (billed in the valid block below).
        // Only the v3 contract-targeted path is gated — v1/v2 capability stakes are XCHAIN-only and
        // are never controller-gated.
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

        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        console.log("\t STAKE v3 : amount=" + data['AMOUNT'] +
            ' : pubkey=' + String(data['SIGNING_PUBKEY']).substring(0, 16) +
            '... : target=' + data['TARGET_CONTRACT_INDEX'] +
            ' : tick=' + data['TICK'] +
            ' : ' + data['STATUS']);

        // Write the contract_stakes row
        await this.indexerDb.createContractStake(data);

        // Track tickers/addresses for balance reconciliation
        this.util.addAddressTicker(data['SOURCE'], data['TICK']);

        // Debit the stake amount from SOURCE
        let credits = [],
            debits  = [];
        if(status === 'valid'){
            debits.push([data['TICK'], data['AMOUNT'], data['SOURCE']]);
            // Bill the controller-guard gas to SOURCE (GAS burn, no offsetting credit). updateTokens
            // below already recomputes GAS supply so the per-block sanityCheck stays balanced.
            if(this.util.bcgt(guardFee, 0)){
                debits.push([this.config['GAS'], guardFee, data['SOURCE']]);
                this.util.addAddressTicker(data['SOURCE'], this.config['GAS']);
            }
        }

        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits);

        let tickers   = this.util.getTickersList(),
            addresses = Object.keys(this.util.getAddressesList());
        await this.indexerDb.updateBalances(addresses);
        await this.indexerDb.updateTokens(tickers);

        await this.mapper.createMappings(data);
    }
}

module.exports = Stake;
