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
 ********************************************************************/

'use strict';

const assert = require('assert');
const Database = require('../../../src/db');

const TYPE_READ = "SELECT DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schema_migrations' AND COLUMN_NAME = 'applied_at'";
const TYPE_ALTER = 'ALTER TABLE schema_migrations MODIFY applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP';

function connectionWithType(dataType){
    const queries = [];
    return {
        queries,
        async query(sql){
            queries.push(sql);
            return sql === TYPE_READ ? [{ DATA_TYPE: dataType }] : [];
        }
    };
}

describe('migration ledger applied_at type', function () {
    it('creates new ledgers with a DATETIME applied_at', async function () {
        const conn = connectionWithType('datetime');

        await Database.prototype.ensureMigrationsLedger.call({}, conn);

        const create = conn.queries.find(sql => /^CREATE TABLE/.test(sql));
        assert.match(create, /applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP/);
        assert.doesNotMatch(create, /\bTIMESTAMP\b/i);
    });

    it('retypes an existing TIMESTAMP applied_at exactly once', async function () {
        const conn = connectionWithType('timestamp');

        await Database.prototype.ensureMigrationsLedger.call({}, conn);

        assert.deepStrictEqual(conn.queries.filter(sql => /^ALTER TABLE/.test(sql)), [TYPE_ALTER]);
    });

    it('does not alter an existing DATETIME applied_at', async function () {
        const conn = connectionWithType('datetime');

        await Database.prototype.ensureMigrationsLedger.call({}, conn);

        assert.strictEqual(conn.queries.filter(sql => /^ALTER TABLE/.test(sql)).length, 0);
    });
});
