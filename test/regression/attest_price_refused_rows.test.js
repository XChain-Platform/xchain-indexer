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
 * test/regression/attest_price_refused_rows.test.js
 *
 * An ATTEST v0 request row and a prices row are written whatever the verdict, with the wire
 * as carried. A refused v0 bound a 4-byte REQUEST_ID to the utf8mb3 single-v0 lookup (errno
 * 1267), an absent PROVIDER_ID to a NOT NULL column (1048), and over-long text to its column
 * (1406). A PRICE whose VERSION was not a number or was negative bound NULL or -1 into
 * prices.version, and a refused v0 batch bound the window header it claimed and round and
 * signature lists past their TEXT columns (1264, 1406). A SLASH resolving an XATTEST slot
 * looked its ROUND_ID up with no format rule ahead (1267). A VM-emitted request whose zero fee
 * was spelled wider than attests.fee_amount passed every rule and failed its insert (1406).
 * Each halted every indexer on that block, so no indexed history holds one.
 *
 * Every write here runs the real row writer against a strict-session model read from the
 * shipped DDL. The controls are values a column stored before: they bind unchanged.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const sinon  = require('sinon');
const mathjs = require('mathjs');

const { getTestConfig } = require('../fixtures/config');
const { setUpAttestHandler, v0FeeData, v0FeeParams } = require('../helpers/attest_fixture.js');
const Price    = require('../../src/actions/price/index.js');
const Utility  = require('../../src/utility');
const Database = require('../../src/db');

const SQL_DIR = path.join(__dirname, '../../src/sql');
const EMOJI   = '\u{1F600}';
const FFFD    = '�';
const U64_MAX = '18446744073709551615';

// ── Strict-session model ──────────────────────────────────────────────────────

// Column definitions and the table's default charset, as the shipped DDL states them.
const schemas = {};
function schema(table){
    if(schemas[table]) return schemas[table];
    const raw = fs.readFileSync(path.join(SQL_DIR, table + '.sql'), 'utf8');
    const cols = Database.prototype.parseExpectedColumns.call(
        { stripSqlLineComments: Database.prototype.stripSqlLineComments }, raw);
    const charset = (/DEFAULT CHARSET=(\w+)/i.exec(raw) || [])[1];
    schemas[table] = { cols: new Map(cols.map(c => [c.name, c.definition])), charset };
    return schemas[table];
}

function isMb3(table, column){
    const s = schema(table);
    return !/utf8mb4/i.test(s.cols.get(column)) && !/utf8mb4/i.test(s.charset);
}

const hasSupplementary = (v) => [...String(v)].some(c => c.codePointAt(0) > 0xFFFF);

function serverError(errno, message){
    const err = new Error('errno ' + errno + ': ' + message);
    err.errno = errno;
    return err;
}

// The errno a strict session raises for this bound value, or 0 when the column stores it.
// A Number binds as its JavaScript text; text columns count code points (excess trailing
// spaces are trimmed with a note) or, for TEXT, UTF-8 bytes.
function rejectErrno(table, column, value){
    const spec = schema(table).cols.get(column);
    assert.ok(spec, table + '.' + column + ' is absent from its schema definition');
    if(value === null || value === undefined)
        return /\bNOT\s+NULL\b/i.test(spec) ? 1048 : 0;
    const raw = String(value);
    const text = /\b(?:VAR)?CHAR\((\d+)\)/i.exec(spec);
    const blob = /\b(MEDIUM)?TEXT\b/i.exec(spec);
    if(text || blob){
        if(isMb3(table, column) && hasSupplementary(raw)) return 1366;
        if(text) return Array.from(raw.replace(/ +$/, '')).length > Number(text[1]) ? 1406 : 0;
        return Buffer.byteLength(raw, 'utf8') > (blob[1] ? 16777215 : 65535) ? 1406 : 0;
    }
    const type = /\b(TINYINT|SMALLINT|MEDIUMINT|INT|BIGINT)\b/i.exec(spec);
    if(!type) return 0;
    if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw.trim())) return 1366;
    const bits = { TINYINT: 8, SMALLINT: 16, MEDIUMINT: 24, INT: 32, BIGINT: 64 }[type[1].toUpperCase()];
    const n  = mathjs.round(mathjs.bignumber(raw.trim()));
    const lo = /\bUNSIGNED\b/i.test(spec) ? mathjs.bignumber(0) : mathjs.bignumber(2).pow(bits - 1).neg();
    const hi = /\bUNSIGNED\b/i.test(spec) ? mathjs.bignumber(2).pow(bits).minus(1) : mathjs.bignumber(2).pow(bits - 1).minus(1);
    return (n.isFinite() && n.gte(lo) && n.lte(hi)) ? 0 : 1264;
}

// INSERT INTO t (cols) VALUES (...): each '?' maps to the next argument, a literal to nothing.
function insertRow(state, sql, args){
    const m = /INSERT INTO (\w+)\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i.exec(sql);
    const columns = m[2].split(',').map(c => c.trim());
    const values  = m[3].split(',').map(v => v.trim());
    const row = {};
    let next = 0;
    columns.forEach((column, i) => { if(values[i] === '?') row[column] = args[next++]; });
    for(const column of Object.keys(row)){
        const errno = rejectErrno(m[1], column, row[column]);
        if(errno) throw serverError(errno, 'strict session refused ' + m[1] + '.' + column);
    }
    state.rows[m[1]] = row;
    return {};
}

// SELECT ... FROM t ... WHERE col = ?: a 4-byte bind against a utf8mb3 column throws.
function selectRows(state, sql, args){
    const from  = /FROM (\w+)/i.exec(sql);
    const where = /WHERE\s+(?:\w+\.)?(\w+)\s*=\s*\?/i.exec(sql);
    state.selects.push({ sql, args });
    if(from && where && schema(from[1]).cols.has(where[1]) && isMb3(from[1], where[1]) && hasSupplementary(args[0]))
        throw serverError(1267, 'Illegal mix of collations');
    return [];
}

function strictDb(){
    const util = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config: getTestConfig(), util });
    const state = { rows: {}, selects: [] };
    sinon.stub(db, 'doQuery').callsFake(async (sql, args = []) =>
        /^\s*INSERT INTO/i.test(sql) ? insertRow(state, sql, args) : selectRows(state, sql, args));
    for(const [name, id] of [['createStatus', 9], ['getAddressId', 4], ['createTicker', 2], ['createAddress', 3],
                             ['createMemo', null], ['createCoin', 5], ['createFiat', 6]])
        sinon.stub(db, name).resolves(id);
    return { db, state };
}

afterEach(() => sinon.restore());

// ── ATTEST v0 request rows ────────────────────────────────────────────────────

const REFUSED = 'invalid: ATTEST v0 must originate from VM emission';

function requestData(o = {}){
    return Object.assign({ ACTION: 'ATTEST', ACTION_INDEX: 70, BLOCK_INDEX: 100, REQUEST_ID: 'ab'.repeat(32),
        PROVIDER_ID: 'http_get', REQUEST_PAYLOAD: 'q', CALLBACK_METHOD: 'onResult', CALLBACK_PARAMS: '[]',
        REDUNDANCY: '3', DEADLINE_BLOCK: 150, FEE_TICK: null, FEE_AMOUNT: null, STATUS: REFUSED,
        REQUEST_STATUS: 'rejected', SOURCE: 'src', FEE_PAYER: 'src' }, o);
}

async function writeRequest(o){
    const { db, state } = strictDb();
    await db.createAttestationRequest(requestData(o));
    return { row: state.rows.attests, state };
}

describe('Refused ATTEST v0 request rows store within their columns @regression @tier1', function () {
    it('a refused v0 whose REQUEST_ID carries a 4-byte character stores it as U+FFFD and looks up that id', async function () {
        const { row, state } = await writeRequest({ REQUEST_ID: 'ab'.repeat(31) + EMOJI });
        assert.strictEqual(row.request_id, 'ab'.repeat(31) + FFFD);
        const lookup = state.selects.find(s => /request_id=\? AND version=0/.test(s.sql));
        assert.strictEqual(lookup.args[0], 'ab'.repeat(31) + FFFD);
    });

    it('a refused v0 with an over-long REQUEST_ID, PROVIDER_ID, CALLBACK_METHOD and FEE_AMOUNT stores each clipped to its column', async function () {
        const { row } = await writeRequest({ REQUEST_ID: 'AB'.repeat(40), PROVIDER_ID: 'p'.repeat(33),
            CALLBACK_METHOD: EMOJI.repeat(65), FEE_AMOUNT: '1'.repeat(61) });
        assert.strictEqual(row.request_id, 'ab'.repeat(32));
        assert.strictEqual(row.provider_id, 'p'.repeat(32));
        assert.strictEqual(row.callback_method, EMOJI.repeat(64));
        assert.strictEqual(row.fee_amount, '1'.repeat(60));
    });

    it('a refused v0 with no PROVIDER_ID stores the empty provider', async function () {
        const { row } = await writeRequest({ PROVIDER_ID: undefined });
        assert.strictEqual(row.provider_id, '');
    });

    it('a refused v0 whose CALLBACK_PARAMS exceeds the TEXT column stores NULL', async function () {
        const { row } = await writeRequest({ CALLBACK_PARAMS: 'x'.repeat(65536) });
        assert.strictEqual(row.callback_params_json, null);
    });

    it('a refused v0 whose text fits its columns binds every value unchanged', async function () {
        const { row } = await writeRequest({ REQUEST_ID: 'AB'.repeat(32), PROVIDER_ID: 'p'.repeat(32),
            CALLBACK_METHOD: EMOJI.repeat(64), CALLBACK_PARAMS: 'x'.repeat(65535), FEE_AMOUNT: '1'.repeat(60) });
        assert.strictEqual(row.request_id, 'ab'.repeat(32));
        assert.strictEqual(row.provider_id, 'p'.repeat(32));
        assert.strictEqual(row.callback_method, EMOJI.repeat(64));
        assert.strictEqual(row.callback_params_json, 'x'.repeat(65535));
        assert.strictEqual(row.fee_amount, '1'.repeat(60));
    });

    it('a valid v0 binds its values unchanged', async function () {
        const { row } = await writeRequest({ STATUS: 'valid', REQUEST_STATUS: 'pending', FEE_TICK: 'XCHAIN', FEE_AMOUNT: '5' });
        assert.deepStrictEqual([row.request_id, row.provider_id, row.callback_method, row.callback_params_json, row.fee_amount],
            ['ab'.repeat(32), 'http_get', 'onResult', '[]', '5']);
    });

    it('a valid v0 whose fee is wider than attests.fee_amount fails its insert, so its verdict must refuse it', async function () {
        await assert.rejects(writeRequest({ STATUS: 'valid', REQUEST_STATUS: 'pending', FEE_TICK: 'XCHAIN', FEE_AMOUNT: '0'.repeat(61) }),
            (e) => e.errno === 1406);
    });
});

describe('ATTEST request lookups never bind an id utf8mb3 cannot hold @regression @tier1', function () {
    it('getAttestationRequestById answers absent for an id with a 4-byte character, without a query', async function () {
        const { db, state } = strictDb();
        assert.strictEqual(await db.getAttestationRequestById('ab' + EMOJI), null);
        assert.strictEqual(state.selects.length, 0);
    });

    it('getAttestationRequestById still queries a 64-hex id', async function () {
        const { db, state } = strictDb();
        assert.strictEqual(await db.getAttestationRequestById('AB'.repeat(32)), null);
        assert.deepStrictEqual(state.selects[0].args, ['ab'.repeat(32)]);
    });
});

describe('A VM-emitted ATTEST v0 whose fee its column cannot store is refused @regression @tier1', function () {
    let indexer, handler;
    beforeEach(() => ({ indexer, handler } = setUpAttestHandler()));

    async function emitWithFee(feeTick, feeAmount){
        const data = v0FeeData();
        await handler.parse(v0FeeParams(data, feeTick, feeAmount), data, null);
        return data;
    }

    it('a zero FEE_AMOUNT of 61 digits is refused as (length) and never enters the pending pool', async function () {
        const data = await emitWithFee('XCHAIN', '0'.repeat(61));
        assert.strictEqual(data.STATUS, 'invalid: FEE_AMOUNT (length)');
        assert.strictEqual(data.REQUEST_STATUS, 'rejected');
        assert.ok(indexer.indexerDb.createEscrow.notCalled);
    });

    it('a zero FEE_AMOUNT of 60 digits, which its column stores, stays valid', async function () {
        const data = await emitWithFee('XCHAIN', '0'.repeat(60));
        assert.strictEqual(data.STATUS, 'valid');
        assert.strictEqual(data.REQUEST_STATUS, 'pending');
    });

    it('an earlier verdict stands over a 61-digit FEE_AMOUNT', async function () {
        const data = await emitWithFee('MYTOKEN', '0'.repeat(61));
        assert.strictEqual(data.STATUS, 'invalid: FEE_TICK (only XCHAIN accepted)');
    });
});

// ── prices rows ───────────────────────────────────────────────────────────────

async function writePrice(o){
    const { db, state } = strictDb();
    await db.createPrice(Object.assign({ ACTION: 'PRICE', ACTION_INDEX: 80, BLOCK_INDEX: 100, SOURCE: 'src',
        VALIDATION_STATUS: 'invalid' }, o));
    return state.rows.prices;
}

// A refused v0 batch as storePriceBatchFields leaves it: the header it claimed, and lists
// only when its body parsed.
function refusedBatch(o = {}){
    return Object.assign({ VERSION: 0, STATUS: 'invalid: batch quorum', ROUND: 900, BATCH_FIRST_ROUND: 900,
        BATCH_LAST_ROUND: 905, ROUND_COUNT: 6, ROUNDS_JSON: '[]', SIGS_JSON: '[]' }, o);
}

function priceHandler(db){
    const config = getTestConfig();
    return new Price({ config, util: db.util, indexerDb: db, decoderDb: null,
        mapper: { createMappings: async () => {} } });
}

describe('Refused PRICE rows store within their columns @regression @tier1', function () {
    for(const [title, version] of [['a VERSION that is not a number', null], ['a VERSION of -1', -1]]){
        it('a PRICE with ' + title + ' records version 255', async function () {
            const row = await writePrice({ VERSION: version, STATUS: 'invalid: VERSION (unknown)' });
            assert.strictEqual(row.version, 255);
        });
    }

    it('PRICE|-1 and PRICE|x run through the handler record version 255', async function () {
        for(const wire of ['-1', 'x']){
            const { db, state } = strictDb();
            const data = { ACTION: 'PRICE', ACTION_INDEX: 80, BLOCK_INDEX: 100, SOURCE: 'src',
                           FORMAT: db.util.getFormatVersion(wire) };
            await priceHandler(db).parse([wire], data, null);
            assert.strictEqual(data.STATUS, 'invalid: VERSION (unknown)');
            assert.strictEqual(state.rows.prices.version, 255, 'PRICE|' + wire);
        }
    });

    it('an unknown VERSION the column stores binds unchanged', async function () {
        const row = await writePrice({ VERSION: 7, STATUS: 'invalid: VERSION (unknown)' });
        assert.strictEqual(row.version, 7);
    });

    it('a v0 batch refused for its window header binds each bound within its column', async function () {
        const row = await writePrice(refusedBatch({ STATUS: 'invalid: invalid FIRST_ROUND', ROUND: -5,
            BATCH_FIRST_ROUND: -5, BATCH_LAST_ROUND: 1e23, ROUND_COUNT: 70000, ROUNDS_JSON: null, SIGS_JSON: null }));
        assert.deepStrictEqual([row.round_number, row.batch_first_round, row.batch_last_round, row.round_count],
            ['0', '0', U64_MAX, '65535']);
    });

    it('a v0 batch refused for its header through the handler stores the window it claimed within its columns', async function () {
        const { db, state } = strictDb();
        const data = { ACTION: 'PRICE', ACTION_INDEX: 80, BLOCK_INDEX: 100, SOURCE: 'src', FORMAT: 0 };
        await priceHandler(db).parse(['0', '-5', '1' + '0'.repeat(22), '1', '70000'], data, null);
        assert.strictEqual(data.STATUS, 'invalid: invalid FIRST_ROUND');
        const row = state.rows.prices;
        assert.deepStrictEqual([row.round_number, row.batch_first_round, row.batch_last_round, row.round_count],
            ['0', '0', U64_MAX, '65535']);
    });

    it('a refused v0 batch whose round or signature list exceeds its TEXT column stores NULL for it', async function () {
        const row = await writePrice(refusedBatch({ ROUNDS_JSON: 'r'.repeat(65536), SIGS_JSON: 's'.repeat(65536) }));
        assert.strictEqual(row.rounds_json, null);
        assert.strictEqual(row.sigs_json, null);
    });

    it('a refused v0 batch whose header and lists fit binds them unchanged', async function () {
        const row = await writePrice(refusedBatch({ ROUNDS_JSON: 'r'.repeat(65535) }));
        assert.deepStrictEqual([row.version, row.round_number, row.batch_first_round, row.batch_last_round,
            row.round_count, row.rounds_json, row.sigs_json], [0, 900, 900, 905, 6, 'r'.repeat(65535), '[]']);
    });

    it('a valid v0 batch binds its values unchanged', async function () {
        const row = await writePrice(refusedBatch({ STATUS: 'valid', VALIDATION_STATUS: 'valid' }));
        assert.deepStrictEqual([row.version, row.round_number, row.batch_first_round, row.batch_last_round,
            row.round_count, row.rounds_json, row.sigs_json], [0, 900, 900, 905, 6, '[]', '[]']);
    });
});
