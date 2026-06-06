/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
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
        config['ORACLE_MAX_PRICE_AGE_SECONDS'] = 1800;       // Reject oracle prices older than this vs the block being processed (≈3× the ~10-min BTC oracle-round interval; applies on all chains); 0 disables
        config['STAKING'] = {
            COOLDOWN_BLOCKS:         1000,                     // Blocks before unstaked XCHAIN is returned
            ACTIVATION_DELAY_BLOCKS: 6,                        // ~60 min reorg protection at ~10 min/block
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
                address['BURN']            = "1XChainBurnAddressXXXXXXXXXbRsd2N";
                address['GAS']             = "1XChain3M4uRwcHqt4XuhVBUQ8cL4qQsA";
                address['DONATE1']         = "1Donate1GERVKPW6GFQcnGeTa8dgL6Abyp"; // Protocol Development
                address['DONATE2']         = "1Donate2LkbBrsanwCVRPWZCXAqQcvcqGz"; // Community Develoment
                address['FEE_DESTINATION'] = process.env['XCHAIN_FEE_DESTINATION_BTC_' + network.toUpperCase()] || "1FeesxM9LTEjBYVTkynK6jfDBgvksuh2WL"; // Native coin fee destination (set pre-launch)
                address['REWARD']          = "1rewardsZAyeuLeFJKoAepYiNN5N6uSzn"; // Validator reward pool — pre-funded, manual top-up, drained by COLLECT (set pre-launch)
                break;
            case 'testnet':
                address['BURN']            = "mxchainburnaddressXXXXXXXXXXa8EAfp";
                address['GAS']             = "mgassdEpzH2AuKGK9W5FZh8drWYKrpXk6D";
                address['DONATE1']         = "mfztXKX1HeVdCQf6pDCZFEzo5i5wYNHAM6"; // Protocol Development
                address['DONATE2']         = "myBbbZ4t7BPoyNcT4sHtFwZDuiyYGDXLQM"; // Community Develoment
                address['FEE_DESTINATION'] = process.env['XCHAIN_FEE_DESTINATION_BTC_' + network.toUpperCase()] || "mfees5QurRs5BHXofdGpTG5pXB6uC6R8RU"; // Native coin fee destination (set pre-launch)
                address['REWARD']          = "mrewards4RQFYoZ5yEv4xr12PzfjDYViks"; // Validator reward pool — pre-funded, manual top-up, drained by COLLECT (set pre-launch)
                break;
            case 'regtest':
                address['BURN']            = "mxchainburnaddressXXXXXXXXXXa8EAfp";
                address['GAS']             = "mgash6jYSKAR3Q5HPpDgNX2BYr18q9N6GQ";
                address['DONATE1']         = "muYHF9MMnK6Nmd5zx7EBtqEYZdaf2Xy8JX"; // Protocol Development
                address['DONATE2']         = "mkQd27aJSqsQ666z1Q4MLFmd3Ybqzy3TNw"; // Community Develoment
                address['FEE_DESTINATION'] = process.env['XCHAIN_FEE_DESTINATION_BTC_' + network.toUpperCase()] || "mfeesX6rLE6V3WPg9tsbL2fHNS7E4rDAim"; // Native coin fee destination
                address['REWARD']          = "mrewardshQqD1ptkEBZGjPDF77L5uKJQmk"; // Validator reward pool — pre-funded, manual top-up, drained by COLLECT
                break;
        }
        config['ADDRESS'] = address;

        return config;
    }
}