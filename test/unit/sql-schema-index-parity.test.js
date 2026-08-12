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
 * Schema index parity: the two schema-construction paths must agree.
 *
 * A table's schema can be built two ways, and they must converge:
 *   DEFINITION path - src/sql/<table>.sql, applied on a fresh install
 *                     (CREATE TABLE, incl. its inline KEY clauses, plus any
 *                     standalone CREATE INDEX, which reconcileTableIndexes
 *                     also re-adds to existing DBs via parseExpectedIndexes).
 *   LEDGER path     - src/sql/migrations/*.sql, replayed in order.
 *
 * The failure this guards is an index that exists ONLY on the ledger path: an
 * ALTER TABLE ... ADD INDEX in a dated migration with no matching declaration
 * in the table's definition. Such an index is a ledger artifact. It is present
 * today only because runMigrations replays the migration on fresh installs too,
 * so the paths appear to agree; but baselining or squashing that migration into
 * the definitions (routine cleanup) would silently DROP the index for fresh
 * installs while long-lived DBs kept it, and the two paths would diverge.
 *
 * This is not hypothetical: index_tickers.block_index was exactly this shape
 * (its sibling index_addresses declared the same index inline, index_tickers
 * did not), which is what motivated this guard.
 *
 * NOTE the two legitimate declaration forms both count as "declared":
 *   - inline  `KEY idx_foo (a, b)` inside the CREATE TABLE block
 *   - standalone `CREATE INDEX idx_foo on <table> (a, b);`
 * Only an index reachable through NEITHER is an orphan.
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const SQL_DIR = path.join(__dirname, '..', '..', 'src', 'sql');
const MIG_DIR = path.join(SQL_DIR, 'migrations');
const INDEX_BASELINE = path.join(__dirname, '..', 'fixtures', 'schema-index-baseline.json');

// Tables whose CREATE TABLE lives in a dated migration are ledger-covered by that
// statement, indexes included, so they are outside the inverse direction entirely
// (same carve-out the column baseline states, #3164). SQL line comments are stripped
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

// table -> Map(lowercased index name -> {columns, unique}) declared in the canonical
// definitions. A Map, not a Set, so the name-only checks below keep working while the
// shape comparison gets the columns and the UNIQUE flag the old Set threw away (#3529).
function collectDeclaredIndexes(){
    const declared = {};
    const add = (table, index, unique, columns) => {
        const key = String(index).toLowerCase();
        const map = (declared[table] || (declared[table] = new Map()));
        // First declaration wins; a table declaring one name twice is its own bug and
        // is caught by the engine, not here.
        if(!map.has(key)) map.set(key, { unique: !!unique, columns: normalizeIndexColumns(columns) });
    };

    for(const file of fs.readdirSync(SQL_DIR).filter(f => f.endsWith('.sql'))){
        const raw = fs.readFileSync(path.join(SQL_DIR, file), 'utf8');

        // Standalone: CREATE [UNIQUE] INDEX <name> on <table> (...)
        for(const m of raw.matchAll(/CREATE\s+(UNIQUE\s+)?INDEX\s+`?(\w+)`?\s+on\s+`?(\w+)`?\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)/gi))
            add(m[3], m[2], m[1], m[4]);

        // Inline: KEY / UNIQUE KEY <name> (...) inside the CREATE TABLE block.
        const createTable = raw.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/i);
        if(createTable)
            for(const m of raw.matchAll(/^\s*(UNIQUE\s+)?KEY\s+`?(\w+)`?\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)/gim))
                add(createTable[1], m[2], m[1], m[3]);
    }
    return declared;
}

// Every index a dated migration adds: {file, table, index, unique, columns}.
function collectMigrationIndexes(){
    const added = [];
    for(const file of fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql'))){
        const raw = fs.readFileSync(path.join(MIG_DIR, file), 'utf8');

        for(const m of raw.matchAll(/ALTER\s+TABLE\s+`?(\w+)`?\s+ADD\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)/gi))
            added.push({ file, table: m[1], index: m[3].toLowerCase(), unique: !!m[2], columns: normalizeIndexColumns(m[4]) });

        for(const m of raw.matchAll(/CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?\s+on\s+`?(\w+)`?\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)/gi))
            added.push({ file, table: m[3], index: m[2].toLowerCase(), unique: !!m[1], columns: normalizeIndexColumns(m[4]) });
    }
    return added;
}

describe('SQL schema index parity (definition path vs ledger path) @regression', function(){

    it('sanity: the parser actually finds migration-added indexes (guard is not vacuous)', function(){
        assert.ok(collectMigrationIndexes().length > 0,
            'found no ALTER TABLE ... ADD INDEX in src/sql/migrations; the regexes above have gone stale ' +
            'and this whole guard would pass vacuously');
    });

    it('sanity: the parser finds indexes declared in the definitions', function(){
        const declared = collectDeclaredIndexes();
        assert.ok(Object.keys(declared).length > 0, 'parsed no indexes out of src/sql/*.sql');
        // index_addresses.block_index is a standalone CREATE INDEX; price_snapshots
        // declares its keys inline. Pin one of each so a regex regression is caught.
        assert.ok(declared['index_addresses'] && declared['index_addresses'].has('block_index'),
            'standalone CREATE INDEX form no longer parsed');
        assert.ok(declared['price_snapshots'] && declared['price_snapshots'].has('idx_status_block_round'),
            'inline KEY form no longer parsed');
    });

    it('no index exists only on the ledger path (every migration-added index is declared in its table definition)', function(){
        const declared = collectDeclaredIndexes();
        const orphans  = collectMigrationIndexes().filter(a =>
            !(declared[a.table] && declared[a.table].has(a.index)));

        assert.deepStrictEqual(orphans, [],
            'These indexes are added by a dated migration but are NOT declared in the table definition, so ' +
            'they exist only as a ledger artifact. Baselining the migration would silently drop them for ' +
            'fresh installs while long-lived DBs keep them. Declare each in its src/sql/<table>.sql (inline ' +
            'KEY, or a standalone CREATE INDEX so reconcileTableIndexes can self-heal it):\n' +
            orphans.map(o => `  ${o.table}.${o.index}  <- ${o.file}`).join('\n'));
    });

    // #3529: name equality is not shape equality. A migration `ADD INDEX foo (a, b)` and a
    // definition `KEY foo (a, c)`, or a `CREATE UNIQUE INDEX foo` against a plain `KEY foo`,
    // both satisfy the name-only check above while leaving a fresh install and a
    // migration-replayed install carrying structurally different indexes under one name. The
    // runtime reconciler is no backstop: reconcileTableIndexes matches by COLUMN SET, and for
    // an inline KEY it is never consulted at all (parseExpectedIndexes reads only standalone
    // CREATE INDEX). This is the rigor the sibling column-parity guard already applies to
    // column types, ported to indexes.
    it('an index declared on BOTH paths has the same columns and uniqueness, not just the same name', function(){
        const declared = collectDeclaredIndexes();
        const mismatches = [];

        for(const a of collectMigrationIndexes()){
            const decl = declared[a.table] && declared[a.table].get(a.index);
            if(!decl) continue;                       // orphan case, already covered above
            if(decl.columns === null || a.columns === null) continue;   // unparsed, do not guess
            if(decl.columns.join(',') !== a.columns.join(','))
                mismatches.push(`  ${a.table}.${a.index} columns: definition (${decl.columns.join(', ')}) ` +
                                `vs migration (${a.columns.join(', ')})  <- ${a.file}`);
            else if(decl.unique !== a.unique)
                mismatches.push(`  ${a.table}.${a.index} uniqueness: definition unique=${decl.unique} ` +
                                `vs migration unique=${a.unique}  <- ${a.file}`);
        }

        assert.deepStrictEqual(mismatches, [],
            'These indexes carry the same NAME on both schema-construction paths but a different ' +
            'SHAPE, so a fresh install and a migration-replayed install end up with different ' +
            'indexes. Column order and the (len) prefix both matter to the engine, and a UNIQUE ' +
            'index additionally enforces a constraint the plain KEY does not. Make the definition ' +
            'in src/sql/<table>.sql and the dated migration agree:\n' + mismatches.join('\n'));
    });

    // #3386: the inverse direction the column-parity sibling already closes (#2457).
    // An index that exists ONLY on the definition path is invisible to a DB converged by
    // replaying migrations alone (an operator-managed or rebuilt replica). It bites hardest
    // for an inline KEY / UNIQUE KEY added to a CREATE TABLE after the table exists:
    // reconcileTableIndexes -> parseExpectedIndexes self-heals only standalone
    // CREATE INDEX ... ON, never an inline KEY, so a running node cannot back-fill it either.
    // The baseline fixture freezes the indexes that shipped with each table's original
    // CREATE TABLE; anything new must arrive by dated migration or be baselined on purpose.
    it('no index exists only on the definition path (every declared index is migration-created or baselined)', function(){
        const fixture  = JSON.parse(fs.readFileSync(INDEX_BASELINE, 'utf8'));
        const baseline = fixture.baseline || {};
        const debt     = new Set((fixture.known_unledgered || []).map(e => String(e).toLowerCase()));
        const ledgerCreated  = collectLedgerCreatedTables();
        const migrationAdded = new Set(collectMigrationIndexes().map(a => a.table + '.' + a.index));

        const declared = collectDeclaredIndexes();
        const unledgered = [];
        for(const table of Object.keys(declared)){
            if(ledgerCreated.has(table)) continue;             // ledger-covered by its CREATE TABLE
            for(const index of declared[table].keys()){
                const key = table + '.' + index;
                if(migrationAdded.has(key)) continue;
                if((baseline[table] || []).some(e => String(e.name).toLowerCase() === index)) continue;
                if(debt.has(key)) continue;
                unledgered.push('  ' + key);
            }
        }

        assert.deepStrictEqual(unledgered, [],
            'These indexes are declared in a table definition but are created by no dated migration and ' +
            'are not in test/fixtures/schema-index-baseline.json, so a DB converged by replaying ' +
            'migrations alone never gets them. If the index was added to an EXISTING table, ship a dated ' +
            'migration under src/sql/migrations/ (and prefer a standalone CREATE INDEX over an inline KEY, ' +
            'so reconcileTableIndexes can self-heal aged DBs). If it genuinely shipped with the table\'s ' +
            'original CREATE TABLE, add it to the baseline deliberately and say so in the commit:\n' +
            unledgered.join('\n'));
    });

    // #4076: the seam BETWEEN the two carve-outs above. The inverse guard exempts a
    // ledger-created table because its CREATE TABLE is the ledger record, and the sibling
    // column-parity case compares that CREATE TABLE body byte-for-byte, so an inline
    // `KEY` on such a table really is covered. A STANDALONE `CREATE INDEX ... ON` is not:
    // it sits outside the body the byte compare reads (normalizeCreateBody stops at
    // `) ENGINE...`) and outside the inverse guard's reach, so it was checked by nothing.
    // Two migrations then disagreed about it - 2026-07-28-escrow-leaf-journal-table.sql
    // restated its standalone indexes, 2026-07-26-bet-cancel-resolve-status-tables.sql
    // omitted all eight of bet_cancels/bet_resolves' and left them to the boot-time
    // reconciler. The reconciler is a repair path, not the schema contract: it heals only
    // standalone CREATE INDEX, so it does not generalize, and a shape change to any of
    // those eight would have landed on the definition path with no test watching.
    it('a ledger-created table restates its definition\'s STANDALONE indexes in a dated migration', function(){
        const ledgerCreated  = collectLedgerCreatedTables();
        const migrationAdded = new Set(collectMigrationIndexes().map(a => a.table + '.' + a.index));

        const missing = [];
        for(const file of fs.readdirSync(SQL_DIR).filter(f => f.endsWith('.sql'))){
            const raw = fs.readFileSync(path.join(SQL_DIR, file), 'utf8');
            for(const m of raw.matchAll(/CREATE\s+(UNIQUE\s+)?INDEX\s+`?(\w+)`?\s+on\s+`?(\w+)`?/gi)){
                const table = m[3], index = m[2].toLowerCase();
                if(!ledgerCreated.has(table)) continue;                 // covered by the inverse guard above
                if(migrationAdded.has(table + '.' + index)) continue;
                missing.push(`  ${table}.${index}  <- src/sql/${file}`);
            }
        }

        assert.deepStrictEqual(missing, [],
            'These tables are CREATEd by a dated migration, and their definition declares these indexes as ' +
            'a STANDALONE CREATE INDEX - which the migration-created-table body compare in ' +
            'sql-schema-column-parity.test.js cannot see (it stops at the ENGINE tail) and the inverse ' +
            'guard above skips. No parity check covers them, so the two schema paths can diverge on them ' +
            'unobserved. Restate each one in a dated migration with CREATE INDEX IF NOT EXISTS, matching ' +
            'the definition\'s name, column list and UNIQUE flag (the shape case above then enforces the ' +
            'match). Do NOT edit the migration that already created the table: an applied migration is ' +
            'immutable and its checksum is the ledger - ship a new dated file:\n' + missing.join('\n'));
    });

    it('sanity: the index baseline is neither empty nor stale (guard is not vacuous)', function(){
        const fixture  = JSON.parse(fs.readFileSync(INDEX_BASELINE, 'utf8'));
        const baseline = fixture.baseline || {};
        assert.ok(Object.keys(baseline).length > 0, 'the index baseline is empty; the inverse guard would pass vacuously');

        // A baseline entry for an index no definition declares any more is dead weight that
        // would quietly re-waive the guard if the name were ever reused.
        const declared = collectDeclaredIndexes();
        const stale = [];
        for(const table of Object.keys(baseline))
            for(const entry of baseline[table]){
                const index = String(entry.name).toLowerCase();
                if(!(declared[table] && declared[table].has(index))) stale.push('  ' + table + '.' + index);
            }

        assert.deepStrictEqual(stale, [],
            'These baseline entries name an index no src/sql/<table>.sql declares any more. Remove them ' +
            'from test/fixtures/schema-index-baseline.json:\n' + stale.join('\n'));
    });

    // #4435: the index twin of the column-shape guard. The inverse guard above exempts a
    // pre-ledger index by NAME, and the baseline stored nothing but names, so re-pointing a
    // baselined index at different columns, changing its (len) prefix or its column ORDER, or
    // promoting a plain KEY to UNIQUE all stayed green with no dated migration. The runtime is
    // no backstop: reconcileTableIndexes matches by COLUMN SET (so it cannot see a prefix or
    // order change) and for an inline KEY it is never consulted at all, since parseExpectedIndexes
    // reads only standalone CREATE INDEX. The shape case above (#3529) covers only indexes a
    // migration ALSO declares; a baselined index has no migration by definition, so nothing
    // watched it. The baseline now freezes each one's normalized columns + UNIQUE flag.
    it('a pre-ledger baselined index has not changed shape (columns, prefix, uniqueness) @regression', function(){
        const fixture  = JSON.parse(fs.readFileSync(INDEX_BASELINE, 'utf8'));
        const baseline = fixture.baseline || {};
        const declared = collectDeclaredIndexes();

        const drifted = [];
        for(const table of Object.keys(baseline))
            for(const entry of baseline[table]){
                const index = String(entry.name).toLowerCase();
                const decl  = declared[table] && declared[table].get(index);
                if(!decl) continue;                                       // staleness is the case above
                if(decl.columns === null || entry.columns === null) continue;  // unparsed, do not guess
                if(decl.columns.join(',') !== (entry.columns || []).join(','))
                    drifted.push(`  ${table}.${index} columns: baseline (${(entry.columns || []).join(', ')}) ` +
                                 `vs definition (${decl.columns.join(', ')})`);
                else if(decl.unique !== !!entry.unique)
                    drifted.push(`  ${table}.${index} uniqueness: baseline unique=${!!entry.unique} ` +
                                 `vs definition unique=${decl.unique}`);
            }

        assert.deepStrictEqual(drifted, [],
            'These indexes predate the migration ledger, so they are exempt from needing a dated migration - ' +
            'but their SHAPE changed in src/sql/<table>.sql with no migration behind it. An aged DB keeps the ' +
            'original index (the boot reconciler matches by column SET, so it cannot see a reorder or a (len) ' +
            'prefix change, and never touches an inline KEY at all), so the two schema-construction paths stop ' +
            'agreeing. Ship a dated migration that recreates the index in its new shape, and re-freeze ' +
            'test/fixtures/schema-index-baseline.json in the SAME commit:\n' + drifted.join('\n'));
    });
});
