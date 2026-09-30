'use strict';

const assert = require('assert');
const eq = require('../../integration/setup/equivalence.js');

function fakeDb(rows) {
    return async function (sql) {
        if(sql === 'SHOW TABLES') return [{ Tables_in_db: 'schema_migrations' }];
        if(sql === 'SELECT * FROM `schema_migrations`') return rows.map(row => ({ ...row }));
        throw new Error('unexpected statement: ' + sql);
    };
}

function migration(appliedAt, overrides = {}) {
    return Object.assign({
        name: '2026-09-12-bridge-tables.sql',
        checksum: 'abc123',
        mode: 'manual',
        applied_at: appliedAt,
    }, overrides);
}

describe('equivalence oracle: schema_migrations @regression @tier1', function () {
    it('accepts nodes that applied the same migration at different boot times', async function () {
        const a = fakeDb([migration(new Date('2026-09-24T10:00:00Z'))]);
        const b = fakeDb([migration(new Date('2026-09-24T10:05:00Z'))]);
        await eq.assertIndexerDbsEquivalent(a, b, { mode: 'strict' });
    });

    it('still rejects different migration identities, checksums and modes', async function () {
        const baseline = fakeDb([migration(new Date('2026-09-24T10:00:00Z'))]);
        for(const overrides of [
            { name: '2026-09-13-destroys-sends-leg-ordinal.sql' },
            { checksum: 'different' },
            { mode: 'auto' },
        ]){
            const changed = fakeDb([migration(new Date('2026-09-24T10:05:00Z'), overrides)]);
            await assert.rejects(
                eq.assertIndexerDbsEquivalent(baseline, changed, { mode: 'strict' }),
                /NOT strict-equivalent in schema_migrations/
            );
        }
    });

    it('excludes applied_at from captured states too', async function () {
        const a = await eq.captureDbState(fakeDb([migration(new Date('2026-09-24T10:00:00Z'))]));
        const b = await eq.captureDbState(fakeDb([migration(new Date('2026-09-24T10:05:00Z'))]));
        assert.deepStrictEqual(a, b);
        eq.assertCapturedStatesEqual(a, b);
    });
});
