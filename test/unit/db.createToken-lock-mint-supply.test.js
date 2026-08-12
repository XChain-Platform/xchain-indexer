/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/db.createToken-lock-mint-supply.test.js
 *
 * createToken() wrote six of the seven token locks and silently dropped
 * LOCK_MINT_SUPPLY, so tokens.lock_mint_supply sat at its column default on every
 * chain and every read API (explorer/SDK `locks.mint_supply`, and through it the
 * wallet mint form and lock matrix) reported the seventh lock unset even where the
 * chain enforces it. Consensus was never affected (issue.js re-folds the `issues`
 * rows), so these tests pin the READ MODEL: all seven locks must reach the tokens
 * row on both the INSERT and the UPDATE path, positionally bound to the right
 * column, plus the one-time backfill that repairs already-issued tokens.
 *
 * Technique: stub doQuery and read back the emitted SQL + args, matching each lock
 * to its own placeholder by column position rather than trusting arity alone (a
 * column/arg misalignment writes the WRONG lock's value and is the failure this
 * class of bug actually produces).
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

// The seven token locks, in wire order (xchain-sdk ISSUE serialization).
const ALL_LOCKS = [
    'lock_max_supply',
    'lock_mint',
    'lock_mint_supply',
    'lock_max_mint',
    'lock_description',
    'lock_sleep',
    'lock_callback'
];

function makeDb() {
    const config = getTestConfig();
    const util   = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    db.pool = { getConnection: sinon.stub().resolves({
        query:   sinon.stub().resolves([]),
        release: sinon.stub().resolves()
    }) };
    sinon.stub(db, 'createTicker').resolves(1);
    sinon.stub(db, 'createAddress').resolves(2);
    return db;
}

// Run createToken against a stubbed DB and hand back the emitted (sql, args).
// `existsRows` non-empty drives the UPDATE branch, empty the INSERT branch.
async function runCreateToken(data, existsRows) {
    const db = makeDb();
    const dq = sinon.stub(db, 'doQuery');
    dq.onCall(0).resolves(existsRows || []);
    dq.onCall(1).resolves([]);
    await db.createToken(Object.assign({
        ACTION_INDEX: 20, TICK: 'FOO', OWNER: 'addr1', SUPPLY: '100', DECIMALS: '8',
        MAX_SUPPLY: '1000', MAX_MINT: '10', MINT_SUPPLY: '0'
    }, data));
    return { sql: String(dq.args[1][0]), args: dq.args[1][1] };
}

// Every lock flag set - the shape a real "lock it all down" ISSUE produces.
const ALL_SET = {
    LOCK_MAX_SUPPLY: 1, LOCK_MINT: 1, LOCK_MINT_SUPPLY: 1, LOCK_MAX_MINT: 1,
    LOCK_DESCRIPTION: 1, LOCK_SLEEP: 1, LOCK_CALLBACK: 1
};
const NONE_SET = {
    LOCK_MAX_SUPPLY: 0, LOCK_MINT: 0, LOCK_MINT_SUPPLY: 0, LOCK_MAX_MINT: 0,
    LOCK_DESCRIPTION: 0, LOCK_SLEEP: 0, LOCK_CALLBACK: 0
};

// Positional binding helpers: map a column name to its ? index in the statement.

// INSERT: the args line up with the column list inside `INSERT INTO tokens ( ... )`.
function insertColumns(sql) {
    const m = sql.match(/INSERT\s+INTO\s+tokens\s*\(([\s\S]*?)\)\s*values/i);
    assert.ok(m, 'expected an INSERT INTO tokens (...) values (...) statement');
    return m[1].split(',').map(s => s.trim()).filter(Boolean);
}

// UPDATE: the args line up with the `col=?` assignments in the SET clause.
function updateSetColumns(sql) {
    const m = sql.match(/SET([\s\S]*?)WHERE/i);
    assert.ok(m, 'expected an UPDATE ... SET ... WHERE statement');
    return (m[1].match(/([a-z_]+)\s*=\s*\?/gi) || []).map(s => s.split('=')[0].trim());
}

afterEach(function () {
    sinon.restore();
});

describe('Database.createToken() token locks @regression @tier1', function () {

    it('INSERT writes all seven locks, each bound to its own column', async function () {
        const { sql, args } = await runCreateToken(ALL_SET, []);
        const cols = insertColumns(sql);
        for(const lock of ALL_LOCKS){
            const idx = cols.indexOf(lock);
            assert.ok(idx >= 0, 'INSERT column list is missing ' + lock);
            assert.strictEqual(args[idx], 1,
                lock + ' must bind the value 1 at its column position (got ' + args[idx] + ')');
        }
    });

    it('UPDATE writes all seven locks, each bound to its own SET assignment', async function () {
        const { sql, args } = await runCreateToken(ALL_SET, [{ id: 5 }]);
        const cols = updateSetColumns(sql);
        for(const lock of ALL_LOCKS){
            const idx = cols.indexOf(lock);
            assert.ok(idx >= 0, 'UPDATE SET clause is missing ' + lock);
            assert.strictEqual(args[idx], 1,
                lock + ' must bind the value 1 at its SET position (got ' + args[idx] + ')');
        }
    });

    it('an unset LOCK_MINT_SUPPLY still writes 0 (no column-default drift)', async function () {
        for(const rows of [[], [{ id: 5 }]]){
            const { sql, args } = await runCreateToken(NONE_SET, rows);
            const cols = rows.length ? updateSetColumns(sql) : insertColumns(sql);
            assert.strictEqual(args[cols.indexOf('lock_mint_supply')], 0);
        }
    });

    it('a missing LOCK_MINT_SUPPLY key coerces to 0, like the other six', async function () {
        const { sql, args } = await runCreateToken({}, []);
        const cols = insertColumns(sql);
        for(const lock of ALL_LOCKS)
            assert.strictEqual(args[cols.indexOf(lock)], 0, lock + ' should coerce to 0 when absent');
    });

    it('only an exact 1 sets the lock (a truthy non-1 does not)', async function () {
        const { sql, args } = await runCreateToken({ LOCK_MINT_SUPPLY: 'yes' }, []);
        const cols = insertColumns(sql);
        assert.strictEqual(args[cols.indexOf('lock_mint_supply')], 0);
    });

    it('INSERT column count, placeholder count and arg count all agree', async function () {
        const { sql, args } = await runCreateToken(ALL_SET, []);
        const cols   = insertColumns(sql);
        const values = sql.match(/values\s*\(([^)]*)\)/i);
        assert.ok(values, 'expected a values (...) list');
        const placeholders = (values[1].match(/\?/g) || []).length;
        assert.strictEqual(placeholders, cols.length,
            'placeholder count (' + placeholders + ') must match column count (' + cols.length + ')');
        assert.strictEqual(args.length, cols.length,
            'arg count (' + args.length + ') must match column count (' + cols.length + ')');
    });

    it('UPDATE SET placeholder count matches its args (tick_id is the trailing WHERE arg)', async function () {
        const { sql, args } = await runCreateToken(ALL_SET, [{ id: 5 }]);
        const cols  = updateSetColumns(sql);
        const where = (sql.match(/WHERE[\s\S]*$/i)[0].match(/\?/g) || []).length;
        assert.strictEqual(args.length, cols.length + where);
    });
});

describe('tokens.lock_mint_supply backfill migration @regression @tier1', function () {
    const FILE = '2026-07-26-tokens-backfill-lock-mint-supply.sql';
    const MIG  = path.join(__dirname, '..', '..', 'src', 'sql', 'migrations', FILE);

    it('the backfill migration is committed', function () {
        assert.ok(fs.existsSync(MIG), 'expected ' + MIG);
    });

    it('is gated mode=manual (the runner refuses a bare UPDATE on the auto path)', function () {
        const raw  = fs.readFileSync(MIG, 'utf8');
        const mode = Database.prototype._migrationMode.call({}, raw);
        assert.strictEqual(mode, 'manual');
        // Guard the reason it must be manual: the auto-apply classifier flags this UPDATE.
        const stmts = Database.prototype.splitSqlStatements.call(Database.prototype, raw);
        assert.ok(Database.prototype._destructiveAutoStatement.call(Database.prototype, stmts),
            'a data-backfill UPDATE must be rejected by the auto-apply guard');
    });

    it('repairs tokens.lock_mint_supply from the valid issues rows and never clears it', function () {
        const raw   = fs.readFileSync(MIG, 'utf8');
        const stmts = Database.prototype.splitSqlStatements.call(Database.prototype, raw);
        assert.strictEqual(stmts.length, 1, 'the backfill should be a single statement');
        const sql = stmts[0].replace(/\s+/g, ' ');
        assert.ok(/UPDATE\s+tokens/i.test(sql), 'must target the tokens table');
        assert.ok(/SET\s+t\.lock_mint_supply\s*=\s*1/i.test(sql),
            'must set lock_mint_supply, and only ever to 1 (a lock never unsets)');
        assert.ok(/FROM\s+issues/i.test(sql), 'must derive the value from the issues rows');
        assert.ok(/status\s*=\s*'valid'/i.test(sql), 'must only fold VALID issues, like getTokenInfo()');
        assert.ok(/lock_mint_supply\s*<>\s*1/i.test(sql), 'must be re-runnable (idempotent WHERE guard)');
        assert.ok(!/lock_mint_supply\s*=\s*0/i.test(sql), 'must never clear the lock');
    });
});
