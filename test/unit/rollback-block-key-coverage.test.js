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
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const lifecycle = require('../../src/tableLifecycle.js');

const SQL_DIR      = path.resolve(__dirname, '../../src/sql');
const ROLLBACK_SRC = path.resolve(__dirname, '../../src/rollback.js');

// Column names declared by a table definition. Deliberately crude: it only has to
// answer "is this column declared", and the schema-parity suites already own the
// business of comparing full shapes. Index and constraint lines are skipped because
// they can NAME a column without declaring one.
function declaredColumns(table){
    const file = path.join(SQL_DIR, table + '.sql');
    if(!fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, 'utf8')
        .split('\n').map(l => { const i = l.indexOf('--'); return i >= 0 ? l.slice(0, i) : l; }).join('\n');
    const body = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?\w+`?\s*\(([\s\S]*)\)\s*ENGINE/i.exec(text);
    if(!body) return null;
    const cols = new Set();
    for(const raw of body[1].split('\n')){
        const line = raw.trim();
        if(!line) continue;
        if(/^(PRIMARY|UNIQUE|INDEX|KEY|CHECK|CONSTRAINT|FOREIGN)\b/i.test(line)) continue;
        const m = /^`?([A-Za-z_][A-Za-z0-9_]*)`?\s+/.exec(line);
        if(m) cols.add(m[1].toLowerCase());
    }
    return cols;
}

describe('rollback block-key coverage @regression', function () {

    // THE GUARD THAT WAS MISSING. rollback.js deletes every `blockTables` entry with a
    // literal `DELETE FROM <table> WHERE block_index >= ?`. That loop runs INSIDE the
    // reorg transaction, where doQuery re-throws instead of swallowing, so a table in
    // that list without a block_index column does not degrade: it raises errno 1054 and
    // aborts the entire rollback. Measured against the real DDL on MariaDB 10.11:
    // "Unknown column 'block_index' in 'WHERE'".
    //
    // The roll-call tables shipped classified `block` while keying their block scope on
    // close_block, so every reorg on an upgraded indexer threw. Nothing caught it,
    // because the classification and the schema are checked by different suites and
    // neither compares them to each other. This is that comparison.
    it('every table the generic block loop deletes actually declares block_index', function () {
        const missing = [];
        for(const table of lifecycle.rollbackTables().blockTables){
            const cols = declaredColumns(table);
            if(cols === null) continue;          // definition lives elsewhere; not this guard's business
            if(!cols.has('block_index')) missing.push(table);
        }
        assert.deepStrictEqual(missing, [],
            'These tables are classified rollback: \'block\', so rollback.js will run ' +
            '"DELETE FROM <table> WHERE block_index >= ?" against them inside the reorg ' +
            'transaction, where it throws errno 1054 and aborts the whole rollback. Either give ' +
            'the table a block_index column, or classify it rollback: \'special\' and add a ' +
            'bespoke delete on its real block-scoped key: ' + missing.join(', '));
    });

    // The other half. Moving a table to 'special' takes it out of every generic bucket,
    // so without a bespoke delete it is simply never rolled back and the node keeps
    // serving rows for orphaned blocks. That failure IS silent, so it needs its own pin.
    it('the roll-call tables are special-cased and deleted on their real block key', function () {
        const buckets = lifecycle.rollbackTables();
        for(const table of ['rollcalls', 'rollcall_absences']){
            for(const bucket of ['blockTables', 'dataTables', 'indexTables'])
                assert.ok(!buckets[bucket].includes(table),
                    table + ' must not be in ' + bucket + ': it has no block_index and no action_index');
        }

        const src = fs.readFileSync(ROLLBACK_SRC, 'utf8');
        const verdicts = src.indexOf('DELETE FROM rollcalls WHERE close_block >= ?');
        const absences = src.indexOf('DELETE FROM rollcall_absences WHERE close_block >= ?');
        assert.ok(absences !== -1, 'rollback.js must delete rollcall_absences on close_block');
        assert.ok(verdicts !== -1, 'rollback.js must delete rollcalls on close_block');
        assert.ok(absences < verdicts,
            'absences must be deleted BEFORE verdicts, so a partial failure cannot leave an ' +
            'absence row pointing at an epoch whose verdict is already gone');
    });

    // close_block is what the bespoke delete keys on, so it has to exist for the same
    // reason block_index has to exist for the generic loop. Same class of fault, one
    // level down.
    it('the roll-call tables declare the close_block key those deletes use', function () {
        for(const table of ['rollcalls', 'rollcall_absences']){
            const cols = declaredColumns(table);
            assert.ok(cols, 'could not parse ' + table + '.sql');
            assert.ok(cols.has('close_block'), table + ' must declare close_block');
            assert.ok(!cols.has('block_index'),
                table + ' declares block_index after all, so it belongs in the generic loop ' +
                'and this special case should be removed rather than left to rot');
        }
    });
});
