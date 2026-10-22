/*
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 */

'use strict';

// Whether one mirrored capability snapshot read would land on rows held out of the
// mirror for a pending checkpoint proof (hub_db_sync/barriers/capability_proof.js).
//
// The block loop no longer waits on every held row before a block. The snapshot a block
// reads is keyed by a BTC height carried inside its transactions (a price or attestation
// batch anchor, a match or call snapshot_block), and a landing-chain height says nothing
// about it, so the only exact place to decide is the read itself. A held row is absent
// from the mirror, so a read of its (snapshot_block, capability) would see a partial set
// and reach a quorum verdict its peers do not.
//
// Overflowed rows are not tracked by key, so an armed overflow means any snapshot may be
// held: every read counts as held until the overflow re-page clears it, which is what the
// whole-set barrier did before.

const CAPABILITY_PROOF_DEFERRED = 'CAPABILITY_PROOF_DEFERRED';

/**
 * @param {object|null} sync the HubDbSync client, or null when this node mirrors nothing
 * @param {string} capability the capability the read resolves
 * @param {number|string} snapshotBlock the BTC snapshot_block the read keys on
 * @returns {boolean} true when the read must not run yet
 */
function capabilityReadHeld(sync, capability, snapshotBlock){
    if(!sync || !sync.enabled) return false;
    if(sync._capabilityProofOverflow) return true;
    let holds = sync._capabilityProofHolds;
    if(!(holds instanceof Map) || holds.size === 0) return false;
    let block = Number(snapshotBlock);
    for(let row of holds.values()){
        if(!row) continue;
        if(String(row.capability) !== String(capability)) continue;
        // A hold whose height does not parse cannot be ruled out, so it counts.
        let heldAt = Number(row.snapshot_block);
        if(!Number.isFinite(heldAt) || !Number.isFinite(block) || heldAt === block) return true;
    }
    return false;
}

module.exports = { CAPABILITY_PROOF_DEFERRED, capabilityReadHeld };
