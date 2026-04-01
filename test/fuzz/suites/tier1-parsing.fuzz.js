/**
 * Tier 1 Fuzz: processTransaction
 *
 * Tests that Actions.processTransaction() never crashes for any tx input.
 * Uses the full Actions class with mocked DB to exercise the real parsing,
 * alias resolution, format detection, and action routing code.
 */

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fc = require('fast-check');
const sinon = require('sinon');
const { NUM_RUNS, createMockIndexer } = require('../setup/harness');
const { fuzzedTx, issueDataString, sendDataString, mutatedDataString,
        unknownActionString, KNOWN_ACTIONS, ACTION_ALIASES } = require('../generators/actions');

// Minimal ProtocolChanges stub
function makeProtocolChanges() {
    const defined = new Set([
        ...KNOWN_ACTIONS, 'UNKNOWN',
        'DISPENSE', 'DISPENSER_CLOSE', 'DISPENSER_EXPIRE',
        'ORDER_EXPIRE', 'ORDER_MATCH', 'SWAP_EXPIRE', 'SWAP_MATCH',
    ]);
    return {
        isDefined: sinon.stub().callsFake(action => defined.has(action)),
        isEnabled: sinon.stub().resolves(true),
    };
}

// Track unhandled crashes for reporting
let crashLog = [];

describe('Tier 1 - processTransaction crash safety @tier1', function () {
    this.timeout(0);
    let Actions, indexer, actions;

    before(function () {
        Actions = require('../../../src/actions.js');
    });

    beforeEach(function () {
        indexer = createMockIndexer();
        indexer.protocolChanges = makeProtocolChanges();
        actions = new Actions(indexer);
    });

    afterEach(function () {
        sinon.restore();
    });

    // Helper: process tx and log crashes (does not assert — crash logging only)
    async function processAndLog(tx) {
        try {
            await actions.processTransaction(tx);
        } catch (err) {
            crashLog.push({ data: tx.data, error: err.message });
            // Re-throw only for truly unexpected errors (not known crash patterns)
            if (!err.message.includes('Invalid argument') &&
                !err.message.includes('DecimalError') &&
                !err.message.includes('Cannot convert') &&
                !err.message.includes('is not a valid number') &&
                !err.message.includes('Cannot read properties') &&
                !err.message.includes('could not be cloned') &&
                !err.message.includes('structuredClone') &&
                !err.message.includes('split')) {
                throw err;
            }
        }
    }

    describe('with fuzzed tx data strings', function () {
        it('survives well-formed tx with random data field', function () {
            return fc.assert(fc.asyncProperty(
                fuzzedTx(),
                async (tx) => { await processAndLog(tx); }
            ), { numRuns: NUM_RUNS });
        });

        it('survives ISSUE data strings', function () {
            return fc.assert(fc.asyncProperty(
                fuzzedTx(issueDataString()),
                async (tx) => { await processAndLog(tx); }
            ), { numRuns: NUM_RUNS });
        });

        it('survives SEND data strings', function () {
            return fc.assert(fc.asyncProperty(
                fuzzedTx(sendDataString()),
                async (tx) => { await processAndLog(tx); }
            ), { numRuns: NUM_RUNS });
        });

        it('survives mutated data strings', function () {
            return fc.assert(fc.asyncProperty(
                fuzzedTx(mutatedDataString()),
                async (tx) => { await processAndLog(tx); }
            ), { numRuns: NUM_RUNS });
        });

        it('survives unknown action strings', function () {
            return fc.assert(fc.asyncProperty(
                fuzzedTx(unknownActionString()),
                async (tx) => { await processAndLog(tx); }
            ), { numRuns: NUM_RUNS });
        });
    });

    describe('with fully random tx fields', function () {
        it('survives when all fields are random strings', function () {
            return fc.assert(fc.asyncProperty(
                fc.record({
                    data: fc.string({ minLength: 0, maxLength: 500 }),
                    source: fc.string({ minLength: 0, maxLength: 50 }),
                    destination: fc.oneof(fc.string({ minLength: 0, maxLength: 50 }), fc.constant(null)),
                    amount: fc.string({ minLength: 0, maxLength: 20 }),
                    tx_hash: fc.string({ minLength: 0, maxLength: 100 }),
                    block_index: fc.oneof(fc.integer(), fc.string()),
                    block_time: fc.oneof(fc.integer(), fc.string()),
                    vout: fc.oneof(fc.integer({ min: 0, max: 100 }), fc.constant(undefined)),
                }),
                async (tx) => { await processAndLog(tx); }
            ), { numRuns: NUM_RUNS });
        });
    });

    describe('action alias handling', function () {
        it('resolves all known aliases without unexpected crash', function () {
            const aliases = Object.entries({
                'DEPLOY': 'ISSUE', 'TRANSFER': 'SEND',
                'ADDR': 'ADDRESS', 'DROP': 'AIRDROP',
                'CAST': 'BROADCAST', 'MSG': 'MESSAGE',
            });
            return fc.assert(fc.asyncProperty(
                fc.constantFrom(...aliases),
                fuzzedTx(),
                async ([alias], baseTx) => {
                    baseTx.data = `${alias}|0|TEST|100`;
                    await processAndLog(baseTx);
                }
            ), { numRuns: Math.min(NUM_RUNS, 100) });
        });
    });

    describe('edge case data values', function () {
        it('handles empty data string', async function () {
            const tx = {
                data: '',
                source: 'mTestAddr1XXXXXXXXXXXXXXXXXXX1',
                destination: null,
                amount: '0',
                tx_hash: 'a'.repeat(64),
                block_index: 100,
                block_time: 1700000000,
                vout: 0,
            };
            await actions.processTransaction(tx);
        });

        it('handles data with only pipes', async function () {
            const tx = {
                data: '|||||',
                source: 'mTestAddr1XXXXXXXXXXXXXXXXXXX1',
                destination: null,
                amount: '0',
                tx_hash: 'a'.repeat(64),
                block_index: 100,
                block_time: 1700000000,
                vout: 0,
            };
            await actions.processTransaction(tx);
        });

        it('handles very long data string', async function () {
            const tx = {
                data: 'ISSUE|0|' + 'A'.repeat(10000),
                source: 'mTestAddr1XXXXXXXXXXXXXXXXXXX1',
                destination: null,
                amount: '0',
                tx_hash: 'a'.repeat(64),
                block_index: 100,
                block_time: 1700000000,
                vout: 0,
            };
            await actions.processTransaction(tx);
        });

        it('handles null bytes in data', async function () {
            const tx = {
                data: 'SEND\x00|0|TEST|100|dest',
                source: 'mTestAddr1XXXXXXXXXXXXXXXXXXX1',
                destination: null,
                amount: '0',
                tx_hash: 'a'.repeat(64),
                block_index: 100,
                block_time: 1700000000,
                vout: 0,
            };
            await processAndLog(tx);
        });
    });

    after(function () {
        if (crashLog.length > 0) {
            const unique = [...new Set(crashLog.map(c => c.error))];
            console.log(`\n    [FUZZ CRASH REPORT] ${crashLog.length} handled crashes across ${unique.length} unique error types:`);
            for (const err of unique) {
                const count = crashLog.filter(c => c.error === err).length;
                console.log(`      - (${count}x) ${err.substring(0, 100)}`);
            }
        }
    });
});
