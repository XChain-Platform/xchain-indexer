/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * A REAL SQL engine for data-backfill migrations.
 *
 * A backfill migration is a WHERE clause and nothing else: its whole
 * correctness lives in which rows it selects. A mock cannot test that, and a
 * migration that silently matches nothing (or matches the wrong row and writes
 * a wrong address into a read model) passes every stubbed suite there is. So
 * these run for real, against the project's OWN src/sql DDL, on node:sqlite
 * (built into Node 22, the version every package here pins).
 *
 * Reuses sqlAnchorDb's MySQL->sqlite DDL translation and adds the two things a
 * multi-table load needs:
 *   - CHARACTER SET / COLLATE decorations are dropped (sqlite rejects an
 *     unknown collating sequence outright).
 *   - CREATE INDEX statements are dropped. Index names are per-table in MySQL
 *     but global in sqlite, and the schema reuses `action_index` / `tick_id` as
 *     an index name on nearly every table, so loading two tables collides.
 *     Indexes change plans, never results.
 *
 * Column names, order, and the NULL/NOT NULL contract - the properties a
 * backfill's predicate actually reasons about - survive the translation
 * untouched.
 *
 ********************************************************************/
'use strict';

const fs   = require('fs');
const path = require('path');

const { mysqlDdlToSqlite } = require('./sqlAnchorDb');

const SQL_DIR = path.join(__dirname, '..', '..', 'src', 'sql');
const MIG_DIR = path.join(SQL_DIR, 'migrations');

function toSqlite(ddl){
    return mysqlDdlToSqlite(ddl)
        .replace(/\bCHARACTER\s+SET\s+\w+\s*/gi, '')
        .replace(/\bCOLLATE\s+\w+\s*/gi, '')
        .replace(/^\s*CREATE\s+(UNIQUE\s+)?INDEX[^;]*;\s*$/gim, '');
}

// Load the named src/sql table scripts into a fresh in-memory database.
function makeMigrationDb(tables){
    // Required lazily: node:sqlite is experimental in Node 22 and prints a warning
    // on load, so only suites that actually need a SQL engine pay for it.
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');

    for(const file of tables){
        db.exec(toSqlite(fs.readFileSync(path.join(SQL_DIR, file), 'utf8')));
    }

    // Insert through the caller's own column set, so an omitted key lands NULL here
    // exactly as it does in production when db.js binds an absent field.
    function insert(table, row){
        const cols = Object.keys(row);
        db.prepare(
            'INSERT INTO ' + table + ' (' + cols.join(', ') + ') VALUES (' +
            cols.map(() => '?').join(', ') + ')'
        ).run(...cols.map(c => row[c]));
    }

    function rows(sql, args){
        return db.prepare(sql).all(...(args || [])).map(r => Object.assign({}, r));
    }

    return { db, insert, rows, close(){ db.close(); } };
}

// The statements of a committed migration, split exactly the way the runner splits
// them (quote-aware, comments stripped), so the test executes the shipped file and
// not a paraphrase of it.
function migrationStatements(filename){
    const Database = require('../../src/db');
    const raw = fs.readFileSync(path.join(MIG_DIR, filename), 'utf8');
    return Database.prototype.splitSqlStatements.call(Database.prototype, raw);
}

module.exports = { makeMigrationDb, migrationStatements, toSqlite, MIG_DIR };
