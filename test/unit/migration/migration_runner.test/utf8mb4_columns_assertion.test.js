// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');

const Database = require('../../../../src/db');
const utf8mb4Columns = require('../../../../src/chain/utf8mb4_columns');

const registeredRows = () => utf8mb4Columns.UTF8MB4_RAW_FIELD_COLUMNS.map((entry) => ({
    table_name: entry.table,
    column_name: entry.column,
    character_set_name: 'utf8mb4',
}));

function makeDb(rows) {
    const calls = [];
    const conn = {
        async query(sql, args) {
            calls.push({ sql, args });
            if(/SELECT table_name, column_name, character_set_name/i.test(sql)) return rows;
            if(/bridge_transfers/i.test(sql)) return [
                'bridge_transfers', 'bridge_settlements', 'policy_snapshots', 'xbridges'
            ].map((name) => ({ name }));
            if(/list_snapshots/i.test(sql))
                return ['list_snapshots', 'list_share_mirrors'].map((name) => ({ name }));
            return [];
        },
        async release() {},
    };
    const db = Object.create(Database.prototype);
    db.dbName = 'fake_indexer';
    db.transactionConnection = null;
    db.getConnection = async () => conn;
    return { db, calls };
}

describe('runMigrations() registered utf8mb4-column assertion @regression @tier1', function () {
    it('passes when every registered column is still utf8mb4', async function () {
        const { db, calls } = makeDb(registeredRows());

        await db.assertRegisteredUtf8mb4ColumnsStayWide();

        assert.strictEqual(calls.length, 1);
        assert.match(calls[0].sql, /information_schema\.columns/i);
        assert.strictEqual(calls[0].args[0], 'fake_indexer');
        const queriedTables = new Set(calls[0].args.slice(1));
        for(const entry of utf8mb4Columns.UTF8MB4_RAW_FIELD_COLUMNS)
            assert.ok(queriedTables.has(entry.table), 'metadata query omitted ' + entry.table);
    });

    it('halts with every present registered column that regressed to utf8mb3', async function () {
        const rows = registeredRows();
        rows.find((row) => row.table_name === 'contracts' && row.column_name === 'code')
            .character_set_name = 'utf8mb3';
        rows.find((row) => row.table_name === 'messages' && row.column_name === 'coin')
            .character_set_name = 'utf8';
        const { db } = makeDb(rows);

        await assert.rejects(
            () => db.assertRegisteredUtf8mb4ColumnsStayWide(),
            (error) => /contracts\.code \(utf8mb3\)/.test(error.message) &&
                /messages\.coin \(utf8\)/.test(error.message) &&
                /--file 2026-09-02-utf8mb4-raw-wire-fields-not-null\.sql/.test(error.message)
        );
    });

    it('ignores unregistered metadata rows and accepts absent registered columns', async function () {
        const { db } = makeDb([
            { table_name: 'contracts', column_name: 'code_hash', character_set_name: 'utf8mb3' },
            { table_name: 'CONTRACTS', column_name: 'CODE', character_set_name: 'utf8mb4' },
        ]);

        await db.assertRegisteredUtf8mb4ColumnsStayWide();
    });

    it('passes through when the metadata answer is unreadable', async function () {
        const { db } = makeDb(null);

        await db.assertRegisteredUtf8mb4ColumnsStayWide();
    });

    it('runs after a lock-skipped migration pass', async function () {
        const { db, calls } = makeDb(registeredRows());
        db.runMigrationsInner = async () => ({ applied: [], pending: [], lockSkipped: true });
        db.assertPubkeyColumnIsUncompressedWide = async () => {};
        db.assertStakeWeightOrderingCollation = async () => {};

        const result = await Database.prototype.runMigrations.call(db, {});

        assert.strictEqual(result.lockSkipped, true);
        assert.ok(calls.some((call) => /SELECT table_name, column_name, character_set_name/i.test(call.sql)));
    });
});

describe('runMigrations() registered utf8mb4-column assertion @regression @tier1', function () {
    it('keeps the generic remedy when only an auto-widen column drifts', async function () {
        const rows = registeredRows();
        rows.find((row) => row.table_name === 'messages' && row.column_name === 'coin')
            .character_set_name = 'utf8mb3';
        const { db } = makeDb(rows);

        await assert.rejects(
            () => db.assertRegisteredUtf8mb4ColumnsStayWide(),
            (error) => /Restore the registered charset/.test(error.message) &&
                !/2026-09-02-utf8mb4-raw-wire-fields-not-null/.test(error.message)
        );
    });

    it('baselines the manual migration only when every manual registry column is wide', function () {
        const file = '2026-09-02-utf8mb4-raw-wire-fields-not-null.sql';
        const pre = Database.MIGRATION_PRECONDITIONS[file];
        const rows = utf8mb4Columns.forMode('manual').map((entry) => ({
            tbl: entry.table, col: entry.column, type: entry.type.toLowerCase(),
            charset: 'utf8mb4', coll: 'utf8mb4_general_ci', nullable: 'NO',
        }));
        assert.match(pre.skipWhen(rows), /already have their declared utf8mb4 NOT NULL shape/);
        for (const drift of [{ charset: 'utf8mb3' }, { coll: 'utf8mb4_bin' }, { nullable: 'YES' },
            { type: 'varchar(100)' }, { charset: null }]) {
            assert.strictEqual(pre.skipWhen(rows.map((row, i) => i === rows.length - 1 ? { ...row, ...drift } : row)),
                null, JSON.stringify(drift));
        }
        assert.strictEqual(pre.skipWhen(rows.slice(1)), null);
        assert.strictEqual(pre.skipWhen([]), null);
        assert.match(pre.sql, /\(table_name, column_name\) IN \(/);
        assert.strictEqual((pre.sql.match(/\?/g) || []).length, 1, 'binds only the database name');
        const raw = require('fs').readFileSync(require('path').join(
            __dirname, '..', '..', '..', '..', 'src', 'sql', 'migrations', file), 'utf8');
        const hash = require('crypto').createHash('sha256').update(raw).digest('hex');
        const rebaseline = Database.MIGRATION_CHECKSUM_REBASELINES[file];
        assert.strictEqual(rebaseline.from,
            '08f543fd5439280e9ffd4d7396b05b33880b6b9b07240a43d273e7110267d4e6');
        assert.strictEqual(rebaseline.to, hash);
        const statements = Database.prototype.splitSqlStatements.call({
            stripSqlLineComments: Database.prototype.stripSqlLineComments
        }, raw);
        assert.strictEqual(statements.length, 11);
        assert.ok(statements.every((statement) => /^ALTER TABLE/i.test(statement.trim())));
    });
});
