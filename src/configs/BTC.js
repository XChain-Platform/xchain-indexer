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
 * XChain Indexer - COIN Configuration - Bitcoin (BTC) 
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
        config['ISSUANCE_FEE_TOKEN']    = '1.00000000';
        config['ISSUANCE_FEE_SUBTOKEN'] = '0.50000000';
        config['EXPIRATION_FEE_DEFAULT_DAYS'] = 90;
        config['EXPIRATION_FEE_FREE_DAYS']    = 182;
        config['EXPIRATION_FEE_PER_DAY']      = '0.00547945';

        // Unified gas fee schedule (active after UNIFIED_FEES protocol change)
        config['GAS_PRICE'] = '0.00001';                     // XCHAIN per gas unit
        config['UNIFIED_EXPIRATION_FEE_FREE_DAYS'] = 90;     // 90 days free (reduced from 182)
        config['FEE_PAYMENT_MODE'] = 'xchain';               // 'xchain' or 'native' (BTC supports both via implicit detection)
        config['FEE_TOLERANCE_MIN'] = '0.95';                // Minimum acceptable fee (95% of expected)
        config['FEE_TOLERANCE_MAX'] = '1.10';                // Maximum acceptable fee (110% of expected)
        config['ORACLE_MAX_PRICE_AGE_SECONDS'] = 1800;       // Reject oracle prices older than this vs the block being processed (≈3× the 10-min publish interval); 0 disables
        config['STAKING'] = {
            COOLDOWN_BLOCKS:         1000,                     // Blocks before unstaked XCHAIN is returned
            ACTIVATION_DELAY_BLOCKS: 6,                        // Blocks before stake/delegation/unstake takes effect (BTC reorg safety)
            CAPABILITIES: {
                price:          { MIN_STAKE: '1000.00000000' }, // Sign PRICE v0 snapshots (replaces Tier 1)
                cross_chain:    { MIN_STAKE: '5000.00000000' }, // Cross-chain attestation (replaces Tier 2)
                oracle_publish: { MIN_STAKE: '500.00000000'  }, // Publish price rounds to DOGE chain (replaces Tier 3)
                attestation:    { MIN_STAKE: '1000.00000000' }  // Off-chain data attestation framework (http_get, llm, future providers)
            }
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
                address['BURN']            = "1Muhahahahhahahahahahhahahauxh9QX";
                address['GAS']             = "1BTNSGASK5En7rFurDJ79LQ8CVYo2ecLC8";
                address['DONATE1']         = "1BTNSGASK5En7rFurDJ79LQ8CVYo2ecLC8"; // Protocol Development
                address['DONATE2']         = "1BTNSGASK5En7rFurDJ79LQ8CVYo2ecLC8"; // Community Develoment
                address['FEE_DESTINATION'] = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Native coin fee destination (set pre-launch)
                break;
            case 'testnet':
                address['BURN']            = "mvCounterpartyXXXXXXXXXXXXXXW24Hef";
                address['GAS']             = "mvThcDEbeqog2aJ7JNj1FefUPaNdYYGqHt";
                address['DONATE1']         = "mvThcDEbeqog2aJ7JNj1FefUPaNdYYGqHt"; // Protocol Development
                address['DONATE2']         = "mvThcDEbeqog2aJ7JNj1FefUPaNdYYGqHt"; // Community Develoment
                address['FEE_DESTINATION'] = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Native coin fee destination (set pre-launch)
                break;
            case 'regtest':
                address['BURN']            = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
                address['GAS']             = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
                address['DONATE1']         = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Protocol Development
                address['DONATE2']         = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Community Develoment
                address['FEE_DESTINATION'] = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Native coin fee destination
                break;
        }
        config['ADDRESS'] = address;

        return config;
    }
}