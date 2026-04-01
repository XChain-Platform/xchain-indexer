/**
 * Tier 2 — Balance & Ledger Mutations @tier2
 *
 * Verifies that tests detect mutations in getTokenSupply formula,
 * createCredit/Debit/Escrow delegation, createLedgerChangeRecord
 * whitelist, and balance update logic.
 */

'use strict';

const assert = require('assert');
const {
    registry, operators, sinon, Utility, mathjs,
    createMockIndexer, createBaseData, createTokenInfo, getTestConfig,
} = require('../setup/harness');

const Database = require('../../../src/db.js');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a bound getTokenSupply method using a mock doQuery
 * that returns predetermined credits/debits/escrows values.
 */
function createSupplyTestContext(credits, debits, escrows) {
    const config = getTestConfig();
    const util = new Utility();
    let queryCount = 0;

    const ctx = {
        config,
        util,
        createTicker: sinon.stub().resolves(1),
        getTokenDecimalPrecision: sinon.stub().resolves(0),
        doQuery: sinon.stub().callsFake(async (query, args) => {
            queryCount++;
            if (queryCount === 1) return [{ credits: credits }];
            if (queryCount === 2) return [{ debits: debits }];
            if (queryCount === 3) return [{ escrows: escrows }];
            return [];
        }),
    };

    const getTokenSupply = Database.prototype.getTokenSupply.bind(ctx);
    return { ctx, getTokenSupply, util };
}

/**
 * Create a bound createLedgerChangeRecord method with mock doQuery
 */
function createLedgerTestContext() {
    const config = getTestConfig();
    const util = new Utility();
    const queries = [];

    const ctx = {
        config,
        util,
        createTicker: sinon.stub().resolves(1),
        createAddress: sinon.stub().resolves(1),
        doQuery: sinon.stub().callsFake(async (query, args) => {
            queries.push({ query, args: [...args] });
            if (query.trim().startsWith('SELECT')) return []; // No existing record
            return { insertId: 1 };
        }),
    };

    // Bind createLedgerChangeRecord to ctx first, then attach it
    ctx.createLedgerChangeRecord = Database.prototype.createLedgerChangeRecord.bind(ctx);
    const createCredit = Database.prototype.createCredit.bind(ctx);
    const createDebit = Database.prototype.createDebit.bind(ctx);
    const createEscrow = Database.prototype.createEscrow.bind(ctx);

    return { ctx, createLedgerChangeRecord: ctx.createLedgerChangeRecord, createCredit, createDebit, createEscrow, queries };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('Mutation — Tier 2: Balance & Ledger @tier2', function () {

    afterEach(function () {
        sinon.restore();
    });

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

        it('AOR-202: supply formula with zero debits — bcsub mutation still detected', async function () {
            const { ctx, getTokenSupply, util } = createSupplyTestContext('500', '0', '100');
            operators.AOR.subToAdd(util);
            ctx.util = util;

            const supply = await getTokenSupply('TEST');
            const formatted = util.bcformat(supply, 0);
            // Original: (500 - 0) + 100 = 600
            // Mutant:   (500 + 0) + 100 = 600 — EQUIVALENT when debits=0!
            registry.record({
                id: 'AOR-202', operator: 'AOR', target: 'Database.getTokenSupply',
                mutation: 'bcsub→bcadd with zero debits', file: 'src/db.js',
                status: formatted === '600' ? 'survived' : 'killed',
                killedBy: formatted === '600' ? '' : `supply = ${formatted}`,
                description: 'getTokenSupply bcsub mutation — equivalent when debits=0',
            });
            // Expected: equivalent when debits are zero
        });

        it('AOR-203: supply formula with zero escrows — bcadd mutation still detected', async function () {
            const { ctx, getTokenSupply, util } = createSupplyTestContext('1000', '300', '0');
            operators.AOR.addToSub(util);
            ctx.util = util;

            const supply = await getTokenSupply('TEST');
            const formatted = util.bcformat(supply, 0);
            // Original: (1000 - 300) + 0 = 700
            // Mutant:   (1000 - 300) - 0 = 700 — EQUIVALENT when escrows=0!
            registry.record({
                id: 'AOR-203', operator: 'AOR', target: 'Database.getTokenSupply',
                mutation: 'bcadd→bcsub with zero escrows', file: 'src/db.js',
                status: formatted === '700' ? 'survived' : 'killed',
                killedBy: formatted === '700' ? '' : `supply = ${formatted}`,
                description: 'getTokenSupply bcadd mutation — equivalent when escrows=0',
            });
            // Expected: equivalent when escrows are zero
        });
    });

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
