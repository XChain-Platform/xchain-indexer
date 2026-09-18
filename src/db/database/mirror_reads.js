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
 * XChain Indexer - Database class part: mirror binding and archive reads
 *
 * Hub-mirror binding (the mirror connection and the admission-height clause) and the
 * archive anchor chunk and head reads.
 *
 * A part of the Database class body: db/index.js installs it onto Database.prototype,
 * non-enumerable and in the order the class declared it, so call sites stay
 * this.db.<method>().
 *
 ********************************************************************/

// Strict, as the class body these methods came from was.
'use strict';

// The mirror-admission flag day, CONSUMER side (the time-keyed mirror barrier family): above
// it the mirrored selects bind rows by their signed admission height instead of by the clock.
const { isMirrorAdmissionConsumerActive } = require('../../consensus/gates/mirror_admission_gate.js');
const { ARCHIVE_CHUNK_SET_SQL, ARCHIVE_CHUNK_SET_BY_AUTHOR_SQL, ARCHIVE_ANCHOR_BY_CONTENT_SQL, selectArchiveHeadRow, dedupeArchiveChunks } = require('../../actions/anchor/anchor_action_query');

module.exports = {

    // Connection for hub-mirrored tables (price_snapshots, oracle_prices,
    // cross_chain_matches, capability_snapshots). In distributed deployments these live in
    // the local hub-DB copy; single-host falls back to this indexer DB. Mirrors the
    // `(this.actions.hubDb || this.indexerDb)` idiom used at the oracle read sites.
    mirrorDb(){
        return (this.indexer && this.indexer.hubDb) ? this.indexer.hubDb : this;
    },

    // Whether this indexer binds mirrored rows by admission height at block B: the consumer
    // side of the mirror-admission flag day for (COIN, NETWORK). A caller that passes no
    // height reads as below the activation, which is today's clock form, so every existing
    // call shape keeps its meaning; the block loop's callers all pass their block index.
    mirrorAdmissionActiveAt(blockHeight){
        if(blockHeight === null || blockHeight === undefined) return false;
        return isMirrorAdmissionConsumerActive(this.config['COIN'], this.config['NETWORK'], blockHeight);
    },

    // This chain's admission column on the mirrored cross-chain tables, `admit_block_<c>` in
    // the hub's own DDL spelling, built from the configured coin and never from anything read
    // off the wire. The columns arrive with the indexer's dated admission migration; nothing
    // reads them below the activation, which is every network in this train.
    admitColumn(){
        return 'admit_block_' + String(this.config['COIN'] || '').toLowerCase();
    },

    // The binding clause of a mirrored select at block B, with its bindings.
    //
    // Below the activation this is `effective_time <= ?`, byte for byte the text the select
    // has always issued, with one binding. Above it, the C33 form for this chain's column:
    //
    //   (admit_block_<c> IS NULL AND effective_time <= ?) OR (admit_block_<c> IS NOT NULL AND admit_block_<c> <= ?)
    //
    // wrapped in one more pair of parentheses so it composes under the select's own ANDs, and
    // NEVER a bare `admit_block_<c> <= ?`: a bare comparison on a nullable column evaluates to
    // NULL for every legacy row and silently drops it, the silent consensus change this file's
    // own eff_expiration case study documents. The IS NULL arm is the legacy-row rule and it
    // holds at every height, so a row finalized below the producer activation, and a row whose
    // map never named this chain, both bind exactly as they do today (C38).
    //
    // `alias` prefixes every column for a select that aliases its table; `column` overrides the
    // chain column for the one table that carries a single fixed column (attestation_responses,
    // BTC-only by its call-site guard). bridge_settle.js carries the same clause text for its
    // two selects and the admission-binding suite pins the two spellings equal.
    mirrorBindClause(blockTime, blockHeight, alias, column){
        let p   = alias ? alias + '.' : '';
        if(!this.mirrorAdmissionActiveAt(blockHeight))
            return { sql: p + 'effective_time <= ?', args: [blockTime] };
        let col = p + (column || this.admitColumn());
        return {
            sql:  '((' + col + ' IS NULL AND ' + p + 'effective_time <= ?) OR (' + col + ' IS NOT NULL AND ' + col + ' <= ?))',
            args: [blockTime, Number(blockHeight)]
        };
    },

    // The usable v2 continuation chunks stored for an archive batch: rejected
    // rows (status 'invalid: ...') are excluded and the result is deduped to
    // ONE row per chunk_index (lowest action_index wins, deterministically).
    // anchor_actions stores a row for EVERY parsed ANCHOR (the verdict lives
    // in STATUS) and idx_anchor_batch is NON-unique, so a permissionless junk
    // v2 tx adds a countable row for an existing (batch, index): unfiltered,
    // that row inflated the readers' chunk counts - the duplicate guard then
    // stamped the LEGITIMATE chunk 'invalid: CHUNK_INDEX (duplicate)', the
    // live invalid_archive CRC check never fired, and AnchorRecovery threw
    // 'incomplete batch' forever (finding #2269). 'orphan' rows are KEPT: a
    // chunk that landed before its parent v1 carries legitimate archive
    // bytes. Mirrors rollback.js's valid-chunk self-join and the recovery.js
    // v1 status filter. #3075 added the authorship term and moved the whole
    // query into anchor_action_query.js (ARCHIVE_CHUNK_SET_SQL), which
    // recovery.verifyBatch now requires verbatim, so the two can no longer
    // drift by hand-copy: only chunks authored by the CANONICAL archive head
    // count, which is what stops a junk chunk broadcast BEFORE the head (stored
    // 'orphan', so it carries no rejection verdict of its own) from squatting a
    // slot and denying the batch permanently.
    // `author`, when supplied, replaces "authored by the canonical head" with
    // "authored by THIS address", the read-path half of publisher-scoped archive
    // batches. anchor.js supplies it (gated) so the chunk set a head reassembles - and
    // the occupancy set the duplicate guard reads - belong to that head's own
    // publisher, not to whoever happened to broadcast the earliest row for the seq.
    // Omitted / null runs the legacy canonical-head query unchanged.
    async getAnchorChunks(batchSeq, author){
        let rows = (author !== undefined && author !== null)
            ? await this.doQuery(ARCHIVE_CHUNK_SET_BY_AUTHOR_SQL, [batchSeq, String(author)])
            : await this.doQuery(ARCHIVE_CHUNK_SET_SQL, [batchSeq, batchSeq]);
        return dedupeArchiveChunks(rows);
    },

    // CONTENT-ADDRESSED archive-head lookup: the archive-anchor head for one batch
    // identified by WHAT IT CONTAINS (checkpoint identity + batch_crc32 + match_count)
    // rather than by the match_batch_seq it happened to be published under.
    //
    // getAnchorV1ByBatchSeq above cannot serve this question at all. Its key is
    // match_batch_seq, and the caller that needs this read (the hub's archive publish
    // path, recovering from a crash between "head broadcast" and "batch recorded") has
    // by definition lost that seq: the re-election allocates a fresh one. The content
    // key is the only identity that survives the restart, and the publisher signs it
    // into the v1 canonical, so both sides can compute it.
    //
    // `author` scopes the answer to one publishing address. Supplied, the question
    // becomes "did THIS publisher already publish this batch", which is the only form
    // safe to act on: unscoped, a copy of an already-mined head broadcast by anyone
    // answers yes for a batch whose chunks that party never sent.
    //
    // Returns the head row (with `source` = author address and `txid`) plus the chunk
    // rows already on-chain for it, so a partially published batch is resumable:
    // { head, chunks } with head null when nothing matches (chunks then empty).
    // Status is NOT filtered here for the reason ARCHIVE_CHUNK_SET_SQL is not
    // status-filtered either: a mirrored and an unmirrored node store the same head
    // under different statuses, and the caller applies its own verdict.
    async getArchiveAnchorByContent(chain, network, block_index, checkpoint_seq, batch_crc32, match_count, author){
        let rows = await this.doQuery(ARCHIVE_ANCHOR_BY_CONTENT_SQL,
            [chain, network, Number(block_index), Number(checkpoint_seq),
             String(batch_crc32).toLowerCase(), Number(match_count)]);
        let head = selectArchiveHeadRow(rows, { author: (author != null && author !== '') ? author : null });
        if(!head) return { head: null, chunks: [] };
        // Chunks are read under the head's OWN seq and author, never the caller's:
        // that pairing is what lets a resuming publisher address slots allocated by a
        // process that is gone. A head with an unresolvable author has no chunk set
        // that can be attributed, so report none rather than the whole seq's rows.
        let chunks = head.source != null
            ? await this.getAnchorChunks(Number(head.match_batch_seq), String(head.source))
            : [];
        return { head, chunks };
    },

};
