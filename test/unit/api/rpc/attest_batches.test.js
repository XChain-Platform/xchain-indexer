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
const { buildAttestBatchesRpc } = require('../../../../src/api/rpc/attest_batches.js');
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
        .call(self, 'valid', 100, 200, 10)
        .then(result => ({ seen, result }));
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
            ['getCompleteAttestBatchesByWindowStart', 'valid', 100, 100, 500]);
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
        assert.deepStrictEqual(seen.params, ['valid', 100, 200, 'valid', 10]);
    });

    it('excludes invalid heads and incomplete or foreign multi-wire batches', async function () {
        const { seen } = await captureQuery();
        assert.match(seen.sql, /h\.version = 5/);
        assert.match(seen.sql, /hs\.status = \?/);
        assert.match(seen.sql, /h\.batch_total_chunks = 1/,
            'a single-wire head is complete without continuations');
        assert.match(seen.sql, /ha\.source_id IS NOT NULL/,
            'a multi-wire head with no authenticated publisher fails closed');
        assert.match(seen.sql, /ca\.source_id = ha\.source_id/,
            'foreign continuations cannot complete another publisher\'s head');
        assert.match(seen.sql, /cs\.status = \?/,
            'an invalid continuation cannot fill a slot');
        assert.match(seen.sql, /COUNT\(DISTINCT c\.batch_chunk_index\)/);
        assert.match(seen.sql, /c\.batch_total_chunks = h\.batch_total_chunks/);
        assert.match(seen.sql, /c\.batch_crc32 = h\.batch_crc32/);
        assert.match(seen.sql, /\) = h\.batch_total_chunks/,
            'every declared slot must be present before a multi-wire head is returned');
    });
});
