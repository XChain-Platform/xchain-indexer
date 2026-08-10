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
 * XChain Platform - Consensus Config Pin
 *
 * Per-(network, coin) sha256 of the consensus-critical subset of the canonical
 * coin definitions (see coins/index.js consensusHash). A node verifies its OWN
 * bundled coin files against these pins at boot and fails closed on mismatch,
 * exactly as genesis.js verifies the bundled ledger CSV. The hub also serves
 * these hashes so a consumer can detect a hub that would serve divergent
 * consensus values (transport, not authority).
 *
 * mainnet is intentionally `null` (skip), mirroring the genesis-pin convention:
 * the fail-closed pin is armed on mainnet only in a coordinated release (plan
 * Phase 6), so a pre-launch value carries no risk of bricking a live BTC node.
 * testnet/regtest carry real pins so the mechanism is exercised before mainnet.
 *
 * A conformance test asserts these equal consensusHash(coin, network) for the
 * shipped coin files, so the pin can never silently drift from the defaults;
 * updating a consensus value means updating the matching pin in the same commit.
 *
 ********************************************************************/
module.exports = {
    CONSENSUS_CONFIG_PIN: {
        // Armed in a coordinated release (plan Phase 6). null = skip verification.
        mainnet: null,

        // REGENERATED 2026-07-28 ( batch, ): folding `wireFormat` into
        // consensusSubset() changes every hash by construction. Every service that
        // bundles these must ship the SAME new values in one wave; a straggler
        // fail-closes on verifyConsensusPin() rather than forking, which is the
        // designed behavior but halts that node until it is updated.
        //
        // BTC REGENERATED 2026-07-31 : minStandardTxNonWitnessSize 65 -> 82,
        // the relay-policy floor Bitcoin Core actually enforces. It lives in the `net`
        // block, which consensusSubset() hashes whole, so a pure policy correction
        // still moves the pin and still needs the one-wave rollout above. LTC and DOGE
        // are unchanged and re-verified against the canonical files.
        //
        // REGENERATED 2026-08-06 (): folding `firstBlock` into
        // consensusSubset() changes every hash by construction, same one-wave rollout
        // rule as the wireFormat fold above. Mainnet stays null (Phase 6 arms it).
        //
        // REGENERATED 2026-08-10 (fresh testnet genesis, operator): testnet
        // `firstBlock` moved to just under the live tip on all three chains
        // (BTC 138000 -> 147500, LTC 4765000 -> 4855000, DOGE 64800000 -> 67815000),
        // wiping the old testnet chain state. firstBlock is in consensusSubset, so
        // all three testnet hashes move and the one-wave rule above applies in full.
        // Regtest and mainnet are untouched, and their hashes were re-verified
        // against the canonical files as unchanged by this edit.
        testnet: {
            BTC:  '1e45a958ff9eb6a88be8684e3801b57e7afcfc9031f7761e4f4b1dcf1c8d42a9',
            LTC:  '888818a874d6d8acb3363355089f0de601c355b63fc8431a44ef666f91615202',
            DOGE: 'ea3ee0d1407959f3cb59e4baf66b50dfc2ada9962351e578d7c6d8586e6ff905',
        },

        regtest: {
            BTC:  '24e6a363e5a36285574dea357328a997fdee5762ef812d8947eacf69c51afc24',
            LTC:  '5ad03b383d873d309640e75dfefa2787a5806cb8a84ee46f4cc7fb25ca7f808b',
            DOGE: '019220a461e34c99fcf5cbf107673f13d3f2a57d2a20e16a0323ed44c81edd11',
        },
    },
};
