/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN = process.env.INDEXER_COIN || 'DOGE';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const zlib = require('zlib');

const { createBaseData } = require('../../fixtures/mocks.js');
const gateRegistry = require('../../../src/consensus/gate_registry.js');
const { stubActiveAt } = require('../../helpers/gate_modules.js');
const { v3Params, vectors } = require('../actions/anchor/anchor.test/helpers/anchor_v3_fixtures.js');
const {
    PUBLISHER, armAnchor, crc32Hex
} = require('../actions/anchor/anchor.test/helpers/anchor_fixtures.js');

const FOLD_GATE = 'anchor_fold_activation.ANCHOR_FOLD_ACTIVATION';
const VERDICT_GATE =
    'archive_section_verdict_activation.ARCHIVE_SECTION_VERDICT_STATE_HASH_ACTIVATION';
const ACTION_INDEX = 41;
const BATCH_SEQ = 42;

function splitArchiveWire() {
    const json = JSON.stringify({ matches: Array.from({ length: 17 }, (_, id) => ({ id })) });
    const b64 = zlib.gzipSync(Buffer.from(json, 'utf8')).toString('base64url');
    const cut = Math.ceil(b64.length / 2);
    const params = v3Params();
    const crcIndex = params.indexOf(vectors.fixture.bundle_v3.batch_crc32);
    params[crcIndex] = crc32Hex(json);
    params[crcIndex + 1] = '2';
    params[crcIndex + 2] = b64.slice(0, cut);
    return { params, finalChunk: b64.slice(cut) };
}

function corrupt(chunk) {
    return (chunk[0] === 'A' ? 'B' : 'A') + chunk.slice(1);
}

function parentRow(rows) {
    const row = rows.find(candidate => candidate.ACTION_INDEX === ACTION_INDEX &&
        candidate.MATCH_BATCH_SEQ !== null);
    if (!row) return null;
    return {
        action_index: row.ACTION_INDEX,
        version: row.FORMAT,
        chain: 'BTC',
        block_index_doge: row.BLOCK_INDEX,
        match_batch_seq: row.MATCH_BATCH_SEQ,
        match_count: row.MATCH_COUNT,
        batch_crc32: row.BATCH_CRC32,
        total_chunks: row.TOTAL_CHUNKS,
        archive_b64: row.ARCHIVE_B64,
        source: row.SOURCE
    };
}

function installStore(indexer, rows) {
    const db = indexer.indexerDb;
    db.createAnchorAction.callsFake(async row => rows.push(Object.assign({}, row)));
    db.getAnchorV1ByBatchSeq.callsFake(async () => parentRow(rows));
    db.getAnchorChunks.callsFake(async () => rows
        .filter(row => row.FORMAT === 2 && row.STATUS === 'valid')
        .map(row => ({ chunk_index: row.CHUNK_INDEX, archive_b64: row.ARCHIVE_B64 })));
    db.setAnchorArchiveStatus = sinon.stub().callsFake(async (actionIndex, status) => {
        for (const row of rows)
            if (row.ACTION_INDEX === actionIndex) row.STATUS = status;
    });
    db.setAnchorArchiveRowStatus = sinon.stub().callsFake(async (actionIndex, status) => {
        for (const row of rows)
            if (row.ACTION_INDEX === actionIndex && row.MATCH_BATCH_SEQ !== null &&
                row.FORMAT !== 2) row.STATUS = status;
    });
}

async function runLateFailure(verdictActive) {
    const armed = armAnchor();
    const rows = [];
    installStore(armed.indexer, rows);
    stubActiveAt(sinon, FOLD_GATE, true);
    stubActiveAt(sinon, VERDICT_GATE, verdictActive);
    const wire = splitArchiveWire();
    const head = createBaseData({
        ACTION: 'ANCHOR', FORMAT: 3, COIN: 'DOGE', ACTION_INDEX, SOURCE: PUBLISHER
    });
    await armed.handler.parse(wire.params, head, null);
    const chunk = createBaseData({
        ACTION: 'ANCHOR', FORMAT: 2, COIN: 'DOGE', ACTION_INDEX: 42,
        BLOCK_INDEX: 101, SOURCE: PUBLISHER
    });
    await armed.handler.parse(
        ['2', String(BATCH_SEQ), '1', '2', corrupt(wire.finalChunk)], chunk, null);
    return { armed, rows, head, chunk };
}

function foldedRows(rows) {
    return rows.filter(row => row.ACTION_INDEX === ACTION_INDEX)
        .sort((a, b) => a.SECTION_INDEX - b.SECTION_INDEX);
}

describe('ANCHOR archive section verdict integration', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('keeps consumed checkpoint sections valid after a late folded archive failure', async function () {
        const result = await runLateFailure(true);
        const rows = foldedRows(result.rows);

        assert.strictEqual(result.head.STATUS, 'valid');
        assert.strictEqual(result.chunk.STATUS, 'valid');
        assert.deepStrictEqual(rows.map(row => row.STATUS),
            ['valid', 'valid', 'valid', 'invalid_archive']);
        assert.ok(rows.slice(0, 3).every(row => row.MATCH_BATCH_SEQ === null));
        assert.strictEqual(rows[3].MATCH_BATCH_SEQ, String(BATCH_SEQ));
        sinon.assert.calledOnceWithExactly(
            result.armed.indexer.indexerDb.setAnchorArchiveRowStatus,
            ACTION_INDEX, 'invalid_archive');
        sinon.assert.notCalled(result.armed.indexer.indexerDb.setAnchorArchiveStatus);
    });

    it('preserves the action-wide verdict before the section verdict activation', async function () {
        const result = await runLateFailure(false);
        const rows = foldedRows(result.rows);

        assert.deepStrictEqual(rows.map(row => row.STATUS),
            ['invalid_archive', 'invalid_archive', 'invalid_archive', 'invalid_archive']);
        sinon.assert.calledOnceWithExactly(
            result.armed.indexer.indexerDb.setAnchorArchiveStatus,
            ACTION_INDEX, 'invalid_archive');
        sinon.assert.notCalled(result.armed.indexer.indexerDb.setAnchorArchiveRowStatus);
        assert.ok(gateRegistry.activeAt.calledWith(
            VERDICT_GATE, 'regtest', null, 100, null));
    });
});
