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

// table -> Set(lowercased index names) declared in the canonical definitions.
function collectDeclaredIndexes(){
    const declared = {};
    const add = (table, index) => {
        (declared[table] || (declared[table] = new Set())).add(String(index).toLowerCase());
    };

    for(const file of fs.readdirSync(SQL_DIR).filter(f => f.endsWith('.sql'))){
        const raw = fs.readFileSync(path.join(SQL_DIR, file), 'utf8');

        // Standalone: CREATE [UNIQUE] INDEX <name> on <table> (...)
        for(const m of raw.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+`?(\w+)`?\s+on\s+`?(\w+)`?/gi))
            add(m[2], m[1]);

        // Inline: KEY / UNIQUE KEY <name> (...) inside the CREATE TABLE block.
        const createTable = raw.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/i);
        if(createTable)
            for(const m of raw.matchAll(/^\s*(?:UNIQUE\s+)?KEY\s+`?(\w+)`?/gim))
                add(createTable[1], m[1]);
    }
    return declared;
}

// Every index a dated migration adds: {file, table, index}.
function collectMigrationIndexes(){
    const added = [];
    for(const file of fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql'))){
        const raw = fs.readFileSync(path.join(MIG_DIR, file), 'utf8');

        for(const m of raw.matchAll(/ALTER\s+TABLE\s+`?(\w+)`?\s+ADD\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/gi))
            added.push({ file, table: m[1], index: m[2].toLowerCase() });

        for(const m of raw.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?\s+on\s+`?(\w+)`?/gi))
            added.push({ file, table: m[2], index: m[1].toLowerCase() });
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
});
