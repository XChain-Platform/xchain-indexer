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

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('../../../../src/db');
const { isTableDefinitionFile, tableNameOf } = require('../../../../src/db/database/schema/table_files.js');

const SQL_DIR = path.resolve(__dirname, '../../../../src/sql');

describe('startup schema table file suffix filter @regression', function () {
    it('never feeds a name containing extra text after .sql to the reconciler', async function () {
        const touched = [];
        const realRead = fs.readdirSync;
        fs.readdirSync = function (dir, ...args) {
            const files = realRead.call(fs, dir, ...args);
            return path.resolve(dir) === SQL_DIR
                ? files.concat(['balances.sql~', 'balances.sql.orig', 'rollcall_actions.sql.test.js']) : files;
        };
        try {
            const conn = {
                query: async (sql) => /table_type = 'BASE TABLE'/.test(sql) ? [] : [{}],
                release: async () => {},
            };
            const db = Object.create(Database.prototype);
            Object.assign(db, { dbName: 'test', getConnection: async () => conn,
                alterTableForDrift: async (file) => touched.push(file),
                reconcileTableIndexes: async () => {},
                createTable: async () => { throw new Error('all declared tables are live'); },
                util: { throwError(message) { throw new Error(message); } } });
            assert.strictEqual(await db.verifyTables(), true);
        } finally {
            fs.readdirSync = realRead;
        }
        assert.ok(touched.length > 0, 'the reconciler must inspect real table files');
        assert.ok(touched.every((file) => file.endsWith('.sql')), touched.join(','));
        assert.ok(!touched.some((file) => /\.sql(?:~|\.|\.orig)/.test(file)), touched.join(','));
    });

    it('derives names only from a terminal .sql suffix', function () {
        assert.strictEqual(isTableDefinitionFile('balances.sql'), true);
        assert.strictEqual(isTableDefinitionFile('balances.sql.orig'), false);
        assert.strictEqual(tableNameOf('balances.sql'), 'balances');
    });
});
