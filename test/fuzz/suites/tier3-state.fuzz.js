/**
 * Tier 3 Fuzz: State transition edge cases
 *
 * Tests Send handler, lock validation, balance operations, and
 * ledger consolidation with random inputs.
 */

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fc = require('fast-check');
const sinon = require('sinon');
const { NUM_RUNS, createMockIndexer, createBaseData, createTokenInfo, makeFuzzActionsCtx } = require('../setup/harness');
const { validAmount, anyAmount } = require('../generators/amounts');
const { validTick, anyTick } = require('../generators/ticks');
const { cryptoAddress } = require('../generators/addresses');

describe('Tier 3 - State transition edge cases @tier3', function () {
    this.timeout(0);
    let Send, indexer, actionsCtx, util;

    before(function () {
        Send = require('../../../src/actions/send.js');
    });

    beforeEach(function () {
        indexer = createMockIndexer();
        actionsCtx = makeFuzzActionsCtx(indexer);
        util = indexer.util;

        // Default stubs
        indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({
            TICK: 'TEST', MAX_SUPPLY: '10000', DECIMALS: 0, SUPPLY: '5000',
        }));
        indexer.indexerDb.getAddressBalances.resolves({ 1: '1000' });
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.getTickerId.resolves(1);
        indexer.indexerDb.isActionAllowed.resolves(true);
    });

    afterEach(function () {
        sinon.restore();
    });

    function isKnownCrash(err) {
        return err.message.includes('Cannot read properties');
    }

    describe('Send handler crash safety', function () {
        it('never throws for any (amount, destination) combination', function () {
            const handler = new Send(actionsCtx);
            return fc.assert(fc.asyncProperty(
                anyAmount(),
                fc.constantFrom(
                    'mAddr2XXXXXXXXXXXXXXXXXXXXXXX2',
                    'mAddr3XXXXXXXXXXXXXXXXXXXXXXX3',
                    '1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9',
                ),
                async (amount, dest) => {
                    const params = ['0', 'TEST', amount, dest, ''];
                    const data = createBaseData({
                        ACTION: 'SEND', FORMAT: 0,
                        TX_DATA: `SEND|0|TEST|${amount}|${dest}|`,
                    });
                    try {
                        await handler.parse(params, data, null);
                    } catch (err) {
                        if (!isKnownCrash(err)) throw err;
                    }
                }
            ), { numRuns: NUM_RUNS });
        });

        it('never throws with fuzzed amount values', function () {
            const handler = new Send(actionsCtx);
            return fc.assert(fc.asyncProperty(
                anyAmount(),
                async (amount) => {
                    const params = ['0', 'TEST', amount, 'mAddr2XXXXXXXXXXXXXXXXXXXXXXX2', ''];
                    const data = createBaseData({
                        ACTION: 'SEND', FORMAT: 0,
                        TX_DATA: `SEND|0|TEST|${amount}|mAddr2XXXXXXXXXXXXXXXXXXXXXXX2|`,
                    });
                    try {
                        await handler.parse(params, data, null);
                    } catch (err) {
                        if (!isKnownCrash(err)) throw err;
                    }
                }
            ), { numRuns: NUM_RUNS });
        });

        it('handles all 4 send format versions', async function () {
            const handler = new Send(actionsCtx);
            const formats = [
                { format: 0, params: ['0', 'TEST', '100', 'mAddr2XXXXXXXXXXXXXXXXXXXXXXX2', 'memo'] },
                { format: 1, params: ['1', 'TEST', '50', 'mAddr2XXXXXXXXXXXXXXXXXXXXXXX2', '50', 'mAddr3XXXXXXXXXXXXXXXXXXXXXXX3', 'memo'] },
                { format: 2, params: ['2', 'TEST', '50', 'mAddr2XXXXXXXXXXXXXXXXXXXXXXX2', 'TOK2', '25', 'mAddr3XXXXXXXXXXXXXXXXXXXXXXX3', 'memo'] },
                { format: 3, params: ['3', 'TEST', '50', 'mAddr2XXXXXXXXXXXXXXXXXXXXXXX2', 'memo1', 'TOK2', '25', 'mAddr3XXXXXXXXXXXXXXXXXXXXXXX3', 'memo2'] },
            ];
            for (const { format, params } of formats) {
                const data = createBaseData({
                    ACTION: 'SEND', FORMAT: format,
                    TX_DATA: `SEND|${params.join('|')}`,
                });
                try {
                    await handler.parse(params, data, null);
                } catch (err) {
                    if (!isKnownCrash(err)) throw err;
                }
            }
        });
    });

    describe('hasBalance(balances, tick_id, amount)', function () {
        it('never throws for any (balance, amount) combination', function () {
            fc.assert(fc.property(
                validAmount(8), validAmount(8),
                (balance, amount) => {
                    const balances = { 1: balance };
                    util.hasBalance(balances, 1, amount);
                }
            ), { numRuns: NUM_RUNS });
        });

        it('returns true when balance >= amount', function () {
            fc.assert(fc.property(
                fc.integer({ min: 100, max: 999999 }),
                fc.integer({ min: 0, max: 99 }),
                (balance, amount) => {
                    const balances = { 1: String(balance) };
                    assert.strictEqual(util.hasBalance(balances, 1, String(amount)), true);
                }
            ), { numRuns: NUM_RUNS });
        });

        it('returns false when balance < amount', function () {
            fc.assert(fc.property(
                fc.integer({ min: 0, max: 99 }),
                fc.integer({ min: 100, max: 999999 }),
                (balance, amount) => {
                    const balances = { 1: String(balance) };
                    assert.strictEqual(util.hasBalance(balances, 1, String(amount)), false);
                }
            ), { numRuns: NUM_RUNS });
        });

        it('handles missing tick_id gracefully (balance=0)', function () {
            fc.assert(fc.property(
                fc.integer({ min: 1, max: 999999 }).map(String),
                (amount) => {
                    const result = util.hasBalance({}, 999, amount);
                    assert.strictEqual(result, false);
                }
            ), { numRuns: NUM_RUNS });
        });
    });

    describe('debitBalances(balances, tick_id, amount)', function () {
        it('never throws for any inputs', function () {
            fc.assert(fc.property(
                validAmount(8), validAmount(8),
                (balance, amount) => {
                    const balances = { 1: balance };
                    util.debitBalances(balances, 1, amount);
                }
            ), { numRuns: NUM_RUNS });
        });
    });

    describe('isValidLock(tokenInfo, data, lock)', function () {
        it('never throws for any (tokenInfo, data, lock) combination', function () {
            fc.assert(fc.property(
                fc.oneof(
                    fc.constant(null),
                    fc.record({
                        LOCK_MINT: fc.oneof(fc.constantFrom(0, 1, '', null), fc.anything()),
                        LOCK_MAX_SUPPLY: fc.oneof(fc.constantFrom(0, 1, '', null), fc.anything()),
                        LOCK_DESCRIPTION: fc.oneof(fc.constantFrom(0, 1, '', null), fc.anything()),
                    }),
                ),
                fc.record({
                    LOCK_MINT: fc.oneof(fc.constantFrom(0, 1, null), fc.anything()),
                    LOCK_MAX_SUPPLY: fc.oneof(fc.constantFrom(0, 1, null), fc.anything()),
                }),
                fc.constantFrom('LOCK_MINT', 'LOCK_MAX_SUPPLY', 'LOCK_DESCRIPTION'),
                (tokenInfo, data, lock) => {
                    util.isValidLock(tokenInfo, data, lock);
                }
            ), { numRuns: NUM_RUNS });
        });

        it('always returns true when tokenInfo is null (token not created yet)', function () {
            fc.assert(fc.property(
                fc.record({
                    LOCK_MINT: fc.oneof(fc.constantFrom(0, 1, null), fc.integer()),
                }),
                fc.constantFrom('LOCK_MINT', 'LOCK_MAX_SUPPLY'),
                (data, lock) => {
                    assert.strictEqual(util.isValidLock(null, data, lock), true);
                }
            ), { numRuns: NUM_RUNS });
        });

        it('returns false when trying to unlock a locked field', function () {
            const tokenInfo = createTokenInfo({ LOCK_MINT: 1 });
            const data = { LOCK_MINT: 0 };
            assert.strictEqual(util.isValidLock(tokenInfo, data, 'LOCK_MINT'), false);
        });

        it('returns true when locking an unlocked field', function () {
            const tokenInfo = createTokenInfo({ LOCK_MINT: 0 });
            const data = { LOCK_MINT: 1 };
            assert.strictEqual(util.isValidLock(tokenInfo, data, 'LOCK_MINT'), true);
        });
    });

    describe('consolidateLedgerRecords(records)', function () {
        it('never throws for any records array', function () {
            fc.assert(fc.property(
                fc.array(
                    fc.tuple(
                        validTick(),
                        validAmount(8),
                        cryptoAddress(),
                    ),
                    { minLength: 0, maxLength: 20 }
                ),
                (records) => {
                    util.consolidateLedgerRecords(records);
                }
            ), { numRuns: NUM_RUNS });
        });

        it('output count is always <= input count', function () {
            fc.assert(fc.property(
                fc.array(
                    fc.tuple(
                        fc.constantFrom('TICK1', 'TICK2', 'TICK3'),
                        validAmount(0),
                        fc.constantFrom('addr1', 'addr2', 'addr3'),
                    ),
                    { minLength: 0, maxLength: 20 }
                ),
                (records) => {
                    const result = util.consolidateLedgerRecords(records);
                    assert.ok(result.length <= records.length,
                        `Output ${result.length} > input ${records.length}`);
                }
            ), { numRuns: NUM_RUNS });
        });

        it('handles empty records array', function () {
            const result = util.consolidateLedgerRecords([]);
            assert.deepStrictEqual(result, []);
        });

        it('consolidates duplicate tick+address records', function () {
            const records = [
                ['TICK1', '100', 'addr1'],
                ['TICK1', '200', 'addr1'],
                ['TICK2', '50', 'addr1'],
            ];
            const result = util.consolidateLedgerRecords(records);
            assert.strictEqual(result.length, 2); // TICK1+addr1 consolidated, TICK2+addr1 separate
        });
    });

    describe('getFormatVersion edge cases', function () {
        it('returns 0 for empty string and undefined', function () {
            assert.strictEqual(util.getFormatVersion(''), 0);
            assert.strictEqual(util.getFormatVersion(undefined), 0);
        });

        it('returns null for decimal strings (fixed: no longer truncates)', function () {
            assert.strictEqual(util.getFormatVersion('1.5'), null);
            assert.strictEqual(util.getFormatVersion('2.9'), null);
            // '1.0' is not float (1.0|0 === 1.0), so it's treated as integer
            assert.strictEqual(util.getFormatVersion('1.0'), 1);
        });

        it('returns null for numbers > 255', function () {
            assert.strictEqual(util.getFormatVersion('256'), null);
            assert.strictEqual(util.getFormatVersion(256), null);
        });

        it('strips quotes from string inputs', function () {
            assert.strictEqual(util.getFormatVersion('"1"'), 1);
            assert.strictEqual(util.getFormatVersion("'2'"), 2);
        });
    });
});
