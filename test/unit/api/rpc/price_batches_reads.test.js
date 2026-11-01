/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 **********************************************************************
 * Read-count regression coverage for getpricebatches. A page is allowed
 * one indexer tip read, one indexer batch read and one decoder time read,
 * regardless of how many distinct landing blocks the page contains.
 ********************************************************************/

'use strict';

const assert = require('assert');

const { buildPriceBatchesRpc } = require('../../../../src/api/rpc/price_batches.js');
const blockReadsMixin = require('../../../../src/db/database/block_reads.js');
const timeWindowsMixin = require('../../../../src/db/blocks/time_windows.js');
const { recordingView, fakeIndexer } = require('./helpers/fake_indexer.js');

function batchRows(count) {
    return Array.from({ length: count }, (_, i) => ({
        action_index: 1000 + i,
        batch_first_round: 2000 + (i * 2),
        batch_last_round: 2001 + (i * 2),
        round_count: 2,
        block_index: 3000 + i
    }));
}

function fixture(count) {
    const rows = batchRows(count);
    const view = recordingView({
        getLatestBlockIndex: 4000,
        getPriceBatchesOverlappingRange: rows
    });
    const timeFor = (blockIndex) => 1700000000 + Number(blockIndex);
    const decoderView = recordingView({
        protocolTimesForStoredBlocks: (blockIndexes) =>
            new Map(blockIndexes.map(blockIndex => [blockIndex, timeFor(blockIndex)])),
        // This accessor makes the unfixed route measurable: it records one read
        // for every distinct landing block instead of one read for the whole page.
        protocolTimeForStoredBlock: timeFor
    });
    const rpc = buildPriceBatchesRpc({ indexer: fakeIndexer({ view, decoderView }) });
    return { rpc, view, decoderView };
}

describe('getpricebatches decoder read count @regression @tier1', function () {
    for (const count of [2, 20]) {
        it('keeps database reads constant for ' + count + ' batches', async function () {
            const { rpc, view, decoderView } = fixture(count);
            const response = await rpc.getpricebatches({
                first_round: 2000,
                last_round: 2100,
                limit: 100
            });

            assert.strictEqual(response.batches.length, count);
            assert.strictEqual(view.calls.length, 2, 'indexer reads must stay at two');
            assert.strictEqual(decoderView.calls.length, 1, 'decoder reads must stay at one');
            assert.strictEqual(decoderView.calls[0][0], 'protocolTimesForStoredBlocks');
        });
    }

    it('preserves the response shape and values for a fixed fixture', async function () {
        const { rpc } = fixture(2);
        const response = await rpc.getpricebatches({
            first_round: 2000,
            last_round: 2100,
            limit: 100
        });

        assert.deepStrictEqual(response, {
            block_index: 4000,
            first_round: 2000,
            last_round: 2100,
            batches: [
                { action_index: 1000, first_round: 2000, last_round: 2001,
                  round_count: 2, block_index: 3000, block_time: 1700003000 },
                { action_index: 1001, first_round: 2002, last_round: 2003,
                  round_count: 2, block_index: 3001, block_time: 1700003001 }
            ],
            truncated: false
        });
    });
});

describe('bulk decoder protocol-time read', function () {
    it('builds one strict statement for every requested landing block', async function () {
        const calls = [];
        const self = {
            async doQueryStrict(sql, params) {
                calls.push({ sql, params });
                return [];
            }
        };
        await timeWindowsMixin.getStoredBlockTimeWindows.call(self, [20, 30], 11);

        assert.strictEqual(calls.length, 1);
        assert.strictEqual((calls[0].sql.match(/UNION ALL/g) || []).length, 1);
        assert.strictEqual((calls[0].sql.match(/LIMIT 12/g) || []).length, 2);
        assert.deepStrictEqual(calls[0].params, [20, 20, 20, 30, 30, 30]);
    });

    it('computes each testnet median from the bulk rows in memory', async function () {
        const calls = [];
        const rows = [];
        for (const requested of [20, 30]) {
            for (let block = requested; block >= requested - 11; block--) {
                rows.push({
                    requested_block_index: requested,
                    block_index: block,
                    block_time: block * 10
                });
            }
        }
        const self = {
            config: { NETWORK: 'testnet' },
            async getStoredBlockTimeWindows(blockIndexes, span) {
                calls.push([blockIndexes, span]);
                return rows;
            }
        };
        const times = await blockReadsMixin.protocolTimesForStoredBlocks.call(self, [20, 30]);

        assert.deepStrictEqual(calls, [[[20, 30], 11]]);
        assert.deepStrictEqual(Array.from(times), [[20, 140], [30, 240]]);
    });

    it('requests only landing rows on a raw-time network', async function () {
        const calls = [];
        const self = {
            config: { NETWORK: 'regtest' },
            async getStoredBlockTimeWindows(blockIndexes, span) {
                calls.push([blockIndexes, span]);
                return blockIndexes.map(blockIndex => ({
                    requested_block_index: blockIndex,
                    block_index: blockIndex,
                    block_time: 1700000000 + blockIndex
                }));
            }
        };
        const times = await blockReadsMixin.protocolTimesForStoredBlocks.call(self, [20, 30]);

        assert.deepStrictEqual(calls, [[[20, 30], 0]]);
        assert.deepStrictEqual(Array.from(times), [[20, 1700000020], [30, 1700000030]]);
    });
});
