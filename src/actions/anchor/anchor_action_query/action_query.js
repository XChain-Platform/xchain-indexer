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
 * getanchoraction: the request validation, the row pick, and the row -> response
 * mapping for the per-CHECKPOINT anchor read.
 *
 * This is the leg that answers "is THIS checkpoint anchored, and by which
 * transaction". It is its own file because the two other legs beside it answer
 * different questions off different keys (a transaction, and a batch's content), and
 * reading one of them should not mean scrolling past the other two.
 *
 * TXID_RE and normalizeVersion are defined here and shared with
 * confirmations_query.js: both reads accept the same DOGE txid shape and both must
 * normalize a stored version column the same way, so one definition keeps them from
 * drifting into two.
 *
 ********************************************************************/

'use strict';

// CHECKPOINT_VERSIONS is the checkpoint-bearing version set and CHECKPOINT_SECTION_VERSIONS
// the bundle-section family inside it; both live beside the tables they name, in
// src/db/anchor_sql.js, and reach every caller through the entry's re-export.
const { CHECKPOINT_VERSIONS, CHECKPOINT_SECTION_VERSIONS } = require('../../../db/anchor_sql.js');

// A DOGE txid as the hub announces it (XANC_V0_DONE.txid / XANC_FINALIZED.txid).
const TXID_RE = /^[0-9a-fA-F]{64}$/;

// Validate the getanchoraction request shape. Returns
// {ok:true, block_index, checkpoint_seq, txid, version} on success (txid/version
// null when not supplied), or {ok:false, error} otherwise.
//
// `txid` and `version` are OPTIONAL narrowing filters added for the hub's
// anchor-gossip gate: without them this RPC answers "is THIS CHECKPOINT anchored
// at depth", which does not bind the specific announced transaction. With them it
// answers "did THIS txid (of THIS anchor version) land for this checkpoint",
// which is what closes the forged-anchor gap (a Byzantine ELECTED publisher
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

module.exports = {
    TXID_RE, normalizeVersion,
    validateAnchorActionParams, selectAnchorRow, buildAnchorActionResponse
};
