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
 * test/unit/db_queries.test/schema_parsing.test.js
 *
 * The schema-file parsers: stripSqlLineComments, parseExpectedColumns and
 * parseExpectedIndexes.
 *
 * Part of the Database query suite (see ../db_queries.test.js): real method
 * logic against a stubbed doQuery, no live MariaDB required.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { makeDb } = require('./helpers/db_stub');

afterEach(function () {
    sinon.restore();
});

// ---------------------------------------------------------------------------
// stripSqlLineComments
// ---------------------------------------------------------------------------
describe('Database.stripSqlLineComments() @regression @tier1', function () {
    let db;
    beforeEach(function () { db = makeDb(); });

    it('removes -- comments from SQL', function () {
        const sql = 'SELECT 1 -- this is a comment\nFROM dual';
        const out = db.stripSqlLineComments(sql);
        assert.ok(!out.includes('this is a comment'));
        assert.ok(out.includes('SELECT 1'));
        assert.ok(out.includes('FROM dual'));
    });

    it('preserves content inside single-quoted strings', function () {
        const sql = "SELECT '-- not a comment' FROM t";
        const out = db.stripSqlLineComments(sql);
        assert.ok(out.includes('-- not a comment'), 'string content must be preserved');
    });

    it('preserves content inside double-quoted strings', function () {
        const sql = 'SELECT "-- not a comment" FROM t';
        const out = db.stripSqlLineComments(sql);
        assert.ok(out.includes('-- not a comment'));
    });

    it('preserves content inside backtick identifiers', function () {
        const sql = 'SELECT `-- col` FROM t';
        const out = db.stripSqlLineComments(sql);
        assert.ok(out.includes('-- col'));
    });

    it('removes multiple comment lines', function () {
        const sql = '-- first\nSELECT 1\n-- second\nFROM t';
        const out = db.stripSqlLineComments(sql);
        assert.ok(!out.includes('first'));
        assert.ok(!out.includes('second'));
    });
});

describe('Database.stripSqlLineComments() @regression @tier1', function () {
    let db;
    beforeEach(function () { db = makeDb(); });

    it('handles doubled-quote escape inside string (does not crash)', function () {
        const sql = "SELECT '' FROM t -- comment";
        const out = db.stripSqlLineComments(sql);
        assert.ok(!out.includes('comment'));
    });

    it('removes # comments, which MariaDB honours to end-of-line like --', function () {
        const out = db.stripSqlLineComments('SELECT 1 # this is a comment\nFROM dual');
        assert.ok(!out.includes('this is a comment'));
        assert.ok(out.includes('SELECT 1'));
        assert.ok(out.includes('FROM dual'));
    });

    it('preserves a # inside quoted strings and backtick identifiers', function () {
        assert.ok(db.stripSqlLineComments("SELECT '# not a comment' FROM t").includes('# not a comment'));
        assert.ok(db.stripSqlLineComments('SELECT "# not a comment" FROM t').includes('# not a comment'));
        assert.ok(db.stripSqlLineComments('SELECT `col#1` FROM t').includes('`col#1`'));
    });

    it('copies /* */ block comments through verbatim (a # or -- inside must not eat the */)', function () {
        const sql = '/* see issue #4373 -- and this */ SELECT 1';
        assert.strictEqual(db.stripSqlLineComments(sql), sql);
    });

    it('does not treat an apostrophe in block-comment prose as a quote start', function () {
        const out = db.stripSqlLineComments("/* don't do this */ SELECT 1 -- gone\nSELECT 2");
        assert.ok(!out.includes('gone'));
        assert.ok(out.includes('SELECT 2'));
    });
});

// ---------------------------------------------------------------------------
// parseExpectedColumns
// ---------------------------------------------------------------------------
describe('Database.parseExpectedColumns() @regression @tier1', function () {
    let db;
    beforeEach(function () { db = makeDb(); });

    it('returns null for SQL without a CREATE TABLE ENGINE block', function () {
        const sql = 'SELECT 1';
        assert.strictEqual(db.parseExpectedColumns(sql), null);
    });

    it('parses a simple CREATE TABLE and returns column definitions', function () {
        const sql = [
            'CREATE TABLE `test` (',
            '  `id` INT NOT NULL AUTO_INCREMENT,',
            '  `name` VARCHAR(250) NULL,',
            '  PRIMARY KEY (`id`)',
            ') ENGINE=InnoDB;'
        ].join('\n');
        const cols = db.parseExpectedColumns(sql);
        assert.ok(Array.isArray(cols));
        const id   = cols.find(c => c.name === 'id');
        const name = cols.find(c => c.name === 'name');
        assert.ok(id, 'id column should be parsed');
        assert.strictEqual(id.nullable, false, 'NOT NULL column should have nullable=false');
        assert.ok(name, 'name column should be parsed');
        assert.strictEqual(name.nullable, true, 'NULL column should have nullable=true');
    });

    it('strips inline comments before parsing to avoid phantom columns', function () {
        const sql = [
            'CREATE TABLE `t` (',
            '  `col1` INT NOT NULL, -- 0=foo, 1=bar',
            '  `col2` VARCHAR(10) NULL',
            ') ENGINE=InnoDB;'
        ].join('\n');
        const cols = db.parseExpectedColumns(sql);
        // There must be exactly 2 columns (not phantom ones from the comment)
        assert.ok(cols.length === 2, 'Expected 2 columns, got ' + cols.length);
    });
});

let db;

// ---------------------------------------------------------------------------
// parseExpectedIndexes
// ---------------------------------------------------------------------------
describe('Database.parseExpectedIndexes() @regression @tier1', function () {
    beforeEach(function () { db = makeDb(); });

    it('returns [] when no CREATE INDEX statements found', function () {
        const sql = 'CREATE TABLE t (id INT) ENGINE=InnoDB;';
        assert.deepStrictEqual(db.parseExpectedIndexes(sql, 't'), []);
    });

    it('parses a regular CREATE INDEX', function () {
        const sql = [
            'CREATE TABLE balances (id INT, address_id INT, tick_id INT) ENGINE=InnoDB;',
            'CREATE INDEX idx_addr ON balances (address_id);'
        ].join('\n');
        const idxs = db.parseExpectedIndexes(sql, 'balances');
        assert.strictEqual(idxs.length, 1);
        assert.strictEqual(idxs[0].name, 'idx_addr');
        assert.strictEqual(idxs[0].unique, false);
        assert.deepStrictEqual(idxs[0].columns, ['address_id']);
    });

    it('parses a CREATE UNIQUE INDEX', function () {
        const sql = 'CREATE UNIQUE INDEX uq_addr_tick ON balances (address_id, tick_id);';
        const idxs = db.parseExpectedIndexes(sql, 'balances');
        assert.strictEqual(idxs.length, 1);
        assert.strictEqual(idxs[0].unique, true);
        assert.deepStrictEqual(idxs[0].columns, ['address_id', 'tick_id']);
    });

    it('ignores indexes declared for other tables', function () {
        const sql = 'CREATE INDEX idx_other ON other_table (col1);';
        const idxs = db.parseExpectedIndexes(sql, 'balances');
        assert.strictEqual(idxs.length, 0);
    });

    // The (len) prefix must not be stripped and discarded, or a live
    // aged address(62) UNIQUE index and the declared full-column one would read as
    // identical and prefix drift would be invisible to the reconciler.
    it('captures per-column prefix widths separately from the column names', function () {
        const sql = 'CREATE UNIQUE INDEX address ON index_addresses (address(62));\n' +
                    'CREATE INDEX combo ON index_addresses (a(10), b);';
        const idxs = db.parseExpectedIndexes(sql, 'index_addresses');
        assert.strictEqual(idxs.length, 2);
        assert.deepStrictEqual(idxs[0].columns, ['address']);
        assert.deepStrictEqual(idxs[0].prefixes, [62]);
        assert.deepStrictEqual(idxs[1].columns, ['a', 'b']);
        assert.deepStrictEqual(idxs[1].prefixes, [10, null]);
    });
});

describe('Database.parseExpectedIndexes() @regression @tier1', function () {
    beforeEach(function () { db = makeDb(); });

    // An aged prefixed UNIQUE index matching the declared full-column
    // one by column set must be WARNED about (auditable drift), never DDL'd
    // (the UNIQUE rebuild is deliberately gated manual).
    it('reconcileTableIndexes warns on prefix-width drift without issuing DDL', async function () {
        const warn = sinon.stub(console, 'warn');
        try {
            const dbc = {
                query: sinon.stub().resolves([
                    { INDEX_NAME: 'address', NON_UNIQUE: 0, COLUMN_NAME: 'address', SEQ_IN_INDEX: 1, SUB_PART: 62 },
                    { INDEX_NAME: 'block_index', NON_UNIQUE: 1, COLUMN_NAME: 'block_index', SEQ_IN_INDEX: 1, SUB_PART: null },
                ]),
            };
            await db.reconcileTableIndexes('index_addresses.sql', dbc);
            assert.strictEqual(dbc.query.callCount, 1, 'read-only: no ALTER for a satisfied column set');
            const warned = warn.getCalls().map((c) => c.args.join(' ')).join('\n');
            assert.match(warned, /prefix width/, 'drift must be surfaced');
            assert.match(warned, /address live \(62\) vs declared full-column/);
        } finally {
            warn.restore();
        }
    });

    it('reconcileTableIndexes stays silent when live prefixes match the declaration', async function () {
        const warn = sinon.stub(console, 'warn');
        try {
            const dbc = {
                query: sinon.stub().resolves([
                    { INDEX_NAME: 'address', NON_UNIQUE: 0, COLUMN_NAME: 'address', SEQ_IN_INDEX: 1, SUB_PART: null },
                    { INDEX_NAME: 'block_index', NON_UNIQUE: 1, COLUMN_NAME: 'block_index', SEQ_IN_INDEX: 1, SUB_PART: null },
                ]),
            };
            await db.reconcileTableIndexes('index_addresses.sql', dbc);
            const warned = warn.getCalls().map((c) => c.args.join(' ')).join('\n');
            assert.doesNotMatch(warned, /prefix width/);
        } finally {
            warn.restore();
        }
    });
});

describe('Database.parseExpectedIndexes() @regression @tier1', function () {
    beforeEach(function () { db = makeDb(); });

    // A declared UNIQUE index whose name is already held by a live NON-unique
    // index of the same column set must be WARNED about (uniqueness drift is otherwise
    // invisible and silently degrades ON DUPLICATE KEY UPDATE writers), never DDL'd
    // (we must never DROP an index we did not create).
    it('reconcileTableIndexes warns when a declared UNIQUE name is held by a live non-unique index', async function () {
        const warn = sinon.stub(console, 'warn');
        try {
            const dbc = {
                query: sinon.stub().resolves([
                    // Same NAME and column set as the declared UNIQUE `address`, but NON_UNIQUE.
                    { INDEX_NAME: 'address', NON_UNIQUE: 1, COLUMN_NAME: 'address', SEQ_IN_INDEX: 1, SUB_PART: null },
                    { INDEX_NAME: 'block_index', NON_UNIQUE: 1, COLUMN_NAME: 'block_index', SEQ_IN_INDEX: 1, SUB_PART: null },
                ]),
            };
            await db.reconcileTableIndexes('index_addresses.sql', dbc);
            assert.strictEqual(dbc.query.callCount, 1, 'read-only: never DROP/CREATE an index we did not create');
            const warned = warn.getCalls().map((c) => c.args.join(' ')).join('\n');
            assert.match(warned, /name is already held by non-unique/, 'uniqueness drift must be surfaced');
            assert.match(warned, /index_addresses/);
            assert.match(warned, /address/);
        } finally {
            warn.restore();
        }
    });
});
