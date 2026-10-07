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
// THE ATTEST HANDLER SUITE. One handler, split by behaviour across
// test/unit/actions/attest.test.js and its parts in test/unit/actions/attest.test/, every part under
// the same suite title so each full test title is what it was when the suite was
// one file. The shared setup, the wire builders and the fixture constants live in
// test/helpers/attest_fixture.js; the batch-rail fixtures in
// test/helpers/attest_batch_rail_fixture.js.
//
// This part: the ATTEST v5/v6 response batch chunk table after a failed head, where a
// republished encoding must still reassemble past the failed one's valid continuations.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const abw = require('../../../../src/actions/attest/attest_batch_wire.js');
// Same module instance Attest holds a reference to (Node module cache); stubbing
// `verify` here controls signature acceptance inside the handler.
const ed25519 = require('../../../../src/consensus/ed25519.js');
const Database = require('../../../../src/db');
const { setUpAttestHandler } = require('../../../helpers/attest_fixture.js');
const { batchHandler, chunkedBatch, chunkStore, PUB_A, PUB_B, land } = require('../../../helpers/attest_batch_rail_fixture.js');

const SLOTS = 140;

// These cases build their own handlers, but still run under the suite's setup:
// it stubs the genesis-armed gates the batch rail consults back to their legacy side.
function setUpHandler() {
    setUpAttestHandler();
}

// The chunk table behind the real query text: valid rows with a slot, the author and
// encoding terms when the query carries them, slot-major order and the query's LIMIT.
function sqlStore(db) {
    const rows = chunkStore(db);
    const sql = Object.create(Database.prototype);
    sql.doQuery = sinon.stub().callsFake(async (query, params) => {
        let out = rows.filter(r => r.request_id === String(params[0]) && r.status === 'valid' && r.chunk_index != null);
        if (query.includes('c.batch_chunk_index = ?')) {
            return out.filter(r => r.version === abw.ATTEST_BATCH_CONTINUATION_VERSION &&
                r.chunk_index === Number(params[1]) && r.source === String(params[2])).slice(0, 1);
        }
        let p = 1;
        if (query.includes('cadr.address = ?')) { const a = String(params[p++]); out = out.filter(r => r.source === a); }
        if (query.includes('c.batch_total_chunks = ?')) {
            const t = Number(params[p++]); const c = String(params[p++]);
            out = out.filter(r => r.version === abw.ATTEST_BATCH_HEAD_VERSION ||
                (Number(r.total_chunks) === t && String(r.batch_crc32) === c));
        }
        out = out.slice().sort((a, b) => (a.chunk_index - b.chunk_index) || (a.action_index - b.action_index));
        const limit = query.match(/LIMIT (\d+)/);
        return limit ? out.slice(0, Number(limit[1])) : out;
    });
    db.getAttestBatchChunks = (k, a, g) => Database.prototype.getAttestBatchChunks.call(sql, k, a, g);
    db.attestBatchSlotTaken = (k, a, i) => Database.prototype.attestBatchSlotTaken.call(sql, k, a, i);
    return rows;
}

// A real window re-split into `n` wires: the split carries no consensus weight, so a
// finer one than the encoder's is a batch the parser accepts.
function resplit(enc, n) {
    const b64 = enc.wires.map(w => w.split('|').slice(-1)[0]).join('');
    const size = Math.floor(b64.length / n / 4) * 4;
    assert.ok(size > 0, 'fixture assumption: every slot carries bytes');
    const head = enc.wires[0].split('|');
    head[9] = String(n);
    const wires = [head.slice(0, 10).concat([b64.slice(0, size)]).join('|')];
    for (let i = 1; i < n; i++)
        wires.push(['ATTEST', abw.ATTEST_BATCH_CONTINUATION_VERSION, enc.batchKey, i, n, enc.batchCrc32,
                    i === n - 1 ? b64.slice(i * size) : b64.slice(i * size, (i + 1) * size)].join('|'));
    return { batchKey: enc.batchKey, batchCrc32: enc.batchCrc32, totalChunks: n, wires };
}

// A failed earlier encoding of the same window: its head stamped invalid, every one of
// its continuations still valid, as absorbCompletedBatch leaves them.
function failedEncoding(rows, enc, crc, firstActionIndex) {
    rows.push({ action_index: firstActionIndex, version: abw.ATTEST_BATCH_HEAD_VERSION,
        request_id: enc.batchKey, status: 'invalid: ATTEST_BATCH (quorum)', source: PUB_A,
        batch_crc32: crc, total_chunks: SLOTS, chunk_index: 0, chunk_b64: 'AAAA' });
    for (let i = 1; i < SLOTS; i++)
        rows.push({ action_index: firstActionIndex + i, version: abw.ATTEST_BATCH_CONTINUATION_VERSION,
            request_id: enc.batchKey, status: 'valid', source: PUB_A,
            batch_crc32: crc, total_chunks: SLOTS, chunk_index: i, chunk_b64: 'AAAA' });
}

async function landAll(h, enc, firstActionIndex) {
    const out = [];
    for (let i = 0; i < enc.wires.length; i++) out.push(await land(h, enc, i, firstActionIndex + i));
    return out;
}

// A republish after a failed head: the failed encoding's continuations stay valid, so a
// read bounded per author alone cuts the new encoding's high slots. These cases drive the
// REAL queries over a doQuery that applies the predicates and LIMIT their text carries.
describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());

    describe('ATTEST v5/v6 response batch: a republish after a failed head', function () {
        beforeEach(function () {
            sinon.stub(ed25519, 'verify').returns(true);
        });

        it('a republished encoding absorbs although the failed one still fills every low slot', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            const rows = sqlStore(db);
            const enc = resplit(chunkedBatch(2).enc, SLOTS);
            failedEncoding(rows, enc, 'deadbeef', 1000);

            const landed = await landAll(h, enc, 5000);
            assert.ok(landed.every(d => d['STATUS'] === 'valid'), 'every wire of the republish is well formed');
            assert.strictEqual(db.enqueueHubPushTx.callCount, 1,
                'the completing chunk must absorb; a read cut at slot 128 leaves the window stuck');
            assert.strictEqual(db.setAttestBatchStatus.called, false);
        });

        it('a second chunk for a high slot of the republish is still a duplicate', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            const rows = sqlStore(db);
            const enc = resplit(chunkedBatch(2).enc, SLOTS);
            failedEncoding(rows, enc, 'deadbeef', 1000);
            failedEncoding(rows, enc, 'cafebabe', 2000);
            await land(h, enc, 0, 5000);
            await land(h, enc, SLOTS - 2, 5001);

            const replay = await land(h, enc, SLOTS - 2, 5002);
            assert.strictEqual(replay['STATUS'], 'invalid: CHUNK_INDEX (duplicate)',
                'a truncated read hid this slot, so the guard accepted its refill');
        });
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());

    describe('ATTEST v5/v6 response batch: a republish after a failed head', function () {
        beforeEach(function () {
            sinon.stub(ed25519, 'verify').returns(true);
        });

        it('a third encoding absorbs after two failed ones, so no fixed bound is involved', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            const rows = sqlStore(db);
            const enc = resplit(chunkedBatch(2).enc, SLOTS);
            failedEncoding(rows, enc, 'deadbeef', 1000);
            failedEncoding(rows, enc, 'cafebabe', 2000);

            await landAll(h, enc, 5000);
            assert.strictEqual(db.enqueueHubPushTx.callCount, 1);
        });

        it('with no valid head, a slot the failed encoding holds still refuses another encoding\'s chunk', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            const rows = sqlStore(db);
            const enc = resplit(chunkedBatch(2).enc, SLOTS);
            failedEncoding(rows, enc, 'deadbeef', 1000);

            const early = await land(h, enc, 5, 5000);
            assert.strictEqual(early['STATUS'], 'invalid: CHUNK_INDEX (duplicate)',
                'before a head the slot rule spans every encoding, as it did when the read returned them all');
            const foreign = await land(h, enc, 6, 5001, PUB_B);
            assert.strictEqual(foreign['STATUS'], 'valid', 'and only this publisher\'s slots count');
        });
    });
});
