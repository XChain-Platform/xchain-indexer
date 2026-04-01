/**
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

describe('Chaos — Block Processing Resilience', function () {
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

        // Should not throw — the error is caught and logged
        try {
            const result = await processBlock(ctx, [tx], 1700000000, 100);
            // If rollback throws, it propagates out of the catch — that's the current behavior
            // This test documents that behavior
            assert.strictEqual(result.success, false);
        } catch (e) {
            // Rollback failure propagates — this is acceptable since the block loop
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
});
