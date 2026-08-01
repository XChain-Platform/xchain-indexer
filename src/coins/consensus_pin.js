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
        testnet: {
            BTC:  'f9ec594c2b9ae8b33a653faed64a36578ca11472e00f2e3cc6258541b35460ed',
            LTC:  '03f62fc2f57151924aa6a76ff5ee97684aece17ca54a3f39eb7d8167bd34a20b',
            DOGE: '3ec0ad2f7290e36887d09a880761c217ea6b0eeb06078d708ee5c200ef2a2410',
        },

        regtest: {
            BTC:  '10b520d6b33487b46d9d9bcc5ecc6177eb233ebfc8cb1c4d94c1d4ef0c89899d',
            LTC:  '786d903d2b347803c06a1b5b157011834ebc25a246be54f5c27ddd27629eba57',
            DOGE: '9f448912ed9d24ac50dc16f132619c91115355c165e8f1a5bb3b630ea090f2e0',
        },
    },
};
