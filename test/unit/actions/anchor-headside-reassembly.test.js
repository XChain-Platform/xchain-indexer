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
// Regression for the archive reassembly CRC check must fire when the
// v1/v6 head lands AFTER its continuation chunks (chunks-before-head ordering),
// not only from the chunk side. Before the head-side gate, a corrupt multi-chunk
// batch whose completing chunk arrives first leaves the head 'valid' with the
// signed BATCH_CRC32 never verified until a recovery run.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const zlib   = require('zlib');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Anchor  = require('../../../src/actions/anchor.js');
const ed25519 = require('../../../src/ed25519.js');
const swq     = require('../../../src/stake_weighted_quorum.js');
const ahug    = require('../../../src/archive_head_unverified_gate_activation.js');

const PUBKEY_A = 'a'.repeat(64);
const SIG      = '1'.repeat(128);
const HASH     = (c) => c.repeat(64);

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

// v1 archive head carrying only its own leading blob slice + TOTAL_CHUNKS geometry.
function v1HeadParams(f) {
    let p = ['1', 'BTC', f.network || 'regtest', '500', HASH('0'), HASH('1'), HASH('2'), HASH('3'),
             '0', '100', f.batch_seq, '1', f.crc, f.total_chunks, f.head_b64, '1', PUBKEY_A, SIG];
    return p;
}

const ARCHIVE_JSON = JSON.stringify({ v: 1, network: 'regtest', batch_seq: 9, matches: [{ match_id: 'm1' }], capability_snapshots: [] });

describe('Anchor head-side reassembly gate @regression', function () {
    let indexer, handler, verifyStub, swqStub;
    let b64, headSlice, chunk1, chunk2;

    function addAnchorDbStubs(db) {
        db.getValidatorsByCapability  = sinon.stub().resolves([{ pubkey: PUBKEY_A, amount: '1' }]);
        db.getMaxAnchorCheckpointSeq  = sinon.stub().resolves(null);
        db.getArchiveReplayWatermarks = sinon.stub().resolves({ batchSeq: null, checkpointSeq: null });
        db.createAnchorAction         = sinon.stub().resolves();
        db.getAnchorV1ByBatchSeq      = sinon.stub().resolves(null);
        db.getAnchorChunks            = sinon.stub().resolves([]);
        db.setAnchorArchiveStatus     = sinon.stub().resolves();
        db.createValidatorReward      = sinon.stub().resolves(true);
        db.reconcileAnchorRewardWinner= sinon.stub().resolves(0);
    }

    beforeEach(function () {
        indexer = createMockIndexer();
        indexer.config = Object.assign({}, indexer.config, { COIN: 'DOGE', NETWORK: 'regtest' });
        addAnchorDbStubs(indexer.indexerDb);
        handler = new Anchor(indexer);
        verifyStub = sinon.stub(ed25519, 'verify').returns(true);
        swqStub = sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);

        b64       = gz64(ARCHIVE_JSON);
        let cut1  = Math.ceil(b64.length / 3), cut2 = 2 * cut1;
        headSlice = b64.slice(0, cut1);
        chunk1    = { chunk_index: 1, archive_b64: b64.slice(cut1, cut2) };
        chunk2    = { chunk_index: 2, archive_b64: b64.slice(cut2) };
    });
    afterEach(function () { verifyStub.restore(); swqStub.restore(); });

    it('chunks-before-head, corrupt blob: head-side gate flags the head invalid_archive', async function () {
        // Both continuation chunks already stored (as orphans) before the head lands.
        indexer.indexerDb.getAnchorChunks.resolves([chunk1, chunk2]);
        // BATCH_CRC32 does not bind the reassembled blob.
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE', ACTION_INDEX: 7 });
        await handler.parse(v1HeadParams({ batch_seq: '9', crc: '00000000', total_chunks: '3', head_b64: headSlice }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');   // the anchor itself stays valid
        assert.ok(indexer.indexerDb.setAnchorArchiveStatus.calledWith(7, 'invalid_archive'),
            'head-side reassembly must stamp invalid_archive when the completing chunk landed before the head');
    });

    it('chunks-before-head, sound blob: head-side gate verifies and does not flag', async function () {
        indexer.indexerDb.getAnchorChunks.resolves([chunk1, chunk2]);
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE', ACTION_INDEX: 8 });
        await handler.parse(v1HeadParams({ batch_seq: '9', crc: crc32Hex(ARCHIVE_JSON), total_chunks: '3', head_b64: headSlice }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.ok(indexer.indexerDb.setAnchorArchiveStatus.notCalled, 'a CRC-sound reassembly must not be flagged');
    });

    it('head-first ordering unchanged: no chunks stored yet means no head-side stamp', async function () {
        indexer.indexerDb.getAnchorChunks.resolves([]);   // head arrives before any chunk
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE', ACTION_INDEX: 9 });
        await handler.parse(v1HeadParams({ batch_seq: '9', crc: '00000000', total_chunks: '3', head_b64: headSlice }), data, null);
        assert.ok(indexer.indexerDb.setAnchorArchiveStatus.notCalled,
            'with the completing chunks not yet present the chunk-side gate (not the head) owns the check');
    });

    // Status axis: a node with no mirrored oracle_publish snapshot stores every v1/v6
    // head 'unverified' (oracleN === 0). The chunk-side path runs regardless of the
    // parent head's status, so the head-side gate must too, or head-last ordering skips
    // the CRC check on exactly those nodes and re-opens the ordering nondeterminism.
    // These two run on regtest, where the widening's flag day is ARMED at 0; the
    // flag-day axis (inert -> deployed 'valid'-only rule) is its own describe below.
    it('unverified head (snapshot-less node), chunks-before-head, corrupt blob: still flags invalid_archive', async function () {
        indexer.indexerDb.getValidatorsByCapability.resolves([]); // no snapshot -> head stored 'unverified'
        indexer.indexerDb.getAnchorChunks.resolves([chunk1, chunk2]);
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE', ACTION_INDEX: 11 });
        await handler.parse(v1HeadParams({ batch_seq: '9', crc: '00000000', total_chunks: '3', head_b64: headSlice }), data, null);
        assert.strictEqual(data['STATUS'], 'unverified');
        assert.ok(indexer.indexerDb.setAnchorArchiveStatus.calledWith(11, 'invalid_archive'),
            'an unverified head must run the same head-side CRC check as a valid one');
    });

    it('unverified head, chunks-before-head, sound blob: verifies and does not flag', async function () {
        indexer.indexerDb.getValidatorsByCapability.resolves([]);
        indexer.indexerDb.getAnchorChunks.resolves([chunk1, chunk2]);
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE', ACTION_INDEX: 12 });
        await handler.parse(v1HeadParams({ batch_seq: '9', crc: crc32Hex(ARCHIVE_JSON), total_chunks: '3', head_b64: headSlice }), data, null);
        assert.strictEqual(data['STATUS'], 'unverified');
        assert.ok(indexer.indexerDb.setAnchorArchiveStatus.notCalled, 'a CRC-sound unverified reassembly must not be flagged');
    });

    // Coverage axis: completeness is exact index coverage of {1..TOTAL_CHUNKS-1}, not a
    // bare chunk count. A stray out-of-range orphan chunk squatting an impossible slot
    // must neither mask a missing in-range index nor block a genuinely complete set.
    it('stray out-of-range chunk masking a missing index: count would fire, coverage does not', async function () {
        // Need indices {1,2}; present are {1} and a stray {5}. Count === 2 === TOTAL_CHUNKS-1
        // (the old bug) but index 2 is missing, so the batch is NOT complete.
        let stray = { chunk_index: 5, archive_b64: 'ZZZZ' };
        indexer.indexerDb.getAnchorChunks.resolves([chunk1, stray]);
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE', ACTION_INDEX: 13 });
        // Sound CRC for the real (still-incomplete) batch: a false reassembly would mismatch and wrongly flag.
        await handler.parse(v1HeadParams({ batch_seq: '9', crc: crc32Hex(ARCHIVE_JSON), total_chunks: '3', head_b64: headSlice }), data, null);
        assert.ok(indexer.indexerDb.setAnchorArchiveStatus.notCalled,
            'an incomplete batch padded to length by a stray out-of-range chunk must not be reassembled');
    });

    it('complete set plus a stray out-of-range chunk, corrupt blob: coverage still runs the check', async function () {
        // {1,2} complete plus a stray {5}: count === 3 !== TOTAL_CHUNKS-1 blocked the check
        // forever under the old count test; coverage drops the stray and verifies.
        let stray = { chunk_index: 5, archive_b64: 'ZZZZ' };
        indexer.indexerDb.getAnchorChunks.resolves([chunk1, chunk2, stray]);
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE', ACTION_INDEX: 14 });
        await handler.parse(v1HeadParams({ batch_seq: '9', crc: '00000000', total_chunks: '3', head_b64: headSlice }), data, null);
        assert.ok(indexer.indexerDb.setAnchorArchiveStatus.calledWith(14, 'invalid_archive'),
            'a complete in-range set must be verified even when an extra out-of-range chunk is present');
    });
});

// The 'unverified' admission is preimage-moving (invalid_archive is projected by
// stateHash.js class 6) and it does NOT move the two node classes together: a mirrored
// node whose quorum FAILS gets error set, so the gate never runs and no stamp lands,
// while a snapshot-less node's same head is 'unverified' with error null and stamps.
// So it ships default INERT behind a per-network height, like every other
// preimage-moving change in this repo, and must never be re-landed ungated.
describe('Anchor head-side reassembly gate: unverified flag-day @regression', function () {
    let indexer, handler, verifyStub, swqStub;
    let headSlice, chunk1, chunk2;

    function addAnchorDbStubs(db) {
        db.getValidatorsByCapability  = sinon.stub().resolves([{ pubkey: PUBKEY_A, amount: '1' }]);
        db.getMaxAnchorCheckpointSeq  = sinon.stub().resolves(null);
        db.getArchiveReplayWatermarks = sinon.stub().resolves({ batchSeq: null, checkpointSeq: null });
        db.createAnchorAction         = sinon.stub().resolves();
        db.getAnchorV1ByBatchSeq      = sinon.stub().resolves(null);
        db.getAnchorChunks            = sinon.stub().resolves([]);
        db.setAnchorArchiveStatus     = sinon.stub().resolves();
        db.createValidatorReward      = sinon.stub().resolves(true);
        db.reconcileAnchorRewardWinner= sinon.stub().resolves(0);
    }

    // Build a handler bound to `network`, with the archive chunks already stored.
    function handlerFor(network) {
        indexer = createMockIndexer();
        indexer.config = Object.assign({}, indexer.config, { COIN: 'DOGE', NETWORK: network });
        addAnchorDbStubs(indexer.indexerDb);
        indexer.indexerDb.getAnchorChunks.resolves([chunk1, chunk2]);
        return new Anchor(indexer);
    }

    beforeEach(function () {
        verifyStub = sinon.stub(ed25519, 'verify').returns(true);
        swqStub    = sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
        let b64    = gz64(ARCHIVE_JSON);
        let cut1   = Math.ceil(b64.length / 3), cut2 = 2 * cut1;
        headSlice  = b64.slice(0, cut1);
        chunk1     = { chunk_index: 1, archive_b64: b64.slice(cut1, cut2) };
        chunk2     = { chunk_index: 2, archive_b64: b64.slice(cut2) };
    });
    afterEach(function () { verifyStub.restore(); swqStub.restore(); });

    // Run a corrupt-CRC head-last arrival on `network` at DOGE height `blockIndex`,
    // returning whether the head-side gate stamped invalid_archive.
    async function stampedAt(network, blockIndex, snapshotless) {
        handler = handlerFor(network);
        if (snapshotless) indexer.indexerDb.getValidatorsByCapability.resolves([]);
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE', ACTION_INDEX: 21, BLOCK_INDEX: blockIndex });
        await handler.parse(v1HeadParams({ network, batch_seq: '9', crc: '00000000', total_chunks: '3', head_b64: headSlice }), data, null);
        return { stamped: indexer.indexerDb.setAnchorArchiveStatus.calledWith(21, 'invalid_archive'), status: data['STATUS'] };
    }

    it('every mainnet and testnet key is INERT, regtest armed at 0', function () {
        for (const net of ['mainnet', 'testnet']) {
            assert.strictEqual(ahug.ARCHIVE_HEAD_UNVERIFIED_GATE_ACTIVATION[net], 999999999,
                net + ' must stay an INERT placeholder until the class-6 height-key repair is pinned on the same train');
        }
        assert.strictEqual(ahug.ARCHIVE_HEAD_UNVERIFIED_GATE_ACTIVATION.regtest, 0, 'regtest armed at genesis');
    });

    it('the predicate is fail-closed on a junk height or an unknown network', function () {
        assert.strictEqual(ahug.isArchiveHeadUnverifiedGateActive('nope', 'regtest'), false);
        assert.strictEqual(ahug.isArchiveHeadUnverifiedGateActive(null, 'regtest'), false);
        assert.strictEqual(ahug.isArchiveHeadUnverifiedGateActive(0, 'nosuchnet'), false);
        assert.strictEqual(ahug.isArchiveHeadUnverifiedGateActive(0, 'regtest'), true);
        assert.strictEqual(ahug.isArchiveHeadUnverifiedGateActive(999999998, 'testnet'), false);
    });

    it('gate INERT (testnet), unverified head, corrupt blob: deployed valid-only rule stands, no stamp', async function () {
        let r = await stampedAt('testnet', 100, true);
        assert.strictEqual(r.status, 'unverified');
        assert.strictEqual(r.stamped, false,
            'below the flag day the head-side gate must keep its deployed valid-only rule, or the widening forks the fleet ungated');
    });

    it('gate INERT (testnet), VALID head, corrupt blob: the always-on half of the gate still stamps', async function () {
        let r = await stampedAt('testnet', 100, false);
        assert.strictEqual(r.status, 'valid');
        assert.strictEqual(r.stamped, true, 'the flag day governs ONLY the unverified admission, never the valid path');
    });

    it('gate ARMED (regtest), unverified head, corrupt blob: stamps', async function () {
        let r = await stampedAt('regtest', 100, true);
        assert.strictEqual(r.status, 'unverified');
        assert.strictEqual(r.stamped, true, 'at/after the flag day an unverified head runs the same CRC check as a valid one');
    });

    it('the gate is keyed on the HEAD\'s own DOGE height: one block below the threshold is inert', async function () {
        const map  = ahug.ARCHIVE_HEAD_UNVERIFIED_GATE_ACTIVATION;
        const prev = map.regtest;
        map.regtest = 500;
        try {
            assert.strictEqual((await stampedAt('regtest', 499, true)).stamped, false, 'one block below the height must be inert');
            assert.strictEqual((await stampedAt('regtest', 500, true)).stamped, true, 'the threshold block itself is active');
        } finally { map.regtest = prev; }
    });
});
