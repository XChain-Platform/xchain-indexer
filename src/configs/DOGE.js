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
        config['ORACLE_MAX_PRICE_AGE_SECONDS'] = 1800;       // Reject oracle prices older than this vs the block being processed (≈3× the ~10-min BTC oracle-round interval; applies on all chains); 0 disables
        config['STAKING'] = {
            COOLDOWN_BLOCKS:         1000,                     // Blocks before unstaked XCHAIN is returned
            ACTIVATION_DELAY_BLOCKS: 60,                       // ~60 min reorg protection at ~1 min/block
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
                address['BURN']            = "DChainBurnAddressXXXXXXXXXXXawc9pt";
                address['GAS']             = "DGasfpttCnTijuuoAdiJ9sXJjG7vQ5pMkW";
                address['DONATE1']         = "DDonate1RBcwGnCRNnVtwuCmQyWW1Gn25f"; // Protocol Development
                address['DONATE2']         = "DDonate2o3Sg4phybp92oFpkmv8S9ZhGSV"; // Community Develoment
                address['FEE_DESTINATION'] = process.env['XCHAIN_FEE_DESTINATION_DOGE_' + network.toUpperCase()] || "DFeesjvoMoVqd9UDuwDSAxzHMF5xZFgeG9"; // Native coin fee destination
                address['REWARD']          = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Validator reward pool (structural only — COLLECT/XCHAIN are BTC-only; unused on DOGE)
                break;
            case 'testnet':
                address['BURN']            = "nchainburnaddressXXXXXXXXXXXYKgF7W";
                address['GAS']             = "ngasn6zHFzJ72zpk3DBKmXhD2XtszujSDW";
                address['DONATE1']         = "ndonate1dE87UXUFf4gjyhPg7hfQRJXVXr"; // Protocol Development
                address['DONATE2']         = "ndonate2wev8vKDgvd1DHhtJtvkRbn2usJ"; // Community Develoment
                address['FEE_DESTINATION'] = process.env['XCHAIN_FEE_DESTINATION_DOGE_' + network.toUpperCase()] || "nfeesoodkv5UTFXcDeKcUU95QHFiK2Ggo7"; // Native coin fee destination
                address['REWARD']          = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Validator reward pool (structural only — COLLECT/XCHAIN are BTC-only; unused on DOGE)
                break;
            case 'regtest':
                address['BURN']            = "mvs8WdppEhzQLxfcYwrr1eoKA2nUFi55ff";
                address['GAS']             = "mgasDTdKu5DsbW97qSRnE8raAuYpKMfmhg";
                address['DONATE1']         = "mzdg8wGxgP3Jk45FuZPspumCL3Ruup37ob"; // Protocol Development
                address['DONATE2']         = "mmXU8RU7q3BUsyT66rtw1H6P7B2ZZd9c5Y"; // Community Develoment
                address['FEE_DESTINATION'] = process.env['XCHAIN_FEE_DESTINATION_DOGE_' + network.toUpperCase()] || "mfees5pa2HwNBonk5vG23aDWkN9fuDJib4"; // Native coin fee destination
                address['REWARD']          = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Validator reward pool (structural only — COLLECT/XCHAIN are BTC-only; unused on DOGE)
                break;
        }
        config['ADDRESS'] = address;

        return config;
    }
}