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
 * XChain Platform - Canonical Coin Definition - Litecoin (LTC)
 *
 * SINGLE SOURCE OF TRUTH for all Litecoin-specific facts. See coins/BTC.js for
 * the schema rationale and how coins/index.js applies network selection +
 * regtest-only env overrides. Pure data: no getConfig() switch, no env reads.
 *
 * LTC is a native-fee chain: fees are paid in the native coin (no XCHAIN balance
 * deduction), capability staking is BTC-only, and there is no Counterparty-style
 * source ledger, so genesis stays disabled on mainnet/testnet.
 *
 ********************************************************************/
module.exports = {

    // ── IDENTITY ────────────────────────────────────────────────────────────
    tick:        'LTC',
    fullName:    'litecoin',
    displayName: 'Litecoin',
    site:        'https://litecoin.org',
    decimals:    8,

    confirmations: 12, // default cross-chain attestation depth (hub DEFAULT_CONFIRMATIONS)

    // Block/transaction wire-serialization family (see BTC.js). Litecoin carries the
    // MWEB HogEx marker+flag (0x08 / 0x09) that plain bitcoinjs misreads, so its
    // blocks/txs are parsed via the 'mweb' strip path in the decoder.
    wireFormat: 'mweb',

    // Address roles excluded from the consensus subset/hash (display-only; not read
    // by the indexer). Every role NOT listed here is consensus-relevant and folds
    // into the pinned hash. Declared beside the data so a new display-only role is
    // classified where it is added, and a rename moves the classification with it
    // (consensusSubset in index.js derives the exclusion from this list).
    DISPLAY_ONLY_ADDRESS_ROLES: ['EXPLORER'],

    // ── PER-NETWORK PARAMS ──────────────────────────────────────────────────
    networks: {

        mainnet: {
            net: {
                messagePrefix:               '\x19Litecoin Signed Message:\n',
                bech32:                      'ltc',
                bip32:                       { public: 0x019da462, private: 0x019d9cfe },
                pubKeyHash:                  0x30,
                scriptHash:                  0x32,
                wif:                         0xb0,
                dustThreshold:               5460,
                minStandardTxNonWitnessSize: 85,
                singleOpReturnPolicy:        true, // DOGE/LTC enforce one OP_RETURN per tx
            },
            firstBlock: 3120000,
            // Block-0 hash of the chain (full rationale in BTC.js mainnet).
            // Unpinned until the operator reads it off the fleet's own node:
            // `litecoin-cli getblockhash 0`. Not in consensusSubset(), so pinning it
            // moves no CONSENSUS_CONFIG_PIN.
            chainGenesisHash: null,
            addresses: {
                BURN:            'LXChainBurnAddressXXXXXXXXXXSkrYkJ',
                GAS:             'LXChainCN6yjHVqqS9tYzYVYZ8CCZcSx72',
                DONATE1:         'Ldonate18tNZcVThKm5MX33EjvhaanJ6Mg', // Protocol Development
                DONATE2:         'Ldonate2io846q2e7q8dUArh3TNnaq9ENb', // Community Development
                FEE_DESTINATION: 'Lfees7tszAx5Gqam2fuqf6biaX3LXafM4H', // native-fee destination (regtest-only env override; ignored on mainnet/testnet)
                REWARD:          'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', // structural only; COLLECT/XCHAIN are BTC-only
                EXPLORER:        'Ldonate3FfyqbYQAYxo3qjFLcu28oUdAfn', // display-only donation
            },
            // No LTC source ledger; genesis disabled (no dumpHash on LTC).
            // XCP/XDP airdrop leg: DISARMED, and disarmed HERE rather
            // than by leaving the keys off a node's environment. The bucket set decides how
            // much XCHAIN each snapshot holder mints and which synthetic tx hashes carry the
            // credits, so on mainnet/testnet it is bundle data like every other genesis pin;
            // the indexer ignores the GENESIS_AIRDROP_* env vars off regtest. Arming the leg
            // is an edit here (index-aligned paths + sha256 content pins + XCHAIN amounts)
            // plus airdropSetHash - the sha256 over the canonical `name:hash:amount` lines,
            // which genesis.js verifies before it credits anything - followed by a
            // bin/sync-coins.sh re-vendoring wave.
            genesis: {
                block:      0,
                ledgerHash: null,
                airdropPaths:         [],
                airdropHashes:        [],
                airdropAmounts:       [],
                airdropSnapshotBlock: null,
                airdropSetHash:       null,
            },
        },

        testnet: {
            net: {
                messagePrefix:               '\x19Litecoin Signed Message:\n',
                bech32:                      'tltc',
                bip32:                       { public: 0x0436f6e1, private: 0x0436ef7d },
                pubKeyHash:                  0x6f,
                scriptHash:                  0xc4,
                wif:                         0xef,
                dustThreshold:               5460,
                minStandardTxNonWitnessSize: 85,
                singleOpReturnPolicy:        true,
            },
            // Fresh testnet genesis 2026-08-24 (operator): was 4855000 (the
            // 2026-08-10 genesis). Raised to just under the live tip (4862567 at
            // the decision) so the public testnet announces with zero
            // pre-announcement test actions and replays in seconds. Consensus
            // input (folded into consensusSubset), so it moves the LTC testnet
            // pin and ships in one wave with every other vendoring service.
            firstBlock: 4862500,
            // Block-0 hash of the chain (see mainnet above). Unpinned until the operator
            // reads it off the fleet's own node: `litecoin-cli -testnet getblockhash 0`.
            chainGenesisHash: null,
            addresses: {
                BURN:            'mxchainburnaddressXXXXXXXXXXa8EAfp',
                GAS:             'mgashLN9oSvj2CUJYKWdNxh6VkamPg1Ges',
                DONATE1:         'mybp5CceJvVV5tNCCiF7oBiZWko2fNkmnT',
                DONATE2:         'muKEjejjXQvLY7Lp7Ecpn29gM2TCb5BLTF',
                FEE_DESTINATION: 'mfeeskqGYw3wXYqMZFnUxBwGposEvjziRW',
                REWARD:          'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
                EXPLORER:        'mzCXcxcECbY5aNSXsfWjzKQN1YwoefEcG8',
            },
            // Airdrop keys carried explicitly and empty for the same reason as mainnet:
            // testnet is a multi-operator federation, so an env-armed bucket set would let
            // one node mint an allocation the rest of the federation never derives.
            genesis: {
                block:      0,
                ledgerHash: null,
                airdropPaths:         [],
                airdropHashes:        [],
                airdropAmounts:       [],
                airdropSnapshotBlock: null,
                airdropSetHash:       null,
            },
        },

        regtest: {
            net: {
                messagePrefix:               '\x19Litecoin Signed Message:\n',
                bech32:                      'rltc',
                bip32:                       { public: 0x0436f6e1, private: 0x0436ef7d },
                pubKeyHash:                  0x6f,
                scriptHash:                  0xc4,
                wif:                         0xef,
                dustThreshold:               5460,
                minStandardTxNonWitnessSize: 85,
                singleOpReturnPolicy:        true,
            },
            firstBlock: 0,
            // Deliberately unset on regtest: every stack mines its own chain, so there is
            // no stable block-0 hash to pin (see BTC.js regtest).
            chainGenesisHash: null,
            addresses: {
                BURN:            'mxchainburnaddressXXXXXXXXXXa8EAfp',
                GAS:             'mgas5QYE38Bg34hwEjFKaE7Gs536FARue4',
                DONATE1:         'mgNY2ZXbnNEkRT5ZRF8yGamivrSX2QH97h',
                DONATE2:         'n2DLJPppXUi8jC6fLiSkthZi2sc9UKiZHd',
                FEE_DESTINATION: 'mfeesJdVLx23zhtsCveA8EEfmHX7qSV2Ls',
                REWARD:          'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
                EXPLORER:        'myL7sZGPEG3LhFXn7RFCZ321r8bxgmgDBz',
            },
            // Regtest binds genesis via env so the mechanism can be exercised on a
            // regtest LTC stack (no dumpHash on LTC). index.js applies for regtest only.
            genesis: {
                $envOverrides: {
                    block:      { env: 'XCHAIN_GENESIS_BLOCK',       type: 'int', default: 0 },
                    ledgerHash: { env: 'XCHAIN_GENESIS_LEDGER_HASH', type: 'str', default: null },
                    // XCP/XDP airdrop leg. Registering it here is what makes the leg
                    // regtest-only-configurable: the indexer used to read these
                    // three env vars on EVERY network, so two mainnet replay nodes with
                    // byte-identical snapshot CSVs could still mint different allocations.
                    // Paths compact empty entries; hashes/amounts keep them, because entry N
                    // pins/funds entry N and an empty hash means "this bucket is unpinned".
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
    legacyFees: {
        ISSUANCE_FEE_TOKEN:          '0.50000000',
        ISSUANCE_FEE_SUBTOKEN:       '0.25000000',
        EXPIRATION_FEE_DEFAULT_DAYS: 90,
        EXPIRATION_FEE_FREE_DAYS:    182,
        EXPIRATION_FEE_PER_DAY:      '0.00273973',
    },

    GAS_PRICE:                        '0.00001',
    UNIFIED_EXPIRATION_FEE_FREE_DAYS: 90,
    FEE_PAYMENT_MODE:                 'native', // LTC: native-only; informational, not read at runtime
    FEE_TOLERANCE_MIN:                '0.95',
    FEE_TOLERANCE_MAX:                '1.10',
    ORACLE_MAX_PRICE_AGE_SECONDS:     1800,
    VALIDATOR_QUERY_LIMIT:            1000,

    GAS_SCHEDULE: {
        ISSUE:                 100000,
        ISSUE_SUBTOKEN:        50000,
        EXPIRATION_PER_DAY:    550,
        OWNERSHIP_ESCROW:      50000,
        AIRDROP_PER_RECIPIENT: 100,
        DIVIDEND_PER_RECIPIENT: 100,
        // SWEEP / CALLBACK, priced on the unified schedule from the
        // UNIFIED_FEES_SWEEP_CALLBACK flag day. The legacy flat per-DB-hit fee prices a
        // small action BELOW the dust threshold of a native-fee chain (LTC/DOGE, where a
        // missing fee output is rejected outright rather than falling back to an XCHAIN
        // balance debit), so the fee output cannot be created and the action cannot be
        // submitted at all: a Litecoin SWEEP needs ~273 DB hits before it clears LTC's
        // 5460-satoshi floor at LTC $100 / XCHAIN $2.
        //
        // The BASE keys are what close that: gas is what buys the output, so the SMALLEST
        // possible SWEEP or CALLBACK has to buy an above-dust one on its own. The floor a
        // chain demands is dust_sats * COIN_USD / (1000 * XCHAIN_USD) gas units, so 5000 gas
        // (0.05 XCHAIN) clears Litecoin while COIN/XCHAIN stays under ~915 and Dogecoin
        // while it stays under ~50, both far outside any plausible band. The PER_ITEM keys
        // hold the marginal cost at AIRDROP/DIVIDEND per-recipient parity; a SWEEP item is
        // one swept balance, one closed order/swap/dispenser escrow, or one transferred
        // ownership.
        SWEEP_BASE:            5000,
        SWEEP_PER_ITEM:        100,
        CALLBACK_BASE:         5000,
        CALLBACK_PER_RECIPIENT: 100,
        // BET (parimutuel betting, spec decision F): feed creation is duration-
        // metered like ORDER/SWAP/DISPENSER expiration (same free window via
        // UNIFIED_EXPIRATION_FEE_FREE_DAYS) but under its OWN per-day key so the
        // two families can be re-priced independently; BET_PER_CREDIT pre-funds
        // each bet's single terminal credit at place time (AIRDROP/DIVIDEND
        // per-recipient parity). Resolve and cancel are free by design.
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
        COOLDOWN_BLOCKS:         4032, // ~7 days at ~2.5 min/block
        ACTIVATION_DELAY_BLOCKS: 24,   // ~60 min reorg protection at ~2.5 min/block
        CAPABILITIES: {},              // capability staking is BTC-only at the protocol level
    },
};
