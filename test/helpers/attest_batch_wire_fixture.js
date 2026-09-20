// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Fixtures of the ATTEST v5/v6 batch wire suite (test/unit/actions/attest/attest_batch_wire.test.js
// and test/unit/actions/attest/attest_batch_wire.test/batch_wire_integrity.test.js). Like the cases, they use the
// exported API of src/actions/attest/attest_batch_wire.js alone.

const assert = require('assert');
const crypto = require('crypto');

const abw = require('../../src/actions/attest/attest_batch_wire.js');

const PUBKEY_A = 'a'.repeat(64);
const SIG_A    = '1'.repeat(128);

// A row shaped exactly as the mirror table holds one. `filler` drives how
// compressible the window is: repetitive bodies fit one wire, random ones chunk.
function batchRow(i, filler) {
    return {
        network:              'regtest',
        request_id:           crypto.createHash('sha256').update('req' + i).digest('hex'),
        request_action_index: 100 + i,
        request_block_index:  90 + i,
        provider_id:          'http_get',
        status:               'ok',
        response_payload:     filler === undefined ? 'body-' + i : filler(i),
        response_hash:        crypto.createHash('sha256').update('body-' + i).digest('hex'),
        meta:                 'm',
        effective_time:       1700000000 + i,
        admit_block_btc:      899000 + i,
        signer_pubkeys:       JSON.stringify([PUBKEY_A]),
        signatures:           JSON.stringify([{ pubkey: PUBKEY_A, sig: SIG_A }]),
        widen:                0,
    };
}

function window_(rowCount, filler, overrides = {}) {
    const rows = [];
    for (let i = 0; i < rowCount; i++) rows.push(batchRow(i, filler));
    return {
        network:          'regtest',
        window_start:     1700000000,
        window_end:       1700003600,
        row_count:        rows.length,
        btc_block_height: 900000,
        rows:             rows,
        sigs:             [{ pubkey: PUBKEY_A, sig: SIG_A }],
        ...overrides,
    };
}

// Deterministic pseudo-random filler: incompressible enough to force chunking (a
// REPEATED block would deflate away and quietly leave every chunking case running
// against a single wire), and stable across runs so a failure is reproducible.
function noisy(i) {
    let out = '';
    for (let k = 0; k < 8; k++)
        out += crypto.createHash('sha512').update('noise:' + i + ':' + k).digest('base64');
    return out;
}

// A wire string as the decoder hands it to a handler: positional fields with
// params[0] the VERSION and the action name already stripped.
function toParams(wire) {
    return wire.split('|').slice(1);
}

function chunkRows(wires) {
    return wires.slice(1).map((w, i) => {
        const c = abw.parseAttestBatchContinuation(toParams(w));
        assert.strictEqual(c.ok, true, 'fixture continuation must parse');
        return { chunk_index: c.chunkIndex, chunk_b64: c.chunkB64, action_index: 500 + i };
    });
}

function roundTrip(win) {
    const enc = abw.encodeAttestBatch(win);
    assert.strictEqual(enc.ok, true, 'fixture window must encode');
    const head = abw.parseAttestBatchHead(toParams(enc.wires[0]));
    assert.strictEqual(head.ok, true, 'fixture head must parse');
    return { enc, head, chunks: chunkRows(enc.wires) };
}

module.exports = { PUBKEY_A, SIG_A, batchRow, window_, noisy, toParams, chunkRows, roundTrip };
