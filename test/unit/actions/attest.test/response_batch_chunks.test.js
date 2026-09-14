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
// This part: the ATTEST v5/v6 response batch chunk table: duplicates, corruption,
// geometry, the one publisher a batch belongs to, and its canonical head.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const fs = require('fs');
const path = require('path');

const abw = require('../../../../src/actions/attest/attest_batch_wire.js');
// Same module instance Attest holds a reference to (Node module cache); stubbing
// `verify` here controls signature acceptance inside the handler.
const ed25519 = require('../../../../src/consensus/ed25519.js');
const { setUpAttestHandler } = require('../../../helpers/attest_fixture.js');
const { ANCHOR, batchWindow, batchHandler, batchData, chunkedBatch, chunkStore, PUB_A, PUB_B, land } = require('../../../helpers/attest_batch_rail_fixture.js');

// These cases build their own handlers, but still run under the suite's setup:
// it stubs the genesis-armed gates the batch rail consults back to their legacy side.
function setUpHandler() {
    setUpAttestHandler();
}

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('ATTEST v5/v6 response batch', function () {
        beforeEach(function () {
            sinon.stub(ed25519, 'verify').returns(true);
        });

        it('a duplicate continuation is inert: refused, and absorbing nothing a second time', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            chunkStore(db);
            const { enc } = chunkedBatch(2);

            await land(h, enc, 0, 71);
            await land(h, enc, 1, 72);
            assert.strictEqual(db.enqueueHubPushTx.callCount, 1);

            const replay = await land(h, enc, 1, 73);
            assert.strictEqual(replay['STATUS'], 'invalid: CHUNK_INDEX (duplicate)');
            assert.strictEqual(db.enqueueHubPushTx.callCount, 1,
                'a replayed chunk must not push the same window at the hub twice');
        });

        it('a corrupted chunk reds the batch on the HEAD, leaving the honest chunk valid', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            const stored = chunkStore(db);
            const { enc } = chunkedBatch(2);

            await land(h, enc, 0, 71);

            // The same slot and the same declared geometry, with the body bytes mangled:
            // the wire is well formed, the reassembled window is not. Field 0 of a wire is
            // the action name, so the body sits one past its position in the format string.
            const wire = enc.wires[1].split('|');
            const body = wire[6];
            wire[6] = body.slice(0, body.length - 8) + 'AAAAAAAA';
            const cont = batchData({ FORMAT: 6, ACTION_INDEX: 72 });
            await h.parse(wire.slice(1), cont, null);

            assert.strictEqual(cont['STATUS'], 'valid', 'the chunk carried well-formed bytes of its own');
            assert.strictEqual(db.enqueueHubPushTx.called, false, 'nothing reaches the hub');
            assert.strictEqual(db.setAttestBatchStatus.callCount, 1, 'the batch verdict lands on the head');
            assert.strictEqual(db.setAttestBatchStatus.firstCall.args[0], 71);
            assert.match(db.setAttestBatchStatus.firstCall.args[1], /^invalid: ATTEST_BATCH \(/);
            assert.strictEqual(stored.find(r => r.action_index === 72).status, 'valid');
        });
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('ATTEST v5/v6 response batch', function () {
        beforeEach(function () {
            sinon.stub(ed25519, 'verify').returns(true);
        });

        it('refuses a continuation whose geometry disagrees with its head', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            chunkStore(db);
            const { enc } = chunkedBatch(2);
            await land(h, enc, 0, 71);

            // A different encoding of the same window: same batch key, another chunk count.
            const wire = enc.wires[1].split('|');
            wire[4] = '3';
            const cont = batchData({ FORMAT: 6, ACTION_INDEX: 72 });
            await h.parse(wire.slice(1), cont, null);
            assert.strictEqual(cont['STATUS'], 'invalid: TOTAL_CHUNKS (does not match the batch head)');

            // And one whose CRC names a body this head never declared.
            const other = enc.wires[1].split('|');
            other[5] = 'deadbeef';
            const cont2 = batchData({ FORMAT: 6, ACTION_INDEX: 73 });
            await h.parse(other.slice(1), cont2, null);
            assert.strictEqual(cont2['STATUS'], 'invalid: BATCH_CRC32 (does not match the batch head)');
            assert.strictEqual(db.enqueueHubPushTx.called, false);
        });
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('ATTEST v5/v6 response batch', function () {
        beforeEach(function () {
            sinon.stub(ed25519, 'verify').returns(true);
        });

        it('the head stores slot 0 and the window header a later chunk rebuilds it from', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            const stored = chunkStore(db);
            const { win, enc } = chunkedBatch(2);
            await land(h, enc, 0, 71);

            const row = stored[0];
            assert.strictEqual(row.chunk_index, 0, 'the head owns slot 0');
            assert.strictEqual(row.total_chunks, 2);
            assert.strictEqual(row.batch_crc32, enc.batchCrc32);
            assert.strictEqual(row.window_start, win.window_start);
            assert.strictEqual(row.window_end, win.window_end);
            assert.strictEqual(row.row_count, win.row_count);
            assert.strictEqual(row.btc_block_height, ANCHOR);
            assert.ok(row.chunk_b64 && row.chunk_b64.length > 0, 'and its own slice of the body');
        });

        it('a bad quorum on a completed batch reds the head and pushes nothing', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            chunkStore(db);
            const { enc } = chunkedBatch(2);
            await land(h, enc, 0, 71);

            ed25519.verify.returns(false);
            await land(h, enc, 1, 72);
            assert.strictEqual(db.enqueueHubPushTx.called, false);
            assert.match(db.setAttestBatchStatus.firstCall.args[1], /^invalid: insufficient PBFT quorum/,
                'the completing chunk is judged on the same quorum a single-wire head is');
        });
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('ATTEST v5/v6 response batch', function () {
        beforeEach(function () {
            sinon.stub(ed25519, 'verify').returns(true);
        });

        // ------------------------------------------- a batch belongs to ONE publisher

        it('a foreign continuation cannot squat a slot, and the honest set still completes', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            const stored = chunkStore(db);
            const { win, enc } = chunkedBatch(2);

            await land(h, enc, 0, 71, PUB_A);

            // Another publisher lands the same slot FIRST, carrying the real bytes. Under a
            // key-wide chunk set it would occupy slot 1 and get the honest chunk refused as
            // a duplicate, denying the window outright.
            const squat = await land(h, enc, 1, 72, PUB_B);
            assert.strictEqual(squat['STATUS'], 'valid', 'its own wire is well formed, so it is its own batch');
            assert.strictEqual(db.enqueueHubPushTx.called, false,
                'but it belongs to a batch with no head, so it absorbs nothing');

            const honest = await land(h, enc, 1, 73, PUB_A);
            assert.strictEqual(honest['STATUS'], 'valid', 'the publisher\'s own slot was never taken');
            assert.strictEqual(db.enqueueHubPushTx.callCount, 1, 'and the batch completes');
            assert.deepStrictEqual(db.enqueueHubPushTx.firstCall.args[1].rows,
                JSON.parse(abw.buildAttestBatchBody(win)).rows);
            assert.strictEqual(db.setAttestBatchStatus.called, false,
                'no foreign bytes ever joined the reassembly, so the head keeps its verdict');
            assert.strictEqual(stored.find(r => r.action_index === 72).status, 'valid',
                'and the foreign wire is judged on its own bytes, not on someone else\'s batch');
        });

        it('a continuation of a head belonging to another publisher absorbs nothing', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            chunkStore(db);
            const { enc } = chunkedBatch(2);

            await land(h, enc, 0, 71, PUB_A);
            const foreign = await land(h, enc, 1, 72, PUB_B);
            assert.strictEqual(foreign['STATUS'], 'valid');
            assert.strictEqual(db.enqueueHubPushTx.called, false,
                'a chunk completes only its OWN publisher\'s coverage; anyone could otherwise ' +
                'close a window at a moment of their choosing');
        });
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('ATTEST v5/v6 response batch', function () {
        beforeEach(function () {
            sinon.stub(ed25519, 'verify').returns(true);
        });

        // -------------------------------------------------- ONE canonical head per window

        it('a second head for the window from the same publisher neither absorbs nor pushes', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            const stored = chunkStore(db);
            const enc = abw.encodeAttestBatch(batchWindow(2));

            const first = await land(h, enc, 0, 71, PUB_A);
            assert.strictEqual(first['STATUS'], 'valid');
            assert.strictEqual(db.enqueueHubPushTx.callCount, 1);

            const dup = await land(h, enc, 0, 72, PUB_A);
            assert.strictEqual(dup['STATUS'], 'invalid: BATCH_KEY (this publisher already has a head for the window)');
            assert.strictEqual(db.enqueueHubPushTx.callCount, 1,
                'one window, one delivery: a republish must not push the same rows twice');
            assert.strictEqual(stored.find(r => r.action_index === 71).status, 'valid',
                'and the canonical head keeps its verdict');
        });

        it('the canonical head is the earliest action, whatever order the two arrive in', async function () {
            // Same two heads, landed the other way round: the pick follows action_index,
            // which is a total order, so every node names the same canonical head.
            for (const [firstIdx, secondIdx] of [[71, 72], [72, 71]]) {
                const { handler: h, db } = batchHandler('DOGE');
                const stored = chunkStore(db);
                const enc = abw.encodeAttestBatch(batchWindow(2));
                await land(h, enc, 0, firstIdx, PUB_A);
                await land(h, enc, 0, secondIdx, PUB_A);
                const valid = stored.filter(r => r.status === 'valid').map(r => r.action_index);
                assert.deepStrictEqual(valid, [firstIdx],
                    'the head that landed first is canonical; the later one is the duplicate');
                assert.strictEqual(db.enqueueHubPushTx.callCount, 1);
            }
        });

        it('another publisher\'s head for the same window is its own batch, not a duplicate', async function () {
            // The key is derived from the window, so anyone can mint a wire under it. A
            // key-wide canonical pick would let a junk head squatting a window deny the
            // honest publisher; the pick is therefore per publisher.
            const { handler: h, db } = batchHandler('DOGE');
            chunkStore(db);
            const enc = abw.encodeAttestBatch(batchWindow(2));

            await land(h, enc, 0, 71, PUB_B);
            const honest = await land(h, enc, 0, 72, PUB_A);
            assert.strictEqual(honest['STATUS'], 'valid',
                'a squatted window must not be deniable by landing a head under its key');
            assert.strictEqual(db.enqueueHubPushTx.callCount, 2);
        });
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('ATTEST v5/v6 response batch', function () {
        beforeEach(function () {
            sinon.stub(ed25519, 'verify').returns(true);
        });

        // ------------------------------------------------------ the batch link names the head

        it('a three-chunk batch pushes the HEAD\'s action index, not the completing chunk\'s', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            chunkStore(db);
            const { enc } = chunkedBatch(3);

            await land(h, enc, 0, 71);
            await land(h, enc, 1, 72);
            await land(h, enc, 2, 73);

            assert.strictEqual(db.enqueueHubPushTx.callCount, 1);
            const payload = db.enqueueHubPushTx.firstCall.args[1];
            assert.strictEqual(payload.action_index, 71,
                'the hub stamps this onto every carried response as its batch link, so it ' +
                'must name the head that declares the window');
            assert.strictEqual(payload.block_index, 6300002,
                'the block stays the completing action\'s, whose rollback un-lands the delivery');
        });

        it('a single-wire head pushes its own index, which is the head\'s', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            chunkStore(db);
            const enc = abw.encodeAttestBatch(batchWindow(2));
            await land(h, enc, 0, 71);
            assert.strictEqual(db.enqueueHubPushTx.firstCall.args[1].action_index, 71);
        });

        it('the delivery arm knows the attest_batch push type', function () {
            const src = require('../../../helpers/indexer_class_source.js').readIndexerClassSource();
            assert.match(src, /entry\.pushType === 'attest_batch'/,
                'a staged push whose type no arm handles is left undelivered and silent');
            assert.match(src, /pushAttestBatch/);
        });
    });
});
