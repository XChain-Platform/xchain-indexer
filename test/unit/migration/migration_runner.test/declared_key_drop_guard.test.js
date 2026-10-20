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
 * Schema migration runner: the declared-key drop guard of the auto-apply path.
 *
 * verifyTables runs before runMigrations, so a mode=auto file that drops a key
 * src/sql still declares UNIQUE or PRIMARY would leave the table without it for the
 * whole process. The guard refuses that drop unless the same file re-creates the key.
 *
 ********************************************************************/

const crypto = require('crypto');
const sinon = require('sinon');
const { assert, fs, path, Database, statementsOf, modeOf, SQL_MODE_PROBE, pinnedSqlModeRows, BRIDGE_TABLES_PROBE,
        bridgeTablesPresent, LIST_SHARE_TABLES_PROBE, listShareTablesPresent } = require('./helpers/migration_fixtures.js');
const { assertNoDeclaredKeyDrop } = require('../../../../src/db/database/migration_guards/declared_key_drop.js');

const SQL_DIR = path.join(__dirname, '..', '..', '..', '..', 'src', 'sql');
const MIG_DIR = path.join(SQL_DIR, 'migrations');
const sqlFor = (table) => {
    try { return fs.readFileSync(path.join(SQL_DIR, table + '.sql'), 'utf8'); }
    catch (err) { if (err.code === 'ENOENT') return null; throw err; }
};
const guard = (sql) => assertNoDeclaredKeyDrop('t.sql', statementsOf(sql), sqlFor);

describe('declared-key drop guard @regression @tier1', function () {
    it('refuses a drop of a declared UNIQUE or PRIMARY key that the file never re-creates', function () {
        for (const sql of [
            'DROP INDEX uq_cap_snap ON capability_snapshots;',
            'ALTER TABLE capability_snapshots DROP KEY uq_cap_snap;',
            'ALTER TABLE `capability_snapshots` DROP INDEX IF EXISTS `uq_cap_snap`;',
            'ALTER TABLE capability_snapshots DROP CONSTRAINT uq_cap_snap;',
            'ALTER TABLE anchor_actions DROP PRIMARY KEY;',
            'ALTER TABLE capability_snapshots DROP INDEX uq_cap_snap, ADD INDEX uq_cap_snap (source);',
        ]) {
            assert.throws(() => guard(sql), /drops (UNIQUE|PRIMARY) key (uq_cap_snap|primary) on (capability_snapshots|anchor_actions)/, sql);
        }
    });

    it('allows a drop the same file re-creates under the same name and kind', function () {
        for (const sql of [
            'ALTER TABLE anchor_actions DROP PRIMARY KEY, ADD PRIMARY KEY (id);',
            'ALTER TABLE capability_snapshots DROP INDEX uq_cap_snap, ADD UNIQUE KEY uq_cap_snap (source);',
            'DROP INDEX uq_cap_snap ON capability_snapshots;\nCREATE UNIQUE INDEX uq_cap_snap ON capability_snapshots (source);',
        ]) {
            assert.doesNotThrow(() => guard(sql), sql);
        }
    });

    it('allows a drop of a key src/sql does not declare UNIQUE, and of a table with no src/sql file', function () {
        assert.doesNotThrow(() => guard('DROP INDEX action_index ON destroys;'));
        assert.doesNotThrow(() => guard('ALTER TABLE no_such_source_table DROP PRIMARY KEY;'));
    });

    it('fails closed on a key drop it cannot read', function () {
        assert.throws(() => guard('DROP INDEX ON capability_snapshots;'), /drops a key this guard cannot read/);
    });
});

describe('committed mode=auto migrations drop no declared key @regression @tier1', function () {
    for (const file of fs.readdirSync(MIG_DIR).filter((name) => name.endsWith('.sql')).sort()) {
        it(file + ': if tagged mode=auto, passes the declared-key drop guard', function () {
            const raw = fs.readFileSync(path.join(MIG_DIR, file), 'utf8');
            if (modeOf(raw) !== 'auto') return;
            assert.doesNotThrow(() => assertNoDeclaredKeyDrop(file, statementsOf(raw), sqlFor));
        });
    }
});

describe('Database.runMigrations() applies the declared-key drop guard @regression @tier1', function () {
    afterEach(() => sinon.restore());

    it('refuses an auto file that drops a declared UNIQUE key before running any statement', async function () {
        const files = fs.readdirSync(MIG_DIR).filter((name) => name.endsWith('.sql')).sort();
        const target = files[files.length - 1];
        const body = '-- xchain:migration mode=auto\nDROP INDEX uq_cap_snap ON capability_snapshots;\n';
        const realRead = fs.readFileSync;
        sinon.stub(fs, 'readFileSync').callsFake(function (p, ...rest) {
            return p === path.join(MIG_DIR, target) ? body : realRead.call(fs, p, ...rest);
        });
        const ledger = files.filter((f) => f !== target).map((name) => ({
            name, checksum: crypto.createHash('sha256').update(realRead.call(fs, path.join(MIG_DIR, name), 'utf8')).digest('hex') }));
        const ran = [];
        const conn = { release: async () => {}, query: async (sql) => {
            if (SQL_MODE_PROBE.test(sql)) return pinnedSqlModeRows();
            if (/GET_LOCK/i.test(sql)) return [{ l: 1 }];
            if (/SELECT name, checksum FROM schema_migrations/i.test(sql)) return ledger;
            if (BRIDGE_TABLES_PROBE.test(sql)) return bridgeTablesPresent();
            if (LIST_SHARE_TABLES_PROBE.test(sql)) return listShareTablesPresent();
            if (/^DROP INDEX/i.test(sql)) ran.push(sql);
            return [];
        } };
        const db = Object.assign(Object.create(Database.prototype),
            { dbName: 'test_indexer', transactionConnection: null, getConnection: async () => conn });
        await assert.rejects(Database.prototype.runMigrations.call(db, {}),
            new RegExp(target + ' is tagged mode=auto but drops UNIQUE key uq_cap_snap on capability_snapshots'));
        assert.deepStrictEqual(ran, [], 'the DROP INDEX never ran');
    });
});
