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
 * XChain Indexer - Rollback: archive and ATTEST batch head resets
 *
 * Restore a batch head an orphaned completing chunk stamped in place: the anchor
 * archive head reset to unverified, and the ATTEST v5 head restored to valid.
 * Installed onto Rollback.prototype by ./index.js; the statements are in
 * src/db/rollback/batch_heads.js.
 *
 ********************************************************************/

'use strict';

const headsSql = require('../db/rollback/batch_heads.js');

module.exports = {

    // Reset an anchor archive batch's parent (v1 archive-head) status that an
    // orphaned final chunk flipped to 'invalid_archive' IN PLACE on a surviving row. A
    // chunked archive batch spans multiple blocks: a head in an early block, then v2
    // continuation chunks in later blocks. When the LAST v2 chunk lands, anchor.js
    // reassembles the blob and, on a CRC mismatch against the parent's signed
    // batch_crc32, stamps the parent 'invalid_archive' via a direct UPDATE on the
    // parent row (created in an EARLIER block, so it survives the bulk delete below).
    // If that completing chunk is in the orphaned range, the delete removes the chunk
    // but cannot undo the in-place stamp, leaving the surviving parent stuck
    // 'invalid_archive' while a from-genesis replay (the bad chunk never re-mined, or
    // re-mined validly) would re-derive the parent's pre-flip status. anchor_actions
    // .status_id is not in any block-hash projection, so this is a state-table
    // divergence (and could mislead the archive-integrity flag / recovery selection,
    // which read the ARCHIVE_HEAD_VERSIONS set at status 'valid'/'unverified'), not a
    // consensus fork.
    //
    // Reset to 'unverified', the conservative re-verification state (anchor.js stores
    // a v1 'unverified' whenever its signer snapshot isn't locally mirrored, and
    // recovery re-verifies such rows from the archived snapshots), so a parent that was
    // 'valid' before the flip is re-promoted by recovery rather than left wrongly
    // terminal. We self-join the parent to an orphaned v2 chunk of the SAME
    // match_batch_seq and require that chunk's status be 'valid': a completing chunk is
    // always 'valid', and there can be at most TOTAL_CHUNKS-1 distinct valid chunks (the
    // duplicate-index guard rejects extras as 'invalid: ...'), so a surviving orphaned
    // VALID chunk proves fewer than the full set remain on the new chain, so the batch can
    // no longer reassemble there and the flip is not re-derivable. Filtering on 'valid'
    // also excludes a late duplicate chunk that landed (and was rejected) AFTER a
    // legitimate completion, which must NOT trigger a reset. Runs BEFORE the delete so
    // both the parent and the orphaned chunk rows are still present.
    async resetOrphanedArchiveHeads(block_index, firstActionIndex){
        await headsSql.resetOrphanedArchiveHeads(this.indexerDb, this.config, block_index, firstActionIndex);
    },

    // Restore an ATTEST v5 batch head that an orphaned v6 continuation flipped IN
    // PLACE on a surviving row. The exact shape of the archive reset
    // above, on the batch rail, and for the same reason.
    //
    // A chunked batch spans blocks: the v5 head in an early block, v6 continuations
    // after it. The chunk that COMPLETES the coverage reassembles the window and,
    // when the body or the quorum fails, stamps the verdict on the head
    // (attest.js absorbCompletedBatch) - a direct UPDATE on a row created in an
    // earlier block, which therefore survives the bulk delete below. If that
    // completing chunk is in the orphaned range, the delete removes the chunk and
    // cannot undo the stamp, and the damage is worse than a stale verdict: the head
    // is now terminal, getAttestBatchChunks reads status 'valid' only, so the head
    // is missing from its OWN chunk set and canonicalBatchHead resolves nothing.
    // The re-mined continuation then rejoins a batch with no head, absorbs nothing,
    // and the window is permanently dead on this node while a from-genesis replay
    // (the chunk never re-mined, or re-mined into a batch that reassembles) has it
    // live. attests.status_id is in no block-hash projection, so this is a
    // state-table divergence, not a consensus fork.
    //
    // ONLY A MARKED STAMP IS RESTORED, and this is the whole safety argument. A
    // blanket "reset every non-valid head joined to an orphaned chunk" is UNSAFE:
    // a head can be terminal because it was terminal AT WRITE TIME (a duplicate
    // head for the publisher's own window, a foreign NETWORK, a single-chunk head
    // that failed its own quorum), every one of which can sit below the orphaned
    // range with a valid same-author continuation above it, and restoring one
    // REVIVES a head that was never valid - two live heads for one window. So the
    // stamp writes ATTEST_BATCH_COMPLETION_STAMP (attest.js; keep the two copies
    // byte-identical, a test pins the pair) and only rows carrying it are matched.
    // 'valid' is then not a guess either: a head reaches the stamp only by coming
    // back from the status='valid' chunk read, so 'valid' is the one value the
    // flip could have overwritten.
    //
    // Publisher scope, UNCONDITIONAL and with no flag day, unlike the archive twin:
    // a batch's identity has been (key, author) since the rail shipped (attest.js
    // authoredBy), so the scope here has never been wider than the live path's and
    // narrowing it suppresses no reset that was ever owed. Scoped on actions
    // .source_id rather than the resolved address: both rows are local, the ids are
    // exact, and index_addresses.address is a case-folding collation. An
    // unresolvable author on either side is a NULL that no equality matches, so it
    // authenticates nothing rather than everything, matching authoredBy's
    // fail-closed rule.
    //
    // Runs BEFORE the delete (both rows still present) and AFTER the read-phase
    // retraction collect, which requires the head's status to be 'valid': a batch
    // stamped on its head never pushed, so it has no hub link to retract, and
    // restoring it any earlier would invent one.
    async restoreStampedAttestHeads(firstActionIndex){
        await headsSql.restoreStampedAttestHeads(this.indexerDb, firstActionIndex);
    },

};
