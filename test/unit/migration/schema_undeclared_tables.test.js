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
 *
 * The boot schema-shape summary names a whole live table that no src/sql
 * file declares, so an aged DB still holding a retired table prints a
 * different line from a fresh install of the same release.
 *
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const Database = require('../../../src/db');

const SQL_DIR = path.join(__dirname, '..', '..', '..', 'src', 'sql');

// The boot pass over the real src/sql definitions, against a fake connection whose live
// table listing is the fixture. Returns the drift store and every statement issued.
async function bootWithLiveTables(liveTables, listingError) {
    const issued = [];
    const declared = fs.readdirSync(SQL_DIR).filter(f => f.endsWith('.sql'));
    const connection = {
        async query(sql, params) {
            issued.push(sql);
            if (/table_type = 'BASE TABLE'/.test(sql)) {
                if (listingError) throw listingError;
                return liveTables.map(name => ({ name }));
            }
            if (/information_schema\.tables/i.test(sql)) return [{}];
            throw new Error('unexpected statement: ' + sql);
        },
        async release() {},
    };
    const inst = Object.create(Database.prototype);
    Object.assign(inst, {
        dbName: 'xchain_test',
        util: { throwError(message) { throw new Error(message); } },
        getConnection: async () => connection,
        alterTableForDrift: async () => {},
        reconcileTableIndexes: async () => {},
    });
    assert.strictEqual(await inst.verifyTables(), true);
    return { store: inst.schemaShapeDrift, issued, summary: inst.schemaShapeSummary(), declared };
}

describe('startup drift detection sees whole live tables no SQL source declares @regression', function () {

    it('names a retired table that an aged DB still holds', async function () {
        const { store, summary, declared } = await bootWithLiveTables(['balances', 'contract_balances']);
        assert.ok(!declared.includes('contract_balances.sql'), 'fixture assumption: the table is retired');
        assert.deepStrictEqual([...store.keys()], ['contract_balances']);
        assert.ok(/^SCHEMA SHAPE DRIFT: 1 table\(s\) carry 1 undeclared table\(s\), /.test(summary), summary);
        assert.ok(summary.includes('contract_balances: undeclared table (no src/sql/contract_balances.sql)'), summary);
    });

    it('never flags a declared table or one a sharing service owns', async function () {
        const live = ['balances', 'schema_migrations', 'sync_meta', 'merkle_epochs', 'merkle_reorgs',
            'sync_halt', 'sync_state', 'state_tree_roots', 'state_tree_nodes', 'escrow_leaf_journal'];
        const { store, summary } = await bootWithLiveTables(live);
        assert.strictEqual(store.size, 0, JSON.stringify([...store.keys()]));
        assert.strictEqual(summary, 'Schema shape: no undeclared tables, columns or indexes.');
    });

    it('records nothing and still boots when the table listing cannot be read', async function () {
        const { store } = await bootWithLiveTables(['contract_balances'], new Error('listing refused'));
        assert.strictEqual(store.size, 0);
    });

    it('only reads: the table check issues no DROP or ALTER', async function () {
        const { issued } = await bootWithLiveTables(['contract_balances', 'leftover_backup']);
        assert.deepStrictEqual(issued.filter(sql => /\b(DROP|ALTER)\b/i.test(sql)), []);
    });

    // A table the sync service ships in its own src/sql lands in this DB too; skipped when
    // that repo is not checked out beside this one.
    it('covers every table the sibling sync service creates in this DB', async function () {
        const syncSql = path.join(__dirname, '..', '..', '..', '..', 'xchain-sync', 'src', 'sql');
        if (!fs.existsSync(syncSql)) return this.skip();
        const live = fs.readdirSync(syncSql).filter(f => f.endsWith('.sql')).map(f => f.slice(0, -4));
        assert.ok(live.length > 0, 'fixture assumption: the sync service declares tables');
        const { store } = await bootWithLiveTables(live);
        assert.deepStrictEqual([...store.keys()], [], 'add the table to the infrastructure set');
    });
});
