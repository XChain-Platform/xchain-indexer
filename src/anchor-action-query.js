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

const { ARCHIVE_HEAD_VERSIONS_SQL } = require('./stateHash.js');

// ANCHOR versions that carry a full checkpoint identity (chain/network/block_index/
// checkpoint_seq + the state hashes). Version 2 is an archive continuation chunk with
// no checkpoint identity of its own, so it is never a getanchoraction match. Kept here
// as the single source of truth for both the SQL filter and the tests.
const CHECKPOINT_VERSIONS = [0, 1, 3, 4, 5, 6];

// A DOGE txid as the hub announces it (XANC_V0_DONE.txid / XANC_FINALIZED.txid).
const TXID_RE = /^[0-9a-fA-F]{64}$/;

// One checkpoint identity can carry more than one anchor row: a reorg-replayed
// re-anchor, and the v0/v3 checkpoint anchor plus the v1 archive anchor that
// shares its checkpoint_seq. The caller filters those by txid/version, so fetch
// the (tiny) candidate set rather than only the highest action_index. Bounded so
// a pathological identity can never stream unbounded rows into the RPC.
const ANCHOR_ROW_LIMIT = 20;

// Candidate anchor rows for a checkpoint identity, newest (highest action_index)
// first, each carrying the DOGE txid it landed in. The txid is resolved through
// actions -> transactions -> index_transactions; LEFT JOINed so a row whose tx
// linkage is missing still returns (txid null) instead of vanishing, which would
// silently turn a present anchor into 'absent' for the hub.
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
     ORDER BY a.action_index DESC
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
// `publisher` column is the v4/v5/v6 elected-PUBLISHER PUBKEY, a different thing
// entirely, and a v1 head has none at all.
//
// The head is the canonical one: the earliest (lowest action_index) v1/v6 row for
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

// The batch's canonical head row identity (earliest v1/v6 row for the seq,
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

// Dedupe an ARCHIVE_CHUNK_SET_SQL result to ONE row per chunk_index, lowest
// action_index first (the query's ORDER BY guarantees that arrival). Shared so the
// live path and recovery cannot drift on the tie-break either.
function dedupeArchiveChunks(rows) {
    let byIndex = new Map();
    for (let r of (rows || []))
        if (!byIndex.has(Number(r.chunk_index))) byIndex.set(Number(r.chunk_index), r);
    return Array.from(byIndex.values());
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
// ordered action_index DESC (ANCHOR_ACTIONS_SQL does this), so with no filter the
// highest action_index wins, byte-identical to the pre-filter behavior: a
// reorg-replayed re-anchor supersedes an earlier one. A supplied txid/version
// narrows to that exact anchor. Returns null when nothing matches.
function selectAnchorRow(rows, filter) {
    let f = filter || {};
    let candidates = Array.isArray(rows) ? rows : [];
    if (f.version !== undefined && f.version !== null)
        candidates = candidates.filter(r => Number(r.version) === Number(f.version));
    if (f.txid)
        candidates = candidates.filter(r => String(r.txid || '').toLowerCase() === String(f.txid).toLowerCase());
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

module.exports = {
    CHECKPOINT_VERSIONS, ANCHOR_ROW_LIMIT, ANCHOR_ACTIONS_SQL,
    ARCHIVE_HEAD_AUTHOR_SQL, ARCHIVE_CHUNK_SET_SQL, ARCHIVE_CHUNK_SET_BY_AUTHOR_SQL,
    ARCHIVE_HEAD_GATE_SQL, dedupeArchiveChunks,
    validateAnchorActionParams, selectAnchorRow, buildAnchorActionResponse
};
