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
 * Unit: a commit that finds no open transaction is a failure, never a commit
 */

'use strict';

const assert = require('assert');

const blockParseMethods = require('../../../src/XChainIndexer/block_parse');
const blockCommitMethods = require('../../../src/XChainIndexer/block_commit');
const blockFaultMethods = require('../../../src/XChainIndexer/block_faults');
const rollbackCommitMethods = require('../../../src/rollback/commit');

// An indexer whose block passes succeed and whose commit answers `commitResult`.
function makeIndexer(commitResult) {
    const seen = { rollbacks: 0, afterCommit: 0, logged: [] };
    const indexer = Object.assign({}, blockParseMethods, blockCommitMethods, blockFaultMethods, {
        config: { BLOCK_CHECK_INTERVAL: 6000 },
        stallReason: null,
        util: {
            withTimeout: promise => promise,
            logError: (msg, err) => { seen.logged.push(String(err && err.message)); }
        },
        indexerDb: {
            currentTxEpoch: () => 1,
            runInTxEpoch: (epoch, fn) => fn(),
            commitTransaction: async () => commitResult,
            rollbackTransaction: async () => { seen.rollbacks++; }
        },
        openBlockTransaction: async () => false,
        runBlockPasses: async () => [{}, {}, {}],
        afterBlockCommit: async (blk, results, lastDecoderBlock) => { seen.afterCommit++; return lastDecoderBlock; }
    });
    return { indexer, seen };
}

function runBlock(indexer) {
    return indexer.processBlock({ blockToParse: 43, blockTime: 1, rawBlockTime: 1, blockTransactions: [] },
                                42, 43, null);
}

describe('processBlock commit with no open block transaction', function () {
    it('abandons the block and skips every post-commit step when the commit reports false', async function () {
        const { indexer, seen } = makeIndexer(false);
        const result = await runBlock(indexer);
        assert.strictEqual(result.committed, false, 'a commit that found no transaction committed nothing');
        assert.strictEqual(result.stop, true, 'the pass stops so the loop retries the same block');
        assert.strictEqual(seen.afterCommit, 0, 'no tip push, hub delivery or cursor advance for an uncommitted block');
        assert.strictEqual(seen.rollbacks, 1, 'the block goes through the abandon path');
        assert.ok(seen.logged.some(m => /no open block transaction at commit/.test(m)), 'the fault names its cause');
    });

    it('treats a true or an undefined commit answer as committed', async function () {
        for (const answer of [true, undefined]) {
            const { indexer, seen } = makeIndexer(answer);
            const result = await runBlock(indexer);
            assert.strictEqual(result.committed, true, 'commit answer ' + answer);
            assert.strictEqual(seen.afterCommit, 1, 'commit answer ' + answer);
            assert.strictEqual(seen.rollbacks, 0, 'commit answer ' + answer);
        }
    });
});

describe('reorg commit with no open transaction', function () {
    it('throws before invalidating any cache when the commit reports false', async function () {
        let cleared = 0;
        const rollback = Object.assign({}, rollbackCommitMethods, {
            indexerDb: {
                commitTransaction: async () => false,
                clearBlockTimeCache: () => { cleared++; },
                _smtTickNameCache: new Map(),
                _smtAddressNameCache: new Map()
            },
            indexer: { stallReason: 'reorg_rollback' }
        });
        await assert.rejects(() => rollback.commitAndInvalidateCaches(), /no open transaction at commit/);
        assert.strictEqual(cleared, 0);
        assert.strictEqual(rollback.indexer.stallReason, 'reorg_rollback',
            'the in-progress marker is left for the unwind path, never cleared as if committed');
    });
});
