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
            addresses: {
                BURN:            'LXChainBurnAddressXXXXXXXXXXSkrYkJ',
                GAS:             'LXChainCN6yjHVqqS9tYzYVYZ8CCZcSx72',
                DONATE1:         'Ldonate18tNZcVThKm5MX33EjvhaanJ6Mg', // Protocol Development
                DONATE2:         'Ldonate2io846q2e7q8dUArh3TNnaq9ENb', // Community Development
                FEE_DESTINATION: 'Lfees7tszAx5Gqam2fuqf6biaX3LXafM4H', // native-fee destination (env-overridable)
                REWARD:          'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', // structural only; COLLECT/XCHAIN are BTC-only
                EXPLORER:        'Ldonate3FfyqbYQAYxo3qjFLcu28oUdAfn', // display-only donation
            },
            // No LTC source ledger; genesis disabled (no dumpHash on LTC).
            genesis: { block: 0, ledgerHash: null },
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
            firstBlock: 4765000,
            addresses: {
                BURN:            'mxchainburnaddressXXXXXXXXXXa8EAfp',
                GAS:             'mgashLN9oSvj2CUJYKWdNxh6VkamPg1Ges',
                DONATE1:         'mybp5CceJvVV5tNCCiF7oBiZWko2fNkmnT',
                DONATE2:         'muKEjejjXQvLY7Lp7Ecpn29gM2TCb5BLTF',
                FEE_DESTINATION: 'mfeeskqGYw3wXYqMZFnUxBwGposEvjziRW',
                REWARD:          'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
                EXPLORER:        'mzCXcxcECbY5aNSXsfWjzKQN1YwoefEcG8',
            },
            genesis: { block: 0, ledgerHash: null },
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
