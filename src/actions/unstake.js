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
 * XChain Platform Action - UNSTAKE
 *
 * Begins the unstaking cooldown for an active stake.
 *   v0 (capability): BTC-only; unwinds all rows for the pubkey (original + top-ups).
 *   v1 (contract):   any chain; scoped to a single (target, pubkey, tick) triple.
 *
 * FORMATS:
 *   v0 - VERSION|SIGNING_PUBKEY                                       (capability stake, all rows for pubkey)
 *   v1 - VERSION|SIGNING_PUBKEY|TARGET_CONTRACT_INDEX|TICK            (contract-targeted stake, per (target, tick))
 *
 ********************************************************************/

class Unstake {

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
        this.formats[0] = 'VERSION|SIGNING_PUBKEY';                                          // capability unstake
        this.formats[1] = 'VERSION|SIGNING_PUBKEY|TARGET_CONTRACT_INDEX|TICK';               // contract-targeted unstake
    }

    // Handle parsing the UNSTAKE transaction
    async parse(params, data, error){

        // Validate that format is known
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined))
            error = 'invalid: VERSION (unknown)';

        // v1 = contract-targeted unstake; dispatch to its own handler
        if(!error && format === 1){
            return await this._parseContractUnstake(params, data, error);
        }

        // Extract params (v0 capability unstake)
        data['SIGNING_PUBKEY'] = params[1];

        // Convert NUMBER fields from string value to number value
        if(!error)
            data = this.util.setNumberFormats(data);

        /*****************************************************************
         * Chain Restriction
         ****************************************************************/

        // UNSTAKE is BTC-only
        if(!error && data['COIN'] !== 'BTC')
            error = 'invalid: ACTION (BTC only)';

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
         * Stake Existence Validations
         ****************************************************************/

        // Verify the pubkey has an active stake owned by SOURCE
        let totalAmount = '0';
        if(!error){
            // undeactivatedOnly: an UNSTAKE may only target stake that is not already
            // being unstaked. A second UNSTAKE inside the activation-delay window would
            // otherwise re-read the same still-"active" rows and write a duplicate
            // cooldown credit (double-credit, item 4617).
            let aggregate = await this.indexerDb.getActiveStakeByPubkey(data['SIGNING_PUBKEY'], data['BLOCK_INDEX'], {undeactivatedOnly: true});
            if(!aggregate){
                error = 'invalid: SIGNING_PUBKEY (no active stake or unstake already in progress)';
            } else {
                let sourceId = await this.indexerDb.getAddressId(data['SOURCE']);
                if(sourceId === null || Number(sourceId) !== Number(aggregate.source_id))
                    error = 'invalid: SOURCE (does not own this stake)';
                else
                    totalAmount = aggregate.amount;
            }
        }

        // Verify SOURCE is not sleeping
        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        /*****************************************************************
         * Cooldown / Deactivation Calculation
         ****************************************************************/

        let staking         = this.config['STAKING'];
        let cooldownBlocks  = (staking && staking['COOLDOWN_BLOCKS'])         ? staking['COOLDOWN_BLOCKS']         : 1000;
        let activationDelay = (staking && staking['ACTIVATION_DELAY_BLOCKS']) ? staking['ACTIVATION_DELAY_BLOCKS'] : this.config['ACTIVATION_DELAY_BLOCKS'];
        data['COOLDOWN_END_BLOCK'] = parseInt(data['BLOCK_INDEX']) + cooldownBlocks;
        data['AMOUNT']             = totalAmount;

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        // Print status message
        console.log("\t UNSTAKE : pubkey=" + String(data['SIGNING_PUBKEY']).substring(0, 16) + '... : amount=' + data['AMOUNT'] + ' : ' + data['STATUS']);

        // Create record in unstakes table
        await this.indexerDb.createUnstake(data);

        // Mark all active stake rows for this pubkey with deactivation_block
        // (validator continues to participate for ACTIVATION_DELAY_BLOCKS blocks before being removed from active set)
        if(status === 'valid')
            await this.indexerDb.setStakeDeactivationByPubkey(
                data['SIGNING_PUBKEY'],
                parseInt(data['BLOCK_INDEX']) + activationDelay,
                parseInt(data['BLOCK_INDEX'])
            );

        // Store the SOURCE and GAS tick in addresses list
        let gas = this.config['GAS'];
        this.util.addAddressTicker(data['SOURCE'], gas);

        // Array of credits and debits
        let credits = [],
            debits  = [];

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

    // UNSTAKE v1: contract-targeted unstake. Writes to contract_unstakes table,
    // sets deactivation_block on the matching contract_stakes rows, uses the contract's
    // own cooldown_blocks (vs. the global 1000 used for capability staking).
    async _parseContractUnstake(params, data, error){

        // Extract params
        data['SIGNING_PUBKEY']        = params[1];
        data['TARGET_CONTRACT_INDEX'] = params[2];
        data['TICK']                  = params[3];

        if(!error)
            data = this.util.setNumberFormats(data);

        if(!error && this.util.isNull(data['SIGNING_PUBKEY']))
            error = 'invalid: SIGNING_PUBKEY (required)';
        if(!error && !/^[0-9a-fA-F]{64}$/.test(String(data['SIGNING_PUBKEY'])))
            error = 'invalid: SIGNING_PUBKEY (format)';
        if(!error && this.util.isNull(data['TARGET_CONTRACT_INDEX']))
            error = 'invalid: TARGET_CONTRACT_INDEX (required)';
        // STAKE-1 (gated by CONTRACT_INDEX_CANONICAL): reject non-canonical leading zeros at/after the flag-day.
        let idxRe = (await this.actions.protocolChanges.isEnabled('CONTRACT_INDEX_CANONICAL', data['BLOCK_INDEX'])) ? /^[1-9]\d*$/ : /^[0-9]+$/;
        if(!error && (!idxRe.test(String(data['TARGET_CONTRACT_INDEX'])) || Number(data['TARGET_CONTRACT_INDEX']) <= 0))
            error = 'invalid: TARGET_CONTRACT_INDEX (format)';
        if(!error && this.util.isNull(data['TICK']))
            error = 'invalid: TICK (required)';

        // Load the contract to fetch its cooldown_blocks
        let contractInfo = null;
        if(!error){
            contractInfo = await this.indexerDb.getContract(data['TARGET_CONTRACT_INDEX']);
            if(!contractInfo){
                error = 'invalid: TARGET_CONTRACT_INDEX (unknown)';
            } else if(contractInfo.cooldown_blocks === null || contractInfo.cooldown_blocks === undefined){
                error = 'invalid: TARGET_CONTRACT_INDEX (contract is not stakeable)';
            }
        }

        // Verify the (target, pubkey, tick) has an active contract-stake owned by SOURCE
        let totalAmount = '0';
        if(!error){
            let aggregate = await this.indexerDb.getActiveContractStakeByPubkey(
                data['TARGET_CONTRACT_INDEX'], data['SIGNING_PUBKEY'], data['TICK'], data['BLOCK_INDEX'], {undeactivatedOnly: true}
            );
            if(!aggregate){
                error = 'invalid: SIGNING_PUBKEY (no active stake on contract for this tick)';
            } else {
                let sourceId = await this.indexerDb.getAddressId(data['SOURCE']);
                if(sourceId === null || Number(sourceId) !== Number(aggregate.source_id))
                    error = 'invalid: SOURCE (does not own this stake)';
                else
                    totalAmount = aggregate.amount;
            }
        }

        if(!error && await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
            error = 'invalid: SOURCE (sleeping)';

        let staking         = this.config['STAKING'];
        let activationDelay = (staking && staking['ACTIVATION_DELAY_BLOCKS']) ? staking['ACTIVATION_DELAY_BLOCKS'] : this.config['ACTIVATION_DELAY_BLOCKS'];
        data['AMOUNT']             = totalAmount;

        // Pkg6 / 048fdea9 + ce6a484f (gated UNSTAKE_CONTRACT_COOLDOWN_STRICT): the cooldown is
        // the target contract's own validated stake parameter (DEPLOY enforces an integer in
        // [1,100000]). The legacy ternary fell back to the capability global 1000 whenever the
        // contract cooldown_blocks was falsy - a DEAD branch on the valid path (195-197 already
        // rejects a null/non-stakeable cooldown) that nonetheless FIRED on every ERROR path
        // (unknown target / not-stakeable / no-active-stake -> contractInfo null/absent),
        // persisting a phantom BLOCK_INDEX+1000 cooldown_end_block into the INVALID
        // contract_unstakes row (a replicated, state_hash-covered column). At/after the flag-day:
        // reject a non-positive-integer contract cooldown outright (closes the latent cross-file
        // trap) and compute COOLDOWN_END_BLOCK only on the valid path, leaving error rows at 0.
        // The valid-path value is unchanged. Below it: byte-identical to the legacy ternary so a
        // from-genesis replay / heterogeneous fleet reproduces the historic (phantom-1000)
        // error-row values.
        if(await this.actions.protocolChanges.isEnabled('UNSTAKE_CONTRACT_COOLDOWN_STRICT', data['BLOCK_INDEX'])){
            if(!error){
                let cb = Number(contractInfo.cooldown_blocks);
                if(!Number.isInteger(cb) || cb < 1)
                    error = 'invalid: TARGET_CONTRACT_INDEX (contract cooldown invalid)';
            }
            data['COOLDOWN_END_BLOCK'] = (!error) ? (parseInt(data['BLOCK_INDEX']) + Number(contractInfo.cooldown_blocks)) : 0;
        } else {
            let cooldownBlocks = (contractInfo && contractInfo.cooldown_blocks) ? Number(contractInfo.cooldown_blocks) : 1000;
            data['COOLDOWN_END_BLOCK'] = parseInt(data['BLOCK_INDEX']) + cooldownBlocks;
        }

        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        console.log("\t UNSTAKE v1 : pubkey=" + String(data['SIGNING_PUBKEY']).substring(0, 16) +
            '... : target=' + data['TARGET_CONTRACT_INDEX'] +
            ' : tick=' + data['TICK'] +
            ' : amount=' + data['AMOUNT'] +
            ' : ' + data['STATUS']);

        // Write the contract_unstakes row
        await this.indexerDb.createContractUnstake(data);

        // Mark all active contract_stakes rows for (target, pubkey, tick) with deactivation_block
        if(status === 'valid'){
            await this.indexerDb.setContractStakeDeactivationByPubkey(
                data['TARGET_CONTRACT_INDEX'],
                data['SIGNING_PUBKEY'],
                data['TICK'],
                parseInt(data['BLOCK_INDEX']) + activationDelay,
                parseInt(data['BLOCK_INDEX'])
            );
        }

        // Tickers/addresses tracking (no credits/debits at unstake time; funds are released by block-end sweep)
        this.util.addAddressTicker(data['SOURCE'], data['TICK']);
        let credits = [],
            debits  = [];
        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits);

        let tickers   = this.util.getTickersList(),
            addresses = Object.keys(this.util.getAddressesList());
        await this.indexerDb.updateBalances(addresses);
        await this.indexerDb.updateTokens(tickers);

        await this.mapper.createMappings(data);
    }
}

module.exports = Unstake;
