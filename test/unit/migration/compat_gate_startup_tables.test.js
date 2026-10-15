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
/*
 * The old-code compat gate (bin/check-migration-old-code-compat.js) runs the product's
 * runMigrations, which ends in the assert*TablesPresent startup assertions. Those need
 * the bridge and shared-list tables, which the gate's old-ref build does not create, so
 * the gate must build whatever the assertions require. This pins the gate's setup list to
 * the assertions' own REQUIRED lists, so a table added to an assertion cannot silently
 * break the gate again.
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const Database = require('../../../src/db');
const G        = require('../../../bin/check-migration-old-code-compat.js');
const SQL_DIR  = path.join(__dirname, '..', '..', '..', 'src', 'sql');

const ASSERTIONS = Object.getOwnPropertyNames(Database.prototype).filter(n => /^assert.*TablesPresent$/.test(n));

describe('compat gate: startup-required tables', function(){
    it('exports the startup table reader and builder', function(){
        assert.strictEqual(typeof G.startupRequiredTables, 'function');
        assert.strictEqual(typeof G.buildStartupRequiredTables, 'function');
    });

    it('covers every table named in each assert*TablesPresent REQUIRED list', function(){
        assert.ok(ASSERTIONS.length >= 2, 'expected the bridge and list-share assertions, saw ' + ASSERTIONS.join(','));
        const covered = new Set(G.startupRequiredTables());
        for(const name of ASSERTIONS){
            const m = /const\s+REQUIRED\s*=\s*\[([^\]]*)\]/.exec(Database.prototype[name].toString());
            assert.ok(m, name + ' has no REQUIRED list');
            for(const t of [...m[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]))
                assert.ok(covered.has(t), name + ' requires ' + t + ' but the gate does not build it');
        }
        for(const t of ['bridge_transfers', 'bridge_settlements', 'policy_snapshots', 'xbridges', 'list_snapshots', 'list_share_mirrors'])
            assert.ok(covered.has(t), t + ' missing from the gate setup list');
    });

    it('every required table has a src/sql definition the product createTable can build', function(){
        for(const t of G.startupRequiredTables())
            assert.ok(fs.existsSync(path.join(SQL_DIR, t + '.sql')), 'no src/sql/' + t + '.sql');
    });

    it('builds the missing tables through db.createTable, skipping live and skipped ones', async function(){
        const all   = G.startupRequiredTables();
        const live  = all[0];
        const skip  = all[1];
        const calls = [];
        const db    = { createTable: async f => { calls.push(f); } };
        const raw   = async () => [{ n: live }];
        const built = await G.buildStartupRequiredTables(db, raw, 'x', new Set([skip]));
        const expected = all.filter(t => t !== live && t !== skip);
        assert.deepStrictEqual(built, expected);
        assert.deepStrictEqual(calls, expected.map(t => t + '.sql'));
    });
});
