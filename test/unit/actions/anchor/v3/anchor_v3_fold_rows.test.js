'use strict';

const assert = require('assert');
const { foldActionRows } = require('../../../../../src/actions/anchor/v3/v3_rows.js');
const { anchorActionRow } = require('../../../../../src/db/anchors/anchor_action_row.js');

const ARCHIVE_COLUMNS = [
    'MATCH_BATCH_SEQ', 'MATCH_COUNT', 'BATCH_CRC32', 'TOTAL_CHUNKS',
    'CHUNK_INDEX', 'ARCHIVE_B64'
];
const CHAIN_COLUMNS = [
    'CHAIN', 'BLOCK_INDEX_CHECKPOINTED', 'BLOCK_HASH', 'LEDGER_HASH',
    'ACTIONS_HASH', 'CONTRACT_HASH', 'CHECKPOINT_SEQ', 'STATE_ROOT',
    'STATE_ROOT_VERSION', 'BLOCK_MERKLE_ROOT', 'BLOCK_MERKLE_VERSION'
];

function actionData(sectionCount = 3){
    return {
        FORMAT: 3,
        NETWORK: 'regtest',
        SNAPSHOT_BLOCK: '900',
        SECTION_COUNT: sectionCount,
        BLOCK_INDEX: 1234,
        PUBLISHER: 'a'.repeat(64),
        PUBLISHER_ATTESTATIONS: '[{"pubkey":"publisher"}]',
        STATUS: 'valid'
    };
}

function section(chain, index){
    return {
        FORMAT: 0,
        SECTION_INDEX: index,
        NETWORK: 'regtest',
        CHAIN: chain,
        BLOCK_INDEX_CHECKPOINTED: String(500 + index),
        BLOCK_HASH: String(index).repeat(64),
        LEDGER_HASH: '1'.repeat(64),
        ACTIONS_HASH: '2'.repeat(64),
        CONTRACT_HASH: '3'.repeat(64),
        CHECKPOINT_SEQ: String(index),
        SNAPSHOT_BLOCK: String(900 - index),
        STATE_ROOT: '4'.repeat(64),
        STATE_ROOT_VERSION: '1',
        BLOCK_MERKLE_ROOT: '5'.repeat(64),
        BLOCK_MERKLE_VERSION: '1',
        SIGS: [{ pubkey: chain + '-validator', sig: chain + '-signature' }]
    };
}

function archiveData(){
    return {
        WRAPPER_SECTION_INDEX: 1,
        MATCH_BATCH_SEQ: '72',
        MATCH_COUNT: '4',
        BATCH_CRC32: 'deadbeef',
        TOTAL_CHUNKS: '1',
        ARCHIVE_B64: 'archive_payload'
    };
}

function fixtures(){
    return {
        data: actionData(),
        sections: [section('BTC', 0), section('DOGE', 1), section('LTC', 2)],
        archive: archiveData(),
        wrapperSigs: [{ pubkey: 'wrapper-validator', sig: 'wrapper-signature' }]
    };
}

describe('ANCHOR v3 action rows', function () {
    it('puts three chain rows before one archive row', function () {
        const { data, sections, archive, wrapperSigs } = fixtures();
        const rows = foldActionRows(data, sections, archive, wrapperSigs);

        assert.strictEqual(rows.length, 4);
        assert.deepStrictEqual(rows.map(row => row.SECTION_INDEX), [0, 1, 2, 3]);
        assert.deepStrictEqual(rows.slice(0, 3).map(row => row.CHAIN), ['BTC', 'DOGE', 'LTC']);
        assert.strictEqual(rows[0].VALIDATOR_SIGNATURES, JSON.stringify(sections[0].SIGS));
        assert.strictEqual(rows[3].CHAIN, null);
        assert.strictEqual(rows[3].MATCH_BATCH_SEQ, archive.MATCH_BATCH_SEQ);
        assert.strictEqual(rows[3].VALIDATOR_SIGNATURES, JSON.stringify(wrapperSigs));
        assert.ok(!Object.hasOwn(rows[3], 'WRAPPER_SECTION_INDEX'));
    });

    it('makes every row archive-ineligible when no archive is present', function () {
        const { data, sections, wrapperSigs } = fixtures();
        const rows = foldActionRows(data, sections, null, wrapperSigs);

        assert.strictEqual(rows.length, 3);
        for(const row of rows){
            for(const column of ARCHIVE_COLUMNS) assert.strictEqual(row[column], null);
        }
    });

    it('allows an archive-only action at section index zero', function () {
        const data = actionData(0);
        const archive = archiveData();
        const wrapperSigs = [{ pubkey: 'wrapper', sig: 'signature' }];
        const rows = foldActionRows(data, [], archive, wrapperSigs);

        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].SECTION_INDEX, 0);
        assert.strictEqual(rows[0].CHUNK_INDEX, 0);
        assert.strictEqual(rows[0].VALIDATOR_SIGNATURES, JSON.stringify(wrapperSigs));
        for(const column of CHAIN_COLUMNS) assert.strictEqual(rows[0][column], null);
        for(const column of ARCHIVE_COLUMNS.filter(column => column !== 'CHUNK_INDEX'))
            assert.strictEqual(rows[0][column], archive[column]);
    });

    it('records one data-only row for a malformed action', function () {
        const data = actionData(0);
        const rows = foldActionRows(data, [], null, []);

        assert.deepStrictEqual(rows, [Object.assign({}, data, { SECTION_INDEX: 0 })]);
    });

    it('restores the action format after merging each section', function () {
        const { data, sections } = fixtures();
        const rows = foldActionRows(data, sections, null, []);

        assert.ok(sections.every(item => item.FORMAT === 0));
        assert.ok(rows.every(row => row.FORMAT === data.FORMAT));
        assert.ok(rows.every(row => !Object.hasOwn(row, 'SIGS')));
    });

    it('does not mutate any input', function () {
        const input = fixtures();
        const before = structuredClone(input);

        foldActionRows(input.data, input.sections, input.archive, input.wrapperSigs);

        assert.deepStrictEqual(input, before);
    });

    it('produces rows accepted by the database coercion boundary', function () {
        const { data, sections, archive, wrapperSigs } = fixtures();
        const rows = foldActionRows(data, sections, archive, wrapperSigs);
        const bound = rows.map(row => anchorActionRow(row, 1));

        assert.deepStrictEqual(bound.map(item => item.section_index), [0, 1, 2, 3]);
        assert.ok(bound.slice(0, 3).every(item => item.args[2] !== null));
        assert.strictEqual(bound[3].args[2], null);
        assert.ok(bound.slice(0, 3).every(item => item.args[15] === null));
        assert.strictEqual(bound[3].args[15], Number(archive.MATCH_BATCH_SEQ));
    });
});
