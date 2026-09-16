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
// ANCHOR archive chunks: the single-chunk CRC binding, v2 continuation storage
// and duplicates, chunk authorship against the head publisher, and reassembly.
// Part of the ANCHOR suite; see ../anchor.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const { createBaseData } = require('../../../../fixtures/mocks');
const { HASH, crc32Hex, gz64, v1Params, ARCHIVE_JSON, PUBLISHER, OUTSIDER, armAnchor, disarmAnchor } = require('./helpers/anchor_fixtures.js');
const eq = require('../../../../../src/equivocation_header.js');

let indexer, handler, verifyStub, swqStub, deriveGateStub;

const headOf = (source) => ({ action_index: 1, total_chunks: 3, archive_b64: 'AAA', batch_crc32: 'deadbeef', source });

describe('Anchor (ANCHOR) @regression @tier3', function () {
    beforeEach(function () {
        ({ indexer, handler, verifyStub, swqStub, deriveGateStub } = armAnchor());
    });
    afterEach(function () {
        disarmAnchor({ verifyStub, swqStub, deriveGateStub });
    });

    it('v1 single-chunk: CRC binds the archive, valid blob accepted, mismatch rejected', async function () {
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE' });
        await handler.parse(v1Params(ARCHIVE_JSON), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        // v1 canonical appends the archive fields. EQUIV active in regtest: the v1
        // ROUND_ID appends batch_seq (=0 here) to the v0 round id so v0 and v1 get
        // DISTINCT equivocation keys (so the pair never reads as a false equivocation); VIEW=0.
        let raw = ['XCHECKPOINT', 'BTC', 'regtest', '500', HASH('0'), HASH('1'), HASH('2'), HASH('3'), '0', '100',
                        '0', '1', crc32Hex(ARCHIVE_JSON), '1'].join('|');
        let expected = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, 'BTC|regtest|500|0|0', 0, raw);
        assert.strictEqual(verifyStub.firstCall.args[0], expected);

        let data2 = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE', ACTION_INDEX: 2 });
        await handler.parse(v1Params(ARCHIVE_JSON, { crc: 'deadbeef' }), data2, null);
        assert.ok(String(data2['STATUS']).startsWith('invalid: BATCH_CRC32 (archive mismatch)'));
    });

    it('v2 continuation stores, orphans without a parent v1, and rejects duplicates', async function () {
        // Orphan: no parent v1 for batch 9
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 2, COIN: 'DOGE' });
        await handler.parse(['2', '9', '1', '3', gz64('x')], data, null);
        assert.strictEqual(data['STATUS'], 'orphan');

        // Parent present, fresh chunk from the head's OWN publisher → valid. `source` is
        // the head author the chunk is bound to; createBaseData's SOURCE is the
        // chunk author, so the two must match for the chunk to be authenticated at all.
        indexer.indexerDb.getAnchorV1ByBatchSeq.resolves({ action_index: 1, total_chunks: 3, archive_b64: 'AAA', batch_crc32: 'deadbeef', source: PUBLISHER });
        let data2 = createBaseData({ ACTION: 'ANCHOR', FORMAT: 2, COIN: 'DOGE', ACTION_INDEX: 3 });
        await handler.parse(['2', '9', '1', '3', 'BBBB'], data2, null);
        assert.strictEqual(data2['STATUS'], 'valid');

        // Duplicate chunk index → invalid
        indexer.indexerDb.getAnchorChunks.resolves([{ chunk_index: 1, archive_b64: 'BBBB' }]);
        let data3 = createBaseData({ ACTION: 'ANCHOR', FORMAT: 2, COIN: 'DOGE', ACTION_INDEX: 4 });
        await handler.parse(['2', '9', '1', '3', 'BBBB'], data3, null);
        assert.ok(String(data3['STATUS']).startsWith('invalid: CHUNK_INDEX (duplicate)'));
    });

    // ── Chunk-slot poisoning. "Authenticated by its parent v1" must mean more than
    //    that a parent exists with matching geometry, or the FIRST broadcast into a slot
    //    wins permanently: a junk chunk takes the slot, the real publisher's chunk is
    //    rejected as a duplicate, and the batch can never reassemble. ─────────────────
    describe('v2 chunk authorship (#3075)', function () {
        it('rejects a chunk whose author is not the archive head publisher', async function () {
            indexer.indexerDb.getAnchorV1ByBatchSeq.resolves(headOf(PUBLISHER));
            let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 2, COIN: 'DOGE', ACTION_INDEX: 7, SOURCE: OUTSIDER });
            await handler.parse(['2', '9', '1', '3', 'BBBB'], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: SOURCE (not the archive head publisher)');
        });
    });
});

describe('Anchor (ANCHOR) @regression @tier3', function () {
    beforeEach(function () {
        ({ indexer, handler, verifyStub, swqStub, deriveGateStub } = armAnchor());
    });
    afterEach(function () {
        disarmAnchor({ verifyStub, swqStub, deriveGateStub });
    });

    describe('v2 chunk authorship (#3075)', function () {
        it('the real publisher keeps its slot: an outsider chunk no longer makes it a duplicate', async function () {
            // The denial the finding describes, driven end to end. The junk chunk is
            // rejected on authorship, so it is NOT in the occupancy set getAnchorChunks
            // returns (that query excludes 'invalid: ...' rows), and the legitimate chunk
            // for the same index parses 'valid' instead of 'invalid: CHUNK_INDEX (duplicate)'.
            indexer.indexerDb.getAnchorV1ByBatchSeq.resolves(headOf(PUBLISHER));
            let junk = createBaseData({ ACTION: 'ANCHOR', FORMAT: 2, COIN: 'DOGE', ACTION_INDEX: 8, SOURCE: OUTSIDER });
            await handler.parse(['2', '9', '1', '3', 'JUNK'], junk, null);
            assert.ok(String(junk['STATUS']).startsWith('invalid: SOURCE'));

            let real = createBaseData({ ACTION: 'ANCHOR', FORMAT: 2, COIN: 'DOGE', ACTION_INDEX: 9, SOURCE: PUBLISHER });
            await handler.parse(['2', '9', '1', '3', 'BBBB'], real, null);
            assert.strictEqual(real['STATUS'], 'valid');
        });

        it('fails closed when the head author cannot be resolved at all', async function () {
            // A head whose actions/index_addresses linkage is missing yields source null.
            // Waving the chunk through then would authenticate it against nothing.
            indexer.indexerDb.getAnchorV1ByBatchSeq.resolves(headOf(null));
            let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 2, COIN: 'DOGE', ACTION_INDEX: 10 });
            await handler.parse(['2', '9', '1', '3', 'BBBB'], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: SOURCE (archive head author unresolvable)');
        });

        it('geometry still outranks authorship, so the pre-#3075 verdict is unchanged', async function () {
            // TOTAL_CHUNKS is checked first: a wrong-geometry chunk from the right
            // publisher must keep reporting the geometry reason, not the new one.
            indexer.indexerDb.getAnchorV1ByBatchSeq.resolves(headOf(PUBLISHER));
            let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 2, COIN: 'DOGE', ACTION_INDEX: 11 });
            await handler.parse(['2', '9', '1', '4', 'BBBB'], data, null);
            assert.ok(String(data['STATUS']).startsWith('invalid: TOTAL_CHUNKS'));
        });

        it('an orphan chunk is still stored unjudged: there is no head to authenticate against', async function () {
            // Legitimate early chunks exist (the head can land last), so an
            // orphan must NOT be rejected on authorship. Excluding a junk orphan is the
            // read path's job (ARCHIVE_CHUNK_SET_SQL), not this one's.
            indexer.indexerDb.getAnchorV1ByBatchSeq.resolves(null);
            let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 2, COIN: 'DOGE', ACTION_INDEX: 12, SOURCE: OUTSIDER });
            await handler.parse(['2', '9', '1', '3', 'BBBB'], data, null);
            assert.strictEqual(data['STATUS'], 'orphan');
        });
    });
});

describe('Anchor (ANCHOR) @regression @tier3', function () {
    beforeEach(function () {
        ({ indexer, handler, verifyStub, swqStub, deriveGateStub } = armAnchor());
    });
    afterEach(function () {
        disarmAnchor({ verifyStub, swqStub, deriveGateStub });
    });

    it('v2 reassembly: the final chunk triggers CRC verification and flags a bad batch', async function () {
        let json = ARCHIVE_JSON;
        let b64  = gz64(json);
        let cut1 = Math.ceil(b64.length / 3), cut2 = 2 * cut1;
        let parent = { action_index: 1, total_chunks: 3, archive_b64: b64.slice(0, cut1), batch_crc32: crc32Hex(json), source: PUBLISHER };
        indexer.indexerDb.getAnchorV1ByBatchSeq.resolves(parent);
        // First call per parse = duplicate guard (before this chunk is stored);
        // second call = reassembly read (after the store).
        let chunk1 = { chunk_index: 1, archive_b64: b64.slice(cut1, cut2) };
        let chunk2 = { chunk_index: 2, archive_b64: b64.slice(cut2) };
        let calls = 0;
        indexer.indexerDb.getAnchorChunks.callsFake(async () => (++calls % 2 === 1) ? [chunk1] : [chunk1, chunk2]);
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 2, COIN: 'DOGE', ACTION_INDEX: 5 });
        await handler.parse(['2', '9', '2', '3', b64.slice(cut2)], data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.ok(indexer.indexerDb.setAnchorArchiveStatus.notCalled);        // CRC matched: no flag

        // Same reassembly with a corrupted parent CRC → batch flagged invalid_archive
        parent.batch_crc32 = '00000000';
        let data2 = createBaseData({ ACTION: 'ANCHOR', FORMAT: 2, COIN: 'DOGE', ACTION_INDEX: 6 });
        await handler.parse(['2', '9', '2', '3', b64.slice(cut2)], data2, null);
        assert.ok(indexer.indexerDb.setAnchorArchiveStatus.calledWith(1, 'invalid_archive'));
    });
});
