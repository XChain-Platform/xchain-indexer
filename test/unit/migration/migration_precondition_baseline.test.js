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
 * migrationPreconditionSkip().
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
 * live DB) and migrationPreconditionSkip() against a stubbed connection.
 *
 ********************************************************************/

const assert = require('assert');

const Database = require('../../../src/db');

const FILE = '2026-07-24-pubkeys-widen-uncompressed.sql';

// runMigrations() makes four fail-closed schema assertions on every normal return, and each
// asks the live schema a question the fake connections below have to answer. The pubkey
// width, the stake-weight collation and the reward-key assertions all read
// information_schema.columns/statistics and pass through on an empty answer, because an
// absent column is a fresh install rather than drift - which is why a bare fake conn that
// returns [] has always satisfied them. assertBridgeTablesPresent reads
// information_schema.TABLES, where an empty answer is NOT ambiguous: zero rows means the
// three tables really are gone, and halting is the whole point of the guard.
//
// So the harnesses below seed that one probe, exactly as the sibling runner suite does
// (test/unit/migration_runner.test.js): these cases drive the runner's PRECONDITION branch
// against a deliberately bare schema, and a precondition test must not be the thing that
// decides whether a node may boot without the bridge tables. The production assertion is
// left exactly as written; its halt is pinned by its own describe block in
// test/unit/migration_runner.test.js.
const BRIDGE_TABLES_PROBE = /information_schema\.tables[\s\S]*bridge_transfers/i;
const BRIDGE_TABLE_ROWS   = Object.freeze(['bridge_transfers', 'bridge_settlements', 'policy_snapshots']);
const bridgeTablesPresent = () => BRIDGE_TABLE_ROWS.map((name) => ({ name }));

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

const QUALIFIER_FILE = '2026-08-24-validator-rewards-round-qualifier.sql';

const pre = Database.MIGRATION_PRECONDITIONS[QUALIFIER_FILE];
// The converged shape: both qualifier columns present AND reward_unique carrying
// the qualifier as a UNIQUE index.
const present = { reward_col: 1, log_col: 1, key_col: 1 };

describe('Database.MIGRATION_PRECONDITIONS[validator-rewards round_qualifier] @regression @tier1', function () {
    it('is registered', function () {
        assert.ok(pre, QUALIFIER_FILE + ' must have a MIGRATION_PRECONDITIONS entry');
        assert.strictEqual(typeof pre.sql, 'string');
        assert.strictEqual(typeof pre.skipWhen, 'function');
    });

    it('binds the database name EXACTLY once (_migrationPreconditionSkip passes one parameter)', function () {
        assert.strictEqual((pre.sql.match(/\?/g) || []).length, 1,
            'the precondition query must carry exactly one bind parameter');
        assert.match(pre.sql, /SELECT \? AS db/);
        assert.match(pre.sql, /table_schema = p\.db/);
    });

    it('keys on the live INDEX shape, not merely on the column', function () {
        // The columns arrive on their own (NOT NULL WITH DEFAULT, so alterTableForDrift
        // ADDs them); the KEY does not. A predicate testing the column alone would
        // baseline exactly the database this migration exists for.
        assert.match(pre.sql, /information_schema\.statistics/i);
        assert.match(pre.sql, /index_name = 'reward_unique'/);
        assert.match(pre.sql, /column_name = 'round_qualifier'/);
        assert.match(pre.sql, /non_unique = 0/);
    });

    it('names both qualifier columns the migration adds', function () {
        assert.match(pre.sql, /table_name = 'validator_rewards'/);
        assert.match(pre.sql, /table_name = 'anchor_reward_reconcile_log'/);
    });

    it('baselines when both columns and the qualified unique key are present', function () {
        const reason = pre.skipWhen([present]);
        assert.ok(reason, 'expected a skip reason when the converged shape is fully present');
        assert.match(reason, /reward_unique/);
        assert.match(reason, /round_qualifier/);
    });

    it('does NOT baseline the TRAP state: qualifier columns present, reward_unique still four-column', function () {
        // The exact state the migration exists to converge, and the one a column-only
        // predicate would silently have marked done: the drift reconciler ADDed both
        // columns at boot while reconcileTableIndexes refused to rebuild the key it did
        // not create, so the qualifier-aware writers run against the OLD identity.
        assert.strictEqual(pre.skipWhen([{ ...present, key_col: 0 }]), null);
    });

    it('does NOT baseline when the validator_rewards column is missing', function () {
        assert.strictEqual(pre.skipWhen([{ ...present, reward_col: 0 }]), null);
    });

    it('does NOT baseline when the reconcile-log column is missing', function () {
        assert.strictEqual(pre.skipWhen([{ ...present, log_col: 0 }]), null);
    });

    it('does NOT baseline on an empty result set', function () {
        assert.strictEqual(pre.skipWhen([]), null);
    });
});

describe('Database.MIGRATION_PRECONDITIONS[validator-rewards round_qualifier] @regression @tier1', function () {
    it('does NOT baseline when a count is NULL (unreadable)', function () {
        assert.strictEqual(pre.skipWhen([{ ...present, key_col: null }]), null);
    });

    it('does NOT baseline when a count is unparsable', function () {
        assert.strictEqual(pre.skipWhen([{ ...present, key_col: 'not-a-number' }]), null);
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
            path.join(__dirname, '..', '..', '..', 'src', 'sql', 'migrations', DERIVE_FILE), 'utf8');
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

// The deploy-precondition retag changed this file's sha256 the same way, and every
// database that applied it by hand records the pre-tag hash. Without the entry the
// immutability guard logs `content CHANGED` on every boot and `node src/db/migration/migrate.js`
// fails closed, which strands the whole pending manual backlog on that host.
describe('MIGRATION_CHECKSUM_REBASELINES[validator-rewards round_qualifier] @regression @tier1', function () {

    const fs     = require('fs');
    const path   = require('path');
    const crypto = require('crypto');

    const readQualifier = () => fs.readFileSync(
        path.join(__dirname, '..', '..', '..', 'src', 'sql', 'migrations', QUALIFIER_FILE), 'utf8');

    it('pins the current file content as `to`', function () {
        const entry = Database.MIGRATION_CHECKSUM_REBASELINES[QUALIFIER_FILE];
        assert.ok(entry, QUALIFIER_FILE + ' must have a checksum rebaseline entry');
        assert.strictEqual(entry.to, crypto.createHash('sha256').update(readQualifier()).digest('hex'),
            '`to` must be the sha256 of the file as committed');
    });

    it('lists every prior revision in `from`, and never the current hash', function () {
        const entry = Database.MIGRATION_CHECKSUM_REBASELINES[QUALIFIER_FILE];
        const from  = [].concat(entry.from);
        assert.ok(from.length >= 1);
        assert.ok(!from.includes(entry.to), '`from` must not contain the current hash');
        for (const h of from) assert.match(h, /^[0-9a-f]{64}$/);
    });

    it('rebaselines a COMMENT-only retag: the executable SQL is byte-identical', function () {
        // The documented contract of this table. The tag rides on the directive comment
        // line, so the four ALTER TABLE statements must be untouched; an executable edit
        // needs its own dated migration, never an entry here.
        const statements = Database.prototype.splitSqlStatements.call({
            stripSqlLineComments: Database.prototype.stripSqlLineComments
        }, readQualifier());
        assert.strictEqual(statements.length, 4, 'got: ' + JSON.stringify(statements));
        assert.ok(statements.every(s => /^ALTER TABLE/i.test(s.trim())),
            'every statement in this migration is an ALTER TABLE; got: ' + JSON.stringify(statements));
        assert.ok(!statements.some(s => /deploy-precondition/i.test(s)),
            'the tag must live in the header comment, never in an executable statement');
    });
});
