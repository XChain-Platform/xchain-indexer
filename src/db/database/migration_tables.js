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
 *
 * XChain Indexer - Database class part: migration data tables
 *
 * Runner-side data tables keyed by migration filename: the live-schema preconditions, and the
 * reviewed checksum rebaselines from src/db/migration/checksum_rebaselines.js. db/index.js
 * assigns both onto Database as statics.
 *
 ********************************************************************/

const { MIGRATION_CHECKSUM_REBASELINES } = require('../migration/checksum_rebaselines.js');

// Applicability preconditions the runner evaluates against the LIVE schema before it
// applies a migration (see migrationPreconditionSkip). Each entry is a parameterised
// information_schema query taking the database name, plus a predicate returning a reason
// string when the migration does not apply to this database and null when it does.
//
// The guard lives HERE rather than inside the .sql file on purpose: a migration file's
// sha256 is its identity in schema_migrations, so adding a guard clause to an already
// applied file would trip the immutability check on every node that ran it, and healing
// that needs a MIGRATION_CHECKSUM_REBASELINES entry whose documented contract is that the
// executable SQL is byte-identical across pinned revisions. A runner-side predicate keeps
// both properties intact and covers every invocation route (startup, blanket
// `node src/db/migration/migrate.js`, and a targeted `--file` rollout), since all three funnel through
// this loop. Mirrors xchain-decoder/src/db.js.
const MIGRATION_PRECONDITIONS = {
    // Widens pubkeys.pubkey to hold an uncompressed key (130 hex chars). It is
    // mode=manual, so it stays PENDING on a database created from the current
    // src/sql/pubkeys.sql (already VARCHAR(130) or wider) - and a fresh install never
    // needs the widen a prior narrower column required. Baseline only while the live
    // column is already 130 characters or more, the same threshold
    // assertPubkeyColumnIsUncompressedWide enforces at startup.
    //
    // Absent table/column, or an unreadable/NULL length, is deliberately NOT
    // baselined: that state needs an operator, and the startup assertion fails
    // closed on it (a non-character type or a missing column returns early there,
    // leaving the migration's own PENDING state as the only signal).
    '2026-07-24-pubkeys-widen-uncompressed.sql': {
        sql: "SELECT CHARACTER_MAXIMUM_LENGTH AS len FROM information_schema.columns " +
             "WHERE table_schema = ? AND table_name = 'pubkeys' AND column_name = 'pubkey'",
        skipWhen: (rows) => {
            // No column, or a length we could not read: never baseline on an absent
            // answer, let the file speak for itself and the assertion fail closed after it.
            if(!rows.length || rows[0].len == null) return null;
            const len = Number(rows[0].len);
            if(Number.isNaN(len)) return null;
            if(len >= 130) return 'pubkeys.pubkey is already ' + len + ' characters wide, so there is no narrow column to widen.';
            return null;
        }
    },
    // Adds validator_rewards.derive_block_index (+ its index) and
    // anchor_reward_reconcile_log.reward_derive_block_index. It is mode=manual, but
    // unlike the surrogate-key case alterTableForDrift documents as its BLIND SPOT
    // (AUTO_INCREMENT / PRIMARY KEY), the drift reconciler CAN converge every object
    // it adds: both columns are nullable-with-DEFAULT in
    // src/sql/validator_rewards.sql and src/sql/anchor_reward_reconcile_log.sql (so
    // alterTableForDrift ADDs them rather than hitting the NOT-NULL-no-DEFAULT skip),
    // and the index is non-unique (so reconcileTableIndexes adds it unconditionally).
    // verifyTables() runs before runMigrations() at startup, so on a fresh or aged
    // install the end state is already in place by the time this file is read. The
    // ledger row records what is true there; without it the file sits PENDING with no
    // row forever and every operator run re-lists a no-op.
    //
    // ONE bind parameter: migrationPreconditionSkip passes [this.dbName] and nothing
    // else, so the database name is bound once in a CTE and reused by each subquery.
    //
    // A partially converged or unreadable schema is deliberately NOT baselined: any
    // missing object, or a count that will not parse, returns null and the file runs,
    // which is idempotent (IF NOT EXISTS throughout) on whatever is already there.
    '2026-08-12-validator-rewards-derive-block-index.sql': {
        sql: "WITH p AS (SELECT ? AS db) SELECT " +
             "(SELECT COUNT(*) FROM information_schema.columns, p WHERE table_schema = p.db " +
             "AND table_name = 'validator_rewards' AND column_name = 'derive_block_index') AS reward_col, " +
             "(SELECT COUNT(*) FROM information_schema.columns, p WHERE table_schema = p.db " +
             "AND table_name = 'anchor_reward_reconcile_log' AND column_name = 'reward_derive_block_index') AS log_col, " +
             "(SELECT COUNT(*) FROM information_schema.statistics, p WHERE table_schema = p.db " +
             "AND table_name = 'validator_rewards' AND column_name = 'derive_block_index') AS reward_idx",
        skipWhen: (rows) => {
            if(!rows.length) return null;
            const row = rows[0] || {};
            const counts = [row.reward_col, row.log_col, row.reward_idx];
            for(const raw of counts){
                if(raw == null) return null;
                const n = Number(raw);
                if(Number.isNaN(n) || n < 1) return null;
            }
            return 'validator_rewards.derive_block_index (with its index) and ' +
                   'anchor_reward_reconcile_log.reward_derive_block_index are already present, ' +
                   'converged from the table definitions by the startup drift reconciler, so this ' +
                   'migration has nothing left to add.';
        }
    },
    // Adds validator_rewards.round_qualifier and anchor_reward_reconcile_log.round_qualifier,
    // and REBUILDS validator_rewards.reward_unique to include the qualifier. It is mode=manual,
    // and unlike the derive-block entry above the drift reconciler converges only PART of that
    // end state: both columns are NOT NULL *with a DEFAULT* in src/sql, so alterTableForDrift
    // ADDs them, but reconcileTableIndexes never DROPs an index name already held by a
    // differently-defined live index, so an AGED database keeps the four-column key and logs a
    // "cannot be applied" drift warning every boot. A database CREATED from the current src/sql
    // gets the five-column index directly from validator_rewards.sql (createTable executes every
    // statement in the file, including its CREATE UNIQUE INDEX), so it needs nothing from this
    // file and would otherwise sit PENDING with no ledger row forever.
    //
    // The predicate keys on the LIVE INDEX SHAPE, not on the column, and that is the whole point.
    // The columns arrive on their own, so a column-only test would baseline exactly the database
    // this migration exists for: qualifier column present, reward_unique still four-column, the
    // qualifier-aware writers silently re-collapsing two distinct archive rewards. That state
    // must NOT be baselined, so the index check is the gate and the columns are only a
    // completeness check on the other half of the file.
    //
    // ONE bind parameter: migrationPreconditionSkip passes [this.dbName] and nothing else, so
    // the database name is bound once in a CTE and reused by each subquery.
    //
    // non_unique = 0 is asserted, not assumed: a same-named NON-unique index carrying the
    // qualifier would satisfy a name-and-column test while deduplicating nothing.
    //
    // Any missing object, a partial shape, or a count that will not parse returns null and the
    // file runs, which is idempotent (IF [NOT] EXISTS throughout, and the DROP/ADD index pair
    // re-creates an identical definition).
    '2026-08-24-validator-rewards-round-qualifier.sql': {
        sql: "WITH p AS (SELECT ? AS db) SELECT " +
             "(SELECT COUNT(*) FROM information_schema.columns, p WHERE table_schema = p.db " +
             "AND table_name = 'validator_rewards' AND column_name = 'round_qualifier') AS reward_col, " +
             "(SELECT COUNT(*) FROM information_schema.columns, p WHERE table_schema = p.db " +
             "AND table_name = 'anchor_reward_reconcile_log' AND column_name = 'round_qualifier') AS log_col, " +
             "(SELECT COUNT(*) FROM information_schema.statistics, p WHERE table_schema = p.db " +
             "AND table_name = 'validator_rewards' AND index_name = 'reward_unique' " +
             "AND column_name = 'round_qualifier' AND non_unique = 0) AS key_col",
        skipWhen: (rows) => {
            if(!rows.length) return null;
            const row = rows[0] || {};
            const counts = [row.reward_col, row.log_col, row.key_col];
            for(const raw of counts){
                if(raw == null) return null;
                const n = Number(raw);
                if(Number.isNaN(n) || n < 1) return null;
            }
            return 'validator_rewards.reward_unique already carries round_qualifier and both ' +
                   'round_qualifier columns are present, so this database is already on the ' +
                   'qualified reward identity and this migration has nothing left to rebuild.';
        }
    },
    // Creates bridge_transfers, bridge_settlements, policy_snapshots and xbridges. It is
    // mode=manual and every statement is CREATE TABLE IF NOT EXISTS copied from src/sql, so
    // once the boot-time verifyTables() has built all four, running the file changes nothing.
    // Baseline exactly when assertBridgeTablesPresent passes (same query, same four names);
    // a missing table or an unreadable answer returns null and the file stays pending.
    '2026-09-12-bridge-tables.sql': {
        sql: "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ? " +
             "AND table_name IN ('bridge_transfers', 'bridge_settlements', 'policy_snapshots', 'xbridges')",
        skipWhen: (rows) => {
            if(!Array.isArray(rows)) return null;
            const live = new Set(rows.map(r => String((r && r.name) || '').toLowerCase()));
            const required = ['bridge_transfers', 'bridge_settlements', 'policy_snapshots', 'xbridges'];
            if(!required.every(t => live.has(t))) return null;
            return 'bridge_transfers, bridge_settlements, policy_snapshots and xbridges are all ' +
                   'present, built from their src/sql definitions at boot, so this migration has ' +
                   'no table left to create.';
        }
    },
    '2026-09-30-list-share-tables.sql': {
        sql: "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ? AND table_name IN ('list_snapshots', 'list_share_mirrors')",
        skipWhen: (rows) => { const live = new Set((Array.isArray(rows) ? rows : []).map(r => String((r && r.name) || '').toLowerCase()));
            return ['list_snapshots', 'list_share_mirrors'].every(t => live.has(t))
                ? 'list_snapshots and list_share_mirrors are both present, so this migration has no table left to create.' : null;
        } },
    // Widens oracle_prices.tick to 250. mode=manual, so a database created from the current
    // src/sql/oracle_prices.sql (already 250) would sit PENDING forever; baseline only while the
    // live column is already 250 or wider. An absent or unreadable length never baselines.
    '2026-09-22-oracle-prices-widen-tick.sql': {
        sql: "SELECT CHARACTER_MAXIMUM_LENGTH AS len FROM information_schema.columns " +
             "WHERE table_schema = ? AND table_name = 'oracle_prices' AND column_name = 'tick'",
        skipWhen: (rows) => {
            if(!rows.length || rows[0].len == null) return null;
            const len = Number(rows[0].len);
            if(Number.isNaN(len) || len < 250) return null;
            return 'oracle_prices.tick is already ' + len + ' characters wide, so there is no narrow column to widen.';
        }
    },
};

module.exports = {
    MIGRATION_CHECKSUM_REBASELINES,
    MIGRATION_PRECONDITIONS,
};
