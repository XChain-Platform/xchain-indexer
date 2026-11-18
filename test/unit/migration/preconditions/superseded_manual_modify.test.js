// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// A mode=manual migration that restates a column a later migration restates again can be
// applied behind its successor: a scoped `--file` run of the later file leaves the earlier one
// pending, and the next blanket run applies it second, reverting the column. The runner's
// reorder guard only covers auto files, so the earlier file needs a live-schema precondition
// that baselines it once the column has moved on. These tests pin that for index_memos.memo
// and scan every committed migration for the same shape.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const Database = require('../../../../src/db');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', '..', '..', 'src', 'sql', 'migrations');
const WIDEN  = '2026-08-19-utf8mb4-index-memos-memo.sql';
const BINARY = '2026-11-01-index-memos-binary-collation.sql';

function stripComments(sql){
    return sql.split('\n').filter(line => !/^\s*--/.test(line)).join('\n');
}

// Every column a file restates with MODIFY, as 'table.column'.
function modifiedColumns(sql){
    const found = new Set();
    for(const statement of stripComments(sql).split(';')){
        const alter = /^\s*ALTER\s+TABLE\s+`?(\w+)`?/i.exec(statement);
        if(!alter) continue;
        for(const m of statement.matchAll(/\bMODIFY\s+(?:COLUMN\s+)?`?(\w+)`?/gi))
            found.add(alter[1].toLowerCase() + '.' + m[1].toLowerCase());
    }
    return found;
}

function migrationModes(files, read){
    return new Map(files.map(file => {
        const mode = /^--\s*xchain:migration\s+mode=(auto|manual)/m.exec(read(file));
        return [file, mode ? mode[1] : null];
    }));
}

// Earlier mode=manual files whose column a later file restates, with no precondition entry.
function unguardedSupersededManual(files, read, preconditions){
    const modes = migrationModes(files, read);
    const columns = new Map(files.map(file => [file, modifiedColumns(read(file))]));
    const unguarded = [];
    files.forEach((file, i) => {
        if(modes.get(file) !== 'manual' || preconditions[file]) return;
        for(const column of columns.get(file)){
            const later = files.slice(i + 1).find(next => columns.get(next).has(column));
            if(later) unguarded.push({ file, column, later });
        }
    });
    return unguarded;
}

const committedFiles = () => fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
const readCommitted  = (file) => fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

describe('index_memos.memo widen is baselined once the column has moved on @regression @tier1', function () {
    const pre = Database.MIGRATION_PRECONDITIONS[WIDEN];

    it('is registered and reads the live charset of index_memos.memo', function () {
        assert.ok(pre, WIDEN + ' must have a MIGRATION_PRECONDITIONS entry');
        assert.strictEqual(typeof pre.skipWhen, 'function');
        assert.match(pre.sql, /CHARACTER_SET_NAME/);
        assert.match(pre.sql, /table_name = 'index_memos'/);
        assert.match(pre.sql, /column_name = 'memo'/);
        assert.strictEqual((pre.sql.match(/\?/g) || []).length, 1);
    });

    it('baselines a column already at utf8mb4 whatever its collation', function () {
        assert.match(pre.skipWhen([{ charset_name: 'utf8mb4' }]), /utf8mb4/);
        assert.ok(pre.skipWhen([{ charset_name: 'UTF8MB4' }]));
    });

    it('leaves a utf8mb3 column to run the widen', function () {
        assert.strictEqual(pre.skipWhen([{ charset_name: 'utf8mb3' }]), null);
        assert.strictEqual(pre.skipWhen([{ charset_name: 'utf8' }]), null);
    });

    it('does not baseline an absent column or an unreadable charset', function () {
        assert.strictEqual(pre.skipWhen([]), null);
        assert.strictEqual(pre.skipWhen([{ charset_name: null }]), null);
        assert.strictEqual(pre.skipWhen([{}]), null);
        assert.strictEqual(pre.skipWhen(undefined), null);
    });

    it('is the verdict the runner reads for this file, so it cannot run after the binary collation', async function () {
        const live = { query: async () => [{ charset_name: 'utf8mb4' }] };
        const reason = await Database.prototype.migrationPreconditionSkip.call({ dbName: 'x' }, WIDEN, live);
        assert.strictEqual(typeof reason, 'string');
        assert.ok(fs.existsSync(path.join(MIGRATIONS_DIR, BINARY)));
        assert.strictEqual(Database.MIGRATION_PRECONDITIONS[BINARY], undefined);
    });
});

describe('a superseded mode=manual migration carries a precondition @regression @tier1', function () {
    it('finds the memo pair, so an empty scan cannot pass', function () {
        const files = committedFiles();
        assert.ok(modifiedColumns(readCommitted(WIDEN)).has('index_memos.memo'));
        assert.ok(modifiedColumns(readCommitted(BINARY)).has('index_memos.memo'));
        const unguarded = unguardedSupersededManual(files, readCommitted, {});
        assert.ok(unguarded.some(u => u.file === WIDEN && u.later === BINARY && u.column === 'index_memos.memo'),
            'without the precondition the scan must flag the memo widen');
    });

    it('flags nothing once the committed preconditions are applied', function () {
        assert.deepStrictEqual(
            unguardedSupersededManual(committedFiles(), readCommitted, Database.MIGRATION_PRECONDITIONS), []);
    });

    it('flags a manual file superseded by a later file, and passes it once guarded or auto', function () {
        const bodies = {
            'a.sql': '-- xchain:migration mode=manual\nALTER TABLE t MODIFY c INT NOT NULL;\n',
            'b.sql': '-- xchain:migration mode=manual\nALTER TABLE t MODIFY COLUMN c BIGINT NOT NULL;\n',
            'c.sql': '-- xchain:migration mode=auto\nALTER TABLE t MODIFY other INT;\n',
        };
        const files = Object.keys(bodies);
        const read = (f) => bodies[f];
        assert.deepStrictEqual(unguardedSupersededManual(files, read, {}),
            [{ file: 'a.sql', column: 't.c', later: 'b.sql' }]);
        assert.deepStrictEqual(unguardedSupersededManual(files, read, { 'a.sql': {} }), []);
        bodies['a.sql'] = bodies['a.sql'].replace('mode=manual', 'mode=auto');
        assert.deepStrictEqual(unguardedSupersededManual(files, read, {}), []);
    });
});
