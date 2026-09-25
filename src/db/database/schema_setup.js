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
 * XChain Indexer - Database class part: schema setup
 *
 * Database creation and table verification at boot, and the runMigrations entry with the
 * stake-weight collation assertion it runs on every return.
 *
 * A part of the Database class body: db/index.js installs it onto Database.prototype,
 * non-enumerable and in the order the class declared it, so call sites stay
 * this.db.<method>().
 *
 ********************************************************************/

// Strict, as the class body these methods came from was.
'use strict';

const mariadb = require('mariadb');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const stakeWeightCollation = require('../../consensus/gates/stake_weight_collation_gate');
const { getLogger } = require('../../observability/index.js');
// The class itself, for the statics these methods read. db/index.js publishes it before it
// requires any part, so this resolves to the finished class rather than a half-built export.
const Database = require('../index.js');

module.exports = {

    /* 
     * Database creation and verification functions 
     */

    // Verify a database exists and return true or false
    async verifyDatabase(){
        let connectionParams = {
            host:     this.host,
            user:     this.user,
            password: this.pass,
            port:     this.port
        };
        // Bounded retry (#3168): retry only transient connect faults, and fail fast on a
        // non-retryable auth error (bad credentials never self-heal). An unbounded loop here
        // left the process silently hung on bad creds instead of exiting for pm2 to surface.
        let attempt = 0;
        while(true){
            try {
                let db      = await mariadb.createConnection(connectionParams);
                let results = await db.query("SELECT * FROM information_schema.schemata WHERE schema_name = ?",[this.dbName]);
                await db.end();
                if(results.length > 0)
                    return true;
                return false;
            } catch (e){
                if(Database._isNonRetryableDbError(e))
                    throw new Error('verifyDatabase: non-retryable DB error for ' + this.dbName + ' (' + (e && (e.code || e.errno)) + '): ' + (e && e.message) + '. Check DB credentials/grants; not retrying.');
                if(++attempt >= Database.DB_CONNECT_MAX_ATTEMPTS)
                    throw new Error('verifyDatabase: gave up after ' + attempt + ' attempts reaching ' + this.dbName + ': ' + (e && e.message));
                getLogger().error('Error checking if database ' + this.dbName + ' exists (attempt ' + attempt + '/' + Database.DB_CONNECT_MAX_ATTEMPTS + '):', e)
                await this.util.sleep(5000); // Wait 5 seconds
            }
        }
    },

    // Handle creating a database
    async createDatabase(){
        // First time connecting, do not specify database name or we throw error
        let connectionParams = {
            host:     this.host,
            user:     this.user,
            password: this.pass,
            port:     this.port
        };
        let databaseCreated = false;
        // Validate database name to prevent SQL injection
        if(!/^[A-Za-z0-9_]+$/.test(this.dbName))
            throw new Error('Invalid database name: ' + this.dbName);
        getLogger().info("Creating " + this.dbName + " database!");
        // Bounded retry (#3168): same fail-fast-on-auth / cap-transient policy as verifyDatabase.
        let attempt = 0;
        while(!databaseCreated){
            try {
                let db      = await mariadb.createConnection(connectionParams);
                let results = await db.query("CREATE DATABASE IF NOT EXISTS `" + this.dbName + "`");
                await db.end();
                databaseCreated = true;
            } catch(e){
                if(Database._isNonRetryableDbError(e))
                    throw new Error('createDatabase: non-retryable DB error for ' + this.dbName + ' (' + (e && (e.code || e.errno)) + '): ' + (e && e.message) + '. Check DB credentials/grants; not retrying.');
                if(++attempt >= Database.DB_CONNECT_MAX_ATTEMPTS)
                    throw new Error('createDatabase: gave up after ' + attempt + ' attempts creating ' + this.dbName + ': ' + (e && e.message));
                getLogger().error('Error creating database ' + this.dbName + ' (attempt ' + attempt + '/' + Database.DB_CONNECT_MAX_ATTEMPTS + '):', e)
                await this.util.sleep(5000); // Waiting 5 seconds
            }
        }
        return true;
    },

    // Handle verifying all database tables exist
    async verifyTables(){
        let dir   = path.join(__dirname, '..', '..', 'sql');
        let files = fs.readdirSync(dir);
        let file  = null;
        let db    = await this.getConnection();
        // One summary line instead of a per-table pair; error paths below still
        // name the table, so a failure stays attributable.
        getLogger().info('Verifying database and tables...');
        let checked = 0;
        let created = 0;
        // Collector for the undeclared-shape findings the two reconcilers raise, so the
        // boot log carries ONE comparable summary per DB. Reading that line off all nine
        // fleet indexers is the drift comparison, in place of a hand audit.
        this.schemaShapeDrift = new Map();
        // Loop through SQL files
        for (file of files){
            if(file.indexOf('.sql') !== -1){
                let table   = file.substring(0, file.indexOf('.sql'));
                checked++;
                try {
                    let results = await db.query("SELECT * FROM information_schema.tables WHERE table_schema = ? AND table_name = ?",[this.dbName, table]);
                    if(results.length > 0){
                        // Existing table - reconcile column nullability against the
                        // SQL source. Catches schemas that were updated upstream but
                        // never migrated on stacks created from an older release.
                        await this.alterTableForDrift(file, db);
                        // Also reconcile declared indexes. A UNIQUE index added to the
                        // SQL source AFTER a table was first created (e.g. balances'
                        // addr_tick on 2026-05-29) is otherwise never applied, which
                        // silently degrades updateAddressBalance's INSERT ... ON DUPLICATE
                        // KEY UPDATE to a plain INSERT and accumulates duplicate rows.
                        await this.reconcileTableIndexes(file, db);
                    } else {
                        await this.createTable(file);
                        created++;
                    }
                } catch(e){
                    this.util.throwError('Error while trying to verify ' + table + ' table exists!');
                    return false;
                }
            }
        }
        if(checked > 0 && created === checked)
            await this.recordFreshSchemaMigrations(db);
        await db.release();
        getLogger().info('Database and tables verified (' + checked + ' tables, ' + created + ' created).');
        getLogger().info(this.schemaShapeSummary());
        return true;
    },

    async recordFreshSchemaMigrations(db){
        const dir = path.join(__dirname, '..', '..', 'sql', 'migrations');
        let files = [];
        try { files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort(); }
        catch(_){ return; }
        if(!files.length) return;

        await this.ensureMigrationsLedger(db);
        for(const file of files){
            const raw = fs.readFileSync(path.join(dir, file), 'utf8');
            const checksum = crypto.createHash('sha256').update(raw).digest('hex');
            await db.query(
                'INSERT INTO schema_migrations (name, checksum, mode, applied_at) VALUES (?, ?, ?, NOW())',
                [file, checksum, this.migrationMode(raw)]
            );
        }
    },

    // One line (plus a per-table breakdown when there is one) naming everything live that
    // no SQL source declares. Printed at the end of verifyTables so the fleet-wide
    // "does every indexer DB carry the same shape?" question is answered by comparing one
    // boot line per DB rather than by a hand schema diff across nine databases.
    schemaShapeSummary(){
        const store = this.schemaShapeDrift;
        if(!store || !store.size) return 'Schema shape: no undeclared columns or indexes.';
        const lines = [];
        let columns = 0;
        let indexes = 0;
        for(const [table, entry] of store){
            const parts = [];
            if(entry.columns.length){ columns += entry.columns.length; parts.push('columns ' + entry.columns.join(', ')); }
            if(entry.indexes.length){ indexes += entry.indexes.length; parts.push('indexes ' + entry.indexes.map(i => i.name).join(', ')); }
            lines.push('  ' + table + ': ' + parts.join('; '));
        }
        return 'SCHEMA SHAPE DRIFT: ' + store.size + ' table(s) carry ' + columns + ' undeclared column(s) and ' +
               indexes + ' undeclared index(es); this DB does not match a fresh install of this release.\n' + lines.join('\n');
    },

    // Apply tracked, ordered schema migrations from src/sql/migrations/ - the changes
    // the startup drift reconciler deliberately can't/won't make on its own: data
    // backfills, destructive index/column changes, dedup-then-unique, type changes.
    // (Additive column/index drift is already auto-reconciled by verifyTables; this is
    // only for the rest.) Each file is applied at most once and recorded in the
    // `schema_migrations` ledger, so it is safe to call on every startup.
    //
    // A migration opts into unattended application with a header tag on any of its
    // first lines:
    //   -- xchain:migration mode=auto     → applied automatically at startup
    //   -- xchain:migration mode=manual   → applied only by an explicit operator run
    // A file with NO tag is treated as `manual` - unknown DDL never auto-runs on a
    // validator fleet. `auto` migrations must be additive + idempotent (guard with
    // IF [NOT] EXISTS); anything that can fail on existing data (e.g. a UNIQUE index
    // needing dedup) must be `manual`.
    //
    // opts.includeManual=true also applies pending `manual` migrations - that's the
    // operator-initiated path (`node src/db/migration/migrate.js`). The whole run holds a DB-scoped
    // advisory lock so concurrent processes/replicas can't apply the same file twice.
    // Returns { applied:[...], pending:[...] }.
    //
    // opts.only (the CLI's --file) scopes a run to named migration files - a targeted
    // rollout of one manual migration without dragging in every other pending one.
    //
    // Fail-closed schema contract the drift reconciler cannot heal (alterTableForDrift
    // only ADDS columns and RELAXES nullability, never changes width). The widen is
    // mode=manual, so it never auto-applies; assert on EVERY normal return - including
    // no-dir, empty-dir, lock-skip and a scoped --file run - so a half-migrated fleet
    // halts loudly instead of truncating the source_pubkey seam (#3875). If the inner
    // body throws it is already failing loudly, so the assertion is skipped.
    async runMigrations(opts = {}){
        const result = await this.runMigrationsInner(opts);
        await this.assertPubkeyColumnIsUncompressedWide();
        await this.assertStakeWeightOrderingCollation();
        // Invoked through the prototype rather than `this`: the reward-identity assertion is
        // a fail-closed COLLECT-rail guard, and a partial object that happens not to carry
        // the method would otherwise drop it without a word. Nothing may opt out of it.
        await Database.prototype.assertRewardUniqueKeyCarriesQualifier.call(this);
        // Same fail-closed rule as the reward assertion above: invoked through the prototype
        // so a partial object cannot silently drop the bridge-table check.
        await Database.prototype.assertBridgeTablesPresent.call(this);
        return result;
    },

    // Fail-closed schema contract for the columns the stake-weight snapshot ORDERS on
    // (stake_weight_collation_activation.js). The window caps truncate on that order, so
    // the collation of index_addresses.address / index_pubkeys.pubkey decides which
    // sources and keys reach the hashed stakes_root: a node whose column collation
    // drifted off src/sql commits a different root than the rest of the fleet, silently.
    // Once the gate is armed, a drifted CHARSET is worse than silent - `COLLATE utf8_bin`
    // against a utf8mb4 column is errno 1253, so the node dies mid-block instead of at
    // boot. Halting here with the table.column named is the cheap end of that.
    //
    // The comparison normalises the utf8 / utf8mb3 spelling on BOTH sides: MariaDB 10.6
    // renamed the charset, so a column declared `CHARSET=utf8 COLLATE=utf8_general_ci`
    // reports utf8mb3 / utf8mb3_general_ci (verified on 11.4.12). Comparing the raw names
    // would halt every node in the fleet on a perfectly correct schema.
    //
    // An absent column and an unreadable name both return early rather than halt: a
    // fresh install has no table yet, and an answer we could not read is not evidence of
    // drift. Same convention as assertPubkeyColumnIsUncompressedWide above.
    async assertStakeWeightOrderingCollation(){
        let conn;
        try {
            conn = await this.getConnection();
            for(const spec of stakeWeightCollation.STAKE_WEIGHT_ORDERING_COLUMNS){
                const rows = await conn.query(
                    "SELECT CHARACTER_SET_NAME, COLLATION_NAME FROM information_schema.columns " +
                    "WHERE table_schema = ? AND table_name = ? AND column_name = ?",
                    [this.dbName, spec.table, spec.column]
                );
                if(!rows.length) continue;  // column absent: table may not exist yet
                const reason = stakeWeightCollation.collationDriftReason(spec, rows[0]);
                if(reason) throw new Error(reason);
            }
        } finally {
            if(conn && this.transactionConnection == null){
                try { await conn.release(); } catch(_){}
            }
        }
    },

};
