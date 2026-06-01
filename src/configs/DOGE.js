/*********************************************************************
 * 
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 * 
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided “AS IS”, without warranties or conditions of any kind.
 * 
 **********************************************************************
 * 
 * XChain Indexer - COIN Configuration - Dogecoin (DOGE) 
 * 
 * This config file contains COIN specific configuration information
 * 
 ********************************************************************/
module.exports = {

    // Handle returning the current coin configuration
    getConfig: function(network){

        // Define config objects
        let config  = {};
		let address = {};

        // Legacy fee constants (used before UNIFIED_FEES activation)
        config['ISSUANCE_FEE_TOKEN']    = '0.25000000';
        config['ISSUANCE_FEE_SUBTOKEN'] = '0.10000000';
        config['EXPIRATION_FEE_DEFAULT_DAYS'] = 90;
        config['EXPIRATION_FEE_FREE_DAYS']    = 182;
        config['EXPIRATION_FEE_PER_DAY']      = '0.00136986';

        // Unified gas fee schedule (active after UNIFIED_FEES protocol change)
        config['GAS_PRICE'] = '0.00001';
        config['UNIFIED_EXPIRATION_FEE_FREE_DAYS'] = 90;
        config['FEE_PAYMENT_MODE'] = 'native';               // DOGE: 'native' only (no XCHAIN balance deduction)
        config['FEE_TOLERANCE_MIN'] = '0.95';
        config['FEE_TOLERANCE_MAX'] = '1.10';
        config['ORACLE_MAX_PRICE_AGE_SECONDS'] = 1800;       // Reject oracle prices older than this vs the block being processed (≈3× the 10-min publish interval); 0 disables
        config['STAKING'] = {
            COOLDOWN_BLOCKS:         1000,                     // Blocks before unstaked XCHAIN is returned
            ACTIVATION_DELAY_BLOCKS: 6,                        // Blocks before stake/delegation/unstake takes effect
            CAPABILITIES: []                                   // Capability staking is BTC-only at the protocol level
        };
        config['GAS_SCHEDULE'] = {
            ISSUE:              100000,
            ISSUE_SUBTOKEN:     50000,
            EXPIRATION_PER_DAY: 550,
            OWNERSHIP_ESCROW:   50000,   // Premium charged on ORDER/SWAP/DISPENSER create when GIVE_OWNERSHIP=1
            AIRDROP_PER_RECIPIENT: 100,
            DIVIDEND_PER_RECIPIENT: 100,
            VM_EXECUTE_BASE:    1000,
            VM_DEPLOY_BASE:     100000,
            VM_DEPLOY_PER_BYTE: 10,
            VM_STATE_READ:      100,
            VM_STATE_WRITE:     200,
            VM_STATE_DELETE:     100,
            VM_ORACLE_READ:     100,
            VM_CROSSCHAIN_READ: 100,
            VM_ATTEST_REQUEST: 5000,    // External attestation framework — emit one ATTEST v0 (off-chain data request)
            VM_EMISSION:        500,
            VM_COMPUTATION:     1
        };

		// Set network specific addresses
        switch(network){
            case 'mainnet':
                address['BURN']            = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
                address['GAS']             = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
                address['DONATE1']         = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Protocol Development
                address['DONATE2']         = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Community Develoment
                address['FEE_DESTINATION'] = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Native coin fee destination
                address['REWARD']          = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Validator reward pool (structural only — COLLECT/XCHAIN are BTC-only; unused on DOGE)
                break;
            case 'testnet':
                address['BURN']            = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
                address['GAS']             = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
                address['DONATE1']         = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Protocol Development
                address['DONATE2']         = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Community Develoment
                address['FEE_DESTINATION'] = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Native coin fee destination
                address['REWARD']          = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Validator reward pool (structural only — COLLECT/XCHAIN are BTC-only; unused on DOGE)
                break;
            case 'regtest':
                address['BURN']            = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
                address['GAS']             = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
                address['DONATE1']         = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Protocol Development
                address['DONATE2']         = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Community Develoment
                address['FEE_DESTINATION'] = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Native coin fee destination
                address['REWARD']          = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Validator reward pool (structural only — COLLECT/XCHAIN are BTC-only; unused on DOGE)
                break;
        }
        config['ADDRESS'] = address;

        return config;
    }
}