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
 * A REAL SQL engine for the anchor_actions consensus projections.
 *
 * The state-hash anchor_invalid class (stateHash.js class 6) selects its rows
 * with a four-way self-join whose predicate had never once been executed: the
 * only test for it stubbed doQuery() and answered with fabricated rows for any
 * SQL mentioning 'anchor_actions p', so a WHERE clause that matched NOTHING on
 * every deployed node passed as green for its whole life. A mock cannot catch
 * that class of defect by construction, so this helper runs the query for real.
 *
 * node:sqlite (built into Node 22, the version every package here pins) backs an
 * in-memory database whose anchor_actions and index_statuses tables are built
 * from THE PROJECT'S OWN src/sql DDL rather than a hand-written copy, so a column
 * rename or a nullability change in the real schema reaches this test. The DDL is
 * mechanically translated (MySQL storage clauses and width/UNSIGNED decorations
 * dropped); the column NAMES, the NULL/NOT NULL contract and the key that matters
 * here (anchor_actions.block_index nullable, block_index_doge NOT NULL) survive
 * the translation untouched.
 *
 * Scope: only the anchor_actions self-join is served for real. buildStateHashData
 * issues ~20 other queries against tables outside this helper's remit, so those
 * return [] exactly as before; this changes the ONE projection under test from
 * mocked to executed, and leaves the rest of the harness alone.
 *
 ********************************************************************/
'use strict';

const fs   = require('fs');
const path = require('path');

const SQL_DIR = path.join(__dirname, '..', '..', 'src', 'sql');

// Translate one MySQL CREATE TABLE script into something sqlite accepts. Only
// storage/decoration syntax is rewritten: names, order, and NULL/NOT NULL (the
// properties this test reasons about) are never touched.
function mysqlDdlToSqlite(ddl){
    return ddl
        .replace(/\)\s*ENGINE=[^;]*;/g, ');')        // table storage clause
        .replace(/\bAUTO_INCREMENT\b/g, '')          // INTEGER PRIMARY KEY is a rowid alias
        .replace(/\b(BIG|TINY|SMALL|MEDIUM)?INT(\s*\(\d+\))?\s+UNSIGNED\b/gi, 'INTEGER')
        .replace(/\b(BIG|TINY|SMALL|MEDIUM)INT(\s*\(\d+\))?\b/gi, 'INTEGER')
        .replace(/\bMEDIUMTEXT\b/gi, 'TEXT')
        .replace(/\bLONGTEXT\b/gi, 'TEXT');
}

// A doQuery-compatible db whose anchor_actions self-join runs against real rows.
// `otherTables` answers every non-anchor query (default: no rows), and `captured`
// collects every SQL string the caller issued so predicate shape stays assertable.
function makeAnchorDb(captured){
    // Required lazily: node:sqlite is experimental in Node 22 and prints a warning
    // on load, so only suites that actually need a SQL engine pay for it.
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');

    for(const file of ['index_statuses.sql', 'anchor_actions.sql']){
        db.exec(mysqlDdlToSqlite(fs.readFileSync(path.join(SQL_DIR, file), 'utf8')));
    }

    // Intern a status name the way db.js createStatus does, and hand back its id.
    // Ids are deliberately NOT stable across nodes in production, which is why the
    // class resolves statuses by NAME; interning here mirrors that.
    function status(name){
        db.prepare('INSERT OR IGNORE INTO index_statuses (status) VALUES (?)').run(name);
        return db.prepare('SELECT id FROM index_statuses WHERE status = ?').get(name).id;
    }

    // Insert one anchor_actions row through the same column set db.js binds, so an
    // omitted key lands NULL here exactly as it does in production. Callers pass
    // only the columns they care about; everything else is left NULL by the schema.
    function anchor(row){
        const cols = Object.keys(row);
        db.prepare(
            'INSERT INTO anchor_actions (' + cols.join(', ') + ') VALUES (' +
            cols.map(() => '?').join(', ') + ')'
        ).run(...cols.map(c => row[c]));
    }

    const api = {
        db,
        status,
        anchor,
        // Rows the class-6 join actually returns, as the real engine returns them.
        async doQuery(sql, args){
            if(captured) captured.push(sql);
            if(sql.indexOf('anchor_actions p') === -1) return [];
            // node:sqlite hands back null-prototype rows; the mariadb driver hands back
            // plain objects, so normalize or callers see a shape production never sees.
            return db.prepare(sql).all(...(args || [])).map(r => Object.assign({}, r));
        },
        getStatusId: async () => null,
        close(){ db.close(); },
    };
    return api;
}

module.exports = { makeAnchorDb, mysqlDdlToSqlite };
