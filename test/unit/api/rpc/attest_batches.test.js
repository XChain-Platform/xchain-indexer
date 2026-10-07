/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 **********************************************************************
 * Unit coverage for the getattestbatches federation read.
 ********************************************************************/

'use strict';

const assert = require('assert');
const sinon  = require('sinon');
const { DatabaseSync } = require('node:sqlite');

const observability = require('../../../../src/observability/index.js');
const batchHeads = require('../../../../src/db/attests/batch_heads.js');
// Take the head and continuation versions from the codec, as the reader does, so a codec
// version change moves the fixture and the assertions with it instead of pinning 5 and 6.
const abw = require('../../../../src/actions/attest/attest_batch_wire.js');
const HEAD = abw.ATTEST_BATCH_HEAD_VERSION;
const CONT = abw.ATTEST_BATCH_CONTINUATION_VERSION;
const { buildAttestBatchesRpc } = require('../../../../src/api/rpc/attest/attest_batches.js');
const { recordingView, fakeIndexer } = require('./helpers/fake_indexer.js');

function captureQuery(rows = []) {
    let seen = null;
    const self = {
        async doQuery(sql, params) {
            seen = { sql, params };
            return rows;
        }
    };
    return batchHeads.getCompleteAttestBatchesByWindowStart
        .call(self, 100, 200, 10)
        .then(result => ({ seen, result }));
}

function executableBatchReader() {
    const db = new DatabaseSync(':memory:');
    db.exec(`
        CREATE TABLE index_statuses (id INTEGER PRIMARY KEY, status TEXT NOT NULL);
        CREATE TABLE attests (
            action_index INTEGER PRIMARY KEY, version INTEGER NOT NULL, request_id TEXT NOT NULL,
            batch_window_start INTEGER, batch_window_end INTEGER, batch_row_count INTEGER,
            batch_total_chunks INTEGER, batch_crc32 TEXT, batch_chunk_index INTEGER,
            status_id INTEGER NOT NULL, block_index INTEGER NOT NULL
        );
        CREATE TABLE actions (action_index INTEGER PRIMARY KEY, source_id INTEGER, tx_index INTEGER);
        CREATE TABLE transactions (tx_index INTEGER PRIMARY KEY, tx_hash_id INTEGER);
        CREATE TABLE index_transactions (id INTEGER PRIMARY KEY, hash TEXT);
        INSERT INTO index_statuses VALUES
            (1, 'valid'),
            (2, 'invalid: ATTEST_BATCH (reassembly CRC mismatch) (stamped on batch completion)');
        INSERT INTO attests VALUES
            (10, ${HEAD}, 'single',     100, 200, 0, 1, '11111111', 0, 1, 7),
            (20, ${HEAD}, 'failed',     110, 210, 2, 1, '22222222', 0, 2, 8),
            (30, ${HEAD}, 'incomplete', 120, 220, 2, 2, '33333333', 0, 1, 9),
            (40, ${HEAD}, 'complete',   130, 230, 2, 2, '44444444', 0, 1, 10),
            (41, ${CONT}, 'complete',  NULL, NULL, NULL, 2, '44444444', 1, 1, 11);
        INSERT INTO actions VALUES
            (10, 1, 10), (20, 2, 20), (30, 3, 30), (40, 4, 40), (41, 4, 41);
        INSERT INTO transactions VALUES (10, 10), (20, 20), (30, 30), (40, 40), (41, 41);
        INSERT INTO index_transactions VALUES
            (10, 'single-tx'), (20, 'failed-tx'), (30, 'incomplete-tx'),
            (40, 'complete-tx'), (41, 'continuation-tx');
    `);
    return {
        db,
        reader: {
            async doQuery(sql, params) {
                return db.prepare(sql).all(...params);
            }
        }
    };
}

describe('JSON-RPC attest batch family @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('returns a valid single-wire head with its window, count, location and transaction', async function () {
        const row = {
            batch_window_start: '100', batch_window_end: 200n, batch_row_count: '0',
            action_index: 12n, block_index: '9', tx_hash: 'ab'.repeat(32)
        };
        const view = recordingView({ getCompleteAttestBatchesByWindowStart: [row] });
        const rpc = buildAttestBatchesRpc({ indexer: fakeIndexer({ view }) });
        const answer = await rpc.getattestbatches({ window_start_from: 100, window_start_to: 100 });

        assert.deepStrictEqual(answer, {
            batches: [{
                window_start: 100, window_end: 200, row_count: 0,
                action_index: 12, block_index: 9, tx_hash: 'ab'.repeat(32)
            }],
            truncated: false
        });
        assert.deepStrictEqual(view.calls[0],
            ['getCompleteAttestBatchesByWindowStart', 100, 100, 500]);
    });

    it('preserves database ordering and marks a full page truncated', async function () {
        const rows = [
            { batch_window_start: 100, batch_window_end: 200, batch_row_count: 2,
              action_index: 8, block_index: 10, tx_hash: 'aa' },
            { batch_window_start: 100, batch_window_end: 200, batch_row_count: 2,
              action_index: 9, block_index: 11, tx_hash: 'bb' },
            { batch_window_start: 200, batch_window_end: 300, batch_row_count: 1,
              action_index: 15, block_index: 12, tx_hash: 'cc' }
        ];
        const view = recordingView({ getCompleteAttestBatchesByWindowStart: rows.slice(0, 2) });
        const rpc = buildAttestBatchesRpc({ indexer: fakeIndexer({ view }) });
        const answer = await rpc.getattestbatches({ window_start_from: 100, window_start_to: 200, limit: 2 });

        assert.deepStrictEqual(answer.batches.map(b => [b.window_start, b.action_index]), [[100, 8], [100, 9]]);
        assert.strictEqual(answer.truncated, true);
    });

    it('answers every bad parameter set with an error and never throws', async function () {
        const rpc = buildAttestBatchesRpc({ indexer: fakeIndexer() });
        for (const body of [
            undefined, null, {},
            { window_start_from: -1, window_start_to: 2 },
            { window_start_from: 1.5, window_start_to: 2 },
            { window_start_from: 3, window_start_to: 2 },
            { window_start_from: 1, window_start_to: 2, limit: 0 },
            { window_start_from: 1, window_start_to: 2, limit: 'nope' }
        ]) {
            const answer = await rpc.getattestbatches(body);
            assert.strictEqual(typeof answer.error, 'string', JSON.stringify(body));
        }
    });

    it('answers database readiness and query failures as errors', async function () {
        const notReady = buildAttestBatchesRpc({ indexer: fakeIndexer({ indexerDb: null }) });
        assert.deepStrictEqual(await notReady.getattestbatches({ window_start_from: 1, window_start_to: 2 }),
            { error: 'indexer database not ready' });

        sinon.stub(observability.getLogger(), 'error');
        const view = recordingView({
            getCompleteAttestBatchesByWindowStart: async () => { throw new Error('query failed'); }
        });
        const rpc = buildAttestBatchesRpc({ indexer: fakeIndexer({ view }) });
        assert.deepStrictEqual(await rpc.getattestbatches({ window_start_from: 1, window_start_to: 2 }),
            { error: 'failed to look up attest batches' });
    });
});

describe('ATTEST batch federation reader @regression @tier1', function () {
    it('uses inclusive bounds and orders by window then action', async function () {
        const { seen } = await captureQuery();
        assert.match(seen.sql, /h\.batch_window_start BETWEEN \? AND \?/);
        assert.match(seen.sql, /ORDER BY h\.batch_window_start ASC, h\.action_index ASC/);
        assert.match(seen.sql, /LIMIT \?/);
        assert.deepStrictEqual(seen.params, [100, 200, 10]);
    });

    it('requires valid heads and complete publisher-scoped multi-wire batches', async function () {
        const { seen } = await captureQuery();
        assert.match(seen.sql, new RegExp('h\\.version = ' + HEAD + '\\b'),
            'a head is the codec head version, never a literal');
        assert.match(seen.sql, new RegExp('c\\.version IN \\(' + HEAD + ', ' + CONT + '\\)'),
            'a chunk slot is the codec head or continuation version, never a literal');
        assert.match(seen.sql, /hs\.status = 'valid'/);
        assert.match(seen.sql, /h\.batch_total_chunks = 1/,
            'a single-wire head is complete without continuations');
        assert.match(seen.sql, /ha\.source_id IS NOT NULL/,
            'a multi-wire head with no authenticated publisher fails closed');
        assert.match(seen.sql, /ca\.source_id = ha\.source_id/,
            'foreign continuations cannot complete another publisher\'s head');
        assert.match(seen.sql, /cs\.status = 'valid'/,
            'an invalid continuation cannot fill a slot');
        assert.match(seen.sql, /COUNT\(DISTINCT c\.batch_chunk_index\)/);
        assert.match(seen.sql, /c\.batch_total_chunks = h\.batch_total_chunks/);
        assert.match(seen.sql, /c\.batch_crc32 = h\.batch_crc32/);
        assert.match(seen.sql, /\) = h\.batch_total_chunks/,
            'every declared slot must be present before a multi-wire head is returned');
    });

    it('executes the reader and rejects a failure-stamped head and an incomplete head', async function () {
        const { db, reader } = executableBatchReader();
        try {
            const rows = await batchHeads.getCompleteAttestBatchesByWindowStart.call(reader, 100, 130, 10);
            assert.deepStrictEqual(rows.map(row => ({
                action_index: Number(row.action_index),
                row_count: Number(row.batch_row_count),
                tx_hash: row.tx_hash
            })), [
                { action_index: 10, row_count: 0, tx_hash: 'single-tx' },
                { action_index: 40, row_count: 2, tx_hash: 'complete-tx' }
            ]);
        } finally {
            db.close();
        }
    });
});
