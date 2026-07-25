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
            BTC:  '211086b82b345092a8ce18ca08ab945a6b294c59efa5588c70eacdb5ee515e62',
            LTC:  '7e4cc52a609606024d1ea8d26c743957e195c660b0bb749e523f4cbdcc82baf8',
            DOGE: 'd61706332ddcb921b4bb3d0a9f077119426405692fc118eaba8d1a6a9ecb28d0',
        },

        regtest: {
            BTC:  'd900b05a7df14595ff4a2be4bbd9505a661f0c6cef4237f1e00aace3b2397f0e',
            LTC:  '769d91cad98ea674494290ac680bb1c0ddb8bcd3b75cbffa131365bf97811db1',
            DOGE: '3de84c0bf6478e985f0ea0cc0ece155cf2780f0e932c3f6e063d3f01bfc38197',
        },
    },
};
