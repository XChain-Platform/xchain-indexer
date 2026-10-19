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

const observability = require('../../../../src/observability/index.js');
const batchHeads = require('../../../../src/db/attests/batch_heads.js');
// Take the head and continuation versions from the codec, as the reader does, so a codec
// version change moves the fixture and the assertions with it instead of pinning 5 and 6.
const abw = require('../../../../src/actions/attest/attest_batch_wire.js');
const HEAD = abw.ATTEST_BATCH_HEAD_VERSION;
const CONT = abw.ATTEST_BATCH_CONTINUATION_VERSION;
const { buildAttestBatchesRpc } = require('../../../../src/api/rpc/attest/attest_batches.js');
const { recordingView, fakeIndexer } = require('./helpers/fake_indexer.js');
const { makeMigrationDb } = require('../../../helpers/sqlMigrationDb.js');

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
    const fixture = makeMigrationDb([
        'index_statuses.sql', 'attests.sql', 'actions.sql', 'transactions.sql', 'index_transactions.sql'
    ]);
    const { db, insert } = fixture;

    insert('index_statuses', { id: 1, status: 'valid' });
    insert('index_statuses', {
        id: 2, status: 'invalid: ATTEST_BATCH (reassembly CRC mismatch) (stamped on batch completion)'
    });

    const batch = (action_index, version, request_id, start, end, count, chunks, crc32, chunk, status_id, block_index) =>
        insert('attests', {
            action_index, version, request_id, provider_id: 'attest_batch',
            batch_window_start: start, batch_window_end: end, batch_row_count: count,
            batch_total_chunks: chunks, batch_crc32: crc32, batch_chunk_index: chunk,
            status_id, block_index
        });
    batch(10, HEAD, 'single',     100, 200, 0, 1, '11111111', 0, 1, 7);
    batch(20, HEAD, 'failed',     110, 210, 2, 1, '22222222', 0, 2, 8);
    batch(30, HEAD, 'incomplete', 120, 220, 2, 2, '33333333', 0, 1, 9);
    batch(40, HEAD, 'complete',   130, 230, 2, 2, '44444444', 0, 1, 10);
    batch(41, CONT, 'complete',  null, null, null, 2, '44444444', 1, 1, 11);

    const hashes = { 10: 'single-tx', 20: 'failed-tx', 30: 'incomplete-tx', 40: 'complete-tx', 41: 'continuation-tx' };
    const sources = { 10: 1, 20: 2, 30: 3, 40: 4, 41: 4 };
    for(const idx of Object.keys(hashes).map(Number)){
        insert('actions', { action_index: idx, block_index: 1, action_id: 1, source_id: sources[idx], tx_index: idx });
        insert('transactions', { tx_index: idx, block_index: 1, tx_hash_id: idx });
        insert('index_transactions', { id: idx, hash: hashes[idx] });
    }
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
