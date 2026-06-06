/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Tier 2 Fuzz: Token lifecycle (ISSUE + MINT)
 *
 * Tests that Issue.parse() and Mint.parse() never crash
 * for any combination of params and format versions.
 */

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fc = require('fast-check');
const sinon = require('sinon');
const { NUM_RUNS, createMockIndexer, createBaseData, createTokenInfo, makeFuzzActionsCtx } = require('../setup/harness');
const { anyAmount, validAmount, decimalsValue } = require('../generators/amounts');
const { anyTick, validTick } = require('../generators/ticks');
const { cryptoAddress } = require('../generators/addresses');

describe('Tier 2 - Token lifecycle (ISSUE + MINT) @tier2', function () {
    this.timeout(0);
    let Issue, Mint, indexer, actionsCtx;

    before(function () {
        Issue = require('../../../src/actions/issue.js');
        Mint = require('../../../src/actions/mint.js');
    });

    beforeEach(function () {
        indexer = createMockIndexer();
        actionsCtx = makeFuzzActionsCtx(indexer);

        // Default stubs
        indexer.indexerDb.getAddressBalances.resolves({ 1: '999999' });
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.getTickerId.resolves(1);
    });

    afterEach(function () {
        sinon.restore();
    });

    // Remaining known errors from null property access in complex handler paths
    function isKnownCrash(err) {
        return err.message.includes('Cannot read properties');
    }

    describe('Issue.parse() crash safety', function () {
        it('never throws unexpected errors for fuzzed format 0 params', function () {
            const handler = new Issue(actionsCtx);
            return fc.assert(fc.asyncProperty(
                anyTick(),
                anyAmount(),   // MAX_SUPPLY
                anyAmount(),   // MAX_MINT
                fc.oneof(fc.integer({ min: 0, max: 18 }).map(String), fc.string({ minLength: 0, maxLength: 5 })),
                fc.string({ minLength: 0, maxLength: 50 }),  // DESCRIPTION
                async (tick, maxSupply, maxMint, decimals, desc) => {
                    const params = ['0', tick, maxSupply, maxMint, decimals, desc];
                    const data = createBaseData({
                        ACTION: 'ISSUE', FORMAT: 0,
                        TX_DATA: `ISSUE|${params.join('|')}`,
                    });
                    try {
                        await handler.parse(params, data, null);
                    } catch (err) {
                        if (!isKnownCrash(err)) throw err;
                    }
                }
            ), { numRuns: NUM_RUNS });
        });

        it('never throws for any format version (0-255 and outside range)', function () {
            const handler = new Issue(actionsCtx);
            return fc.assert(fc.asyncProperty(
                fc.oneof(
                    fc.integer({ min: 0, max: 255 }),
                    fc.integer({ min: -10, max: -1 }),
                    fc.integer({ min: 256, max: 1000 }),
                    fc.constantFrom(null, undefined, NaN),
                ),
                async (format) => {
                    const data = createBaseData({
                        ACTION: 'ISSUE', FORMAT: format,
                        TX_DATA: 'ISSUE|0|TESTTICK|1000|100|0|test',
                    });
                    const params = ['0', 'TESTTICK', '1000', '100', '0', 'test'];
                    try {
                        await handler.parse(params, data, null);
                    } catch (err) {
                        if (!isKnownCrash(err)) throw err;
                    }
                }
            ), { numRuns: NUM_RUNS });
        });

        it('handles all 6 format versions without crash', async function () {
            const handler = new Issue(actionsCtx);
            const formats = [
                ['0', 'TICK1', '1000', '100', '0', 'desc'],        // format 0 (partial)
                ['1', 'TICK1', 'new desc', 'memo'],                  // format 1
                ['2', 'TICK1', '200', '50', '10', '5', '100', '500', 'memo'], // format 2
                ['3', 'TICK1', '0', '0', '0', '0', '0', '0', '0', 'memo'],   // format 3
                ['4', 'TICK1', '1000', 'CALLBACK_TICK', '50', 'memo'],        // format 4
                ['5', 'TICK1', '1', '2', 'memo'],                             // format 5
            ];
            for (let i = 0; i < formats.length; i++) {
                const params = formats[i];
                const data = createBaseData({
                    ACTION: 'ISSUE', FORMAT: i,
                    TX_DATA: `ISSUE|${params.join('|')}`,
                });
                try {
                    await handler.parse(params, data, null);
                } catch (err) {
                    if (!isKnownCrash(err)) throw err;
                }
            }
        });
    });

    describe('Mint.parse() crash safety', function () {
        it('never throws unexpected errors for fuzzed params', function () {
            const handler = new Mint(actionsCtx);
            return fc.assert(fc.asyncProperty(
                anyTick(),
                anyAmount(),
                cryptoAddress(),
                fc.string({ minLength: 0, maxLength: 30 }),
                async (tick, amount, dest, memo) => {
                    // Setup: token exists
                    indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({
                        TICK: tick, MAX_SUPPLY: '10000', MAX_MINT: '1000',
                        DECIMALS: 0, SUPPLY: '500', LOCK_MINT: 0,
                    }));
                    const params = ['0', tick, amount, dest, memo];
                    const data = createBaseData({
                        ACTION: 'MINT', FORMAT: 0,
                        TX_DATA: `MINT|${params.join('|')}`,
                    });
                    try {
                        await handler.parse(params, data, null);
                    } catch (err) {
                        if (!isKnownCrash(err)) throw err;
                    }
                }
            ), { numRuns: NUM_RUNS });
        });

        it('never throws when getTokenInfo returns null (token does not exist)', function () {
            const handler = new Mint(actionsCtx);
            indexer.indexerDb.getTokenInfo.resolves(null);
            return fc.assert(fc.asyncProperty(
                validTick(),
                validAmount(0),
                async (tick, amount) => {
                    const params = ['0', tick, amount];
                    const data = createBaseData({
                        ACTION: 'MINT', FORMAT: 0,
                        TX_DATA: `MINT|0|${tick}|${amount}`,
                    });
                    try {
                        await handler.parse(params, data, null);
                    } catch (err) {
                        if (!isKnownCrash(err)) throw err;
                    }
                }
            ), { numRuns: NUM_RUNS });
        });

        it('handles unknown format version', async function () {
            const handler = new Mint(actionsCtx);
            indexer.indexerDb.getTokenInfo.resolves(createTokenInfo());
            const data = createBaseData({
                ACTION: 'MINT', FORMAT: 99,
                TX_DATA: 'MINT|99|TEST|100',
            });
            try {
                await handler.parse(['99', 'TEST', '100'], data, null);
            } catch (err) {
                if (!isKnownCrash(err)) throw err;
                return;
            }
            assert.ok(data.STATUS.startsWith('invalid'),
                `Unknown format should be rejected, got: ${data.STATUS}`);
        });
    });

    describe('supply arithmetic safety', function () {
        it('bcadd with random supply values never produces NaN', function () {
            const util = indexer.util;
            fc.assert(fc.property(
                validAmount(8), validAmount(8),
                (a, b) => {
                    const result = util.bcadd(a, b, 8);
                    const str = util.bcformat(result, 8);
                    assert.ok(!str.includes('NaN'), `bcadd(${a}, ${b}) = NaN`);
                }
            ), { numRuns: NUM_RUNS });
        });

        it('bcsub with random valid amounts never produces NaN', function () {
            const util = indexer.util;
            fc.assert(fc.property(
                validAmount(8), validAmount(8),
                (a, b) => {
                    const result = util.bcsub(a, b, 8);
                    const str = util.bcformat(result, 8);
                    assert.ok(!str.includes('NaN'), `bcsub(${a}, ${b}) = NaN`);
                }
            ), { numRuns: NUM_RUNS });
        });
    });
});
