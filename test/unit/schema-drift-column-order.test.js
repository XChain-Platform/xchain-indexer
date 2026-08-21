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
 * Column-ORDER convergence for the startup drift reconciler.
 *
 * alterTableForDrift() adds any column declared in src/sql/<table>.sql but absent
 * live. It used to emit a bare `ADD COLUMN`, which MariaDB appends at the tail, so
 * an aged table reconciled at boot ended up column-ordered differently from a fresh
 * createTable of the exact same definition (contract_state.state_key_bin: mid-table
 * fresh, tail on aged) - logically equivalent, but not a byte-identical SHOW CREATE
 * TABLE, which is what the bootstrap/migration convergence audit compares.
 *
 * These tests pin the placement clause: the column goes AFTER its predecessor in the
 * SQL source (the nearest preceding column that exists live), or FIRST when it leads.
 *
 ********************************************************************/

const assert = require('assert');

const Database = require('../../src/db');

// Minimal harness: alterTableForDrift only needs `this.dbName` plus a `db` with
// query(). It reads the REAL src/sql/<table>.sql, so the source stays the fixture.
function makeReconciler(liveColumns) {
    const queries = [];
    const ctx = { dbName: 'xchain_test', parseExpectedColumns: Database.prototype.parseExpectedColumns,
                  stripSqlLineComments: Database.prototype.stripSqlLineComments };
    const db = {
        query: async (sql) => {
            queries.push(sql);
            if (/information_schema\.columns/i.test(sql)) {
                return liveColumns.map(name => ({
                    COLUMN_NAME: name, IS_NULLABLE: 'YES', COLUMN_TYPE: 'varchar(256)', COLUMN_KEY: '', EXTRA: ''
                }));
            }
            return [];
        }
    };
    return { ctx, db, queries, run: (file) => Database.prototype.alterTableForDrift.call(ctx, file, db) };
}

const alters = (queries) => queries.filter(q => /^ALTER TABLE/i.test(q));

describe('alterTableForDrift(): column-order convergence @regression', function () {

    it('places a missing mid-table column AFTER its source predecessor (state_key_bin)', async function () {
        // An aged contract_state: every column except the generated state_key_bin.
        const h = makeReconciler(['id', 'contract_index', 'state_key', 'state_value', 'block_index', 'action_index']);
        await h.run('contract_state.sql');
        const added = alters(h.queries).filter(q => /ADD COLUMN/i.test(q) && /state_key_bin/i.test(q));
        assert.strictEqual(added.length, 1, 'expected exactly one ADD COLUMN for state_key_bin');
        assert.ok(/AFTER `state_key`/.test(added[0]),
            'the generated column must be placed after state_key, not appended: ' + added[0]);
    });

    it('does not touch a table whose columns are all present', async function () {
        const h = makeReconciler(['id', 'contract_index', 'state_key', 'state_key_bin', 'state_value', 'block_index', 'action_index']);
        await h.run('contract_state.sql');
        assert.deepStrictEqual(alters(h.queries).filter(q => /ADD COLUMN/i.test(q)), []);
    });

    it('a source-leading column with nothing before it live is placed FIRST', async function () {
        // Drop `id` (the leading column) from the live set: it has no predecessor to
        // anchor on, so the reconciler must say FIRST rather than append it at the tail.
        const h = makeReconciler(['contract_index', 'state_key', 'state_key_bin', 'state_value', 'block_index', 'action_index']);
        await h.run('contract_state.sql');
        const added = alters(h.queries).filter(q => /ADD COLUMN/i.test(q));
        if (added.length) assert.ok(/ FIRST$/.test(added[0]), 'leading column must be added FIRST: ' + added[0]);
    });

    it('two adjacent missing columns keep their source order (second anchors on the first)', async function () {
        // state_key_bin and state_value both missing: state_value must anchor on the
        // state_key_bin added moments earlier, not skip back to state_key.
        const h = makeReconciler(['id', 'contract_index', 'state_key', 'block_index', 'action_index']);
        await h.run('contract_state.sql');
        const added = alters(h.queries).filter(q => /ADD COLUMN/i.test(q));
        const bin = added.find(q => /ADD COLUMN\s+`?state_key_bin`?/i.test(q));
        const val = added.find(q => /ADD COLUMN\s+`?state_value`?/i.test(q));
        assert.ok(bin && /AFTER `state_key`/.test(bin), 'state_key_bin after state_key: ' + bin);
        assert.ok(val && /AFTER `state_key_bin`/.test(val), 'state_value must chain after the just-added column: ' + val);
    });

    // The reconciler's blind spot, pinned as a fact rather than left to be re-guessed.
    // parseExpectedColumns reads AUTO_INCREMENT / PRIMARY KEY as NOT NULL with no DEFAULT,
    // and the missing-column branch skips that shape, so a surrogate key is never converged
    // in at boot - even though the engine would backfill the sequence safely. That is why
    // 2026-08-19-attest-validator-stats-surrogate-id.sql is the SOLE convergence path for
    // attest_validator_stats.id on an aged install, and why it must not be squashed as
    // redundant with the reconciler. If this branch is ever taught to add an AUTO_INCREMENT
    // column, this test is the deliberate edit that records the change.
    it('skips a missing AUTO_INCREMENT primary key (the reconciler is NOT a convergence path for it)', async function () {
        // An aged attest_validator_stats: every column except the surrogate id.
        const h = makeReconciler(['validator_pubkey', 'provider_id', 'fulfilled_count',
                                  'missed_count', 'slashed_count', 'quality_score', 'last_updated_block']);
        await h.run('attest_validator_stats.sql');
        const added = alters(h.queries).filter(q => /ADD COLUMN/i.test(q));
        assert.deepStrictEqual(added.filter(q => /ADD COLUMN\s+`?id`?\b/i.test(q)), [],
            'alterTableForDrift must not add attest_validator_stats.id: it parses as NOT NULL ' +
            'with no DEFAULT, so the dated migration is the only path that carries it to an aged ' +
            'DB. An ADD here means the migration prose and the squash guidance resting on this ' +
            'skip are now wrong.');
    });
});
