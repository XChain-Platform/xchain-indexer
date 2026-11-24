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
 **********************************************************************
 * Unit: the "settled after watchdog" log line names only real watchdog aborts
 */

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const Utility = require('../../../src/utility.js');
const blockParseMethods = require('../../../src/XChainIndexer/block_parse');
const { getLogger } = require('../../../src/observability/index.js');

const LATE_LINE = 'settled after watchdog';

function makeIndexer(runBlockPasses, budgetMs) {
    const abandoned = [];
    const indexer = Object.assign({}, blockParseMethods, {
        config: { BLOCK_PROCESS_TIMEOUT: budgetMs, GENESIS_BLOCK: 0 },
        util: new Utility(),
        indexerDb: {
            currentTxEpoch: () => 1,
            runInTxEpoch: (epoch, fn) => fn(),
            commitTransaction: async () => true
        },
        openBlockTransaction: async () => false,
        runBlockPasses,
        afterBlockCommit: async (blk, result, lastDecoderBlock) => lastDecoderBlock,
        abandonBlock: async (error) => { abandoned.push(error); }
    });
    indexer.abandoned = abandoned;
    return indexer;
}

const blk = { blockToParse: 43, blockTime: 1, rawBlockTime: 1, blockTransactions: [] };
const tick = () => new Promise(resolve => setImmediate(resolve));

describe('abandoned block-processing promise log @regression @tier1', function () {
    let warns;
    let logger;
    let originalWarn;

    beforeEach(function () {
        logger = getLogger();
        originalWarn = logger.warn;
        warns = [];
        logger.warn = (msg) => { warns.push(String(msg)); };
    });
    afterEach(function () { logger.warn = originalWarn; });

    it('does not claim the watchdog when a pass rejects inside the budget', async function () {
        const failure = new Error('executor worker terminated externally (signal SIGKILL)');
        const indexer = makeIndexer(async () => { throw failure; }, 60000);

        const result = await indexer.processBlock(blk, 42, 43, null);
        await tick();

        assert.strictEqual(result.stop, true);
        assert.strictEqual(indexer.abandoned.length, 1);
        assert.strictEqual(indexer.abandoned[0], failure);
        assert.deepStrictEqual(warns.filter(w => w.includes(LATE_LINE)), []);
    });

    it('logs the late settlement when the watchdog fired first', async function () {
        let release;
        const gate = new Promise((resolve, reject) => { release = reject; });
        const indexer = makeIndexer(() => gate, 5);

        const result = await indexer.processBlock(blk, 42, 43, null);
        assert.strictEqual(result.stop, true);
        assert.strictEqual(indexer.abandoned.length, 1);
        assert.ok(/timeout/i.test(indexer.abandoned[0].message), indexer.abandoned[0].message);
        assert.deepStrictEqual(warns.filter(w => w.includes(LATE_LINE)), [],
            'nothing is logged while the abandoned promise is still pending');

        release(new Error('late zombie rejection'));
        await tick();

        const late = warns.filter(w => w.includes(LATE_LINE));
        assert.strictEqual(late.length, 1);
        assert.ok(late[0].includes('block 43'));
        assert.ok(late[0].includes('late zombie rejection'));
    });

    it('logs nothing for a block that commits', async function () {
        const indexer = makeIndexer(async () => [{}, [], []], 60000);

        const result = await indexer.processBlock(blk, 42, 43, null);
        await tick();

        assert.strictEqual(result.committed, true);
        assert.strictEqual(result.stop, false);
        assert.strictEqual(indexer.abandoned.length, 0);
        assert.deepStrictEqual(warns, []);
    });
});
