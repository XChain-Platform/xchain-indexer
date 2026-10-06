'use strict';

const assert = require('assert');

const { foldActionRows } = require('../../../../../src/actions/anchor/v3_rows.js');

function section(chain){
    return {
        CHAIN: chain,
        BLOCK_INDEX_CHECKPOINTED: '100007',
        BLOCK_HASH: 'a'.repeat(64),
        CHECKPOINT_SEQ: '7',
        SIGS: [{ sig: chain }]
    };
}

function archive(wrapperIndex){
    return {
        WRAPPER_SECTION_INDEX: String(wrapperIndex),
        MATCH_BATCH_SEQ: '5',
        MATCH_COUNT: '1',
        BATCH_CRC32: '8665563e',
        TOTAL_CHUNKS: '1',
        ARCHIVE_B64: 'AAAA'
    };
}

const FIELDS = ['MATCH_BATCH_SEQ', 'MATCH_COUNT', 'BATCH_CRC32', 'TOTAL_CHUNKS'];

describe('ANCHOR v3 archive wrapper section fields', function () {
    const data = { FORMAT: 3, STATUS: 'valid', NETWORK: 'regtest', SNAPSHOT_BLOCK: '41647' };

    it('carries the archive tuple on the wrapper chain section row', function () {
        let rows = foldActionRows(data, [section('BTC'), section('LTC')], archive(0), []);
        assert.strictEqual(rows.length, 3);
        assert.strictEqual(rows[0].CHAIN, 'BTC');
        assert.strictEqual(rows[0].MATCH_BATCH_SEQ, '5');
        assert.strictEqual(rows[0].MATCH_COUNT, '1');
        assert.strictEqual(rows[0].BATCH_CRC32, '8665563e');
        assert.strictEqual(rows[0].TOTAL_CHUNKS, '1');
        assert.strictEqual(rows[0].ARCHIVE_B64, null);
        assert.strictEqual(rows[0].CHUNK_INDEX, null);
    });

    it('leaves every other chain section row without archive fields', function () {
        let rows = foldActionRows(data, [section('BTC'), section('LTC')], archive(0), []);
        for(let field of FIELDS) assert.strictEqual(rows[1][field], null);
    });

    it('follows the wrapper index when it is not the first section', function () {
        let rows = foldActionRows(data, [section('BTC'), section('LTC')], archive(1), []);
        for(let field of FIELDS) assert.strictEqual(rows[0][field], null);
        assert.strictEqual(rows[1].MATCH_BATCH_SEQ, '5');
    });

    it('keeps every chain section archive-free when there is no archive', function () {
        let rows = foldActionRows(data, [section('BTC')], null, []);
        assert.strictEqual(rows.length, 1);
        for(let field of FIELDS) assert.strictEqual(rows[0][field], null);
    });

    it('still appends the archive row after the sections', function () {
        let rows = foldActionRows(data, [section('BTC')], archive(0), [{ sig: 'w' }]);
        assert.strictEqual(rows[1].SECTION_INDEX, 1);
        assert.strictEqual(rows[1].ARCHIVE_B64, 'AAAA');
        assert.strictEqual(rows[1].CHAIN, null);
    });
});
