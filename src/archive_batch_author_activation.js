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
 * Publisher-scoped archive batches flag-day .
 *
 * THE PROBLEM. An ANCHOR archive batch was identified by MATCH_BATCH_SEQ alone,
 * and its head was "the earliest v1/v6 row carrying that seq" - deliberately
 * STATUS-AGNOSTIC, because a node with no mirrored oracle_publish snapshot stores
 * an unverifiable head 'unverified' where a mirrored node stores 'valid' /
 * 'invalid: ...', so a status-filtered pick would fork mirrored and unmirrored
 * nodes (see  P5). MATCH_BATCH_SEQ is not unique (the replay guard admits an
 * EQUAL seq, for re-broadcast and failover double-publish), so anyone could
 * broadcast a junk head at the next batch seq and CAPTURE the batch:
 *
 *   - its bogus TOTAL_CHUNKS became the geometry gate every legitimate chunk was
 *     measured against (this half predates #3075), and
 *   - since #3075 its SOURCE became the only author whose chunks counted, so the
 *     real publisher's chunks were filtered out of the read set and the archive
 *     never reassembled.
 *
 * THE DISCRIMINATOR. The batch key becomes (MATCH_BATCH_SEQ, HEAD AUTHOR): a v2
 * continuation chunk is judged against the earliest head for that seq authored by
 * the SAME address, and a head governs only the chunks of its own publisher. This
 * is the only discriminator available that is status-agnostic (no mirrored /
 * unmirrored fork), needs no schema change, and is decidable at parse time -
 * "which head's CRC actually reassembles" is not known when a chunk is parsed, and
 * "the head the archive-leader election picked" needs the mirrored snapshot, i.e.
 * exactly the mirror dependence that forbids a status filter. Authorship comes from
 * actions.source_id, authoritative for auth (never re-derived from the transaction).
 *
 * A junk head is then only ever the head of its OWN (junk) batch: it can deny
 * nothing, and it reassembles against its own CRC or not at all. The liveness cost
 * recorded for #3075 is unchanged - within one publisher the earliest head still
 * wins - and honest operation is bit-identical, because a batch seq published by
 * exactly one author resolves to the same head under both rules.
 *
 * WHY GATED. It changes consensus-visible verdicts: a chunk that was
 * 'invalid: TOTAL_CHUNKS ...' / 'invalid: SOURCE ...' under a captured batch is
 * 'valid' (or 'orphan') under its own publisher's head, and chunk status feeds the
 * class-6 anchor_invalid state-hash preimage. So it lands DEFAULT INERT: below the
 * threshold the legacy canonical-head rule runs and historical replay is
 * byte-identical. Pin real heights via the  flag-day set and deploy every
 * indexer (and any recovery host) BEFORE the network crosses its height.
 *
 * KEYED ON THE DOGE BLOCK INDEX OF THE BATCH'S CANONICAL HEAD, per network. Not on
 * SNAPSHOT_BLOCK like the anchor-reward family: a v2 chunk carries no snapshot
 * block (VERSION|MATCH_BATCH_SEQ|CHUNK_INDEX|TOTAL_CHUNKS|ARCHIVE_B64_CHUNK), and
 * not on the chunk's own block either, because head and chunks of one batch must
 * never straddle two rules. The canonical (earliest, status-agnostic) head is the
 * one row every node agrees on for a batch seq without looking at status, so it is
 * the gate anchor in the parse path, the read path and recovery alike. No per-chain
 * keys: ANCHOR is valid only on DOGE, so the network alone identifies the venue.
 *
 ********************************************************************/

'use strict';

// Per-network activation, interpreted against the DOGE block_index of the batch's
// canonical archive head. Placeholders are INERT (no live network can reach them);
// regtest is armed from genesis so fresh regtest stacks exercise the rule end to end.
const ARCHIVE_BATCH_AUTHOR_ACTIVATION = {
    mainnet: 999999999,   // INERT placeholder; pin via the  flag-day set before arming
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
