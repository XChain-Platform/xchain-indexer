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
 * test/unit/db/db_ledger_retype.test.js
 *
 * Pin the migration ledger retype helper as an isolated schema operation.
 */

'use strict';

const assert = require('assert');
const { retypeLedgerAppliedAt } = require('../../../src/db/database/ledger_retype');

const READ_SQL = "SELECT DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schema_migrations' AND COLUMN_NAME = 'applied_at'";
const ALTER_SQL = 'ALTER TABLE schema_migrations MODIFY applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP';

function recordingConnection(rows){
    const queries = [];
    return {
        queries,
        async query(sql){
            queries.push(sql);
            return queries.length === 1 ? rows : [];
        }
    };
}

describe('retypeLedgerAppliedAt', function () {
    it('retypes a lowercase timestamp column', async function () {
        const conn = recordingConnection([{ DATA_TYPE: 'timestamp' }]);

        assert.strictEqual(await retypeLedgerAppliedAt(conn), true);
        assert.deepStrictEqual(conn.queries, [READ_SQL, ALTER_SQL]);
    });

    it('retypes an uppercase timestamp answer from a lowercase field', async function () {
        const conn = recordingConnection([{ data_type: 'TIMESTAMP' }]);

        assert.strictEqual(await retypeLedgerAppliedAt(conn), true);
        assert.deepStrictEqual(conn.queries, [READ_SQL, ALTER_SQL]);
    });

    it('leaves an existing datetime column unchanged', async function () {
        const conn = recordingConnection([{ DATA_TYPE: 'datetime' }]);

        assert.strictEqual(await retypeLedgerAppliedAt(conn), false);
        assert.deepStrictEqual(conn.queries, [READ_SQL]);
    });

    it('leaves the ledger unchanged when the column is absent', async function () {
        const conn = recordingConnection([]);

        assert.strictEqual(await retypeLedgerAppliedAt(conn), false);
        assert.deepStrictEqual(conn.queries, [READ_SQL]);
    });
});
