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
 **********************************************************************/

'use strict';

const assert = require('assert');
const Database = require('../../../../src/db');

async function bootWithExisting(existingNames) {
    const existing = new Set(existingNames);
    const created = [];
    const reconciled = [];
    let seeded = 0;
    const connection = {
        async query(sql, params) {
            if(/table_type = 'BASE TABLE'/.test(sql))
                return [...existing].map(name => ({ name }));
            if(/information_schema\.tables/i.test(sql))
                return existing.has(params[1]) ? [{}] : [];
            throw new Error('unexpected statement: ' + sql);
        },
        async release() {}
    };
    const db = Object.create(Database.prototype);
    Object.assign(db, {
        dbName: 'bootstrap_race',
        util: { throwError(message) { throw new Error(message); } },
        getConnection: async () => connection,
        recordFreshSchemaMigrations: async () => { seeded++; },
        createTable: async file => { created.push(file.slice(0, -4)); },
        alterTableForDrift: async file => { reconciled.push(file.slice(0, -4)); },
        reconcileTableIndexes: async () => {},
        schemaShapeSummary: () => 'Schema shape: fixture.'
    });
    assert.strictEqual(await db.verifyTables(), true);
    return { created, reconciled, seeded };
}

describe('fresh schema detection tolerates sync-created indexer tables @regression @tier1', function () {
    const shared = ['state_tree_roots', 'state_tree_nodes', 'escrow_leaf_journal'];

    it('seeds the migration ledger when only shared tables already exist', async function () {
        const result = await bootWithExisting(shared);
        assert.strictEqual(result.seeded, 1);
        assert.deepStrictEqual(result.reconciled.slice().sort(), shared.slice().sort());
        assert.ok(!result.created.some(name => shared.includes(name)));
    });

    it('does not seed when an indexer-only declared table already exists', async function () {
        const result = await bootWithExisting(shared.concat('balances'));
        assert.strictEqual(result.seeded, 0);
    });
});
