// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// The mirror and request rows every applier suite builds its cases from
// (test/unit/actions/attest/attest_response_applier.test.js and its parts beside it).

'use strict';

const crypto = require('crypto');

const PUBKEY_A = 'a'.repeat(64);
const SIG_A    = '1'.repeat(128);
const REQ_ID   = 'd'.repeat(64);

const BODY      = 'hello';
const BODY_HASH = crypto.createHash('sha256').update(Buffer.from(BODY, 'utf8')).digest('hex');

// The request's own block, its deadline, and the protocol time of the block the
// binding rule is asked about. EFFECTIVE_TIME is the SIGNED stamp inside the row.
const REQ_BLOCK   = 90;
const DEADLINE    = 200;
const BLOCK_TIME  = 1700000000;
const EFFECTIVE_T = BLOCK_TIME;             // binds at the first block whose t(B) reaches it

function mirrorRow(overrides = {}) {
    return {
        request_id:       REQ_ID,
        provider_id:      'http_get',
        status:           'ok',
        response_payload: BODY,
        response_hash:    BODY_HASH,
        meta:             'm',
        effective_time:   EFFECTIVE_T,
        signer_pubkeys:   JSON.stringify([PUBKEY_A]),
        signatures:       JSON.stringify([{ pubkey: PUBKEY_A, sig: SIG_A }]),
        widen:            0,
        ...overrides,
    };
}

function requestRow(overrides = {}) {
    return {
        request_id:           REQ_ID,
        action_index:         11,
        provider_id:          'http_get',
        request_status:       'pending',
        deadline_block:       DEADLINE,
        block_index:          REQ_BLOCK,
        redundancy:           1,
        contract_index:       5,
        callback_method:      'onResult',
        callback_params_json: '[]',
        fee_payer:            'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
        ...overrides,
    };
}

module.exports = {
    PUBKEY_A, SIG_A, REQ_ID, BODY, BODY_HASH, REQ_BLOCK, DEADLINE, BLOCK_TIME, EFFECTIVE_T,
    mirrorRow, requestRow,
};
