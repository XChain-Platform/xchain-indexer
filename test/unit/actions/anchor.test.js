// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const zlib   = require('zlib');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Anchor  = require('../../../src/actions/anchor.js');
// Same module instance Anchor holds a reference to (Node module cache) — stubbing
// `verify` here controls signature acceptance inside the handler.
const ed25519 = require('../../../src/ed25519.js');
const swq     = require('../../../src/stake_weighted_quorum.js');
const eq      = require('../../../src/equivocation_header.js');

const PUBKEY_A = 'a'.repeat(64);
const PUBKEY_B = 'b'.repeat(64);
const PUBKEY_C = 'c'.repeat(64);
const PUBKEY_D = 'd'.repeat(64);
const SIG      = '1'.repeat(128);

const HASH = (c) => c.repeat(64);

function crc32Hex(str) {
    let buf = Buffer.from(str, 'utf8');
    let n;
    if (zlib.crc32) n = zlib.crc32(buf);
    else {
        let c, crc = 0xFFFFFFFF;
        for (let i = 0; i < buf.length; i++) {
            c = (crc ^ buf[i]) & 0xFF;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            crc = (crc >>> 8) ^ c;
        }
        n = (crc ^ 0xFFFFFFFF) >>> 0;
    }
    return (n >>> 0).toString(16).padStart(8, '0');
}
function gz64(str) { return zlib.gzipSync(Buffer.from(str, 'utf8'), { level: 9 }).toString('base64url'); }

// ANCHOR v0 params (params[0] = VERSION, mirroring how actions.js splits the wire string)
function v0Params(overrides = {}) {
    let f = Object.assign({
        chain: 'BTC', network: 'regtest', block_index: '500', block_hash: HASH('0'),
        ledger: HASH('1'), actions: HASH('2'), contracts: HASH('3'),
        seq: '0', snapshot: '100',
        sigs: [[PUBKEY_A, SIG]]
    }, overrides);
    let p = ['0', f.chain, f.network, f.block_index, f.block_hash, f.ledger, f.actions, f.contracts,
             f.seq, f.snapshot, String(f.sigs.length)];
    for (let [pk, sg] of f.sigs) p.push(pk, sg);
    return p;
}

function v1Params(archiveJson, overrides = {}) {
    let b64 = (overrides.archive_b64 !== undefined) ? overrides.archive_b64 : gz64(archiveJson);
    let f = Object.assign({
        chain: 'BTC', network: 'regtest', block_index: '500', block_hash: HASH('0'),
        ledger: HASH('1'), actions: HASH('2'), contracts: HASH('3'),
        seq: '0', snapshot: '100',
        batch_seq: '0', match_count: '1',
        crc: crc32Hex(archiveJson), total_chunks: '1',
        sigs: [[PUBKEY_A, SIG]]
    }, overrides);
    let p = ['1', f.chain, f.network, f.block_index, f.block_hash, f.ledger, f.actions, f.contracts,
             f.seq, f.snapshot, f.batch_seq, f.match_count, f.crc, f.total_chunks, b64, String(f.sigs.length)];
    for (let [pk, sg] of f.sigs) p.push(pk, sg);
    return p;
}

const ARCHIVE_JSON = JSON.stringify({ v: 1, network: 'regtest', batch_seq: 0, matches: [{ match_id: 'm1' }], capability_snapshots: [] });

describe('Anchor (ANCHOR) @regression @tier3', function () {
    let indexer, handler, verifyStub, swqStub;

    function addAnchorDbStubs(db) {
        db.getValidatorsByCapability  = sinon.stub().resolves([{ pubkey: PUBKEY_A, amount: '1' }]);
        db.hasCapability              = sinon.stub().resolves(true);
        db.getMaxAnchorCheckpointSeq  = sinon.stub().resolves(null);
        db.getMaxAnchorBatchSeq       = sinon.stub().resolves(null);
        db.createAnchorAction         = sinon.stub().resolves();
        db.getAnchorV1ByBatchSeq      = sinon.stub().resolves(null);
        db.getAnchorChunks            = sinon.stub().resolves([]);
        db.setAnchorArchiveStatus     = sinon.stub().resolves();
    }

    beforeEach(function () {
        indexer = createMockIndexer();
        indexer.config = Object.assign({}, indexer.config, { COIN: 'DOGE', NETWORK: 'regtest' });
        addAnchorDbStubs(indexer.indexerDb);
        handler = new Anchor(indexer);
        verifyStub = sinon.stub(ed25519, 'verify').returns(true);
        // These cases assert legacy COUNT quorum (the live mainnet path, whose
        // activation is a far-future placeholder). Regtest has WI-1 stake-weighted
        // quorum active at every block, so pin the legacy path — the oracle_publish
        // mocks here carry no source/weight. Weighted coverage: StakeWeightedQuorum.test.js.
        swqStub = sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
    });
    afterEach(function () { verifyStub.restore(); swqStub.restore(); });

    function lastWrite() { return indexer.indexerDb.createAnchorAction.lastCall.args[0]; }

    it('v0 with a quorum of valid oracle_publish sigs is valid and stored', async function () {
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE' });
        await handler.parse(v0Params(), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        let row = lastWrite();
        assert.strictEqual(row['CHAIN'], 'BTC');
        assert.strictEqual(row['BLOCK_INDEX_CHECKPOINTED'], '500');
        assert.strictEqual(row['SNAPSHOT_BLOCK'], '100');
        // Canonical covers the wire fields, byte-identical to the hub engine. EQUIV is
        // active in regtest (WI-2 bump 2), so it is the v0 raw wrapped in the uniform
        // header (TAG=XCHECKPOINT, ROUND_ID=chain|network|block|checkpoint_seq, VIEW=0).
        let raw = ['XCHECKPOINT', 'BTC', 'regtest', '500', HASH('0'), HASH('1'), HASH('2'), HASH('3'), '0', '100'].join('|');
        let expected = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, 'BTC|regtest|500|0', 0, raw);
        assert.strictEqual(verifyStub.firstCall.args[0], expected);
    });

    it('rejects ANCHOR on a non-DOGE chain', async function () {
        indexer.config['COIN'] = 'BTC';
        handler = new Anchor(indexer);
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0 });
        await handler.parse(v0Params(), data, null);
        assert.ok(String(data['STATUS']).startsWith('invalid: ANCHOR only valid on DOGE'));
    });

    it('rejects a checkpoint for a different network', async function () {
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE' });
        await handler.parse(v0Params({ network: 'mainnet' }), data, null);
        assert.ok(String(data['STATUS']).startsWith('invalid: NETWORK'));
    });

    it('enforces 2f+1: 2 valid sigs of a 4-validator set (quorum 3) is rejected', async function () {
        indexer.indexerDb.getValidatorsByCapability.resolves(
            [PUBKEY_A, PUBKEY_B, PUBKEY_C, PUBKEY_D].map(pk => ({ pubkey: pk, amount: '1' })));
        verifyStub.callsFake((canon, sig, pk) => (pk === PUBKEY_A || pk === PUBKEY_B));
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE' });
        await handler.parse(v0Params({ sigs: [[PUBKEY_A, SIG], [PUBKEY_B, SIG], [PUBKEY_C, SIG]] }), data, null);
        // Message denominator is N (total snapshot validators), not the quorum —
        // 2 valid signatures of a 4-validator set (quorum 3) → rejected.
        assert.ok(String(data['STATUS']).startsWith('invalid: insufficient valid signatures (2/4)'));
    });

    it('stores as unverified when no oracle_publish snapshot is mirrored locally', async function () {
        indexer.indexerDb.getValidatorsByCapability.resolves([]);
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE' });
        await handler.parse(v0Params(), data, null);
        assert.strictEqual(data['STATUS'], 'unverified');
        assert.ok(indexer.indexerDb.createAnchorAction.calledOnce);   // stored regardless
    });

    it('replay guard: a checkpoint_seq below the recorded max is stale; equal is allowed (v0+v1 pairs share a seq)', async function () {
        indexer.indexerDb.getMaxAnchorCheckpointSeq.resolves(5);
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE' });
        await handler.parse(v0Params({ seq: '4' }), data, null);
        assert.ok(String(data['STATUS']).startsWith('invalid: CHECKPOINT_SEQ (stale'));

        let data2 = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE', ACTION_INDEX: 2 });
        await handler.parse(v0Params({ seq: '5' }), data2, null);
        assert.strictEqual(data2['STATUS'], 'valid');
    });

    it('replay guard: a v1 match_batch_seq below the recorded max is stale', async function () {
        indexer.indexerDb.getMaxAnchorBatchSeq.resolves(3);
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE' });
        await handler.parse(v1Params(ARCHIVE_JSON, { batch_seq: '2' }), data, null);
        assert.ok(String(data['STATUS']).startsWith('invalid: MATCH_BATCH_SEQ (stale'));
    });

    it('v1 single-chunk: CRC binds the archive — valid blob accepted, mismatch rejected', async function () {
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE' });
        await handler.parse(v1Params(ARCHIVE_JSON), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        // v1 canonical appends the archive fields. EQUIV active in regtest: the v1
        // ROUND_ID appends batch_seq (=0 here) to the v0 round id so v0 and v1 get
        // DISTINCT equivocation keys (R-4 false-slash fix); VIEW=0.
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

        // Parent present, fresh chunk → valid
        indexer.indexerDb.getAnchorV1ByBatchSeq.resolves({ action_index: 1, total_chunks: 3, archive_b64: 'AAA', batch_crc32: 'deadbeef' });
        let data2 = createBaseData({ ACTION: 'ANCHOR', FORMAT: 2, COIN: 'DOGE', ACTION_INDEX: 3 });
        await handler.parse(['2', '9', '1', '3', 'BBBB'], data2, null);
        assert.strictEqual(data2['STATUS'], 'valid');

        // Duplicate chunk index → invalid
        indexer.indexerDb.getAnchorChunks.resolves([{ chunk_index: 1, archive_b64: 'BBBB' }]);
        let data3 = createBaseData({ ACTION: 'ANCHOR', FORMAT: 2, COIN: 'DOGE', ACTION_INDEX: 4 });
        await handler.parse(['2', '9', '1', '3', 'BBBB'], data3, null);
        assert.ok(String(data3['STATUS']).startsWith('invalid: CHUNK_INDEX (duplicate)'));
    });

    it('v2 reassembly: the final chunk triggers CRC verification and flags a bad batch', async function () {
        let json = ARCHIVE_JSON;
        let b64  = gz64(json);
        let cut1 = Math.ceil(b64.length / 3), cut2 = 2 * cut1;
        let parent = { action_index: 1, total_chunks: 3, archive_b64: b64.slice(0, cut1), batch_crc32: crc32Hex(json) };
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
        assert.ok(indexer.indexerDb.setAnchorArchiveStatus.notCalled);        // CRC matched — no flag

        // Same reassembly with a corrupted parent CRC → batch flagged invalid_archive
        parent.batch_crc32 = '00000000';
        let data2 = createBaseData({ ACTION: 'ANCHOR', FORMAT: 2, COIN: 'DOGE', ACTION_INDEX: 6 });
        await handler.parse(['2', '9', '2', '3', b64.slice(cut2)], data2, null);
        assert.ok(indexer.indexerDb.setAnchorArchiveStatus.calledWith(1, 'invalid_archive'));
    });
});
