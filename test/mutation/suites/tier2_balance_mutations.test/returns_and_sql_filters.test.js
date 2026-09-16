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
 * Tier 2: Balance & Ledger Mutations @tier2: empty returns in supply and the
 * getTokenSupply SQL filter and boundary operator mutations.
 *
 * Part of the tier 2 balance mutation suite; see
 * ../tier2_balance_mutations.test.js, which loads this file.
 */

'use strict';

const assert = require('assert');
const {
    registry, Utility, sinon, mathjs, getTestConfig,
} = require('../../setup/harness');
const {
    createSupplyTestContext, createLedgerTestContext,
} = require('./helpers/ledger_context.js');

const Database = require('../../../../src/db');

describe('Mutation: Tier 2: Balance & Ledger @tier2', function () {
    afterEach(function () { sinon.restore(); });

    // ── EMR: Empty Return Mutations ──────────────────────────────────────

    describe('EMR: Empty Return in Supply', function () {
        it('EMR-200: getTokenSupply with null credits returns 0-based supply', async function () {
            const { ctx, getTokenSupply, util } = createSupplyTestContext(null, '300', '50');

            const supply = await getTokenSupply('TEST');
            const formatted = util.bcformat(supply, 0);
            // credits=null → defaults to 0: (0 - 300) + 50 = -250
            registry.record({
                id: 'EMR-200', operator: 'EMR', target: 'Database.getTokenSupply',
                mutation: 'null credits handling', file: 'src/db.js',
                status: formatted === '-250' ? 'killed' : 'survived',
                killedBy: formatted === '-250' ? 'null credits → 0 default works' : '',
                description: 'getTokenSupply handles null credits correctly',
            });
            assert.strictEqual(formatted, '-250', 'EMR-200: null credits should default to 0');
        });

        it('EMR-201: getTokenSupply with all nulls returns 0', async function () {
            const { ctx, getTokenSupply, util } = createSupplyTestContext(null, null, null);

            const supply = await getTokenSupply('TEST');
            const formatted = util.bcformat(supply, 0);

            registry.record({
                id: 'EMR-201', operator: 'EMR', target: 'Database.getTokenSupply',
                mutation: 'all null returns', file: 'src/db.js',
                status: formatted === '0' ? 'killed' : 'survived',
                killedBy: formatted === '0' ? 'all nulls → 0' : '',
                description: 'getTokenSupply handles all null returns',
            });
            assert.strictEqual(formatted, '0', 'EMR-201: all nulls should produce 0');
        });

        it('EMR-202: getTokenSupply with decimal precision', async function () {
            const { ctx, getTokenSupply, util } = createSupplyTestContext('100.50', '25.25', '10.00');
            ctx.getTokenDecimalPrecision.resolves(2);

            const supply = await getTokenSupply('TEST');
            const formatted = util.bcformat(supply, 2);
            // (100.50 - 25.25) + 10.00 = 85.25

            registry.record({
                id: 'EMR-202', operator: 'EMR', target: 'Database.getTokenSupply',
                mutation: 'decimal precision handling', file: 'src/db.js',
                status: formatted === '85.25' ? 'killed' : 'survived',
                killedBy: formatted === '85.25' ? 'decimal supply correct' : '',
                description: 'getTokenSupply decimal precision calculation',
            });
            assert.strictEqual(formatted, '85.25', 'EMR-202: decimal supply should be 85.25');
        });
    });
});

describe('Mutation: Tier 2: Balance & Ledger @tier2', function () {
    afterEach(function () { sinon.restore(); });

    describe('EMR: Empty Return in Supply', function () {
        it('EMR-203: createLedgerChangeRecord converts BigNumber to string', async function () {
            const { createLedgerChangeRecord, queries } = createLedgerTestContext();
            const bigNum = mathjs.bignumber('12345.678');

            await createLedgerChangeRecord('credits', 1, 'TEST', bigNum, 'addr1');

            const insertQuery = queries.find(q => q.query.includes('INSERT'));
            const amountArg = insertQuery ? insertQuery.args[0] : null;

            registry.record({
                id: 'EMR-203', operator: 'EMR', target: 'Database.createLedgerChangeRecord',
                mutation: 'BigNumber String() conversion', file: 'src/db.js',
                status: typeof amountArg === 'string' ? 'killed' : 'survived',
                killedBy: typeof amountArg === 'string' ? `amount is string: '${amountArg}'` : '',
                description: 'createLedgerChangeRecord converts BigNumber to string',
            });
            assert.strictEqual(typeof amountArg, 'string', 'EMR-203: amount should be string');
        });
    });
});

describe('Mutation: Tier 2: Balance & Ledger @tier2', function () {
    afterEach(function () { sinon.restore(); });

    // ── SDL: SQL Filter Mutations ────────────────────────────────────────

    describe('SDL: SQL Filter Mutations in Supply', function () {

        it('SDL-200: block_index filter present in getTokenSupply', async function () {
            const config = getTestConfig();
            const util = new Utility();
            const queriesCaptured = [];

            const ctx = {
                config, util,
                createTicker: sinon.stub().resolves(1),
                getTokenDecimalPrecision: sinon.stub().resolves(0),
                doQuery: sinon.stub().callsFake(async (query, args) => {
                    queriesCaptured.push(query);
                    return [{ credits: '100', debits: '50', escrows: '10' }];
                }),
            };

            const getTokenSupply = Database.prototype.getTokenSupply.bind(ctx);
            await getTokenSupply('TEST', 100); // With block_index

            const hasBlockFilter = queriesCaptured.some(q => q.includes('block_index'));
            registry.record({
                id: 'SDL-200', operator: 'SDL', target: 'Database.getTokenSupply',
                mutation: 'block_index filter present', file: 'src/db.js',
                status: hasBlockFilter ? 'killed' : 'survived',
                killedBy: hasBlockFilter ? 'SQL includes block_index filter' : '',
                description: 'getTokenSupply includes block_index filter when provided',
            });
            assert.ok(hasBlockFilter, 'SDL-200: block_index filter should be in query');
        });
    });
});

describe('Mutation: Tier 2: Balance & Ledger @tier2', function () {
    afterEach(function () { sinon.restore(); });

    describe('SDL: SQL Filter Mutations in Supply', function () {
        it('SDL-201: action_index filter present in getTokenSupply', async function () {
            const config = getTestConfig();
            const util = new Utility();
            const queriesCaptured = [];

            const ctx = {
                config, util,
                createTicker: sinon.stub().resolves(1),
                getTokenDecimalPrecision: sinon.stub().resolves(0),
                doQuery: sinon.stub().callsFake(async (query, args) => {
                    queriesCaptured.push(query);
                    return [{ credits: '100', debits: '50', escrows: '10' }];
                }),
            };

            const getTokenSupply = Database.prototype.getTokenSupply.bind(ctx);
            await getTokenSupply('TEST', 100, 50); // With both filters

            const hasActionFilter = queriesCaptured.some(q => q.includes('action_index'));
            registry.record({
                id: 'SDL-201', operator: 'SDL', target: 'Database.getTokenSupply',
                mutation: 'action_index filter present', file: 'src/db.js',
                status: hasActionFilter ? 'killed' : 'survived',
                killedBy: hasActionFilter ? 'SQL includes action_index filter' : '',
                description: 'getTokenSupply includes action_index filter when provided',
            });
            assert.ok(hasActionFilter, 'SDL-201: action_index filter should be in query');
        });
    });
});

describe('Mutation: Tier 2: Balance & Ledger @tier2', function () {
    afterEach(function () { sinon.restore(); });

    // ── BCR: Boundary in SQL filters ─────────────────────────────────────

    describe('BCR: SQL Filter Boundary Operators', function () {
        it('BCR-200: block_index uses <= (not <)', async function () {
            const config = getTestConfig();
            const util = new Utility();
            const queriesCaptured = [];

            const ctx = {
                config, util,
                createTicker: sinon.stub().resolves(1),
                getTokenDecimalPrecision: sinon.stub().resolves(0),
                doQuery: sinon.stub().callsFake(async (query, args) => {
                    queriesCaptured.push(query);
                    return [{ credits: '100', debits: '0', escrows: '0' }];
                }),
            };

            const getTokenSupply = Database.prototype.getTokenSupply.bind(ctx);
            await getTokenSupply('TEST', 100);

            const usesLte = queriesCaptured.some(q => q.includes('block_index <='));
            registry.record({
                id: 'BCR-200', operator: 'BCR', target: 'Database.getTokenSupply',
                mutation: 'block_index <= ? (not <)', file: 'src/db.js',
                status: usesLte ? 'killed' : 'survived',
                killedBy: usesLte ? 'uses <= for block_index' : '',
                description: 'getTokenSupply block_index filter uses <=',
            });
            assert.ok(usesLte, 'BCR-200: should use <= for block_index');
        });
    });
});

describe('Mutation: Tier 2: Balance & Ledger @tier2', function () {
    afterEach(function () { sinon.restore(); });

    describe('BCR: SQL Filter Boundary Operators', function () {
        it('BCR-201: action_index uses < (not <=)', async function () {
            const config = getTestConfig();
            const util = new Utility();
            const queriesCaptured = [];

            const ctx = {
                config, util,
                createTicker: sinon.stub().resolves(1),
                getTokenDecimalPrecision: sinon.stub().resolves(0),
                doQuery: sinon.stub().callsFake(async (query, args) => {
                    queriesCaptured.push(query);
                    return [{ credits: '100', debits: '0', escrows: '0' }];
                }),
            };

            const getTokenSupply = Database.prototype.getTokenSupply.bind(ctx);
            await getTokenSupply('TEST', 100, 50);

            // Should use < not <=
            const usesLt = queriesCaptured.some(q => q.includes('action_index < ?') && !q.includes('action_index <='));
            registry.record({
                id: 'BCR-201', operator: 'BCR', target: 'Database.getTokenSupply',
                mutation: 'action_index < ? (not <=)', file: 'src/db.js',
                status: usesLt ? 'killed' : 'survived',
                killedBy: usesLt ? 'uses < for action_index' : '',
                description: 'getTokenSupply action_index filter uses strict <',
            });
            assert.ok(usesLt, 'BCR-201: should use < for action_index');
        });
    });
});
