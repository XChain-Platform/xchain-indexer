/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 **********************************************************************
 * Pure helpers for the getpricebatches RPC (api.js), extracted for unit
 * testing because startApi() is not importable (it opens DB connections).
 *
 * The question the RPC answers is the one the hub's PRICE batch publisher has
 * to ask before it re-proposes a buffered window: "which of these oracle rounds
 * already ride a VALID PRICE batch on this chain?" A validator hub cannot answer
 * it from its own tables. Its price_snapshots rows keep the per-round consensus
 * proof for every round it finalized itself, so a landed batch leaves no trace
 * there, and its at-most-once marker table records only the batches IT
 * broadcast. Measured on public testnet 2026-09-07: five hubs each held ~1400
 * finalized rounds buffered, of which ~80% were already on chain, and the
 * catch-up sweep re-published them as duplicates at a DOGE fee apiece.
 *
 * Only valid, version-0 batch rows count. An invalid wire (for example one that
 * failed signer-stake quorum during a stake-share outage) does not carry its
 * rounds for a replaying node, so the publisher is right to fill it.
 ********************************************************************/

'use strict';

// Rows a single answer may carry. A busy hour publishes three 2-round batches,
// so 500 rows span roughly a week of windows; the caller pages by advancing
// first_round past the last batch it received when `truncated` is set.
const PRICE_BATCHES_DEFAULT_LIMIT = 500;
const PRICE_BATCHES_MAX_LIMIT     = 1000;

// Valid batch rows overlapping the closed round range [?, ?]. The parameters are
// (last_round, first_round, limit): a batch overlaps when it starts at or before
// the range's end AND ends at or after the range's start. round_number is the
// batch's FIRST_ROUND on a batch row (prices.sql), so the indexed column drives
// the scan; batch_first_round is the authoritative field and is what is returned.
const PRICE_BATCHES_SQL =
    'SELECT action_index, batch_first_round, batch_last_round, round_count ' +
    'FROM prices ' +
    'WHERE version = 0 AND validation_status = ? ' +
    'AND batch_first_round IS NOT NULL AND batch_last_round IS NOT NULL ' +
    'AND batch_first_round <= ? AND batch_last_round >= ? ' +
    'ORDER BY batch_first_round ASC, action_index ASC ' +
    'LIMIT ?';

function isRound(v) {
    return Number.isSafeInteger(v) && v >= 0;
}

/**
 * Validate the request body. Rounds are non-negative safe integers with
 * first_round <= last_round; `limit` is optional and clamped to the ceiling
 * rather than refused, because a caller asking for more than the cap wants
 * "as many as you will give me", not an error.
 *
 * @param {{first_round:*, last_round:*, limit?:*}} body
 * @returns {{ok:true, first_round:number, last_round:number, limit:number}|{ok:false, error:string}}
 */
function validatePriceBatchParams(body) {
    body = body || {};
    let first = Number(body.first_round);
    let last  = Number(body.last_round);
    if (!isRound(first)) return { ok: false, error: 'first_round must be a non-negative integer' };
    if (!isRound(last))  return { ok: false, error: 'last_round must be a non-negative integer' };
    if (first > last)    return { ok: false, error: 'first_round must not exceed last_round' };
    let limit = body.limit === undefined || body.limit === null ? PRICE_BATCHES_DEFAULT_LIMIT : Number(body.limit);
    if (!Number.isInteger(limit) || limit < 1) return { ok: false, error: 'limit must be a positive integer' };
    if (limit > PRICE_BATCHES_MAX_LIMIT) limit = PRICE_BATCHES_MAX_LIMIT;
    return { ok: true, first_round: first, last_round: last, limit };
}

/**
 * Map the rows to the response. `truncated` is true when the row count hit the
 * limit, which tells the caller the range past the last returned batch is
 * unanswered rather than empty. Rows come from the driver as BigInt-or-string
 * BIGINTs, so every number is normalized through Number() for the wire.
 *
 * @param {number|null} latestBlockIndex the indexer's committed tip
 * @param {Array<object>} rows
 * @param {{first_round:number, last_round:number, limit:number}} v
 */
function buildPriceBatchesResponse(latestBlockIndex, rows, v) {
    let list = Array.isArray(rows) ? rows : [];
    let batches = list.map(r => ({
        action_index: Number(r.action_index),
        first_round:  Number(r.batch_first_round),
        last_round:   Number(r.batch_last_round),
        round_count:  r.round_count === null || r.round_count === undefined ? null : Number(r.round_count)
    }));
    return {
        block_index: latestBlockIndex === null || latestBlockIndex === undefined ? null : Number(latestBlockIndex),
        first_round: v.first_round,
        last_round:  v.last_round,
        batches:     batches,
        truncated:   batches.length >= v.limit
    };
}

module.exports = {
    PRICE_BATCHES_SQL,
    PRICE_BATCHES_DEFAULT_LIMIT,
    PRICE_BATCHES_MAX_LIMIT,
    validatePriceBatchParams,
    buildPriceBatchesResponse
};
