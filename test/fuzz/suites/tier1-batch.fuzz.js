/**
 * Tier 1 Fuzz: BATCH handler
 *
 * Tests that Batch.parse() never crashes and enforces structural invariants
 * (no nested batches, action limits) for any input.
 */

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fc = require('fast-check');
const sinon = require('sinon');
const { NUM_RUNS, createMockIndexer, createBaseData, makeFuzzActionsCtx } = require('../setup/harness');
const { batchDataString, issueDataString, sendDataString } = require('../generators/actions');

describe('Tier 1 - BATCH handler @tier1', function () {
    this.timeout(0);
    let Batch, indexer, actionsCtx, handler;

    before(function () {
        Batch = require('../../../src/actions/batch.js');
    });

    beforeEach(function () {
        indexer = createMockIndexer();
        actionsCtx = makeFuzzActionsCtx(indexer);
        handler = new Batch(actionsCtx);
    });

    afterEach(function () {
        sinon.restore();
    });

    function makeData(txData, overrides = {}) {
        return createBaseData({
            ACTION: 'BATCH',
            FORMAT: 0,
            TX_DATA: txData,
            ...overrides,
        });
    }

    describe('never throws for fuzzed BATCH inputs', function () {
        it('handles grammar-based batch data strings', function () {
            return fc.assert(fc.asyncProperty(
                batchDataString(),
                async (txData) => {
                    const data = makeData(txData);
                    const params = txData.split('|').slice(1); // remove BATCH
                    await handler.parse(params, data, null);
                }
            ), { numRuns: NUM_RUNS });
        });

        it('handles empty command (single semicolon)', async function () {
            const data = makeData('BATCH|0|');
            await handler.parse(['0', ''], data, null);
        });

        it('handles deeply fuzzed TX_DATA', function () {
            return fc.assert(fc.asyncProperty(
                fc.string({ minLength: 0, maxLength: 500 }),
                async (txData) => {
                    const fullData = 'BATCH|0|' + txData;
                    const data = makeData(fullData);
                    await handler.parse(['0', txData], data, null);
                }
            ), { numRuns: NUM_RUNS });
        });

        it('handles huge number of semicolons (many commands)', function () {
            return fc.assert(fc.asyncProperty(
                fc.integer({ min: 50, max: 200 }),
                async (count) => {
                    const cmds = Array(count).fill('SEND|0|TEST|1|addr').join(';');
                    const fullData = 'BATCH|0|' + cmds;
                    const data = makeData(fullData);
                    await handler.parse(['0', cmds], data, null);
                }
            ), { numRuns: 20 }); // fewer runs — each iteration is expensive
        });
    });

    describe('structural invariants', function () {
        it('createBatch is always called exactly once', function () {
            return fc.assert(fc.asyncProperty(
                batchDataString(),
                async (txData) => {
                    const data = makeData(txData);
                    const params = txData.split('|').slice(1);
                    await handler.parse(params, data, null);
                    assert.strictEqual(
                        indexer.indexerDb.createBatch.callCount, 1,
                        'createBatch must be called exactly once'
                    );
                    // Reset for next iteration
                    indexer.indexerDb.createBatch.resetHistory();
                    actionsCtx.processAction.resetHistory();
                }
            ), { numRuns: NUM_RUNS });
        });

        it('processAction is never called when error is pre-set', function () {
            return fc.assert(fc.asyncProperty(
                batchDataString(),
                async (txData) => {
                    const data = makeData(txData);
                    const params = txData.split('|').slice(1);
                    await handler.parse(params, data, 'pre-existing error');
                    assert.strictEqual(
                        actionsCtx.processAction.callCount, 0,
                        'processAction must not be called when error is pre-set'
                    );
                    indexer.indexerDb.createBatch.resetHistory();
                    actionsCtx.processAction.resetHistory();
                }
            ), { numRuns: NUM_RUNS });
        });

        it('nested BATCH is rejected (actionLimits)', async function () {
            const txData = 'BATCH|0|BATCH|0|SEND|0|TEST|1|addr';
            const data = makeData(txData);
            await handler.parse(['0', 'BATCH|0|SEND|0|TEST|1|addr'], data, null);
            assert.ok(
                data.STATUS.startsWith('invalid'),
                `Nested BATCH should be rejected, got: ${data.STATUS}`
            );
        });

        it('multiple ISSUE actions are rejected (limit=1)', async function () {
            const txData = 'BATCH|0|ISSUE|0|TOK1|1000|100|0|desc;ISSUE|0|TOK2|2000|200|0|desc2';
            const data = makeData(txData);
            await handler.parse(['0', 'ISSUE|0|TOK1|1000|100|0|desc;ISSUE|0|TOK2|2000|200|0|desc2'], data, null);
            assert.ok(
                data.STATUS.startsWith('invalid'),
                `Multiple ISSUE should be rejected, got: ${data.STATUS}`
            );
        });

        it('multiple MINT actions are rejected (limit=1)', async function () {
            const txData = 'BATCH|0|MINT|0|TOK1|50;MINT|0|TOK1|50';
            const data = makeData(txData);
            await handler.parse(['0', 'MINT|0|TOK1|50;MINT|0|TOK1|50'], data, null);
            assert.ok(
                data.STATUS.startsWith('invalid'),
                `Multiple MINT should be rejected, got: ${data.STATUS}`
            );
        });
    });

    describe('format edge cases', function () {
        it('unknown format sets error status', async function () {
            const data = makeData('BATCH|99|SEND|0|TEST|1|addr');
            data.FORMAT = 99;
            await handler.parse(['99', 'SEND|0|TEST|1|addr'], data, null);
            assert.ok(
                data.STATUS.startsWith('invalid'),
                `Unknown format should be rejected, got: ${data.STATUS}`
            );
        });

        it('null format sets error status', async function () {
            const data = makeData('BATCH||SEND|0|TEST|1|addr');
            data.FORMAT = null;
            await handler.parse([null, 'SEND|0|TEST|1|addr'], data, null);
            assert.ok(
                data.STATUS.startsWith('invalid'),
                `Null format should be rejected, got: ${data.STATUS}`
            );
        });
    });
});
