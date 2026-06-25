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

        testnet: {
            BTC:  '63dbeef3ea93fa5ece4ea823f4e1f13d299f274fd869e264d713b58d0e79a66d',
            LTC:  '39862b4a35bd5c255e68fb065b3bfe0cb3752f4b9a3562a2a23f674fed0482ea',
            DOGE: 'c5dca915fb5c8233b52eeac061853b4aa9843d19569870c45ec19d8853136cf6',
        },

        regtest: {
            BTC:  '3a33f0830b7138245b05767a905a1820c51b04b4bffd1178a4628e0bf41cafac',
            LTC:  '6e8a60b0aa4f78f1e64353778252b01d09f41b01ad351d6aa26ab354be4d9645',
            DOGE: '51a8be37d15a183723338bf157365d2fa2c28fad36440db958df2dae86f544fb',
        },
    },
};
