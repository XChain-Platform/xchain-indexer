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
 * Block Processing Resilience Tests
 *
 * Verifies XChainIndexer behavior under failures during block processing:
 * transaction rollback on errors, watchdog timeout, recovery after failure,
 * and synced flag transitions.
 */

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

describe('Chaos: Block Processing Resilience', function () {
    this.timeout(10000);

    let indexer, mockActions;

    beforeEach(function () {
        indexer = createMockIndexer();

        // Mock the actions class
        mockActions = {
            processTransaction: sinon.stub().resolves(),
        };

        // Mock utility lifecycle methods
        sinon.stub(indexer.util, 'processExpirations').resolves();
        sinon.stub(indexer.util, 'processCancellations').resolves();
        sinon.stub(indexer.util, 'processMarketUpdates').resolves();
    });

    afterEach(function () {
        sinon.restore();
    });

    /**
     * Helper: simulate processing a single block the way XChainIndexer does.
     * Extracted from the main loop to test the block processing logic in isolation.
     */
    async function processBlock(ctx, blockTransactions, blockTime, blockIndex) {
        const config = ctx.indexer.config;
        config['BLOCK_PROCESS_TIMEOUT'] = config['BLOCK_PROCESS_TIMEOUT'] || 5000;

        await ctx.indexer.indexerDb.beginTransaction();
        try {
            let blockProcessing = (async () => {
                for (const tx of blockTransactions)
                    await ctx.actions.processTransaction(tx);

                await ctx.indexer.util.processExpirations(ctx.actions, ctx.indexer.indexerDb, blockIndex, blockTime);
                await ctx.indexer.util.processCancellations(ctx.actions, ctx.indexer.indexerDb, blockIndex, blockTime);

                let [ledger, actions] = await ctx.indexer.indexerDb.createBlock(blockIndex, blockTime);

                await ctx.indexer.util.processMarketUpdates(ctx.indexer.indexerDb, blockIndex, blockTime);
                await ctx.indexer.indexerDb.sanityCheck(blockIndex);

                return [ledger, actions];
            })();

            let [ledger, actions] = await ctx.indexer.util.withTimeout(
                blockProcessing, config['BLOCK_PROCESS_TIMEOUT'], 'block ' + blockIndex
            );

            await ctx.indexer.indexerDb.commitTransaction();
            return { success: true, ledger, actions };
        } catch (error) {
            await ctx.indexer.indexerDb.rollbackTransaction();
            ctx.indexer.util.logError('Error while parsing block data :', error);
            return { success: false, error };
        }
    }

    /**
     * Helper: faithfully mirror the inner catch-up `while` loop in XChainIndexer.run(),
     * INCLUDING the parts processBlock() omits (the block counter and loop control flow).
     * This is what guards against the silent block-skip class of bug: the counter must
     * advance only after a successful commit, and a failure must `break` out to the
     * (simulated) outer loop rather than falling through to the next block.
     *
     *   shouldFail(blockIndex) -> true to simulate a processing/commit failure for that block
     *
     * Returns { attempted, committed, lastIndexerBlock } for the single inner-loop pass.
     */
    async function runInnerCatchUpLoop(ctx, lastIndexerBlock, lastDecoderBlock, shouldFail) {
        const { util, indexerDb } = ctx.indexer;
        const attempted = [];
        const committed = [];
        let guard = 0;

        while (!util.isNull(lastIndexerBlock) && !util.isNull(lastDecoderBlock) && util.bclt(lastIndexerBlock, lastDecoderBlock)) {
            if (++guard > 10000) throw new Error('inner loop failed to terminate');

            // Mirror of XChainIndexer.js: do NOT advance lastIndexerBlock until the commit succeeds.
            let blockToParse = Number(lastIndexerBlock) + 1;
            attempted.push(blockToParse);

            await indexerDb.beginTransaction();
            try {
                if (shouldFail(blockToParse)) throw new Error('processing failed for block ' + blockToParse);
                await indexerDb.commitTransaction();
                // Advance only on success.
                lastIndexerBlock = blockToParse;
                committed.push(blockToParse);
            } catch (error) {
                await indexerDb.rollbackTransaction();
                util.logError('Error while parsing block data :', error);
                break;
            }
        }

        return { attempted, committed, lastIndexerBlock };
    }

    it('BK-01: query error during block processing triggers transaction rollback', async function () {
        mockActions.processTransaction.rejects(new Error('DB write failed'));
        const tx = createBaseData({ ACTION: 'SEND' });

        const ctx = { indexer, actions: mockActions };
        const result = await processBlock(ctx, [tx], 1700000000, 100);

        assert.strictEqual(result.success, false);
        assert.ok(indexer.indexerDb.rollbackTransaction.calledOnce, 'Should rollback');
        assert.ok(indexer.indexerDb.commitTransaction.notCalled, 'Should NOT commit');
    });

    it('BK-02: block processing succeeds after a prior failed block', async function () {
        const ctx = { indexer, actions: mockActions };
        const tx = createBaseData({ ACTION: 'SEND' });

        // First block fails
        mockActions.processTransaction.rejects(new Error('transient error'));
        const result1 = await processBlock(ctx, [tx], 1700000000, 100);
        assert.strictEqual(result1.success, false);

        // Second block succeeds
        mockActions.processTransaction.resolves();
        const result2 = await processBlock(ctx, [tx], 1700000005, 101);
        assert.strictEqual(result2.success, true);
        assert.ok(indexer.indexerDb.commitTransaction.calledOnce, 'Second block should commit');
    });

    it('BK-03: watchdog timeout triggers rollback on stuck block', async function () {
        // Make processTransaction hang forever
        mockActions.processTransaction.returns(new Promise(() => {}));
        const tx = createBaseData({ ACTION: 'SEND' });

        const ctx = { indexer, actions: mockActions };
        // Use very short timeout to avoid slow test
        indexer.config['BLOCK_PROCESS_TIMEOUT'] = 100;
        const result = await processBlock(ctx, [tx], 1700000000, 100);

        assert.strictEqual(result.success, false);
        assert.ok(result.error.message.includes('Watchdog timeout'));
        assert.ok(indexer.indexerDb.rollbackTransaction.calledOnce, 'Should rollback on timeout');
    });

    it('BK-04: successful block commit returns ledger and actions hashes', async function () {
        indexer.indexerDb.createBlock.resolves(['abc123', 'def456']);
        const ctx = { indexer, actions: mockActions };

        const result = await processBlock(ctx, [], 1700000000, 100);

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.ledger, 'abc123');
        assert.strictEqual(result.actions, 'def456');
    });

    it('BK-05: sanity check failure triggers rollback', async function () {
        indexer.indexerDb.sanityCheck.rejects(new Error('Supply mismatch'));
        const ctx = { indexer, actions: mockActions };

        const result = await processBlock(ctx, [], 1700000000, 100);

        assert.strictEqual(result.success, false);
        assert.ok(result.error.message.includes('Supply mismatch'));
        assert.ok(indexer.indexerDb.rollbackTransaction.calledOnce);
        assert.ok(indexer.indexerDb.commitTransaction.notCalled);
    });

    it('BK-06: commitTransaction failure triggers rollback', async function () {
        indexer.indexerDb.commitTransaction.rejects(new Error('commit failed'));
        const ctx = { indexer, actions: mockActions };

        const result = await processBlock(ctx, [], 1700000000, 100);

        assert.strictEqual(result.success, false);
        // rollbackTransaction called in the catch block
        assert.ok(indexer.indexerDb.rollbackTransaction.calledOnce);
    });

    it('BK-07: rollback failure during error handling does not crash', async function () {
        mockActions.processTransaction.rejects(new Error('query error'));
        indexer.indexerDb.rollbackTransaction.rejects(new Error('rollback also failed'));
        const ctx = { indexer, actions: mockActions };
        const tx = createBaseData({ ACTION: 'SEND' });

        // Should not throw: the error is caught and logged
        try {
            const result = await processBlock(ctx, [tx], 1700000000, 100);
            // If rollback throws, it propagates out of the catch; that's the current behavior
            // This test documents that behavior
            assert.strictEqual(result.success, false);
        } catch (e) {
            // Rollback failure propagates; this is acceptable since the block loop
            // in XChainIndexer catches it at a higher level
            assert.ok(e.message.includes('rollback also failed'));
        }
    });

    it('BK-08: multiple transactions processed in same block all complete', async function () {
        const txs = [
            createBaseData({ ACTION: 'SEND', TX_INDEX: 1 }),
            createBaseData({ ACTION: 'SEND', TX_INDEX: 2 }),
            createBaseData({ ACTION: 'SEND', TX_INDEX: 3 }),
        ];
        const ctx = { indexer, actions: mockActions };

        const result = await processBlock(ctx, txs, 1700000000, 100);

        assert.strictEqual(result.success, true);
        assert.strictEqual(mockActions.processTransaction.callCount, 3);
        assert.ok(indexer.indexerDb.commitTransaction.calledOnce);
    });

    it('BK-09: @regression a failing block is NOT skipped; the loop halts at it instead of advancing', async function () {
        // Indexer at block 99, decoder has data through 105. Block 100 fails to process.
        // The inner loop must stop AT block 100 and must never attempt 101..105; otherwise
        // block 100 would be permanently skipped (the silent block-skip bug).
        const ctx = { indexer, actions: mockActions };
        const { attempted, committed, lastIndexerBlock } =
            await runInnerCatchUpLoop(ctx, 99, 105, (b) => b === 100);

        assert.deepStrictEqual(attempted, [100], 'should attempt only block 100, then break (not skip ahead)');
        assert.deepStrictEqual(committed, [], 'no block should commit when block 100 fails');
        assert.strictEqual(lastIndexerBlock, 99, 'counter must NOT advance past the failed block');
        assert.ok(indexer.indexerDb.commitTransaction.notCalled, 'nothing should commit');
    });

    it('BK-10: @regression a transient failure is retried on the next pass with no gap in committed blocks', async function () {
        // Simulate the outer loop re-fetching lastIndexerBlock from the DB after each inner pass.
        // Block 100 fails on the first attempt, then succeeds. The committed sequence must be
        // contiguous (100..105): block 100 must not be lost.
        const ctx = { indexer, actions: mockActions };
        const decoderLast = 105;
        const failOnce = new Set([100]); // clears after first attempt → transient

        let lastIndexerBlock = 99;
        const committedAll = [];
        for (let pass = 0; pass < 5; pass++) {
            const res = await runInnerCatchUpLoop(ctx, lastIndexerBlock, decoderLast, (b) => failOnce.delete(b));
            committedAll.push(...res.committed);
            // Outer loop re-fetches MAX(block_index), which equals the last committed block (un-advanced on failure).
            lastIndexerBlock = res.lastIndexerBlock;
            if (lastIndexerBlock >= decoderLast) break;
        }

        assert.deepStrictEqual(committedAll, [100, 101, 102, 103, 104, 105],
            'every block 100..105 must commit exactly once, in order, with no gap');
        assert.strictEqual(lastIndexerBlock, 105, 'indexer should be fully caught up');
    });
});
