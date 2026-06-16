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
 * XChain Indexer - COIN Configuration - Litecoin (LTC) 
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
        config['ISSUANCE_FEE_TOKEN']    = '0.50000000';
        config['ISSUANCE_FEE_SUBTOKEN'] = '0.25000000';
        config['EXPIRATION_FEE_DEFAULT_DAYS'] = 90;
        config['EXPIRATION_FEE_FREE_DAYS']    = 182;
        config['EXPIRATION_FEE_PER_DAY']      = '0.00273973';

        // Unified gas fee schedule (active after UNIFIED_FEES protocol change)
        config['GAS_PRICE'] = '0.00001';
        config['UNIFIED_EXPIRATION_FEE_FREE_DAYS'] = 90;
        config['FEE_PAYMENT_MODE'] = 'native';               // LTC: 'native' only (no XCHAIN balance deduction)
        config['FEE_TOLERANCE_MIN'] = '0.95';
        config['FEE_TOLERANCE_MAX'] = '1.10';
        config['ORACLE_MAX_PRICE_AGE_SECONDS'] = 1800;       // Reject oracle prices older than this vs the block being processed (≈3× the ~10-min BTC oracle-round interval; applies on all chains); 0 disables
        config['VALIDATOR_QUERY_LIMIT'] = 1000;              // CONSENSUS-CRITICAL safety cap on validator-set queries (db.js). Frozen node-local — NOT an env var — because the cap is read on the deterministic block-processing path (attest responsible-set, quorum gates); a per-node value would fork the federation once the qualifying set exceeds the smaller cap. Generous vs any realistic federation; hitting it is logged.
        config['STAKING'] = {
            COOLDOWN_BLOCKS:         1000,                     // Blocks before unstaked XCHAIN is returned
            ACTIVATION_DELAY_BLOCKS: 24,                       // ~60 min reorg protection at ~2.5 min/block
            CAPABILITIES: {}                                   // Capability staking is BTC-only at the protocol level
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
            VM_XCALL_REQUEST: 2000,    // Cross-chain call — emit one XCALL v0 request (relay cost)
            VM_XCALL_CALLBACK: 20000,  // Cross-chain call — fixed ceiling the result/expiry callback runs against
            VM_EMISSION:        500,
            VM_COMPUTATION:     1,
            VM_GUARD_GAS_CEILING: 200000  // Per-call gas ceiling for a controller-bound token `guard` run; SOURCE reserves this fee
        };

		// Set network specific addresses
        switch(network){
            case 'mainnet':
                address['BURN']            = "LXChainBurnAddressXXXXXXXXXXSkrYkJ";
                address['GAS']             = "LXChainCN6yjHVqqS9tYzYVYZ8CCZcSx72";
                address['DONATE1']         = "Ldonate18tNZcVThKm5MX33EjvhaanJ6Mg"; // Protocol Development
                address['DONATE2']         = "Ldonate2io846q2e7q8dUArh3TNnaq9ENb"; // Community Develoment
                address['FEE_DESTINATION'] = process.env['XCHAIN_FEE_DESTINATION_LTC_' + network.toUpperCase()] || "Lfees7tszAx5Gqam2fuqf6biaX3LXafM4H"; // Native coin fee destination
                address['REWARD']          = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Validator reward pool (structural only — COLLECT/XCHAIN are BTC-only; unused on LTC)
                break;
            case 'testnet':
                address['BURN']            = "mxchainburnaddressXXXXXXXXXXa8EAfp";
                address['GAS']             = "mgashLN9oSvj2CUJYKWdNxh6VkamPg1Ges";
                address['DONATE1']         = "mybp5CceJvVV5tNCCiF7oBiZWko2fNkmnT"; // Protocol Development
                address['DONATE2']         = "muKEjejjXQvLY7Lp7Ecpn29gM2TCb5BLTF"; // Community Develoment
                address['FEE_DESTINATION'] = process.env['XCHAIN_FEE_DESTINATION_LTC_' + network.toUpperCase()] || "mfeeskqGYw3wXYqMZFnUxBwGposEvjziRW"; // Native coin fee destination
                address['REWARD']          = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Validator reward pool (structural only — COLLECT/XCHAIN are BTC-only; unused on LTC)
                break;
            case 'regtest':
                address['BURN']            = "mxchainburnaddressXXXXXXXXXXa8EAfp";
                address['GAS']             = "mgas5QYE38Bg34hwEjFKaE7Gs536FARue4";
                address['DONATE1']         = "mgNY2ZXbnNEkRT5ZRF8yGamivrSX2QH97h"; // Protocol Development
                address['DONATE2']         = "n2DLJPppXUi8jC6fLiSkthZi2sc9UKiZHd"; // Community Develoment
                address['FEE_DESTINATION'] = process.env['XCHAIN_FEE_DESTINATION_LTC_' + network.toUpperCase()] || "mfeesJdVLx23zhtsCveA8EEfmHX7qSV2Ls"; // Native coin fee destination
                address['REWARD']          = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Validator reward pool (structural only — COLLECT/XCHAIN are BTC-only; unused on LTC)
                break;
        }
        config['ADDRESS'] = address;

        return config;
    }
}