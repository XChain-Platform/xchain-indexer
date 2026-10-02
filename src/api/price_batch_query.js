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

function isRound(v) {
    return Number.isSafeInteger(v) && v >= 0;
}

function validateInclusiveBounds(body, firstName, lastName) {
    body = body || {};
    let first = Number(body[firstName]);
    let last  = Number(body[lastName]);
    if (!isRound(first)) return { ok: false, error: firstName + ' must be a non-negative integer' };
    if (!isRound(last))  return { ok: false, error: lastName + ' must be a non-negative integer' };
    if (first > last)    return { ok: false, error: firstName + ' must not exceed ' + lastName };
    return { ok: true, first, last };
}

function validatedLimit(body) {
    let limit = body.limit === undefined || body.limit === null ? PRICE_BATCHES_DEFAULT_LIMIT : Number(body.limit);
    if (!Number.isInteger(limit) || limit < 1) return { ok: false, error: 'limit must be a positive integer' };
    return { ok: true, limit: Math.min(limit, PRICE_BATCHES_MAX_LIMIT) };
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
    let bounds = validateInclusiveBounds(body, 'first_round', 'last_round');
    if (!bounds.ok) return bounds;
    let page = validatedLimit(body);
    if (!page.ok) return page;
    return { ok: true, first_round: bounds.first, last_round: bounds.last, limit: page.limit };
}

function validateAttestBatchParams(body) {
    body = body || {};
    let bounds = validateInclusiveBounds(body, 'window_start_from', 'window_start_to');
    if (!bounds.ok) return bounds;
    let page = validatedLimit(body);
    if (!page.ok) return page;
    return {
        ok: true,
        window_start_from: bounds.first,
        window_start_to: bounds.last,
        limit: page.limit
    };
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

function buildAttestBatchesResponse(rows, v) {
    let list = Array.isArray(rows) ? rows : [];
    let batches = list.map(r => ({
        window_start: Number(r.batch_window_start),
        window_end:   Number(r.batch_window_end),
        row_count:    Number(r.batch_row_count),
        action_index: Number(r.action_index),
        block_index:  Number(r.block_index),
        tx_hash:      r.tx_hash === null || r.tx_hash === undefined ? null : String(r.tx_hash)
    }));
    return { batches, truncated: batches.length >= v.limit };
}

module.exports = {
    PRICE_BATCHES_DEFAULT_LIMIT,
    PRICE_BATCHES_MAX_LIMIT,
    validatePriceBatchParams,
    buildPriceBatchesResponse,
    validateAttestBatchParams,
    buildAttestBatchesResponse
};
