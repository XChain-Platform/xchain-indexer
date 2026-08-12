/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * Publisher-scoped archive batches flag-day.
 *
 * THE PROBLEM. An ANCHOR archive batch was identified by MATCH_BATCH_SEQ alone,
 * with its head defined as "the earliest row carrying that seq" (deliberately
 * status-agnostic, since a mirrored node and an unmirrored node disagree on a
 * head's verified status, and a status-filtered pick would fork them).
 * MATCH_BATCH_SEQ is not unique (replay and failover double-publish both admit
 * an equal seq), so anyone could broadcast a junk head at the next seq and
 * capture the batch: its bogus TOTAL_CHUNKS became the geometry gate every
 * legitimate chunk was measured against, and its SOURCE became the only
 * author whose chunks counted, so the real publisher's chunks were filtered
 * out and the archive never reassembled.
 *
 * THE FIX. The batch key becomes (MATCH_BATCH_SEQ, HEAD AUTHOR): a chunk is
 * judged against the earliest head for that seq authored by the SAME address,
 * so a head governs only its own publisher's chunks. This is the only
 * discriminator that stays status-agnostic, needs no schema change, and is
 * decidable at parse time. A junk head can then only ever head its own junk
 * batch; honest operation is bit-identical, since a seq published by exactly
 * one author still resolves to the same head.
 *
 * WHY GATED. This changes consensus-visible chunk-status verdicts (feeding
 * the class-6 anchor_invalid state-hash preimage), so it lands default inert:
 * below the threshold the legacy canonical-head rule runs and historical
 * replay is byte-identical. Pin real heights on the coordinated mainnet
 * activation train and deploy every indexer (and any recovery host) before
 * the network crosses its height.
 *
 * KEYED ON THE DOGE BLOCK INDEX OF THE BATCH'S CANONICAL HEAD, per network,
 * not on SNAPSHOT_BLOCK like the anchor-reward family: a v2 chunk carries no
 * snapshot block, and gating on the chunk's own block would let a head and
 * its chunks straddle two rules. No per-chain keys: ANCHOR is valid only on
 * DOGE.
 *
 ********************************************************************/

'use strict';

// Per-network activation, interpreted against the DOGE block_index of the batch's
// canonical archive head. Placeholders are INERT (no live network can reach them);
// regtest is armed from genesis so fresh regtest stacks exercise the rule end to end.
const ARCHIVE_BATCH_AUTHOR_ACTIVATION = {
    mainnet: 999999999,   // INERT placeholder; pin to a real height on the coordinated mainnet activation train before arming
    testnet: 999999999,   // INERT placeholder
    regtest: 0,           // armed from genesis
};

// Whether archive batches are publisher-scoped for a batch whose canonical head
// landed at DOGE height `blockIndex` on `network`. A non-numeric height or an
// unknown network -> false (legacy canonical-head rule, deployed behavior kept).
function isArchiveBatchAuthorActive(blockIndex, network){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = ARCHIVE_BATCH_AUTHOR_ACTIVATION[network];
    if(threshold === undefined) return false;
    return b >= threshold;
}

module.exports = {
    ARCHIVE_BATCH_AUTHOR_ACTIVATION,
    isArchiveBatchAuthorActive
};
