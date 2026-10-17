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
 * Every table the mirror can retract declares the fence column its DELETE names.
 *
 * A fenced retraction appends `push_generation <= ?` (per leg on cross_chain_matches)
 * whatever the local schema holds, so a retractable table whose DDL lacks that column
 * has a DELETE that can only fail with ER_BAD_FIELD_ERROR. Read from the DDL files, not
 * from a mock, so a mocked doQuery can never certify SQL the real table cannot run.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { RETRACTION_COLUMNS } = require('../../../../src/hub/hub_db_sync/mirror_tables.js');

const SQL_DIR = path.join(__dirname, '..', '..', '..', '..', 'src', 'sql');

// The column names a CREATE TABLE file declares, one per indented column line.
function declaredColumns(table){
    const sql = fs.readFileSync(path.join(SQL_DIR, table + '.sql'), 'utf8');
    const out = new Set();
    for(const line of sql.split('\n')){
        const m = line.match(/^\s+([a-z_][a-z0-9_]*)\s+[A-Z]/);
        if(m) out.add(m[1]);
    }
    return out;
}

describe('hub_db_sync retraction fence columns', function(){
    it('declares push_generation on every RETRACTION_COLUMNS table and on cross_chain_calls', function(){
        const tables = Object.keys(RETRACTION_COLUMNS).concat(['cross_chain_calls']);
        assert.ok(tables.length >= 4, 'the retractable set is unexpectedly small: ' + tables.join(', '));
        for(const table of tables)
            assert.ok(declaredColumns(table).has('push_generation'),
                table + ' is retractable but its DDL declares no push_generation fence column');
    });

    it('declares both per-leg fence columns on cross_chain_matches', function(){
        const columns = declaredColumns('cross_chain_matches');
        assert.ok(columns.has('a_push_generation'), 'cross_chain_matches lacks a_push_generation');
        assert.ok(columns.has('b_push_generation'), 'cross_chain_matches lacks b_push_generation');
    });
});
