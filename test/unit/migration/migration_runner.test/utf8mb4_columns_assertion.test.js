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
                /messages\.coin \(utf8\)/.test(error.message)
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
