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
 * test/unit/db.rollcalls-public-reads.test.js
 *
 * Two plain public BTC-indexer reads over the roll-call tables (validator
 * liveness eviction spec, D97): db.getRollcalls (JSON-RPC getrollcalls) and
 * db.getRollcallAbsencesBySource (JSON-RPC getrollcallabsences). The writer
 * (rollcall_close.js) and the tables are already landed; this file proves
 * only the read side: the limit clamp, the DESC ordering, the absent_count
 * correlation, and the unknown-source empty answer.
 *
 * Mock-based (doQuery stubbed), matching db.swq-source-cap.test.js: the SQL
 * shape and bound args are asserted directly against the captured query, the
 * same convention api-federation-read-isolation.test.js uses at the api.js
 * layer (source-scan, since startApi() is not importable without opening DB
 * connections). A second describe block below source-scans src/api.js for
 * the two new handlers.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

// getTestConfig() force-sets INDEXER_COIN and returns the config module's
// single cached object, shared by every caller in the process. Give each
// test a shallow copy so a mutation here (NETWORK/COIN below) cannot leak
// into a later test in this file or another file run in the same process.
function dbFor(rows) {
    const config = Object.assign({}, getTestConfig());
    config.NETWORK = 'regtest';
    config.COIN    = 'BTC';
    const util = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    const calls = [];
    // Both reads run through doQueryStrict, not doQuery, and stubbing the wrong
    // one is not a harmless mismatch: doQuery swallows a query error into [] and
    // the whole point of these two reads is that they must not do that.
    sinon.stub(db, 'doQueryStrict').callsFake((query, args) => {
        calls.push({ query, args });
        if (rows instanceof Error) return Promise.reject(rows);
        return Promise.resolve(typeof rows === 'function' ? rows(calls.length) : (rows || []));
    });
    db._calls = calls;
    return db;
}

afterEach(function () { sinon.restore(); });

describe('getRollcalls (JSON-RPC getrollcalls, BTC public read) @regression @tier1', function () {

    it('defaults to limit 20 when no limit is given', async function () {
        const db = dbFor([]);
        await db.getRollcalls(undefined);
        assert.strictEqual(db._calls[0].args[0], 20, 'unbounded limit falls back to the default');
    });

    it('defaults to 20 for a non-numeric limit rather than erroring', async function () {
        const db = dbFor([]);
        const out = await db.getRollcalls('not-a-number');
        assert.strictEqual(db._calls[0].args[0], 20, 'non-numeric limit takes the default');
        assert.deepStrictEqual(out, [], 'no error is thrown for a bad limit');
    });

    it('defaults to 20 for limit <= 0', async function () {
        const db = dbFor([]);
        await db.getRollcalls(0);
        assert.strictEqual(db._calls[0].args[0], 20, 'limit=0 is not a valid page size');
        const db2 = dbFor([]);
        await db2.getRollcalls(-5);
        assert.strictEqual(db2._calls[0].args[0], 20, 'a negative limit falls back to the default');
    });

    it('clamps a limit above 100 down to 100', async function () {
        const db = dbFor([]);
        await db.getRollcalls(9999);
        assert.strictEqual(db._calls[0].args[0], 100, 'limit is capped at 100');
    });

    it('passes an in-range limit straight through', async function () {
        const db = dbFor([]);
        await db.getRollcalls(37);
        assert.strictEqual(db._calls[0].args[0], 37);
    });

    it('orders by epoch_height DESC and never selects responsible_set_json', async function () {
        const db = dbFor([]);
        await db.getRollcalls(20);
        const { query } = db._calls[0];
        assert.match(query, /ORDER BY r\.epoch_height DESC/, 'must order newest epoch first');
        assert.doesNotMatch(query, /responsible_set_json/,
            'responsible_set_json pins K-streak membership and must never reach the public read');
    });

    it('absent_count is a correlated subquery keyed on THIS row\'s epoch_height', function () {
        // Static check on the query text: the correlation is what makes an
        // UNROLLED epoch (no absences by construction) read back 0 rather than
        // some other epoch's count, or the whole table's count.
        const db = dbFor([]);
        return db.getRollcalls(20).then(() => {
            const { query } = db._calls[0];
            assert.match(query, /SELECT COUNT\(\*\) FROM rollcall_absences ra\s+WHERE ra\.epoch_height = r\.epoch_height/,
                'absent_count must be COUNT(*) correlated on epoch_height, not a global or mis-keyed count');
        });
    });

    it('passes rows through unmodified (0 for unrolled, correct count for rolled)', async function () {
        const rows = [
            { epoch_height: 300, snapshot_block: 290, close_block: 306, rolled: 1, absent_count: 3 },
            { epoch_height: 200, snapshot_block: 190, close_block: 206, rolled: 0, absent_count: 0 }
        ];
        const db = dbFor(rows);
        const out = await db.getRollcalls(20);
        assert.deepStrictEqual(out, rows);
        assert.strictEqual(out[1].rolled, 0);
        assert.strictEqual(out[1].absent_count, 0, 'an unrolled epoch has no absences by construction');
        assert.strictEqual(out[0].absent_count, 3);
    });

    // Found by driving the read against the real regtest BTC indexer before the
    // roll-call migration had been applied there: doQuery logged
    // ER_NO_SUCH_TABLE and returned rows=0, which this surface would have served
    // as a cheerful "no epoch has closed yet". The dashboard's only detector for
    // a federation that has stopped rolling treats an empty list as silence, so
    // a broken read and a healthy rail would have been the same answer.
    it('lets a query error propagate rather than serving it as an empty history', async function () {
        const db = dbFor(Object.assign(new Error('Table xchain.rollcalls doesn\'t exist'), { errno: 1146, code: 'ER_NO_SUCH_TABLE' }));
        await assert.rejects(
            () => db.getRollcalls(20),
            /doesn't exist/,
            'a DB fault must reach the caller, never collapse into "no roll calls"'
        );
    });

    it('reads through doQueryStrict, the variant that does not collapse an error into []', function () {
        const src = fs.readFileSync(path.join(__dirname, '../../src/db.js'), 'utf8');
        const body = src.match(/async getRollcalls\(limit\)\{[\s\S]*?\n    \}/);
        assert.ok(body, 'getRollcalls must still be findable in db.js');
        assert.match(body[0], /this\.doQueryStrict\(/, 'getRollcalls must not fall back to doQuery');
        assert.doesNotMatch(body[0], /this\.doQuery\(/, 'getRollcalls must not use the error-swallowing variant');
    });
});

describe('getRollcallAbsencesBySource (JSON-RPC getrollcallabsences, BTC public read) @regression @tier1', function () {

    it('returns {absences: []} for an unknown/unresolvable source, without erroring', async function () {
        const db = dbFor([{ epoch_height: 1, source: 'should-not-be-reached', close_block: 1, evicted: 0 }]);
        sinon.stub(db, 'getAddressId').resolves(null);
        const out = await db.getRollcallAbsencesBySource('bc1qsomeneveraddress', 20);
        assert.deepStrictEqual(out, [], 'unresolvable source must yield an empty list, not an error');
        assert.strictEqual(db._calls.length, 0, 'an unresolved source must never reach the absences SELECT');
    });

    it('resolves the source to source_id and queries by id', async function () {
        const db = dbFor([]);
        sinon.stub(db, 'getAddressId').resolves(42);
        await db.getRollcallAbsencesBySource('bc1qsomevalidatoraddress', 20);
        const { query, args } = db._calls[0];
        assert.match(query, /WHERE a\.source_id = \?/, 'must filter by the resolved internal id');
        assert.strictEqual(args[0], 42, 'source_id is the first bound arg');
    });

    it('joins back to index_addresses so the response carries the address string, not the id', async function () {
        const db = dbFor([]);
        sinon.stub(db, 'getAddressId').resolves(42);
        await db.getRollcallAbsencesBySource('bc1qsomevalidatoraddress', 20);
        const { query } = db._calls[0];
        assert.match(query, /ia\.address AS source/, 'source in each row must be the resolved address string');
        assert.match(query, /INNER JOIN index_addresses ia ON \(ia\.id = a\.source_id\)/);
    });

    it('orders by epoch_height DESC', async function () {
        const db = dbFor([]);
        sinon.stub(db, 'getAddressId').resolves(42);
        await db.getRollcallAbsencesBySource('bc1qsomevalidatoraddress', 20);
        assert.match(db._calls[0].query, /ORDER BY a\.epoch_height DESC/);
    });

    it('defaults to limit 20, clamped to [1,100], same as getrollcalls', async function () {
        const db1 = dbFor([]);
        sinon.stub(db1, 'getAddressId').resolves(42);
        await db1.getRollcallAbsencesBySource('addr', undefined);
        assert.strictEqual(db1._calls[0].args[1], 20, 'default limit');

        const db2 = dbFor([]);
        sinon.stub(db2, 'getAddressId').resolves(42);
        await db2.getRollcallAbsencesBySource('addr', 0);
        assert.strictEqual(db2._calls[0].args[1], 20, 'limit=0 falls back to default');

        const db3 = dbFor([]);
        sinon.stub(db3, 'getAddressId').resolves(42);
        await db3.getRollcallAbsencesBySource('addr', 5000);
        assert.strictEqual(db3._calls[0].args[1], 100, 'limit clamps to 100');

        const db4 = dbFor([]);
        sinon.stub(db4, 'getAddressId').resolves(42);
        await db4.getRollcallAbsencesBySource('addr', 'garbage');
        assert.strictEqual(db4._calls[0].args[1], 20, 'non-numeric limit takes the default rather than erroring');
    });

    it('rolls evicted through as 0 or 1 as stored, rows unmodified', async function () {
        const rows = [
            { epoch_height: 900, source: 'bc1qEVICTED', close_block: 906, evicted: 1 },
            { epoch_height: 800, source: 'bc1qEVICTED', close_block: 806, evicted: 0 }
        ];
        const db = dbFor(rows);
        sinon.stub(db, 'getAddressId').resolves(7);
        const out = await db.getRollcallAbsencesBySource('bc1qEVICTED', 20);
        assert.deepStrictEqual(out, rows);
    });

    // The dangerous reading this protects: an operator checks `validator status`,
    // the query fails, and they are told they have no absences on record. That is
    // the answer that makes them stop worrying, so it must never come from a fault.
    it('lets a query error propagate rather than reporting a clean record', async function () {
        const db = dbFor(Object.assign(new Error('Table xchain.rollcall_absences doesn\'t exist'), { errno: 1146, code: 'ER_NO_SUCH_TABLE' }));
        sinon.stub(db, 'getAddressId').resolves(7);
        await assert.rejects(
            () => db.getRollcallAbsencesBySource('bc1qEVICTED', 20),
            /doesn't exist/,
            'a DB fault must reach the caller, never collapse into "no absences"'
        );
    });

    it('reads through doQueryStrict, the variant that does not collapse an error into []', function () {
        const src = fs.readFileSync(path.join(__dirname, '../../src/db.js'), 'utf8');
        const body = src.match(/async getRollcallAbsencesBySource\(source, limit\)\{[\s\S]*?\n    \}/);
        assert.ok(body, 'getRollcallAbsencesBySource must still be findable in db.js');
        assert.match(body[0], /this\.doQueryStrict\(/, 'the absences read must not fall back to doQuery');
        assert.doesNotMatch(body[0], /this\.doQuery\(/, 'the absences read must not use the error-swallowing variant');
    });
});

// ---------------------------------------------------------------------------
// src/api.js: static source-scan, the same technique
// api-federation-read-isolation.test.js uses (startApi() opens real DB
// connections, so it is not importable / invokable here). Confirms the two
// new methods exist, are wired as PLAIN reads (never added to the
// federation/write/gated-exec gates), route through apiView(), and return
// exactly the response shape the spec calls for.
// ---------------------------------------------------------------------------
describe('api.js getrollcalls / getrollcallabsences wiring (source-scan) @regression @tier1', function () {
    const API_SRC = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');

    function extractHandlerBodies(src) {
        const decl = /\n {8}async\s+(\w+)\s*\(/g;
        const starts = [];
        let m;
        while ((m = decl.exec(src)) !== null) starts.push({ name: m[1], index: m.index });
        const bodies = {};
        for (let i = 0; i < starts.length; i++) {
            const end = (i + 1 < starts.length) ? starts[i + 1].index : src.length;
            bodies[starts[i].name] = src.slice(starts[i].index, end);
        }
        return bodies;
    }

    function parseSet(src, name) {
        const m = src.match(new RegExp('const\\s+' + name + '\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)'));
        assert.ok(m, name + ' not found in src/api.js');
        const names = [];
        const re = /['"]([a-z0-9_]+)['"]/gi;
        let hit;
        while ((hit = re.exec(m[1])) !== null) names.push(hit[1]);
        return names;
    }

    const bodies = extractHandlerBodies(API_SRC);

    it('getrollcalls and getrollcallabsences have handlers in the controller', function () {
        assert.ok(bodies['getrollcalls'], 'no getrollcalls handler found');
        assert.ok(bodies['getrollcallabsences'], 'no getrollcallabsences handler found');
    });

    it('neither method is gated (plain public reads, not federation reads)', function () {
        const federation = parseSet(API_SRC, 'FEDERATION_READ_METHODS');
        const writes      = parseSet(API_SRC, 'WRITE_METHODS');
        const gatedExec    = parseSet(API_SRC, 'GATED_EXEC_METHODS');
        for (const name of ['getrollcalls', 'getrollcallabsences']) {
            assert.ok(!federation.includes(name), name + ' must not be a federation-gated read');
            assert.ok(!writes.includes(name), name + ' must not be a gated write');
            assert.ok(!gatedExec.includes(name), name + ' must not be a gated exec method');
        }
    });

    it('both resolve their DB through apiView(), like every other read here', function () {
        assert.match(bodies['getrollcalls'], /\.apiView\(\)/);
        assert.match(bodies['getrollcallabsences'], /\.apiView\(\)/);
    });

    it('both clamp limit to a default of 20 and a cap of 100', function () {
        for (const name of ['getrollcalls', 'getrollcallabsences']) {
            const body = bodies[name];
            assert.match(body, /if\(!Number\.isFinite\(max\) \|\| max <= 0\) max = 20;/,
                name + ' must default an absent/non-numeric/non-positive limit to 20');
            assert.match(body, /if\(max > 100\) max = 100;/,
                name + ' must clamp limit to at most 100');
        }
    });

    it('getrollcalls returns exactly {rollcalls: [...]}', function () {
        assert.match(bodies['getrollcalls'], /return \{ rollcalls: rows \};/);
    });

    it('getrollcallabsences returns exactly {absences: [...]}', function () {
        assert.match(bodies['getrollcallabsences'], /return \{ absences: rows \};/);
    });

    it('getrollcalls delegates to db.getRollcalls and getrollcallabsences to db.getRollcallAbsencesBySource', function () {
        assert.match(bodies['getrollcalls'], /db\.getRollcalls\(max\)/);
        assert.match(bodies['getrollcallabsences'], /db\.getRollcallAbsencesBySource\(source, max\)/);
    });
});
