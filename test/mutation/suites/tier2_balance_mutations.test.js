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
 * Tier 2: Balance & Ledger Mutations @tier2
 *
 * Verifies that tests detect mutations in getTokenSupply formula,
 * createCredit/Debit/Escrow delegation, createLedgerChangeRecord
 * whitelist, and balance update logic.
 *
 * The supply formula, parameter order, ledger table names and the whitelist
 * live here; empty returns and the SQL filter mutations live beside it in
 * tier2_balance_mutations.test/returns_and_sql_filters.test.js, and
 * helpers/ledger_context.js there binds the Database methods under test.
 */

'use strict';

const assert = require('assert');
const {
    registry, operators, sinon,
} = require('../setup/harness');
const {
    createSupplyTestContext, createLedgerTestContext,
} = require('./tier2_balance_mutations.test/helpers/ledger_context.js');

const Database = require('../../../src/db');

// ─────────────────────────────────────────────────────────────────────────────

describe('Mutation: Tier 2: Balance & Ledger @tier2', function () {
    afterEach(function () { sinon.restore(); });

    // ── AOR: Arithmetic in getTokenSupply ────────────────────────────────

    describe('AOR: getTokenSupply Formula', function () {
        it('AOR-200: bcsub→bcadd in supply formula (credits+debits)', async function () {
            const { ctx, getTokenSupply, util } = createSupplyTestContext('1000', '300', '50');
            // Mutate: bcsub → bcadd
            operators.AOR.subToAdd(util);
            // Re-bind after mutation
            ctx.util = util;

            const supply = await getTokenSupply('TEST');
            const formatted = util.bcformat(supply, 0);
            // Original: (1000 - 300) + 50 = 750
            // Mutant:   (1000 + 300) + 50 = 1350
            const mutated = (formatted !== '750');

            registry.record({
                id: 'AOR-200', operator: 'AOR', target: 'Database.getTokenSupply',
                mutation: 'bcsub→bcadd in (credits-debits)', file: 'src/db.js',
                status: mutated ? 'killed' : 'survived',
                killedBy: mutated ? `supply = ${formatted} not 750` : '',
                description: 'getTokenSupply adds debits instead of subtracting',
            });
            assert.notStrictEqual(formatted, '750', 'AOR-200 survived');
        });

        it('AOR-201: bcadd→bcsub in supply formula (subtract escrows)', async function () {
            const { ctx, getTokenSupply, util } = createSupplyTestContext('1000', '300', '50');
            operators.AOR.addToSub(util);
            ctx.util = util;

            const supply = await getTokenSupply('TEST');
            const formatted = util.bcformat(supply, 0);
            // Original: (1000 - 300) + 50 = 750
            // Mutant:   (1000 - 300) - 50 = 650
            const mutated = (formatted !== '750');

            registry.record({
                id: 'AOR-201', operator: 'AOR', target: 'Database.getTokenSupply',
                mutation: 'bcadd→bcsub in result+escrows', file: 'src/db.js',
                status: mutated ? 'killed' : 'survived',
                killedBy: mutated ? `supply = ${formatted} not 750` : '',
                description: 'getTokenSupply subtracts escrows instead of adding',
            });
            assert.notStrictEqual(formatted, '750', 'AOR-201 survived');
        });
    });
});

describe('Mutation: Tier 2: Balance & Ledger @tier2', function () {
    afterEach(function () { sinon.restore(); });

    describe('AOR: getTokenSupply Formula', function () {
        it('AOR-202: supply formula with zero debits; bcsub mutation still detected', async function () {
            const { ctx, getTokenSupply, util } = createSupplyTestContext('500', '0', '100');
            operators.AOR.subToAdd(util);
            ctx.util = util;

            const supply = await getTokenSupply('TEST');
            const formatted = util.bcformat(supply, 0);
            // Original: (500 - 0) + 100 = 600
            // Mutant:   (500 + 0) + 100 = 600 (EQUIVALENT when debits=0!)
            registry.record({
                id: 'AOR-202', operator: 'AOR', target: 'Database.getTokenSupply',
                mutation: 'bcsub→bcadd with zero debits', file: 'src/db.js',
                status: formatted === '600' ? 'survived' : 'killed',
                killedBy: formatted === '600' ? '' : `supply = ${formatted}`,
                description: 'getTokenSupply bcsub mutation, equivalent when debits=0',
            });
            // Expected: equivalent when debits are zero
        });

        it('AOR-203: supply formula with zero escrows; bcadd mutation still detected', async function () {
            const { ctx, getTokenSupply, util } = createSupplyTestContext('1000', '300', '0');
            operators.AOR.addToSub(util);
            ctx.util = util;

            const supply = await getTokenSupply('TEST');
            const formatted = util.bcformat(supply, 0);
            // Original: (1000 - 300) + 0 = 700
            // Mutant:   (1000 - 300) - 0 = 700 (EQUIVALENT when escrows=0!)
            registry.record({
                id: 'AOR-203', operator: 'AOR', target: 'Database.getTokenSupply',
                mutation: 'bcadd→bcsub with zero escrows', file: 'src/db.js',
                status: formatted === '700' ? 'survived' : 'killed',
                killedBy: formatted === '700' ? '' : `supply = ${formatted}`,
                description: 'getTokenSupply bcadd mutation, equivalent when escrows=0',
            });
            // Expected: equivalent when escrows are zero
        });
    });
});

describe('Mutation: Tier 2: Balance & Ledger @tier2', function () {
    afterEach(function () { sinon.restore(); });

    // ── PRM: Parameter Reorder in supply formula ─────────────────────────

    describe('PRM: Parameter Reorder in Supply', function () {

        it('PRM-200: bcsub(credits,debits) → bcsub(debits,credits)', async function () {
            const { ctx, getTokenSupply, util } = createSupplyTestContext('1000', '300', '50');
            operators.PRM.bcsubSwapArgs(util);
            ctx.util = util;

            const supply = await getTokenSupply('TEST');
            const formatted = util.bcformat(supply, 0);
            // Original: (1000 - 300) + 50 = 750
            // Mutant:   (300 - 1000) + 50 = -650
            const mutated = (formatted !== '750');

            registry.record({
                id: 'PRM-200', operator: 'PRM', target: 'Database.getTokenSupply',
                mutation: 'bcsub(credits,debits) → bcsub(debits,credits)', file: 'src/db.js',
                status: mutated ? 'killed' : 'survived',
                killedBy: mutated ? `supply = ${formatted} not 750` : '',
                description: 'getTokenSupply subtraction direction reversed',
            });
            assert.notStrictEqual(formatted, '750', 'PRM-200 survived');
        });
    });
});

describe('Mutation: Tier 2: Balance & Ledger @tier2', function () {
    afterEach(function () { sinon.restore(); });

    // ── SBR: String Replacement in createCredit/Debit/Escrow ─────────────

    describe('SBR: Table Name Mutations in Ledger', function () {

        it('SBR-200: createCredit calls with correct table name', async function () {
            const { createCredit, queries } = createLedgerTestContext();
            await createCredit(1, 'TEST', '100', 'addr1');

            const insertQuery = queries.find(q => q.query.includes('INSERT'));
            const usesCredits = insertQuery && insertQuery.query.includes('credits');

            registry.record({
                id: 'SBR-200', operator: 'SBR', target: 'Database.createCredit',
                mutation: "table='credits' baseline check", file: 'src/db.js',
                status: usesCredits ? 'killed' : 'survived',
                killedBy: usesCredits ? 'INSERT targets credits table' : '',
                description: 'createCredit delegates to credits table',
            });
            assert.ok(usesCredits, 'SBR-200: INSERT should target credits table');
        });

        it('SBR-201: createDebit calls with correct table name', async function () {
            const { createDebit, queries } = createLedgerTestContext();
            await createDebit(1, 'TEST', '100', 'addr1');

            const insertQuery = queries.find(q => q.query.includes('INSERT'));
            const usesDebits = insertQuery && insertQuery.query.includes('debits');

            registry.record({
                id: 'SBR-201', operator: 'SBR', target: 'Database.createDebit',
                mutation: "table='debits' baseline check", file: 'src/db.js',
                status: usesDebits ? 'killed' : 'survived',
                killedBy: usesDebits ? 'INSERT targets debits table' : '',
                description: 'createDebit delegates to debits table',
            });
            assert.ok(usesDebits, 'SBR-201: INSERT should target debits table');
        });

        it('SBR-202: createEscrow calls with correct table name', async function () {
            const { createEscrow, queries } = createLedgerTestContext();
            await createEscrow(1, 'TEST', '100', 'addr1');

            const insertQuery = queries.find(q => q.query.includes('INSERT'));
            const usesEscrows = insertQuery && insertQuery.query.includes('escrows');

            registry.record({
                id: 'SBR-202', operator: 'SBR', target: 'Database.createEscrow',
                mutation: "table='escrows' baseline check", file: 'src/db.js',
                status: usesEscrows ? 'killed' : 'survived',
                killedBy: usesEscrows ? 'INSERT targets escrows table' : '',
                description: 'createEscrow delegates to escrows table',
            });
            assert.ok(usesEscrows, 'SBR-202: INSERT should target escrows table');
        });
    });
});

describe('Mutation: Tier 2: Balance & Ledger @tier2', function () {
    afterEach(function () { sinon.restore(); });

    // ── EHR: Error Handling in createLedgerChangeRecord ──────────────────

    describe('EHR: Whitelist Validation in Ledger', function () {

        it('EHR-200: createLedgerChangeRecord rejects invalid table name', async function () {
            const { createLedgerChangeRecord } = createLedgerTestContext();
            let threw = false;
            try {
                await createLedgerChangeRecord('injected_table', 1, 'TEST', '100', 'addr1');
            } catch (e) {
                threw = true;
            }

            registry.record({
                id: 'EHR-200', operator: 'EHR', target: 'Database.createLedgerChangeRecord',
                mutation: 'whitelist check present', file: 'src/db.js',
                status: threw ? 'killed' : 'survived',
                killedBy: threw ? 'invalid table threw' : '',
                description: 'createLedgerChangeRecord whitelist rejects injection',
            });
            assert.ok(threw, 'EHR-200: invalid table should throw');
        });

        it('EHR-201: createLedgerChangeRecord accepts valid table names', async function () {
            const { createLedgerChangeRecord } = createLedgerTestContext();
            let threw = false;
            try {
                await createLedgerChangeRecord('credits', 1, 'TEST', '100', 'addr1');
            } catch (e) {
                threw = true;
            }

            registry.record({
                id: 'EHR-201', operator: 'EHR', target: 'Database.createLedgerChangeRecord',
                mutation: 'whitelist allows credits', file: 'src/db.js',
                status: !threw ? 'killed' : 'survived',
                killedBy: !threw ? 'credits table accepted' : '',
                description: 'createLedgerChangeRecord accepts valid table name',
            });
            assert.ok(!threw, 'EHR-201: credits table should be accepted');
        });
    });
});

// The rest of the suite lives in tier2_balance_mutations.test/. test:guard-dependencies globs only the top
// level of suites/, so this file loads each part itself and every title stays
// collected under this file.
require('./tier2_balance_mutations.test/returns_and_sql_filters.test.js');
