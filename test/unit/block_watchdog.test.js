/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Block-processing watchdog safety
 *
 * XChainIndexer wraps each block's processing in
 * `util.withTimeout(blockProcessing, BLOCK_PROCESS_TIMEOUT, 'block N')` (src/
 * XChainIndexer.js). If processing hangs (deadlock, pathological contract that burns
 * the CPU budget), the watchdog must REJECT so the surrounding catch fires: it rolls
 * back the block's writes and (crucially) does NOT advance `lastIndexerBlock` (that
 * assignment runs only after a successful commit), so the same block is retried on the
 * next loop rather than silently skipped. A watchdog that failed to reject would hang
 * the indexer on one block forever with no recovery path.
 *
 * This pins the watchdog primitive's three safety properties:
 *   1. fast block -> resolves with the real result (no false timeout)
 *   2. slow block -> rejects with a labeled "Watchdog timeout" error (fires rollback/retry)
 *   3. a block that throws (e.g. SanityError) -> its own rejection propagates (also
 *      rolls back; the timeout doesn't swallow real errors)
 *
 * Note: a timed-out block is retried, not skipped. By design this never silently drops a
 * block). The halt risk from a block that ALWAYS times out is mitigated upstream by the
 * VM's deterministic gas/CPU bounds + the BigInt/RegExp restriction (see xchain-vm
 * vmRestrict / native-dos suites), so no single EXECUTE can sit in this timeout.
 ********************************************************************/

const assert = require('assert');

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';
const Utility = require('../../src/utility.js');

describe('Block-processing watchdog (withTimeout) @regression @tier1', function () {
    let util;
    beforeEach(function () { util = new Utility(); });

    it('resolves with the block result when processing finishes within budget', async function () {
        const result = await util.withTimeout(Promise.resolve(['ledger', 'actions', 'contracts']), 100, 'block 5');
        assert.deepStrictEqual(result, ['ledger', 'actions', 'contracts']);
    });

    it('rejects with a labeled Watchdog timeout when processing exceeds the budget', async function () {
        const slow = new Promise((resolve) => setTimeout(() => resolve('too late'), 200));
        await assert.rejects(
            () => util.withTimeout(slow, 20, 'block 7'),
            (err) => {
                assert.match(err.message, /Watchdog timeout/);
                assert.match(err.message, /block 7/);          // names the stuck block for the log
                assert.match(err.message, /exceeded 20ms/);
                return true;
            }
        );
    });

    it('propagates a block-processing error (not just timeouts) so it still rolls back', async function () {
        const failing = Promise.reject(new Error('SanityError: supply mismatch'));
        await assert.rejects(
            () => util.withTimeout(failing, 1000, 'block 9'),
            /SanityError: supply mismatch/
        );
    });

    it('defaults the label to "operation" when none is given', async function () {
        const slow = new Promise((resolve) => setTimeout(resolve, 200));
        await assert.rejects(() => util.withTimeout(slow, 10), /Watchdog timeout: operation exceeded 10ms/);
    });
});
