'use strict';

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
 *********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const Database = require('../../../src/db');

const FILE = '2026-07-24-pubkeys-widen-uncompressed.sql';
const QUALIFIER_FILE = '2026-08-24-validator-rewards-round-qualifier.sql';
const BRIDGE_TABLES_PROBE = /information_schema\.tables[\s\S]*bridge_transfers/i;
const BRIDGE_TABLE_ROWS   = Object.freeze(['bridge_transfers', 'bridge_settlements', 'policy_snapshots']);
const bridgeTablesPresent = () => BRIDGE_TABLE_ROWS.map((name) => ({ name }));

const MIG_DIR = path.join(__dirname, '..', '..', '..', 'src', 'sql', 'migrations');
const sha256  = (s) => crypto.createHash('sha256').update(s).digest('hex');

describe('Database._migrationPreconditionSkip() @regression @tier1', function () {

    // Bind to a bare object carrying only what the method reads: dbName is the
    // parameter passed to the precondition query, MIGRATION_PRECONDITIONS is a
    // static lookup reached via the constructor, not `this`.
    function dbStub(dbName){
        return { dbName, migrationPreconditionSkip: Database.prototype.migrationPreconditionSkip };
    }

    it('returns null for a file with no registered precondition', async function () {
        const db = dbStub('test_indexer');
        const conn = { query: async () => { throw new Error('must not query when no precondition is registered'); } };
        const result = await db.migrationPreconditionSkip('2026-01-01-unrelated.sql', conn);
        assert.strictEqual(result, null);
    });

    it('queries information_schema with the database name and returns the skip reason', async function () {
        const db = dbStub('test_indexer');
        let seenSql, seenParams;
        const conn = {
            query: async (sql, params) => {
                seenSql = sql;
                seenParams = params;
                return [{ len: 130 }];
            }
        };
        const reason = await db.migrationPreconditionSkip(FILE, conn);
        assert.ok(reason);
        assert.deepStrictEqual(seenParams, ['test_indexer']);
        assert.match(seenSql, /CHARACTER_MAXIMUM_LENGTH/);
    });

    it('returns null (do not baseline) when the live column is still narrow', async function () {
        const db = dbStub('test_indexer');
        const conn = { query: async () => [{ len: 66 }] };
        const result = await db.migrationPreconditionSkip(FILE, conn);
        assert.strictEqual(result, null);
    });

    it('returns null when the query yields no rows (table/column absent)', async function () {
        const db = dbStub('test_indexer');
        const conn = { query: async () => [] };
        const result = await db.migrationPreconditionSkip(FILE, conn);
        assert.strictEqual(result, null);
    });

    it('tolerates a query result with no rows array (guards with `|| []`)', async function () {
        const db = dbStub('test_indexer');
        const conn = { query: async () => null };
        const result = await db.migrationPreconditionSkip(FILE, conn);
        assert.strictEqual(result, null);
    });
});

const fileChecksums = () => {
    const out = new Map();
    for (const f of fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql'))) {
        out.set(f, sha256(fs.readFileSync(path.join(MIG_DIR, f), 'utf8')));
    }
    return out;
};

// Runs runMigrations against a fake connection: the ledger holds every file
// EXCEPT the pubkeys-widen migration (so it enters the apply loop as
// unapplied), and information_schema reports the column already at the
// target width. Nothing else should be applied, since every other file is
// already in the ledger.
async function runAgainst(pubkeyLen) {
    const inserts = [];
    const logged  = [];
    const ledger  = fileChecksums();
    ledger.delete(FILE);

    const conn = {
        query: async function (sql, params) {
            if (/GET_LOCK/i.test(sql))     return [{ l: 1 }];
            if (/RELEASE_LOCK/i.test(sql)) return [{}];
            if (/SELECT name, checksum FROM schema_migrations/i.test(sql)) {
                return Array.from(ledger, ([name, checksum]) => ({ name, checksum }));
            }
            // Bare-schema harness, live-schema question: see BRIDGE_TABLES_PROBE above.
            if (BRIDGE_TABLES_PROBE.test(sql)) return bridgeTablesPresent();
            if (/CREATE TABLE IF NOT EXISTS schema_migrations/i.test(sql)) return {};
            if (/CHARACTER_MAXIMUM_LENGTH/i.test(sql)) return [{ len: pubkeyLen }];
            if (/^INSERT INTO schema_migrations/i.test(sql.trim())) { inserts.push(params); return {}; }
            if (/^(UPDATE|INSERT|CREATE|ALTER|DROP)/i.test(sql.trim())) return {};
            return [];
        },
        release: async function () {},
    };
    const db = {
        dbName: 'test_indexer',
        transactionConnection: null,
        getConnection: async () => conn,
        ensureMigrationsLedger: async () => {},
        runMigrationsInner: Database.prototype.runMigrationsInner,
        migrationPreconditionSkip: Database.prototype.migrationPreconditionSkip,
        assertPubkeyColumnIsUncompressedWide: async () => {},
        // The REAL collation assertion, not a stub: this harness's conn answers []
        // to any SQL it does not recognise, which is exactly the absent-column case
        // that assertion must pass through rather than halt on. Stubbing it away
        // would let a regression in that pass-through ride into runMigrations unseen.
        assertStakeWeightOrderingCollation: Database.prototype.assertStakeWeightOrderingCollation,
        migrationMode: Database.prototype.migrationMode,
        splitSqlStatements: Database.prototype.splitSqlStatements,
        stripSqlLineComments: Database.prototype.stripSqlLineComments,
        destructiveAutoStatement: Database.prototype.destructiveAutoStatement,
        isIdRepairUpdate: Database.prototype.isIdRepairUpdate,
    };
    const realLog = console.log, realErr = console.error, realWarn = console.warn;
    console.log = console.error = console.warn = (...a) => { logged.push(a.join(' ')); };
    let result;
    try {
        result = await Database.prototype.runMigrations.call(db, {});
    } finally {
        console.log = realLog; console.error = realErr; console.warn = realWarn;
    }
    return { inserts, logged, result };
}

// End-to-end over the runner's precondition branch itself, against a stubbed
// connection: a live schema that already satisfies the migration's end state
// must be baselined (a ledger row inserted, no SQL statement executed) rather
// than left pending forever.
describe('runMigrations() precondition baseline branch @regression @tier1', function () {
    it('baselines the migration when the live column is already wide enough', async function () {
        const { inserts, logged, result } = await runAgainst(130);
        assert.ok(result.baselined.includes(FILE), 'expected ' + FILE + ' in result.baselined, got: ' + JSON.stringify(result));
        assert.ok(!result.applied.includes(FILE), 'a baselined migration must not also be recorded as applied');
        assert.ok(!result.pending.includes(FILE), 'a baselined migration must not stay pending');
        assert.strictEqual(inserts.length, 1, 'exactly one ledger row should be inserted (the baseline)');
        assert.strictEqual(inserts[0][0], FILE);
        assert.ok(logged.some(l => /BASELINED/.test(l) && l.includes(FILE)),
            'expected a BASELINED log line: ' + logged.join(' | '));
    });

    it('leaves the migration pending (not baselined) when the live column is still narrow', async function () {
        const { inserts, result } = await runAgainst(66);
        assert.ok(result.pending.includes(FILE), 'expected ' + FILE + ' in result.pending, got: ' + JSON.stringify(result));
        assert.ok(!result.baselined.includes(FILE));
        assert.strictEqual(inserts.length, 0, 'no ledger row should be inserted for a still-pending migration');
    });
});

// Every migration in the ledger EXCEPT the qualifier file, so it is the only one
// that reaches the apply loop and the only precondition that is evaluated.
function ledgerWithoutQualifier(){
    const out = new Map();
    for (const f of fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql'))) {
        out.set(f, sha256(fs.readFileSync(path.join(MIG_DIR, f), 'utf8')));
    }
    out.delete(QUALIFIER_FILE);
    return out;
}

// `assertRows` is what the POST-RUN startup assertion
// (assertRewardUniqueKeyCarriesQualifier) sees, which is a different question from
// the precondition predicate and answered by a different query. It defaults to an
// absent reward_unique index - a state the assertion passes through - so these cases
// isolate the runner's precondition branch; the assertion's own halt behaviour is
// driven directly in migration_preconditions.test.js, and its coupling to the runner
// is driven by the last case in this block.
async function runAgainstShape(shape, assertRows = []) {
    const inserts = [];
    const logged  = [];
    const ledger  = ledgerWithoutQualifier();

    const conn = {
        query: async function (sql, params) {
            if (/GET_LOCK/i.test(sql))     return [{ l: 1 }];
            if (/RELEASE_LOCK/i.test(sql)) return [{}];
            if (/SELECT name, checksum FROM schema_migrations/i.test(sql)) {
                return Array.from(ledger, ([name, checksum]) => ({ name, checksum }));
            }
            // Bare-schema harness, live-schema question: see BRIDGE_TABLES_PROBE above.
            if (BRIDGE_TABLES_PROBE.test(sql)) return bridgeTablesPresent();
            if (/CREATE TABLE IF NOT EXISTS schema_migrations/i.test(sql)) return {};
            // Ordered BEFORE the precondition matcher: both queries mention
            // round_qualifier and information_schema, and only this one asks for the
            // index-shape counts the startup assertion reads.
            if (/qualifier_columns/i.test(sql)) return assertRows;
            if (/round_qualifier/i.test(sql) && /information_schema/i.test(sql)) return [shape];
            if (/^INSERT INTO schema_migrations/i.test(sql.trim())) { inserts.push(params); return {}; }
            if (/^(UPDATE|INSERT|CREATE|ALTER|DROP)/i.test(sql.trim())) return {};
            return [];
        },
        release: async function () {},
    };
    const db = {
        dbName: 'test_indexer',
        transactionConnection: null,
        getConnection: async () => conn,
        ensureMigrationsLedger: async () => {},
        runMigrationsInner: Database.prototype.runMigrationsInner,
        migrationPreconditionSkip: Database.prototype.migrationPreconditionSkip,
        assertPubkeyColumnIsUncompressedWide: async () => {},
        assertStakeWeightOrderingCollation: Database.prototype.assertStakeWeightOrderingCollation,
        migrationMode: Database.prototype.migrationMode,
        splitSqlStatements: Database.prototype.splitSqlStatements,
        stripSqlLineComments: Database.prototype.stripSqlLineComments,
        destructiveAutoStatement: Database.prototype.destructiveAutoStatement,
        isIdRepairUpdate: Database.prototype.isIdRepairUpdate,
    };
    const realLog = console.log, realErr = console.error, realWarn = console.warn;
    console.log = console.error = console.warn = (...a) => { logged.push(a.join(' ')); };
    let result;
    try {
        result = await Database.prototype.runMigrations.call(db, {});
    } finally {
        console.log = realLog; console.error = realErr; console.warn = realWarn;
    }
    return { inserts, logged, result };
}

// Same end-to-end drive for the round-qualifier migration, whose predicate keys on the
// live INDEX shape. The trap case is what makes this worth running through the real
// runner branch rather than the predicate alone: a database whose qualifier COLUMNS were
// added by the boot drift reconciler, while reward_unique is still the four-column key,
// must come out PENDING with no ledger row - baselining it would record the migration as
// done on exactly the schema it exists to converge.
describe('runMigrations() precondition baseline branch, round_qualifier @regression @tier1', function () {
    it('baselines when reward_unique already carries round_qualifier', async function () {
        const { inserts, logged, result } = await runAgainstShape({ reward_col: 1, log_col: 1, key_col: 1 });
        assert.ok(result.baselined.includes(QUALIFIER_FILE),
            'expected ' + QUALIFIER_FILE + ' in result.baselined, got: ' + JSON.stringify(result));
        assert.ok(!result.applied.includes(QUALIFIER_FILE), 'a baselined migration must not also be recorded as applied');
        assert.ok(!result.pending.includes(QUALIFIER_FILE), 'a baselined migration must not stay pending');
        assert.strictEqual(inserts.length, 1, 'exactly one ledger row should be inserted (the baseline)');
        assert.strictEqual(inserts[0][0], QUALIFIER_FILE);
        assert.ok(logged.some(l => /BASELINED/.test(l) && l.includes(QUALIFIER_FILE)),
            'expected a BASELINED log line: ' + logged.join(' | '));
    });
});

describe('runMigrations() precondition baseline branch, round_qualifier @regression @tier1', function () {
    it('leaves it PENDING on the trap shape: columns drift-healed, key still four-column', async function () {
        const { inserts, result } = await runAgainstShape({ reward_col: 1, log_col: 1, key_col: 0 });
        assert.ok(result.pending.includes(QUALIFIER_FILE),
            'expected ' + QUALIFIER_FILE + ' in result.pending, got: ' + JSON.stringify(result));
        assert.ok(!result.baselined.includes(QUALIFIER_FILE),
            'baselining the four-column key would record the migration as done on the one schema it exists to converge');
        assert.strictEqual(inserts.length, 0, 'no ledger row should be inserted for a still-pending migration');
    });

    it('HALTS runMigrations on the trap shape once the live key is read, pending or not', async function () {
        // Leaving the file pending is a log line an operator can miss for weeks. What stops
        // a node from running the qualifier-aware reward writers against the four-column
        // key is the startup assertion on the way out of runMigrations, and it must fire
        // through the real wrapper - not merely exist as a method - or a deploy discovers
        // the requirement as a diverged COLLECT rail instead of a refused boot.
        await assert.rejects(
            () => runAgainstShape({ reward_col: 1, log_col: 1, key_col: 0 },
                                  [{ reward_table: 1, qualifier_column: 1, key_columns: 4, qualifier_columns: 0 }]),
            /reward_unique does not include round_qualifier[\s\S]*--file 2026-08-24-validator-rewards-round-qualifier\.sql/);
    });

    it('returns normally when the live key already carries the qualifier', async function () {
        const { result } = await runAgainstShape({ reward_col: 1, log_col: 1, key_col: 1 },
                                                 [{ reward_table: 1, qualifier_column: 1, key_columns: 5, qualifier_columns: 1 }]);
        assert.ok(result.baselined.includes(QUALIFIER_FILE));
    });
});
