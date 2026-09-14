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
 * XChain Indexer - Database class part: startup assertions
 *
 * The fail-closed schema assertions runMigrations runs on every return, each one registered
 * in Database.STARTUP_ASSERTED_MIGRATIONS.
 *
 * A part of the Database class body: db/index.js installs it onto Database.prototype,
 * non-enumerable and in the order the class declared it, so call sites stay
 * this.db.<method>().
 *
 ********************************************************************/

// Strict, as the class body these methods came from was.
'use strict';

// The class itself, for the statics these methods read. db/index.js publishes it before it
// requires any part, so this resolves to the finished class rather than a half-built export.
const Database = require('../index.js');

module.exports = {

    // Assert pubkeys.pubkey is wide enough for an UNCOMPRESSED key (130 hex chars).
    // 2026-07-24-pubkeys-widen-uncompressed.sql is mode=manual, so the startup drift
    // reconciler cannot heal it (alterTableForDrift only ADDS columns and RELAXES
    // nullability, never changes width) and a scoped --file rollout can leave a fleet
    // half-migrated with no operator signal: too narrow, an uncompressed key is
    // truncated to 66 chars under non-strict sql_mode or rejected with errno 1406.
    // Skips silently when the column is absent (table not created yet).
    //
    // This assertion is REGISTERED in Database.STARTUP_ASSERTED_MIGRATIONS, which is
    // what lets a deploy discover the requirement before it recreates a container
    // rather than after (see that constant for the 2026-08-09 outage it closes).
    async assertPubkeyColumnIsUncompressedWide(){
        const UNCOMPRESSED_PUBKEY_HEX_LENGTH = 130;
        let conn;
        try {
            conn = await this.getConnection();
            const rows = await conn.query(
                "SELECT CHARACTER_MAXIMUM_LENGTH AS len FROM information_schema.columns WHERE table_schema = ? AND table_name = 'pubkeys' AND column_name = 'pubkey'",
                [this.dbName]
            );
            if(!rows.length) return;  // column absent: table may not exist yet
            const len = rows[0].len == null ? null : Number(rows[0].len);
            // A non-character type reports NULL here; that is a schema shape this
            // guard cannot reason about, so leave it to the column's own contract.
            if(len == null || Number.isNaN(len)) return;
            if(len < UNCOMPRESSED_PUBKEY_HEX_LENGTH){
                // Name the exact file. The old text said only "node src/migration/migrate.js", which
                // on an aged fleet DB means "apply every pending manual migration" - nine of
                // them on mainnet in August 2026, one a DROP COLUMN - so the operator either
                // ran far more than the halt required or had to work out which file it meant
                // while three chains were down.
                throw new Error(
                    'pubkeys.pubkey holds ' + len + ' chars but VARCHAR(' + UNCOMPRESSED_PUBKEY_HEX_LENGTH + ') is required ' +
                    'for uncompressed keys; narrower silently NULLs or truncates the source_pubkey seam field. ' +
                    'Run the pending migration: node src/migration/migrate.js --file ' +
                    Database.startupAssertedMigrationFile('assertPubkeyColumnIsUncompressedWide')
                );
            }
        } finally {
            if(conn && this.transactionConnection == null){
                try { await conn.release(); } catch(_){}
            }
        }
    },

    // Assert validator_rewards.reward_unique keys the QUALIFIED reward identity, i.e. that
    // the index carries round_qualifier. 2026-08-24-validator-rewards-round-qualifier.sql
    // is mode=manual and is the ONLY convergence path for that key on an aged database:
    // both round_qualifier columns are NOT NULL with a DEFAULT, so the boot drift
    // reconciler ADDs them, but reconcileTableIndexes never DROPs an index name already
    // held by a differently-defined live index, so `reward_unique` stays the four-column
    // key and only logs drift. A build carrying the qualifier-aware reward writers against
    // that four-column key re-collapses two genuinely distinct archive anchors into one
    // paid reward inside its own UNIQUE index, which is a COLLECT-rail divergence from its
    // peers rather than an error anything reports. Halting at boot is the cheap end of that.
    //
    // BOTH halves of the qualified identity are read, because both are fatal and they fail
    // at different moments. The KEY is the silent half (the divergence above) and the one
    // this file is the only convergence path for. The COLUMN is the loud half: a writer
    // naming round_qualifier against a table that has not got it is errno 1054, so the node
    // dies MID-BLOCK instead of at boot. Neither is reported by anything else, and the
    // index check cannot stand in for the column check - the counts come from different
    // information_schema tables and an index carrying no qualifier says nothing about
    // whether the column exists.
    //
    // non_unique = 0 is asserted, not assumed: a same-named NON-unique index carrying the
    // qualifier would satisfy a name-and-column test while deduplicating nothing.
    //
    // Passes through (never halts) when validator_rewards does not exist yet, when it
    // carries no reward_unique index at all, and when a count is unreadable: a fresh
    // install has no table, a missing index is another contract's business, and an answer
    // we could not read is not evidence of drift.
    //
    // REGISTERED in Database.STARTUP_ASSERTED_MIGRATIONS and tagged
    // `deploy-precondition=required` in the migration's own header, which is what lets a
    // deploy refuse before it recreates a container instead of after (see that constant).
    async assertRewardUniqueKeyCarriesQualifier(){
        // Name the exact file in every halt, for the same reason the pubkey halt above
        // does: a bare `node src/migration/migrate.js` on an aged fleet database means "apply every
        // pending manual migration", which is never what a scoped recovery wants.
        const remedy = ' Run the pending migration: node src/migration/migrate.js --file ' +
            Database.startupAssertedMigrationFile('assertRewardUniqueKeyCarriesQualifier');
        let conn;
        try {
            conn = await this.getConnection();
            const rows = await conn.query(
                "WITH p AS (SELECT ? AS db) SELECT " +
                "(SELECT COUNT(*) FROM information_schema.tables, p WHERE table_schema = p.db " +
                "AND table_name = 'validator_rewards') AS reward_table, " +
                "(SELECT COUNT(*) FROM information_schema.columns, p WHERE table_schema = p.db " +
                "AND table_name = 'validator_rewards' AND column_name = 'round_qualifier') AS qualifier_column, " +
                "(SELECT COUNT(*) FROM information_schema.statistics, p WHERE table_schema = p.db " +
                "AND table_name = 'validator_rewards' AND index_name = 'reward_unique') AS key_columns, " +
                "(SELECT COUNT(*) FROM information_schema.statistics, p WHERE table_schema = p.db " +
                "AND table_name = 'validator_rewards' AND index_name = 'reward_unique' " +
                "AND column_name = 'round_qualifier' AND non_unique = 0) AS qualifier_columns",
                [this.dbName]
            );
            if(!rows || !rows.length) return;
            const row   = rows[0] || {};
            const count = (v) => {
                if(v == null) return null;
                const n = Number(v);
                return Number.isNaN(n) ? null : n;
            };
            const table    = count(row.reward_table);
            const column   = count(row.qualifier_column);
            const keyCols  = count(row.key_columns);
            const qualCols = count(row.qualifier_columns);
            // An unreadable answer is not evidence of drift; leave the migration's own
            // PENDING state as the signal rather than halting on a row we cannot parse.
            if(table == null || column == null || keyCols == null || qualCols == null) return;
            if(table < 1) return;                     // table absent: not created yet
            if(column < 1){
                throw new Error(
                    'validator_rewards has no round_qualifier column, but this build writes rewards on the ' +
                    'qualified identity: the first archive reward it derives fails errno 1054 mid-block.' + remedy
                );
            }
            if(keyCols < 1) return;                   // no reward_unique index to compare
            if(qualCols < 1){
                throw new Error(
                    'validator_rewards.reward_unique does not include round_qualifier, so this database still ' +
                    'keys a reward on the UNQUALIFIED identity while this build derives archive rewards on the ' +
                    'qualified one: two distinct archive anchors would collapse into one paid reward and diverge ' +
                    'the COLLECT rail from the rest of the fleet.' + remedy
                );
            }
        } finally {
            if(conn && this.transactionConnection == null){
                try { await conn.release(); } catch(_){}
            }
        }
    },

    // Assert the three bridge tables exist: bridge_transfers and policy_snapshots (the
    // hub-mirrored, quorum-signed rows the XBRIDGE and XPOLICY passes apply from) and
    // bridge_settlements (the local idempotency and rollback record for every applied leg).
    //
    // WHAT GOES WRONG WITHOUT THEM, and why it is worse than a missing column: the mirror
    // ingest for a table this database cannot write fails by OMISSION. Nothing errors; the
    // bridge barrier simply never opens, and this chain stops applying transfers whose
    // source legs have already debited on the other side. An indexer in that state looks
    // healthy and is silently half of a broken bridge.
    //
    // REGISTERED in Database.STARTUP_ASSERTED_MIGRATIONS and tagged
    // `deploy-precondition=required` in 2026-09-12-bridge-tables.sql's own header, which is
    // what lets a deploy refuse before it recreates a container instead of after. This
    // assertion is the second line: on a database that boots at all, verifyTables() creates
    // a missing table from src/sql/ first, so the halt fires only where that path did not
    // run or could not (a scoped rollout, an operator-managed schema, a replica converged by
    // replaying migrations alone).
    //
    // Passes through (never halts) when a count is unreadable: an answer we could not read
    // is not evidence of a missing table, the same convention as the two assertions above.
    async assertBridgeTablesPresent(){
        const REQUIRED = ['bridge_transfers', 'bridge_settlements', 'policy_snapshots'];
        // Name the exact file in the halt: a bare `node src/migration/migrate.js` on an aged fleet
        // database means "apply every pending manual migration", which is never what a
        // scoped recovery wants.
        const remedy = ' Run the pending migration: node src/migration/migrate.js --file ' +
            Database.startupAssertedMigrationFile('assertBridgeTablesPresent');
        let conn;
        try {
            conn = await this.getConnection();
            const rows = await conn.query(
                "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ? " +
                "AND table_name IN ('bridge_transfers', 'bridge_settlements', 'policy_snapshots')",
                [this.dbName]
            );
            if(!rows) return;                       // unreadable answer: not evidence of drift
            const live    = new Set((rows || []).map(r => String(r.name || '').toLowerCase()));
            const missing = REQUIRED.filter(t => !live.has(t));
            if(!missing.length) return;
            throw new Error(
                'the bridge tables ' + missing.join(', ') + ' are absent, but this build applies ' +
                'hub-mirrored bridge rows: the mirror for a table this database cannot write fails ' +
                'by omission, so the bridge barrier never opens and transfers whose source leg has ' +
                'already debited on the other chain are never applied here.' + remedy
            );
        } finally {
            if(conn && this.transactionConnection == null){
                try { await conn.release(); } catch(_){}
            }
        }
    },

};
