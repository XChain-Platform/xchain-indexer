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
 * Shape-aware migration baselining: Database.MIGRATION_PRECONDITIONS and
 * _migrationPreconditionSkip().
 *
 * A database rebuilt from chain creates its tables directly from src/sql/*.sql,
 * so a manual migration whose end state already holds on the live schema stays
 * PENDING forever with zero ledger rows, even though nothing needs converting.
 * The precondition gate records such a migration as applied WITHOUT running its
 * statements ("baselining") the first time the live schema is examined, so a
 * deploy guard that checks the ledger sees the migration as satisfied instead
 * of refusing the deploy.
 *
 * These tests exercise the pubkeys.pubkey predicate directly (pure logic, no
 * live DB) and _migrationPreconditionSkip() against a stubbed connection.
 *
 ********************************************************************/

const assert = require('assert');

const Database = require('../../src/db');

const FILE = '2026-07-24-pubkeys-widen-uncompressed.sql';

describe('Database.MIGRATION_PRECONDITIONS[pubkeys widen] @regression @tier1', function () {

    const pre = Database.MIGRATION_PRECONDITIONS[FILE];

    it('is registered', function () {
        assert.ok(pre, FILE + ' must have a MIGRATION_PRECONDITIONS entry');
        assert.strictEqual(typeof pre.sql, 'string');
        assert.strictEqual(typeof pre.skipWhen, 'function');
    });

    it('reads CHARACTER_MAXIMUM_LENGTH for pubkeys.pubkey, parameterised on the database name', function () {
        assert.match(pre.sql, /CHARACTER_MAXIMUM_LENGTH/);
        assert.match(pre.sql, /information_schema\.columns/i);
        assert.match(pre.sql, /table_name = 'pubkeys'/);
        assert.match(pre.sql, /column_name = 'pubkey'/);
        assert.match(pre.sql, /table_schema = \?/);
    });

    it('baselines when the column already holds 130 characters (matches the uncompressed threshold)', function () {
        const reason = pre.skipWhen([{ len: 130 }]);
        assert.ok(reason, 'expected a skip reason at exactly the threshold');
        assert.match(reason, /130/);
    });

    it('baselines when the column is wider than 130 characters', function () {
        const reason = pre.skipWhen([{ len: 191 }]);
        assert.ok(reason, 'expected a skip reason above the threshold');
    });

    it('does NOT baseline at 66 characters (the pre-widen compressed-only width)', function () {
        assert.strictEqual(pre.skipWhen([{ len: 66 }]), null);
    });

    it('does NOT baseline at 129 characters (one short of the threshold)', function () {
        assert.strictEqual(pre.skipWhen([{ len: 129 }]), null);
    });

    it('does NOT baseline when the table/column is missing (empty result set)', function () {
        assert.strictEqual(pre.skipWhen([]), null);
    });

    it('does NOT baseline when the length is NULL (non-character type, or unreadable)', function () {
        assert.strictEqual(pre.skipWhen([{ len: null }]), null);
    });

    it('does NOT baseline when the length is an unparsable value', function () {
        assert.strictEqual(pre.skipWhen([{ len: 'not-a-number' }]), null);
    });
});

const DERIVE_FILE = '2026-08-12-validator-rewards-derive-block-index.sql';

describe('Database.MIGRATION_PRECONDITIONS[validator-rewards derive_block_index] @regression @tier1', function () {

    const pre = Database.MIGRATION_PRECONDITIONS[DERIVE_FILE];
    const present = { reward_col: 1, log_col: 1, reward_idx: 1 };

    it('is registered', function () {
        assert.ok(pre, DERIVE_FILE + ' must have a MIGRATION_PRECONDITIONS entry');
        assert.strictEqual(typeof pre.sql, 'string');
        assert.strictEqual(typeof pre.skipWhen, 'function');
    });

    it('binds the database name EXACTLY once (_migrationPreconditionSkip passes one parameter)', function () {
        assert.strictEqual((pre.sql.match(/\?/g) || []).length, 1,
            'the precondition query must carry exactly one bind parameter');
        assert.match(pre.sql, /SELECT \? AS db/);
        assert.match(pre.sql, /table_schema = p\.db/);
    });

    it('names both columns and the index it gates', function () {
        assert.match(pre.sql, /information_schema\.columns/i);
        assert.match(pre.sql, /information_schema\.statistics/i);
        assert.match(pre.sql, /table_name = 'validator_rewards'/);
        assert.match(pre.sql, /column_name = 'derive_block_index'/);
        assert.match(pre.sql, /table_name = 'anchor_reward_reconcile_log'/);
        assert.match(pre.sql, /column_name = 'reward_derive_block_index'/);
    });

    it('baselines when both columns and the index are present', function () {
        const reason = pre.skipWhen([present]);
        assert.ok(reason, 'expected a skip reason when the converged shape is fully present');
        assert.match(reason, /derive_block_index/);
    });

    it('does NOT baseline when the reward column is missing', function () {
        assert.strictEqual(pre.skipWhen([{ ...present, reward_col: 0 }]), null);
    });

    it('does NOT baseline when the reconcile-log column is missing', function () {
        assert.strictEqual(pre.skipWhen([{ ...present, log_col: 0 }]), null);
    });

    it('does NOT baseline when the index is missing (column added, index not yet reconciled)', function () {
        assert.strictEqual(pre.skipWhen([{ ...present, reward_idx: 0 }]), null);
    });

    it('does NOT baseline on an empty result set', function () {
        assert.strictEqual(pre.skipWhen([]), null);
    });

    it('does NOT baseline when a count is NULL (unreadable)', function () {
        assert.strictEqual(pre.skipWhen([{ ...present, log_col: null }]), null);
    });

    it('does NOT baseline when a count is unparsable', function () {
        assert.strictEqual(pre.skipWhen([{ ...present, reward_idx: 'not-a-number' }]), null);
    });
});

// The header rewrite changed the file's sha256, which is its identity in
// schema_migrations, so every DB that applied a prior revision must heal rather
// than fail the immutability guard forever.
describe('MIGRATION_CHECKSUM_REBASELINES[validator-rewards derive_block_index] @regression @tier1', function () {

    const fs     = require('fs');
    const path   = require('path');
    const crypto = require('crypto');

    it('pins the current file content as `to`', function () {
        const entry = Database.MIGRATION_CHECKSUM_REBASELINES[DERIVE_FILE];
        assert.ok(entry, DERIVE_FILE + ' must have a checksum rebaseline entry');
        const raw = fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'sql', 'migrations', DERIVE_FILE), 'utf8');
        assert.strictEqual(entry.to, crypto.createHash('sha256').update(raw).digest('hex'),
            '`to` must be the sha256 of the file as committed');
    });

    it('lists every prior revision in `from`, and never the current hash', function () {
        const entry = Database.MIGRATION_CHECKSUM_REBASELINES[DERIVE_FILE];
        const from  = [].concat(entry.from);
        assert.ok(from.length >= 1);
        assert.ok(!from.includes(entry.to), '`from` must not contain the current hash');
        for (const h of from) assert.match(h, /^[0-9a-f]{64}$/);
    });
});

describe('Database._migrationPreconditionSkip() @regression @tier1', function () {

    // Bind to a bare object carrying only what the method reads: dbName is the
    // parameter passed to the precondition query, MIGRATION_PRECONDITIONS is a
    // static lookup reached via the constructor, not `this`.
    function dbStub(dbName){
        return { dbName, _migrationPreconditionSkip: Database.prototype._migrationPreconditionSkip };
    }

    it('returns null for a file with no registered precondition', async function () {
        const db = dbStub('test_indexer');
        const conn = { query: async () => { throw new Error('must not query when no precondition is registered'); } };
        const result = await db._migrationPreconditionSkip('2026-01-01-unrelated.sql', conn);
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
        const reason = await db._migrationPreconditionSkip(FILE, conn);
        assert.ok(reason);
        assert.deepStrictEqual(seenParams, ['test_indexer']);
        assert.match(seenSql, /CHARACTER_MAXIMUM_LENGTH/);
    });

    it('returns null (do not baseline) when the live column is still narrow', async function () {
        const db = dbStub('test_indexer');
        const conn = { query: async () => [{ len: 66 }] };
        const result = await db._migrationPreconditionSkip(FILE, conn);
        assert.strictEqual(result, null);
    });

    it('returns null when the query yields no rows (table/column absent)', async function () {
        const db = dbStub('test_indexer');
        const conn = { query: async () => [] };
        const result = await db._migrationPreconditionSkip(FILE, conn);
        assert.strictEqual(result, null);
    });

    it('tolerates a query result with no rows array (guards with `|| []`)', async function () {
        const db = dbStub('test_indexer');
        const conn = { query: async () => null };
        const result = await db._migrationPreconditionSkip(FILE, conn);
        assert.strictEqual(result, null);
    });
});

// End-to-end over the runner's precondition branch itself, against a stubbed
// connection: a live schema that already satisfies the migration's end state
// must be baselined (a ledger row inserted, no SQL statement executed) rather
// than left pending forever.
describe('runMigrations() precondition baseline branch @regression @tier1', function () {

    const fs   = require('fs');
    const path = require('path');
    const crypto = require('crypto');

    const MIG_DIR = path.join(__dirname, '..', '..', 'src', 'sql', 'migrations');
    const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
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
            _ensureMigrationsLedger: async () => {},
            _runMigrationsInner: Database.prototype._runMigrationsInner,
            _migrationPreconditionSkip: Database.prototype._migrationPreconditionSkip,
            _assertPubkeyColumnIsUncompressedWide: async () => {},
            // The REAL collation assertion, not a stub: this harness's conn answers []
            // to any SQL it does not recognise, which is exactly the absent-column case
            // that assertion must pass through rather than halt on. Stubbing it away
            // would let a regression in that pass-through ride into runMigrations unseen.
            _assertStakeWeightOrderingCollation: Database.prototype._assertStakeWeightOrderingCollation,
            _migrationMode: Database.prototype._migrationMode,
            splitSqlStatements: Database.prototype.splitSqlStatements,
            stripSqlLineComments: Database.prototype.stripSqlLineComments,
            _destructiveAutoStatement: Database.prototype._destructiveAutoStatement,
            _isIdRepairUpdate: Database.prototype._isIdRepairUpdate,
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
