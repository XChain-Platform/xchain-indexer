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
        testnet: {
            BTC:  'a04af39cd9d3d332a6c043c02e0920075857078437cb46c7d07c9da143d1b551',
            LTC:  '185dddc98eb5c94d9069f006a9acb1b1fd6f2772b0a91a6b68a6e0ceddcba778',
            DOGE: '860422244b1317a2a125d38a49358fc01d639d9a50c173828235787368884610',
        },

        regtest: {
            BTC:  '24e6a363e5a36285574dea357328a997fdee5762ef812d8947eacf69c51afc24',
            LTC:  '5ad03b383d873d309640e75dfefa2787a5806cb8a84ee46f4cc7fb25ca7f808b',
            DOGE: '019220a461e34c99fcf5cbf107673f13d3f2a57d2a20e16a0323ed44c81edd11',
        },
    },
};
