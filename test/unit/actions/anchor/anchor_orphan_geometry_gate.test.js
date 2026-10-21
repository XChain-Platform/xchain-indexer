'use strict';

process.env.INDEXER_COIN = 'DOGE';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const zlib = require('zlib');

const { createMockIndexer, createBaseData } = require('../../../fixtures/mocks');
const Anchor = require('../../../../src/actions/anchor/index.js');
const archiveQuery = require('../../../../src/actions/anchor/anchor_action_query/archive_query.js');
const mirrorReads = require('../../../../src/db/database/mirror_reads.js');
const anchorSql = require('../../../../src/db/anchor_sql.js');
const AnchorRecovery = require('../../../../bin/recovery.js');
const gateRegistry = require('../../../../src/consensus/gate_registry.js');
const ed25519 = require('../../../../src/consensus/ed25519.js');
const swq = require('../../../../src/consensus/stake_weighted_quorum.js');
const { v1Params, crc32Hex, gz64, PUBLISHER } =
    require('./anchor.test/helpers/anchor_fixtures.js');

const GATE = archiveQuery.ARCHIVE_ORPHAN_GEOMETRY_GATE;
const BATCH = 9;
const HEAD_TOTAL = 2;
let geometryGateActive;

function installAnchorDb(indexer, heads, chunks, state) {
    const db = indexer.indexerDb;
    db.getValidatorsByCapability = sinon.stub().resolves([{ pubkey: 'a'.repeat(64), amount: '1' }]);
    db.hasCapability = sinon.stub().resolves(true);
    db.getMaxAnchorCheckpointSeq = sinon.stub().resolves(null);
    db.getArchiveReplayWatermarks = sinon.stub().resolves({ batchSeq: null, checkpointSeq: null });
    db.createValidatorReward = sinon.stub().resolves(true);
    db.reconcileAnchorRewardWinner = sinon.stub().resolves(0);
    db.getAnchorV1ByBatchSeq = sinon.stub().callsFake(async (seq, author) =>
        heads.filter(row => Number(row.match_batch_seq) === Number(seq))
            .filter(row => author == null || String(row.source) === String(author))
            .sort((a, b) => Number(a.action_index) - Number(b.action_index))[0] || null);
    db.getAnchorChunks = sinon.stub().callsFake(async (seq, author, totalChunks, ignoreMismatchedTotal) => {
        const rows = chunks.filter(row => Number(row.match_batch_seq) === Number(seq))
            .filter(row => !String(row.status).startsWith('invalid:'))
            .filter(row => String(row.source) === String(author))
            .sort((a, b) => Number(a.chunk_index) - Number(b.chunk_index) ||
                Number(a.action_index) - Number(b.action_index));
        return archiveQuery.dedupeArchiveChunks(rows, totalChunks, ignoreMismatchedTotal);
    });
    db.createAnchorAction = sinon.stub().callsFake(async data => {
        if(Number(data['FORMAT']) === 1) {
            heads.push({
                action_index: Number(data['ACTION_INDEX']), version: 1,
                match_batch_seq: Number(data['MATCH_BATCH_SEQ']),
                total_chunks: Number(data['TOTAL_CHUNKS']), archive_b64: data['ARCHIVE_B64'],
                batch_crc32: data['BATCH_CRC32'], block_index_doge: Number(data['BLOCK_INDEX']),
                source: data['SOURCE'], status: data['STATUS']
            });
        } else if(Number(data['FORMAT']) === 2) {
            chunks.push({
                action_index: Number(data['ACTION_INDEX']), version: 2,
                match_batch_seq: Number(data['MATCH_BATCH_SEQ']),
                chunk_index: Number(data['CHUNK_INDEX']), total_chunks: Number(data['TOTAL_CHUNKS']),
                archive_b64: data['ARCHIVE_B64'], source: data['SOURCE'], status: data['STATUS']
            });
        }
    });
    db.setAnchorArchiveStatus = sinon.stub().callsFake(async actionIndex => {
        state.invalidHeads.add(Number(actionIndex));
    });
}

async function runOrdering(order) {
    const indexer = createMockIndexer();
    indexer.config = Object.assign({}, indexer.config, { COIN: 'DOGE', NETWORK: 'regtest' });
    const heads = [];
    const chunks = [];
    const state = { invalidHeads: new Set() };
    installAnchorDb(indexer, heads, chunks, state);
    const handler = new Anchor(indexer);
    const json = JSON.stringify({ v: 1, network: 'regtest', batch_seq: BATCH, matches: [] });
    const b64 = gz64(json);
    const cut = Math.ceil(b64.length / 2);
    const headParams = v1Params(json, {
        batch_seq: String(BATCH), match_count: '0', total_chunks: String(HEAD_TOTAL),
        archive_b64: b64.slice(0, cut), crc: crc32Hex(json)
    });

    const parseHead = async () => {
        const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE',
            ACTION_INDEX: 20, BLOCK_INDEX: 500, SOURCE: PUBLISHER });
        await handler.parse(headParams, data, null);
    };
    const parseMismatch = async () => {
        const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 2, COIN: 'DOGE',
            ACTION_INDEX: 10, BLOCK_INDEX: 499, SOURCE: PUBLISHER });
        await handler.parse(['2', String(BATCH), '1', '3', 'MISMATCH'], data, null);
        return data['STATUS'];
    };

    let mismatchStatus;
    if(order === 'head-first') {
        await parseHead();
        mismatchStatus = await parseMismatch();
    } else {
        mismatchStatus = await parseMismatch();
        await parseHead();
    }

    const correct = createBaseData({ ACTION: 'ANCHOR', FORMAT: 2, COIN: 'DOGE',
        ACTION_INDEX: 30, BLOCK_INDEX: 501, SOURCE: PUBLISHER });
    await handler.parse(['2', String(BATCH), '1', String(HEAD_TOTAL), b64.slice(cut)], correct, null);
    return {
        mismatchStatus,
        correctStatus: correct['STATUS'],
        headVerdict: state.invalidHeads.has(20) ? 'invalid_archive' : 'valid'
    };
}

describe('ANCHOR orphan geometry activation @regression @tier1', function () {
    let originalActiveAt;

    beforeEach(function () {
        geometryGateActive = true;
        originalActiveAt = gateRegistry.activeAt.bind(gateRegistry);
        sinon.stub(gateRegistry, 'activeAt').callsFake((key, ...args) =>
            key === GATE ? geometryGateActive : originalActiveAt(key, ...args));
        sinon.stub(ed25519, 'verify').returns(true);
        sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
    });

    afterEach(function () { sinon.restore(); });

    it('registers the head-height gate on the rollout networks', function () {
        const heights = gateRegistry.get(GATE);
        assert.strictEqual(heights.mainnet, 9999999999);
        assert.strictEqual(heights['BTC:testnet'], 157073);
        assert.strictEqual(heights['LTC:testnet'], 4928460);
        assert.strictEqual(heights['DOGE:testnet'], 68009330);
        assert.strictEqual(heights.regtest, 0);
    });

    it('makes head-first and orphan-first geometry mismatches reach the same verdict', async function () {
        const headFirst = await runOrdering('head-first');
        const orphanFirst = await runOrdering('orphan-first');

        assert.deepStrictEqual(
            { correctStatus: headFirst.correctStatus, headVerdict: headFirst.headVerdict },
            { correctStatus: orphanFirst.correctStatus, headVerdict: orphanFirst.headVerdict });
        assert.strictEqual(headFirst.correctStatus, 'valid');
        assert.strictEqual(orphanFirst.correctStatus, 'valid');
        assert.strictEqual(orphanFirst.headVerdict, 'valid');
        assert.strictEqual(headFirst.mismatchStatus.startsWith('invalid: TOTAL_CHUNKS'), true);
        assert.strictEqual(orphanFirst.mismatchStatus, 'orphan');
    });

    it('retains the historical order dependence below the gate', async function () {
        geometryGateActive = false;
        const headFirst = await runOrdering('head-first');
        const orphanFirst = await runOrdering('orphan-first');

        assert.strictEqual(headFirst.headVerdict, 'valid');
        assert.strictEqual(headFirst.correctStatus, 'valid');
        assert.strictEqual(orphanFirst.headVerdict, 'invalid_archive');
        assert.match(orphanFirst.correctStatus, /^invalid: CHUNK_INDEX \(duplicate\)/);
    });

    it('filters the mismatch from content lookup and recovery before per-index dedupe', async function () {
        const json = JSON.stringify({ v: 1, network: 'regtest', batch_seq: BATCH, matches: [] });
        const b64 = zlib.gzipSync(Buffer.from(json)).toString('base64url');
        const cut = Math.ceil(b64.length / 2);
        const head = {
            action_index: 20, version: 1, chain: 'BTC', network: 'regtest', block_index: 500,
            checkpoint_seq: 0, match_batch_seq: BATCH, match_count: 0,
            batch_crc32: crc32Hex(json), total_chunks: HEAD_TOTAL, block_index_doge: 500,
            source: PUBLISHER, status: 'valid', archive_b64: b64.slice(0, cut),
            validator_signatures: '[]', snapshot_block: 100
        };
        const mismatch = {
            action_index: 10, version: 2, match_batch_seq: BATCH, chunk_index: 1,
            total_chunks: 3, archive_b64: 'MISMATCH', source: PUBLISHER, status: 'orphan'
        };
        const correct = {
            action_index: 30, version: 2, match_batch_seq: BATCH, chunk_index: 1,
            total_chunks: HEAD_TOTAL, archive_b64: b64.slice(cut), source: PUBLISHER, status: 'valid'
        };
        const rawRows = [mismatch, correct];
        const db = {
            config: { COIN: 'DOGE', NETWORK: 'regtest' },
            async doQuery(sql) {
                if(sql === anchorSql.ARCHIVE_ANCHOR_BY_CONTENT_SQL) return [head];
                if(sql === anchorSql.ARCHIVE_CHUNK_SET_BY_AUTHOR_SQL) return rawRows;
                if(sql === anchorSql.ARCHIVE_HEAD_GATE_SQL)
                    return [{ action_index: head.action_index, block_index_doge: head.block_index_doge }];
                return [];
            },
            getAnchorChunks: mirrorReads.getAnchorChunks
        };

        const found = await mirrorReads.getArchiveAnchorByContent.call(db,
            'BTC', 'regtest', 500, 0, head.batch_crc32, 0, PUBLISHER);
        assert.deepStrictEqual(found.chunks, [correct]);

        const recovery = new AnchorRecovery(db, { log: () => {} });
        sinon.stub(recovery, 'quorumVerified').returns(true);
        const archive = await recovery.verifyBatch(head);
        assert.deepStrictEqual(archive.matches, []);
    });
});
