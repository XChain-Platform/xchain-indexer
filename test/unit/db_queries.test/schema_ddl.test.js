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
 * test/unit/db_queries.test/schema_ddl.test.js
 *
 * Schema drift repair DDL (reconcileTableIndexes, alterTableForDrift), the
 * migration mode flag, the raw pool query path and the API read view.
 *
 * Part of the Database query suite (see ../db_queries.test.js): real method
 * logic against a stubbed doQuery, no live MariaDB required.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { makeDb } = require('./helpers/db_stub');

afterEach(function () {
    sinon.restore();
});

// The ADD path must not build its column list from bare column names, or an index the
// source declares with a (len) prefix or a DESC column is rebuilt as a different index.
// index_tickers.tick is TEXT, so the full-column rebuild fails with errno 1170 and the
// non-fatal catch swallows it, leaving the table without its declared UNIQUE.
describe('Database.reconcileTableIndexes() prefix/direction-preserving DDL @regression @tier1', function () {
    let db;
    beforeEach(function () { db = makeDb(); });

    // Live statistics rows for a table that has NONE of its declared indexes, which is
    // the only state that reaches the ADD branch.
    const noIndexes = () => sinon.stub().resolves([]);

    it('recreates a missing prefixed UNIQUE index with its declared width', async function () {
        const dbc = { query: noIndexes() };
        await db.reconcileTableIndexes('index_tickers.sql', dbc);
        const alters = dbc.query.getCalls().map(c => c.args[0]).filter(s => /^ALTER TABLE/i.test(s));
        const tick   = alters.find(s => /ADD UNIQUE INDEX `tick`/.test(s));
        assert.ok(tick, 'the declared UNIQUE tick index must be added: ' + alters.join(' | '));
        assert.match(tick, /\(`tick`\(200\)\)/,
            'a TEXT column must be indexed at its declared prefix width, not full-column: ' + tick);
    });

    it('leaves an unprefixed column bare in the same table', async function () {
        const dbc = { query: noIndexes() };
        await db.reconcileTableIndexes('index_tickers.sql', dbc);
        const alters = dbc.query.getCalls().map(c => c.args[0]).filter(s => /^ALTER TABLE/i.test(s));
        const block  = alters.find(s => /ADD INDEX `block_index`/.test(s));
        assert.ok(block, 'the secondary index must still be added');
        assert.match(block, /\(`block_index`\)/, 'no width may be invented for a full-column index: ' + block);
    });

    it('recreates a missing DESC index with its declared sort direction', async function () {
        const dbc = { query: noIndexes() };
        await db.reconcileTableIndexes('escrow_leaf_journal.sql', dbc);
        const alters = dbc.query.getCalls().map(c => c.args[0]).filter(s => /^ALTER TABLE/i.test(s));
        const latest = alters.find(s => /ADD INDEX `idx_latest`/.test(s));
        assert.ok(latest, 'idx_latest must be added: ' + alters.join(' | '));
        assert.match(latest, /\(`address_id`, `tick_id`, `id` DESC\)/,
            'the declared DESC must survive into the rebuilt index: ' + latest);
    });

    it('parses direction alongside the column name rather than instead of it', function () {
        const sql  = 'CREATE INDEX idx_latest ON t (a, b DESC);';
        const idxs = db.parseExpectedIndexes(sql, 't');
        assert.deepStrictEqual(idxs[0].columns, ['a', 'b']);
        assert.deepStrictEqual(idxs[0].directions, ['ASC', 'DESC']);
    });

    // files.name shipped UNINDEXED; the by-name query mode added a standalone
    // `CREATE INDEX name ON files (name);` so reconcileTableIndexes self-heals it
    // on an existing install (verifyTables calls it at boot), not just on a fresh
    // install of files.sql.
    it('recreates a missing files.name index on an existing install', async function () {
        const dbc = { query: noIndexes() };
        await db.reconcileTableIndexes('files.sql', dbc);
        const alters = dbc.query.getCalls().map(c => c.args[0]).filter(s => /^ALTER TABLE/i.test(s));
        const name   = alters.find(s => /ADD INDEX `name`/.test(s));
        assert.ok(name, 'the declared files.name index must be added: ' + alters.join(' | '));
        assert.match(name, /\(`name`\)/, 'no width may be invented for a full-column index: ' + name);
    });
});

// Relaxing NOT NULL -> NULL with a bare MODIFY restates the whole column, so every
// attribute the statement omits (DEFAULT, COMMENT, ON UPDATE, generation expression) is
// dropped and an aged DB silently stops matching a fresh install of the same source.
describe('Database.alterTableForDrift() lossless nullability relax @regression @tier1', function () {
    let db;
    beforeEach(function () { db = makeDb(); });

    // fees.gas_price is declared `VARCHAR(250) DEFAULT '0'` (nullable) in src/sql/fees.sql,
    // so an aged DB holding it NOT NULL is exactly the drift this branch acts on.
    function liveFees(overrides) {
        return sinon.stub().callsFake(async (sql) => {
            if (!/information_schema\.columns/i.test(sql)) return [];
            return [Object.assign({
                COLUMN_NAME: 'gas_price', IS_NULLABLE: 'NO', COLUMN_TYPE: 'varchar(250)',
                COLUMN_KEY: '', EXTRA: '', COLUMN_DEFAULT: null, COLLATION_NAME: null,
                COLUMN_COMMENT: '', GENERATION_EXPRESSION: ''
            }, overrides)];
        });
    }

    const modifies = (stub) => stub.getCalls().map(c => c.args[0]).filter(s => /MODIFY/i.test(s));

    it('skips the relax when the live column carries a DEFAULT a bare MODIFY would drop', async function () {
        const warn = sinon.stub(console, 'warn');
        try {
            const dbc = { query: liveFees({ COLUMN_DEFAULT: '0' }) };
            await db.alterTableForDrift('fees.sql', dbc);
            assert.deepStrictEqual(modifies(dbc.query), [], 'no attribute-dropping MODIFY may be issued');
            const warned = warn.getCalls().map(c => c.args.join(' ')).join('\n');
            assert.match(warned, /SKIPPING relax .*DEFAULT/, 'the skip must be auditable: ' + warned);
        } finally { warn.restore(); }
    });

    it('skips the relax for a generated column', async function () {
        const warn = sinon.stub(console, 'warn');
        try {
            const dbc = { query: liveFees({ GENERATION_EXPRESSION: '`gas_cost` * 2' }) };
            await db.alterTableForDrift('fees.sql', dbc);
            assert.deepStrictEqual(modifies(dbc.query), [], 'a MODIFY would strip the generation expression');
        } finally { warn.restore(); }
    });

    it('skips the relax for an ON UPDATE column', async function () {
        const warn = sinon.stub(console, 'warn');
        try {
            const dbc = { query: liveFees({ EXTRA: 'on update current_timestamp()' }) };
            await db.alterTableForDrift('fees.sql', dbc);
            assert.deepStrictEqual(modifies(dbc.query), [], 'a MODIFY would strip ON UPDATE');
        } finally { warn.restore(); }
    });

    it('still relaxes an attribute-free column, restating its collation', async function () {
        const dbc = { query: liveFees({ COLLATION_NAME: 'utf8_bin' }) };
        await db.alterTableForDrift('fees.sql', dbc);
        const issued = modifies(dbc.query);
        assert.strictEqual(issued.length, 1, 'the safe relax must still happen: ' + issued.join(' | '));
        assert.match(issued[0], /MODIFY `gas_price` varchar\(250\) COLLATE utf8_bin NULL/,
            'an explicit collation must be restated, not re-defaulted: ' + issued[0]);
    });
});

// ---------------------------------------------------------------------------
// migrationMode
// ---------------------------------------------------------------------------
describe('Database._migrationMode() @regression @tier1', function () {
    let db;
    beforeEach(function () { db = makeDb(); });

    it('returns "manual" when no tag present (conservative default)', function () {
        assert.strictEqual(db.migrationMode('SELECT 1;'), 'manual');
    });

    it('returns "auto" for -- xchain:migration mode=auto tag', function () {
        const raw = '-- xchain:migration mode=auto\nALTER TABLE t ADD COLUMN x INT;';
        assert.strictEqual(db.migrationMode(raw), 'auto');
    });

    it('returns "manual" for -- xchain:migration mode=manual tag', function () {
        const raw = '-- xchain:migration mode=manual\nALTER TABLE t DROP COLUMN x;';
        assert.strictEqual(db.migrationMode(raw), 'manual');
    });

    it('is case-insensitive', function () {
        const raw = '-- XCHAIN:MIGRATION MODE=AUTO\nSELECT 1;';
        assert.strictEqual(db.migrationMode(raw), 'auto');
    });
});

// ---------------------------------------------------------------------------
// poolQuery
// ---------------------------------------------------------------------------
describe('Database._poolQuery() @regression @tier1', function () {
    it('acquires a fresh connection, runs query, releases connection', async function () {
        const db  = makeDb();
        const row = [{ id: 1 }];
        const conn = {
            query:   sinon.stub().resolves(row),
            release: sinon.stub().resolves()
        };
        db.pool.getConnection.resolves(conn);
        const result = await db.poolQuery('SELECT 1', []);
        assert.deepStrictEqual(result, row);
        assert.ok(conn.release.calledOnce);
    });

    it('releases connection even on query error', async function () {
        const db   = makeDb();
        const conn = {
            query:   sinon.stub().rejects(new Error('pool error')),
            release: sinon.stub().resolves()
        };
        db.pool.getConnection.resolves(conn);
        await assert.rejects(() => db.poolQuery('SELECT 1'), /pool error/);
        assert.ok(conn.release.calledOnce);
    });
});

// apiView: federation-API writes must never join an open block transaction.
// Without the view, a pushvalidatorrewards landing mid-block routes through doQuery ->
// getConnection() -> the block's transactionConnection, so a reorg/throw
// rolls back rewards the API has already acked (the hub never retries).
describe('Database.apiView() @regression @tier1', function () {
    it('routes doQuery to a pooled connection even while a block transaction is open', async function () {
        const db     = makeDb();
        const txConn = { query: sinon.stub().resolves([]), release: sinon.stub().resolves() };
        const poolConn = { query: sinon.stub().resolves([{ id: 7 }]), release: sinon.stub().resolves() };
        db.transactionConnection = txConn;           // simulate mid-block state
        db.pool.getConnection.resolves(poolConn);

        const rows = await db.apiView().doQuery('SELECT 1', []);
        assert.deepStrictEqual(rows, [{ id: 7 }]);
        assert.ok(poolConn.query.calledOnce, 'query must run on the pooled connection');
        assert.ok(poolConn.release.calledOnce, 'pooled connection must be released');
        assert.ok(txConn.query.notCalled, 'the open block transaction must never see API queries');
    });

    it('createValidatorReward via apiView never touches the transaction connection', async function () {
        const db     = makeDb();
        const txConn = { query: sinon.stub().resolves([]), release: sinon.stub().resolves() };
        db.transactionConnection = txConn;
        // Pooled connection answers the whole helper chain: pubkey id, status id,
        // stake-source resolution, then accepts the INSERT.
        const poolConn = {
            query: sinon.stub().callsFake(async (sql) => {
                if (/FROM index_pubkeys/i.test(sql))   return [{ id: 11 }];
                if (/FROM index_statuses/i.test(sql))  return [{ id: 1 }];
                if (/FROM stakes/i.test(sql))          return [{ source_id: 5 }];
                return [];
            }),
            release: sinon.stub().resolves()
        };
        db.pool.getConnection.resolves(poolConn);

        const ok = await db.apiView().createValidatorReward('aa'.repeat(32), 3, 'anchor_BTC', '1', 100);
        assert.strictEqual(ok, true);
        const insert = poolConn.query.getCalls().find(c => /INSERT.*validator_rewards/is.test(c.args[0]));
        assert.ok(insert, 'reward INSERT must run on the pooled connection');
        assert.ok(txConn.query.notCalled, 'no statement may join the open block transaction');
    });

    it('base doQuery still uses the open transaction connection (control)', async function () {
        const db     = makeDb();
        const txConn = { query: sinon.stub().resolves([{ id: 1 }]), release: sinon.stub().resolves() };
        db.transactionConnection = txConn;
        await db.doQuery('SELECT 1', []);
        assert.ok(txConn.query.calledOnce, 'block-loop queries must keep joining the transaction');
    });
});

describe('Database.apiView() @regression @tier1', function () {
    // Federation read isolation: READ methods (not just the pushvalidatorrewards
    // write) must resolve on a pooled connection. A read accessor invoked through the
    // view routes its internal doQuery calls off the open block transaction, so a hub
    // never reads validator-set rows the block may still roll back.
    it('a read accessor (getActiveValidators) via apiView never touches the transaction connection', async function () {
        const db     = makeDb();
        const txConn = { query: sinon.stub().resolves([]), release: sinon.stub().resolves() };
        db.transactionConnection = txConn;                // simulate mid-block state
        const poolConn = {
            query: sinon.stub().callsFake(async (sql) => {
                if (/FROM index_statuses/i.test(sql)) return [{ id: 1 }];   // getStatusId('valid')
                return [{ pubkey: 'ab'.repeat(32), total: '100' }];         // the validator query
            }),
            release: sinon.stub().resolves()
        };
        db.pool.getConnection.resolves(poolConn);

        const validators = await db.apiView().getActiveValidators(850000);
        assert.strictEqual(validators.length, 1);
        assert.strictEqual(validators[0].pubkey, 'ab'.repeat(32));
        assert.ok(poolConn.query.called, 'read must run on the pooled connection');
        assert.ok(txConn.query.notCalled, 'a federation read must never join the open block transaction');
    });

    it('returns the same cached view on repeated calls', function () {
        const db = makeDb();
        assert.strictEqual(db.apiView(), db.apiView());
    });
});
