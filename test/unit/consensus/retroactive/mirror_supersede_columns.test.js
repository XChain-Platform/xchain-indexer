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
 *
 * A superseding checkpoint keeps supersedes_from and rules_digest in the mirror.
 *
 * The hub marks the checkpoint that follows a retroactive rules replay with the
 * first replaced height (supersedes_from) and the applied-rules digest
 * (rules_digest). Readers decide "superseded" from those two fields alone, so a
 * mirror that drops them reports every replaced checkpoint as still current.
 *
 * The mirror applier is schema-driven: applyRow keeps only the incoming fields
 * the LOCAL table reports through SHOW COLUMNS, then writes a plain INSERT IGNORE
 * (src/hub/hub_db_sync/row_apply.js, row_upserts.js). No table-specific code
 * names these columns, so the local schema is the whole change, and this suite
 * proves it on a real SQL engine rather than on a stubbed write:
 *
 *   SCHEMA   - a fresh table from src/sql/state_checkpoints.sql and a long-lived
 *              table taken through the shipped dated migration end with the same
 *              column set, both columns included.
 *   APPLY    - the real HubDbSync.applyRow, over a hubDb that answers SHOW COLUMNS
 *              from the table itself and runs the emitted INSERT IGNORE, lands a
 *              hub-served superseding row with both fields, on both schemas.
 *   CONTROL  - the same apply against the pre-migration table lands the row
 *              without them, so the assertions above can fail.
 *
 * node:sqlite stands in for MariaDB (test/helpers/sqlMigrationDb.js). Column
 * names and the NULL contract survive its DDL translation, which is all the
 * column filter and the read-back observe.
 *
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const HubDbSync = require('../../../../src/hub/hub_db_sync.js');
const { toSqlite, migrationStatements, MIG_DIR } = require('../../../helpers/sqlMigrationDb.js');

const TABLE     = 'state_checkpoints';
const MIGRATION = '2026-10-25-state-checkpoints-supersede-columns.sql';
const FRESH_DDL = fs.readFileSync(path.join(MIG_DIR, '..', TABLE + '.sql'), 'utf8');
const COLUMNS   = ['supersedes_from', 'rules_digest'];

// The superseding row as the hub serves it: a wire id the mirror never stores, every
// NOT NULL column populated (sqlite's OR IGNORE would otherwise drop a short row
// silently), and the hub-only anchor_txid audit column the mirror does not carry.
const SUPERSEDING = {
    id:                   9041,
    chain:                'LTC',
    network:              'regtest',
    block_index:          8100,
    block_hash:           '1'.repeat(64),
    ledger_hash:          '2'.repeat(64),
    actions_hash:         '3'.repeat(64),
    contract_hash:        '4'.repeat(64),
    checkpoint_seq:       812,
    snapshot_block:       812,
    supersedes_from:      8042,
    rules_digest:         'ab'.repeat(32),
    state_root:           '5'.repeat(64),
    state_root_version:   1,
    validator_signatures: '[{"pubkey":"02aa","sig":"30"}]',
    anchor_txid:          'f'.repeat(64)
};

// sqlite has no inline index clause: the content UNIQUE key is kept (INSERT IGNORE
// dedupes on it) and the plain KEY is dropped, since indexes change plans, never rows.
function sqliteTableDdl(ddl) {
    return toSqlite(ddl)
        .replace(/\bUNIQUE\s+KEY\s+\w+\s*\(/gi, 'UNIQUE (')
        .replace(/,\s*KEY\s+\w+\s*\([^)]*\)/gi, '');
}

// The shipped migration's ADD COLUMN clauses, from the runner's own statement split.
function migrationClauses() {
    const clauses = [];
    for (const stmt of migrationStatements(MIGRATION)) {
        const head = /^\s*ALTER\s+TABLE\s+(\w+)\s+([\s\S]+?)\s*;?\s*$/i.exec(stmt);
        assert.ok(head && head[1] === TABLE, 'unexpected statement in ' + MIGRATION + ': ' + stmt);
        for (const part of head[2].split(/,\s*(?=ADD\s+COLUMN\b)/i)) {
            const m = /^ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+`?(\w+)`?\s+([\s\S]+?)(?:\s+AFTER\s+`?\w+`?)?\s*$/i.exec(part.trim());
            assert.ok(m, 'unexpected clause in ' + MIGRATION + ': ' + part);
            clauses.push({ name: m[1], definition: m[2] });
        }
    }
    return clauses;
}

// One ADD COLUMN per ALTER (sqlite takes no list and no AFTER), skipped when the
// column exists, which is the migration's own IF NOT EXISTS contract.
function applyMigration(db) {
    for (const clause of migrationClauses()) {
        const present = db.prepare('PRAGMA table_info(' + TABLE + ')').all().some(c => c.name === clause.name);
        if (!present) db.exec('ALTER TABLE ' + TABLE + ' ADD COLUMN ' + clause.name + ' ' + toSqlite(clause.definition));
    }
}

// The table as it stood before this change: the fresh definition minus the column
// lines the migration adds. Asserting each line was found keeps the DDL and the
// migration agreeing on what was added.
function preMigrationDdl() {
    let ddl = FRESH_DDL;
    for (const { name } of migrationClauses()) {
        const line = new RegExp('^\\s*' + name + '\\s.*\\n', 'm');
        assert.ok(line.test(ddl), name + ' is added by ' + MIGRATION + ' but not declared in ' + TABLE + '.sql');
        ddl = ddl.replace(line, '');
    }
    return ddl;
}

function openTable(kind) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec(sqliteTableDdl(kind === 'fresh' ? FRESH_DDL : preMigrationDdl()));
    if (kind === 'migrated') applyMigration(db);
    return db;
}

function columnShapes(db) {
    return db.prepare('PRAGMA table_info(' + TABLE + ')').all()
        .map(c => [c.name, c.type, c.notnull, c.dflt_value].join(' '))
        .sort();
}

// The hubDb HubDbSync talks to, answered by the table itself: SHOW COLUMNS from its
// real column list (the applier's filter) and the emitted INSERT IGNORE run as sqlite's
// OR IGNORE. Any other statement fails the test, so the writes seen are exactly the
// apply path's.
function sqliteHubDb(db) {
    const writes = [];
    async function query(sql, args) {
        const show = /^SHOW COLUMNS FROM (\w+)$/.exec(sql);
        if (show) {
            return db.prepare('PRAGMA table_info(' + show[1] + ')').all()
                .map(c => ({ Field: c.name, Type: String(c.type).toLowerCase() }));
        }
        if (/^INSERT IGNORE INTO /.test(sql)) {
            writes.push(sql);
            const run = db.prepare(sql.replace(/^INSERT IGNORE INTO /, 'INSERT OR IGNORE INTO ')).run(...args);
            return { affectedRows: Number(run.changes) };
        }
        throw new Error('unexpected mirror statement: ' + sql);
    }
    return { doQuery: query, doQueryStrict: query, writes };
}

async function mirror(db, row) {
    const hubDb = sqliteHubDb(db);
    const sync  = new HubDbSync(hubDb, { hubUrl: 'http://hub.test', network: 'regtest' });
    await sync.applyRow(TABLE, Object.assign({}, row));
    return hubDb.writes;
}

function stored(db, seq) {
    return db.prepare('SELECT * FROM ' + TABLE + ' WHERE chain = ? AND network = ? AND checkpoint_seq = ?')
        .all(SUPERSEDING.chain, SUPERSEDING.network, seq);
}

function schemaCase() {
    it('a fresh schema and a migrated one carry the same columns, both supersede fields included', function () {
        const fresh    = openTable('fresh');
        const migrated = openTable('migrated');
        const before   = openTable('pre');
        const names    = db => db.prepare('PRAGMA table_info(' + TABLE + ')').all().map(c => c.name);

        assert.deepStrictEqual(migrationClauses().map(c => c.name).sort(), COLUMNS.slice().sort(),
            MIGRATION + ' adds exactly the two supersede columns');
        for (const col of COLUMNS) {
            assert.ok(names(fresh).includes(col), 'fresh schema lacks ' + col);
            assert.ok(names(migrated).includes(col), 'migrated schema lacks ' + col);
            assert.ok(!names(before).includes(col), 'the pre-migration table must not already hold ' + col);
        }
        assert.deepStrictEqual(columnShapes(migrated), columnShapes(fresh),
            'the migration must bring a long-lived table to the fresh definition');
        for (const db of [fresh, migrated]) {
            for (const c of db.prepare('PRAGMA table_info(' + TABLE + ')').all().filter(c => COLUMNS.includes(c.name)))
                assert.strictEqual(c.notnull, 0, c.name + ' must stay nullable: every non-superseding checkpoint leaves it unset');
        }
    });
}

function applyCases(kind) {
    it(kind + ' schema: a mirrored superseding row keeps both fields through the INSERT IGNORE apply', async function () {
        const db     = openTable(kind);
        const writes = await mirror(db, SUPERSEDING);

        assert.strictEqual(writes.length, 1, 'one mirrored write per row');
        const named = /^INSERT IGNORE INTO state_checkpoints \(([^)]*)\) VALUES/.exec(writes[0]);
        assert.ok(named, 'the apply path must emit the plain INSERT IGNORE: ' + writes[0]);
        const cols = named[1].split(',').map(c => c.trim());
        for (const col of COLUMNS) assert.ok(cols.includes(col), 'the emitted INSERT must name ' + col);
        assert.ok(!cols.includes('id') && !cols.includes('anchor_txid'),
            'the wire id and the hub-only audit column stay out of the mirror');

        const rows = stored(db, SUPERSEDING.checkpoint_seq);
        assert.strictEqual(rows.length, 1, 'the superseding row must land');
        assert.strictEqual(Number(rows[0].supersedes_from), SUPERSEDING.supersedes_from);
        assert.strictEqual(rows[0].rules_digest, SUPERSEDING.rules_digest);
        assert.notStrictEqual(Number(rows[0].id), SUPERSEDING.id, 'the mirror assigns its own surrogate id');

        // A re-delivery at the same content key is a no-op, so a later copy without
        // the fields can never clear them: append-only, first row wins.
        await mirror(db, Object.assign({}, SUPERSEDING, { supersedes_from: null, rules_digest: null }));
        const again = stored(db, SUPERSEDING.checkpoint_seq);
        assert.strictEqual(again.length, 1);
        assert.strictEqual(Number(again[0].supersedes_from), SUPERSEDING.supersedes_from);
        assert.strictEqual(again[0].rules_digest, SUPERSEDING.rules_digest);
    });

    it(kind + ' schema: an ordinary checkpoint mirrors with both fields NULL', async function () {
        const db    = openTable(kind);
        const plain = Object.assign({}, SUPERSEDING, { checkpoint_seq: 813, snapshot_block: 813 });
        delete plain.supersedes_from;
        delete plain.rules_digest;
        await mirror(db, plain);

        const rows = stored(db, 813);
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].supersedes_from, null);
        assert.strictEqual(rows[0].rules_digest, null);
    });
}

function controlCase() {
    it('control: the pre-migration table lands the same row without the fields, so the schema is what carries them', async function () {
        const db     = openTable('pre');
        const writes = await mirror(db, SUPERSEDING);

        const cols = /\(([^)]*)\) VALUES/.exec(writes[0])[1].split(',').map(c => c.trim());
        for (const col of COLUMNS) assert.ok(!cols.includes(col), 'the column filter drops ' + col + ' on a table without it');
        const rows = stored(db, SUPERSEDING.checkpoint_seq);
        assert.strictEqual(rows.length, 1, 'an older mirror still applies the row rather than failing it');
        for (const col of COLUMNS) assert.ok(!(col in rows[0]));
    });
}

describe('state_checkpoints mirror keeps supersedes_from and rules_digest @regression', function () {
    schemaCase();
    for (const kind of ['fresh', 'migrated']) applyCases(kind);
    controlCase();
});
