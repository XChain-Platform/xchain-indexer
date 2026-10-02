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
 * Schema migration runner: pure-logic contract tests (no live DB).
 *
 * Covers the gate that decides whether a migration runs unattended at startup:
 * migrationMode() header parsing, and the invariant that every committed migration
 * declares its intent explicitly so a destructive file can never default-silently
 * into the auto-apply path on a validator fleet.
 *
 ********************************************************************/

const { assert, path, Database, BRIDGE_TABLES_PROBE, BRIDGE_TABLE_ROWS, bridgeTablesPresent,
        LIST_SHARE_TABLES_PROBE, LIST_SHARE_TABLE_ROWS, listShareTablesPresent } = require('./helpers/migration_fixtures.js');


// Post-run schema contract. 2026-07-24-pubkeys-widen-uncompressed.sql is
// mode=manual, so alterTableForDrift cannot heal it (that reconciler only ADDS
// columns and RELAXES nullability) and a scoped --file run can leave a fleet
// half-migrated with no operator signal. runMigrations asserts the width on every
// normal return so the half-migrated node halts instead of truncating pubkeys.
describe('runMigrations() pubkey-width assertion @regression @tier1', function () {

    function makeDb(pubkeyLen, { emptyDir = false } = {}) {
        const conn = {
            async query(sql) {
                if (/GET_LOCK/i.test(sql))                                        return [{ l: '1' }];
                if (/RELEASE_LOCK/i.test(sql))                                    return [];
                if (/SELECT name, checksum FROM schema_migrations/i.test(sql))    return [];
                if (/information_schema\.columns/i.test(sql))
                    return (pubkeyLen === null) ? [] : [{ len: pubkeyLen }];
                // Bare-ledger harness, live-schema question: see BRIDGE_TABLES_PROBE above.
                if (BRIDGE_TABLES_PROBE.test(sql)) return bridgeTablesPresent();
                if (LIST_SHARE_TABLES_PROBE.test(sql)) return listShareTablesPresent();
                return [];
            },
            async release() {},
        };
        const db = Object.create(Database.prototype);
        db.dbName = 'fake_indexer';
        db.transactionConnection = null;
        db.getConnection = async () => conn;
        db.ensureMigrationsLedger = async () => {};
        // A lock-skip returns early from the inner body; the wrapper must still assert.
        if (emptyDir) db.runMigrationsInner = async () => ({ applied: [], pending: [], lockSkipped: true });
        return db;
    }

    async function quietly(fn) {
        const realLog = console.log, realWarn = console.warn;
        console.log = console.warn = () => {};
        try { return await fn(); }
        finally { console.log = realLog; console.warn = realWarn; }
    }

    it('throws with the remedy when pubkeys.pubkey is too narrow for an uncompressed key', async function () {
        await assert.rejects(
            () => quietly(() => makeDb(66).runMigrations({ only: '2026-07-24-pubkeys-widen-uncompressed.sql' })),
            /pubkeys\.pubkey holds 66 chars but VARCHAR\(130\) is required[\s\S]*node src\/db\/migration\/migrate\.js/);
    });

    it('passes at the migrated width', async function () {
        await quietly(() => makeDb(130).runMigrations({ only: '2026-07-24-pubkeys-widen-uncompressed.sql' }));
    });

    it('asserts even when the inner run examined nothing (lock skip)', async function () {
        await assert.rejects(
            () => quietly(() => makeDb(66, { emptyDir: true }).runMigrations({})),
            /VARCHAR\(130\) is required/);
    });

    it('stays silent when the column is absent (table not created yet)', async function () {
        await quietly(() => makeDb(null, { emptyDir: true }).runMigrations({}));
    });
});

// `present` is the list of bridge tables information_schema reports, `listShare` the
// list-share tables (all present unless a case says otherwise). null answers the probe
// with a non-array (the unreadable case), which must pass through rather than halt.
// Only names the probe's IN-list asks for are returned, as the server would.
function makeDb(present, listShare = [...LIST_SHARE_TABLE_ROWS]) {
    const answer = (names, sql) => {
        if (names === null) return null;
        const asked = sql.toLowerCase();
        return names.filter((name) => asked.includes("'" + name.toLowerCase() + "'")).map((name) => ({ name }));
    };
    const conn = {
        async query(sql) {
            if (/GET_LOCK/i.test(sql))                                     return [{ l: '1' }];
            if (/RELEASE_LOCK/i.test(sql))                                 return [];
            if (/SELECT name, checksum FROM schema_migrations/i.test(sql)) return [];
            if (BRIDGE_TABLES_PROBE.test(sql))     return answer(present, sql);
            if (LIST_SHARE_TABLES_PROBE.test(sql)) return answer(listShare, sql);
            return [];
        },
        async release() {},
    };
    const db = Object.create(Database.prototype);
    db.dbName = 'fake_indexer';
    db.transactionConnection = null;
    db.getConnection = async () => conn;
    db.ensureMigrationsLedger = async () => {};
    // A lock-skip returns early from the inner body; the wrapper must still assert.
    db.runMigrationsInner = async () => ({ applied: [], pending: [], lockSkipped: true });
    return db;
}

async function quietly(fn) {
    const realLog = console.log, realWarn = console.warn;
    console.log = console.warn = () => {};
    try { return await fn(); }
    finally { console.log = realLog; console.warn = realWarn; }
}

// Post-run schema contract for the bridge tables (2026-09-12-bridge-tables.sql,
// mode=manual deploy-precondition=required). This is the case the harnesses above seed
// their way past, so it is the one that has to hold: without it a node boots, looks
// healthy, and silently never applies a mirrored transfer whose source leg has already
// debited on the other chain, because the mirror ingest for a table this database cannot
// write fails by OMISSION rather than by error.
const BRIDGE_MIGRATION = path.join(__dirname, '..', '..', '..', '..', 'src', 'sql', 'migrations', '2026-09-12-bridge-tables.sql');

// Every table the registered migration creates, read from the file itself.
function migrationTables() {
    const sql = require('fs').readFileSync(BRIDGE_MIGRATION, 'utf8');
    return [...sql.matchAll(/^\s*CREATE TABLE IF NOT EXISTS\s+`?(\w+)`?/gim)].map((m) => m[1].toLowerCase());
}

describe('runMigrations() bridge-tables assertion @regression @tier1', function () {
    it('halts naming the migration file when every bridge table is absent', async function () {
        await assert.rejects(
            () => quietly(() => makeDb([]).runMigrations({})),
            /bridge_transfers, bridge_settlements, policy_snapshots, xbridges are absent[\s\S]*node src\/db\/migration\/migrate\.js --file 2026-09-12-bridge-tables\.sql/);
    });

    // A partially migrated database is the shape a scoped --file rollout actually leaves,
    // and it is the one an operator most needs named precisely: the halt lists only what is
    // missing, so the remedy is not "re-run everything and hope".
    it('halts naming ONLY the missing table when the schema is half migrated', async function () {
        await assert.rejects(
            () => quietly(() => makeDb(['bridge_transfers', 'policy_snapshots', 'xbridges']).runMigrations({})),
            /the bridge tables bridge_settlements are absent/);
        await assert.rejects(
            () => quietly(() => makeDb(['bridge_transfers', 'xbridges']).runMigrations({})),
            /the bridge tables bridge_settlements, policy_snapshots are absent/);
        // Every table the migration creates halts on its own absence, so a table added to
        // the migration without widening the guard fails here.
        const tables = migrationTables();
        assert.deepStrictEqual([...tables].sort(), [...BRIDGE_TABLE_ROWS].sort());
        for (const missing of tables) {
            await assert.rejects(
                () => quietly(() => makeDb(tables.filter((t) => t !== missing)).runMigrations({})),
                new RegExp('the bridge tables ' + missing + ' are absent'));
        }
    });

    it('passes on a fully migrated schema', async function () {
        await quietly(() => makeDb([...BRIDGE_TABLE_ROWS]).runMigrations({}));
    });

    // information_schema reports table names in whatever case the server stores them
    // (lower_case_table_names differs by platform), and a case-folded comparison is what
    // keeps a correctly migrated node off the halt path.
    it('accepts the names case-folded', async function () {
        await quietly(() => makeDb(['BRIDGE_TRANSFERS', 'Bridge_Settlements', 'POLICY_snapshots', 'XBridges']).runMigrations({}));
    });
});

describe('runMigrations() bridge-tables assertion @regression @tier1', function () {
    // An answer we could not read is not evidence of a missing table, the same convention
    // the pubkey and reward assertions follow.
    it('passes through on an unreadable answer', async function () {
        await quietly(() => makeDb(null).runMigrations({}));
    });
});

// Post-run schema contract for the shared-list tables (2026-09-30-list-share-tables.sql,
// mode=manual deploy-precondition=required), the same shape as the bridge guard above.
describe('runMigrations() list-share-tables assertion @regression @tier1', function () {
    const ALL_BRIDGE = [...BRIDGE_TABLE_ROWS];

    it('halts naming the migration file when both list-share tables are absent', async function () {
        await assert.rejects(
            () => quietly(() => makeDb(ALL_BRIDGE, []).runMigrations({})),
            /list_snapshots, list_share_mirrors are absent[\s\S]*node src\/db\/migration\/migrate\.js --file 2026-09-30-list-share-tables\.sql/);
    });

    it('halts naming ONLY the missing table when one is absent', async function () {
        await assert.rejects(
            () => quietly(() => makeDb(ALL_BRIDGE, ['list_snapshots']).runMigrations({})),
            /the shared-list tables list_share_mirrors are absent/);
        await assert.rejects(
            () => quietly(() => makeDb(ALL_BRIDGE, ['list_share_mirrors']).runMigrations({})),
            /the shared-list tables list_snapshots are absent/);
    });

    it('passes when both are present, case-folded, or unreadable', async function () {
        await quietly(() => makeDb(ALL_BRIDGE).runMigrations({}));
        await quietly(() => makeDb(ALL_BRIDGE, ['LIST_SNAPSHOTS', 'List_Share_Mirrors']).runMigrations({}));
        await quietly(() => makeDb(ALL_BRIDGE, null).runMigrations({}));
    });
});

// A registered startup assertion that runMigrations never calls is a deploy precondition
// that xchain-node enforces and this build does not; spy on the prototype, since several
// are invoked as Database.prototype.X.call(this).
describe('runMigrations() calls every registered startup assertion @regression @tier1', function () {
    it('invokes each Database.STARTUP_ASSERTED_MIGRATIONS assertion exactly once', async function () {
        const names = Database.STARTUP_ASSERTED_MIGRATIONS.map((m) => m.assertion)
            .concat(['assertPubkeyColumnIsUncompressedWide', 'assertStakeWeightOrderingCollation']);
        const calls = {};
        const saved = {};
        for (const n of names) {
            saved[n] = Database.prototype[n];
            calls[n] = 0;
            Database.prototype[n] = async function () { calls[n]++; };
        }
        try {
            const db = Object.create(Database.prototype);
            db.runMigrationsInner = async () => ({ applied: [], pending: [], lockSkipped: true });
            await db.runMigrations({});
        } finally {
            for (const n of names) Database.prototype[n] = saved[n];
        }
        const uncalled = names.filter((n) => calls[n] !== 1);
        assert.deepStrictEqual(uncalled, [], 'runMigrations() did not call exactly once: ' + uncalled.join(', '));
    });
});
