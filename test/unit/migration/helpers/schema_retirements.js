'use strict';

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
 * Retirements for the column and index parity suites: every DROP the dated
 * migrations perform, and the pinned-anchor entries that have left both the
 * live baseline and the definitions. Boot never drops a column or an index,
 * so a retirement converges an aged database only through a dated DROP.
 ********************************************************************/

const fs   = require('fs');
const path = require('path');

const { SQL_DIR, MIG_DIR, splitTopLevelClauses } =
    require('../sql_schema_index_parity.test/helpers/index_ledger.js');

// Match an ALTER TABLE clause that drops a secondary index (DROP PRIMARY KEY never matches).
const DROP_INDEX_CLAUSE  = /^DROP\s+(?:INDEX|KEY)\s+(IF\s+EXISTS\s+)?`?(\w+)`?\s*$/i;
// Match an ALTER TABLE clause that drops a column; MariaDB makes the COLUMN keyword optional.
const DROP_COLUMN_CLAUSE = /^DROP\s+(?:COLUMN\s+)?(IF\s+EXISTS\s+)?`?(\w+)`?\s*$/i;

// Strip `--` line comments and `/* */` block comments, inline ones included.
const stripComments = (sql) => String(sql).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n\r]*/g, '');

const clean = (name) => String(name).replace(/`/g, '').trim().toLowerCase();
const drop  = (file, kind, table, name, ifExists) =>
    ({ file, kind, table: clean(table), name: name === null ? null : clean(name), ifExists: !!ifExists });

// Read one ALTER TABLE clause as a column or index drop, or null when it drops neither.
function dropClause(file, table, clause) {
    const index = clause.match(DROP_INDEX_CLAUSE);
    if (index) return drop(file, 'index', table, index[2], index[1]);
    const column = clause.match(DROP_COLUMN_CLAUSE);
    return column ? drop(file, 'column', table, column[2], column[1]) : null;
}

// Read every drop one statement performs. Anchored at the statement start, so a DROP quoted
// inside a prepared-statement string is not read as one.
function dropsInStatement(stmt, file) {
    const table = stmt.match(/^DROP\s+TABLE\s+(IF\s+EXISTS\s+)?([\w`,\s]+)$/i);
    if (table) return table[2].split(',').filter(t => t.trim()).map(t => drop(file, 'table', t, null, table[1]));
    const index = stmt.match(/^DROP\s+INDEX\s+(IF\s+EXISTS\s+)?`?(\w+)`?\s+ON\s+`?(\w+)`?\s*$/i);
    if (index) return [drop(file, 'index', index[3], index[2], index[1])];
    const alter = stmt.match(/^ALTER\s+(?:ONLINE\s+|IGNORE\s+)*TABLE\s+(?:IF\s+EXISTS\s+)?`?(\w+)`?/i);
    if (!alter) return [];
    return splitTopLevelClauses(stmt.slice(alter[0].length))
        .map(clause => dropClause(file, alter[1], clause)).filter(Boolean);
}

// List every drop in one migration text as {file, kind, table, name, ifExists}, where kind is
// column, index or table and a table drop has name null. Pure, so it is pinned on made-up SQL.
function parseMigrationDrops(sql, file) {
    return stripComments(sql).split(';').flatMap(stmt => dropsInStatement(stmt.trim(), file));
}

// List every drop the dated migrations perform, in apply (lexical filename) order.
function collectMigrationDrops() {
    return fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort()
        .flatMap(file => parseMigrationDrops(fs.readFileSync(path.join(MIG_DIR, file), 'utf8'), file));
}

// Name every table that still has a src/sql/<table>.sql definition.
function collectDefinedTables() {
    return new Set(fs.readdirSync(SQL_DIR).filter(f => f.endsWith('.sql')).map(f => clean(f.slice(0, -4))));
}

// Map each dropped `table.name` (or `table.*` for a whole table) to whether EVERY such drop
// carries IF EXISTS: one bare DROP fails a replay where the entry is already gone.
function dropGuards(kind, drops) {
    const guards = new Map();
    for (const d of drops) {
        if (d.kind !== kind && d.kind !== 'table') continue;
        const key = d.table + '.' + (d.kind === 'table' ? '*' : d.name);
        guards.set(key, (guards.has(key) ? guards.get(key) : true) && d.ifExists);
    }
    return guards;
}

// List the anchor entries gone from BOTH the live baseline and the definitions, as
// {table, key}. isDeclared(table, name) answers for the definitions.
function retiredAnchorEntries(origin, baseline, isDeclared) {
    const out = [];
    for (const [table, entries] of Object.entries(origin || {})) {
        const kept = new Set(((baseline || {})[table] || []).map(e => clean(e.name)));
        for (const e of entries) {
            const name = clean(e.name);
            if (!kept.has(name) && !isDeclared(table, name)) out.push({ table: clean(table), key: clean(table) + '.' + name });
        }
    }
    return out;
}

// Split the retired anchor entries into those no dated migration drops and those dropped
// without IF EXISTS. A whole-table drop counts only once the table's definition is gone.
// Pure over its inputs, so a negative control runs it on made-up data.
function auditRetiredAnchorEntries({ kind, origin, baseline, isDeclared, drops, definedTables }) {
    const guards = dropGuards(kind, drops);
    const missing = [], unguarded = [];
    for (const { table, key } of retiredAnchorEntries(origin, baseline, isDeclared)) {
        const whole   = definedTables.has(table) ? undefined : guards.get(table + '.*');
        const guarded = guards.has(key) ? guards.get(key) : whole;
        if (guarded === undefined) missing.push(key);
        else if (!guarded) unguarded.push(key);
    }
    return { missing, unguarded };
}

module.exports = {
    parseMigrationDrops, collectMigrationDrops, collectDefinedTables, auditRetiredAnchorEntries,
};
