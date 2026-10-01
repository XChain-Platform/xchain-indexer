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
 *********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const Database = require('../../../src/db');
const lifecycle = require('../../../src/hub/table_lifecycle.js');
const { DERIVED } = require('../../../src/hub/table_lifecycle/action_tables.js');
const { HUB_SCHEMA_VERSION } = require('../../../src/hub/hub_schema_version.js');
const admissionManifest = require('../db/mirror_admission_schema.test/helpers/manifest.js');

const ROOT = path.resolve(__dirname, '../../..');
const MIGRATION_FILE = '2026-09-30-list-share-tables.sql';

function read(relative){
    return fs.readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n/g, '\n');
}

function createBlock(sql, table){
    const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
        'CREATE TABLE(?: IF NOT EXISTS)? ' + escaped + ' \\([\\s\\S]*?\\) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;'
    );
    const match = re.exec(sql);
    assert.ok(match, 'missing CREATE TABLE block for ' + table);
    return match[0].replace('CREATE TABLE IF NOT EXISTS', 'CREATE TABLE');
}

describe('shared-list table contracts @regression @tier1', function () {
    it('pins the append-only list_snapshots lifecycle row', function () {
        const row = lifecycle.entry('list_snapshots');
        assert.ok(row, 'list_snapshots is absent from the lifecycle registry');
        assert.strictEqual(row.replication, 'hub-mirror');
        assert.strictEqual(row.rollback, 'exempt');
        assert.strictEqual(row.replicaRollback, 'exempt');
        assert.deepStrictEqual(row.hashed.classes, ['quorum']);
        assert.ok(row.hashed.note, 'list_snapshots must explain its quorum coverage');
    });

    it('pins the local list_share_mirrors lifecycle row', function () {
        const row = lifecycle.entry('list_share_mirrors');
        assert.ok(row, 'list_share_mirrors is absent from the lifecycle registry');
        assert.strictEqual(row.replication, 'stream:action');
        assert.strictEqual(row.rollback, 'action');
        assert.strictEqual(row.replicaRollback, 'mirror');
        assert.deepStrictEqual(row.hashed, DERIVED);
    });

    it('keeps both migration CREATE blocks byte-consistent with fresh-build SQL', function () {
        const migration = read('src/sql/migrations/' + MIGRATION_FILE);
        for(const table of ['list_snapshots', 'list_share_mirrors']){
            const fresh = createBlock(read('src/sql/' + table + '.sql'), table);
            assert.strictEqual(createBlock(migration, table), fresh, table + ' migration DDL drifted');
        }
    });

    it('baselines only when both shared-list tables are present', function () {
        const pre = Database.MIGRATION_PRECONDITIONS[MIGRATION_FILE];
        assert.ok(pre, MIGRATION_FILE + ' has no baseline probe');
        assert.strictEqual((pre.sql.match(/\?/g) || []).length, 1);
        assert.match(pre.sql, /information_schema\.tables/i);
        assert.strictEqual(pre.skipWhen([{ name: 'list_snapshots' }]), null);
        assert.strictEqual(pre.skipWhen([{ name: 'list_share_mirrors' }]), null);
        assert.strictEqual(pre.skipWhen([]), null);
        assert.ok(pre.skipWhen([
            { name: 'list_snapshots' },
            { name: 'list_share_mirrors' },
        ]));
    });

    it('registers the fail-closed startup assertion', function () {
        const entry = Database.STARTUP_ASSERTED_MIGRATIONS.find(m => m.file === MIGRATION_FILE);
        assert.ok(entry, MIGRATION_FILE + ' is absent from STARTUP_ASSERTED_MIGRATIONS');
        assert.strictEqual(entry.assertion, 'assertListShareTablesPresent');
        assert.strictEqual(typeof Database.prototype.assertListShareTablesPresent, 'function');
    });

    it('pins the shared-list mirror contract to hub schema version 8', function () {
        assert.strictEqual(HUB_SCHEMA_VERSION, 8);
    });

    it('classifies list snapshot admission heights as indexer mirror columns', function () {
        assert.deepStrictEqual(
            [...admissionManifest.MIRROR_ADMISSION_COLUMNS.list_snapshots.columns],
            ['admit_block_btc', 'admit_block_ltc', 'admit_block_doge']
        );
        assert.strictEqual(admissionManifest.MIRROR_ADMISSION_COLUMNS.list_snapshots.after, 'origin_block');
        assert.ok(!Object.hasOwn(admissionManifest.HUB_ONLY_ADMISSION_COLUMNS, 'list_snapshots'));
    });
});
