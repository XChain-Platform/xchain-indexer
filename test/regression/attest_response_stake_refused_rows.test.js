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
 * test/regression/attest_response_stake_refused_rows.test.js
 *
 * A STAKE, an ATTEST v1 or v4 response and an ATTEST v5 batch head write their rows whatever
 * the verdict. A STAKE refused for a negative VERSION bound -1 into stakes.version (errno
 * 1264). A refused response bound a 4-byte REQUEST_ID into the utf8mb3 request_id (1366), an
 * absent PROVIDER_ID into the NOT NULL provider_id (1048), a STATUS outside the
 * response_status ENUM (1265) and a META past VARCHAR(256) (1406). A batch head bound a window
 * or anchor past BIGINT UNSIGNED (1264), and a head naming more than one chunk was recorded
 * valid before any quorum read, so anyone could file one. Each halted every indexer on that
 * block, so no indexed history holds one.
 *
 * Two narrowings of the earlier v0 fits: an over-wide VM fee is refused only when the request
 * writer would write the row (it skips a v0 whose id a prior v0 already holds), and refused
 * callback params past the TEXT column only by trailing spaces bind unchanged, as the server
 * cut them before.
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
const { createMockIndexer, createBaseData } = require('../fixtures/mocks');
const { setUpAttestHandler, v1Data, v0FeeData, v0FeeParams } = require('../helpers/attest_fixture.js');
const Attest   = require('../../src/actions/attest/index.js');
const abw      = require('../../src/actions/attest/attest_batch_wire.js');
const Stake    = require('../../src/actions/stake/index.js');
const Utility  = require('../../src/utility');
const Database = require('../../src/db');

const SQL_DIR = path.join(__dirname, '../../src/sql');
const EMOJI   = '\u{1F600}';
const FFFD    = '\u{FFFD}';
const U64_MAX = '18446744073709551615';

// ── Strict-session model ──────────────────────────────────────────────────────

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

// An ENUM bind as the server reads it: excess trailing spaces cut, then an ASCII
// case-insensitive label, else a short decimal read as a 1-based label index.
function enumErrno(labels, raw){
    const s = raw.replace(/ +$/, '');
    if(labels.includes(s.toLowerCase())) return 0;
    if(/^[0-9]{1,5}$/.test(s) && Number(s) >= 1 && Number(s) <= labels.length) return 0;
    return 1265;
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
    const en = /\bENUM\(([^)]*)\)/i.exec(spec);
    if(en) return enumErrno(en[1].split(',').map(l => l.trim().replace(/^'|'$/g, '')), raw);
    const text = /\b(?:VAR)?CHAR\((\d+)\)/i.exec(spec);
    const blob = /\b(MEDIUM)?TEXT\b/i.exec(spec);
    if(text || blob){
        if(isMb3(table, column) && hasSupplementary(raw)) return 1366;
        if(text) return Array.from(raw.replace(/ +$/, '')).length > Number(text[1]) ? 1406 : 0;
        return Buffer.byteLength(raw.replace(/ +$/, ''), 'utf8') > (blob[1] ? 16777215 : 65535) ? 1406 : 0;
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

function strictDb(){
    const util = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config: getTestConfig(), util });
    const state = { rows: {} };
    sinon.stub(db, 'doQuery').callsFake(async (sql, args = []) =>
        /^\s*INSERT INTO/i.test(sql) ? insertRow(state, sql, args) : []);
    for(const [name, id] of [['createStatus', 9], ['getAddressId', 4], ['getOrCreatePubkeyId', 7], ['createTicker', 2]])
        sinon.stub(db, name).resolves(id);
    return { db, state };
}

afterEach(() => sinon.restore());

// ── STAKE rows ────────────────────────────────────────────────────────────────

const VERSION_UNKNOWN = 'invalid: VERSION (unknown)';

async function writeStake(o){
    const { db, state } = strictDb();
    await db.createStake(Object.assign({ ACTION: 'STAKE', ACTION_INDEX: 60, BLOCK_INDEX: 100, SOURCE: 'src',
        SIGNING_PUBKEY: 'a'.repeat(64), AMOUNT: '5', ACTIVATION_BLOCK: 110 }, o));
    return state.rows.stakes;
}

// A STAKE wire through the real handler, its row written by the real writer.
async function stakeThroughHandler(wire){
    const { db, state } = strictDb();
    sinon.stub(db, 'getTokenInfo').resolves(null);
    sinon.stub(db, 'getAddressBalances').resolves([]);
    sinon.stub(db, 'updateBalances').resolves();
    sinon.stub(db, 'updateTokens').resolves();
    sinon.stub(db.util, 'processTransactionLedgerChanges').resolves();
    const config = getTestConfig();
    const handler = new Stake({ config, util: db.util, indexerDb: db, decoderDb: null,
        mapper: { createMappings: async () => {} } });
    const data = { ACTION: 'STAKE', ACTION_INDEX: 60, BLOCK_INDEX: 100, SOURCE: 'src', COIN: 'BTC',
                   FORMAT: db.util.getFormatVersion(wire[0]) };
    await handler.parse(wire, data, null);
    return { data, row: state.rows.stakes };
}

describe('Refused STAKE rows store a version stakes.version can hold @regression @tier1', function () {
    it('STAKE|-1 run through the handler is refused and records version 0', async function () {
        const { data, row } = await stakeThroughHandler(['-1', '5', 'a'.repeat(64)]);
        assert.strictEqual(data.STATUS, VERSION_UNKNOWN);
        assert.strictEqual(row.version, '0');
    });

    it('a refused stake row whose version is negative binds 0', async function () {
        for(const version of [-1, -5, -300])
            assert.strictEqual((await writeStake({ VERSION: version, STATUS: VERSION_UNKNOWN })).version, '0', String(version));
    });

    it('an unknown VERSION the column stores binds unchanged, and an absent or zero one binds 1', async function () {
        assert.strictEqual((await writeStake({ VERSION: 7, STATUS: VERSION_UNKNOWN })).version, 7);
        assert.strictEqual((await writeStake({ VERSION: 255, STATUS: VERSION_UNKNOWN })).version, 255);
        assert.strictEqual((await writeStake({ VERSION: null, STATUS: VERSION_UNKNOWN })).version, 1);
        assert.strictEqual((await writeStake({ VERSION: 0, STATUS: VERSION_UNKNOWN })).version, 1);
    });

    it('a valid stake binds its version unchanged', async function () {
        assert.strictEqual((await writeStake({ VERSION: 2, STATUS: 'valid' })).version, 2);
    });
});

// ── ATTEST v1 / v4 response rows ──────────────────────────────────────────────

const REFUSED = 'invalid: REQUEST_ID (format)';

function responseData(o = {}){
    return Object.assign({ ACTION: 'ATTEST', ACTION_INDEX: 71, BLOCK_INDEX: 100, REQUEST_ID: 'ab'.repeat(32),
        PROVIDER_ID: 'http_get', RESPONSE_PAYLOAD: 'body', RESPONSE_STATUS: 'ok', META: 'm',
        RESPONSE_HASH: 'cd'.repeat(32), VALIDATOR_SIGNATURES: null, STATUS: REFUSED }, o);
}

async function writeResponse(o){
    const { db, state } = strictDb();
    await db.createAttestationResponse(responseData(o));
    return state.rows.attests;
}

describe('Refused ATTEST response rows store within their columns @regression @tier1', function () {
    it('a refused response whose REQUEST_ID carries a 4-byte character stores it as U+FFFD', async function () {
        const row = await writeResponse({ REQUEST_ID: 'AB'.repeat(31) + EMOJI });
        assert.strictEqual(row.request_id, 'ab'.repeat(31) + FFFD);
    });

    it('a refused response with an over-long REQUEST_ID, PROVIDER_ID and META stores each clipped to its column', async function () {
        const row = await writeResponse({ REQUEST_ID: 'ab'.repeat(40), PROVIDER_ID: 'p'.repeat(33), META: EMOJI.repeat(257) });
        assert.strictEqual(row.request_id, 'ab'.repeat(32));
        assert.strictEqual(row.provider_id, 'p'.repeat(32));
        assert.strictEqual(row.meta, EMOJI.repeat(256));
        assert.strictEqual((await writeResponse({ META: 'm'.repeat(250) + ' '.repeat(10) })).meta, 'm'.repeat(250) + ' '.repeat(6));
    });

    it('a refused response with no PROVIDER_ID stores the empty provider', async function () {
        assert.strictEqual((await writeResponse({ PROVIDER_ID: undefined })).provider_id, '');
    });

    it('a refused response whose text fits binds it unchanged', async function () {
        const row = await writeResponse({ REQUEST_ID: 'ab'.repeat(32), PROVIDER_ID: 'p'.repeat(32), META: EMOJI.repeat(256) });
        assert.deepStrictEqual([row.request_id, row.provider_id, row.meta], ['ab'.repeat(32), 'p'.repeat(32), EMOJI.repeat(256)]);
    });

    it('a valid response binds its values unchanged', async function () {
        const row = await writeResponse({ STATUS: 'valid', VALIDATOR_SIGNATURES: '[]' });
        assert.deepStrictEqual([row.request_id, row.provider_id, row.response_status, row.meta],
            ['ab'.repeat(32), 'http_get', 'ok', 'm']);
    });

    it('a user-broadcast v1 carrying every unstorable field is refused before any request lookup and stores its row', async function () {
        const { indexer, handler } = setUpAttestHandler();
        const data = v1Data();
        await handler.parse(['1', 'ab'.repeat(31) + EMOJI, '', 'eA==', 'bogus', 'm'.repeat(300), '1'], data, null);
        assert.strictEqual(data.STATUS, REFUSED);
        assert.ok(indexer.indexerDb.getAttestationRequestById.notCalled);
        const row = await writeResponse(indexer.indexerDb.createAttestationResponse.firstCall.args[0]);
        assert.deepStrictEqual([row.request_id, row.provider_id, row.response_status, row.meta],
            ['ab'.repeat(31) + FFFD, '', null, 'm'.repeat(256)]);
    });
});

describe('Refused ATTEST response rows store a STATUS the response_status ENUM can hold @regression @tier1', function () {
    it('a refused response whose STATUS the ENUM cannot store records NULL', async function () {
        for(const status of ['bogus', '', ' ok', '6', 'ok\t', EMOJI])
            assert.strictEqual((await writeResponse({ RESPONSE_STATUS: status })).response_status, null, JSON.stringify(status));
    });

    it('a refused response whose STATUS is a non-ASCII or zero-index spelling records NULL rather than risk a refused bind', async function () {
        for(const status of ['ÓK', '0', '+3'])
            assert.strictEqual((await writeResponse({ RESPONSE_STATUS: status })).response_status, null, JSON.stringify(status));
    });

    it('a refused response whose STATUS the ENUM stores binds it unchanged', async function () {
        for(const status of ['ok', 'OK', 'no_quorum  ', 'Expired', '3', '00005', null])
            assert.strictEqual((await writeResponse({ RESPONSE_STATUS: status })).response_status, status, JSON.stringify(status));
    });

    it('a refused v4 with an empty STATUS records NULL', async function () {
        assert.strictEqual((await writeResponse({ RESPONSE_STATUS: '', META: null,
            STATUS: 'invalid: STATUS (not a terminal relay status)' })).response_status, null);
    });
});

// ── ATTEST v0 request rows the writer skips or stores ─────────────────────────

// A VM-emitted v0 with a 61-digit zero fee, judged against a strict lookup: `prior` is a v0
// already holding the id, `here` a row already at this action_index.
async function emitWideFee(prior, here){
    const { indexer, handler } = setUpAttestHandler();
    const db = indexer.indexerDb;
    db.attestationRequestRowWrites = Database.prototype.attestationRequestRowWrites;
    db.doQueryStrict = sinon.stub().callsFake(async (sql) =>
        (/WHERE action_index=\?/.test(sql) ? here : /request_id=\? AND version=0/.test(sql) ? prior : false) ? [{ action_index: 5 }] : []);
    const data = v0FeeData();
    await handler.parse(v0FeeParams(data, 'XCHAIN', '0'.repeat(61)), data, null);
    return data;
}

async function writeRefusedRequest(o){
    const { db, state } = strictDb();
    await db.createAttestationRequest(Object.assign({ ACTION: 'ATTEST', ACTION_INDEX: 70, BLOCK_INDEX: 100,
        REQUEST_ID: 'ab'.repeat(32), PROVIDER_ID: 'http_get', REQUEST_PAYLOAD: 'q', CALLBACK_METHOD: 'onResult',
        CALLBACK_PARAMS: '[]', REDUNDANCY: '3', DEADLINE_BLOCK: 150, STATUS: 'invalid: ATTEST v0 must originate from VM emission',
        REQUEST_STATUS: 'rejected', SOURCE: 'src', FEE_PAYER: 'src' }, o));
    return state.rows.attests;
}

describe('An over-wide ATTEST v0 fee is refused only when its row would be written @regression @tier1', function () {
    it('a 61-digit zero fee on an id a prior v0 already holds stays valid, since the writer skips that row', async function () {
        const data = await emitWideFee(true, false);
        assert.strictEqual(data.STATUS, 'valid');
        assert.strictEqual(data.REQUEST_STATUS, 'pending');
    });

    it('a 61-digit zero fee with no prior v0 is refused as (length)', async function () {
        assert.strictEqual((await emitWideFee(false, false)).STATUS, 'invalid: FEE_AMOUNT (length)');
    });

    it('a 61-digit zero fee whose action_index already holds a row is refused as (length), since the writer updates it', async function () {
        assert.strictEqual((await emitWideFee(true, true)).STATUS, 'invalid: FEE_AMOUNT (length)');
    });

    it('a refused v0 whose CALLBACK_PARAMS exceeds the TEXT column only by trailing spaces binds it unchanged', async function () {
        const params = 'x'.repeat(65535) + '   ';
        assert.strictEqual((await writeRefusedRequest({ CALLBACK_PARAMS: params })).callback_params_json, params);
        assert.strictEqual((await writeRefusedRequest({ CALLBACK_PARAMS: 'x'.repeat(65535) + ' y' })).callback_params_json, null);
    });
});

// ── ATTEST v5 batch head rows ─────────────────────────────────────────────────

// One more than BIGINT UNSIGNED holds; Number reads it as 2^64 exactly.
const PAST_U64 = '18446744073709551616';
// The largest double below 2^64, which the column stores.
const TOP_U64_DOUBLE = '18446744073709549568';

function batchHandler(){
    const ix = createMockIndexer();
    ix.config.COIN    = 'DOGE';
    ix.config.NETWORK = 'regtest';
    const db = ix.indexerDb;
    db.createAttestationBatchAction = sinon.stub().resolves();
    db.getAttestBatchChunks         = sinon.stub().resolves([]);
    const handler = new Attest({ config: ix.config, util: ix.util, mapper: ix.mapper,
        decoderDb: ix.decoderDb, indexerDb: db, hubClient: null,
        protocolChanges: { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) } });
    return { handler, db };
}

// A well-formed v5 head naming two chunks, keyed by the window it declares.
function headWire(o = {}){
    const p = Object.assign({ network: 'regtest', start: '1700000000', end: '1700003600', anchor: '900000' }, o);
    const key = abw.computeBatchKey({ network: p.network, window_start: Number(p.start), window_end: Number(p.end) });
    return ['5', key, p.network, p.start, p.end, '3', p.anchor, '0a1b2c3d', '2', 'QUJD'];
}

async function parseHead(o){
    const { handler, db } = batchHandler();
    const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 5, BLOCK_INDEX: 6300000, ACTION_INDEX: 72,
        BLOCK_TIME: 1700004000, COIN: 'DOGE', SOURCE: 'DPubAxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' });
    await handler.parse(headWire(o), data, null);
    const { db: sdb, state } = strictDb();
    let errno = 0;
    try { await sdb.createAttestationBatchAction(db.createAttestationBatchAction.firstCall.args[0]); }
    catch(e){ errno = e.errno; }
    return { data, row: state.rows.attests, errno };
}

describe('An ATTEST v5 head whose window or anchor its columns cannot store is refused @regression @tier1', function () {
    for(const [field, o] of [['WINDOW_START', { start: PAST_U64, end: PAST_U64 }], ['WINDOW_END', { end: '1' + '0'.repeat(25) }],
                             ['BTC_BLOCK_HEIGHT', { anchor: PAST_U64 }]]){
        it('a two-chunk head whose ' + field + ' is past BIGINT UNSIGNED is refused as (format) and stores its row at the bound', async function () {
            const { data, row, errno } = await parseHead(o);
            assert.strictEqual(errno, 0);
            assert.strictEqual(data.STATUS, 'invalid: ' + field + ' (format)');
            const stored = { WINDOW_START: row.batch_window_start, WINDOW_END: row.batch_window_end,
                             BTC_BLOCK_HEIGHT: row.batch_btc_block_height }[field];
            assert.strictEqual(stored, U64_MAX);
        });
    }

    it('a two-chunk head at the largest window and anchor the columns store stays valid and binds them unchanged', async function () {
        const { data, row, errno } = await parseHead({ start: TOP_U64_DOUBLE, end: TOP_U64_DOUBLE, anchor: TOP_U64_DOUBLE });
        assert.strictEqual(data.STATUS, 'valid');
        assert.strictEqual(errno, 0);
        assert.deepStrictEqual([row.batch_window_start, row.batch_window_end, row.batch_btc_block_height],
            [Number(TOP_U64_DOUBLE), Number(TOP_U64_DOUBLE), Number(TOP_U64_DOUBLE)]);
    });

    it('an earlier verdict stands over a window past BIGINT UNSIGNED, and its row stores at the bound', async function () {
        const { data, row, errno } = await parseHead({ network: 'testnet', start: PAST_U64, end: PAST_U64 });
        assert.strictEqual(data.STATUS, 'invalid: NETWORK (batch declares testnet)');
        assert.strictEqual(errno, 0);
        assert.deepStrictEqual([row.batch_window_start, row.batch_window_end], [U64_MAX, U64_MAX]);
    });

    it('a refused head whose window fits binds it unchanged', async function () {
        const { data, row } = await parseHead({ network: 'testnet' });
        assert.strictEqual(data.STATUS, 'invalid: NETWORK (batch declares testnet)');
        assert.deepStrictEqual([row.batch_window_start, row.batch_window_end, row.batch_btc_block_height],
            [1700000000, 1700003600, 900000]);
    });
});
