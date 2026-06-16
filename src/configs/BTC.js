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
        config['VALIDATOR_QUERY_LIMIT'] = 1000;              // CONSENSUS-CRITICAL safety cap on validator-set queries (db.js). Frozen node-local — NOT an env var — because the cap is read on the deterministic block-processing path (attest responsible-set, quorum gates); a per-node value would fork the federation once the qualifying set exceeds the smaller cap. Generous vs any realistic federation; hitting it is logged.
        config['STAKING'] = {
            COOLDOWN_BLOCKS:         1000,                     // Blocks before unstaked XCHAIN is returned
            ACTIVATION_DELAY_BLOCKS: 6,                        // ~60 min reorg protection at ~10 min/block
            CAPABILITIES: {
                price:          { MIN_STAKE: '1000.00000000' }, // Sign PRICE v0 snapshots (replaces Tier 1)
                cross_chain:    { MIN_STAKE: '5000.00000000' }, // Cross-chain attestation (replaces Tier 2)
                oracle_publish: { MIN_STAKE: '500.00000000'  }, // Publish price rounds to DOGE chain (replaces Tier 3)
                attestation:    { MIN_STAKE: '1000.00000000' }, // Off-chain data attestation framework (http_get, llm, future providers)
                full_node:      { MIN_STAKE: '2000.00000000' }  // Verified full-node tier — entrance stake; verification ALSO requires passing periodic NODEPROOF possession challenges (NODEPROOF.md)
            }
        };
        // Full-node possession-proof / verified-validator tier (NODEPROOF.md).
        config['FULLNODE'] = {
            CHALLENGE_INTERVAL_BLOCKS:    144,    // epoch cadence (~daily on BTC)
            CONFIRM_DEPTH:                100,    // target block buried this deep (reorg-stable)
            PROOF_WINDOW_BLOCKS:          300,    // a passed proof keeps a node "verified" this long
            VERDICT_ACCEPT_WINDOW_BLOCKS:  24,    // a verdict must land within this many blocks of its epoch
            REWARD_SHARE:                 '0',    // fraction of the oracle-round budget routed to verified full nodes (raise to '0.25' to enable — see price.js)
            GENESIS_VERIFIERS:            []      // bootstrap verifier pubkeys (operator); empty = feature dormant
        };
        // REGTEST/e2e ONLY: the possession-proof cadence and the bootstrap genesis
        // verifiers are unknowable ahead of a regtest run (validator keys are
        // generated per run). Allow the e2e harness to inject them via env on
        // regtest exclusively — mainnet/testnet keep the frozen consensus defaults
        // above, so real-network behavior carries NO env surface and stays
        // byte-identical. Mirrors the federation env pattern used elsewhere.
        if(network === 'regtest'){
            let fn = config['FULLNODE'];
            // (a) Optional sidecar JSON in the working dir (fullnode.regtest.json) —
            //     lets a venue reconfigure with a plain `docker restart` (no env/
            //     container recreate). Keys present override the defaults above.
            try {
                let p = require('path').resolve(process.cwd(), 'fullnode.regtest.json');
                if(require('fs').existsSync(p)){
                    let j = JSON.parse(require('fs').readFileSync(p, 'utf8')) || {};
                    for(let k of Object.keys(j)) fn[k] = j[k];
                }
            } catch(e){ console.log('FULLNODE regtest sidecar ignored: ' + e.message); }
            // (b) Per-key env overrides (highest precedence) — for compose/CI.
            let envInt = (k, d) => (process.env[k] !== undefined && process.env[k] !== '') ? parseInt(process.env[k]) : d;
            fn['CHALLENGE_INTERVAL_BLOCKS']    = envInt('FULLNODE_CHALLENGE_INTERVAL_BLOCKS',    fn['CHALLENGE_INTERVAL_BLOCKS']);
            fn['CONFIRM_DEPTH']                = envInt('FULLNODE_CONFIRM_DEPTH',                fn['CONFIRM_DEPTH']);
            fn['PROOF_WINDOW_BLOCKS']          = envInt('FULLNODE_PROOF_WINDOW_BLOCKS',          fn['PROOF_WINDOW_BLOCKS']);
            fn['VERDICT_ACCEPT_WINDOW_BLOCKS'] = envInt('FULLNODE_VERDICT_ACCEPT_WINDOW_BLOCKS', fn['VERDICT_ACCEPT_WINDOW_BLOCKS']);
            if(process.env['FULLNODE_REWARD_SHARE'] !== undefined && process.env['FULLNODE_REWARD_SHARE'] !== '')
                fn['REWARD_SHARE'] = String(process.env['FULLNODE_REWARD_SHARE']);
            if(process.env['FULLNODE_GENESIS_VERIFIERS'])
                fn['GENESIS_VERIFIERS'] = process.env['FULLNODE_GENESIS_VERIFIERS'].split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
            // Genesis pubkeys are case-insensitive on the wire; normalize.
            fn['GENESIS_VERIFIERS'] = (fn['GENESIS_VERIFIERS'] || []).map(s => String(s).toLowerCase());
        }
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