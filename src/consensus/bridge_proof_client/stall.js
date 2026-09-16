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
 **********************************************************************
 *
 * XChain Platform - bridge escrow proof transport: the stall vocabulary.
 *
 * A proof that cannot be obtained YET is a DEFERRED BLOCK and never a refusal, so the barrier
 * name, the stall reasons and the error that carries them live together here, away from the
 * code that decides anything about a transfer.
 *
 ********************************************************************/

'use strict';

// The block loop's stall reason for a proof that cannot be obtained yet. The '_barrier'
// suffix is load-bearing: health.js keys its mirror-barrier class on it (isMirrorBarrierReason
// in XChainIndexer.js), so a proof stall reads as the mirror-lag stall it is rather than as a
// wedged indexer.
const BRIDGE_PROOF_BARRIER = 'bridge_proof_barrier';

// Why a pass stalled. LOG reasons, not consensus verdict strings: no action's STATUS is built
// from them and no canonical carries them.
const PROOF_STALL_REASON = {
    NO_CHECKPOINT: 'no quorum-established checkpoint at or after the transfer snapshot_block is held locally',
    NO_ENDPOINT:   'no origin-chain indexer endpoint is configured for the escrow proof',
    UNREACHABLE:   'the origin-chain indexer served no usable escrow proof',
};

// The ANCHOR wire version that carries a checkpoint SECTION in its own right. Version 1 is the
// archive head, which carries its WRAPPER checkpoint's identity rather than being one, and
// version 2 is a continuation chunk with no identity at all. Kept as a local constant rather
// than imported from anchor_action_query.js's CHECKPOINT_VERSIONS, which deliberately admits
// the archive head for the getanchoraction read: an archive head's state_root columns are NULL
// (see sql/anchor_actions.sql), so admitting it here would select a rootless "checkpoint" that
// fails CHECKPOINT_ROOTLESS and turn a provable transfer into a refusal.
const ANCHOR_SECTION_VERSION = 0;

/**
 * Raised when the proof for a transfer cannot be obtained YET. The caller must DEFER the
 * block, never refuse the row: see the header.
 */
class BridgeProofUnavailableError extends Error {
    constructor(transferId, detail){
        super('bridge escrow proof unavailable for transfer ' + String(transferId).substring(0, 16) + '...: ' + detail);
        this.name        = 'BridgeProofUnavailableError';
        this.transferId  = transferId;
        this.detail      = detail;
        this.stallReason = BRIDGE_PROOF_BARRIER;
    }
}

module.exports = { BRIDGE_PROOF_BARRIER, PROOF_STALL_REASON, BridgeProofUnavailableError };
