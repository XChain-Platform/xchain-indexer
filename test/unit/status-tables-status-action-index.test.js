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
 * : the per-block expiry sweep (getExpiredItems) probes
 * order_statuses / swap_statuses / dispenser_statuses filtered by
 * status_id (the index_statuses 'open' join) and needs action_index for
 * the latest-status check. A composite (status_id, action_index) index
 * bounds that probe; it supersedes the single-column status_id index
 * (leftmost prefix), which is dropped.
 *
 * This guards BOTH schema-construction paths (see sql-schema-index-parity):
 *   - DEFINITION: src/sql/<table>.sql declares the composite and no longer
 *     declares the single-column status_id index, so a fresh install builds
 *     exactly the composite and reconcileTableIndexes self-heals it onto an
 *     aged DB at boot.
 *   - LEDGER: a dated mode=auto migration ADDs the composite (belt-and-
 *     suspenders) and DROPs the redundant single-column status_id on aged DBs.
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const SQL_DIR = path.join(__dirname, '..', '..', 'src', 'sql');
const MIG_DIR = path.join(SQL_DIR, 'migrations');
const TABLES  = ['order_statuses', 'swap_statuses', 'dispenser_statuses'];

// Parse standalone `CREATE [UNIQUE] INDEX <name> ON <table> (<cols>)` from a
// table's SQL source into [{name, columns:[...]}], mirroring how the runtime
// reconciler (db.js parseExpectedIndexes) reads them.
function standaloneIndexes(table){
    const raw = fs.readFileSync(path.join(SQL_DIR, table + '.sql'), 'utf8')
        .replace(/^\s*--[^\n]*$/gm, '');                        // strip line comments
    const re  = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+`?(\w+)`?\s+ON\s+`?(\w+)`?\s*\(([^)]+)\)/gi;
    const out = [];
    let m;
    while((m = re.exec(raw)) !== null){
        if(m[2].toLowerCase() !== table) continue;
        const columns = m[3].split(',').map(c => c.trim().replace(/`/g, '').split(/\s+/)[0]).filter(Boolean);
        out.push({ name: m[1], columns });
    }
    return out;
}

describe(' status-table composite (status_id, action_index) index @regression', function(){

    for(const table of TABLES){
        describe(table, function(){

            it('declares the composite (status_id, action_index) index in the base schema', function(){
                const composite = standaloneIndexes(table).find(i =>
                    i.columns.length === 2 && i.columns[0] === 'status_id' && i.columns[1] === 'action_index');
                assert.ok(composite,
                    table + '.sql must declare a standalone CREATE INDEX on (status_id, action_index) so a fresh ' +
                    'install builds it and reconcileTableIndexes self-heals it onto aged DBs');
            });

            it('no longer declares a standalone single-column status_id index (redundant, dropped)', function(){
                const single = standaloneIndexes(table).find(i =>
                    i.columns.length === 1 && i.columns[0] === 'status_id');
                assert.ok(!single,
                    table + '.sql still declares a single-column status_id index; the composite (status_id, ' +
                    'action_index) covers it as a leftmost prefix, so the single-column form must be removed to ' +
                    'keep fresh installs consistent with the migration that drops it on aged DBs');
            });
        });
    }

    it('a dated mode=auto migration adds the composite and drops the single-column status_id for all three tables', function(){
        const files = fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql'));
        // Find the migration that carries the composite for these tables.
        let migRaw = null;
        for(const f of files){
            const raw = fs.readFileSync(path.join(MIG_DIR, f), 'utf8');
            if(/ADD\s+INDEX\s+IF\s+NOT\s+EXISTS\s+`?status_action`?\s*\(\s*status_id\s*,\s*action_index\s*\)/i.test(raw)){
                assert.ok(/^\s*--\s*xchain:migration\b[^\n]*\bmode\s*=\s*auto\b/im.test(raw),
                    f + ' must be tagged `-- xchain:migration mode=auto` (ADD/DROP INDEX is idempotent and non-destructive)');
                migRaw = raw;
                break;
            }
        }
        assert.ok(migRaw, 'no migration ADDs the composite status_action (status_id, action_index) index');
        for(const table of TABLES){
            const tRe = new RegExp('ALTER\\s+TABLE\\s+`?' + table + '`?', 'i');
            assert.ok(tRe.test(migRaw), 'migration does not touch ' + table);
            const addRe  = new RegExp('ALTER\\s+TABLE\\s+`?' + table + '`?\\s+ADD\\s+INDEX\\s+IF\\s+NOT\\s+EXISTS\\s+`?status_action`?\\s*\\(\\s*status_id\\s*,\\s*action_index\\s*\\)', 'i');
            const dropRe = new RegExp('ALTER\\s+TABLE\\s+`?' + table + '`?\\s+DROP\\s+INDEX\\s+IF\\s+EXISTS\\s+`?status_id`?', 'i');
            assert.ok(addRe.test(migRaw),  'migration must ADD INDEX IF NOT EXISTS status_action (status_id, action_index) on ' + table);
            assert.ok(dropRe.test(migRaw), 'migration must DROP INDEX IF EXISTS status_id on ' + table);
        }
    });
});
