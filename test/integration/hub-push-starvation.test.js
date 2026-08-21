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
 * HubPushQueue starvation regression (review finding 01178748).
 *
 * getPendingHubPushes used to fetch the oldest `limit` pending rows with no
 * due-time predicate, applying exponential backoff ONLY afterward in JS
 * (HubPushQueue._isDue). During a hub outage that parks more than `limit`
 * rows in backoff, every drain tick re-fetched the same oldest not-due rows
 * and a newer DUE row (id beyond the oldest batch) was never even fetched -
 * head-of-line blocking. The fix pushes the backoff due-time predicate into
 * the SQL itself (MariaDB dialect: DATE_SUB/POW/LEAST), so this must run
 * against a real MariaDB instance to prove the dialect is correct; a stubbed
 * connection (see test/unit/db.queries.test.js) can only assert the SQL text
 * shape, not that MariaDB actually evaluates it as intended.
 */

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

const Database = require('../../src/db.js');
const {
    getConnectionParams,
    useFileDatabases,
    resetIndexerDb,
    closeAll
} = require('./setup/db-connection');

// Minimal indexer stub: Database's constructor only reads indexer.config and
// indexer.util; neither is exercised by the table-create/insert/select path
// this test drives.
function makeMinimalIndexer() {
    return {
        config: {},
        util: {
            throwError: (msg) => { throw new Error(msg); },
            sleep: async () => {}
        }
    };
}

async function createPendingHubPushesTable(db) {
    const sqlPath = path.join(__dirname, '..', '..', 'src', 'sql', 'pending_hub_pushes.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8').replace(/--[^\n]*/g, '');
    const conn = await db.getConnection();
    try {
        for (let stmt of sql.split(';')) {
            stmt = stmt.trim();
            if (stmt) await conn.query(stmt);
        }
    } finally {
        await conn.release();
    }
}

describe('HubPushQueue starvation fix (MariaDB integration) @regression @tier1', function () {
    this.timeout(60000);

    let db;

    before(async function () {
        await useFileDatabases(__filename);
        await resetIndexerDb();
        const p = getConnectionParams();
        db = new Database(p.indexerHost, p.indexerPort, p.indexerName, p.indexerUser, p.indexerPass, makeMinimalIndexer());
        await createPendingHubPushesTable(db);
    });

    after(async function () {
        if (db && db.pool) await db.pool.end();
        await closeAll();
    });

    beforeEach(async function () {
        await db._poolQuery('DELETE FROM pending_hub_pushes', []);
    });

    it('fetches a newer due row even with 50+ older rows parked in backoff (head-of-line blocking)', async function () {
        // 55 "parked" rows: high attempt count and a recent last_attempted_at, so
        // under the base=30s/max=600s backoff schedule none of them are due yet.
        // These occupy ids 1..55, all older than the due row below.
        const PARKED = 55;
        for (let i = 0; i < PARKED; i++) {
            await db._poolQuery(
                `INSERT INTO pending_hub_pushes (push_type, action_index, payload, attempts, last_attempted_at, status)
                 VALUES (?, ?, ?, ?, NOW(), 'pending')`,
                ['price_round', i, JSON.stringify({ round: i }), 9]   // attempts=9 -> backoff capped at max (600s)
            );
        }

        // One newer row that has never been attempted (NULL last_attempted_at),
        // therefore immediately due, but its id falls well beyond the oldest 50.
        const dueInsert = await db._poolQuery(
            `INSERT INTO pending_hub_pushes (push_type, action_index, payload, attempts, last_attempted_at, status)
             VALUES (?, ?, ?, 0, NULL, 'pending')`,
            ['price_round', 99999, JSON.stringify({ round: 99999 })]
        );
        const dueId = dueInsert.insertId != null ? Number(dueInsert.insertId) : null;
        assert.ok(dueId, 'due row must have been inserted');

        const rows = await db.getPendingHubPushes(50, { baseBackoffMs: 30000, maxBackoffMs: 600000 });

        assert.ok(rows.length <= 50, 'must still respect the batch LIMIT');
        const gotDueRow = rows.some(r => Number(r.id) === dueId);
        assert.ok(gotDueRow,
            'the newer due row (id ' + dueId + ') must be fetched even though ' + PARKED +
            ' older not-due rows exist; got ids: ' + rows.map(r => r.id).join(','));

        // Every row returned must genuinely be due (belt-and-braces: the SQL predicate
        // itself, not just the JS re-check, must exclude the still-parked rows).
        for (const r of rows) {
            assert.strictEqual(Number(r.attempts) === 9 && r.last_attempted_at != null, false,
                'a freshly-attempted, high-attempt (still-in-backoff) row must not be returned: id ' + r.id);
        }
    });

    it('still returns parked rows once their backoff window has actually elapsed', async function () {
        // A row attempted long enough ago (11 minutes, past the 600s/10min max
        // backoff cap) must be treated as due regardless of its attempt count.
        await db._poolQuery(
            `INSERT INTO pending_hub_pushes (push_type, action_index, payload, attempts, last_attempted_at, status)
             VALUES (?, ?, ?, ?, DATE_SUB(NOW(), INTERVAL 11 MINUTE), 'pending')`,
            ['price_round', 1, JSON.stringify({ round: 1 }), 20]
        );

        const rows = await db.getPendingHubPushes(50, { baseBackoffMs: 30000, maxBackoffMs: 600000 });
        assert.strictEqual(rows.length, 1, 'the elapsed-backoff row must be fetched once its window has passed');
    });

    it('excludes a row whose backoff window has not yet elapsed', async function () {
        await db._poolQuery(
            `INSERT INTO pending_hub_pushes (push_type, action_index, payload, attempts, last_attempted_at, status)
             VALUES (?, ?, ?, ?, NOW(), 'pending')`,
            ['price_round', 1, JSON.stringify({ round: 1 }), 1]   // attempts=1 -> 30s backoff, just attempted
        );

        const rows = await db.getPendingHubPushes(50, { baseBackoffMs: 30000, maxBackoffMs: 600000 });
        assert.strictEqual(rows.length, 0, 'a row still inside its backoff window must not be fetched');
    });
});
