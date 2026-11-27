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
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('../../../../src/db');

const FILE = '2026-11-19-pending-hub-pushes-widen-payload.sql';
const SQL_DIR = path.join(__dirname, '..', '..', '..', '..', 'src', 'sql');
const DEFINITION = path.join(SQL_DIR, 'pending_hub_pushes.sql');
const MIGRATION = path.join(SQL_DIR, 'migrations', FILE);
const TARGET = 'MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL';

function payloadDefinition(file) {
    const line = fs.readFileSync(file, 'utf8').split('\n')
        .find(candidate => /^\s*(?:MODIFY\s+)?payload\s+/i.test(candidate));
    assert.ok(line, file + ' must declare pending_hub_pushes.payload');
    return line.replace(/^\s*(?:MODIFY\s+)?payload\s+/i, '').replace(/[;,].*$/, '').trim();
}

describe('pending_hub_pushes payload capacity @regression @tier1', function () {
    it('fresh and migrated schemas use the same MEDIUMTEXT utf8mb4 shape', function () {
        const migration = fs.readFileSync(MIGRATION, 'utf8');
        assert.match(migration, /^-- xchain:migration mode=manual deploy-precondition=required\s*$/m);
        assert.strictEqual(payloadDefinition(DEFINITION), TARGET);
        assert.strictEqual(payloadDefinition(MIGRATION), TARGET);
    });
});

describe('Database.MIGRATION_PRECONDITIONS[outbox payload widen] @regression @tier1', function () {
    const pre = Database.MIGRATION_PRECONDITIONS[FILE];

    it('reads the live type and charset for the exact outbox column', function () {
        assert.ok(pre, FILE + ' must have a MIGRATION_PRECONDITIONS entry');
        assert.strictEqual(typeof pre.skipWhen, 'function');
        assert.match(pre.sql, /DATA_TYPE/);
        assert.match(pre.sql, /CHARACTER_SET_NAME/);
        assert.match(pre.sql, /table_name = 'pending_hub_pushes'/);
        assert.match(pre.sql, /column_name = 'payload'/);
        assert.strictEqual((pre.sql.match(/\?/g) || []).length, 1);
    });

    it('baselines only wide utf8mb4 text types', function () {
        assert.match(pre.skipWhen([{ data_type: 'mediumtext', charset_name: 'utf8mb4' }]), /mediumtext/);
        assert.match(pre.skipWhen([{ data_type: 'LONGTEXT', charset_name: 'UTF8MB4' }]), /longtext/);
    });

    it('leaves every legacy or partial shape pending', function () {
        for (const rows of [
            [],
            [{ data_type: null, charset_name: null }],
            [{ data_type: 'text', charset_name: 'utf8mb4' }],
            [{ data_type: 'mediumtext', charset_name: 'utf8mb3' }],
            [{ data_type: 'mediumtext', charset_name: null }]
        ]) assert.strictEqual(pre.skipWhen(rows), null);
    });
});
