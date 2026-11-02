/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * test/unit/db/db_integer_field_range.test.js
 *
 * A wire field that lands in an integer column must never reach the bind with a
 * value the column cannot represent.
 *
 * NUMBER_FIELDS normalization bounds a field's TYPE and not its MAGNITUDE, so
 * EXPIRATION='18446744073709551616' cleared every format check and was bound into
 * orders.expiration BIGINT UNSIGNED - which throws inside the block transaction
 * under STRICT_TRANS_TABLES (the retry loop then re-runs the same deterministic
 * transaction forever) or clamps under a permissive sql_mode (two nodes store
 * different values). The action handlers write their row even when the action is
 * invalid, so rejecting the action is not on its own enough.
 *
 * Negative control: drop the INTEGER_FIELDS loop from normalizeDataValues and the
 * out-of-range / negative cases below resolve to the original value instead of
 * null; drop the validator clause and the "still invalid" case goes red. The
 * money-field case is the control in the other direction - it goes red if the
 * guard ever leaks onto a VARCHAR amount column.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const sinon  = require('sinon');
const mathjs = require('mathjs');

const { getTestConfig } = require('../../fixtures/config');
const Utility           = require('../../../src/utility');
const Database          = require('../../../src/db');
const settle            = require('../../../src/actions/deploy/settle.js');

const U64_MAX = '18446744073709551615';
const OVER_U64 = '18446744073709551616';

function makeDb() {
    const config = getTestConfig();
    const util   = new Utility();
    sinon.stub(util, 'logError');
    return new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
}

afterEach(function () { sinon.restore(); });

describe('integer-backed wire fields are range-guarded before the bind @regression @tier1', function () {
    it('nulls an EXPIRATION one past the BIGINT UNSIGNED maximum', function () {
        const db = makeDb();
        const out = db.normalizeDataValues({ ACTION: 'ORDER', EXPIRATION: OVER_U64 });
        assert.strictEqual(out['EXPIRATION'], null);
    });

    it('keeps the BIGINT UNSIGNED maximum itself, which the column can store', function () {
        const db = makeDb();
        const out = db.normalizeDataValues({ ACTION: 'ORDER', EXPIRATION: U64_MAX });
        assert.strictEqual(String(out['EXPIRATION']), U64_MAX);
    });

    it('nulls a negative value bound for an UNSIGNED column', function () {
        const db = makeDb();
        const out = db.normalizeDataValues({ ACTION: 'ORDER', EXPIRATION: '-1' });
        assert.strictEqual(out['EXPIRATION'], null);
    });

    it('leaves an ordinary in-range expiration untouched', function () {
        const db = makeDb();
        const out = db.normalizeDataValues({ ACTION: 'ORDER', EXPIRATION: '9999999999' });
        assert.strictEqual(String(out['EXPIRATION']), '9999999999');
    });

    it('honours a narrower column: COOLDOWN_BLOCKS is INT UNSIGNED, not BIGINT', function () {
        const db = makeDb();
        const out = db.normalizeDataValues({ ACTION: 'ISSUE', COOLDOWN_BLOCKS: '4294967296' });
        assert.strictEqual(out['COOLDOWN_BLOCKS'], null);
        const ok = db.normalizeDataValues({ ACTION: 'ISSUE', COOLDOWN_BLOCKS: '4294967295' });
        assert.strictEqual(String(ok['COOLDOWN_BLOCKS']), '4294967295');
    });

    // The control in the other direction. The amount family is VARCHAR(250) and
    // legitimately carries fixed-decimal strings far larger than any integer column;
    // range-clamping one would destroy a real balance.
    it('never touches the VARCHAR amount fields, however large', function () {
        const db = makeDb();
        const out = db.normalizeDataValues({
            ACTION:      'ISSUE',
            MAX_SUPPLY:  '184467440737095516150.00000000',
            GIVE_AMOUNT: '999999999999999999999.00000000'
        });
        assert.strictEqual(String(out['MAX_SUPPLY']),  '184467440737095516150.00000000');
        assert.strictEqual(String(out['GIVE_AMOUNT']), '999999999999999999999.00000000');
    });
});

describe('integer-backed wire fields are range-guarded before the bind @regression @tier1', function () {
    it('every INTEGER_FIELDS maximum is an unsigned column bound, never a money field', function () {
        const db = makeDb();
        const map = db.config['INTEGER_FIELDS'];
        const AMOUNTS = ['AMOUNT', 'GIVE_AMOUNT', 'GET_AMOUNT', 'MAX_SUPPLY', 'MIN_AMOUNT',
                         'FEE', 'FEE_AMOUNT', 'DEPOSIT', 'GAS_ESCROW', 'GIVE_ESCROW',
                         'CALLBACK_AMOUNT', 'FIAT_AMOUNT', 'MINT_SUPPLY', 'BALANCES'];
        for (const field of AMOUNTS)
            assert.ok(!(field in map), field + ' is a VARCHAR amount column and must not be range-guarded');
        for (const field of Object.keys(map)) {
            assert.ok(db.config['NUMBER_FIELDS'].indexOf(field) !== -1,
                field + ' must also be numeric-normalized');
            assert.match(String(map[field]), /^[0-9]+$/,
                field + ' maximum is a decimal digit string, compared as BigInt');
        }
    });
});

describe('exceedsUnsignedColumn proves overflow and never guesses @regression @tier1', function () {

    it('answers on the exact boundary without losing precision above 2^53', function () {
        const util = new Utility();
        assert.strictEqual(util.exceedsUnsignedColumn(U64_MAX, U64_MAX), false);
        assert.strictEqual(util.exceedsUnsignedColumn(OVER_U64, U64_MAX), true);
        // The naive Number() compare this replaces: both sides round to the same float,
        // so it would answer false for the value one past the maximum.
        assert.strictEqual(Number(OVER_U64) > Number(U64_MAX), false);
    });

    it('answers false for a spelling it cannot prove out of range', function () {
        const util = new Utility();
        assert.strictEqual(util.exceedsUnsignedColumn('1.0', U64_MAX), false);
        assert.strictEqual(util.exceedsUnsignedColumn('not a number', U64_MAX), false);
        assert.strictEqual(util.exceedsUnsignedColumn(null, U64_MAX), false);
    });
});

/*
 * Integer columns fed by a wire value that validation checks only loosely. A DEPLOY with
 * GAS_LIMIT='-1' passed the isNumeric check, was refused for its fee, and still wrote its
 * contract_executions row: the gas_limit BIGINT UNSIGNED insert failed with errno 1264
 * inside the block transaction and the block retried forever. ADDRESS, SWEEP and XCALL v0
 * write their rows for refused actions the same way. Each case runs the production
 * writer (or the DEPLOY settle step in front of it) and checks the bound parameter against
 * a model of the strict integer conversion read from the table's shipped DDL. Values the
 * column already stores bind unchanged, so the in-range spellings are controls.
 */

const SQL_DIR  = path.join(__dirname, '../../../src/sql');

// Column definitions as the shipped DDL states them.
function columnSpec(table, column){
    const raw = fs.readFileSync(path.join(SQL_DIR, table + '.sql'), 'utf8');
    const parsed = Database.prototype.parseExpectedColumns.call(
        { stripSqlLineComments: Database.prototype.stripSqlLineComments }, raw);
    const col = parsed.find(c => c.name === column);
    assert.ok(col, table + '.' + column + ' is absent from its schema definition');
    return col.definition;
}

// The strict-session integer conversion: a plain decimal spelling, rounded half away from
// zero, inside the type's range; NULL only where the column allows it.
function columnAccepts(table, column, value){
    const spec = columnSpec(table, column);
    if(value === null || value === undefined)
        return !/\bNOT\s+NULL\b/i.test(spec);
    const type = /\b(TINYINT|SMALLINT|MEDIUMINT|INT|BIGINT)\b/i.exec(spec);
    assert.ok(type, table + '.' + column + ' is not an integer column');
    const unsigned = /\bUNSIGNED\b/i.test(spec);
    const bits = { TINYINT: 8, SMALLINT: 16, MEDIUMINT: 24, INT: 32, BIGINT: 64 }[type[1].toUpperCase()];
    const raw = String(value).trim();
    if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw))
        return false;
    const n = mathjs.round(mathjs.bignumber(raw));
    const two = mathjs.bignumber(2);
    const min = unsigned ? mathjs.bignumber(0) : two.pow(bits - 1).negated();
    const max = unsigned ? two.pow(bits).minus(1) : two.pow(bits - 1).minus(1);
    return n.isFinite() && n.gte(min) && n.lte(max);
}

// A Database whose lookups answer 1 and whose doQuery records each statement.
function makeWritingDb(){
    const util = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config: getTestConfig(), util });
    const writes = [];
    for(const lookup of ['createStatus', 'getAddressId', 'createAddress', 'createMemo', 'createTicker'])
        db[lookup] = async () => 1;
    db.doQuery = async (query, args) => {
        if(!/^\s*SELECT/i.test(query)) writes.push({ query, args });
        return [];
    };
    return { db, writes };
}

// The value bound for one column of the single INSERT a writer ran.
function bound(writes, column){
    assert.strictEqual(writes.length, 1, 'expected one write');
    const cols = /\(([^)]*)\)\s*(?:VALUES|values)/.exec(writes[0].query)[1].split(',').map(c => c.trim());
    const at = cols.indexOf(column);
    assert.ok(at >= 0, column + ' is not in the INSERT column list');
    return writes[0].args[at];
}

// Out-of-range spellings that passed the handlers' loose checks, each with the value
// the column now receives. In-range spellings are controls and bind byte-identical.
const GAS_LIMIT_CASES = [
    { wire: '-1',       binds: '0' },
    { wire: OVER_U64,   binds: U64_MAX },
    { wire: '1e6',      binds: '1e6' },
    { wire: '1.5',      binds: '1.5' },
    { wire: '200000',   binds: '200000' },
];

describe('contract_executions.gas_limit fits its BIGINT UNSIGNED column @regression @tier1', function () {
    for(const c of GAS_LIMIT_CASES){
        it("binds a DEPLOY GAS_LIMIT of '" + c.wire + "' as '" + c.binds + "'", async function () {
            const { db, writes } = makeWritingDb();
            // The DEPLOY settle step in front of the writer, as runDeployment calls it for a
            // deploy refused for insufficient GAS funds (the shape of the observed wedge).
            const deploy = {
                indexerDb: db,
                actions: { protocolChanges: { isEnabled: async () => true } }
            };
            const run = {
                data: { ACTION_INDEX: 114155001, SOURCE: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH', BLOCK_INDEX: 114155 },
                chargedGas: 101480, gasLimit: c.wire, constructorParams: '',
                status: 'invalid: insufficient funds (GAS)', error: 'invalid: insufficient funds (GAS)',
                landedPending: false, constructorResult: null, assemblerActionIndex: null, feePaymentMode: 2
            };
            await settle.writeExecutionRecord(deploy, run);
            const value = bound(writes, 'gas_limit');
            assert.strictEqual(String(value), c.binds);
            assert.ok(columnAccepts('contract_executions', 'gas_limit', value),
                'contract_executions.gas_limit refuses ' + JSON.stringify(value));
            assert.strictEqual(run.status, 'invalid: insufficient funds (GAS)');
        });
    }

    it("binds the gas charged for a DEPLOY GAS_LIMIT of 'abc', which is refused as invalid: GAS_LIMIT", async function () {
        const { db, writes } = makeWritingDb();
        await db.createContractExecution({ ACTION_INDEX: 7, CONTRACT_INDEX: 7, CALLER: 'x', METHOD_NAME: 'constructor',
            INPUT_PARAMS: '', GAS_USED: 5000, GAS_LIMIT: 'abc', STATUS: 'invalid: GAS_LIMIT (required)', BLOCK_INDEX: 1 });
        assert.strictEqual(bound(writes, 'gas_limit'), 5000);
    });

    it('binds U64 max for a deferred deploy limit read back above 2^53 as a Number', async function () {
        const { db, writes } = makeWritingDb();
        await db.createContractExecution({ ACTION_INDEX: 8, CONTRACT_INDEX: 8, CALLER: 'x', METHOD_NAME: 'constructor',
            INPUT_PARAMS: '', GAS_USED: 5000, GAS_LIMIT: Number(U64_MAX), STATUS: 'valid', BLOCK_INDEX: 1 });
        assert.strictEqual(bound(writes, 'gas_limit'), U64_MAX);
    });
});

// The other writers whose rows a refused action writes with its raw wire value.
const ROW_CASES = [
    { table: 'addresses', writer: 'createAddressOption', field: 'FEE_PREFERENCE',       column: 'fee_preference',
      base: { ACTION: 'ADDRESS', STATUS: 'invalid: FEE_PREFERENCE (invalid)' } },
    { table: 'addresses', writer: 'createAddressOption', field: 'REQUIRE_MEMO',         column: 'require_memo',
      base: { ACTION: 'ADDRESS', STATUS: 'invalid: REQUIRE_MEMO (invalid)' } },
    { table: 'addresses', writer: 'createAddressOption', field: 'DISPENSER_PREFERENCE', column: 'dispenser_preference',
      base: { ACTION: 'ADDRESS', STATUS: 'invalid: DISPENSER_PREFERENCE (invalid)' } },
    { table: 'sweeps', writer: 'createSweep', field: 'BALANCES',   column: 'balances',   base: { ACTION: 'SWEEP', STATUS: 'invalid: BALANCES (format)' } },
    { table: 'sweeps', writer: 'createSweep', field: 'OWNERSHIPS', column: 'ownerships', base: { ACTION: 'SWEEP', STATUS: 'invalid: OWNERSHIPS (format)' } },
    { table: 'sweeps', writer: 'createSweep', field: 'ORDERS',     column: 'orders',     base: { ACTION: 'SWEEP', STATUS: 'invalid: ORDERS (format)' } },
    { table: 'sweeps', writer: 'createSweep', field: 'SWAPS',      column: 'swaps',      base: { ACTION: 'SWEEP', STATUS: 'invalid: SWAPS (format)' } },
    { table: 'sweeps', writer: 'createSweep', field: 'DISPENSERS', column: 'dispensers', base: { ACTION: 'SWEEP', STATUS: 'invalid: DISPENSERS (format)' } },
    { table: 'xcalls', writer: 'createCrossChainCallRequest', field: 'GAS_LIMIT',      column: 'gas_limit',
      base: { ACTION: 'XCALL', CALL_ID: 'a'.repeat(64), STATUS: 'invalid: XCALL v0 must originate from VM emission' } },
    { table: 'xcalls', writer: 'createCrossChainCallRequest', field: 'CROSS_HOPS',     column: 'cross_hops',
      base: { ACTION: 'XCALL', CALL_ID: 'a'.repeat(64), STATUS: 'invalid: XCALL v0 must originate from VM emission' } },
    { table: 'xcalls', writer: 'createCrossChainCallRequest', field: 'DEADLINE_BLOCK', column: 'deadline_block',
      base: { ACTION: 'XCALL', CALL_ID: 'a'.repeat(64), STATUS: 'invalid: XCALL v0 must originate from VM emission' } },
];

describe('refused-action rows bind integer values their columns store @regression @tier1', function () {
    for(const c of ROW_CASES){
        describe(c.table + '.' + c.column, function () {
            for(const wire of ['-1', OVER_U64, '1e30', '99999999999', 'abc', '1', '1.5']){
                it("binds a storable value for " + c.field + "='" + wire + "'", async function () {
                    const { db, writes } = makeWritingDb();
                    await db[c.writer](Object.assign({ ACTION_INDEX: 9, BLOCK_INDEX: 1 }, c.base, { [c.field]: wire }));
                    const value = bound(writes, c.column);
                    assert.ok(columnAccepts(c.table, c.column, value),
                        c.table + '.' + c.column + ' refuses ' + JSON.stringify(value));
                    if(columnAccepts(c.table, c.column, wire))
                        assert.strictEqual(value, wire, 'a value the column stores binds unchanged');
                });
            }
        });
    }
});

describe('Utility.fitIntegerColumn @tier1', function () {
    const cases = [
        ['200000', '200000'], ['-1', '0'], [OVER_U64, U64_MAX], ['1e6', '1e6'], ['1.5', '1.5'],
        ['-0.4', '-0.4'], [U64_MAX + '.4', U64_MAX + '.4'], [U64_MAX + '.5', U64_MAX], ['1e30', U64_MAX],
        ['1e99999999999999999', U64_MAX], ['-1e99999999999999999', '0'], [' 100', ' 100'],
        ['0x10', '16'], ['0b11', '3'], ['0o17', '15'], ['0x' + 'F'.repeat(18), U64_MAX],
        ['abc', null], ['Infinity', null], ['-0x10', null], ['', ''], [null, null],
    ];
    for(const [input, out] of cases){
        it('fits ' + JSON.stringify(input) + ' into BIGINT UNSIGNED as ' + JSON.stringify(out), function () {
            assert.strictEqual(new Utility().fitIntegerColumn(input, '0', U64_MAX), out);
        });
    }

    it('bounds a signed INT on both sides', function () {
        assert.strictEqual(new Utility().fitIntegerColumn('99999999999', '-2147483648', '2147483647'), '2147483647');
        assert.strictEqual(new Utility().fitIntegerColumn('-99999999999', '-2147483648', '2147483647'), '-2147483648');
        assert.strictEqual(new Utility().fitIntegerColumn('-5', '-2147483648', '2147483647'), '-5');
    });
});
