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
 * XChain Platform - Canonical Coin Definition - Bitcoin (BTC)
 *
 * SINGLE SOURCE OF TRUTH for all Bitcoin-specific facts on the platform.
 * Every service derives its coin config from this file (via coins/index.js
 * getCoinConfig) rather than keeping its own copy. To add a new chain, copy
 * this file, rename it to <COIN>.js, register it in index.js, and tweak the
 * values.
 *
 * This is PURE DATA: no getConfig() switch and no env reads. Network selection
 * and the regtest-only env overrides (genesis pins, FULLNODE cadence,
 * FEE_DESTINATION) are applied by coins/index.js, so the env surface lives in
 * exactly one place and mainnet/testnet carry none of it.
 *
 * Fields are split by coins/index.js into three consensus classes: the
 * pinned-verify-only subset (gas schedule, staking, fee math, addresses,
 * genesis, network byte-prefixes) is content-hashed and must stay byte-identical
 * fleet-wide; display/connection fields may be served live. See the platform
 * plan and genesis.js for the hash-pin rationale.
 *
 ********************************************************************/
module.exports = {

    // ── IDENTITY ────────────────────────────────────────────────────────────
    tick:        'BTC',          // uppercase ticker; the map key used everywhere
    fullName:    'bitcoin',      // hub configs-table coin key + COIN_FULL_NAME
    displayName: 'Bitcoin',      // explorer chain.name
    site:        'https://bitcoin.org',
    decimals:    8,              // native-coin decimal places

    // Default cross-chain attestation depth (hub DEFAULT_CONFIRMATIONS). Operators
    // may override per coin via XCHAIN_CONFIRMATIONS_BTC; this is the factory value.
    confirmations: 6,

    // ── PER-NETWORK PARAMS ──────────────────────────────────────────────────
    networks: {

        mainnet: {
            // bitcoinjs-lib network object + XChain relay overlays. Consumers
            // (decoder/encoder/utxo-tracker) pass this straight to bitcoinjs for
            // address coding, so the byte-prefixes are consensus-critical.
            net: {
                messagePrefix:               '\x18Bitcoin Signed Message:\n',
                bech32:                      'bc',
                bip32:                       { public: 0x0488b21e, private: 0x0488ade4 },
                pubKeyHash:                  0x00,
                scriptHash:                  0x05,
                wif:                         0x80,
                dustThreshold:               546,
                minStandardTxNonWitnessSize: 65,
                singleOpReturnPolicy:        true,
            },
            // Indexing start boundary only; NOT part of any consensus hash.
            firstBlock: 950000,
            // Canonical protocol address roles (UPPERCASE). Consumer adapters
            // alias these (explorer uses lowercase protocol/community/explorer).
            addresses: {
                BURN:            '1XChainBurnAddressXXXXXXXXXbRsd2N',
                GAS:             '1XChain3M4uRwcHqt4XuhVBUQ8cL4qQsA',
                DONATE1:         '1Donate1GERVKPW6GFQcnGeTa8dgL6Abyp', // Protocol Development
                DONATE2:         '1Donate2LkbBrsanwCVRPWZCXAqQcvcqGz', // Community Development
                FEE_DESTINATION: '1FeesxM9LTEjBYVTkynK6jfDBgvksuh2WL', // native-fee destination (env-overridable)
                REWARD:          '1rewardsZAyeuLeFJKoAepYiNN5N6uSzn',  // validator reward pool (COLLECT)
                EXPLORER:        '1Donate3GBGSZzzrS9U9gUgURYKscAE6Yn', // display-only donation; not read by indexer
            },
            // Genesis ledger bootstrap pin (Counterparty name carry-forward).
            // mainnet is frozen at launch; LEDGER_HASH = sha256 of the bundled CSV,
            // DUMP_HASH = sha256 of the uncompressed bundled state dump.
            // DUMP_HASH re-pinned 2026-06-26: XCHAIN gas token injected as genesis token #1
            // (decimals 8, max_supply 100M, mint disabled, GAS-owned); ledgerHash unchanged
            // (XCHAIN is injected in genesis.js code, not the CSV manifest).
            genesis: {
                block:      950000,
                ledgerHash: 'f347a0499654b128dd0461441ed6341ac27a24b909d6ff6e3995db4e69dc23e5',
                dumpHash:   'e416c382dd6951ce5c4da7e053f6dbb407ca3d966a513209eb59886dbe95e738',
            },
        },

        testnet: {
            net: {
                messagePrefix:               '\x18Bitcoin Signed Message:\n',
                bech32:                      'tb',
                bip32:                       { public: 0x043587cf, private: 0x04358394 },
                pubKeyHash:                  0x6f,
                scriptHash:                  0xc4,
                wif:                         0xef,
                dustThreshold:               546,
                minStandardTxNonWitnessSize: 65,
                singleOpReturnPolicy:        true,
            },
            firstBlock: 138000,
            addresses: {
                BURN:            'mxchainburnaddressXXXXXXXXXXa8EAfp',
                GAS:             'mgassdEpzH2AuKGK9W5FZh8drWYKrpXk6D',
                DONATE1:         'mfztXKX1HeVdCQf6pDCZFEzo5i5wYNHAM6',
                DONATE2:         'myBbbZ4t7BPoyNcT4sHtFwZDuiyYGDXLQM',
                FEE_DESTINATION: 'mfees5QurRs5BHXofdGpTG5pXB6uC6R8RU',
                REWARD:          'mrewards4RQFYoZ5yEv4xr12PzfjDYViks',
                EXPLORER:        'n1jbLKMrhvFae7NwTj37ZtkN4uPy29o9aM',
            },
            // Testnet launches CLEAN (genesis disabled, like LTC); namespace open.
            genesis: { block: 0, ledgerHash: null, dumpHash: null },
        },

        regtest: {
            net: {
                messagePrefix:               '\x18Bitcoin Signed Message:\n',
                bech32:                      'bcrt',
                bip32:                       { public: 0x043587cf, private: 0x04358394 },
                pubKeyHash:                  0x6f,
                scriptHash:                  0xc4,
                wif:                         0xef,
                dustThreshold:               546,
                minStandardTxNonWitnessSize: 65,
                singleOpReturnPolicy:        true,
            },
            firstBlock: 0,
            addresses: {
                BURN:            'mxchainburnaddressXXXXXXXXXXa8EAfp',
                GAS:             'mgash6jYSKAR3Q5HPpDgNX2BYr18q9N6GQ',
                DONATE1:         'muYHF9MMnK6Nmd5zx7EBtqEYZdaf2Xy8JX',
                DONATE2:         'mkQd27aJSqsQ666z1Q4MLFmd3Ybqzy3TNw',
                FEE_DESTINATION: 'mfeesX6rLE6V3WPg9tsbL2fHNS7E4rDAim',
                REWARD:          'mrewardshQqD1ptkEBZGjPDF77L5uKJQmk',
                EXPLORER:        'mrDH7rA2ZmGoh4Qx5guhDBJbZotUd6XyVH',
            },
            // Regtest genesis is env-driven so the e2e harness can point it at a
            // current regtest block + test manifest. index.js reads these env vars
            // for network === 'regtest' ONLY; mainnet/testnet ignore them.
            genesis: {
                $envOverrides: {
                    block:      { env: 'XCHAIN_GENESIS_BLOCK',       type: 'int', default: 0 },
                    ledgerHash: { env: 'XCHAIN_GENESIS_LEDGER_HASH', type: 'str', default: null },
                    dumpHash:   { env: 'XCHAIN_GENESIS_DUMP_HASH',   type: 'str', default: null },
                },
            },
        },
    },

    // ── COIN-LEVEL CONSENSUS PARAMS (network-independent) ────────────────────
    // These gate block-hashed state and must change only via a coordinated node
    // upgrade or a governance flag-day. The indexer never live-polls them.

    // Legacy fee constants (used before UNIFIED_FEES activation).
    legacyFees: {
        ISSUANCE_FEE_TOKEN:          '1.00000000',
        ISSUANCE_FEE_SUBTOKEN:       '0.50000000',
        EXPIRATION_FEE_DEFAULT_DAYS: 90,
        EXPIRATION_FEE_FREE_DAYS:    182,
        EXPIRATION_FEE_PER_DAY:      '0.00547945',
    },

    GAS_PRICE:                        '0.00001', // XCHAIN per gas unit
    UNIFIED_EXPIRATION_FEE_FREE_DAYS: 90,
    FEE_PAYMENT_MODE:                 'xchain',   // informational only; not read at runtime (see detectFeePaymentMode)
    FEE_TOLERANCE_MIN:                '0.95',
    FEE_TOLERANCE_MAX:                '1.10',
    ORACLE_MAX_PRICE_AGE_SECONDS:     1800,
    VALIDATOR_QUERY_LIMIT:            1000,        // CONSENSUS-CRITICAL cap on validator-set queries

    GAS_SCHEDULE: {
        ISSUE:                 100000,
        ISSUE_SUBTOKEN:        50000,
        EXPIRATION_PER_DAY:    550,
        OWNERSHIP_ESCROW:      50000,
        AIRDROP_PER_RECIPIENT: 100,
        DIVIDEND_PER_RECIPIENT: 100,
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
        COOLDOWN_BLOCKS:         1000, // ~7 days at ~10 min/block
        ACTIVATION_DELAY_BLOCKS: 6,    // ~60 min reorg protection at ~10 min/block
        // Per-capability MIN_STAKE + permissionless-SLASH bounty/treasury policy.
        // Mainnet-inert until the EQUIV_HEADER flag-day. See actions/slash.js.
        CAPABILITIES: {
            price:          { MIN_STAKE: '1000.00000000', SLASH: { BOUNTY_BPS: 500, BOUNTY_FLOOR: '50.00000000', BOUNTY_CAP: '1000.00000000' } },
            cross_chain:    { MIN_STAKE: '5000.00000000', SLASH: { BOUNTY_BPS: 500, BOUNTY_FLOOR: '50.00000000', BOUNTY_CAP: '1000.00000000' } },
            oracle_publish: { MIN_STAKE: '500.00000000',  SLASH: { BOUNTY_BPS: 500, BOUNTY_FLOOR: '50.00000000', BOUNTY_CAP: '1000.00000000' } },
            attestation:    { MIN_STAKE: '1000.00000000', SLASH: { BOUNTY_BPS: 500, BOUNTY_FLOOR: '50.00000000', BOUNTY_CAP: '1000.00000000' } },
            full_node:      { MIN_STAKE: '2000.00000000' },
        },
    },

    // SLASH policy for XCONFIG (config-change) equivocation; config signers are the
    // whole federation, so this has no CAPABILITIES home. Same shape/defaults as a
    // capability SLASH block. Mainnet-inert until the EQUIV_HEADER flag-day.
    CONFIG_SLASH: { BOUNTY_BPS: 500, BOUNTY_FLOOR: '50.00000000', BOUNTY_CAP: '1000.00000000' },

    // Full-node possession-proof / verified-validator tier (NODEPROOF.md). The
    // regtest-only env/sidecar overrides are applied by index.js for regtest ONLY;
    // mainnet/testnet keep these frozen defaults with no env surface.
    FULLNODE: {
        CHALLENGE_INTERVAL_BLOCKS:    144,
        CONFIRM_DEPTH:                100,
        PROOF_WINDOW_BLOCKS:          300,
        VERDICT_ACCEPT_WINDOW_BLOCKS:  24,
        REWARD_SHARE:                 '0',
        REWARD_PASS_WINDOW_BLOCKS:   1008,
        MIN_PASS_RATE_BPS:           7000,
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
            GENESIS_VERIFIERS:            { env: 'FULLNODE_GENESIS_VERIFIERS',            type: 'csv_lower' },
        },
    },
};
