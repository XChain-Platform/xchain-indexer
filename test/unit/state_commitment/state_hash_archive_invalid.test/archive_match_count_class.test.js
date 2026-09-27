'use strict';

process.env.INDEXER_COIN = process.env.INDEXER_COIN || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const Anchor = require('../../../../src/actions/anchor/index.js');
const reassembly = require('../../../../src/actions/anchor/reassembly.js');
const { buildStateHashData, ARCHIVE_INVALID_HEIGHT_KEY_ACTIVATION } = require('../../../../src/consensus/state_hash');
const { createMockIndexer } = require('../../../fixtures/mocks');
const { buildBatch, makeKeypair, rawMatch } = require('../../../fixtures/anchor-archive.js');
const { makeAnchorDb } = require('../../../helpers/sqlAnchorDb');

function keys(){ return [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()]; }

async function projectedFor(network){
    const built = buildBatch(54, [rawMatch('class-6-count')], keys(), keys(), { chunkSize: 120, matchCount: 2 });
    const block = network === 'testnet' ? ARCHIVE_INVALID_HEIGHT_KEY_ACTIVATION['BTC:testnet'] : 7;
    const indexer = createMockIndexer();
    indexer.config = Object.assign({}, indexer.config, { COIN: 'DOGE', NETWORK: network });
    indexer.indexerDb.getAnchorChunks = sinon.stub().resolves(built.v2s);
    indexer.indexerDb.setAnchorArchiveStatus = sinon.stub().resolves();
    const handler = new Anchor(indexer);
    const parent = {
        action_index: 100, chain: 'BTC', block_index_doge: block - 1,
        match_batch_seq: built.v1.match_batch_seq, match_count: built.v1.match_count,
        batch_crc32: built.v1.batch_crc32, total_chunks: built.v1.total_chunks,
        archive_b64: built.v1.archive_b64,
    };
    await reassembly.reassembleAtChunk(handler,
        { STATUS: 'valid', MATCH_BATCH_SEQ: built.v1.match_batch_seq,
            TOTAL_CHUNKS: built.v1.total_chunks, BLOCK_INDEX: block },
        parent, null, null);
    const stamped = indexer.indexerDb.setAnchorArchiveStatus.calledWith(100, 'invalid_archive');

    const db = makeAnchorDb();
    try {
        const validId = db.status('valid');
        const parentStatusId = db.status(stamped ? 'invalid_archive' : 'unverified');
        db.anchor({ action_index: 100, version: 1, chain: 'BTC', network,
            block_index: 5000, match_batch_seq: 54, match_count: 2,
            batch_crc32: built.v1.batch_crc32, total_chunks: built.v1.total_chunks,
            status_id: parentStatusId, block_index_doge: block - 1 });
        db.anchor({ action_index: 301, version: 2, match_batch_seq: 54,
            chunk_index: built.v1.total_chunks - 1, total_chunks: built.v1.total_chunks,
            archive_b64: built.v2s[built.v2s.length - 1].archive_b64,
            status_id: validId, block_index_doge: block });
        return (await buildStateHashData(db, block,
            { activationDelay: null, gasTick: 'XCHAIN', network, coin: 'BTC' })).anchor_invalid;
    } finally {
        db.close();
        sinon.restore();
    }
}

describe('state_hash class 6 projection for archive MATCH_COUNT', function () {
    it('carries the flagged head only on the armed side', async function () {
        assert.deepStrictEqual(await projectedFor('testnet'), []);
        assert.deepStrictEqual(await projectedFor('regtest'),
            [{ action_index: 100, status: 'invalid_archive' }]);
    });
});
