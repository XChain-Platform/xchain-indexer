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
 * The values a refused ATTEST response or batch row binds into the attests columns
 * (src/sql/attests.sql), for row_writers.js. Every response and batch action writes its
 * row whatever the verdict, and a value its column refused failed the write under a
 * strict session, retrying the block forever on every indexer. A value that fits binds
 * unchanged, and a valid row never comes through here.
 *
 ********************************************************************/

'use strict';

const { fitColumnText } = require('../column_text.js');

// request_id CHAR(64) keeps the table's utf8mb3 charset; provider_id VARCHAR(32) and meta
// VARCHAR(256) are utf8mb4; the batch window and anchor are BIGINT UNSIGNED.
const REQUEST_ID_CHARS  = 64;
const PROVIDER_ID_CHARS = 32;
const META_CHARS        = 256;
const U64_MAX           = '18446744073709551615';

// attests.response_status, in column order (the order an ENUM index counts).
const RESPONSE_STATUSES = ['ok', 'timeout', 'no_quorum', 'provider_error', 'expired'];

// Whether a strict session stores this bound value in attests.response_status, judged as
// the server reads an ENUM bind: excess trailing spaces are cut, a label then matches
// case-insensitively, and an unmatched decimal of at most five characters is read as a
// 1-based label index ('3' stores 'no_quorum'). Only spellings of printable ASCII are
// claimed; a non-ASCII one the utf8 collation folds onto a label is not, so it fits as
// NULL rather than risk a value the server refuses. NULL stores, the column being nullable.
function storesResponseStatus(value){
    if(value === null || value === undefined) return true;
    let s = String(value).replace(/ +$/, '');
    if(!/^[\x20-\x7e]*$/.test(s)) return false;
    if(RESPONSE_STATUSES.includes(s.toLowerCase())) return true;
    return /^[0-9]{1,5}$/.test(s) && Number(s) >= 1 && Number(s) <= RESPONSE_STATUSES.length;
}

// A refused ATTEST v1 (or v4) response row. Its wire is unbounded once any rule refused it:
// a REQUEST_ID with a supplementary-plane character (errno 1366) or past 64 characters
// (1406), an absent PROVIDER_ID (1048) or one past 32 characters (1406), a STATUS the ENUM
// cannot store (1265; a v4 binds '' for an absent one), and a META past 256 characters
// (1406). Text is fitted to its column (a utf8mb3 code point becomes U+FFFD; a cut of excess
// trailing spaces stores what the server's own cut stored), an absent provider is the empty
// string a rejected v4 already stores, and an unstorable status is NULL.
//
// Readers never take a refused response row into logic. getAttestationDataForVM and the
// relay queue join select status 'valid'; the rollback expiry recompute counts only valid
// responses; the rollback stats read takes response_status 'ok' with validator_signatures
// set, which a refused row never carries (every path inlines signatures on a valid row
// only); the batch link stamp is scoped to the valid row. No state_hash class reads a v1
// row, and NULL matches no 'ok' or IN ('ok','expired') predicate.
function refusedResponseColumns(cols){
    return {
        request_id:      fitColumnText(cols.request_id, REQUEST_ID_CHARS, true),
        provider_id:     fitColumnText(cols.provider_id ?? '', PROVIDER_ID_CHARS, false),
        response_status: storesResponseStatus(cols.response_status) ? cols.response_status : null,
        meta:            fitColumnText(cols.meta, META_CHARS, false)
    };
}

// A refused ATTEST v5 head row stores the window and anchor its wire declared, which the
// head parser admits at any digit count, so a refused head declaring one past 2^64 - 1
// failed the insert (errno 1264). On a refused row each binds its nearest column bound.
// Every batch reader (the chunk and slot reads, the completeness read, the rollback read
// and the attest_batch_head state_hash class) selects valid heads only, and a refused head
// is never stamped, so the bound is never read.
function refusedBatchWindow(util, cols){
    let fit = (v) => util.fitIntegerColumn(v, '0', U64_MAX) ?? null;
    return {
        window_start:     fit(cols.window_start),
        window_end:       fit(cols.window_end),
        btc_block_height: fit(cols.btc_block_height)
    };
}

module.exports = { RESPONSE_STATUSES, storesResponseStatus, refusedResponseColumns, refusedBatchWindow };
