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

const { assert, path, Database, BRIDGE_TABLES_PROBE, BRIDGE_TABLE_ROWS, bridgeTablesPresent } = require('./helpers/migration_fixtures.js');


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
            /pubkeys\.pubkey holds 66 chars but VARCHAR\(130\) is required[\s\S]*node src\/migration\/migrate\.js/);
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

// `present` is the list of bridge tables information_schema reports. null answers the
// probe with a non-array (the unreadable case), which must pass through rather than halt.
function makeDb(present) {
    const conn = {
        async query(sql) {
            if (/GET_LOCK/i.test(sql))                                     return [{ l: '1' }];
            if (/RELEASE_LOCK/i.test(sql))                                 return [];
            if (/SELECT name, checksum FROM schema_migrations/i.test(sql)) return [];
            if (BRIDGE_TABLES_PROBE.test(sql))
                return (present === null) ? null : present.map((name) => ({ name }));
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

// Post-run schema contract for the three bridge tables (2026-09-12-bridge-tables.sql,
// mode=manual deploy-precondition=required). This is the case the harnesses above seed
// their way past, so it is the one that has to hold: without it a node boots, looks
// healthy, and silently never applies a mirrored transfer whose source leg has already
// debited on the other chain, because the mirror ingest for a table this database cannot
// write fails by OMISSION rather than by error.
describe('runMigrations() bridge-tables assertion @regression @tier1', function () {
    it('halts naming the migration file when every bridge table is absent', async function () {
        await assert.rejects(
            () => quietly(() => makeDb([]).runMigrations({})),
            /bridge_transfers, bridge_settlements, policy_snapshots are absent[\s\S]*node src\/migration\/migrate\.js --file 2026-09-12-bridge-tables\.sql/);
    });

    // A partially migrated database is the shape a scoped --file rollout actually leaves,
    // and it is the one an operator most needs named precisely: the halt lists only what is
    // missing, so the remedy is not "re-run everything and hope".
    it('halts naming ONLY the missing table when the schema is half migrated', async function () {
        await assert.rejects(
            () => quietly(() => makeDb(['bridge_transfers', 'policy_snapshots']).runMigrations({})),
            /the bridge tables bridge_settlements are absent/);
        await assert.rejects(
            () => quietly(() => makeDb(['bridge_transfers']).runMigrations({})),
            /the bridge tables bridge_settlements, policy_snapshots are absent/);
    });

    it('passes on a fully migrated schema', async function () {
        await quietly(() => makeDb([...BRIDGE_TABLE_ROWS]).runMigrations({}));
    });

    // information_schema reports table names in whatever case the server stores them
    // (lower_case_table_names differs by platform), and a case-folded comparison is what
    // keeps a correctly migrated node off the halt path.
    it('accepts the names case-folded', async function () {
        await quietly(() => makeDb(['BRIDGE_TRANSFERS', 'Bridge_Settlements', 'POLICY_snapshots']).runMigrations({}));
    });
});

describe('runMigrations() bridge-tables assertion @regression @tier1', function () {
    // An answer we could not read is not evidence of a missing table, the same convention
    // the pubkey and reward assertions follow.
    it('passes through on an unreadable answer', async function () {
        await quietly(() => makeDb(null).runMigrations({}));
    });
});
