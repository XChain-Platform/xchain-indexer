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
 * Pure helpers for the getanchoraction RPC (api.js) and its db read
 * (db.js getAnchorActionByCheckpoint), extracted for unit testing because
 * startApi() is not importable (it opens DB connections). The DB read itself
 * is exercised on regtest / integration; this module holds the request
 * validation, the checkpoint-version set, and the row -> response mapping
 * (including DOGE confirmation-depth math), which is the regression-worthy logic.
 *
 ********************************************************************/

'use strict';

const { ARCHIVE_HEAD_VERSIONS, ARCHIVE_HEAD_VERSIONS_SQL } = require('./stateHash.js');

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

// A DOGE txid as the hub announces it (XANC_V0_DONE.txid / XANC_FINALIZED.txid).
const TXID_RE = /^[0-9a-fA-F]{64}$/;

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

// A batch CRC as the publisher formats it and anchor.js stores it: 8 lowercase
// hex digits (anchor.js normalizes BATCH_CRC32 with .toLowerCase() and rejects
// anything else at parse time, so the stored column is always this shape).
const ARCHIVE_CRC_RE = /^[0-9a-f]{8}$/;

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

// Dedupe an ARCHIVE_CHUNK_SET_SQL result to ONE row per chunk_index, lowest
// action_index first (the query's ORDER BY guarantees that arrival). Shared so the
// live path and recovery cannot drift on the tie-break either.
function dedupeArchiveChunks(rows) {
    let byIndex = new Map();
    for (let r of (rows || []))
        if (!byIndex.has(Number(r.chunk_index))) byIndex.set(Number(r.chunk_index), r);
    return Array.from(byIndex.values());
}

// Exact index-coverage completeness for a reassembled archive batch. Given the
// continuation-chunk rows (already deduped to one per index by dedupeArchiveChunks /
// getAnchorChunks) and the head's TOTAL_CHUNKS, returns the rows for indices
// 1..totalChunks-1 in ascending index order when the set covers that range EXACTLY,
// else null. Out-of-range indices (< 1 or >= totalChunks) are DROPPED rather than
// counted: a bare length test (chunks.length === totalChunks-1) both accepted a set
// missing a real in-range index but padded to length by a stray out-of-range orphan
// chunk (which then corrupts the reassembled byte order and the CRC verdict) and
// blocked a genuinely complete set that an extra stray chunk pushed over the count.
// With one row per in-range index and size === need, coverage of {1..need} is exact
// by pigeonhole. Shared verbatim by the head-side gate, the chunk-side gate, and
// recovery so the three reassembly paths cannot drift on completeness or byte order.
function archiveChunkCoverage(chunks, totalChunks) {
    let need = Number(totalChunks) - 1;
    if (!(need >= 1)) return null;
    let byIndex = new Map();
    for (let c of (chunks || [])) {
        let i = Number(c.chunk_index);
        if (i >= 1 && i <= need && !byIndex.has(i)) byIndex.set(i, c);
    }
    if (byIndex.size !== need) return null;
    let ordered = [];
    for (let i = 1; i <= need; i++) ordered.push(byIndex.get(i));
    return ordered;
}

// Validate the getanchoraction request shape. Returns
// {ok:true, block_index, checkpoint_seq, txid, version} on success (txid/version
// null when not supplied), or {ok:false, error} otherwise.
//
// `txid` and `version` are OPTIONAL narrowing filters added for the hub's
// anchor-gossip gate: without them this RPC answers "is THIS CHECKPOINT anchored
// at depth", which does not bind the specific announced transaction. With them it
// answers "did THIS txid (of THIS anchor version) land for this checkpoint",
// which is what closes XANC-ELECTED-FORGE-1 (a Byzantine ELECTED publisher
// announcing a real-but-different or never-mined txid).
function validateAnchorActionParams({ chain, network, block_index, checkpoint_seq, txid, version }) {
    if (typeof chain !== 'string' || !chain || typeof network !== 'string' || !network)
        return { ok: false, error: 'chain and network are required strings' };
    let bi = Number(block_index);
    let cs = Number(checkpoint_seq);
    if (!Number.isInteger(bi) || bi < 0 || !Number.isInteger(cs) || cs < 0)
        return { ok: false, error: 'block_index and checkpoint_seq must be non-negative integers' };
    let wantTxid = null;
    if (txid !== undefined && txid !== null && txid !== '') {
        if (typeof txid !== 'string' || !TXID_RE.test(txid))
            return { ok: false, error: 'txid must be a 64-character hex string' };
        wantTxid = txid.toLowerCase();
    }
    let wantVersion = null;
    if (version !== undefined && version !== null && version !== '') {
        let ver = Number(version);
        if (!Number.isInteger(ver) || !CHECKPOINT_VERSIONS.includes(ver))
            return { ok: false, error: 'version must be one of ' + CHECKPOINT_VERSIONS.join(', ') };
        wantVersion = ver;
    }
    return { ok: true, block_index: bi, checkpoint_seq: cs, txid: wantTxid, version: wantVersion };
}

// Pick the anchor row a caller asked for from the candidate set. `rows` must be
// ordered action_index DESC within a version family (ANCHOR_ACTIONS_SQL does this),
// so among rows of one family the highest action_index wins: a reorg-replayed
// re-anchor supersedes an earlier one. A supplied txid/version narrows to that exact
// anchor. Returns null when nothing matches.
//
// FAMILY BEFORE RECENCY. A checkpoint key can carry both a v0 bundle section and a
// v1 archive head (the archive wraps the same checkpoint), and the archive head
// usually lands at the higher action_index. getanchoraction is a per-SECTION reader:
// its unfiltered question is "is THIS checkpoint anchored", and answering it with the
// co-located archive head hands the caller a different transaction's txid and status
// while looking like a hit. So whenever any section row survives the caller's filters,
// the pick comes from the section family.
//
// The fallback is what keeps the archive leg reachable: with no section row among the
// candidates, the whole set is used, so an archive-only key still answers unfiltered,
// and an explicit `version: 1`/`version: 6` still resolves to that head even when a
// section shares the key. `txid` behaves the same way, since a txid that carries only
// an archive head leaves no section to prefer.
function selectAnchorRow(rows, filter) {
    let f = filter || {};
    let candidates = Array.isArray(rows) ? rows : [];
    if (f.version !== undefined && f.version !== null)
        candidates = candidates.filter(r => Number(r.version) === Number(f.version));
    if (f.txid)
        candidates = candidates.filter(r => String(r.txid || '').toLowerCase() === String(f.txid).toLowerCase());
    let sections = candidates.filter(r => CHECKPOINT_SECTION_VERSIONS.includes(Number(r.version)));
    if (sections.length > 0) candidates = sections;
    return candidates.length > 0 ? candidates[0] : null;
}

// Map an anchor_actions row (or null) + the indexer's latest block into the RPC response.
// `config` is the indexer config (COIN/NETWORK = the anchor chain this indexer serves,
// i.e. DOGE). Confirmations are DOGE-relative depth of the block the ANCHOR landed in;
// a missing row, a non-finite latest, or a row deeper than tip (rolled back) reports 0
// so a caller never treats a shallow/negative-depth anchor as confirmed.
// `extra.checkpoint_anchored` tells a caller that used a txid/version filter
// whether ANY anchor exists for the checkpoint identity, so it can tell a benign
// "not anchored yet" (abstain) apart from a positively-detected forge: the
// checkpoint IS anchored, but not by the txid that was announced. Defaults to
// !!row, which keeps a filterless caller's response semantics unchanged.
// Coerce a stored version column to a number, normalizing null/undefined/NaN
// to null so a missing version never surfaces as NaN in the response.
function normalizeVersion(v) {
    if (v === null || v === undefined) return null;
    let n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function buildAnchorActionResponse(config, latest, row, extra) {
    let coin    = config['COIN'];
    let network = config['NETWORK'];
    let anchored = (extra && extra.checkpoint_anchored !== undefined) ? !!extra.checkpoint_anchored : !!row;
    if (!row) {
        return { coin, network, exists: false, checkpoint_anchored: anchored,
                 latest_block_index: latest, confirmations: 0 };
    }
    let latestNum = Number(latest);
    let dogeBlock = Number(row.block_index_doge);
    let confirmations = (Number.isFinite(latestNum) && Number.isFinite(dogeBlock) && latestNum >= dogeBlock)
        ? (latestNum - dogeBlock + 1) : 0;
    return {
        coin, network,
        exists:             true,
        checkpoint_anchored: anchored,
        status:             row.status,                    // 'valid' | 'unverified' | 'invalid: ...'
        version:            Number(row.version),
        // DOGE txid this anchor landed in. null when the tx linkage is missing;
        // a hub binding the announced txid MUST treat null as unverifiable.
        txid:               row.txid ? String(row.txid).toLowerCase() : null,
        checkpoint_chain:   row.chain,
        checkpoint_network: row.network,
        block_index:        Number(row.block_index),
        block_hash:         row.block_hash,
        ledger_hash:        row.ledger_hash,
        actions_hash:       row.actions_hash,
        contract_hash:      row.contract_hash,
        checkpoint_seq:     Number(row.checkpoint_seq),
        snapshot_block:     (row.snapshot_block != null) ? Number(row.snapshot_block) : null,
        state_root:           row.state_root || null,
        state_root_version:   row.state_root ? normalizeVersion(row.state_root_version) : null,
        block_merkle_root:    row.block_merkle_root || null,
        block_merkle_version: row.block_merkle_root ? normalizeVersion(row.block_merkle_version) : null,
        block_index_doge:   dogeBlock,
        latest_block_index: latest,
        confirmations:      confirmations
    };
}

// ---------------------------------------------------------------------------
// getanchorconfirmations: DOGE anchor visibility for the BTC indexer.
//
// The BTC indexer mints the COLLECT-spendable anchor/archive reward from a
// hub-mirrored anchor_reward_attestations row, but ANCHOR lives on DOGE, so before
// this read the BTC side had NO way to check that the anchor it is paying for was ever
// mined: it took the mirror's word for it, and an evicted or reorged anchor still paid.
// This is the federation read that closes that (the third and last independent re-proof,
// after the publishing hub's and the receiving peer's).
//
// Keyed on the TXID ALONE, deliberately. The attestation row carries the reward tuple and
// doge_anchor_txid, not the wrapper checkpoint's DOGE-side identity, so getanchoraction's
// (block_index, checkpoint_seq) key is unusable here. Answering "what did THIS transaction
// anchor, and how deep is it" lets the caller do the binding itself: it compares the
// returned publisher / snapshot_block / seq against the tuple it is about to pay, and a
// txid that anchored something else fails that comparison instead of passing a weaker test.
//
// Every attestation-bearing version is served ({4,5,6}) plus their unattested siblings, so
// the caller can positively DETECT a version mismatch rather than see an empty answer for
// one and have to guess.
//
// BOUNDED AND PAGED, not merely bounded. The cap on the checkpoint-identity read above is
// justified by "the caller filters those by txid/version, so fetch the (tiny) candidate
// set"; that reasoning does NOT carry here. This read's caller (anchor_proof_client) binds
// a reward tuple, so a window that silently omits the one matching anchor is
// indistinguishable on the wire from a complete non-matching set, and the client turns
// that into a permanent 'rejected' - a legitimate COLLECT-spendable reward forfeited
// forever. So the row cap keeps a hard bound on any single response, ONE row past it is
// fetched purely as a truncation probe, and the response says both that it was cut off and
// where to resume. `after` is exclusive on action_index, which is unique and totally
// ordered under the ASC sort, so the pages partition the set with no gap and no overlap.
const ANCHOR_BY_TXID_COLUMNS =
    `SELECT a.action_index, a.version, a.chain, a.network, a.block_index,
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
     ORDER BY a.action_index ASC
     LIMIT ${ANCHOR_ROW_LIMIT + 1}`;

// The same read resumed after a page boundary. Params: [txid, after_action_index].
const ANCHOR_BY_TXID_AFTER_SQL =
    `${ANCHOR_BY_TXID_COLUMNS}
     WHERE it.hash = ? AND a.action_index > ?
     ORDER BY a.action_index ASC
     LIMIT ${ANCHOR_ROW_LIMIT + 1}`;

// Validate a getanchorconfirmations request: a single 64-hex txid, plus an optional
// exclusive page cursor. Returns {ok:true, txid, after} (txid lowercased, after a
// non-negative integer or null) or {ok:false, error}.
//
// The cursor is validated rather than coerced: a NaN / negative / fractional cursor
// silently coerced to 0 would restart the walk at the first page forever, which is the
// truncation bug wearing a different hat.
function validateAnchorConfirmationsParams({ txid, after_action_index }) {
    if (typeof txid !== 'string' || !TXID_RE.test(txid))
        return { ok: false, error: 'txid must be a 64-character hex string' };
    let after = null;
    if (after_action_index !== undefined && after_action_index !== null) {
        // Typed before it is numbered: a bare Number() call reads [] as 0 and true as 1, so
        // the two shapes most likely to arrive from a buggy caller would both validate.
        let n = (typeof after_action_index === 'number') ? after_action_index
              : (typeof after_action_index === 'string' && /^\d+$/.test(after_action_index)) ? Number(after_action_index)
              : NaN;
        if (!Number.isInteger(n) || n < 0)
            return { ok: false, error: 'after_action_index must be a non-negative integer' };
        after = n;
    }
    return { ok: true, txid: txid.toLowerCase(), after };
}

// Map the anchor rows a txid carries + the indexer's latest block into the
// getanchorconfirmations response.
//
// `confirmations` is DOGE-relative depth of the block the transaction landed in, computed
// exactly as buildAnchorActionResponse does (a missing row, a non-finite latest, or a row
// deeper than tip reports 0), so a caller can never read a shallow or rolled-back anchor as
// buried. One transaction can carry more than one anchor action (an archive head plus its
// own continuation), so `anchors` is a LIST and the caller picks by version rather than the
// read guessing for it. A decoded-invalid row is reported with its status rather than
// filtered out: "this txid exists and is invalid" is a positively-detected forge for the
// caller, while an empty list is merely "not seen", and the two must not collapse.
// `rows` is the ANCHOR_ROW_LIMIT + 1 the SQL above fetches. The extra row is a truncation
// PROBE and never reaches the caller: it is dropped here, and its existence is reported as
// `truncated` plus `next_after_action_index`, the exclusive cursor for the next page. A
// caller that ignores both sees exactly the response shape it saw before (the same first
// ANCHOR_ROW_LIMIT anchors in the same order), so the fields are additive; a caller that
// reads them can walk the whole set and stop guessing what fell off the end.
function buildAnchorConfirmationsResponse(config, latest, rows) {
    let coin    = config['COIN'];
    let network = config['NETWORK'];
    let latestNum = Number(latest);
    let all       = Array.isArray(rows) ? rows : [];
    let truncated = all.length > ANCHOR_ROW_LIMIT;
    let kept      = truncated ? all.slice(0, ANCHOR_ROW_LIMIT) : all;
    let lastKept  = kept.length > 0 ? kept[kept.length - 1] : null;
    let nextAfter = (truncated && lastKept && lastKept.action_index != null)
                  ? Number(lastKept.action_index) : null;
    let list = kept.map(row => {
        let dogeBlock = Number(row.block_index_doge);
        let confirmations = (Number.isFinite(latestNum) && Number.isFinite(dogeBlock) && latestNum >= dogeBlock)
            ? (latestNum - dogeBlock + 1) : 0;
        return {
            status:             row.status,
            version:            normalizeVersion(row.version),
            checkpoint_chain:   row.chain,
            checkpoint_network: row.network,
            block_index:        (row.block_index != null) ? Number(row.block_index) : null,
            checkpoint_seq:     (row.checkpoint_seq != null) ? Number(row.checkpoint_seq) : null,
            snapshot_block:     (row.snapshot_block != null) ? Number(row.snapshot_block) : null,
            // The ELECTED PUBLISHER pubkey the reward is attested to. Null on the
            // unattested versions, which is itself the answer for a caller checking one.
            publisher:          row.publisher ? String(row.publisher).toLowerCase() : null,
            match_batch_seq:    (row.match_batch_seq != null) ? Number(row.match_batch_seq) : null,
            block_index_doge:   Number.isFinite(dogeBlock) ? dogeBlock : null,
            confirmations:      confirmations
        };
    });
    return { coin, network, exists: list.length > 0, latest_block_index: latest, anchors: list,
             truncated: truncated, next_after_action_index: nextAfter };
}

// Validate a getarchiveanchor request. Returns
// {ok:true, block_index, checkpoint_seq, batch_crc32, match_count, author} or
// {ok:false, error}.
//
// batch_crc32 and match_count are REQUIRED, not optional narrowing filters: without
// both, the query degenerates into "is this checkpoint archived at all", which is
// true for a DIFFERENT batch wrapped in the same checkpoint and would tell a hub its
// unpublished archive is already on-chain. That direction loses match rows
// permanently, so the content terms are part of the question, never a refinement of it.
//
// `author` is optional and, when supplied, scopes the answer to "did THIS publisher
// address already publish this batch". The hub always supplies its own DOGE address:
// unscoped, a third party who copied our already-mined head onto the chain (or a
// co-signer who front-ran it) would answer "already published" for a batch whose
// CHUNKS that party never sent, and the hub would skip its own head and strand the
// archive. Scoping makes the check answer only for spends this publisher made.
function validateArchiveAnchorParams({ chain, network, block_index, checkpoint_seq, batch_crc32, match_count, author }) {
    if (typeof chain !== 'string' || !chain || typeof network !== 'string' || !network)
        return { ok: false, error: 'chain and network are required strings' };
    let bi = Number(block_index);
    let cs = Number(checkpoint_seq);
    if (!Number.isInteger(bi) || bi < 0 || !Number.isInteger(cs) || cs < 0)
        return { ok: false, error: 'block_index and checkpoint_seq must be non-negative integers' };
    if (typeof batch_crc32 !== 'string' || !ARCHIVE_CRC_RE.test(batch_crc32.toLowerCase()))
        return { ok: false, error: 'batch_crc32 must be an 8-character hex string' };
    let mc = Number(match_count);
    if (!Number.isInteger(mc) || mc < 0)
        return { ok: false, error: 'match_count must be a non-negative integer' };
    let wantAuthor = null;
    if (author !== undefined && author !== null && author !== '') {
        if (typeof author !== 'string') return { ok: false, error: 'author must be a string address' };
        wantAuthor = author;
    }
    return { ok: true, block_index: bi, checkpoint_seq: cs,
             batch_crc32: batch_crc32.toLowerCase(), match_count: mc, author: wantAuthor };
}

// Pick the archive head a caller asked for from an ARCHIVE_ANCHOR_BY_CONTENT_SQL
// result. Rows arrive action_index ASC, so with no author filter the EARLIEST head
// wins, the same canonical-head rule getAnchorV1ByBatchSeq and ARCHIVE_HEAD_AUTHOR_SQL
// use (a later copy of a batch never supersedes the row that first published it).
// A supplied author narrows to that publisher's own head; a row whose author could
// not be resolved (source null) compares unequal and is skipped, which is fail-closed
// (the caller sees "absent" and publishes, rather than adopting a head it cannot
// attribute). Address comparison is exact, not case-folded: base58/bech32 addresses
// are case-significant in the first form and canonically lowercase in the second, so
// folding could equate two different addresses.
function selectArchiveHeadRow(rows, filter) {
    let f = filter || {};
    let candidates = Array.isArray(rows) ? rows : [];
    if (f.author) candidates = candidates.filter(r => r.source != null && String(r.source) === String(f.author));
    return candidates.length > 0 ? candidates[0] : null;
}

// The continuation-chunk indexes present for a head, as a sorted array. `chunkRows`
// is a deduped ARCHIVE_CHUNK_SET_BY_AUTHOR_SQL result (v2 rows only; chunk 0 rides in
// the head itself, so it is reported present whenever the head is).
function presentChunkIndexes(head, chunkRows) {
    let present = new Set([0]);
    for (let r of (chunkRows || [])) {
        let i = Number(r.chunk_index);
        if (Number.isInteger(i) && i > 0) present.add(i);
    }
    return Array.from(present).sort((a, b) => a - b);
}

// Map a content-addressed head row (or null) plus its chunk set into the RPC response.
// Confirmations are DOGE-relative depth, computed exactly as buildAnchorActionResponse
// does, so the two anchor reads cannot drift on the "deeper than tip / not finite"
// edges.
//
// `chunks_present` and `chunks_complete` exist so the hub can resume a PARTIALLY
// published archive: the head landing and the continuation chunks landing are separate
// broadcasts, and a crash between them leaves a head on-chain with chunks missing.
// Without per-chunk resolution the hub could only choose between re-sending every
// chunk (paying again for the ones that landed) and skipping the batch (stranding it).
function buildArchiveAnchorResponse(config, latest, head, chunkRows) {
    let coin    = config['COIN'];
    let network = config['NETWORK'];
    if (!head) {
        return { coin, network, exists: false, latest_block_index: latest, confirmations: 0,
                 chunks_present: [], chunks_complete: false };
    }
    let latestNum = Number(latest);
    let dogeBlock = Number(head.block_index_doge);
    let confirmations = (Number.isFinite(latestNum) && Number.isFinite(dogeBlock) && latestNum >= dogeBlock)
        ? (latestNum - dogeBlock + 1) : 0;
    let total   = Number(head.total_chunks);
    let present = presentChunkIndexes(head, chunkRows);
    // Complete only when EVERY declared index is accounted for. A non-finite /
    // non-positive total_chunks (a malformed head) can never be complete.
    let complete = Number.isInteger(total) && total > 0 && present.length >= total &&
                   present[present.length - 1] === total - 1;
    return {
        coin, network,
        exists:             true,
        status:             head.status,                   // 'valid' | 'unverified' | 'invalid: ...'
        version:            Number(head.version),
        txid:               head.txid ? String(head.txid).toLowerCase() : null,
        // The publishing address this head is attributed to; null when the action
        // linkage is missing. A caller that supplied `author` already knows it matches.
        author:             head.source != null ? String(head.source) : null,
        checkpoint_chain:   head.chain,
        checkpoint_network: head.network,
        block_index:        Number(head.block_index),
        checkpoint_seq:     Number(head.checkpoint_seq),
        snapshot_block:     (head.snapshot_block != null) ? Number(head.snapshot_block) : null,
        // The seq the batch actually landed under, which is exactly what the caller
        // could not know: it is how a resuming publisher addresses the chunk slots of
        // a batch its own process allocated a different seq for.
        match_batch_seq:    (head.match_batch_seq != null) ? Number(head.match_batch_seq) : null,
        match_count:        (head.match_count != null) ? Number(head.match_count) : null,
        batch_crc32:        head.batch_crc32 != null ? String(head.batch_crc32).toLowerCase() : null,
        total_chunks:       Number.isFinite(total) ? total : null,
        chunks_present:     present,
        chunks_complete:    complete,
        block_index_doge:   dogeBlock,
        latest_block_index: latest,
        confirmations:      confirmations
    };
}

module.exports = {
    CHECKPOINT_VERSIONS, CHECKPOINT_SECTION_VERSIONS, CHECKPOINT_SECTION_VERSIONS_SQL,
    ANCHOR_ROW_LIMIT, ANCHOR_ACTIONS_SQL,
    ARCHIVE_HEAD_AUTHOR_SQL, ARCHIVE_CHUNK_SET_SQL, ARCHIVE_CHUNK_SET_BY_AUTHOR_SQL,
    ARCHIVE_HEAD_GATE_SQL, dedupeArchiveChunks, archiveChunkCoverage,
    ARCHIVE_HEAD_VERSIONS, ARCHIVE_CRC_RE, ARCHIVE_ANCHOR_ROW_LIMIT,
    ARCHIVE_ANCHOR_BY_CONTENT_SQL, validateArchiveAnchorParams, selectArchiveHeadRow,
    presentChunkIndexes, buildArchiveAnchorResponse,
    validateAnchorActionParams, selectAnchorRow, buildAnchorActionResponse,
    ANCHOR_BY_TXID_SQL, ANCHOR_BY_TXID_AFTER_SQL,
    validateAnchorConfirmationsParams, buildAnchorConfirmationsResponse
};
