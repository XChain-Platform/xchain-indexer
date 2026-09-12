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

        // REGENERATED 2026-07-28: folding `wireFormat` into
        // consensusSubset() changes every hash by construction. Every service that
        // bundles these must ship the SAME new values in one wave; a straggler
        // fail-closes on verifyConsensusPin() rather than forking, which is the
        // designed behavior but halts that node until it is updated.
        //
        // BTC REGENERATED 2026-07-31: minStandardTxNonWitnessSize 65 -> 82,
        // the relay-policy floor Bitcoin Core actually enforces. It lives in the `net`
        // block, which consensusSubset() hashes whole, so a pure policy correction
        // still moves the pin and still needs the one-wave rollout above. LTC and DOGE
        // are unchanged and re-verified against the canonical files.
        //
        // REGENERATED 2026-08-06: folding `firstBlock` into
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
        //
        // REGENERATED 2026-08-24 (fresh testnet genesis, operator): testnet
        // `firstBlock` moved to just under the live tip on all three chains
        // (BTC 147500 -> 149700, LTC 4855000 -> 4862500, DOGE 67815000 -> 67847500)
        // so the public testnet announces with zero pre-announcement test actions.
        // Same one-wave rule as every regeneration above. Regtest and mainnet are
        // untouched and were re-verified as unchanged by this edit.
        // REGENERATED 2026-09-01: GAS_SCHEDULE gains SWEEP_BASE,
        // SWEEP_PER_ITEM, CALLBACK_BASE and CALLBACK_PER_RECIPIENT, the unified prices
        // SWEEP and CALLBACK move onto at the UNIFIED_FEES_SWEEP_CALLBACK flag day
        // (mainnet armed at genesis since the genesis arm; testnet armed
        // 2026-10-01T00:00:00Z; regtest genesis-active). GAS_SCHEDULE is hashed whole by
        // consensusSubset(), so ADDING a key moves every hash regardless of which
        // networks have the flag armed, and the same one-wave rollout rule as every
        // regeneration above applies in full: every service bundling these must ship
        // the new values together, and a straggler fail-closes on verifyConsensusPin()
        // at boot rather than forking. CONSENSUS_CONFIG_PIN.mainnet above stays null
        // regardless (Phase 6 arms that separate pin).
        // REGENERATED 2026-09-12 (XChain bridge, base and token): every network
        // block gains the ADDRESS.BRIDGE_<COIN> escrow roles (two per coin, one per
        // other chain) and GAS_SCHEDULE gains XBRIDGE_BASE. consensusSubset() hashes
        // the address map and the gas schedule WHOLE, so both edits move every hash by
        // construction regardless of where XCHAIN_BRIDGE_ACTIVATION stands, and the
        // same one-wave rollout rule as every regeneration above applies in full: every
        // service bundling these ships the new values together, and a straggler
        // fail-closes on verifyConsensusPin() at boot rather than forking. The escrow
        // addresses themselves are inert until the activation (nothing credits them
        // below it), so no pre-activation block hash moves; the pin moves because the
        // BUNDLE changed, which is exactly what the pin is for.
        // CONSENSUS_CONFIG_PIN.mainnet above stays null (Phase 6 arms that pin).
        testnet: {
            BTC:  'fcff7c1f46a8f7a75ddb7e1e4fb30f9e0c72d72f307a75a9d9357ffad29452c0',
            LTC:  '57373962a5c562f8ceb98fceb482c586741ecf8dd6335965c76f9b8e61a4eb87',
            DOGE: '5276c0a0fb161bbfd4e8b0acaabf38751dded4370ecce86455c57eb5de0e9bb2',
        },

        regtest: {
            BTC:  '63ee757834f6f815045321090fd89b446e784f442e3e7abf84b8c0fb3b479324',
            LTC:  'ab30c1d1fd444ca3dca1a9ec855bd587422e87d5e5e5e6b6f9ddadd1d2fb587d',
            DOGE: '34f8dafeff36f7c8ca3b327c3c915251e78e64448742860620522a92a69368a0',
        },
    },
};
