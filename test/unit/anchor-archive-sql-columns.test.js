'use strict';

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
 * Every column the shared archive queries reference must EXIST in the canonical
 * schema definitions (src/sql/*.sql).
 *
 * These queries decide consensus-visible archive verdicts and none of them is
 * reachable from the unit tier, which stubs the DB: a column that does not exist
 * fails at runtime on a real MariaDB, and a column that exists but MEANS something
 * else fails silently and forever. This suite exists because that second kind was
 * hit while the archive replay guard was being built:
 * `anchor_actions.block_index` is the CHECKPOINTED height on the
 * checkpointed chain (NULL on a v2 chunk), while the DOGE height the ANCHOR itself
 * landed at, which is what a flag day is keyed on, is `block_index_doge`. The
 * stubs were perfectly happy with either.
 *
 * Existence is all this can prove; meaning still belongs to the column comments and
 * to review. That is enough to make the first kind impossible and to force the
 * second kind to be written down.
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const Database = require('../../src/db');
const q        = require('../../src/anchor-action-query.js');

const SQL_DIR = path.join(__dirname, '..', '..', 'src', 'sql');

// table -> Set(column names), parsed with the SAME parser the startup drift
// reconciler uses, so a parse gap here is a parse gap there.
function definitionColumns() {
    const out = {};
    for (const file of fs.readdirSync(SQL_DIR).filter(f => f.endsWith('.sql'))) {
        const raw = fs.readFileSync(path.join(SQL_DIR, file), 'utf8');
        const columns = Database.prototype.parseExpectedColumns.call(
            { stripSqlLineComments: Database.prototype.stripSqlLineComments }, raw);
        if (!columns) continue;
        out[file.slice(0, -4)] = new Set(columns.map(c => c.name));
    }
    return out;
}

// alias -> table, from `FROM <table> <alias>` / `JOIN <table> <alias>` (the shape every
// query in anchor-action-query.js uses).
function aliasMap(sql) {
    const map = {};
    for (const m of String(sql).matchAll(/\b(?:FROM|JOIN)\s+(\w+)\s+(\w+)\b/gi)) {
        const [, table, alias] = m;
        if (/^(ON|WHERE|ORDER|GROUP|LIMIT|LEFT|INNER|JOIN|AS)$/i.test(alias)) continue;
        map[alias] = table;
    }
    return map;
}

// Every `alias.column` reference in a query, minus `alias.*`.
function columnRefs(sql) {
    return Array.from(String(sql).matchAll(/\b(\w+)\.(\w+)\b/g))
        .map(m => ({ alias: m[1], column: m[2] }));
}

const QUERIES = [
    ['ARCHIVE_HEAD_AUTHOR_SQL',          q.ARCHIVE_HEAD_AUTHOR_SQL],
    ['ARCHIVE_CHUNK_SET_SQL',            q.ARCHIVE_CHUNK_SET_SQL],
    ['ARCHIVE_CHUNK_SET_BY_AUTHOR_SQL',  q.ARCHIVE_CHUNK_SET_BY_AUTHOR_SQL],
    ['ARCHIVE_HEAD_GATE_SQL',            q.ARCHIVE_HEAD_GATE_SQL],
    ['ANCHOR_ACTIONS_SQL',               q.ANCHOR_ACTIONS_SQL],
];

describe('archive query column references exist in the canonical schema @regression @tier1', function () {
    const defs = definitionColumns();

    before(function () {
        // Guard the guard: if the DDL parser stops yielding these tables, every case
        // below would pass vacuously.
        for (const t of ['anchor_actions', 'actions', 'index_addresses', 'index_statuses'])
            assert.ok(defs[t] && defs[t].size > 0, 'schema definition for ' + t + ' must parse');
    });

    QUERIES.forEach(function ([name, sql]) {
        it(name + ' references only columns that exist', function () {
            assert.ok(sql, name + ' must be exported');
            const aliases = aliasMap(sql);
            let checked = 0;
            for (const { alias, column } of columnRefs(sql)) {
                const table = aliases[alias];
                if (!table) continue;                 // not a table alias (e.g. a function call)
                if (!defs[table]) continue;           // table has no local definition file
                assert.ok(defs[table].has(column),
                    name + ': ' + table + '.' + column + ' does not exist in src/sql/' + table + '.sql');
                checked++;
            }
            assert.ok(checked > 0, name + ': no column reference was actually checked');
        });
    });

    // The block_index / block_index_doge mix-up, pinned by name so it cannot come back as a "cleanup".
    it('the flag-day gate reads the ANCHOR chain height, not the checkpointed height', function () {
        assert.ok(defs['anchor_actions'].has('block_index_doge'));
        assert.ok(defs['anchor_actions'].has('block_index'));
        assert.match(q.ARCHIVE_HEAD_GATE_SQL, /block_index_doge/,
            'block_index is the checkpointed height on the checkpointed chain and is NULL on a v2 chunk');
    });
});
