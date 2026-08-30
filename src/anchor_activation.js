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
 * ANCHOR_ACTIVATION: where the ANCHOR version set restarts at v0.
 *
 * Kept byte-identical to xchain-documentation/protocol/constants.js by
 * test/unit/activationConstantsParity.test.js. Keyed on the anchor's OWN
 * DOGE block_index (data['BLOCK_INDEX'] at parse time), the same key
 * archive_head_unverified_gate_activation.js uses, never on SNAPSHOT_BLOCK
 * or on the checkpointed height of another chain.
 *
 ********************************************************************/

'use strict';

// ANCHOR_ACTIVATION: the DOGE height (per network) at/above which the ANCHOR wire set restarts at
// version 0 (v0 = the per-network checkpoint bundle, v1 = the archive head with its publisher tail,
// v2 = the archive continuation chunk). Every ANCHOR mined BELOW this height, of any version, is
// invalid ('invalid: ANCHOR before activation'); at/above it only versions 0/1/2 parse and every
// other version byte is 'invalid: VERSION (unknown)'. Keyed on the action's OWN DOGE block_index
// (data['BLOCK_INDEX'] at parse time, anchor_actions.block_index_doge), never on SNAPSHOT_BLOCK or
// the checkpointed height: the row being judged is the anchor itself. Mainnet 6360000 sits ABOVE
// the chain tip on purpose: the restarted wire set has NOT activated on mainnet yet, and the height
// is a flag day the operator arms deliberately rather than one that silently already passed.
// Testnet 67858600 is 24 blocks above its last pre-restart anchor (67858576) and is already past.
// Neither is 0, because both carry pre-restart history (mainnet 56 rows, testnet 11, measured
// 2026-08-30): at 0 the gate can never fire, so the retired wires fall through to the restarted
// version table and are read as shapes they are not. The old per-chain version 0 would report as a
// checkpoint bundle carrying SPV roots and a publisher attestation, and the old tail-less version 1
// as an archive head with a publisher tail; on mainnet those rows carry state_root NULL 36/36 and
// no publisher_attestations field at all 56/56. Regtest is 0: its stacks are rebuilt from genesis.
// Operator rulings 2026-08-30.
const ANCHOR_ACTIVATION = {
    mainnet: 6360000,
    testnet: 67858600,
    regtest: 0,
};

// Is an ANCHOR mined at DOGE height `blockIndex` on `network` at/above the v0
// activation? A non-numeric height or an unknown network fails closed (false):
// the action is then 'invalid: ANCHOR before activation', never silently admitted.
function isAnchorActive(blockIndex, network){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = ANCHOR_ACTIVATION[network];
    if(threshold === undefined) return false;
    return b >= threshold;
}

module.exports = { ANCHOR_ACTIVATION, isAnchorActive };
