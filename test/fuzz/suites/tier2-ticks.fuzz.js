/**
 * Tier 2 Fuzz: Tick name handling
 *
 * Tests tick validation through the Issue handler and utility functions
 * with edge-case token names: reserved, invalid chars, boundary lengths.
 */

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fc = require('fast-check');
const sinon = require('sinon');
const { NUM_RUNS, createMockIndexer, createBaseData, createTokenInfo, makeFuzzActionsCtx } = require('../setup/harness');
const { validTick, reservedTick, invalidTick, anyTick, TICK_CHARACTERS, RESERVED_TICKS } = require('../generators/ticks');

describe('Tier 2 - Tick name handling @tier2', function () {
    this.timeout(0);
    let Issue, indexer, actionsCtx, handler, config;

    before(function () {
        Issue = require('../../../src/actions/issue.js');
        config = createMockIndexer().config;
    });

    beforeEach(function () {
        indexer = createMockIndexer();
        actionsCtx = makeFuzzActionsCtx(indexer);
        handler = new Issue(actionsCtx);

        // Default stubs for Issue handler
        indexer.indexerDb.getAddressBalances.resolves({ 1: '999999' });
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.getTickerId.resolves(1);
    });

    afterEach(function () {
        sinon.restore();
    });

    function makeIssueData(tick) {
        return createBaseData({
            ACTION: 'ISSUE',
            FORMAT: 0,
            TX_DATA: `ISSUE|0|${tick}|1000|100|0|Test token`,
        });
    }

    describe('validTick() generator self-tests', function () {
        it('all generated valid ticks contain only TICK_CHARACTERS', function () {
            fc.assert(fc.property(
                validTick(),
                (tick) => {
                    for (const ch of tick) {
                        assert.ok(TICK_CHARACTERS.includes(ch),
                            `Character '${ch}' (U+${ch.charCodeAt(0).toString(16)}) not in TICK_CHARACTERS`);
                    }
                }
            ), { numRuns: NUM_RUNS });
        });

        it('all generated valid ticks are 1-250 chars', function () {
            fc.assert(fc.property(
                validTick(),
                (tick) => {
                    assert.ok(tick.length >= 1 && tick.length <= 250,
                        `Tick length ${tick.length} out of range`);
                }
            ), { numRuns: NUM_RUNS });
        });

        it('no valid ticks start or end with period', function () {
            fc.assert(fc.property(
                validTick(),
                (tick) => {
                    assert.ok(!tick.startsWith('.'), 'Should not start with period');
                    assert.ok(!tick.endsWith('.'), 'Should not end with period');
                }
            ), { numRuns: NUM_RUNS });
        });
    });

    describe('Issue handler with fuzzed TICK field', function () {
        it('never throws for any tick value', function () {
            return fc.assert(fc.asyncProperty(
                anyTick(),
                async (tick) => {
                    const data = makeIssueData(tick);
                    const params = ['0', tick, '1000', '100', '0', 'Test'];
                    await handler.parse(params, data, null);
                }
            ), { numRuns: NUM_RUNS });
        });

        it('reserved ticks are rejected', function () {
            return fc.assert(fc.asyncProperty(
                reservedTick(),
                async (tick) => {
                    const data = makeIssueData(tick);
                    const params = ['0', tick, '1000', '100', '0', 'Reserved'];
                    await handler.parse(params, data, null);
                    assert.ok(
                        !data.STATUS || data.STATUS.startsWith('invalid'),
                        `Reserved tick '${tick}' should be rejected, got: ${data.STATUS}`
                    );
                }
            ), { numRuns: RESERVED_TICKS.length * 3 });
        });

        it('empty tick is rejected', async function () {
            const data = makeIssueData('');
            const params = ['0', '', '1000', '100', '0', 'Empty'];
            await handler.parse(params, data, null);
            assert.ok(data.STATUS.startsWith('invalid'), `Empty tick should be invalid, got: ${data.STATUS}`);
        });

        it('tick with leading period is rejected', async function () {
            const data = makeIssueData('.BADTICK');
            const params = ['0', '.BADTICK', '1000', '100', '0', 'Period'];
            await handler.parse(params, data, null);
            assert.ok(data.STATUS.startsWith('invalid'), `Leading period tick should be invalid, got: ${data.STATUS}`);
        });

        it('tick with trailing period is rejected', async function () {
            const data = makeIssueData('BADTICK.');
            const params = ['0', 'BADTICK.', '1000', '100', '0', 'Period'];
            await handler.parse(params, data, null);
            assert.ok(data.STATUS.startsWith('invalid'), `Trailing period tick should be invalid, got: ${data.STATUS}`);
        });
    });

    describe('setActionParams with fuzzed fieldFormats', function () {
        it('never throws for any formats object', function () {
            const util = indexer.util;
            fc.assert(fc.property(
                fc.dictionary(
                    fc.integer({ min: 0, max: 10 }).map(String),
                    fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 1, maxLength: 10 })
                        .map(arr => arr.join('|')),
                ),
                fc.array(fc.string({ minLength: 0, maxLength: 50 }), { minLength: 0, maxLength: 20 }),
                fc.integer({ min: 0, max: 10 }),
                (formats, params, version) => {
                    const data = {};
                    util.setActionParams(data, params, formats, version);
                }
            ), { numRuns: NUM_RUNS });
        });

        it('always sets every field in the format to a value or null', function () {
            const util = indexer.util;
            const formats = { 0: 'A|B|C', 1: 'A|B' };
            fc.assert(fc.property(
                fc.array(fc.string({ minLength: 0, maxLength: 30 }), { minLength: 0, maxLength: 10 }),
                (params) => {
                    const data = {};
                    util.setActionParams(data, params, formats, 0);
                    // All fields from all formats should be set
                    assert.ok('A' in data);
                    assert.ok('B' in data);
                    assert.ok('C' in data);
                }
            ), { numRuns: NUM_RUNS });
        });
    });
});
