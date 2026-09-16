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
// Batch-rail fixtures of the ATTEST handler suite: a handler on the DOGE rail, the
// windows it lands, and a stand-in for the attests chunk table. Shared by
// test/unit/actions/attest.test/response_batch.test.js and response_batch_chunks.test.js.

const crypto = require('crypto');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../fixtures/mocks');
const Attest = require('../../src/actions/attest/index.js');
const abw    = require('../../src/actions/attest/attest_batch_wire.js');
const { PUBKEY_A, SIG_A } = require('./attest_fixture.js');

const ANCHOR = 900000;

function batchRow(i) {
    return {
        network: 'regtest',
        request_id: crypto.createHash('sha256').update('breq' + i).digest('hex'),
        request_action_index: 100 + i, request_block_index: 90 + i,
        provider_id: 'http_get', status: 'ok',
        response_payload: 'body-' + i,
        response_hash: crypto.createHash('sha256').update('body-' + i).digest('hex'),
        meta: 'm', effective_time: 1700000000 + i,
        signer_pubkeys: JSON.stringify([PUBKEY_A]),
        signatures: JSON.stringify([{ pubkey: PUBKEY_A, sig: SIG_A }]),
        widen: 0,
    };
}
function batchWindow(rowCount = 2, overrides = {}) {
    const rows = [];
    for (let i = 0; i < rowCount; i++) rows.push(batchRow(i));
    return {
        network: 'regtest', window_start: 1700000000, window_end: 1700003600,
        row_count: rows.length, btc_block_height: ANCHOR, rows,
        sigs: [{ pubkey: PUBKEY_A, sig: SIG_A }],
        ...overrides,
    };
}
// Positional params as the decoder hands them over: params[0] is VERSION.
function wireParams(wire) { return wire.split('|').slice(1); }

// A handler on the batch rail. COIN comes from a fresh mock config, so the
// outer BTC fixtures are untouched.
function batchHandler(coin = 'DOGE') {
    const ix = createMockIndexer();
    ix.config.COIN    = coin;
    ix.config.NETWORK = 'regtest';
    const db = ix.indexerDb;
    db.createAttestationBatchAction = sinon.stub().resolves();
    db.getAttestBatchChunks         = sinon.stub().resolves([]);
    db.setAttestBatchStatus         = sinon.stub().resolves();
    db.getValidatorsByCapability    = sinon.stub().resolves([{ pubkey: PUBKEY_A }]);
    db.getStakeWeightsByCapability  = sinon.stub().resolves([{ pubkey: PUBKEY_A, source: 'SA', weight: '100' }]);
    db.getActiveCapabilityCount     = sinon.stub().resolves(1);
    db.hasCapability                = sinon.stub().resolves(true);
    const h = new Attest({
        config: ix.config, util: ix.util, mapper: ix.mapper,
        decoderDb: ix.decoderDb, indexerDb: db,
        hubClient: { enabled: true },
        protocolChanges: { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) },
    });
    return { handler: h, db, ix };
}
// SOURCE is the broadcaster address, and a batch's slots are bound to it, so every
// fixture wire is one publisher's unless a case deliberately names another.
function batchData(overrides = {}) {
    return createBaseData({
        ACTION: 'ATTEST', FORMAT: 5, BLOCK_INDEX: 6300000, ACTION_INDEX: 71,
        BLOCK_TIME: 1700004000, COIN: 'DOGE', SOURCE: PUB_A, ...overrides,
    });
}

// --------------------------------------------- multi-chunk: the stored chunk table

// A window whose encoding lands on exactly `want` wires. The row bodies are
// deterministic hash noise, which barely deflates, so each added row grows the
// compressed body by far less than one wire and the search below cannot step over
// the size it is looking for.
function chunkedBatch(want) {
    for (let n = 1; n <= 200; n++) {
        const rows = [];
        for (let i = 0; i < n; i++) {
            const r = batchRow(i);
            let noise = '';
            for (let k = 0; k < 8; k++)
                noise += crypto.createHash('sha512').update('n:' + i + ':' + k).digest('base64');
            r.response_payload = noise;
            r.response_hash = crypto.createHash('sha256').update(noise).digest('hex');
            rows.push(r);
        }
        const win = {
            network: 'regtest', window_start: 1700000000, window_end: 1700003600,
            row_count: n, btc_block_height: ANCHOR, rows,
            sigs: [{ pubkey: PUBKEY_A, sig: SIG_A }],
        };
        const enc = abw.encodeAttestBatch(win);
        if (enc.totalChunks === want) return { win, enc };
    }
    throw new Error('no window of this fixture shape encodes to ' + want + ' chunks');
}

// A stand-in for the attests chunk table: the handler's own stamped columns go in,
// and the read serves back exactly what the real query does (valid rows carrying a
// slot, EVERY publisher's, ordered by slot then action index, each carrying the
// broadcaster address). The read is deliberately not author-scoped, because the
// author partition is the handler's rule and a store that pre-filtered would pass
// whether the handler applied it or not.
function chunkStore(db) {
    const rows = [];
    db.createAttestationBatchAction = sinon.stub().callsFake(async (d) => {
        rows.push({
            action_index: Number(d['ACTION_INDEX']), version: Number(d['VERSION']),
            request_id: d['REQUEST_ID'], status: d['STATUS'], source: d['SOURCE'],
            window_start: d['WINDOW_START'], window_end: d['WINDOW_END'],
            row_count: d['ROW_COUNT'], btc_block_height: d['BTC_BLOCK_HEIGHT'],
            batch_crc32: d['BATCH_CRC32'], total_chunks: d['TOTAL_CHUNKS'],
            chunk_index: d['CHUNK_INDEX'], chunk_b64: d['CHUNK_B64'],
        });
    });
    db.getAttestBatchChunks = sinon.stub().callsFake(async (key) => rows
        .filter(r => r.request_id === key && r.status === 'valid' && r.chunk_index != null)
        .sort((a, b) => (a.chunk_index - b.chunk_index) || (a.action_index - b.action_index)));
    db.setAttestBatchStatus = sinon.stub().callsFake(async (actionIndex, status) => {
        for (const r of rows) if (r.action_index === Number(actionIndex)) r.status = status;
    });
    return rows;
}

// The publisher every batch fixture broadcasts from unless a case names another.
const PUB_A = 'DPubAxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const PUB_B = 'DPubBxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

// Land one wire of `enc` as its own action. Wire 0 is the v5 head, the rest v6.
async function land(h, enc, wireIndex, actionIndex, source = PUB_A) {
    const data = batchData({
        FORMAT: wireIndex === 0 ? 5 : 6,
        ACTION_INDEX: actionIndex,
        BLOCK_INDEX: 6300000 + wireIndex,
        SOURCE: source,
    });
    await h.parse(wireParams(enc.wires[wireIndex]), data, null);
    return data;
}

module.exports = {
    ANCHOR, batchRow, batchWindow, wireParams, batchHandler, batchData,
    chunkedBatch, chunkStore, PUB_A, PUB_B, land,
};
