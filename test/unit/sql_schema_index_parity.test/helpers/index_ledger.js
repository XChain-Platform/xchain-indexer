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
 * The two index-construction paths, read out of the tree for the index parity
 * suite (../../sql_schema_index_parity.test.js and ../baseline.test.js): what
 * each src/sql/<table>.sql definition declares, and what the dated migrations
 * under src/sql/migrations/ add.
 ********************************************************************/

const fs     = require('fs');
const path   = require('path');

const SQL_DIR = path.join(__dirname, '..', '..', '..', '..', 'src', 'sql');
const MIG_DIR = path.join(SQL_DIR, 'migrations');
const INDEX_BASELINE = path.join(__dirname, '..', '..', '..', 'fixtures', 'schema-index-baseline.json');

// Tables whose CREATE TABLE lives in a dated migration are ledger-covered by that
// statement, indexes included, so they are outside the inverse direction entirely
// (same carve-out the column baseline states). SQL line comments are stripped
// first: the migrations explain themselves in prose, and an unstripped scan reads
// words like "IF" or "is" out of a sentence as table names.
function stripSqlComments(raw){
    return String(raw).replace(/^\s*--.*$/gm, '');
}

function collectLedgerCreatedTables(){
    const tables = new Set();
    for(const file of fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql'))){
        const raw = stripSqlComments(fs.readFileSync(path.join(MIG_DIR, file), 'utf8'));
        for(const m of raw.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/gi))
            tables.add(m[1]);
    }
    return tables;
}

// Normalize an index's parenthesized column list into a comparable array.
// Keeps ORDER (a leading column decides which lookups the index serves) and the
// (len) prefix (a differently-prefixed index is a different index to the engine),
// drops backticks, case and whitespace. Returns null when the list is unparsed,
// which the shape comparison treats as "cannot compare" rather than "differs".
function normalizeIndexColumns(list){
    if(list === undefined || list === null) return null;
    return String(list).split(',')
        .map(c => c.replace(/`/g, '').trim().toLowerCase().replace(/\s+/g, ''))
        .filter(c => c.length > 0);
}

// The optional word between CREATE/ADD and INDEX, reduced to the two flags that make one
// index a different index from another of the same name. FULLTEXT is admitted alongside
// UNIQUE because contracts.meta_search is a FULLTEXT index declared on BOTH paths: read
// with the old `(UNIQUE\s+)?` regexes, a `CREATE FULLTEXT INDEX` matched nothing at all,
// so the index was invisible to every case in this file and the guard stayed green while
// covering it not at all. Kept as two booleans rather than the raw capture so a UNIQUE
// declaration and a FULLTEXT one can never compare equal just because both are truthy.
function indexKind(qualifier){
    const q = String(qualifier || '');
    return { unique: /\bUNIQUE\b/i.test(q), fulltext: /\bFULLTEXT\b/i.test(q) };
}

// table -> Map(lowercased index name -> {columns, unique, fulltext}) declared in the
// canonical definitions. A Map, not a Set, so the name-only checks below keep working while
// the shape comparison gets the columns and the UNIQUE flag the old Set threw away.
function collectDeclaredIndexes(){
    const declared = {};
    const add = (table, index, qualifier, columns) => {
        const key = String(index).toLowerCase();
        const map = (declared[table] || (declared[table] = new Map()));
        // First declaration wins; a table declaring one name twice is its own bug and
        // is caught by the engine, not here.
        if(!map.has(key)) map.set(key, Object.assign(indexKind(qualifier), { columns: normalizeIndexColumns(columns) }));
    };

    for(const file of fs.readdirSync(SQL_DIR).filter(f => f.endsWith('.sql'))){
        const raw = fs.readFileSync(path.join(SQL_DIR, file), 'utf8');

        // Standalone: CREATE [UNIQUE|FULLTEXT] INDEX <name> on <table> (...)
        for(const m of raw.matchAll(/CREATE\s+(UNIQUE\s+|FULLTEXT\s+)?INDEX\s+`?(\w+)`?\s+on\s+`?(\w+)`?\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)/gi))
            add(m[3], m[2], m[1], m[4]);

        // Inline: KEY / UNIQUE KEY <name> (...) inside the CREATE TABLE block.
        const createTable = raw.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/i);
        if(createTable)
            for(const m of raw.matchAll(/^\s*(UNIQUE\s+)?KEY\s+`?(\w+)`?\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)/gim))
                add(createTable[1], m[2], m[1], m[3]);
    }
    return declared;
}

// Every index a dated migration adds: {file, table, index, unique, fulltext, columns}.
function collectMigrationIndexes(){
    const added = [];
    for(const file of fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql'))){
        const raw = fs.readFileSync(path.join(MIG_DIR, file), 'utf8');

        for(const m of raw.matchAll(/ALTER\s+TABLE\s+`?(\w+)`?\s+ADD\s+(UNIQUE\s+|FULLTEXT\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)/gi))
            added.push(Object.assign({ file, table: m[1], index: m[3].toLowerCase(), columns: normalizeIndexColumns(m[4]) }, indexKind(m[2])));

        for(const m of raw.matchAll(/CREATE\s+(UNIQUE\s+|FULLTEXT\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?\s+on\s+`?(\w+)`?\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)/gi))
            added.push(Object.assign({ file, table: m[3], index: m[2].toLowerCase(), columns: normalizeIndexColumns(m[4]) }, indexKind(m[1])));
    }
    return added;
}

module.exports = {
    SQL_DIR, MIG_DIR, INDEX_BASELINE,
    collectLedgerCreatedTables, collectDeclaredIndexes, collectMigrationIndexes,
};
