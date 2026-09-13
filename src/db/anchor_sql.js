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
 * XChain Indexer - Database statements: anchor reads
 *
 * The anchor_actions statements, as named constants rather than mixin methods.
 * They are constants because THREE layers run the identical text on three
 * different connections: the db class (getAnchorChunks, the content-addressed
 * lookup), the RPC layer (api.js, on the API view of the pool), and the
 * recovery tool, which holds only a doQuery handle and no Database at all.
 * Byte-identity across those three is the point, and it is what several suites
 * assert on directly, so the statement itself is the shared unit.
 *
 * A sibling of db/shared.js: it lives under the db home and is NOT in
 * db/index.js's MIXIN_FILES, because nothing here belongs on Database.prototype.
 *
 * src/actions/anchor/anchor_action_query.js re-exports every name below, so a caller that
 * already imports from there keeps working unchanged; new call sites should read
 * them from here, where they sit beside the tables they name.
 *
 ********************************************************************/

'use strict';

const { ARCHIVE_HEAD_VERSIONS, ARCHIVE_HEAD_VERSIONS_SQL } = require('../stateHash.js');

// ANCHOR versions that carry a full checkpoint identity (chain/network/block_index/
// checkpoint_seq + the state hashes). Version 2 is an archive continuation chunk with
// no checkpoint identity of its own, so it is never a getanchoraction match. Kept here
// as the single source of truth for both the SQL filter and the tests.
//
// 0 is the checkpoint BUNDLE, whose rows are per-SECTION and each carry a full
// checkpoint identity, so a (chain, network, block_index, checkpoint_seq) lookup
// resolves to exactly the section row the caller asked for and needs no new RPC (D17).
// 1 is the archive head, which carries the wrapper checkpoint's identity. Every
// pre-activation version is OUT: the indexer no longer parses them, so admitting them
// here would let a pre-restart row keep raising the replay watermark
// (getMaxAnchorCheckpointSeq reads this same set) against bundles it can never be
// compared with. Rows on chain keep their version byte and stay readable through the
// txid-keyed reads, which filter no version at all.
const CHECKPOINT_VERSIONS = [0, 1];

// The subset of CHECKPOINT_VERSIONS that IS a checkpoint in its own right: a v0
// bundle SECTION. The other member (1) is the archive head, which carries its
// WRAPPER checkpoint's identity, so an archive head and a bundle section can and do
// collide on one (chain, network, block_index, checkpoint_seq) key - both legs anchor
// the same checkpoint, for different purposes. On that shared key the archive head is
// typically the higher action_index, so a plain "newest wins" pick answers a
// getanchoraction("is this checkpoint anchored") with the ARCHIVE head's txid and
// status: a different transaction, a different verdict. The two families are therefore
// ranked before recency (SQL and selectAnchorRow both), and only a version filter
// reaches the archive leg on such a key.
//
// Derived by subtraction rather than written as [0] so that a future checkpoint
// version added to CHECKPOINT_VERSIONS joins the section family automatically; the
// archive family is ARCHIVE_HEAD_VERSIONS, which owns that definition already.
const CHECKPOINT_SECTION_VERSIONS = CHECKPOINT_VERSIONS.filter(v => !ARCHIVE_HEAD_VERSIONS.includes(v));
// SQL fragment form, spliced as `a.version ` + CHECKPOINT_SECTION_VERSIONS_SQL. Only
// integers from the constant above are interpolated, never caller input.
const CHECKPOINT_SECTION_VERSIONS_SQL = 'IN (' + CHECKPOINT_SECTION_VERSIONS.join(', ') + ')';

// One checkpoint identity can carry more than one anchor row: a reorg-replayed
// re-anchor, and the v0 bundle section plus the v1 archive head that
// shares its checkpoint_seq. The caller filters those by txid/version, so fetch
// the (tiny) candidate set rather than only the highest action_index. Bounded so
// a pathological identity can never stream unbounded rows into the RPC.
const ANCHOR_ROW_LIMIT = 20;

// Candidate anchor rows for a checkpoint identity, checkpoint SECTIONS before
// archive heads and newest (highest action_index) first within each family, each
// carrying the DOGE txid it landed in. The txid is resolved through
// actions -> transactions -> index_transactions; LEFT JOINed so a row whose tx
// linkage is missing still returns (txid null) instead of vanishing, which would
// silently turn a present anchor into 'absent' for the hub.
//
// The family term ranks ahead of action_index for a reason the row limit makes
// concrete: anyone can land additional archive rows carrying this same wrapper
// checkpoint identity, each at a higher action_index, and under a pure
// action_index DESC order ANCHOR_ROW_LIMIT of those would push the real section row
// out of the fetched window entirely. Then no downstream tie-break can recover it.
// Ranking the family in the ORDER BY keeps the section inside the window no matter
// how many archive rows share the key.
const ANCHOR_ACTIONS_SQL =
    `SELECT a.action_index, a.version, a.chain, a.network, a.block_index,
            a.block_hash, a.ledger_hash, a.actions_hash, a.contract_hash,
            a.checkpoint_seq, a.snapshot_block, a.state_root, a.state_root_version,
            a.block_merkle_root, a.block_merkle_version, a.block_index_doge, s.status,
            it.hash AS txid
     FROM anchor_actions a
     JOIN index_statuses s ON s.id = a.status_id
     LEFT JOIN actions ac            ON ac.action_index = a.action_index
     LEFT JOIN transactions t        ON t.tx_index      = ac.tx_index
     LEFT JOIN index_transactions it ON it.id           = t.tx_hash_id
     WHERE a.chain = ? AND a.network = ? AND a.block_index = ? AND a.checkpoint_seq = ?
       AND a.version IN (${CHECKPOINT_VERSIONS.map(() => '?').join(', ')})
     ORDER BY (a.version ${CHECKPOINT_SECTION_VERSIONS_SQL}) DESC, a.action_index DESC
     LIMIT ${ANCHOR_ROW_LIMIT}`;

// Archive-batch authorship: a v2 continuation chunk carries no signatures of its
// own. The ANCHOR spec calls it "authenticated by its parent v1", but the only
// checks were that a parent exists and its TOTAL_CHUNKS matches; nothing bound the
// chunk to the parent's AUTHOR. Combined with a slot-occupancy guard that rejects
// any later chunk for a filled index, the first broadcast into a slot won
// permanently: anyone could fill a slot with junk, the real publisher's chunk was
// then rejected as a duplicate, and the archive never reassembled.
//
// The binding is the archive head's SOURCE, resolved through actions.source_id
// (the authoritative source for auth per the actions schema, never re-derived
// from the transaction). anchor_actions carries no source column of its own; the
// `publisher` column is the elected-PUBLISHER PUBKEY carried by the v0/v1 tail, a different thing
// entirely, and a v1 head has none at all.
//
// The head is the canonical one: the earliest (lowest action_index) archive-head row for
// the batch, byte-identical to db.getAnchorV1ByBatchSeq's rule, because
// match_batch_seq is not unique (re-broadcast / failover double-publish). The
// selection is deliberately status-agnostic, matching that rule: a node with no
// mirrored oracle_publish snapshot stores an unverifiable head 'unverified' where
// a mirrored node stores 'valid' or 'invalid: ...', so a status-filtered head pick
// would make authorship, and every chunk verdict downstream of it, differ between
// mirrored and unmirrored nodes. That fleet divergence is worse than the accepted
// cost below.
//
// Accepted cost: because the earliest head wins, a batch whose first head
// publisher stops before broadcasting all its chunks can no longer be rescued by
// a second publisher's chunks under the same batch seq. Denial now requires being
// the legitimate first head publisher and then failing, instead of being anyone
// at all. Residual, out of scope here: nothing stops a junk head row (bad
// signatures, status 'invalid: ...') from being the earliest row for a batch and
// thereby capturing both the geometry gate and this authorship rule; that cannot
// be closed by filtering on status, for the divergence reason above.
//
// LEFT JOINs throughout: the head pick must stay byte-identical to
// getAnchorV1ByBatchSeq (inner joins would silently skip an unlinked head and
// select a different one), and an unresolvable address then compares unequal, so
// a chunk whose action linkage is missing is excluded rather than admitted.
// Fail-closed by shape.
const ARCHIVE_HEAD_AUTHOR_SQL =
    `SELECT hadr.address
     FROM anchor_actions h
     LEFT JOIN actions         hact ON hact.action_index = h.action_index
     LEFT JOIN index_addresses hadr ON hadr.id           = hact.source_id
     WHERE h.version ${ARCHIVE_HEAD_VERSIONS_SQL} AND h.match_batch_seq = ?
     ORDER BY h.action_index ASC
     LIMIT 1`;

// The usable v2 continuation chunks for one archive batch: rejected rows
// ('invalid: ...') excluded, and also every chunk not authored by the canonical
// archive head. 'orphan' rows stay in, since a chunk that landed before its parent
// head carries legitimate archive bytes, and this is precisely why the authorship
// filter has to live in the read path as well as in the parse-time verdict: an
// orphan chunk is parsed with no parent to authenticate against, so a junk chunk
// broadcast ahead of the head can only be excluded here.
//
// Callers dedupe to one row per chunk_index (lowest action_index wins) after this
// query; the ORDER BY makes that deterministic. Params: [batchSeq, batchSeq].
// Shared verbatim by db.getAnchorChunks and recovery.js's reassembly (which holds only
// a doQuery handle) so the two can no longer drift. Two other places join v2 chunks and
// deliberately need NO authorship term, because both already require status 'valid',
// which a wrong-author chunk can never hold (parse rejects it, and an orphan is not
// 'valid'): rollback.js's invalid_archive reset self-join, and stateHash.js's class-6
// anchor_invalid query. Adding the term there would be inert at best and would move a
// hash preimage at worst.
const ARCHIVE_CHUNK_SET_SQL =
    `SELECT c.*, cadr.address AS source
     FROM anchor_actions c
     JOIN index_statuses s ON s.id = c.status_id
     LEFT JOIN actions         cact ON cact.action_index = c.action_index
     LEFT JOIN index_addresses cadr ON cadr.id           = cact.source_id
     WHERE c.version = 2 AND c.match_batch_seq = ? AND s.status NOT LIKE 'invalid:%'
       AND cadr.address = (${ARCHIVE_HEAD_AUTHOR_SQL})
     ORDER BY c.chunk_index ASC, c.action_index ASC`;

// Publisher-scoped archive batches, flag-day gated: the same chunk set, but
// bound to a SUPPLIED author instead of the canonical head's. At/after the
// ARCHIVE_BATCH_AUTHOR flag day the archive batch key is (match_batch_seq, head
// author), so each head governs only its own publisher's chunks and a junk head
// squatting the batch seq governs nothing, closing the earlier gap where "the
// batch" meant "the earliest row carrying that seq". Everything else is
// byte-identical to ARCHIVE_CHUNK_SET_SQL (rejected rows out, 'orphan' kept,
// deterministic order), and with exactly one publisher per batch seq (honest
// operation) the two queries return the same rows.
// Params: [batchSeq, author].
const ARCHIVE_CHUNK_SET_BY_AUTHOR_SQL =
    `SELECT c.*, cadr.address AS source
     FROM anchor_actions c
     JOIN index_statuses s ON s.id = c.status_id
     LEFT JOIN actions         cact ON cact.action_index = c.action_index
     LEFT JOIN index_addresses cadr ON cadr.id           = cact.source_id
     WHERE c.version = 2 AND c.match_batch_seq = ? AND s.status NOT LIKE 'invalid:%'
       AND cadr.address = ?
     ORDER BY c.chunk_index ASC, c.action_index ASC`;

// The batch's canonical head row identity (earliest archive-head row for the seq,
// status-agnostic) reduced to what the flag-day predicate needs: the DOGE height it
// landed at. This is the one row every node agrees on for a batch seq without
// consulting status, which is why the publisher-authorship gate is anchored to it
// rather than to the chunk's own block, so a head and its chunks can never
// straddle two rules. block_index_doge, not block_index: the latter is the
// checkpointed height on the checkpointed chain (and is NULL on a v2 chunk), while
// the flag day is a height on the chain the ANCHOR itself lands on.
// Params: [batchSeq].
const ARCHIVE_HEAD_GATE_SQL =
    `SELECT h.action_index, h.block_index_doge
     FROM anchor_actions h
     WHERE h.version ${ARCHIVE_HEAD_VERSIONS_SQL} AND h.match_batch_seq = ?
     ORDER BY h.action_index ASC
     LIMIT 1`;

// Bound on the content-addressed head candidate set. Larger than
// ANCHOR_ROW_LIMIT because a re-broadcast / failover double-publish, and a third
// party copying an already-mined head, all land additional rows under the SAME
// content key; the caller filters by author afterwards and needs its own row to
// still be in the window. ORDER BY action_index ASC makes that safe: a copy can
// only be made from bytes already on-chain, so it can never sort AHEAD of the
// original it copied.
const ARCHIVE_ANCHOR_ROW_LIMIT = 50;

// CONTENT-ADDRESSED archive-anchor lookup: "is this exact archive batch already
// on-chain?", answered WITHOUT the batch seq.
//
// This is the read the hub's archive publish path needs to be crash-safe. The archive-head
// head is broadcast before the batch is recorded locally, so a crash in between
// re-elects the same match rows on the next flush, and the re-election allocates a
// FRESH match_batch_seq. Every existing archive read is keyed on that seq
// (getAnchorV1ByBatchSeq, ARCHIVE_CHUNK_SET_SQL, the replay watermarks), so none of
// them can recognize the already-published batch, and the hub re-spends DOGE on a
// duplicate archive.
//
// The key here is what the batch IS rather than which attempt produced it: the
// checkpoint identity the archive is wrapped in (chain, network, block_index,
// checkpoint_seq) plus the batch's content commitment (batch_crc32 over the
// uncompressed archive JSON, and match_count). The publisher signs exactly those
// fields into the v1 canonical (_archiveCanonical), so a hub can compute the key
// before it broadcasts and recognize its own earlier send afterwards.
//
// match_batch_seq is deliberately NOT part of the key, and cannot be: recognizing a
// send made under a seq this process no longer knows is the entire point.
//
// Status is returned, never filtered: an 'invalid: ...' head still SPENT the fee, and
// the caller decides whether an invalid row counts as "already published" (the hub
// treats it as absent, matching _findExistingCheckpointAnchor, because a malformed
// row anchored nothing). Filtering here would also make the answer differ between a
// node with a mirrored oracle_publish snapshot and one without, exactly as it would
// for the head picks above.
//
// LEFT JOINs on the author/txid linkage for the same reason ANCHOR_ACTIONS_SQL uses
// them: a row whose action or transaction linkage is missing must still be returned
// (as source/txid null) rather than vanish, because a vanished row reads to the hub
// as "definitively absent" and licenses a second spend.
// Params: [chain, network, block_index, checkpoint_seq, batch_crc32, match_count].
const ARCHIVE_ANCHOR_BY_CONTENT_SQL =
    `SELECT a.action_index, a.version, a.chain, a.network, a.block_index,
            a.checkpoint_seq, a.snapshot_block, a.match_batch_seq, a.match_count,
            a.batch_crc32, a.total_chunks, a.block_index_doge, s.status,
            adr.address AS source, it.hash AS txid
     FROM anchor_actions a
     JOIN index_statuses s ON s.id = a.status_id
     LEFT JOIN actions            act ON act.action_index = a.action_index
     LEFT JOIN index_addresses    adr ON adr.id           = act.source_id
     LEFT JOIN transactions       t   ON t.tx_index       = act.tx_index
     LEFT JOIN index_transactions it  ON it.id            = t.tx_hash_id
     WHERE a.version ${ARCHIVE_HEAD_VERSIONS_SQL}
       AND a.chain = ? AND a.network = ? AND a.block_index = ? AND a.checkpoint_seq = ?
       AND a.batch_crc32 = ? AND a.match_count = ?
     ORDER BY a.action_index ASC
     LIMIT ${ARCHIVE_ANCHOR_ROW_LIMIT}`;

// The getanchorconfirmations read, its page-resumed twin, and the column list both
// share. The design rationale for the cap, the page probe and the exclusive
// action_index cursor lives above buildAnchorConfirmationsResponse in
// src/actions/anchor/anchor_action_query.js, which is the code the rules constrain; what is
// load-bearing HERE is that section_index is selected and ordered, so the
// within-action order is deterministic rather than whatever the engine returns, and
// so the caller can tell two anchors riding one transaction apart.
const ANCHOR_BY_TXID_COLUMNS =
    `SELECT a.action_index, a.section_index, a.version, a.chain, a.network, a.block_index,
            a.checkpoint_seq, a.snapshot_block, a.publisher, a.match_batch_seq,
            a.block_index_doge, s.status, it.hash AS txid
     FROM index_transactions it
     JOIN transactions t   ON t.tx_hash_id  = it.id
     JOIN actions ac       ON ac.tx_index   = t.tx_index
     JOIN anchor_actions a ON a.action_index = ac.action_index
     JOIN index_statuses s ON s.id          = a.status_id`;

const ANCHOR_BY_TXID_SQL =
    `${ANCHOR_BY_TXID_COLUMNS}
     WHERE it.hash = ?
     ORDER BY a.action_index ASC, a.section_index ASC
     LIMIT ${ANCHOR_ROW_LIMIT + 1}`;

// The same read resumed after a page boundary. Params: [txid, after_action_index].
const ANCHOR_BY_TXID_AFTER_SQL =
    `${ANCHOR_BY_TXID_COLUMNS}
     WHERE it.hash = ? AND a.action_index > ?
     ORDER BY a.action_index ASC, a.section_index ASC
     LIMIT ${ANCHOR_ROW_LIMIT + 1}`;

module.exports = {
    CHECKPOINT_VERSIONS, CHECKPOINT_SECTION_VERSIONS, CHECKPOINT_SECTION_VERSIONS_SQL,
    ANCHOR_ROW_LIMIT, ANCHOR_ACTIONS_SQL,
    ARCHIVE_HEAD_AUTHOR_SQL, ARCHIVE_CHUNK_SET_SQL, ARCHIVE_CHUNK_SET_BY_AUTHOR_SQL,
    ARCHIVE_HEAD_GATE_SQL,
    ARCHIVE_ANCHOR_ROW_LIMIT, ARCHIVE_ANCHOR_BY_CONTENT_SQL,
    ANCHOR_BY_TXID_COLUMNS, ANCHOR_BY_TXID_SQL, ANCHOR_BY_TXID_AFTER_SQL
};
