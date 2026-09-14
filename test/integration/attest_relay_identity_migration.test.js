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
 * test/integration/attest_relay_identity_migration.test.js
 *
 * Property 7 of the relay-identity suite: the dated migration's DDL executes, is
 * idempotent, and produces an index byte-identical in shape to the one
 * src/sql/attests.sql declares. Why the suite needs a real engine, and the other
 * six properties, are written down in attest_relay_identity.test.js; this file
 * keeps that suite's title, so every full test title reads as it did when the
 * two were one file. The schema, hooks and row writer are
 * test/helpers/relay_identity_db.js, on a database of its own.
 *
 * Self-skips when TEST_DB_PASS is unset, matching the other DB-backed files here.
 * Run it with bin/run-db-tiers.sh.
 */

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const {
    ORIGIN, OTHER, SQL_DIR, stripSqlLineComments, relayDbName, useRelayIdentityDb,
} = require('../helpers/relay_identity_db');

const DB_NAME   = relayDbName('mig');
const MIGRATION = path.join(SQL_DIR, 'migrations', '2026-08-11-attests-relay-identity-index.sql');
const NAME      = 'origin_relay_identity';

/** The index as the engine built it: uniqueness and column order, or null when absent. */
async function indexShape(conn) {
    const rows = await conn(c => c.query(
        'SHOW INDEX FROM attests WHERE Key_name = ?', [NAME]));
    if (!rows.length) return null;
    return {
        unique:  Number(rows[0].Non_unique) === 0,
        columns: rows.sort((a, b) => Number(a.Seq_in_index) - Number(b.Seq_in_index))
                     .map(r => r.Column_name)
    };
}

async function applyMigration(conn) {
    const sql = stripSqlLineComments(fs.readFileSync(MIGRATION, 'utf8'));
    for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean))
        await conn(c => c.query(stmt));
}

// ── 7. the dated migration ───────────────────────────────────────────────
//
// Two blocks with the same two titles, each with its own copy of the hooks: the
// shape and idempotence cases, in that order because the second reads the index
// the first rebuilt, then the populated-table case.

describe('relay-identity lookup against a real MariaDB @tier3', function () {
    this.timeout(60000);
    const fx = useRelayIdentityDb(DB_NAME);
    const { conn } = fx;

    describe('the origin_relay_identity migration', function () {
        it('creates the index the definition declares, with the same shape', async function () {
            // The ledger path and the definition path must converge. The unit-tier
            // sql-schema-index-parity guard compares the two files LEXICALLY; this asks
            // the engine what it actually built.
            await conn(c => c.query('DROP INDEX ' + NAME + ' ON attests'));
            assert.strictEqual(await indexShape(conn), null, 'precondition: the index is gone');

            await applyMigration(conn);

            assert.deepStrictEqual(await indexShape(conn),
                { unique: false, columns: ['origin_chain', 'origin_action_index'] },
                'NON-UNIQUE, in this column order: uniqueness is enforced in code as a ' +
                'stored verdict, because a constraint violation would throw mid-block');
        });

        it('is idempotent, so a converged DB replays it as a no-op', async function () {
            // Every node auto-applies `mode=auto` migrations at startup and the
            // schema_migrations ledger keeps them from re-running; IF NOT EXISTS is the
            // second belt, for a DB that already carries the index from a fresh install
            // off src/sql/attests.sql.
            const before = await indexShape(conn);
            assert.ok(before, 'precondition: the index is present');

            await applyMigration(conn);
            await applyMigration(conn);

            assert.deepStrictEqual(await indexShape(conn), before);
        });
    });
});

describe('relay-identity lookup against a real MariaDB @tier3', function () {
    this.timeout(60000);
    const fx = useRelayIdentityDb(DB_NAME);
    const { conn, row } = fx;

    describe('the origin_relay_identity migration', function () {
        it('applies to a POPULATED table without touching a row', async function () {
            // The safe-on-populated-table claim, asked of the engine rather than asserted
            // in a comment. Additive index-only DDL: no column, no row, no validation
            // outcome changes, only the access path.
            await row({ actionIndex: 40, originActionIndex: 401 });
            await row({ actionIndex: 41, originActionIndex: 402, status: 'rejected' });
            await row({ actionIndex: 42, originActionIndex: 403, originChain: OTHER });
            const snapshot = await conn(c => c.query(
                'SELECT action_index, origin_chain, origin_action_index, request_status ' +
                'FROM attests ORDER BY action_index'));

            await conn(c => c.query('DROP INDEX ' + NAME + ' ON attests'));
            await applyMigration(conn);

            const after = await conn(c => c.query(
                'SELECT action_index, origin_chain, origin_action_index, request_status ' +
                'FROM attests ORDER BY action_index'));
            assert.strictEqual(after.length, snapshot.length);
            for (let i = 0; i < after.length; i++)
                assert.deepStrictEqual(JSON.parse(JSON.stringify(after[i])),
                                       JSON.parse(JSON.stringify(snapshot[i])));

            // ...and the lookup it exists to serve still answers the same way over the
            // populated table, which is the only thing the index is for.
            assert.strictEqual(Number((await fx.db.getRelayRequestByOrigin(ORIGIN, 401)).action_index), 40);
            assert.strictEqual(await fx.db.getRelayRequestByOrigin(ORIGIN, 402), null);
            assert.strictEqual(Number((await fx.db.getRelayRequestByOrigin(OTHER, 403)).action_index), 42);
        });
    });
});
