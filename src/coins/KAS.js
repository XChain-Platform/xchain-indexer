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
 * XChain Platform - Canonical Coin Definition - Kaspa (KAS)
 *
 * This is the first coin file outside the Bitcoin family. Three points need upstream sign-off:
 *
 *   1. wireFormat introduces a new family name, 'kaspa'. The platform decoder's whitelist
 *      (xchain-decoder/src/chain/XChainBlockDecoder.js:32 `HANDLED_WIRE_FORMATS`)
 *      holds only 'default'/'mweb'/'auxpow' and throws on anything else, so
 *         a Kaspa parse path (or a separate Kaspa decoder service) has to land at the same time.
 *           This is the one place where upstream has to make a call.
 *
 *   2. `net` is not a bitcoinjs network object: Kaspa has no base58check/WIF/pkh bytes.
 *         It is Kaspa-side configuration; consumers must branch on wireFormat before reading it.
 *
 *   3. Every address role below is a placeholder, on a network prefix we control.
 *         Replace them with the real role addresses (BURN/GAS/REWARD/BRIDGE_*) before mainnet.
 *
 * Where the values come from (measured or read from source, never estimated):
 *   · decimals = 8                 —— `SOMPI_PER_KASPA = 100_000_000`
 *                                     (rusty-kaspa consensus/core/src/constants.rs)
 *   · fee model                    - minimum relay fee 100 sompi/gram
 *                                     (wallet/core/src/tx/mass.rs MINIMUM_RELAY_TRANSACTION_FEE)
 *   · 8 KB payload mass = 18,420,  - measured on testnet-10 with the local harness
 *   · 10 blocks per second         - params.rs `BlockrateParams::new::<10>()`
 *   · ports / encoding             - kaspad/src/args.rs; wRPC-Borsh on 17110 measured working
 *
 ********************************************************************/
module.exports = {

    // ── IDENTITY ────────────────────────────────────────────────────────────
    tick:        'KAS',          // native ticker (the platform uses the coin symbol, not the chain name)
    fullName:    'kaspa',        // hub configs-table coin key + COIN_FULL_NAME
    displayName: 'Kaspa',        // explorer chain.name
    site:        'https://kaspa.org',
    decimals:    8,              // sompi(1 KAS = 100,000,000 sompi)✓

    // Cross-chain attestation depth. Kaspa is a DAG at 10 BPS: 100 chain blocks is about 10 seconds.
    // (the platform counts blocks for BTC/LTC/DOGE too; same measure here, different pace.)
    confirmations: 100,

    // New family. See point 1 in the file header.
    wireFormat: 'kaspa',

    DISPLAY_ONLY_ADDRESS_ROLES: ['EXPLORER'],

    // ── family descriptor (new-family only; not a bitcoinjs field) ─────────────────────────────
    // The platform's `net` block describes the bitcoinjs family only, so Kaspa's own facts live here
    // and are read by consumers that branch on the family. Ports come from the help text in
    // kaspad/src/args.rs (mainnet and testnet sets); the simnet default is unverified and must be
    FAMILY: {
        id:         'kaspa',
        addressPrefix: { mainnet: 'kaspa', testnet: 'kaspatest', regtest: 'kaspasim' },
        carrier:    'payload',        // the transaction carries payload natively; this is not OP_RETURN
        rpcPorts: {
            mainnet: { grpc: 16110, p2p: 16111, wrpcBorsh: 17110, wrpcJson: 18110 },
            testnet: { grpc: 16210, p2p: 16211, wrpcBorsh: 17210, wrpcJson: 18210 },
            regtest: null,             // unverified; must be passed explicitly
        },
    },

    // ── PER-NETWORK PARAMS ──────────────────────────────────────────────────
    networks: {

        mainnet: {
            // Kaspa-shaped, not bitcoinjs-shaped: consumers must branch on wireFormat.
            // The Kaspa family has no bitcoinjs network object (the platform feeds `net` straight to
            //  bitcoinjs - see xchain-decoder/src/XChainDecoder.js:92). It is null here on purpose: consumers
            //  must branch on wireFormat and fail loudly; the Kaspa facts live in the coin-level FAMILY block.
            net: null,
            // Start index of the linear projection (not a chain height: Kaspa has none).
            // IS consensus-hashed; the mainnet value must be fixed once, with the network.
            firstBlock: 0,
            // Read the genesis hash from the node (`getBlock` at the DAG origin) or the official docs.
            // Unpinned means the check is skipped (platform semantics): do not guess.
            chainGenesisHash: null,
            addresses: {
                // Placeholders: replace with the real role addresses before mainnet.
                BURN:            'kaspa:qquxrkeluxz9kqjce85m5tm6887l86m9elvlgql06h686ucs78vtynknmzpl6',
                GAS:             'kaspa:qquxrkeluxz9kqjce85m5tm6887l86m9elvlgql06h686ucs78vtynknmzpl6',
                DONATE1:         'kaspa:qquxrkeluxz9kqjce85m5tm6887l86m9elvlgql06h686ucs78vtynknmzpl6',
                DONATE2:         'kaspa:qquxrkeluxz9kqjce85m5tm6887l86m9elvlgql06h686ucs78vtynknmzpl6',
                FEE_DESTINATION: 'kaspa:qquxrkeluxz9kqjce85m5tm6887l86m9elvlgql06h686ucs78vtynknmzpl6',
                REWARD:          'kaspa:qquxrkeluxz9kqjce85m5tm6887l86m9elvlgql06h686ucs78vtynknmzpl6',
                BRIDGE_BTC:      'kaspa:qquxrkeluxz9kqjce85m5tm6887l86m9elvlgql06h686ucs78vtynknmzpl6',
                BRIDGE_LTC:      'kaspa:qquxrkeluxz9kqjce85m5tm6887l86m9elvlgql06h686ucs78vtynknmzpl6',
                BRIDGE_DOGE:     'kaspa:qquxrkeluxz9kqjce85m5tm6887l86m9elvlgql06h686ucs78vtynknmzpl6',
                EXPLORER:        'kaspa:qquxrkeluxz9kqjce85m5tm6887l86m9elvlgql06h686ucs78vtynknmzpl6',
            },
            genesis: {
                block: 0, ledgerHash: null, dumpHash: null,
                airdropPaths: [], airdropHashes: [], airdropAmounts: [],
                airdropSnapshotBlock: null, airdropSetHash: null,
            },
        },

        testnet: {
            // The Kaspa family has no bitcoinjs network object (the platform feeds `net` straight to
            //  bitcoinjs - see xchain-decoder/src/XChainDecoder.js:92). It is null here on purpose: consumers
            //  must branch on wireFormat and fail loudly; the Kaspa facts live in the coin-level FAMILY block.
            net: null,
            firstBlock: 0,
            chainGenesisHash: null,     // read from the node; do not guess
            addresses: {
                BURN:            'kaspatest:qquxrkeluxz9kqjce85m5tm6887l86m9elvlgql06h686ucs78vtyjs4qdlw7',
                GAS:             'kaspatest:qquxrkeluxz9kqjce85m5tm6887l86m9elvlgql06h686ucs78vtyjs4qdlw7',
                DONATE1:         'kaspatest:qquxrkeluxz9kqjce85m5tm6887l86m9elvlgql06h686ucs78vtyjs4qdlw7',
                DONATE2:         'kaspatest:qquxrkeluxz9kqjce85m5tm6887l86m9elvlgql06h686ucs78vtyjs4qdlw7',
                FEE_DESTINATION: 'kaspatest:qquxrkeluxz9kqjce85m5tm6887l86m9elvlgql06h686ucs78vtyjs4qdlw7',
                REWARD:          'kaspatest:qquxrkeluxz9kqjce85m5tm6887l86m9elvlgql06h686ucs78vtyjs4qdlw7',
                BRIDGE_BTC:      'kaspatest:qquxrkeluxz9kqjce85m5tm6887l86m9elvlgql06h686ucs78vtyjs4qdlw7',
                BRIDGE_LTC:      'kaspatest:qquxrkeluxz9kqjce85m5tm6887l86m9elvlgql06h686ucs78vtyjs4qdlw7',
                BRIDGE_DOGE:     'kaspatest:qquxrkeluxz9kqjce85m5tm6887l86m9elvlgql06h686ucs78vtyjs4qdlw7',
                EXPLORER:        'kaspatest:qquxrkeluxz9kqjce85m5tm6887l86m9elvlgql06h686ucs78vtyjs4qdlw7',
            },
            genesis: {
                // testnet starts clean, following the LTC/testnet example
                block: 0, ledgerHash: null, dumpHash: null,
                airdropPaths: [], airdropHashes: [], airdropAmounts: [],
                airdropSnapshotBlock: null, airdropSetHash: null,
            },
        },

        regtest: {
            // The Kaspa family has no bitcoinjs network object (the platform feeds `net` straight to
            //  bitcoinjs - see xchain-decoder/src/XChainDecoder.js:92). It is null here on purpose: consumers
            //  must branch on wireFormat and fail loudly; the Kaspa facts live in the coin-level FAMILY block.
            net: null,
            firstBlock: 0,
            chainGenesisHash: null,             // simnet builds a fresh chain each run, so it is never pinned
            addresses: {
                // simnet is better overridden from the environment; this is a runnable default
                BURN:            'kaspasim:qr9htftcq77c02a83mfrhmu8mw7v7szgk7aanu6g7npfffhwdc2a5ysp42wzg',
                GAS:             'kaspasim:qr9htftcq77c02a83mfrhmu8mw7v7szgk7aanu6g7npfffhwdc2a5ysp42wzg',
                DONATE1:         'kaspasim:qr9htftcq77c02a83mfrhmu8mw7v7szgk7aanu6g7npfffhwdc2a5ysp42wzg',
                DONATE2:         'kaspasim:qr9htftcq77c02a83mfrhmu8mw7v7szgk7aanu6g7npfffhwdc2a5ysp42wzg',
                FEE_DESTINATION: 'kaspasim:qr9htftcq77c02a83mfrhmu8mw7v7szgk7aanu6g7npfffhwdc2a5ysp42wzg',
                REWARD:          'kaspasim:qr9htftcq77c02a83mfrhmu8mw7v7szgk7aanu6g7npfffhwdc2a5ysp42wzg',
                BRIDGE_BTC:      'kaspasim:qr9htftcq77c02a83mfrhmu8mw7v7szgk7aanu6g7npfffhwdc2a5ysp42wzg',
                BRIDGE_LTC:      'kaspasim:qr9htftcq77c02a83mfrhmu8mw7v7szgk7aanu6g7npfffhwdc2a5ysp42wzg',
                BRIDGE_DOGE:     'kaspasim:qr9htftcq77c02a83mfrhmu8mw7v7szgk7aanu6g7npfffhwdc2a5ysp42wzg',
                EXPLORER:        'kaspasim:qr9htftcq77c02a83mfrhmu8mw7v7szgk7aanu6g7npfffhwdc2a5ysp42wzg',
            },
            genesis: {
                $envOverrides: {
                    block:      { env: 'XCHAIN_GENESIS_BLOCK',       type: 'int', default: 0 },
                    ledgerHash: { env: 'XCHAIN_GENESIS_LEDGER_HASH', type: 'str', default: null },
                    dumpHash:   { env: 'XCHAIN_GENESIS_DUMP_HASH',   type: 'str', default: null },
                    airdropPaths:         { env: 'GENESIS_AIRDROP_PATHS',          type: 'csv',        default: [] },
                    airdropHashes:        { env: 'GENESIS_AIRDROP_HASHES',         type: 'csv_sparse', default: [] },
                    airdropAmounts:       { env: 'GENESIS_AIRDROP_AMOUNTS',        type: 'csv_sparse', default: [] },
                    airdropSnapshotBlock: { env: 'GENESIS_AIRDROP_SNAPSHOT_BLOCK', type: 'str',        default: null },
                    airdropSetHash:       { env: 'GENESIS_AIRDROP_SET_HASH',       type: 'str',        default: null },
                },
            },
        },
    },

    // ── COIN-LEVEL CONSENSUS PARAMS (network-independent) ────────────────────
    // These are priced in XCHAIN (independent of the host chain), so they match the BTC side;
    // only the block-count shaped parameters follow the Kaspa pace, noted line by line below.

    legacyFees: {
        ISSUANCE_FEE_TOKEN:          '1.00000000',
        ISSUANCE_FEE_SUBTOKEN:       '0.50000000',
        EXPIRATION_FEE_DEFAULT_DAYS: 90,
        EXPIRATION_FEE_FREE_DAYS:    182,
        EXPIRATION_FEE_PER_DAY:      '0.00547945',
    },

    GAS_PRICE:                        '0.00001',   // XCHAIN per gas unit
    UNIFIED_EXPIRATION_FEE_FREE_DAYS: 90,
    // Design decision: fees are charged from the XCHAIN balance, not from native KAS.
    // FEE_PAYMENT_MODE is a non-consensus field (the guide files it under Display/connection), so
    // the xchain mode avoids the KAS oracle price and its tolerance band.
    FEE_PAYMENT_MODE:                 'xchain',
    FEE_TOLERANCE_MIN:                '0.95',
    FEE_TOLERANCE_MAX:                '1.10',
    ORACLE_MAX_PRICE_AGE_SECONDS:     1800,
    ORACLE_MAX_PRICE_AGE_HOURLY_SECONDS: 4500,
    VALIDATOR_QUERY_LIMIT:            1000,

    // Gas schedule identical to BTC (denominated in XCHAIN, not the host coin).
    GAS_SCHEDULE: {
        ISSUE:                 100000,
        ISSUE_SUBTOKEN:        50000,
        EXPIRATION_PER_DAY:    550,
        OWNERSHIP_ESCROW:      50000,
        AIRDROP_PER_RECIPIENT: 100,
        DIVIDEND_PER_RECIPIENT: 100,
        SWEEP_BASE:            5000,
        SWEEP_PER_ITEM:        100,
        CALLBACK_BASE:         5000,
        CALLBACK_PER_RECIPIENT: 100,
        XBRIDGE_BASE:          5000,
        LIST_SHARE:            100000,
        LIST_SHARED_EDIT_BASE: 5000,
        LIST_SHARED_EDIT_PER_ITEM: 100,
        BET_FEED_PER_DAY:      550,
        BET_PER_CREDIT:        100,
        VM_EXECUTE_BASE:       1000,
        VM_DEPLOY_BASE:        100000,
        VM_DEPLOY_PER_BYTE:    10,
        VM_STATE_READ:         100,
        VM_STATE_WRITE:        200,
        VM_STATE_DELETE:       100,
        VM_ORACLE_READ:        100,
        VM_CROSSCHAIN_READ:    100,
        VM_ATTEST_REQUEST:     5000,
        VM_XCALL_REQUEST:      2000,
        VM_XCALL_CALLBACK:     20000,
        VM_EMISSION:           500,
        VM_COMPUTATION:        1,
        VM_GUARD_GAS_CEILING:  200000,
    },

    STAKING: {
        // Scaled for the 10 BPS pace (the platform values assume a block about every 10 minutes;
        //    the factor is 600 s / 0.1 s = 6000).
        COOLDOWN_BLOCKS:         6048000,   // 7 days (1000 × 6000)
        ACTIVATION_DELAY_BLOCKS: 36000,     // 1 hour (6 × 6000)
        CAPABILITIES: {
            // MIN_STAKE is priced in XCHAIN, independent of the host chain, so it keeps the BTC value
            price:          { MIN_STAKE: '1000.00000000', SLASH: { BOUNTY_BPS: 500, BOUNTY_FLOOR: '50.00000000', BOUNTY_CAP: '1000.00000000' } },
            cross_chain:    { MIN_STAKE: '5000.00000000', SLASH: { BOUNTY_BPS: 500, BOUNTY_FLOOR: '50.00000000', BOUNTY_CAP: '1000.00000000' } },
            oracle_publish: { MIN_STAKE: '500.00000000',  SLASH: { BOUNTY_BPS: 500, BOUNTY_FLOOR: '50.00000000', BOUNTY_CAP: '1000.00000000' } },
            attestation:    { MIN_STAKE: '1000.00000000', SLASH: { BOUNTY_BPS: 500, BOUNTY_FLOOR: '50.00000000', BOUNTY_CAP: '1000.00000000' } },
            full_node:      { MIN_STAKE: '2000.00000000' },
        },
    },

    CONFIG_SLASH: { BOUNTY_BPS: 500, BOUNTY_FLOOR: '50.00000000', BOUNTY_CAP: '1000.00000000' },

    FULLNODE: {
        // Scaled by the same factor; this layer is inert for now
        //    (REWARD_SHARE '0' with an empty GENESIS_VERIFIERS means unactivated: "ships inert until a later flag-day",
        //    in the platform's own words), so these are shaped for the Kaspa pace and do not affect consensus until then.
        CHALLENGE_INTERVAL_BLOCKS:    864000,
        CONFIRM_DEPTH:                600000,
        PROOF_WINDOW_BLOCKS:          1800000,
        VERDICT_ACCEPT_WINDOW_BLOCKS: 144000,
        REWARD_SHARE:                 '0',
        REWARD_PASS_WINDOW_BLOCKS:    6048000,
        MIN_PASS_RATE_BPS:            7000,
        COLLECT_DEPTH_BLOCKS:         18000,
        GENESIS_VERIFIERS:            [],
        $regtestSidecar:   'fullnode.regtest.json',
        $regtestEnvOverrides: {
            CHALLENGE_INTERVAL_BLOCKS:    { env: 'FULLNODE_CHALLENGE_INTERVAL_BLOCKS',    type: 'int' },
            CONFIRM_DEPTH:                { env: 'FULLNODE_CONFIRM_DEPTH',                type: 'int' },
            PROOF_WINDOW_BLOCKS:          { env: 'FULLNODE_PROOF_WINDOW_BLOCKS',          type: 'int' },
            VERDICT_ACCEPT_WINDOW_BLOCKS: { env: 'FULLNODE_VERDICT_ACCEPT_WINDOW_BLOCKS', type: 'int' },
            REWARD_PASS_WINDOW_BLOCKS:    { env: 'FULLNODE_REWARD_PASS_WINDOW_BLOCKS',    type: 'int' },
            MIN_PASS_RATE_BPS:            { env: 'FULLNODE_MIN_PASS_RATE_BPS',            type: 'int' },
            REWARD_SHARE:                 { env: 'FULLNODE_REWARD_SHARE',                 type: 'str' },
            COLLECT_DEPTH_BLOCKS:         { env: 'FULLNODE_COLLECT_DEPTH_BLOCKS',         type: 'int' },
            GENESIS_VERIFIERS:            { env: 'FULLNODE_GENESIS_VERIFIERS',            type: 'csv_lower' },
        },
    },
};
