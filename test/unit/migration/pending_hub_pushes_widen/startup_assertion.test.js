'use strict';

const assert = require('assert');
const Database = require('../../../../src/db');

function assertionDb(rows){
    const seen = { sql: null, params: null, releases: 0 };
    const db = {
        dbName: 'test_indexer',
        transactionConnection: null,
        getConnection: async () => ({
            query: async (sql, params) => {
                seen.sql = sql;
                seen.params = params;
                return rows;
            },
            release: async () => { seen.releases++; }
        })
    };
    return { db, seen };
}

describe('pending_hub_pushes payload startup assertion', function () {
    it('halts on every narrow or non-utf8mb4 shape and names the migration', async function () {
        for(const row of [
            { data_type: 'text', charset_name: 'utf8mb3' },
            { data_type: 'mediumtext', charset_name: 'utf8mb3' },
            { data_type: 'text', charset_name: 'utf8mb4' }
        ]){
            const { db, seen } = assertionDb([row]);
            await assert.rejects(
                () => Database.prototype.assertPendingHubPushPayloadIsWide.call(db),
                /ATTEST batch outbox insert[\s\S]*--file 2026-11-19-pending-hub-pushes-widen-payload\.sql/
            );
            assert.strictEqual(seen.releases, 1);
        }
    });

    it('passes wide utf8mb4 shapes and absent or unreadable answers', async function () {
        for(const rows of [
            [{ data_type: 'mediumtext', charset_name: 'utf8mb4' }],
            [{ DATA_TYPE: 'LONGTEXT', CHARSET_NAME: 'UTF8MB4' }],
            [], null, [{}]
        ]){
            const { db, seen } = assertionDb(rows);
            await Database.prototype.assertPendingHubPushPayloadIsWide.call(db);
            assert.strictEqual(seen.releases, 1);
        }
    });

    it('queries the exact column and binds only the database name', async function () {
        const { db, seen } = assertionDb([{ data_type: 'mediumtext', charset_name: 'utf8mb4' }]);
        await Database.prototype.assertPendingHubPushPayloadIsWide.call(db);
        assert.match(seen.sql, /table_name = 'pending_hub_pushes'/);
        assert.match(seen.sql, /column_name = 'payload'/);
        assert.deepStrictEqual(seen.params, ['test_indexer']);
    });
});
