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
 *********************************************************************/

'use strict';

const assert = require('assert');

const protocolTime = require('../../../src/consensus/protocol_time.js');
const blocks       = require('../../../src/db/blocks/index.js');
const blockReads   = require('../../../src/db/database/block_reads.js');

describe('protocol time caller order', function () {

    it('reads previous timestamps in height-descending order and preserves that order', async function () {
        const newestFirstRows = [
            { block_time: 700 },
            { block_time: 900 },
            { block_time: 800 }
        ];
        const calls = [];
        const reader = {
            async doQueryStrict(query, params) {
                calls.push([query, params]);
                return newestFirstRows;
            }
        };

        const result = await blocks.getPreviousBlockTimes.call(
            reader, 101, protocolTime.MEDIAN_TIME_SPAN);

        assert.deepStrictEqual(result, [700, 900, 800]);
        assert.strictEqual(calls.length, 1);
        const [query, params] = calls[0];
        assert.match(query, /ORDER BY block_index DESC LIMIT \?/);
        assert.deepStrictEqual(params, [101, 11]);
    });

    it('requests exactly the consensus width from the real protocol-time caller', async function () {
        const calls = [];
        const reader = {
            config: { NETWORK: 'testnet' },
            async getRawBlockTime(blockIndex) {
                calls.push(['raw', blockIndex]);
                return 1200;
            },
            async getPreviousBlockTimes(blockIndex, span) {
                calls.push(['previous', blockIndex, span]);
                return [1100, 1000, 900, 800, 700, 600, 500, 400, 300, 200, 100];
            }
        };

        assert.strictEqual(
            await blockReads.protocolTimeForStoredBlock.call(reader, 101),
            600);
        assert.deepStrictEqual(calls, [
            ['raw', 101],
            ['previous', 101, protocolTime.MEDIAN_TIME_SPAN]
        ]);
        assert.strictEqual(protocolTime.MEDIAN_TIME_SPAN, 11);
    });
});
