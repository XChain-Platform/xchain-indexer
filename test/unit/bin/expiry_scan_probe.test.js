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
 ********************************************************************/

// bin/expiry-scan-probe.js prints the plan and wall time of every statement the shipped
// getExpiredItems and findCancelledDispensers issue, and whether the latest-status probe
// reads dispenser_action_action. The stub db carries the REAL DB-layer methods over a
// doQuery that answers EXPLAIN with plan rows and the statement itself with result rows,
// so the test checks the statements the block loop really runs.

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const { getTestConfig } = require('../../fixtures/config');
const Utility      = require('../../../src/utility');
const expiredItems = require('../../../src/db/index_tables/expired_items.js');
const dispensers   = require('../../../src/db/dispensers/index.js');
const { parseArgs, main } = require('../../../bin/expiry-scan-probe.js');

const BIN = path.resolve(__dirname, '../../../bin/expiry-scan-probe.js');

// A fake clock that advances 2 ms per read, so every wall time is a known number.
function stepClock(){
    let t = 0;
    return () => { t += 2; return t; };
}

function planRow(table, key, rows){
    return { id: 1n, select_type: 'PRIMARY', table, type: key ? 'ref' : 'ALL', key, rows: BigInt(rows) };
}

// A db stub over the shipped mixin methods. `dispenserIndexUsed` picks whether the
// cancelled-dispenser plan reports dispenser_action_action on its latest-status probe.
function makeDb(dispenserIndexUsed){
    const statements = [];
    const doQuery = async (sql, args) => {
        statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), args });
        const explain = /^EXPLAIN /.test(sql);
        if(/'order' as type/.test(sql))
            return explain ? [planRow('m', null, 40), planRow('s3', 'order_action_action', 1)]
                           : [{ type: 'order', action_index: 7n, expiration: 100 }];
        if(/dispenser_statuses s3/.test(sql))
            return explain ? [planRow('m', null, 12), planRow('s3', dispenserIndexUsed ? 'dispenser_action_action' : null, 3)]
                           : [{ action_index: 9n, block_index: 10, block_time: 50 }];
        throw new Error('unexpected statement: ' + sql);
    };
    const db = Object.assign({}, expiredItems, dispensers, {
        config: Object.assign({}, getTestConfig(), { NETWORK: 'regtest', COIN: 'BTC', DISPENSER_CLOSE_DELAY: 10 }),
        util: new Utility(getTestConfig()),
        doQuery,
        async protocolTimeForStoredBlock(){ return 50; },
        async getLatestBlockIndex(){ return 20; },
        async getBlockTime(){ return 700; },
    });
    return { db, statements };
}

async function runProbe(argv, dispenserIndexUsed){
    const { db, statements } = makeDb(dispenserIndexUsed);
    let out = '';
    const result = await main(argv, { db, write: text => { out += text; }, clock: stepClock() });
    return { result, out, statements };
}

function registerOutputTests(){
    it('EXPLAINs every statement before running it, through the shipped DB methods', async function(){
        const { statements } = await runProbe([], true);
        const kinds = statements.map(s => (s.sql.startsWith('EXPLAIN ') ? 'explain' : 'run'));
        assert.deepStrictEqual(kinds, ['explain', 'run', 'explain', 'run']);
        assert.strictEqual(statements[0].sql, 'EXPLAIN ' + statements[1].sql, 'the plan is of the exact statement run');
        assert.deepStrictEqual(statements[0].args, statements[1].args);
        assert.deepStrictEqual(statements[1].args, [700, 700, 700], 'getExpiredItems binds the block time per UNION branch');
        assert.match(statements[3].sql, /FROM dispenser_statuses s3 WHERE s3\.dispenser_action_index=m\.action_index/);
    });

    it('prints the plan and wall time of each query, defaulting to the latest block', async function(){
        const { out, result } = await runProbe([], true);
        const lines = out.trimEnd().split('\n');
        assert.strictEqual(lines[0], 'expiry scan probe block_index=20 block_time=700');
        assert.strictEqual(lines[1], 'getExpiredItems total=6.000ms queries=1 results=1');
        assert.strictEqual(lines[2], '  query 1 wall=2.000ms rows=1');
        assert.strictEqual(lines[3], '    plan {"id":"1","select_type":"PRIMARY","table":"m","type":"ALL","key":null,"rows":"40"}');
        assert.ok(lines.includes('findCancelledDispensers total=6.000ms queries=1 results=1'), out);
        assert.strictEqual(lines[lines.length - 1], 'dispenser_action_action lookup in findCancelledDispensers: used by s3');
        assert.deepStrictEqual(result.probes.map(p => p.method), ['getExpiredItems', 'findCancelledDispensers']);
    });

    it('says so when the latest-status probe does not read dispenser_action_action', async function(){
        const { out } = await runProbe(['--block-index', '15', '--block-time', '650'], false);
        assert.match(out, /^expiry scan probe block_index=15 block_time=650$/m);
        assert.match(out, /dispenser_action_action lookup in findCancelledDispensers: NOT used\n$/);
    });

    it('emits the raw result as JSON with --json', async function(){
        const { out } = await runProbe(['--json'], true);
        const parsed = JSON.parse(out);
        assert.strictEqual(parsed.blockIndex, 20);
        assert.deepStrictEqual(parsed.dispenserActionAction, ['s3']);
        assert.strictEqual(parsed.probes[0].calls[0].plan[0].rows, '40');
    });
}

function registerSafetyTests(){
    it('refuses a statement that is not a SELECT before it reaches the database', async function(){
        const { db, statements } = makeDb(true);
        db.getExpiredItems = async function(){ return this.doQuery('DELETE FROM orders', []); };
        await assert.rejects(main([], { db, write: () => {} }), /refuses a non-SELECT statement: DELETE FROM orders/);
        assert.strictEqual(statements.length, 0);
    });

    it('rejects a malformed block argument and an unknown flag', function(){
        assert.throws(() => parseArgs(['--block-index', 'x']), /--block-index needs a non-negative integer/);
        assert.throws(() => parseArgs(['--verbose']), /unknown argument --verbose/);
        assert.deepStrictEqual(parseArgs(['--block-time', '5']), { blockIndex: null, blockTime: 5, json: false });
    });

    it('holds no SQL of its own: every statement comes from the DB layer', function(){
        const code = fs.readFileSync(BIN, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        assert.doesNotMatch(code, /\b(SELECT|EXPLAIN|INSERT|UPDATE|DELETE)\b/);
        assert.doesNotMatch(code, /\bdoQuery(Strict)?\s*\(/);
    });
}

describe('bin/expiry-scan-probe @regression', function(){
    describe('output', registerOutputTests);
    describe('safety', registerSafetyTests);
});
