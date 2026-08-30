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
// an archive batch could be CAPTURED by a junk head row.
//
// getAnchorV1ByBatchSeq picks the earliest archive-head (v1) row for a match_batch_seq and is
// status-agnostic by design (a status filter would fork mirrored vs unmirrored
// nodes, which is worse), so a permissionless ANCHOR whose signatures do not verify
// could be that earliest row. It then governed BOTH consensus-visible verdicts for
// the batch: the TOTAL_CHUNKS geometry gate, and - since P5/#3075 - the
// authorship rule, whose effect was that the real publisher's own chunks were
// filtered out and the archive never reassembled.
//
// The fix scopes the archive batch to its PUBLISHER: the batch key becomes
// (match_batch_seq, head author), so a chunk is judged against the earliest head
// authored by the SAME address, and a foreign head governs nothing. That is
// status-agnostic (no mirrored/unmirrored fork) and deterministic. It moves
// consensus-visible verdicts, so it is flag-day gated: armed at genesis on regtest
// and on testnet (2026-08-11 operator ruling), INERT placeholder on mainnet.

process.env.INDEXER_COIN = 'DOGE';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const zlib   = require('zlib');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Anchor  = require('../../../src/actions/anchor.js');
const ed25519 = require('../../../src/ed25519.js');
const swq     = require('../../../src/stake_weighted_quorum.js');
const abs     = require('../../../src/archive_batch_author_activation.js');

const PUBLISHER = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const ATTACKER  = 'mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef';

// The DOGE height the archive head landed at (anchor_actions.block_index_doge, NOT
// block_index, which is the CHECKPOINTED height on the checkpointed chain). At/after
// the regtest activation, which is armed at 0; the legacy pins switch network to
// MAINNET instead, the only network still carrying an inert placeholder.
const ARMED_BLOCK = 500;

const PUBKEY_A = 'a'.repeat(64);
const SIG      = '1'.repeat(128);
const HASH     = (c) => c.repeat(64);

// A v1 archive head on the wire (the head-lands-last case parses a real one). The
// publisher tail is always present; these cases ride the degraded ATTEST_SIG_COUNT 0
// shape, so nothing here turns on the attestation quorum or a derived reward.
function v1HeadParams(f) {
    return ['1', 'BTC', 'regtest', '500', HASH('0'), HASH('1'), HASH('2'), HASH('3'),
            '0', '100', f.batch_seq, '1', f.crc, f.total_chunks, f.head_b64, '1', PUBKEY_A, SIG,
            PUBKEY_A, '0'];
}

function gz64(str) { return zlib.gzipSync(Buffer.from(str, 'utf8'), { level: 9 }).toString('base64url'); }
function crc32Hex(str) {
    let buf = Buffer.from(str, 'utf8');
    return (zlib.crc32(buf) >>> 0).toString(16).padStart(8, '0');
}

// In-memory anchor_actions head/chunk store honouring the two selection rules the
// DB layer implements: earliest action_index wins, and (when an author is supplied)
// only rows authored by that address are candidates at all.
function makeStore(indexer, heads, chunks) {
    indexer.indexerDb.getAnchorV1ByBatchSeq = sinon.stub().callsFake(async (seq, author) => {
        let rows = heads
            .filter(h => Number(h.match_batch_seq) === Number(seq))
            .filter(h => (author === undefined || author === null) ? true : String(h.source || '') === String(author))
            .sort((a, b) => Number(a.action_index) - Number(b.action_index));
        return rows.length > 0 ? rows[0] : null;
    });
    indexer.indexerDb.getAnchorChunks = sinon.stub().callsFake(async (seq, author) => {
        // Read-path rule: rejected rows out, 'orphan' kept, and bound to an author -
        // either the one supplied (author-scoped batches) or the canonical head's.
        let scope = (author === undefined || author === null)
            ? (await indexer.indexerDb.getAnchorV1ByBatchSeq(seq) || {}).source
            : author;
        let byIndex = new Map();
        for (let c of chunks
                .filter(c => Number(c.match_batch_seq) === Number(seq))
                .filter(c => !String(c.status == null ? 'valid' : c.status).startsWith('invalid:'))
                .filter(c => scope != null && String(c.source || '') === String(scope))
                .sort((a, b) => Number(a.chunk_index) - Number(b.chunk_index) ||
                                Number(a.action_index) - Number(b.action_index)))
            if (!byIndex.has(Number(c.chunk_index))) byIndex.set(Number(c.chunk_index), c);
        return Array.from(byIndex.values());
    });
}

describe('ANCHOR archive batch capture by a junk head @regression @tier1', function () {
    let indexer, handler, heads, chunks;

    beforeEach(function () {
        indexer = createMockIndexer();
        indexer.config = Object.assign({}, indexer.config, { COIN: 'DOGE', NETWORK: 'regtest' });
        indexer.indexerDb.createAnchorAction     = sinon.stub().resolves();
        indexer.indexerDb.setAnchorArchiveStatus = sinon.stub().resolves();
        // Enough of the checkpoint surface for a v1 head to parse (the head-lands-last case).
        indexer.indexerDb.getValidatorsByCapability  = sinon.stub().resolves([{ pubkey: PUBKEY_A, amount: '1' }]);
        indexer.indexerDb.hasCapability              = sinon.stub().resolves(true);
        indexer.indexerDb.getMaxAnchorCheckpointSeq  = sinon.stub().resolves(null);
        indexer.indexerDb.getArchiveReplayWatermarks = sinon.stub().resolves({ batchSeq: null, checkpointSeq: null });
        indexer.indexerDb.createValidatorReward      = sinon.stub().resolves(true);
        indexer.indexerDb.reconcileAnchorRewardWinner= sinon.stub().resolves(0);
        heads  = [];
        chunks = [];
        makeStore(indexer, heads, chunks);
        handler = new Anchor(indexer);
        sinon.stub(ed25519, 'verify').returns(true);
        sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
    });
    afterEach(function () { sinon.restore(); });

    // The attack: a junk head lands FIRST (lower action_index) for the batch seq the
    // real publisher is about to use. Its signatures do not verify, so it is stored
    // 'invalid: ...', which the head pick cannot look at.
    function seedJunkHeadAheadOfTheRealOne(totalChunks) {
        heads.push({ action_index: 1, match_batch_seq: 9, version: 1, block_index_doge: ARMED_BLOCK,
                     total_chunks: 99, archive_b64: 'JUNK', batch_crc32: 'deadbeef', source: ATTACKER });
        heads.push({ action_index: 2, match_batch_seq: 9, version: 1, block_index_doge: ARMED_BLOCK,
                     total_chunks: totalChunks, archive_b64: 'AAA', batch_crc32: 'deadbeef', source: PUBLISHER });
    }

    it('the real publisher\'s chunk survives a junk head that squats the batch seq', async function () {
        seedJunkHeadAheadOfTheRealOne(3);
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 2, COIN: 'DOGE', ACTION_INDEX: 10, SOURCE: PUBLISHER });
        await handler.parse(['2', '9', '1', '3', 'BBBB'], data, null);
        assert.strictEqual(data['STATUS'], 'valid',
            'the junk head must not govern the geometry gate or the authorship rule of another publisher\'s batch');
    });

    it('a junk head\'s bogus TOTAL_CHUNKS no longer invalidates the legitimate chunks', async function () {
        // The half that PREDATES #3075: the junk head declared 99 chunks, so every
        // legitimate chunk of the 3-chunk batch failed the geometry gate.
        seedJunkHeadAheadOfTheRealOne(3);
        for (let i = 1; i <= 2; i++) {
            let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 2, COIN: 'DOGE', ACTION_INDEX: 10 + i, SOURCE: PUBLISHER });
            await handler.parse(['2', '9', String(i), '3', 'BBBB'], data, null);
            assert.strictEqual(data['STATUS'], 'valid', 'chunk ' + i + ' must pass its own head\'s geometry');
            chunks.push({ action_index: 10 + i, match_batch_seq: 9, chunk_index: i,
                          archive_b64: 'BBBB', source: PUBLISHER, status: data['STATUS'] });
        }
    });

    it('the attacker cannot squat a slot in the real publisher\'s batch', async function () {
        seedJunkHeadAheadOfTheRealOne(3);
        // Attacker fills chunk 1 under its OWN head (geometry 99), which is a different
        // batch as far as the real publisher is concerned.
        let junk = createBaseData({ ACTION: 'ANCHOR', FORMAT: 2, COIN: 'DOGE', ACTION_INDEX: 20, SOURCE: ATTACKER });
        await handler.parse(['2', '9', '1', '99', 'JUNK'], junk, null);
        chunks.push({ action_index: 20, match_batch_seq: 9, chunk_index: 1,
                      archive_b64: 'JUNK', source: ATTACKER, status: junk['STATUS'] });

        let real = createBaseData({ ACTION: 'ANCHOR', FORMAT: 2, COIN: 'DOGE', ACTION_INDEX: 21, SOURCE: PUBLISHER });
        await handler.parse(['2', '9', '1', '3', 'BBBB'], real, null);
        assert.strictEqual(real['STATUS'], 'valid',
            'an attacker chunk stored under its own head must not occupy the real publisher\'s slot');
    });

    it('reassembly binds to the batch\'s own head CRC, not the junk head\'s', async function () {
        let json = JSON.stringify({ v: 1, network: 'regtest', batch_seq: 9, matches: [{ match_id: 'm1' }] });
        let b64  = gz64(json);
        let cut  = Math.ceil(b64.length / 2);
        heads.push({ action_index: 1, match_batch_seq: 9, version: 1, block_index_doge: ARMED_BLOCK,
                     total_chunks: 2, archive_b64: 'JUNK', batch_crc32: '00000000', source: ATTACKER });
        heads.push({ action_index: 2, match_batch_seq: 9, version: 1, block_index_doge: ARMED_BLOCK,
                     total_chunks: 2, archive_b64: b64.slice(0, cut), batch_crc32: crc32Hex(json), source: PUBLISHER });
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 2, COIN: 'DOGE', ACTION_INDEX: 30, SOURCE: PUBLISHER });
        indexer.indexerDb.createAnchorAction.callsFake(async () => {
            chunks.push({ action_index: 30, match_batch_seq: 9, chunk_index: 1,
                          archive_b64: b64.slice(cut), source: PUBLISHER, status: data['STATUS'] });
        });
        await handler.parse(['2', '9', '1', '2', b64.slice(cut)], data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.ok(indexer.indexerDb.setAnchorArchiveStatus.notCalled,
            'the real head reassembles against its own CRC, so nothing is flagged invalid_archive');
    });

    // The head-lands-last ordering has the same exposure from the other side
    // the real head reassembled whatever chunk set the CANONICAL head's author owned, so
    // a junk head plus a couple of junk chunks got the REAL head stamped invalid_archive.
    it('a head landing last reassembles its own chunks, not the junk head\'s', async function () {
        let json = JSON.stringify({ v: 1, network: 'regtest', batch_seq: 9, matches: [{ match_id: 'm1' }] });
        let b64  = gz64(json);
        let cut1 = Math.ceil(b64.length / 3), cut2 = 2 * cut1;

        // Junk head first, with junk chunks of its own filling both slots.
        heads.push({ action_index: 1, match_batch_seq: 9, version: 1, block_index_doge: ARMED_BLOCK,
                     total_chunks: 3, archive_b64: 'JUNK', batch_crc32: '00000000', source: ATTACKER });
        chunks.push({ action_index: 2, match_batch_seq: 9, chunk_index: 1, archive_b64: 'JUNKJUNK', source: ATTACKER, status: 'valid' });
        chunks.push({ action_index: 3, match_batch_seq: 9, chunk_index: 2, archive_b64: 'JUNKJUNK', source: ATTACKER, status: 'valid' });
        // The real publisher's chunks landed before its head, so they are orphans.
        chunks.push({ action_index: 4, match_batch_seq: 9, chunk_index: 1, archive_b64: b64.slice(cut1, cut2), source: PUBLISHER, status: 'orphan' });
        chunks.push({ action_index: 5, match_batch_seq: 9, chunk_index: 2, archive_b64: b64.slice(cut2), source: PUBLISHER, status: 'orphan' });

        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE', ACTION_INDEX: 60, SOURCE: PUBLISHER });
        await handler.parse(v1HeadParams({ batch_seq: '9', crc: crc32Hex(json), total_chunks: '3', head_b64: b64.slice(0, cut1) }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.ok(indexer.indexerDb.setAnchorArchiveStatus.notCalled,
            'the real head must reassemble its own publisher\'s chunks and bind its own CRC');
    });

    it('a chunk with no resolvable author of its own lands orphan, never authenticated', async function () {
        seedJunkHeadAheadOfTheRealOne(3);
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 2, COIN: 'DOGE', ACTION_INDEX: 70, SOURCE: '' });
        await handler.parse(['2', '9', '1', '3', 'BBBB'], data, null);
        assert.strictEqual(data['STATUS'], 'orphan',
            'no author means no head of its own to authenticate against: fail closed, do not borrow one');
    });

    it('a single-publisher batch is unaffected: the head is its own canonical head', async function () {
        heads.push({ action_index: 1, match_batch_seq: 9, version: 1, block_index_doge: ARMED_BLOCK,
                     total_chunks: 3, archive_b64: 'AAA', batch_crc32: 'deadbeef', source: PUBLISHER });
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 2, COIN: 'DOGE', ACTION_INDEX: 80, SOURCE: PUBLISHER });
        await handler.parse(['2', '9', '1', '3', 'BBBB'], data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        // Honest operation must not pay for the attack case: the canonical head already
        // IS this publisher's head, so no second head lookup is issued.
        let scopedPicks = indexer.indexerDb.getAnchorV1ByBatchSeq.getCalls().filter(c => c.args[1] != null);
        assert.strictEqual(scopedPicks.length, 0, 'no re-pick when the canonical head is already the right one');
    });

    // ── Flag-day pins ────────────────────────────────────────────────────────────
    it('is INERT below the flag day: the legacy canonical-head rule still applies', async function () {
        indexer.config = Object.assign({}, indexer.config, { NETWORK: 'mainnet' });
        handler = new Anchor(indexer);
        seedJunkHeadAheadOfTheRealOne(3);
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 2, COIN: 'DOGE', ACTION_INDEX: 40, SOURCE: PUBLISHER });
        await handler.parse(['2', '9', '1', '3', 'BBBB'], data, null);
        assert.strictEqual(data['STATUS'], 'invalid: TOTAL_CHUNKS (does not match parent v1)',
            'below the flag day the pre-existing (capturable) verdict must be reproduced byte for byte');
    });

    // ── Read-path SQL pins ───────────────────────────────────────────────────────
    // The author-scoped chunk set is the half that decides what actually reassembles
    // (live path AND recovery share it), so pin the properties it must not lose.
    it('the author-scoped chunk query keeps every filter the canonical-head one has', function () {
        const q = require('../../../src/anchor-action-query.js');
        const one = (sql) => String(sql).replace(/\s+/g, ' ').trim();
        const scoped = one(q.ARCHIVE_CHUNK_SET_BY_AUTHOR_SQL);
        assert.match(scoped, /c\.version = 2/i);
        assert.match(scoped, /s\.status NOT LIKE 'invalid:%'/i, "rejected rows out, 'orphan' rows kept");
        assert.match(scoped, /cadr\.address = \?/i, 'the author is a bound parameter');
        assert.doesNotMatch(scoped, /SELECT[\s\S]*FROM[\s\S]*SELECT/i, 'no canonical-head subquery any more');
        assert.match(scoped, /ORDER BY c\.chunk_index ASC, c\.action_index ASC/i,
            'the per-index dedupe tie-break must stay deterministic');
        // Same select list as the legacy query: callers read `source` off both.
        assert.ok(scoped.startsWith(one(q.ARCHIVE_CHUNK_SET_SQL).slice(0, 60)));
        // The flag-day anchor query resolves the CANONICAL head, status-agnostically.
        const gate = one(q.ARCHIVE_HEAD_GATE_SQL);
        assert.match(gate, /ORDER BY h\.action_index ASC/i);
        assert.match(gate, /LIMIT 1/i);
        assert.doesNotMatch(gate, /status/i, 'the gate anchor must not depend on status (mirror-dependent)');
        assert.match(gate, /block_index_doge/i,
            'the flag day is a height on the chain the ANCHOR lands on, not the checkpointed height');
        assert.doesNotMatch(gate, /\bh\.block_index\b(?!_doge)/i);
    });

    it('activation is network-keyed, armed on regtest/testnet, inert on mainnet', function () {
        assert.strictEqual(abs.isArchiveBatchAuthorActive(0, 'regtest'), true);
        assert.strictEqual(abs.isArchiveBatchAuthorActive(999999998, 'mainnet'), false);
        // Testnet armed at genesis by the 2026-08-11 operator ruling: the publisher-scoped
        // rule is live from block 0 there, so the unratified path is exercised on a real
        // network before mainnet pins a height.
        assert.strictEqual(abs.ARCHIVE_BATCH_AUTHOR_ACTIVATION.testnet, 0);
        assert.strictEqual(abs.isArchiveBatchAuthorActive(0, 'testnet'), true);
        assert.strictEqual(abs.isArchiveBatchAuthorActive(999999998, 'testnet'), true);
        // Mainnet is the one placeholder left; flipping it is a ratification, not a chore.
        assert.strictEqual(abs.ARCHIVE_BATCH_AUTHOR_ACTIVATION.mainnet, 999999999);
        assert.strictEqual(abs.isArchiveBatchAuthorActive(NaN, 'regtest'), false);
        // Fails closed on an armed network too: NaN must never read as ">= 0".
        assert.strictEqual(abs.isArchiveBatchAuthorActive(NaN, 'testnet'), false);
        assert.strictEqual(abs.isArchiveBatchAuthorActive(0, 'nosuchnet'), false);
    });
});
