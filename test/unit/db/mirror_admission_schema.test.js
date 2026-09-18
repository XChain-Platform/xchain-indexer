/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 **********************************************************************
 * The mirror-admission schema contract, pinned three ways:
 *
 *   1. the MANIFEST (mirror_admission_schema.test/helpers/manifest.js) has the
 *      shape the family spec fixes: seven tables, three chains in a fixed order on
 *      the mapped rails, one column on the unsigned oracle rail, nullable everywhere;
 *   2. the manifest equals the HUB DDL and the hub's own migrateAdmissionColumns map
 *      column for column and position for position, so the producer's shape and the
 *      contract the indexer twin is checked against cannot drift apart;
 *   3. the INDEXER twins never carry an admission column the manifest does not name,
 *      and the dated migration, the DDL columns and the compat gate's OLD_STATEMENTS
 *      land together or not at all, never half-applied.
 *
 * Part 3 is family row 7's exit condition: on the seam tree it holds vacuously (no
 * column, no migration, no gate entry) and after row 7 it holds by equality. Row 7
 * grows this file with the equality cases; nothing here is a label test.
 *
 * The hub side is read through the sibling guard: absent, the hub describes skip;
 * under XCHAIN_REQUIRE_SIBLINGS=1 absence is a failure, and a sibling entry that is a
 * symlink into a live main checkout is refused the same way.
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const Database = require('../../../src/db');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');
const M = require('./mirror_admission_schema.test/helpers/manifest.js');

const LOCAL_SQL_DIR = path.join(__dirname, '..', '..', '..', 'src', 'sql');
const HUB_DIR       = process.env.XCHAIN_HUB_DIR || path.join(__dirname, '..', '..', '..', '..', 'xchain-hub');
const HUB_SQL_DIR   = path.join(HUB_DIR, 'src', 'sql');
const HUB_COLUMNS   = path.join(HUB_DIR, 'src', 'db', 'schema', 'columns.js');
const COMPAT_GATE   = path.join(__dirname, '..', '..', '..', 'bin', 'check-migration-old-code-compat.js');

const stripSql = Database.prototype.stripSqlLineComments;

function columnsOf(dir, table){
    return M.parseColumns(stripSql.call({}, fs.readFileSync(path.join(dir, table + '.sql'), 'utf8')));
}

// The column preceding a table's first admission column, or null when it has none.
function anchorOf(columns){
    const first = columns.findIndex(c => c.name.startsWith('admit_block'));
    return first > 0 ? columns[first - 1].name : null;
}

// The `<table>: ['btc', ...]` entries of the hub's migrateAdmissionColumns TABLES map,
// scraped from source because the helper is a method on the hub's Database mixin.
function scrapeHubMigrationMap(source){
    const body = /migrateAdmissionColumns\(\)\s*\{[\s\S]*?const TABLES = \{([\s\S]*?)\};/.exec(source);
    assert.ok(body, 'could not find migrateAdmissionColumns TABLES in ' + HUB_COLUMNS);
    const out = {};
    for(const m of body[1].matchAll(/([a-z_]+):\s*\[([^\]]*)\]/g))
        out[m[1]] = [...m[2].matchAll(/'([a-z]+)'/g)].map(x => 'admit_block_' + x[1]);
    return out;
}

// The compat gate's exported maps and drivers (row 7), and a connection stand-in that
// records every statement and answers a read with rowsFor(sql) rows, so the drivers'
// loops are measured rather than trusted.
const G = require('../../../bin/check-migration-old-code-compat.js');
const placeholders = sql => (String(sql).match(/\?/g) || []).length;
function recorder(rowsFor){
    const log = [];
    const raw = async (sql, args) => {
        log.push({ sql, args });
        return /^\s*SELECT/i.test(sql) ? new Array(rowsFor(sql)).fill({}) : [];
    };
    return { raw, log };
}

describe('mirror admission schema: the manifest shape (pure)', function(){
    it('names exactly the seven admission-bearing mirror tables, in one fixed order', function(){
        assert.deepStrictEqual(M.MIRROR_ADMISSION_TABLES, [
            'attestation_responses', 'cross_chain_matches', 'cross_chain_calls', 'bridge_transfers',
            'policy_snapshots', 'price_snapshots', 'oracle_prices',
        ]);
    });

    it('gives the mapped rails btc, ltc, doge in that order and the two single-column rails one column', function(){
        for(const t of ['cross_chain_matches', 'cross_chain_calls', 'bridge_transfers', 'policy_snapshots', 'price_snapshots'])
            assert.deepStrictEqual([...M.MIRROR_ADMISSION_COLUMNS[t].columns], ['admit_block_btc', 'admit_block_ltc', 'admit_block_doge'], t);
        assert.deepStrictEqual([...M.MIRROR_ADMISSION_COLUMNS.attestation_responses.columns], ['admit_block_btc']);
        // The unsigned rail (R5 (a), B13): one column keyed on the publishing chain, unqualified.
        assert.deepStrictEqual([...M.MIRROR_ADMISSION_COLUMNS.oracle_prices.columns], ['admit_block']);
    });

    it('declares every column nullable with no default, the legacy-row rule of C28', function(){
        assert.strictEqual(M.ADMISSION_COLUMN_DDL, 'BIGINT UNSIGNED DEFAULT NULL');
    });

    it('generates one additive, anchored ALTER per table from the manifest', function(){
        const stmts = M.migrationStatements();
        assert.strictEqual(stmts.length, M.MIRROR_ADMISSION_TABLES.length);
        assert.strictEqual(stmts[1],
            'ALTER TABLE cross_chain_matches\n' +
            '  ADD COLUMN IF NOT EXISTS admit_block_btc BIGINT UNSIGNED DEFAULT NULL AFTER finalizing_view,\n' +
            '  ADD COLUMN IF NOT EXISTS admit_block_ltc BIGINT UNSIGNED DEFAULT NULL AFTER admit_block_btc,\n' +
            '  ADD COLUMN IF NOT EXISTS admit_block_doge BIGINT UNSIGNED DEFAULT NULL AFTER admit_block_ltc;');
        assert.strictEqual(stmts[6],
            'ALTER TABLE oracle_prices\n  ADD COLUMN IF NOT EXISTS admit_block BIGINT UNSIGNED DEFAULT NULL AFTER push_generation;');
        for(const s of stmts) assert.ok(!/\b(DROP|MODIFY|CHANGE)\b/i.test(s), 'not additive: ' + s);
    });

    it('lists every manifest table for the compat gate, so an unlisted table cannot fail it by omission', function(){
        assert.deepStrictEqual(M.compatGateTables(), [...M.MIRROR_ADMISSION_TABLES]);
    });
});

describe('mirror admission schema: the manifest against the hub DDL (sibling)', function(){
    const verdict = siblingCheckout(__dirname, HUB_SQL_DIR);
    before(function(){ skipOrFail(this, verdict, 'the hub DDL comparison'); });

    it('every manifest table carries exactly its columns in the hub DDL, each with the one definition', function(){
        for(const t of M.MIRROR_ADMISSION_TABLES){
            const hub = M.admissionColumnsOf(columnsOf(HUB_SQL_DIR, t));
            assert.deepStrictEqual(hub.map(c => c.name), [...M.MIRROR_ADMISSION_COLUMNS[t].columns], t + ': hub column set');
            for(const c of hub) assert.strictEqual(c.definition, M.ADMISSION_COLUMN_DDL, t + '.' + c.name);
        }
    });

    it('every manifest block sits at the hub position its AFTER anchor names', function(){
        for(const t of M.MIRROR_ADMISSION_TABLES)
            assert.strictEqual(anchorOf(columnsOf(HUB_SQL_DIR, t)), M.MIRROR_ADMISSION_COLUMNS[t].hubAfter || M.MIRROR_ADMISSION_COLUMNS[t].after, t);
    });

    it('the hub-only columns are declared, and no other hub table carries an admission column', function(){
        const carrying = {};
        for(const f of fs.readdirSync(HUB_SQL_DIR).filter(f => f.endsWith('.sql')).sort()){
            const cols = M.admissionColumnsOf(columnsOf(HUB_SQL_DIR, f.slice(0, -4))).map(c => c.name);
            if(cols.length) carrying[f.slice(0, -4)] = cols;
        }
        const expected = {};
        for(const t of M.MIRROR_ADMISSION_TABLES) expected[t] = [...M.MIRROR_ADMISSION_COLUMNS[t].columns];
        for(const t of Object.keys(M.HUB_ONLY_ADMISSION_COLUMNS)) expected[t] = [...M.HUB_ONLY_ADMISSION_COLUMNS[t]];
        assert.deepStrictEqual(carrying, expected,
            'the hub DDL admission columns are not the manifest plus the declared hub-only set');
    });

    it('the hub migrateAdmissionColumns map is the manifest plus the hub-only set, column for column', function(){
        const map = scrapeHubMigrationMap(fs.readFileSync(HUB_COLUMNS, 'utf8'));
        const expected = {};
        for(const t of M.MIRROR_ADMISSION_TABLES) if(t !== 'oracle_prices') expected[t] = [...M.MIRROR_ADMISSION_COLUMNS[t].columns];
        for(const t of Object.keys(M.HUB_ONLY_ADMISSION_COLUMNS)) expected[t] = [...M.HUB_ONLY_ADMISSION_COLUMNS[t]];
        assert.deepStrictEqual(map, expected);
        // The oracle rail is migrated by its own single-column call, outside the map.
        assert.ok(/migrateAddNullableColumn\('oracle_prices',\s*'admit_block',\s*'BIGINT UNSIGNED DEFAULT NULL'\)/
            .test(fs.readFileSync(HUB_COLUMNS, 'utf8')), 'oracle_prices.admit_block is not migrated by the hub helper');
    });
});

describe('mirror admission schema: the indexer twins against the manifest (row 7 exit condition)', function(){
    const migrationPath = path.join(M.MIGRATIONS_DIR, M.MIGRATION_FILE);

    function indexerCarries(){
        const out = {};
        for(const t of M.MIRROR_ADMISSION_TABLES) out[t] = M.admissionColumnsOf(columnsOf(LOCAL_SQL_DIR, t));
        return out;
    }

    it('an indexer twin never carries an admission column the manifest does not declare', function(){
        const carried = indexerCarries();
        for(const t of M.MIRROR_ADMISSION_TABLES){
            const declared = new Set(M.MIRROR_ADMISSION_COLUMNS[t].columns);
            for(const c of carried[t]){
                assert.ok(declared.has(c.name), t + '.' + c.name + ' is not in the manifest');
                assert.strictEqual(c.definition, M.ADMISSION_COLUMN_DDL, t + '.' + c.name);
            }
            if(carried[t].length)
                assert.strictEqual(anchorOf(columnsOf(LOCAL_SQL_DIR, t)), M.MIRROR_ADMISSION_COLUMNS[t].after, t + ': position');
        }
    });

    it('the DDL columns and the dated migration land together, never one without the other', function(){
        const carried = indexerCarries();
        const anyColumn = M.MIRROR_ADMISSION_TABLES.some(t => carried[t].length > 0);
        assert.strictEqual(fs.existsSync(migrationPath), anyColumn,
            'src/sql admission columns present: ' + anyColumn + ', ' + M.MIGRATION_FILE + ' present: ' + fs.existsSync(migrationPath));
        if(!anyColumn) return;
        const text = fs.readFileSync(migrationPath, 'utf8');
        assert.ok(new RegExp('^\\s*--\\s*xchain:migration\\b[^\\n]*\\bmode\\s*=\\s*' + M.MIGRATION_MODE + '\\b', 'm').test(text),
            M.MIGRATION_FILE + ' is not tagged mode=' + M.MIGRATION_MODE);
        const alters = stripSql.call({}, text).split(';').map(s => s.trim()).filter(s => /^ALTER TABLE/i.test(s)).map(s => s + ';');
        assert.deepStrictEqual(alters, M.migrationStatements(), 'the migration ALTERs are not the manifest-generated statements');
    });

    it('the compat gate lists every manifest table exactly when the migration exists', function(){
        const source = fs.readFileSync(COMPAT_GATE, 'utf8');
        const block  = /const OLD_STATEMENTS = \{([\s\S]*?)\n\};/.exec(source);
        assert.ok(block, 'OLD_STATEMENTS not found in ' + COMPAT_GATE);
        const listed = new Set([...block[1].matchAll(/^\s{4}([a-z_]+):\s*\{/gm)].map(m => m[1]));
        const missing = M.compatGateTables().filter(t => !listed.has(t));
        if(fs.existsSync(migrationPath))
            assert.deepStrictEqual(missing, [], 'OLD_STATEMENTS lacks these migration-written tables, which fails the gate');
        else
            assert.deepStrictEqual(missing, M.compatGateTables(), 'OLD_STATEMENTS already lists admission tables with no migration to exercise them');
    });

    // Row 7's equality half: once the migration exists, every twin carries the manifest's
    // whole column block in the manifest's order, not merely a subset of it.
    it('with the migration present, every indexer twin carries exactly its manifest columns, in order', function(){
        if(!fs.existsSync(migrationPath)) this.skip();
        const carried = indexerCarries();
        for(const t of M.MIRROR_ADMISSION_TABLES)
            assert.deepStrictEqual(carried[t].map(c => c.name), [...M.MIRROR_ADMISSION_COLUMNS[t].columns], t);
    });
});

describe('mirror admission schema: the compat gate maps against the manifest (row 7)', function(){
    const migrationPath = path.join(M.MIGRATIONS_DIR, M.MIGRATION_FILE);

    it('the statement map and the row map both name exactly the manifest tables, insert plus read, naming no admission column', function(){
        const tables = M.compatGateTables();
        assert.deepStrictEqual(Object.keys(G.ADMISSION_MIRROR_ROWS), tables);
        for(const t of tables){
            const S = G.OLD_STATEMENTS[t];
            assert.ok(S && S.insert && S.read, t + ' lacks insert/read in OLD_STATEMENTS');
            assert.ok(!/admit_block/i.test(S.insert) && !/admit_block/i.test(S.read), t + ': an OLD statement names an admission column');
            const R = G.ADMISSION_MIRROR_ROWS[t];
            for(const k of ['legacy', 'later']) assert.strictEqual(placeholders(S.insert), R[k].length, t + '.' + k + ' arity');
            assert.strictEqual(placeholders(S.read), R.read.length, t + '.read arity');
        }
    });

    it('the migration adds every manifest column nullable with no NOT NULL, each anchored on the manifest chain', function(){
        if(!fs.existsSync(migrationPath)) this.skip();
        const added = G.addedColumns(fs.readFileSync(migrationPath, 'utf8'));
        const want  = [];
        for(const t of M.MIRROR_ADMISSION_TABLES){
            let prev = M.MIRROR_ADMISSION_COLUMNS[t].after;
            for(const col of M.MIRROR_ADMISSION_COLUMNS[t].columns){ want.push(t + '.' + col + ' AFTER ' + prev); prev = col; }
        }
        assert.deepStrictEqual(added.map(a => a.table + '.' + a.col + ' AFTER ' + /AFTER\s+(\S+)/.exec(a.tail)[1]), want);
        for(const a of added)
            assert.ok(/\bDEFAULT NULL\b/.test(a.tail) && !/NOT\s+NULL/i.test(a.tail), a.table + '.' + a.col + ' is not nullable: ' + a.tail.trim());
    });
});

describe('mirror admission schema: the compat gate drives every manifest table (row 7)', function(){
    it('seeding then exercising executes every table: one legacy insert, two later inserts, one read that must return `expect` rows', async function(){
        const tables = M.compatGateTables();
        const { raw, log } = recorder(sql => {
            const t = tables.find(x => G.OLD_STATEMENTS[x].read === sql);
            return G.ADMISSION_MIRROR_ROWS[t].expect;
        });
        const seeded = await G.seedAdmissionMirrorRows(raw, tables);
        const notes  = await G.exerciseAdmissionMirrorRows(raw, tables);
        assert.deepStrictEqual(seeded, tables);
        assert.strictEqual(notes.length, tables.length);
        for(const t of tables){
            const S = G.OLD_STATEMENTS[t], R = G.ADMISSION_MIRROR_ROWS[t];
            assert.strictEqual(log.filter(e => e.sql === S.insert && e.args === R.legacy).length, 1, t + ' legacy insert');
            assert.strictEqual(log.filter(e => e.sql === S.insert && e.args === R.later).length,  2, t + ' later insert');
            assert.strictEqual(log.filter(e => e.sql === S.read).length, 1, t + ' read');
        }
        assert.strictEqual(log.length, tables.length * 4, 'no statement outside the four per table');
    });

    it('a read that returns the wrong row count fails the exercise, and a table the pending set creates is skipped', async function(){
        const short = recorder(() => 0);
        await assert.rejects(() => G.exerciseAdmissionMirrorRows(short.raw, ['policy_snapshots']), /policy_snapshots: .*returned 0 row/);
        const skip = recorder(sql => G.ADMISSION_MIRROR_ROWS[M.compatGateTables().find(t => G.OLD_STATEMENTS[t].read === sql)].expect);
        await G.exerciseAdmissionMirrorRows(skip.raw, M.compatGateTables().filter(t => t !== 'bridge_transfers'));
        assert.ok(!skip.log.some(e => /bridge_transfers/i.test(e.sql)), 'bridge_transfers was driven although exempt');
    });
});
