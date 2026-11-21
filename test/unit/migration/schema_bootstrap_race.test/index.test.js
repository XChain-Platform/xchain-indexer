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
const fs = require('fs');
const path = require('path');
const Database = require('../../../../src/db');
const { isTableDefinitionFile, tableNameOf } = require('../../../../src/db/database/schema/table_files.js');

const SQL_DIR = path.join(__dirname, '../../../../src/sql');
const TABLE_FILES = fs.readdirSync(SQL_DIR).filter(isTableDefinitionFile);
const TABLE_NAMES = TABLE_FILES.map(tableNameOf);

async function bootWithExisting(existingNames, options = {}) {
    const existing = new Set(existingNames);
    const created = [];
    const reconciled = [];
    const events = [];
    let seeded = 0;
    const connection = {
        async query(sql, params) {
            if(/GET_LOCK/i.test(sql)){
                events.push('lock');
                if(options.appearAtLock) existing.add(options.appearAtLock);
                return [{ l: options.lockResult === undefined ? 1 : options.lockResult }];
            }
            if(/RELEASE_LOCK/i.test(sql)){
                events.push('release-lock');
                return [{ l: 1 }];
            }
            if(/table_type = 'BASE TABLE'/.test(sql))
                return [...existing].map(name => ({ name }));
            if(/information_schema\.tables/i.test(sql)){
                events.push('exists:' + params[1]);
                return existing.has(params[1]) ? [{}] : [];
            }
            throw new Error('unexpected statement: ' + sql);
        },
        async release() { events.push('release-connection'); }
    };
    const db = Object.create(Database.prototype);
    Object.assign(db, {
        dbName: 'bootstrap_race',
        util: { throwError(message) { throw new Error(message); } },
        getConnection: async () => connection,
        recordFreshSchemaMigrations: async (_connection, lockOptions) => {
            seeded++;
            events.push('seed:' + Boolean(lockOptions && lockOptions.lockHeld));
        },
        createTable: async file => {
            const table = tableNameOf(file);
            events.push('create:' + table);
            if(options.failCreate === table) throw new Error('create failed');
            if(options.tableExistsError === table){
                if(options.appearDuringCreate) existing.add(table);
                throw Object.assign(new Error('already exists'), {
                    errno: 1050,
                    code: 'ER_TABLE_EXISTS_ERROR',
                });
            }
            created.push(table);
        },
        alterTableForDrift: async file => {
            const table = tableNameOf(file);
            events.push('reconcile:' + table);
            reconciled.push(table);
        },
        reconcileTableIndexes: async () => {},
        schemaShapeSummary: () => 'Schema shape: fixture.'
    });
    let error = null;
    try { assert.strictEqual(await db.verifyTables(), true); }
    catch(caught){ error = caught; }
    if(!options.expectError && error) throw error;
    return { created, reconciled, seeded, events, error };
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

describe('schema creation lock and stale snapshot handling @regression @tier1', function () {
    it('does not take the migration lock when every declared table is present', async function () {
        const result = await bootWithExisting(TABLE_NAMES);
        assert.strictEqual(result.events.includes('lock'), false);
        assert.strictEqual(result.created.length, 0);
    });

    it('holds the migration lock across the second snapshot and create loop', async function () {
        const missing = 'blocks';
        const result = await bootWithExisting(TABLE_NAMES.filter(name => name !== missing));
        const lock = result.events.indexOf('lock');
        const secondSnapshot = result.events.indexOf('exists:' + TABLE_NAMES[0], TABLE_NAMES.length);
        const create = result.events.indexOf('create:' + missing);
        const release = result.events.indexOf('release-lock');
        assert.ok(lock >= 0 && lock < secondSnapshot);
        assert.ok(secondSnapshot < create && create < release);
    });

    it('releases the migration lock when table creation fails', async function () {
        const missing = 'blocks';
        const result = await bootWithExisting(TABLE_NAMES.filter(name => name !== missing), {
            failCreate: missing,
            expectError: true,
        });
        assert.match(result.error && result.error.message, /create failed/);
        assert.ok(result.events.indexOf('release-lock') > result.events.indexOf('create:' + missing));
    });

    it('reconciles a table that appears while waiting for the lock', async function () {
        const missing = 'blocks';
        const result = await bootWithExisting(TABLE_NAMES.filter(name => name !== missing), {
            appearAtLock: missing,
        });
        assert.strictEqual(result.created.includes(missing), false);
        assert.strictEqual(result.reconciled.includes(missing), true);
    });

    it('reconciles after CREATE reports that a racing peer created the table', async function () {
        const missing = 'blocks';
        const result = await bootWithExisting(TABLE_NAMES.filter(name => name !== missing), {
            tableExistsError: missing,
            appearDuringCreate: true,
        });
        assert.strictEqual(result.created.includes(missing), false);
        assert.strictEqual(result.reconciled.includes(missing), true);
    });

    it('fails loudly when CREATE and information_schema disagree', async function () {
        const missing = 'blocks';
        const result = await bootWithExisting(TABLE_NAMES.filter(name => name !== missing), {
            tableExistsError: missing,
            expectError: true,
        });
        assert.match(result.error && result.error.message, /information_schema still reports it absent/);
        assert.ok(result.events.includes('release-lock'));
    });

    it('creates nothing when the migration lock cannot be acquired', async function () {
        const result = await bootWithExisting([], { lockResult: 0, expectError: true });
        assert.match(result.error && result.error.message, /could not acquire lock/);
        assert.strictEqual(result.created.length, 0);
    });

    it('seeds under the outer lock without acquiring a second lock', async function () {
        const result = await bootWithExisting([]);
        assert.strictEqual(result.events.filter(event => event === 'lock').length, 1);
        assert.ok(result.events.indexOf('lock') < result.events.indexOf('seed:true'));
        assert.ok(result.events.indexOf('seed:true') < result.events.indexOf('release-lock'));
    });
});
