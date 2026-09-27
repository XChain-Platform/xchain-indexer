'use strict';

process.env.INDEXER_COIN = process.env.INDEXER_COIN || 'DOGE';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const Anchor = require('../../../../src/actions/anchor/index.js');
const reassembly = require('../../../../src/actions/anchor/reassembly.js');
const gateRegistry = require('../../../../src/consensus/gate_registry');
const { createMockIndexer, createBaseData } = require('../../../fixtures/mocks');
const { buildBatch, makeKeypair, rawMatch } = require('../../../fixtures/anchor-archive.js');
const {
    v1Params, armAnchor, disarmAnchor,
} = require('./anchor.test/helpers/anchor_fixtures.js');

const ANCHOR_KEY = 'anchor_activation.ANCHOR_ACTIVATION';
const MATCH_COUNT_KEY = 'archive_match_count_activation.ARCHIVE_MATCH_COUNT_ACTIVATION';

function keys(){ return [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()]; }

function batches(){
    const oracleKeys = keys();
    const crossKeys = keys();
    const matches = [rawMatch('match-count-1')];
    const honest = buildBatch(91, matches, oracleKeys, crossKeys, { chunkSize: 120 });
    const mismatch = buildBatch(91, matches, oracleKeys, crossKeys, { chunkSize: 120, matchCount: 2 });
    return { honest, mismatch };
}

function headHeight(network){
    return network === 'testnet' ? gateRegistry.get(ANCHOR_KEY).testnet : 1;
}

async function singleChunkStatus(network, matchCount){
    const built = batches().honest;
    const fullB64 = built.v1.archive_b64 + built.v2s.map(row => row.archive_b64).join('');
    const armed = armAnchor();
    armed.indexer.config.NETWORK = network;
    try {
        const params = v1Params('', {
            network,
            batch_seq: String(built.v1.match_batch_seq),
            match_count: String(matchCount),
            crc: built.v1.batch_crc32,
            total_chunks: '1',
            archive_b64: fullB64,
        });
        const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE', BLOCK_INDEX: headHeight(network) });
        await armed.handler.parse(params, data, null);
        return data.STATUS;
    } finally {
        disarmAnchor(armed);
    }
}

function reassemblyHandler(network, built){
    const indexer = createMockIndexer();
    indexer.config = Object.assign({}, indexer.config, { COIN: 'DOGE', NETWORK: network });
    indexer.indexerDb.getAnchorV1ByBatchSeq = sinon.stub().resolves(null);
    indexer.indexerDb.getAnchorChunks = sinon.stub().resolves(built.v2s);
    indexer.indexerDb.setAnchorArchiveStatus = sinon.stub().resolves();
    return { indexer, handler: new Anchor(indexer) };
}

function headData(network, built){
    return {
        STATUS: 'valid', ACTION_INDEX: 71, CHAIN: 'BTC', NETWORK: network,
        BLOCK_INDEX: headHeight(network), MATCH_BATCH_SEQ: built.v1.match_batch_seq,
        MATCH_COUNT: built.v1.match_count, BATCH_CRC32: built.v1.batch_crc32,
        TOTAL_CHUNKS: built.v1.total_chunks, ARCHIVE_B64: built.v1.archive_b64,
        SOURCE: 'publisher',
    };
}

function parentRow(network, built){
    return {
        action_index: 71, chain: 'BTC', network,
        block_index_doge: headHeight(network), match_batch_seq: built.v1.match_batch_seq,
        match_count: built.v1.match_count, batch_crc32: built.v1.batch_crc32,
        total_chunks: built.v1.total_chunks, archive_b64: built.v1.archive_b64,
    };
}

describe('ANCHOR archive MATCH_COUNT gate', function () {
    it('returns null for non-gzip, non-JSON, and archives without a matches array', function () {
        const { handler } = reassemblyHandler('regtest', { v2s: [] });
        const zlib = require('zlib');
        const encoded = value => zlib.gzipSync(Buffer.from(value, 'utf8')).toString('base64url');
        assert.strictEqual(handler.archiveMatchCount('not-gzip'), null);
        assert.strictEqual(handler.archiveMatchCount(encoded('{')), null);
        assert.strictEqual(handler.archiveMatchCount(encoded(JSON.stringify({ v: 1 }))), null);
        sinon.restore();
    });

    it('pins the activation axis and the fixture signs an overridden count', function () {
        assert.strictEqual(gateRegistry.activeAt(MATCH_COUNT_KEY, 'testnet', null, headHeight('testnet'), null), false);
        assert.strictEqual(gateRegistry.activeAt(MATCH_COUNT_KEY, 'regtest', null, headHeight('regtest'), null), true);
        const { honest, mismatch } = batches();
        assert.strictEqual(honest.v1.match_count, 1);
        assert.strictEqual(mismatch.v1.match_count, 2);
        assert.notStrictEqual(honest.v1.validator_signatures, mismatch.v1.validator_signatures);
    });

    it('single chunk is valid while inert and rejected when armed; honest count stays valid', async function () {
        assert.strictEqual(await singleChunkStatus('testnet', 2), 'valid');
        assert.strictEqual(await singleChunkStatus('regtest', 2), 'invalid: MATCH_COUNT (archive mismatch)');
        assert.strictEqual(await singleChunkStatus('testnet', 1), 'valid');
        assert.strictEqual(await singleChunkStatus('regtest', 1), 'valid');
    });

    for(const side of ['head-last', 'chunk-last']){
        it(side + ' flags a CRC-valid mismatched batch only when armed', async function () {
            for(const network of ['testnet', 'regtest']){
                const { mismatch } = batches();
                const { indexer, handler } = reassemblyHandler(network, mismatch);
                if(side === 'head-last'){
                    await reassembly.reassembleAtHead(handler, headData(network, mismatch), null, 1);
                } else {
                    const data = { STATUS: 'valid', MATCH_BATCH_SEQ: mismatch.v1.match_batch_seq,
                        TOTAL_CHUNKS: mismatch.v1.total_chunks, BLOCK_INDEX: headHeight(network) + 1 };
                    await reassembly.reassembleAtChunk(handler, data, parentRow(network, mismatch), null, null);
                }
                assert.strictEqual(indexer.indexerDb.setAnchorArchiveStatus.calledWith(71, 'invalid_archive'), network === 'regtest');
                sinon.restore();
            }
        });
    }

    it('honest chunked batches remain valid on both sides of the gate', async function () {
        for(const network of ['testnet', 'regtest']){
            const { honest } = batches();
            for(const side of ['head', 'chunk']){
                const { indexer, handler } = reassemblyHandler(network, honest);
                if(side === 'head') await reassembly.reassembleAtHead(handler, headData(network, honest), null, 1);
                else await reassembly.reassembleAtChunk(handler,
                    { STATUS: 'valid', MATCH_BATCH_SEQ: honest.v1.match_batch_seq,
                        TOTAL_CHUNKS: honest.v1.total_chunks, BLOCK_INDEX: headHeight(network) + 1 },
                    parentRow(network, honest), null, null);
                assert.ok(indexer.indexerDb.setAnchorArchiveStatus.notCalled);
                sinon.restore();
            }
        }
    });
});
