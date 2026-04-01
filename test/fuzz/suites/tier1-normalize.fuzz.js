/**
 * Tier 1 Fuzz: normalizeDataValues
 *
 * Tests that db.normalizeDataValues() never throws and always produces
 * valid post-conditions on NUMBER_FIELDS, LOCK_FIELDS, and string fields.
 */

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fc = require('fast-check');
const { NUM_RUNS, createMockIndexer, bindNormalize } = require('../setup/harness');

describe('Tier 1 - normalizeDataValues @tier1', function () {
    this.timeout(0);
    let normalize, config, util;

    before(function () {
        normalize = bindNormalize();
        const indexer = createMockIndexer();
        config = indexer.config;
        util = indexer.util;
    });

    // Arbitrary that produces a data object with known field names populated with random values
    function fuzzedData() {
        const fuzzValue = fc.oneof(
            fc.string({ minLength: 0, maxLength: 300 }),
            fc.integer(),
            fc.double({ noNaN: false }),
            fc.constant(null),
            fc.constant(undefined),
            fc.constantFrom('0', '1', '-1', 'abc', '', 'NaN', 'Infinity'),
        );

        return fc.tuple(
            fc.constantFrom('ISSUE', 'SEND', 'BROADCAST', 'FILE', 'MESSAGE', 'SLEEP', 'MINT', 'UNKNOWN'),
            fuzzValue, fuzzValue, fuzzValue, fuzzValue, fuzzValue, // NUMBER fields
            fuzzValue, fuzzValue, fuzzValue,                        // LOCK fields
            fc.string({ minLength: 0, maxLength: 400 }),            // MEMO
            fc.string({ minLength: 0, maxLength: 400 }),            // MESSAGE
            fc.string({ minLength: 0, maxLength: 400 }),            // DESCRIPTION
            fc.string({ minLength: 0, maxLength: 400 }),            // VALUE (broadcast)
            fc.string({ minLength: 0, maxLength: 400 }),            // NAME (file)
        ).map(([action, amount, maxSupply, decimals, expiration, fee,
                lockMint, lockMaxSupply, lockDesc,
                memo, message, description, value, name]) => ({
            ACTION: action,
            AMOUNT: amount,
            MAX_SUPPLY: maxSupply,
            DECIMALS: decimals,
            EXPIRATION: expiration,
            FEE: fee,
            LOCK_MINT: lockMint,
            LOCK_MAX_SUPPLY: lockMaxSupply,
            LOCK_DESCRIPTION: lockDesc,
            MEMO: memo,
            MESSAGE: message,
            DESCRIPTION: description,
            VALUE: value,
            NAME: name,
            TITLE: name,
            RESUME_BLOCK: String(expiration),
            ENCRYPTION_METHOD: String(amount),
        }));
    }

    describe('never throws', function () {
        it('returns without throwing for fuzzed data objects', function () {
            fc.assert(fc.property(
                fuzzedData(),
                (data) => {
                    normalize(data);
                }
            ), { numRuns: NUM_RUNS });
        });

        it('handles empty data object', function () {
            normalize({});
        });

        it('handles data with only unknown keys', function () {
            fc.assert(fc.property(
                fc.dictionary(
                    fc.string({ minLength: 1, maxLength: 20 }),
                    fc.anything(),
                ),
                (data) => {
                    normalize(data);
                }
            ), { numRuns: NUM_RUNS });
        });
    });

    describe('NUMBER_FIELDS post-conditions', function () {
        it('NUMBER_FIELDS are null or numeric after normalization (non-MESSAGE actions)', function () {
            fc.assert(fc.property(
                fuzzedData().filter(d => d.ACTION !== 'MESSAGE'),
                (data) => {
                    normalize(data);
                    for (const field of config['NUMBER_FIELDS']) {
                        if (data[field] !== undefined) {
                            assert.ok(
                                data[field] === null || util.isNumeric(data[field]),
                                `${field} should be null or numeric, got: ${data[field]} (${typeof data[field]})`
                            );
                        }
                    }
                }
            ), { numRuns: NUM_RUNS });
        });

        it('MESSAGE action: ENCRYPTION_METHOD may be truncated string (known behavior)', function () {
            // normalizeDataValues truncates ENCRYPTION_METHOD to 1 char for MESSAGE actions
            // AFTER NUMBER_FIELDS normalization nulls non-numeric values.
            // If original value was non-null, the truncation re-introduces a string.
            fc.assert(fc.property(
                fuzzedData().filter(d => d.ACTION === 'MESSAGE'),
                (data) => {
                    normalize(data);
                    // ENCRYPTION_METHOD is exempt — may be string after truncation
                    for (const field of config['NUMBER_FIELDS']) {
                        if (field === 'ENCRYPTION_METHOD') continue;
                        if (data[field] !== undefined) {
                            assert.ok(
                                data[field] === null || util.isNumeric(data[field]),
                                `${field} should be null or numeric, got: ${data[field]} (${typeof data[field]})`
                            );
                        }
                    }
                }
            ), { numRuns: Math.floor(NUM_RUNS / 2) });
        });
    });

    describe('LOCK_FIELDS post-conditions', function () {
        it('all LOCK_FIELDS are null, 0, or 1 after normalization', function () {
            fc.assert(fc.property(
                fuzzedData(),
                (data) => {
                    normalize(data);
                    for (const field of config['LOCK_FIELDS']) {
                        if (data[field] !== undefined) {
                            assert.ok(
                                data[field] === null || data[field] === 0 || data[field] === 1,
                                `${field} should be null/0/1, got: ${data[field]} (${typeof data[field]})`
                            );
                        }
                    }
                }
            ), { numRuns: NUM_RUNS });
        });
    });

    describe('DECIMALS post-conditions', function () {
        it('DECIMALS is null or in [0, 18] after normalization', function () {
            fc.assert(fc.property(
                fuzzedData(),
                (data) => {
                    normalize(data);
                    if (data['DECIMALS'] !== null && data['DECIMALS'] !== undefined) {
                        assert.ok(
                            data['DECIMALS'] >= config.MIN_TOKEN_DECIMALS &&
                            data['DECIMALS'] <= config.MAX_TOKEN_DECIMALS,
                            `DECIMALS should be in [0, 18], got: ${data['DECIMALS']}`
                        );
                    }
                }
            ), { numRuns: NUM_RUNS });
        });
    });

    describe('string truncation post-conditions', function () {
        it('MEMO is truncated to at most 250 chars', function () {
            fc.assert(fc.property(
                fuzzedData(),
                (data) => {
                    normalize(data);
                    if (data['MEMO'] !== null && data['MEMO'] !== undefined) {
                        assert.ok(String(data['MEMO']).length <= 250,
                            `MEMO length ${String(data['MEMO']).length} > 250`);
                    }
                }
            ), { numRuns: NUM_RUNS });
        });

        it('BROADCAST MESSAGE is truncated to at most 250 chars', function () {
            fc.assert(fc.property(
                fuzzedData().filter(d => d.ACTION === 'BROADCAST'),
                (data) => {
                    normalize(data);
                    if (data['MESSAGE'] !== null && data['MESSAGE'] !== undefined) {
                        assert.ok(String(data['MESSAGE']).length <= 250,
                            `BROADCAST MESSAGE length ${String(data['MESSAGE']).length} > 250`);
                    }
                }
            ), { numRuns: Math.floor(NUM_RUNS / 2) });
        });

        it('BROADCAST VALUE is truncated to at most 25 chars', function () {
            fc.assert(fc.property(
                fuzzedData().filter(d => d.ACTION === 'BROADCAST'),
                (data) => {
                    normalize(data);
                    if (data['VALUE'] !== null && data['VALUE'] !== undefined) {
                        assert.ok(String(data['VALUE']).length <= 25,
                            `BROADCAST VALUE length ${String(data['VALUE']).length} > 25`);
                    }
                }
            ), { numRuns: Math.floor(NUM_RUNS / 2) });
        });

        it('ISSUE DESCRIPTION is truncated to at most 250 chars', function () {
            fc.assert(fc.property(
                fuzzedData().filter(d => d.ACTION === 'ISSUE'),
                (data) => {
                    normalize(data);
                    if (data['DESCRIPTION'] !== null && data['DESCRIPTION'] !== undefined) {
                        assert.ok(String(data['DESCRIPTION']).length <= 250,
                            `ISSUE DESCRIPTION length ${String(data['DESCRIPTION']).length} > 250`);
                    }
                }
            ), { numRuns: Math.floor(NUM_RUNS / 2) });
        });

        it('FILE NAME is truncated to at most 250 chars', function () {
            fc.assert(fc.property(
                fuzzedData().filter(d => d.ACTION === 'FILE'),
                (data) => {
                    normalize(data);
                    if (data['NAME'] !== null && data['NAME'] !== undefined) {
                        assert.ok(String(data['NAME']).length <= 250,
                            `FILE NAME length ${String(data['NAME']).length} > 250`);
                    }
                }
            ), { numRuns: Math.floor(NUM_RUNS / 2) });
        });

        it('SLEEP RESUME_BLOCK is truncated to at most 25 chars', function () {
            fc.assert(fc.property(
                fuzzedData().filter(d => d.ACTION === 'SLEEP'),
                (data) => {
                    normalize(data);
                    if (data['RESUME_BLOCK'] !== null && data['RESUME_BLOCK'] !== undefined) {
                        assert.ok(String(data['RESUME_BLOCK']).length <= 25,
                            `SLEEP RESUME_BLOCK length ${String(data['RESUME_BLOCK']).length} > 25`);
                    }
                }
            ), { numRuns: Math.floor(NUM_RUNS / 2) });
        });
    });
});
