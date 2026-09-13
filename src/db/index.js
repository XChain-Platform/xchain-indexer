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
 * XChain Indexer - Database Class
 * 
 * This file handles connecting to databases and running SQL queries
 *
 ********************************************************************/

// Runtime floor, asserted above the require it protects. The pinned mariadb 3.5.x line is
// ESM-only ("type": "module"), and require() loads ESM without a flag only from Node 22.12.0;
// below that the next line throws a bare ERR_REQUIRE_ESM that names neither the Node version
// nor the reason. engines.node cannot enforce this (npm only warns, and nothing in the tree
// sets engine-strict), and .nvmrc says only "22", so the check lives here, where the failure
// actually happens. Same guard, same wording, as xchain-hub/src/db.js.
const [NODE_MAJOR, NODE_MINOR] = String(process.versions.node).split('.').map(Number);
if (NODE_MAJOR < 22 || (NODE_MAJOR === 22 && NODE_MINOR < 12)) {
    throw new Error('xchain-indexer requires Node >= 22.12.0 (running ' + process.versions.node +
        '): the pinned mariadb 3.5.x driver is ESM-only and require() can load ESM without ' +
        'a flag only from Node 22.12. Upgrade the runtime (see .nvmrc), or start Node with ' +
        '--experimental-require-module.');
}

// Load required libraries
const mariadb = require('mariadb');
const fs      = require('fs');
const path    = require('path');
const protocolTime = require('../protocol_time');
const swqCap = require('../swq_source_cap_activation');
const listEditResolution = require('../list_edit_resolution_activation');
const caretRefStrict = require('../caret_ref_strict_activation');
const ledgerPrecision = require('../ledger_amount_precision_activation');
const stakeWeightCollation = require('../stake_weight_collation_activation');
// Token-policy inheritance: the flag day at which a LIST type-2 item, and the address-sleep
// read that shares its validator, are judged against EVERY supported coin instead of only
// this chain's. One issuer list has to be able to hold BTC, LTC and DOGE addresses, because
// the policy on the origin row is the policy every bridged copy inherits.
const tokenPolicyActivation = require('../token_policy_activation');
const { CHECKPOINT_VERSIONS: ANCHOR_CHECKPOINT_VERSIONS,
        ARCHIVE_CHUNK_SET_SQL, ARCHIVE_CHUNK_SET_BY_AUTHOR_SQL,
        ARCHIVE_ANCHOR_BY_CONTENT_SQL, selectArchiveHeadRow,
        dedupeArchiveChunks } = require('../anchor-action-query');
const { rethrowIfInfraFault } = require('../actions/faultGuard');
// The frozen anchor/archive reward heights: the derive flag-day and the fleet-agreed
// mirror-completeness watermark. Recovery-restored rewards claim their ORIGINAL derive
// height from here, so a restored row and a live-derived one carry the same stamp.
const ar = require('../anchor_reward_activation.js');
// The mirror-admission flag day, CONSUMER side (the time-keyed mirror barrier family): above
// it the mirrored selects bind rows by their signed admission height instead of by the clock.
const { isMirrorAdmissionConsumerActive } = require('../mirror_admission_activation.js');
// Module-level state and pure helpers that the split keeps in one place, so the class
// and every mixin read the same instance of each.
const { requireStakeWeight, normalizeStakeAmount, AUTO_DEDUP_TABLES, recordShapeDrift, txEpochStore, usesCapabilitySnapshot, opensBackslashEscape } = require('./shared.js');

class Database {

    constructor(host, port, dbName, user, pass, indexer) {
        this.config = indexer.config

        this.util   = indexer.util;

        // Reference back to the parent indexer (so dependent code can access hubDb, etc.)
        this.indexer = indexer;

        // Database connection information
        this.host   = host;
        this.port   = port;
        this.dbName = dbName;
        this.user   = user;
        this.pass   = pass;

        // Database connection parameters
        this.connectionParams = {
            host:     this.host,
            user:     this.user,
            password: this.pass,
            database: this.dbName,
            port:     this.port
        };

        // Database pool connection parameters
        this.connectionPoolParams = {
            host:     this.host,
            user:     this.user,
            password: this.pass,
            database: this.dbName,
            port:     this.port,
            // Connection options
            connectionLimit:      10,
            connectTimeout:       parseInt(process.env.DB_CONNECT_TIMEOUT) || 10000,
            acquireTimeout:       parseInt(process.env.DB_ACQUIRE_TIMEOUT) || 10000,
            idleTimeout:          60000,
            insertIdAsNumber:     true,
            // Return BIGINT columns as JS Numbers rather than BigInts. Without
            // this, any JSON-RPC handler returning a DB row crashes the process
            // on res.json() with `TypeError: Do not know how to serialize a
            // BigInt` (xchain-hub polls getlatestblock/getactivevalidators/
            // getownstake on a loop, so the crash window is always open).
            // Matches xchain-hub and xchain-sync; all indexer BIGINT columns
            // are within Number.MAX_SAFE_INTEGER for any realistic chain.
            bigIntAsNumber:       true,
            minDelayValidation:   3000,
            queryTimeout:         parseInt(process.env.DB_QUERY_TIMEOUT) || 30000
        };

        // Setup pool of connections
        this.pool = mariadb.createPool(this.connectionPoolParams);
        this.transactionConnection = null;

        // Block currently being processed. Set by the block loop (XChainIndexer) right
        // after beginTransaction so createAddress/createTicker can stamp the block at
        // which each index id is first assigned (index_addresses/index_tickers.block_index),
        // which rollback uses to delete and deterministically reassign ids on reorg.
        this.blockIndex = null;

        // Read-only guard for the rollback refresh phase. When true, createAddress /
        // createTicker resolve an existing id but NEVER insert a new one (they return
        // null for an unknown entity instead of assigning the next dense id). Rollback
        // sets it around updateBalances/updateTokens/updateMarkets/sanityCheck: those
        // helpers are fed entities collected from the orphaned range, and an entity that
        // existed ONLY in rolled-back blocks has just had its index id deleted. Creating
        // it again here would resurrect that id (a fresh-from-genesis node never had it,
        // so the id stays free there) and re-open the exact wire ^<id> fork the index-row
        // delete just closed. Default false: forward block processing is unaffected.
        this.suppressIndexIdCreation = false;

        // Optional genesis-only intern cache: address-string -> id, LOWER(tick) -> id, and
        // tx-hash -> id.
        // The genesis bootstrap (genesis.js) runs ~240k synthetic ISSUE/TRANSFER actions
        // through the normal pipeline, which re-resolves the same handful of ticks and the
        // constant GAS source dozens of times per action via getTickerId/getAddressId.
        // Those resolution SELECTs dominate genesis time (profiled ~50% of all DB work).
        // When this map is non-null, getTickerId/getAddressId serve non-null hits from
        // memory; the read paths (getTickerId, getAddressId) populate it lazily on a
        // non-null DB hit. create* methods do NOT call .set() directly. It is SAFE only
        // because genesis is one atomic
        // block and a rollback floor: ids are assigned, never deleted, during injection,
        // so a cached id can never go stale. genesis.inject() enables it for the passes and
        // clears it in a finally; normal block processing leaves it null (path unchanged).
        // Caret ^<id> references are never cached (they take a distinct resolution path).
        this._internCache = null;

        // Single-entry memo for getBlockTime(). block_time is constant for a given
        // block_index, but protocol_changes.isEnabled() re-queries it once per action-handler
        // call (several times per block). Last-block-wins keeps this bounded (a plain Map would
        // grow unbounded across a long-running process) while collapsing the per-action fan-out
        // to one decoder-DB lookup per block.
        this._blockTimeCache = { block_index: null, block_time: null };

        // Companion memo for getBlockTime(), which resolves PROTOCOL time and costs an
        // extra 11-row window read on top of the raw lookup. Same last-block-wins shape
        // and the same reorg invalidation (clearBlockTimeCache clears both).
        this._protocolTimeCache = { block_index: null, block_time: null };

        // Early-decide tally watermark. processVoteFinalizations step 2 re-tallies
        // every armed poll from full ledger/vote/delegation history on EVERY block, uncapped. A
        // non-time_weighted poll's tally is a pure function of {the tick's credits/debits, the
        // poll's votes, the tick's delegations, the (immutable) poll definition}; if none of
        // those gained a row since the last block we tallied the poll, the tally - and therefore
        // the early-decide decision - is byte-identical, and it already did NOT fire (else the
        // poll would be terminal and no longer armed). So we cache, per armed poll, a fingerprint
        // of its input tables' MAX(action_index); a matching fingerprint next block lets us skip
        // the full re-tally. Reorg-invalidated (clearPollTallyWatermark, wired into rollback.js)
        // because a reorg can delete/re-add ledger, vote, and delegation rows at or above the
        // reorg block and reuse action_index values, which would make a stale fingerprint match
        // spuriously. Empty on a fresh process, so the first sight of each poll always tallies.
        this._pollTallyWatermark = new Map();

        // Recovery reward apply-hook gate (F1a id-determinism fix). recovery.js stages
        // archived rewards in recovery_pending_rewards keyed by raw source-address STRING
        // (no index id assigned), and createAddress materializes them into validator_rewards
        // when the source address first gets its deterministic in-block id. This counter is
        // a one-time-probed remaining-unapplied count so normal indexing (no recovery in
        // progress) pays a single COUNT(*) and then short-circuits the hook entirely. The
        // rollback re-arm resets _recoveryPendingChecked to force a re-probe when staged rows
        // are re-armed. See recovery.js and _applyPendingRewardsForAddress below.
        this._recoveryPendingChecked   = false;
        this._recoveryPendingRemaining = 0;

        // Serializes DB transactions across the block-processing loop, the reorg rollback
        // path, and the read-only feequote dry-run (Actions.computeFeeQuoteDryRun). The
        // indexer's own paths are single-threaded and never contend, so the lock is always
        // free for them; it only matters when an API-path dry-run opens a forced-rollback
        // transaction that would otherwise collide with live block processing on the shared
        // transactionConnection. Simple non-reentrant async mutex: beginTransaction acquires,
        // commit/rollback release. Held only during active processing (barrier stalls happen
        // before beginTransaction), so it never blocks on a stalled indexer - but it IS held
        // for the whole of a block's processing, so a waiter behind a slow block waits that
        // long. Public read-only callers therefore bound the wait (, _acquireTxLock).
        this._txLock = { locked: false, queue: [] };

        // Watchdog-fence epoch (M-16). Monotonic counter identifying the current DB
        // transaction context. beginTransaction assigns a fresh epoch; every teardown
        // (commit or rollback) bumps it, so a write issued under a torn-down transaction
        // carries a stale epoch and is rejected by _assertTxNotFenced. See txEpochStore.
        this._txEpoch = 0;

        // Circuit breaker state for database connections
        this.circuitState     = 'closed';  // closed | open | half-open
        this.circuitFailures  = 0;         // consecutive connection failures
        this.circuitThreshold = 10;        // failures before opening circuit
        this.circuitCooldown  = 30000;     // 30s cooldown before half-open retry
        this.circuitOpenUntil = 0;         // timestamp when circuit can transition to half-open
    }

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
                console.error('Error checking if database ' + this.dbName + ' exists (attempt ' + attempt + '/' + Database.DB_CONNECT_MAX_ATTEMPTS + '):', e)
                await this.util.sleep(5000); // Wait 5 seconds
            }
        }
    }

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
        console.log("Creating " + this.dbName + " database!");
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
                console.error('Error creating database ' + this.dbName + ' (attempt ' + attempt + '/' + Database.DB_CONNECT_MAX_ATTEMPTS + '):', e)
                await this.util.sleep(5000); // Waiting 5 seconds
            }
        }
        return true;
    }

    // Handle verifying all database tables exist
    async verifyTables(){
        let dir   = path.join(__dirname, '..', 'sql');
        let files = fs.readdirSync(dir);
        let file  = null;
        let db    = await this.getConnection();
        // One summary line instead of a per-table pair; error paths below still
        // name the table, so a failure stays attributable.
        console.log('Verifying database and tables...');
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
        await db.release();
        console.log('Database and tables verified (' + checked + ' tables, ' + created + ' created).');
        console.log(this.schemaShapeSummary());
        return true;
    }

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
    }

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
    // operator-initiated path (`node src/migrate.js`). The whole run holds a DB-scoped
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
        const result = await this._runMigrationsInner(opts);
        await this._assertPubkeyColumnIsUncompressedWide();
        await this._assertStakeWeightOrderingCollation();
        // Invoked through the prototype rather than `this`: the reward-identity assertion is
        // a fail-closed COLLECT-rail guard, and a partial object that happens not to carry
        // the method would otherwise drop it without a word. Nothing may opt out of it.
        await Database.prototype._assertRewardUniqueKeyCarriesQualifier.call(this);
        // Same fail-closed rule as the reward assertion above: invoked through the prototype
        // so a partial object cannot silently drop the bridge-table check.
        await Database.prototype._assertBridgeTablesPresent.call(this);
        return result;
    }

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
    // drift. Same convention as _assertPubkeyColumnIsUncompressedWide above.
    async _assertStakeWeightOrderingCollation(){
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
    }

    async _runMigrationsInner(opts = {}){
        const crypto        = require('crypto');
        const includeManual = !!opts.includeManual;
        const only          = (opts.only == null) ? null
            : new Set([].concat(opts.only).map(s => String(s).trim()).filter(Boolean));
        const dir           = path.join(__dirname, '..', 'sql', 'migrations');
        const result        = { applied: [], pending: [], baselined: [], lockSkipped: false };

        let files = [];
        try { files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort(); }
        catch(e){ return result; }   // no migrations dir → nothing to do
        if(!files.length) return result;

        // Targeted rollout: a name that matches no committed migration is almost
        // always a typo. Fail loudly (silently applying nothing would look like a
        // successful no-op run) and list what IS available.
        if(only){
            if(only.size === 0)
                throw new Error('runMigrations: opts.only was provided but empty; pass at least one migration filename.');
            const known   = new Set(files);
            const unknown = [...only].filter(n => !known.has(n));
            if(unknown.length)
                throw new Error('runMigrations: --file target(s) not found in ' + dir + ': ' + unknown.join(', ') +
                    '. Available: ' + files.join(', '));
        }

        const lockName = 'xchain_migrate_' + this.dbName;
        let conn = await this.getConnection();
        try {
            // DB-scoped advisory lock so two processes don't apply concurrently. GET_LOCK
            // is server-global, so the name is namespaced by dbName (the shared MariaDB on
            // a combined box hosts many indexer DBs).
            const got = await conn.query('SELECT GET_LOCK(?, 30) AS l', [lockName]);
            if(!got || !got[0] || String(got[0].l) !== '1'){
                console.warn('runMigrations: could not acquire lock ' + lockName + ' (another process is migrating). Skipping this run.');
                // #3162: flag the skip so callers do NOT read the empty applied/pending shape as
                // a completed run. The operator CLI must not print "done" and exit 0 when nothing
                // was even examined - the schema may still be un-migrated.
                result.lockSkipped = true;
                return result;
            }
            try {
                await this._ensureMigrationsLedger(conn);
                const appliedRows   = await conn.query('SELECT name, checksum FROM schema_migrations');
                const appliedByName = new Map(appliedRows.map(r => [r.name, r.checksum]));

                // One-time ledger rename heal: three legacy files were renamed from
                // undated to dated names. The ledger is keyed by filename, so an
                // already-migrated DB still records them under the old names. Re-key
                // those rows to the new names (durably, in place) before the comparison
                // below, so the renamed files register as applied instead of re-running.
                for(const { from, to } of Database.planLedgerRenames(appliedByName.keys())){
                    await conn.query('UPDATE schema_migrations SET name = ? WHERE name = ?', [to, from]);
                    appliedByName.set(to, appliedByName.get(from));
                    appliedByName.delete(from);
                    console.log('runMigrations: re-keyed ledger row ' + from + ' -> ' + to + ' (legacy migration renamed to dated form).');
                }

                for(const file of files){
                    // Scoped run (--file): touch ONLY the targeted file(s). Report an
                    // untargeted-but-unapplied file as pending so the operator still sees
                    // remaining work, then leave it entirely alone: no dated-prefix check,
                    // no checksum guard, no apply. A per-file rollout must never be blocked
                    // by an unrelated migration's state elsewhere in the tree (#3874).
                    if(only && !only.has(file)){
                        if(!appliedByName.has(file)) result.pending.push(file);
                        continue;
                    }
                    // Freeze the dated-prefix convention in code: apply order is lexical
                    // (readdirSync().sort()), so every migration filename must start with a
                    // YYYY-MM-DD- prefix to apply in authorship order. The three legacy
                    // undated files were renamed to dated form, so no exemption remains.
                    if(!/^\d{4}-\d{2}-\d{2}-/.test(file)){
                        throw new Error('runMigrations: migration "' + file + '" is not dated. Every migration ' +
                            'filename must start with a YYYY-MM-DD- prefix so it applies in authorship order ' +
                            '(apply order is lexical). Rename it with the authored date.');
                    }
                    const raw      = fs.readFileSync(path.join(dir, file), 'utf8');
                    const checksum = crypto.createHash('sha256').update(raw).digest('hex');

                    if(appliedByName.has(file)){
                        if(appliedByName.get(file) !== checksum){
                            // Deliberate one-off rebaselines: an applied file whose only change
                            // was a reviewed non-executable edit (e.g. a mode retag) may be
                            // rebaselined here so fleets that recorded the old checksum heal
                            // in place instead of failing every operator migrate run forever.
                            // Both hashes are pinned, so any OTHER edit still trips the guard.
                            // `from` may be a single hash or a list: the same reviewed edit
                            // can supersede several historical file revisions, and each DB
                            // recorded whichever revision it applied first. Normalize to a
                            // list so every recorded predecessor heals to the current hash.
                            const rebase   = Database.MIGRATION_CHECKSUM_REBASELINES[file];
                            const fromList = rebase ? [].concat(rebase.from) : [];
                            if(rebase && fromList.includes(appliedByName.get(file)) && checksum === rebase.to){
                                await conn.query('UPDATE schema_migrations SET checksum = ? WHERE name = ?', [checksum, file]);
                                console.log('runMigrations: rebaselined checksum for ' + file + ' (reviewed retag, executable SQL unchanged).');
                                continue;
                            }
                            // Migrations are immutable once applied. A changed checksum means
                            // someone edited an applied file, so the DB is now on a schema that
                            // diverges from what the committed file describes.
                            const msg = 'runMigrations: ' + file + ' was already applied but its content CHANGED (checksum mismatch: recorded ' +
                                appliedByName.get(file) + ', current ' + checksum + '). Migrations are immutable once applied.';
                            // Operator path (`node src/migrate.js`, includeManual) and opt-in strict
                            // mode fail closed so a diverged schema is caught in CI / by an operator
                            // instead of silently continuing. Default auto-startup stays non-fatal
                            // (console.error, not warn) to avoid a surprise fleet-wide boot failure.
                            if(includeManual || process.env.MIGRATION_STRICT_CHECKSUM === '1'){
                                // Tailor the remedy to which branch actually fired. The operator path
                                // (includeManual, `node src/migrate.js`) ALWAYS fails closed by design, so
                                // MIGRATION_STRICT_CHECKSUM has no effect there - telling the operator to
                                // clear it just loops them back to the same error. Only the passive
                                // startup path opted into strict mode via MIGRATION_STRICT_CHECKSUM=1 can
                                // actually be downgraded by clearing it.
                                const hint = includeManual
                                    ? ' This operator run always fails closed (MIGRATION_STRICT_CHECKSUM has no' +
                                      ' effect here). Either revert ' + file + ' to the content matching the' +
                                      ' recorded checksum, or - if the edit was reviewed and changed no' +
                                      ' executable SQL - add a pinned Database.MIGRATION_CHECKSUM_REBASELINES' +
                                      ' entry mapping the recorded hash to the current one.'
                                    : ' Review manually (set MIGRATION_STRICT_CHECKSUM=0 / omit to downgrade to a non-fatal log).';
                                throw new Error(msg + hint);
                            }
                            console.error(msg + ' Continuing on the diverged schema - review manually.');
                        }
                        continue;
                    }

                    const mode = this._migrationMode(raw);

                    // Precondition gate: a migration listed in MIGRATION_PRECONDITIONS is
                    // applicable only to a schema in a particular shape, and running it on
                    // any other shape destroys data rather than converting it. Evaluate the
                    // predicate against the LIVE schema and, when it says the migration does
                    // not apply, record it as applied WITHOUT executing a statement.
                    //
                    // Baselining rather than merely skipping is what makes it stick: a skip
                    // leaves the file pending forever, so every later blanket run re-enters
                    // this branch and one runner change or one direct-SQL apply puts the
                    // hazard back. The ledger row states what is already true - the end
                    // state this migration exists to produce holds on this database.
                    //
                    // It runs BEFORE the mode gate deliberately, so an unattended startup
                    // baselines a pending manual migration and the hazard is gone before an
                    // operator ever reaches for `npm run migrate`.
                    const preconditionSkip = await this._migrationPreconditionSkip(file, conn);
                    if(preconditionSkip){
                        await conn.query(
                            'INSERT INTO schema_migrations (name, checksum, mode, applied_at) VALUES (?, ?, ?, NOW())',
                            [file, checksum, mode]
                        );
                        result.baselined.push(file);
                        console.log('runMigrations: BASELINED ' + file + ' (recorded as applied, no statement run): ' + preconditionSkip);
                        continue;
                    }

                    if(mode !== 'auto' && !includeManual){
                        console.log('runMigrations: PENDING (gated, mode=' + mode + '): ' + file + ' - apply with `node src/migrate.js`.');
                        result.pending.push(file);
                        continue;
                    }

                    // Backdating guard: the dated-prefix check above freezes the NAMING
                    // convention, but nothing stopped a new file from being dated before a
                    // migration the fleet already applied. Lexical apply order then puts it
                    // in its date slot on a fresh DB and after the frontier on an aged one,
                    // diverging the two schemas. `frontier` is the ledger state at run start
                    // (appliedByName is not written during the loop), so files applied by
                    // THIS run never advance it and a long-offline node catching up is fine.
                    // Auto files only - see Database.backdatedFrontierViolation for why a
                    // deferred mode=manual file cannot be told apart from a backdated one.
                    if(mode === 'auto'){
                        const frontier = Database.backdatedFrontierViolation(file, appliedByName.keys());
                        if(frontier){
                            const msg = 'runMigrations: ' + file + ' is dated BEFORE already-applied migration ' + frontier +
                                ', so it would run in a different position here than on a fresh database and diverge the schema. ' +
                                'Rename it with a date after ' + frontier + '.';
                            // Same dual-mode contract as the checksum guard above: the operator
                            // path and opt-in strict mode fail closed, passive startup logs and
                            // proceeds so a backdated commit cannot black-start the fleet.
                            if(includeManual || process.env.MIGRATION_STRICT_CHECKSUM === '1') throw new Error(msg);
                            console.error(msg + ' Applying it anyway at this position - review manually.');
                        }
                    }

                    // Quote-aware split into statements: strips `--` line comments and
                    // breaks on ';' only outside quoted strings, so a ';' in a comment
                    // header or inside a string literal never terminates a statement, and
                    // _destructiveAutoStatement classifies real statements not fragments.
                    const statements = this.splitSqlStatements(raw);
                    // Destructive-DDL guard: the mode tag is a human declaration; this scan is
                    // the machine check behind it. A file tagged `auto` that contains DDL able
                    // to lose or rename data must NEVER run unattended at startup (nor slip
                    // through migrate.js under the wrong tag) - block startup with an
                    // actionable error instead of executing it against every validator's DB.
                    if(mode === 'auto'){
                        const offender = this._destructiveAutoStatement(statements);
                        if(offender){
                            throw new Error('runMigrations: ' + file + ' is tagged mode=auto but contains destructive DDL: "' +
                                offender.slice(0, 160) + (offender.length > 160 ? '...' : '') + '". ' +
                                'Re-tag the file `-- xchain:migration mode=manual` and apply it deliberately via `node src/migrate.js`.');
                        }
                    }
                    console.log('runMigrations: applying ' + file + ' (mode=' + mode + ', ' + statements.length + ' statement(s))...');
                    try {
                        for(const stmt of statements){ await conn.query(stmt); }
                    } catch(err){
                        // Schema is now in an unknown state - block startup rather than run on.
                        console.error('runMigrations: FAILED applying ' + file + ': ' + (err && err.message));
                        throw err;
                    }
                    await conn.query(
                        'INSERT INTO schema_migrations (name, checksum, mode, applied_at) VALUES (?, ?, ?, NOW())',
                        [file, checksum, mode]
                    );
                    result.applied.push(file);
                    console.log('runMigrations: applied ' + file);
                }
            } finally {
                try { await conn.query('SELECT RELEASE_LOCK(?)', [lockName]); } catch(_){}
            }
        } finally {
            try { await conn.release(); } catch(_){}
        }

        if(result.applied.length) console.log('runMigrations: ' + result.applied.length + ' migration(s) applied to ' + this.dbName + '.');
        if(result.pending.length) console.log('runMigrations: ' + result.pending.length + ' manual migration(s) pending for ' + this.dbName + ' - run `node src/migrate.js` to apply.');
        return result;
    }

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
    async _assertPubkeyColumnIsUncompressedWide(){
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
                // Name the exact file. The old text said only "node src/migrate.js", which
                // on an aged fleet DB means "apply every pending manual migration" - nine of
                // them on mainnet in August 2026, one a DROP COLUMN - so the operator either
                // ran far more than the halt required or had to work out which file it meant
                // while three chains were down.
                throw new Error(
                    'pubkeys.pubkey holds ' + len + ' chars but VARCHAR(' + UNCOMPRESSED_PUBKEY_HEX_LENGTH + ') is required ' +
                    'for uncompressed keys; narrower silently NULLs or truncates the source_pubkey seam field. ' +
                    'Run the pending migration: node src/migrate.js --file ' +
                    Database.startupAssertedMigrationFile('_assertPubkeyColumnIsUncompressedWide')
                );
            }
        } finally {
            if(conn && this.transactionConnection == null){
                try { await conn.release(); } catch(_){}
            }
        }
    }

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
    async _assertRewardUniqueKeyCarriesQualifier(){
        // Name the exact file in every halt, for the same reason the pubkey halt above
        // does: a bare `node src/migrate.js` on an aged fleet database means "apply every
        // pending manual migration", which is never what a scoped recovery wants.
        const remedy = ' Run the pending migration: node src/migrate.js --file ' +
            Database.startupAssertedMigrationFile('_assertRewardUniqueKeyCarriesQualifier');
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
    }

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
    async _assertBridgeTablesPresent(){
        const REQUIRED = ['bridge_transfers', 'bridge_settlements', 'policy_snapshots'];
        // Name the exact file in the halt: a bare `node src/migrate.js` on an aged fleet
        // database means "apply every pending manual migration", which is never what a
        // scoped recovery wants.
        const remedy = ' Run the pending migration: node src/migrate.js --file ' +
            Database.startupAssertedMigrationFile('_assertBridgeTablesPresent');
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
    }

    // Read a migration file's `-- xchain:migration mode=auto|manual` header tag.
    // Defaults to 'manual' when absent (conservative - unknown DDL never auto-runs).
    _migrationMode(raw){
        // The mode tag is a leading-prologue directive: it may only sit in the run of
        // blank and `--`-comment lines BEFORE the first SQL statement. Scanning the
        // whole file (the old /m behavior) let a `mode=auto` token buried in body prose
        // or a data literal silently arm auto-apply for a destructive migration. A fixed
        // first-N-lines window (the old slice(0,10)) fixed that but was too tight: the
        // standard multi-line license banner pushes the tag past line 10, so every
        // banner-prefixed `mode=auto` migration was silently read as the `manual`
        // default and never auto-applied. Anchoring to the comment prologue keeps the
        // body-buried protection (the scan stops at the first non-comment, non-blank
        // line, so no data literal or trailing prose can be seen) while accommodating
        // any length of leading comment banner. Kept byte-for-byte in step with the
        // sibling runner at xchain-decoder/src/db.js:_migrationMode.
        const lines    = String(raw).split('\n');
        const prologue = [];
        for(const line of lines){
            const trimmed = line.trim();
            if(trimmed === '' || trimmed.startsWith('--')){ prologue.push(line); continue; }
            break;   // first non-blank, non-comment line ends the prologue
        }
        const m = prologue.join('\n').match(/^\s*--\s*xchain:migration\b[^\n]*\bmode\s*=\s*(auto|manual)\b/im);
        return m ? m[1].toLowerCase() : 'manual';
    }

    // Destructive-DDL scan for the auto-apply path. Given a migration file's
    // statement list (already line-comment-stripped and ';'-split), returns the
    // first statement that can lose, truncate, or rename data - or null when the
    // file is safe to auto-run. Pure string logic (no DB), unit-tested directly.
    //
    // Flagged as destructive: DROP TABLE/DATABASE/SCHEMA, TRUNCATE, RENAME TABLE,
    // DELETE (any form), REPLACE INTO (atomic DELETE+INSERT), INSERT ... ON DUPLICATE
    // KEY UPDATE (rewrites every colliding row), LOAD DATA (rows from a file the
    // scanner cannot read), UPDATE (except the
    // committed AUTO_INCREMENT id=0 repair), ALTER TABLE ... DROP <column|partition|bare identifier>,
    // ALTER TABLE ... RENAME (except RENAME INDEX/KEY), ALTER TABLE ... CHANGE
    // (rename+retype), MODIFY ... NOT NULL (the statically detectable
    // narrowing; a width reduction cannot be seen without the live schema and
    // stays covered by the manual-tag convention), and any ALTER TABLE PARTITION or
    // TABLESPACE clause.
    //
    // Deliberately NOT flagged (legitimate existing auto patterns): DROP INDEX/KEY,
    // DROP FOREIGN KEY/CONSTRAINT/CHECK/DEFAULT/PRIMARY KEY (structural, no row
    // data lost), ADD ..., plain CREATE TABLE / CREATE TABLE IF NOT EXISTS (additive;
    // but CREATE OR REPLACE TABLE IS flagged - it is an atomic DROP+CREATE), and
    // MODIFY that widens/nullables a column.
    _destructiveAutoStatement(statements){
        // Drops that remove metadata only; anything else after DROP inside an
        // ALTER (COLUMN, PARTITION, or a bare column identifier) loses data.
        const SAFE_ALTER_DROP = new Set(['INDEX', 'KEY', 'FOREIGN', 'CONSTRAINT', 'CHECK', 'DEFAULT', 'PRIMARY']);
        // True when a `#` sits outside every quoted span - a line comment
        // stripSqlLineComments should already have removed. Quote-aware so a `#`
        // inside a string literal or a backtick identifier is not mistaken for one.
        // Local rather than a method: runMigrations' callers build partial `this`
        // objects, and a second prototype hop would break the guard on those.
        const hasUnquotedHash = (s) => {
            let q = null;
            for(let i = 0; i < s.length; i++){
                const c = s[i];
                if(q){
                    if(opensBackslashEscape(s, i, q)){ i++; continue; }
                    if(c === q){
                        if(s[i + 1] === q){ i++; }
                        else { q = null; }
                    }
                    continue;
                }
                if(c === "'" || c === '"' || c === '`'){ q = c; continue; }
                if(c === '#') return true;
            }
            return false;
        };
        for(const raw of (statements || [])){
            // Executable (versioned) comments are the one /* */ form the server RUNS:
            // MariaDB/MySQL execute `/*!50000 DROP TABLE balances */` and `/*M! ... */`
            // verbatim, and splitSqlStatements strips only `--` lines, so the payload
            // reaches conn.query intact. The block-comment strip below would delete it
            // before any keyword check, scoring the file safe and auto-running the DROP.
            // Same class as the PREPARE/EXECUTE/CALL forms below - the server does
            // something a prefix classifier cannot see - and no committed auto migration
            // uses one, so treat any statement carrying one as non-auto-eligible.
            if(/\/\*(?:!|M!)/i.test(String(raw)))                return raw;
            // Belt-and-braces: strip /* */ block comments (line comments are already
            // gone) so a keyword inside comment prose never triggers or hides a hit.
            const stmt = String(raw).replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
            if(!stmt) continue;
            // Second layer behind stripSqlLineComments: MariaDB/MySQL honour `#` to
            // end-of-line as a comment, so `# note\nDROP TABLE balances` is a DROP every
            // ^-anchored check below is blind to. The strip removes it upstream; if one
            // ever reaches here the strip has regressed, and the only safe reading of a
            // comment introducer the classifier can still see is non-auto-eligible.
            if(hasUnquotedHash(stmt))                            return raw;
            // Server-side indirection escapes a statement-prefix classifier: a mode=auto
            // file can smuggle destructive SQL past every keyword check below via dynamic
            // SQL (`SET @s = 'DROP TABLE balances'; PREPARE stmt FROM @s; EXECUTE stmt;`)
            // or a `CALL proc()` whose body the scanner cannot see. None of these are used
            // by any committed auto migration, so treat them as non-auto-eligible. SET of a
            // user variable (`SET @s = ...`) exists to stage dynamic SQL for PREPARE, so
            // flag it too - but NOT system-variable SETs (`SET NAMES ...`, `SET sql_mode
            // = ...`, `SET @@session...`), which are benign and stay auto-eligible.
            if(/^PREPARE\b/i.test(stmt))                         return raw;
            if(/^EXECUTE\b/i.test(stmt))                         return raw;
            if(/^CALL\b/i.test(stmt))                            return raw;
            if(/^SET\s+@(?!@)/i.test(stmt))                      return raw;
            if(/^DROP\s+(TABLE|DATABASE|SCHEMA)\b/i.test(stmt))  return raw;
            // CREATE OR REPLACE TABLE is an atomic DROP TABLE IF EXISTS + CREATE: it destroys
            // every existing row. Plain CREATE TABLE / CREATE TABLE IF NOT EXISTS are additive
            // and stay unflagged (see the CREATE note below); only the OR REPLACE form loses
            // data. DROP TABLE is already flagged, so an author must not be able to slip the
            // data-losing idempotent-create variant past the auto guard.
            if(/^CREATE\s+OR\s+REPLACE\s+(TEMPORARY\s+)?TABLE\b/i.test(stmt)) return raw;
            if(/^TRUNCATE\b/i.test(stmt))                        return raw;
            if(/^RENAME\s+TABLE\b/i.test(stmt))                  return raw;
            // Any DELETE removes row data - there is no non-destructive form - so match the
            // bare keyword, not `DELETE FROM`. The narrower form let valid-but-non-canonical
            // syntax slip the auto guard: `DELETE LOW_PRIORITY FROM`, `DELETE IGNORE FROM`,
            // and multi-table `DELETE t1 FROM t1 JOIN t2 ...` all delete rows yet omit an
            // immediate FROM. No false positive: a statement starting with DELETE is always DML.
            if(/^DELETE\b/i.test(stmt))                          return raw;
            // REPLACE INTO is an atomic DELETE+INSERT on every existing-key row it
            // touches - the same data-loss profile as DELETE, with no non-destructive
            // form - so match the bare keyword like DELETE above.
            if(/^REPLACE\b/i.test(stmt))                         return raw;
            // INSERT ... ON DUPLICATE KEY UPDATE overwrites columns of every existing
            // duplicate-key row it touches - the same data-rewrite profile the UPDATE arm
            // below hard-blocks, reached from a keyword that arm never sees. Plain INSERT
            // stays auto-eligible: with no ON DUPLICATE clause it only adds rows.
            if(/^INSERT\b[\s\S]*\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/i.test(stmt)) return raw;
            // LOAD DATA ... REPLACE INTO TABLE is a DELETE+INSERT on every key collision,
            // and the rows come from a file the classifier cannot read, so no form of it
            // can be judged safe from the statement text. No committed auto migration
            // loads a file; treat the whole form as non-auto-eligible.
            if(/^LOAD\s+DATA\b/i.test(stmt))                     return raw;
            // A bare UPDATE can rewrite arbitrary row data. The one committed auto
            // pattern is the AUTO_INCREMENT id repair (`UPDATE <table> SET id = (...)
            // WHERE id = 0;` in 2026-06-10-mirror-id-autoincrement-repair.sql), which
            // touches only the sentinel id=0 row; carve exactly that shape out and
            // flag every other UPDATE.
            if(/^UPDATE\b/i.test(stmt) && !this._isIdRepairUpdate(stmt)) return raw;
            if(/^ALTER\s+TABLE\b/i.test(stmt)){
                // Partition and tablespace clauses move or discard row data while carrying
                // none of the keywords the checks below look for: TRUNCATE PARTITION empties
                // a partition, EXCHANGE PARTITION swaps its rows out to another table,
                // DISCARD TABLESPACE deletes the table's data file. The additive members of
                // the class (ADD PARTITION, IMPORT TABLESPACE) are not separable from the
                // destructive ones by prefix, and no committed migration partitions anything,
                // so the whole class is non-auto-eligible - re-tag mode=manual to run one.
                if(/\bPARTITION(?:ING)?\b/i.test(stmt))          return raw;
                if(/\bTABLESPACE\b/i.test(stmt))                 return raw;
                // Every DROP inside the ALTER must target a safe (metadata-only) object.
                let m;
                const dropRe = /\bDROP\s+([A-Za-z_]+|`[^`]+`)/gi;
                while((m = dropRe.exec(stmt)) !== null){
                    const target = m[1].replace(/`/g, '').toUpperCase();
                    if(!SAFE_ALTER_DROP.has(target)) return raw;
                }
                // RENAME TO / RENAME COLUMN / bare RENAME lose the old name; only
                // RENAME INDEX/KEY is a metadata-only rename.
                if(/\bRENAME\b(?!\s+(INDEX|KEY)\b)/i.test(stmt)) return raw;
                // CHANGE [COLUMN] renames and retypes in one clause - manual only.
                if(/\bCHANGE\b/i.test(stmt))                     return raw;
                // MODIFY that adds NOT NULL narrows the column domain - except an
                // AUTO_INCREMENT attribute repair: an AUTO_INCREMENT column is
                // definitionally NOT NULL, so no domain is narrowed (see the
                // committed 2026-06-10-mirror-id-autoincrement-repair.sql pattern).
                // Check per top-level clause: a statement-wide AUTO_INCREMENT test
                // would let one AUTO_INCREMENT clause exempt a sibling NOT NULL clause
                // in the same multi-clause ALTER (e.g. `MODIFY id ... AUTO_INCREMENT,
                // MODIFY source VARCHAR(255) NOT NULL`).
                let mDepth = 0, mStart = 0;
                const mClauses = [];
                for(let i=0;i<stmt.length;i++){
                    const ch = stmt[i];
                    if(ch === '(') mDepth++;
                    else if(ch === ')') mDepth--;
                    else if(ch === ',' && mDepth === 0){ mClauses.push(stmt.slice(mStart, i)); mStart = i + 1; }
                }
                mClauses.push(stmt.slice(mStart));
                for(const clause of mClauses){
                    if(/\bMODIFY\b[\s\S]*\bNOT\s+NULL\b/i.test(clause) &&
                       !/\bAUTO_INCREMENT\b/i.test(clause))      return raw;
                }
            }
        }
        return null;
    }

    // True only for the one committed auto UPDATE shape: the AUTO_INCREMENT id
    // repair `UPDATE <table> SET id = (<subquery>) WHERE id = 0`. The old carve-out
    // regex was unanchored (`0\b`, no `$`) and used a greedy paren-unaware
    // `\([\s\S]+\)`, so `... WHERE id = 0 OR 1=1` and a smuggled second assignment
    // `SET id = (...), amount = (...)` both slipped past the guard and rewrote every
    // row. This matches the shape structurally instead: (1) a single table then
    // `SET id = (`; (2) a balanced-paren, quote-aware walk finds the value's true
    // matching `)`, so no extra assignment or clause can ride inside the wildcard;
    // (3) the remainder must be exactly `WHERE id = 0`, end-anchored, so nothing
    // trails. The 2026-06-10-mirror-id-autoincrement-repair.sql migration uses a
    // NESTED subquery with commas, so a "no inner parens / no commas" rule would
    // wrongly reject it and hard-fail startup; the balanced scan is required.
    _isIdRepairUpdate(stmt){
        const head = /^UPDATE\s+(?:`[^`]+`|[A-Za-z0-9_$.]+)\s+SET\s+id\s*=\s*\(/i.exec(stmt);
        if(!head) return false;
        let i = head[0].length - 1;              // index of the opening '('
        let depth = 0;
        let quote = null;
        for(; i < stmt.length; i++){
            const ch = stmt[i];
            if(quote){
                if(opensBackslashEscape(stmt, i, quote)){ i++; continue; }
                if(ch === quote){
                    if(stmt[i + 1] === quote){ i++; }    // doubled-quote escape
                    else { quote = null; }
                }
                continue;
            }
            if(ch === "'" || ch === '"' || ch === '`'){ quote = ch; continue; }
            if(ch === '('){ depth++; }
            else if(ch === ')'){ depth--; if(depth === 0){ i++; break; } }
        }
        if(depth !== 0) return false;            // unbalanced parens: not the repair shape
        return /^\s*WHERE\s+id\s*=\s*0\s*;?\s*$/i.test(stmt.slice(i));
    }

    // Create the migration ledger if absent. Created directly (not via src/sql/) - it
    // is infrastructure, not a domain table, so verifyTables() doesn't manage it.
    async _ensureMigrationsLedger(conn){
        await conn.query(
            'CREATE TABLE IF NOT EXISTS schema_migrations (' +
            "name VARCHAR(255) NOT NULL PRIMARY KEY, " +
            "checksum VARCHAR(64) NOT NULL, " +
            "mode VARCHAR(10) NOT NULL DEFAULT 'manual', " +
            'applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP' +
            ') ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci'
        );
    }

    // Evaluate a migration's declared precondition against the live schema. Returns a
    // human reason string when the migration does NOT apply to this database (the caller
    // baselines it), or null when it should run. Files with no entry always run.
    // Runs on the caller's migration connection so it stays inside the migration lock.
    async _migrationPreconditionSkip(file, conn){
        const pre = Database.MIGRATION_PRECONDITIONS[file];
        if(!pre) return null;
        const rows = await conn.query(pre.sql, [this.dbName]);
        return pre.skipWhen(rows || []);
    }

    // Parse a CREATE TABLE statement to extract expected column nullability.
    // Conservative - only used for drift detection, not for full schema mgmt.
    // Returns array of {name, nullable} or null when parsing can't recognize
    // the file (e.g. a non-CREATE-TABLE definition).
    parseExpectedColumns(sqlData){
        // Strip `--` line comments BEFORE any structural parsing. Inline comments
        // routinely contain commas and parens (e.g. `-- 0=request, 1=response
        // (matches ...)`) that otherwise fool the top-level-comma split below into
        // emitting phantom columns and triggering bogus ADD COLUMN drift fixes.
        sqlData = this.stripSqlLineComments(sqlData);
        // `IF NOT EXISTS` is optional: the src/sql/<table>.sql definitions omit it, but a
        // dated migration that CREATEs a whole new table always carries it (idempotent
        // replay), and the schema-parity guard runs this same parser over those migrations
        // so a migration-created table is checked against its definition instead of being
        // parked in the pre-ledger baseline (#3164).
        const m = sqlData.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?\S+\s*\(([\s\S]+?)\)\s*ENGINE/i);
        if(!m) return null;
        // Split on top-level commas (i.e. commas not inside type parens like VARCHAR(250))
        const parts = m[1].split(/,(?![^()]*\))/g);
        const cols = [];
        for(let raw of parts){
            // Strip trailing `-- comment` text
            let line = raw.replace(/--[^\n\r]*/g, '').trim();
            if(!line) continue;
            // Skip constraint/index/key lines - column definitions only
            if(/^(PRIMARY|UNIQUE|INDEX|KEY|CHECK|CONSTRAINT|FOREIGN)\b/i.test(line)) continue;
            const tokens = line.split(/\s+/);
            if(tokens.length < 2) continue;
            const name = tokens[0].replace(/`/g, '');
            // SQL columns are NULL unless explicitly NOT NULL. Column-level
            // PRIMARY KEY and AUTO_INCREMENT both IMPLY NOT NULL (SQL semantics)
            // - without this, a source line like `id BIGINT AUTO_INCREMENT
            // PRIMARY KEY` reads as "nullable", the reconciler "relaxes" the
            // live NOT NULL with a bare `MODIFY <type> NULL`, and that MODIFY
            // silently STRIPS the AUTO_INCREMENT attribute on every startup
            // (live-diagnosed 2026-06-10: capability_snapshots / price_snapshots /
            // cross_chain_matches / state_checkpoints id cursors lost
            // AUTO_INCREMENT, so id-omitting INSERT IGNORE writers collided on
            // id=0 and were silently swallowed).
            const nullable = !/\bNOT\s+NULL\b/i.test(line) &&
                             !/\bPRIMARY\s+KEY\b/i.test(line) &&
                             !/\bAUTO_INCREMENT\b/i.test(line);
            // Keep the full (comment-stripped) column definition so a missing
            // column can be re-added verbatim - this preserves the DEFAULT
            // clause, which is what backfills existing rows on NOT NULL columns.
            const notNull    = !nullable;
            const hasDefault = /\bDEFAULT\b/i.test(line);
            cols.push({ name, nullable, definition: line, notNull, hasDefault });
        }
        return cols.length > 0 ? cols : null;
    }

    // Parse the index declarations that live INSIDE the CREATE TABLE block: inline
    // `PRIMARY KEY (...)` / `KEY` / `UNIQUE KEY` / `FULLTEXT KEY` clauses, plus the
    // column-level `PRIMARY KEY` and `UNIQUE` attributes the engine turns into an index
    // of its own. parseExpectedIndexes deliberately ignores all of these (they are
    // created WITH the table, so there is nothing for the reconciler to re-add), but the
    // undeclared-index detector below needs them: without them every inline KEY on every
    // table would read as an orphan and the warning would be pure noise.
    //
    // Returns [{ name, columns:[...] }] with `name` null for an unnamed inline key (the
    // engine derives its live name from the first column, so the detector falls back to
    // matching such a key by column set).
    parseInlineIndexes(sqlData, table){
        sqlData = this.stripSqlLineComments(sqlData);
        const m = sqlData.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?\S+\s*\(([\s\S]+?)\)\s*ENGINE/i);
        if(!m) return [];
        const cols = (list) => String(list).split(',')
            .map(c => c.trim().replace(/`/g, '').split(/\s+/)[0].replace(/\(\d+\)$/, ''))
            .filter(Boolean);
        const out = [];
        // Same top-level-comma split parseExpectedColumns uses, so a type's own parens
        // (VARCHAR(250), DECIMAL(30,8)) do not shred a declaration into fragments.
        for(let raw of m[1].split(/,(?![^()]*\))/g)){
            const line = raw.replace(/--[^\n\r]*/g, '').trim();
            if(!line) continue;
            let k;
            if((k = /^PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(line))){
                out.push({ name: 'PRIMARY', columns: cols(k[1]) });
            } else if((k = /^(?:UNIQUE|FULLTEXT|SPATIAL)?\s*(?:KEY|INDEX)\s+`?(\w+)`?\s*\(([^)]*)\)/i.exec(line))){
                out.push({ name: k[1], columns: cols(k[2]) });
            } else if((k = /^(?:UNIQUE|FULLTEXT|SPATIAL)?\s*(?:KEY|INDEX)\s*\(([^)]*)\)/i.exec(line))){
                out.push({ name: null, columns: cols(k[1]) });
            } else if(/^(?:CHECK|CONSTRAINT|FOREIGN)\b/i.test(line)){
                continue;
            } else {
                // A column definition. Column-level PRIMARY KEY / UNIQUE each create an
                // index the CREATE TABLE never names as a key line.
                const name = line.split(/\s+/)[0].replace(/`/g, '');
                if(!name) continue;
                if(/\bPRIMARY\s+KEY\b/i.test(line)) out.push({ name: 'PRIMARY',  columns: [name] });
                else if(/\bUNIQUE\b/i.test(line))   out.push({ name: name,       columns: [name] });
            }
        }
        return out;
    }

    // Live columns that NO SQL source declares - the other half of drift detection.
    //
    // alterTableForDrift converges the source onto the DB (adds what is declared and
    // missing) but has never looked the other way, so a column that exists only live is
    // invisible on every startup: a retired column whose declaration was deleted, a
    // mirror twin from a superseded wire, or one an operator added by hand. DOGE regtest
    // carried 8 such signed mirror-twin columns plus a pre-fence checkpoint key - a shape
    // no other DB in the fleet had - and nothing reported it until a manual migration
    // backlog converged it by hand.
    //
    // Detection only, never a DROP: dropping a column we did not create destroys data
    // unattended, and this is the same never-DROP posture reconcileTableIndexes already
    // takes on its name-collision branch. Returns the live column names, in live order.
    undeclaredLiveColumns(expected, live){
        const declared = new Set((expected || []).map(c => String(c.name).toLowerCase()));
        return (live || []).map(c => c.COLUMN_NAME).filter(n => !declared.has(String(n).toLowerCase()));
    }

    // Live indexes that NO SQL source declares - the index half of the same gap. An index
    // counts as declared when either its NAME or its ordered COLUMN SET appears in the
    // definition (standalone CREATE INDEX or an inline key), because both forms are
    // legitimate and a renamed-but-equivalent index is the shape the reconciler already
    // treats as present. The column-set fallback is also what covers an unnamed inline
    // key, whose live name the engine invents.
    //
    // The pre-fence state_checkpoints key is the canonical case: the definition moved from
    // (chain, network, block_index, checkpoint_seq) to the narrower (chain, network,
    // checkpoint_seq), the reconciler added the new one, and the old wider UNIQUE key
    // stayed live forever because nothing ever looked for indexes the source did not name.
    undeclaredLiveIndexes(declared, byName){
        const names = new Set();
        const keys  = new Set();
        for(const d of declared || []){
            if(d.name) names.add(String(d.name).toLowerCase());
            if(d.columns && d.columns.length) keys.add(d.columns.map(c => String(c).toLowerCase()).join(','));
        }
        const out = [];
        for(const [name, info] of byName){
            if(names.has(String(name).toLowerCase())) continue;
            if(keys.has(info.cols.join(','))) continue;
            out.push({ name, unique: !!info.unique, fulltext: !!info.fulltext, columns: info.cols.slice() });
        }
        return out;
    }

    // Detect schema drift between the live table and its SQL source, and fix
    // it by ALTER. Two kinds of drift are handled:
    //   1. Missing columns - a column declared in the SQL source but absent
    //      from the live table is added with ADD COLUMN, reusing the source
    //      definition verbatim so its DEFAULT clause backfills existing rows,
    //      and placed with AFTER/FIRST so the reconciled table keeps the source's
    //      column ORDER (a bare ADD COLUMN appends, which diverges an aged table
    //      from a fresh createTable of the same definition).
    //      (A NOT NULL column with no DEFAULT can't be backfilled safely, so
    //      it's skipped with a loud warning rather than aborting startup.)
    //   2. Nullability - only relaxes NOT NULL -> NULL (the safe direction -
    //      never strengthens to NOT NULL since live rows might hold NULLs that
    //      would block the ALTER), and only when the bare MODIFY that does it
    //      would lose nothing: a MODIFY restates the WHOLE column, so a live
    //      DEFAULT / COMMENT / ON UPDATE / generation expression not named in the
    //      statement is dropped. A column carrying any of those is skipped with a
    //      loud warning and left to a dated migration (#4359).
    // Doesn't touch types or defaults of existing columns. Index reconciliation
    // is handled separately by reconcileTableIndexes(). Each applied ALTER is loudly logged.
    //
    // Byte-identity scope boundary (#2456): COLUMN position IS part of the
    // byte-identical SHOW CREATE TABLE goal - it affects on-disk row layout, which
    // is why missing columns are placed with AFTER/FIRST above and why the
    // 2026-07-16-reposition-state-key-bin migration exists. KEY / index declaration
    // ORDER is explicitly OUT of scope: MySQL/MariaDB print KEY lines in internal
    // index-creation order and attach no semantics to it, and a DROP+CREATE index
    // migration necessarily re-appends the rebuilt index at the tail, so a migrated
    // DB and a fresh install legitimately differ in KEY ordering for attests,
    // votes, and index_addresses. This is cosmetic and has no consensus effect
    // (consensus hashes ledger/state data, never SHOW CREATE TABLE text). The
    // fresh-vs-migrated schema-convergence comparator should sort KEY lines before
    // comparing; do NOT reorder the CREATE INDEX statements in the definition files
    // to chase it (that would only converge installs bootstrapped after the edit).
    async alterTableForDrift(file, db){
        const dir      = path.join(__dirname, '..', 'sql');
        const data     = fs.readFileSync(dir + '/' + file, "utf8");
        const table    = file.substring(0, file.indexOf('.sql'));
        const expected = this.parseExpectedColumns(data);
        if(!expected){
            // parseExpectedColumns returns null when the file has no recognizable
            // `CREATE TABLE ... ) ENGINE ...` block (e.g. a missing ENGINE clause).
            // That silently disables ALL column-drift reconciliation for this table -
            // exactly the gap that left cross_chain_matches without its Phase B columns.
            // Make it loud so a malformed source file can't hide. (Non-fatal: index
            // reconciliation and table creation are unaffected; the parse-coverage
            // unit test is the hard guardrail.)
            console.warn('Schema drift check SKIPPED for `' + table + '`: could not parse columns from ' + file + ' - expected a `CREATE TABLE ... ) ENGINE ...` definition. Additive column/nullability drift will NOT auto-reconcile for this table until the SQL source is fixed.');
            return;
        }
        const live = await db.query(
            // COLUMN_DEFAULT / COLLATION_NAME / COLUMN_COMMENT / GENERATION_EXPRESSION are
            // read for the nullability branch below: a bare MODIFY drops every attribute it
            // does not restate, so the reconciler has to see them to know what it would lose.
            "SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_TYPE, COLUMN_KEY, EXTRA, COLUMN_DEFAULT, COLLATION_NAME, COLUMN_COMMENT, GENERATION_EXPRESSION FROM information_schema.columns WHERE table_schema = ? AND table_name = ?",
            [this.dbName, table]
        );
        const liveByName = new Map(live.map(c => [c.COLUMN_NAME.toLowerCase(), c]));
        for(let i = 0; i < expected.length; i++){
            const exp = expected[i];
            const cur = liveByName.get(exp.name.toLowerCase());
            if(!cur){
                // Column declared in the SQL source but absent from the live
                // table (schema created before the column was introduced).
                //
                // BLIND SPOT, stated so migration prose stops assuming otherwise: this
                // branch also swallows AUTO_INCREMENT / PRIMARY KEY columns, because
                // parseExpectedColumns reads both as NOT NULL with no DEFAULT. Such an add
                // is actually safe (the engine backfills the sequence), but the parsed
                // shape cannot express that, so the reconciler is NOT a convergence path
                // for a surrogate key - only a dated migration is. A migration that adds
                // one must never be squashed or baselined as "the reconciler already did
                // it" (attest_validator_stats.id, 2026-08-19). Pinned by
                // test/unit/schema-drift-column-order.test.js.
                if(exp.notNull && !exp.hasDefault){
                    console.log('Schema drift on ' + table + '.' + exp.name + ': column missing live, source is NOT NULL with no DEFAULT - cannot backfill existing rows safely. Skipping; add manually.');
                    continue;
                }
                // Place the column where the SQL source puts it, not at the tail. A bare
                // ADD COLUMN appends, so an aged table reconciled at boot ended up with a
                // different column ORDER than a fresh createTable of the same definition
                // (contract_state.state_key_bin: mid-table on fresh installs, tail on aged
                // ones) - logically equivalent, but not a byte-identical SHOW CREATE TABLE.
                // Anchor on the nearest PRECEDING source column that exists live (columns
                // added in this same pass count, hence the liveByName update below); a
                // source-leading column has no anchor and goes FIRST.
                let anchor = null;
                for(let j = i - 1; j >= 0 && !anchor; j--){
                    if(liveByName.has(expected[j].name.toLowerCase())) anchor = expected[j].name;
                }
                const placement = anchor ? ' AFTER `' + anchor + '`' : ' FIRST';
                console.log('Schema drift on ' + table + '.' + exp.name + ': column missing live. Adding column from SQL source' + (anchor ? ' after ' + anchor : ' first') + '.');
                await db.query('ALTER TABLE `' + table + '` ADD COLUMN ' + exp.definition + placement);
                liveByName.set(exp.name.toLowerCase(), { COLUMN_NAME: exp.name, IS_NULLABLE: exp.notNull ? 'NO' : 'YES', COLUMN_TYPE: '', COLUMN_KEY: '', EXTRA: '' });
                continue;
            }
            const liveIsNullable = cur.IS_NULLABLE === 'YES';
            if(!liveIsNullable && exp.nullable){
                // NEVER relax a primary-key or auto-increment column: a PK can't be
                // NULL anyway, and a bare `MODIFY <type> NULL` silently strips the
                // AUTO_INCREMENT attribute (the mirror-cursor corruption found live
                // 2026-06-10). parseExpectedColumns already treats such sources as
                // NOT NULL; this guards against any parse gap.
                const isPk     = String(cur.COLUMN_KEY || '').toUpperCase() === 'PRI';
                const isAutoInc = /auto_increment/i.test(String(cur.EXTRA || ''));
                if(isPk || isAutoInc){
                    console.log('Schema drift on ' + table + '.' + exp.name + ': live=NOT NULL, source=NULL - SKIPPING relax (' + (isPk ? 'PRIMARY KEY' : 'AUTO_INCREMENT') + ' column; a bare MODIFY would strip attributes).');
                    continue;
                }
                // A MODIFY restates the whole column, so anything the statement omits is
                // dropped - DEFAULT, COMMENT, ON UPDATE, and the generation expression all
                // vanish, silently diverging an aged DB from a fresh install of the same
                // source (#4359). Rebuilding those clauses out of information_schema is its
                // own footgun (DEFAULT quoting, expression defaults, virtual vs stored), so
                // relax only when there is nothing to lose and surface the rest as drift -
                // the same skip-and-log posture as the two guards above.
                const lossy = [];
                if(cur.COLUMN_DEFAULT !== null && cur.COLUMN_DEFAULT !== undefined) lossy.push('DEFAULT');
                if(String(cur.COLUMN_COMMENT || '') !== '')                         lossy.push('COMMENT');
                if(String(cur.GENERATION_EXPRESSION || '') !== '')                  lossy.push('generation expression');
                if(/on update/i.test(String(cur.EXTRA || '')))                      lossy.push('ON UPDATE');
                if(lossy.length){
                    console.warn('Schema drift on ' + table + '.' + exp.name + ': live=NOT NULL, source=NULL - SKIPPING relax (a bare MODIFY would drop ' + lossy.join(', ') + '). Relax it in a dated migration that restates the full column instead.');
                    continue;
                }
                // Restate the live collation: it is a bare identifier (no quoting hazard) and
                // omitting it re-collates an explicitly-collated column to the table default.
                const collate = /^[A-Za-z0-9_]+$/.test(String(cur.COLLATION_NAME || '')) ? ' COLLATE ' + cur.COLLATION_NAME : '';
                console.log('Schema drift on ' + table + '.' + exp.name + ': live=NOT NULL, source=NULL. Relaxing constraint.');
                await db.query('ALTER TABLE `' + table + '` MODIFY `' + exp.name + '` ' + cur.COLUMN_TYPE + collate + ' NULL');
            }
        }
        // The other direction: columns the live table carries that the source declares
        // nowhere. Never healed here (a DROP would destroy data unattended), but reported
        // so a DB whose shape has diverged from a fresh install of this release says so on
        // every boot instead of being found by a hand comparison across the fleet.
        const undeclared = this.undeclaredLiveColumns(expected, live);
        if(undeclared.length){
            console.warn('Schema shape drift on ' + table + ': live column(s) ' + undeclared.join(', ') +
                ' are declared by NO SQL source. Not auto-healed (never DROP a column we did not create); ' +
                'converge with a dated migration via node src/migrate.js, or restore the declaration to ' + file + '.');
            recordShapeDrift(this.schemaShapeDrift, table, 'columns', undeclared);
        }
    }

    // Parse standalone `CREATE [UNIQUE] INDEX <name> ON <table> (<cols>)` statements
    // from a table's SQL source. Returns [{name, unique, columns:[...]}]. Inline
    // PRIMARY KEY / UNIQUE clauses inside CREATE TABLE are created with the table and
    // are not reconciled here. Index/column names come from the trusted SQL files.
    parseExpectedIndexes(sqlData, table){
        sqlData = this.stripSqlLineComments(sqlData);
        // UNIQUE and FULLTEXT are both admitted: a FULLTEXT index (contracts.meta_search)
        // was invisible to this parser, so an aged database could never self-heal it and
        // the migration was its only creation path.
        const re = /CREATE\s+(UNIQUE\s+|FULLTEXT\s+)?INDEX\s+`?(\w+)`?\s+ON\s+`?(\w+)`?\s*\(\s*([\s\S]+?)\s*\)\s*;/gi;
        const out = [];
        let m;
        while((m = re.exec(sqlData)) !== null){
            if(m[3].toLowerCase() !== table.toLowerCase()) continue;
            // Split the column list on commas and strip backticks. Any (len) prefix is kept
            // SEPARATELY (prefixes, null = full column) so the reconciler can detect
            // prefix-width drift instead of treating a prefixed and a full-column index on
            // the same columns as identical (#2261). Sort direction is kept the same way
            // (directions) so a rebuilt index carries the declared DESC (#4357); matching
            // still keys on `columns` alone, which is direction- and width-blind by design.
            const specs = m[4].split(',').map(c => c.trim().replace(/`/g, '')).filter(Boolean);
            const parts      = specs.map(c => c.split(/\s+/)[0]);
            const columns    = parts.map(c => c.replace(/\(\d+\)$/, ''));
            const prefixes   = parts.map(c => { const pm = /\((\d+)\)$/.exec(c); return pm ? Number(pm[1]) : null; });
            const directions = specs.map(c => /\sDESC\b/i.test(c) ? 'DESC' : 'ASC');
            const kind = (m[1] || '').trim().toUpperCase();
            if(columns.length) out.push({ name: m[2], unique: kind === 'UNIQUE', fulltext: kind === 'FULLTEXT', columns, prefixes, directions });
        }
        return out;
    }

    // Reconcile declared indexes against the live table. Adds any index named in the
    // SQL source that is absent live (matched by column set, so a renamed-but-equivalent
    // index is treated as present). For a UNIQUE index blocked by pre-existing duplicate
    // rows, dedupes first (see dedupeForUniqueIndex) then retries. Never throws - a
    // failure is logged and startup continues. On a table that already has every declared
    // index (the normal case) this is a single information_schema read and a no-op.
    async reconcileTableIndexes(file, db){
        try {
            const dir      = path.join(__dirname, '..', 'sql');
            const data     = fs.readFileSync(dir + '/' + file, "utf8");
            const table    = file.substring(0, file.indexOf('.sql'));
            const expected = this.parseExpectedIndexes(data, table);
            // The live read happens even with nothing to re-add: the undeclared-index
            // detector at the bottom runs on every table, and a table whose keys are all
            // inline declares no standalone CREATE INDEX at all.

            // Live indexes -> map keyed by ordered column-set: "c1,c2" => {unique}
            const rows = await db.query(
                "SELECT INDEX_NAME, NON_UNIQUE, INDEX_TYPE, COLUMN_NAME, SEQ_IN_INDEX, SUB_PART FROM information_schema.statistics " +
                "WHERE table_schema = ? AND table_name = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX",
                [this.dbName, table]);
            const byName = new Map();
            const liveNames = new Set();
            for(const r of rows){
                liveNames.add(r.INDEX_NAME.toLowerCase());
                if(!byName.has(r.INDEX_NAME)) byName.set(r.INDEX_NAME, { unique: Number(r.NON_UNIQUE) === 0, fulltext: String(r.INDEX_TYPE || '').toUpperCase() === 'FULLTEXT', cols: [], subParts: [] });
                byName.get(r.INDEX_NAME).cols.push(r.COLUMN_NAME.toLowerCase());
                byName.get(r.INDEX_NAME).subParts.push(r.SUB_PART == null ? null : Number(r.SUB_PART));
            }
            const liveByCols = new Map();
            for(const info of byName.values()) liveByCols.set(info.cols.join(','), info);

            for(const idx of expected){
                const key  = idx.columns.map(c => c.toLowerCase()).join(',');
                const live = liveByCols.get(key);
                if(live && (!idx.unique || live.unique) && (!idx.fulltext || live.fulltext)){
                    // Satisfied by column set, but the column-set match is blind to
                    // prefix widths: an aged `address(62)` index and the declared
                    // full-column index read as identical here and no auto path
                    // converges them (the DROP/CREATE is deliberately mode=manual;
                    // rebuilding a UNIQUE index the boot upsert path depends on is
                    // not safe to do unattended). Detect-and-warn so the drift is
                    // auditable instead of invisible (#2261).
                    const declared = idx.prefixes || idx.columns.map(() => null);
                    const drift = idx.columns.map((c, i) => ({ col: c, want: declared[i] ?? null, have: (live.subParts && live.subParts[i]) ?? null }))
                        .filter(d => d.want !== d.have);
                    if(drift.length){
                        const desc = drift.map(d =>
                            d.col + ' live ' + (d.have === null ? 'full-column' : '(' + d.have + ')') +
                            ' vs declared ' + (d.want === null ? 'full-column' : '(' + d.want + ')')).join('; ');
                        console.warn('Schema drift on ' + table + ': index on (' + key + ') differs in prefix width: ' + desc +
                            '. Not auto-healed (UNIQUE index rebuild is gated manual); run the pending manual migration via node src/migrate.js to converge.');
                    }
                    continue;                                               // already satisfied
                }
                if(liveNames.has(idx.name.toLowerCase())){
                    // Name taken by a DIFFERENT live index (different column set, or same
                    // name but not unique when we declare UNIQUE). We must never DROP an
                    // index we did not create, so we leave it alone - but the declared
                    // index is silently never applied, so the table can permanently run
                    // without the declared uniqueness (degrading every
                    // INSERT ... ON DUPLICATE KEY UPDATE to a plain INSERT) or without the
                    // widened column set. Detect-and-warn so this drift is auditable
                    // instead of invisible, matching the prefix-width branch above (#2261)
                    // and the auto-dedup branch below (#2702).
                    let liveInfo = null;
                    for(const [nm, info] of byName){ if(nm.toLowerCase() === idx.name.toLowerCase()){ liveInfo = info; break; } }
                    const liveDesc = liveInfo
                        ? (liveInfo.unique ? 'UNIQUE' : liveInfo.fulltext ? 'FULLTEXT' : 'non-unique') + ' on (' + liveInfo.cols.join(',') + ')'
                        : 'a differently-defined index';
                    console.warn('Schema drift on ' + table + ': declared ' + (idx.unique ? 'UNIQUE ' : idx.fulltext ? 'FULLTEXT ' : '') +
                        'index ' + idx.name + ' on (' + key + ') cannot be applied - the name is already held by ' + liveDesc +
                        '. Not auto-healed (never DROP an index we did not create); apply a manual migration via node src/migrate.js to converge.');
                    continue;
                }
                // Rebuild the index the way the source DECLARES it. Dropping the (len) prefix
                // turns UNIQUE tick(200) into a full-column index on a TEXT column, which
                // MariaDB rejects (errno 1170) and the catch below only logs, so the table
                // permanently runs without its declared uniqueness; dropping DESC diverges an
                // auto-healed index from a fresh install of the same definition (#4357).
                const colList = idx.columns.map((c, i) => {
                    const prefix = idx.prefixes    && idx.prefixes[i] != null      ? '(' + idx.prefixes[i] + ')' : '';
                    const dir    = idx.directions  && idx.directions[i] === 'DESC' ? ' DESC'                     : '';
                    return '`' + c + '`' + prefix + dir;
                }).join(', ');

                if(idx.fulltext){
                    // A FULLTEXT index takes no prefix widths or directions; MariaDB refuses
                    // both, so the heal names the columns bare.
                    console.log('Schema drift on ' + table + ': missing FULLTEXT index ' + idx.name + ' (' + key + '). Adding.');
                    await db.query('ALTER TABLE `' + table + '` ADD FULLTEXT INDEX `' + idx.name + '` (' + idx.columns.map(c => '`' + c + '`').join(', ') + ')');
                    continue;
                }
                if(!idx.unique){
                    console.log('Schema drift on ' + table + ': missing index ' + idx.name + ' (' + key + '). Adding.');
                    await db.query('ALTER TABLE `' + table + '` ADD INDEX `' + idx.name + '` (' + colList + ')');
                    continue;
                }
                try {
                    console.log('Schema drift on ' + table + ': missing UNIQUE index ' + idx.name + ' (' + key + '). Adding.');
                    await db.query('ALTER TABLE `' + table + '` ADD UNIQUE INDEX `' + idx.name + '` (' + colList + ')');
                } catch(e){
                    const dup = e && (Number(e.errno) === 1062 || /duplicate entry/i.test(e.message || ''));
                    if(!dup){ console.log('  could not add UNIQUE index ' + idx.name + ' on ' + table + ': ' + (e && e.message)); continue; }
                    if(!AUTO_DEDUP_TABLES.has(table)){
                        console.warn('  ' + table + '.' + idx.name + ': duplicate rows block the UNIQUE index, but ' + table + ' is NOT on the auto-dedup allow-list - skipping (no rows deleted). Apply a manual migration to resolve the duplicates.');
                        continue;
                    }
                    console.log('  ' + table + '.' + idx.name + ': duplicate rows block the UNIQUE index - deduping (keep newest id per ' + key + ') then retrying.');
                    if(!(await this.dedupeForUniqueIndex(db, table, idx.columns))) continue;
                    try {
                        await db.query('ALTER TABLE `' + table + '` ADD UNIQUE INDEX `' + idx.name + '` (' + colList + ')');
                        console.log('  added ' + idx.name + ' after dedupe.');
                    } catch(e2){
                        console.log('  ' + table + '.' + idx.name + ' still failing after dedupe - leaving as-is: ' + (e2 && e2.message));
                    }
                }
            }

            // Indexes present live that no declaration reaches. Matched against BOTH
            // declaration forms (standalone CREATE INDEX and the inline keys inside the
            // CREATE TABLE block) so only a genuine orphan is reported. Detection only -
            // the never-DROP rule that governs the name-collision branch above governs
            // this too; converging is a dated migration's job.
            const undeclared = this.undeclaredLiveIndexes(
                expected.concat(this.parseInlineIndexes(data, table)), byName);
            if(undeclared.length){
                console.warn('Schema shape drift on ' + table + ': live index(es) ' +
                    undeclared.map(i => (i.unique ? 'UNIQUE ' : i.fulltext ? 'FULLTEXT ' : '') + i.name + ' (' + i.columns.join(',') + ')').join('; ') +
                    ' are declared by NO SQL source. Not auto-healed (never DROP an index we did not create); ' +
                    'converge with a dated migration via node src/migrate.js, or restore the declaration to ' + file + '.');
                recordShapeDrift(this.schemaShapeDrift, table, 'indexes', undeclared);
            }
        } catch(e){
            // Never abort startup over index reconciliation.
            console.warn('reconcileTableIndexes(' + file + ') failed (non-fatal): ' + (e && e.message));
        }
    }

    // Collapse duplicate rows on `columns` so a UNIQUE index can be added, keeping the
    // row with the highest `id` in each group. For the failure this repairs - an
    // INSERT ... ON DUPLICATE KEY UPDATE upsert that degraded to plain INSERT because the
    // unique index was missing - each balance change appended a fresh row with the current
    // value, so the highest id is the live (correct) value and the older rows are stale.
    // Uses `=` (not `<=>`) so NULL tuples are left intact, matching UNIQUE semantics (a
    // UNIQUE index permits multiple NULLs). Requires a single `id` column to pick a
    // survivor; skips with a warning if absent. Returns true if the table is now safe to index.
    async dedupeForUniqueIndex(db, table, columns){
        const hasId = (await db.query(
            "SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND COLUMN_NAME = 'id'",
            [this.dbName, table])).length > 0;
        if(!hasId){
            console.log('  cannot dedupe ' + table + ' (no `id` column to pick a surviving row) - skipping unique-index add.');
            return false;
        }
        const on  = columns.map(c => 't1.`' + c + '` = t2.`' + c + '`').join(' AND ');
        const res = await db.query('DELETE t1 FROM `' + table + '` t1 JOIN `' + table + '` t2 ON ' + on + ' AND t1.id < t2.id');
        console.log('  deduped ' + table + ': removed ' + (res && res.affectedRows != null ? res.affectedRows : '?') + ' stale duplicate row(s).');
        return true;
    }

    // Handle creating database tables.
    //
    // Uses raw db.query (not doQuery) because doQuery swallows non-transactional
    // errors - a DROP TABLE that committed followed by a CREATE TABLE that
    // failed on a connection blip would leave a partial-state table missing
    // (observed on LTC regtest: `dispensers` ended up missing after a transient
    // MariaDB hiccup during init, fatal-looped the indexer on every block).
    // Retries the whole file with exponential backoff so transient DB issues
    // don't leave half-built schema.
    // Remove SQL line comments while respecting quoted strings, so a ';'
    // appearing inside comment prose is never mistaken for a statement
    // terminator. Single/double-quote and backtick spans are preserved verbatim
    // (a doubled quote escapes, and inside `'`/`"` so does a backslash - see
    // opensBackslashEscape); a `--` or `#` outside any quote or block comment
    // skips to the end of its line. Newlines are kept so error positions stay
    // meaningful.
    //
    // `#` counts because MariaDB/MySQL honour it to end-of-line exactly like
    // `--`. Missing it made a `# note` line ahead of a destructive statement
    // invisible to the ^-anchored checks in _destructiveAutoStatement: the
    // chunk began with `#`, matched no keyword, scored the file auto-eligible,
    // and the server ran the DROP unattended at startup. A `;` inside a `#`
    // comment also tore the statement in two for both the classifier and the
    // apply loop.
    //
    // `/* ... */` spans are copied through verbatim rather than scanned: a `--`
    // or `#` inside one would otherwise swallow the closing `*/` and the rest of
    // that line (the server does not treat either as a comment start there), and
    // an apostrophe in block-comment prose would open a bogus quote span. The
    // verbatim copy also keeps `/*!...*/` executable-comment payloads intact for
    // _destructiveAutoStatement to flag.
    stripSqlLineComments(sql){
        let out = '';
        let quote = null;
        for(let i = 0; i < sql.length; i++){
            const ch = sql[i];
            if(quote){
                out += ch;
                if(opensBackslashEscape(sql, i, quote)){ out += sql[++i]; continue; }
                if(ch === quote){
                    if(sql[i + 1] === quote){ out += sql[++i]; }
                    else { quote = null; }
                }
                continue;
            }
            if(ch === "'" || ch === '"' || ch === '`'){ quote = ch; out += ch; continue; }
            if(ch === '/' && sql[i + 1] === '*'){
                const end = sql.indexOf('*/', i + 2);
                if(end === -1){ out += sql.slice(i); break; }   // unterminated: copy the rest as-is
                out += sql.slice(i, end + 2);
                i = end + 1;
                continue;
            }
            if((ch === '-' && sql[i + 1] === '-') || ch === '#'){
                while(i < sql.length && sql[i] !== '\n'){ i++; }
                if(i < sql.length){ out += '\n'; }
                continue;
            }
            out += ch;
        }
        return out;
    }

    // Split a SQL string into individual statements on `;`, but only when the `;`
    // sits outside a quoted string. A naive `.split(';')` tears a statement whose
    // string literal contains a semicolon (e.g. `SET data = 'a;b'`) into invalid
    // fragments, so no migration or seed carrying a semicolon in quoted data can
    // ship, and _destructiveAutoStatement ends up classifying fragments rather than
    // real statements. `--` and `#` line comments are stripped first (same rule as
    // the callers used); the quote model matches stripSqlLineComments exactly
    // (single/double-quote and backtick spans, doubled-quote and backslash escapes).
    // Returns trimmed, non-empty statements.
    splitSqlStatements(sql){
        const stripped = this.stripSqlLineComments(sql);
        const statements = [];
        let current = '';
        let quote = null;
        for(let i = 0; i < stripped.length; i++){
            const ch = stripped[i];
            if(quote){
                current += ch;
                if(opensBackslashEscape(stripped, i, quote)){ current += stripped[++i]; continue; }
                if(ch === quote){
                    if(stripped[i + 1] === quote){ current += stripped[++i]; }
                    else { quote = null; }
                }
                continue;
            }
            if(ch === "'" || ch === '"' || ch === '`'){ quote = ch; current += ch; continue; }
            // Block comments survive the strip (the classifier needs `/*!...*/` payloads
            // intact), so carry them across whole: an apostrophe in comment prose must not
            // open a quote span, and a ';' inside one must not terminate the statement.
            if(ch === '/' && stripped[i + 1] === '*'){
                const end = stripped.indexOf('*/', i + 2);
                if(end === -1){ current += stripped.slice(i); break; }
                current += stripped.slice(i, end + 2);
                i = end + 1;
                continue;
            }
            if(ch === ';'){ statements.push(current); current = ''; continue; }
            current += ch;
        }
        statements.push(current);
        return statements.map(s => s.trim()).filter(Boolean);
    }

    async createTable(file){
        const dir     = path.join(__dirname, '..', 'sql');
        const data    = fs.readFileSync(dir + '/' + file, "utf8");
        const table   = file.substring(0, file.indexOf('.sql'));
        // Quote-aware split into statements. A ';' inside a comment (prose
        // punctuation in a header block) or inside a string literal must not be
        // treated as a statement terminator - that truncates the statement into a
        // bogus standalone query and fails schema creation (observed: a semicolon in
        // attests.sql's header split its comment, crash-looping the indexer).
        const queries = this.splitSqlStatements(data);

        const MAX_ATTEMPTS = 5;
        let lastErr = null;
        for(let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++){
            let db = null;
            try {
                db = await this.getConnection();
                for(const query of queries){
                    await db.query(query);
                }
                await db.release();
                return;
            } catch (err) {
                lastErr = err;
                if(db){
                    try { await db.release(); } catch (_){}
                }
                if(attempt >= MAX_ATTEMPTS) break;
                const backoffMs = Math.min(30000, 500 * Math.pow(2, attempt - 1));
                console.log('Error creating ' + table + ' (attempt ' + attempt + '/' + MAX_ATTEMPTS + '): ', err, '. Retrying in ' + backoffMs + 'ms...');
                await this.util.sleep(backoffMs);
            }
        }
        this.util.throwError('Failed to create ' + table + ' table after ' + MAX_ATTEMPTS + ' attempts: ' + (lastErr ? lastErr.message : 'unknown'));
    }

    /* 
     * Common database connection functions (connect / rollback / commit / doQuery)
     */

    // Handle getting a database Connection (with exponential backoff + jitter)
    async getConnection(){
        if(this.transactionConnection)
            return this.transactionConnection;
        // Circuit breaker: reject immediately if open
        if(this.circuitState === 'open'){
            if(Date.now() < this.circuitOpenUntil)
                this.util.throwError('Circuit breaker open - database connections rejected until cooldown expires');
            // Cooldown expired, transition to half-open
            this.circuitState = 'half-open';
            console.log('Circuit breaker half-open - attempting reconnection');
        }
        var connection    = null;
        var attempts      = 0;
        var maxAttempts   = 30;
        var baseDelay     = 500;   // 500ms initial delay
        var maxDelay      = 15000; // 15s max delay
        while(connection == null){
            try {
                connection = await this.pool.getConnection();
                // Reset circuit breaker on success
                if(this.circuitState === 'half-open'){
                    this.circuitState = 'closed';
                    this.circuitFailures = 0;
                    console.log('Circuit breaker closed - database connection restored');
                }
                this.circuitFailures = 0;
            } catch (e){
                attempts++;
                this.circuitFailures = (this.circuitFailures || 0) + 1;
                // Circuit breaker: open after consecutive failures
                if(this.circuitFailures >= this.circuitThreshold){
                    this.circuitState = 'open';
                    this.circuitOpenUntil = Date.now() + this.circuitCooldown;
                    this.util.throwError('Circuit breaker opened after ' + this.circuitFailures + ' consecutive failures - cooling down for ' + (this.circuitCooldown / 1000) + 's');
                }
                if(attempts >= maxAttempts)
                    this.util.throwError('Could not connect to MariaDB after ' + maxAttempts + ' attempts. Giving up.');
                // Exponential backoff with jitter: delay = min(baseDelay * 2^attempt, maxDelay) + random jitter
                let delay = Math.min(baseDelay * Math.pow(2, attempts - 1), maxDelay);
                let jitter = Math.floor(Math.random() * delay * 0.3); // up to 30% jitter
                let totalDelay = delay + jitter;
                console.error('MariaDB connection attempt ' + attempts + '/' + maxAttempts + ' failed. Retrying in ' + totalDelay + 'ms...', e)
                connection = null;
                await this.util.sleep(totalDelay);
            }
        }
        return connection;
    }

    // Handle releasing a connection and freeing it up for additional queries
    async releaseConnection(){
        if(this.transactionConnection != null){
            await this.transactionConnection.release();
            this.transactionConnection = null;
        }  
    }

    // Drain the connection pool so a process holding this Database can exit. The
    // long-running services never call it (they hold their pool for their lifetime),
    // but every bin/ harness ends with `if(db.close) await db.close()` and there was
    // no such method, so the guard silently did nothing and the pool's idle sockets
    // kept the event loop alive: the tool printed its results and then hung until it
    // was killed, which reads as a slow benchmark rather than as a finished one.
    async close(){
        await this.releaseConnection();
        if(this.pool){
            try { await this.pool.end(); } catch(_){}
            this.pool = null;
        }
    }

    // Acquire the transaction mutex (this._txLock). Resolves once the lock is held.
    // Non-reentrant: a single flow must not call this twice before releasing.
    //
    // `timeoutMs` bounds the WAIT. Unset keeps the block loop's unbounded queue
    // which is the only correct behaviour for a caller that must eventually run. A public
    // read-only caller passes a budget instead, because queueing behind a whole block's
    // processing is what turned a fee quote into a 25-40s hang and then an explorer 502:
    // the quote's own time box only ever covered the dry-run, never the wait in front of it.
    // Rejects with code TX_LOCK_BUSY, before any connection work, so the caller can answer
    // "busy, retry" in milliseconds.
    _acquireTxLock(timeoutMs){
        if(!this._txLock.locked){
            this._txLock.locked = true;
            return Promise.resolve();
        }
        let waiter = { settled: false, grant: null };
        if(!(Number(timeoutMs) > 0)){
            return new Promise(resolve => {
                waiter.grant = resolve;
                this._txLock.queue.push(waiter);
            });
        }
        return new Promise((resolve, reject) => {
            let timer = setTimeout(() => {
                if(waiter.settled) return;
                // Stays in the queue but marked settled; _releaseTxLock skips it. Splicing
                // here would be O(n) on every give-up for no benefit.
                waiter.settled = true;
                let e = new Error('transaction lock busy: waited ' + Number(timeoutMs) +
                    'ms for the database transaction mutex (block processing holds it)');
                e.code = 'TX_LOCK_BUSY';
                reject(e);
            }, Number(timeoutMs));
            // Never let a queued waiter's timer alone hold the process open.
            if(timer.unref) timer.unref();
            waiter.grant = () => { clearTimeout(timer); resolve(); };
            this._txLock.queue.push(waiter);
        });
    }

    // Release the transaction mutex, handing it to the next LIVE waiter. A waiter that
    // already timed out is skipped rather than granted: handing the lock to a
    // caller that has given up would strand it held with nothing left to release it, which
    // would wedge block processing permanently - a far worse failure than the slow quote
    // the budget exists to bound.
    _releaseTxLock(){
        while(this._txLock.queue.length > 0){
            let next = this._txLock.queue.shift();
            if(next.settled) continue;
            next.settled = true;
            next.grant();
            return;
        }
        this._txLock.locked = false;
    }

    // The DB transaction epoch active right now (M-16). The block loop reads this
    // immediately after beginTransaction and runs the block promise under it (runInTxEpoch)
    // so every write it issues is fenced to this epoch.
    currentTxEpoch(){
        return this._txEpoch;
    }

    // Run fn with `epoch` installed as the watchdog-fence context for every DB call fn makes
    // (transitively, across awaits). Returns fn's return value (the block-processing promise).
    // Used by the BLOCK LOOP; behavior on the non-timeout path is unchanged because the
    // installed epoch always equals the current _txEpoch until the transaction is torn down.
    // The context records WHICH Database instance owns the guarded transaction: the indexer
    // process holds several instances of this class (indexer DB, decoder DB, hub-DB mirror),
    // and the fence must only guard the owner's shared transactionConnection. A read through
    // a sibling instance inside the same async context (e.g. a hub-mirror price read during
    // fee validation) draws from that instance's own pool and can never land in the guarded
    // transaction, so it must not be fenced (its epoch counter never advances, so comparing
    // across instances fences every such read; caught live on regtest 2026-07-08).
    // `consensus: true` marks this context as real block processing, which is what
    // _assertPriceBarrierNotSkipped keys on; see runInDryRunEpoch below for why the flag
    // exists and why THIS is the defaulted side.
    runInTxEpoch(epoch, fn){
        return txEpochStore.run({ owner: this, epoch: epoch, consensus: true }, fn);
    }

    // Same M-16 fence, no consensus authority. The fee-quote dry run needs the
    // zombie-write protection above - it holds the shared transaction and can be abandoned by
    // its watchdog exactly as a block can - but it is NOT block processing and it commits
    // nothing. _assertPriceBarrierNotSkipped used "a txEpochStore context exists" as its proof
    // that a caller is the block loop, and this call site made that proof false: a public
    // /feequote whose dry run read the price mirror during a barrier-skipped block answered
    // `handler threw: ... PRICE_BARRIER_DEFERRED` and, worse, set priceBarrierForceBlock, so an
    // unauthenticated read wrote block-loop state. Splitting the two kinds is the whole fix.
    // The DEFAULT is deliberately on runInTxEpoch: an unlabelled future caller is then treated
    // as consensus and trips the barrier as before, which is over-firing rather than silently
    // escaping a consensus guard. Opting OUT has to be a visible act, and this is it.
    runInDryRunEpoch(epoch, fn){
        return txEpochStore.run({ owner: this, epoch: epoch, consensus: false }, fn);
    }

    // Watchdog fence (M-16). Reject a write whose issuing epoch no longer matches the current
    // transaction epoch ON THE INSTANCE THAT OWNS THE GUARDED TRANSACTION. Only block-loop
    // code runs inside a txEpochStore context, so an owner-match with a stale epoch means this
    // call is an abandoned (timed-out) block's zombie continuation trying to write after its
    // transaction was rolled back and a later block's transaction took over the shared
    // connection. No stored context = a non-block-loop caller (federation RPC read, health
    // check); an owner mismatch = a sibling Database instance's pool read inside the block's
    // async context; neither is fenced. This can only ADD a throw on the already-broken
    // timeout path; it never suppresses a legitimate write, so the non-timeout path is
    // byte-identical.
    _assertTxNotFenced(){
        const ctx = txEpochStore.getStore();
        if(ctx !== undefined && ctx.owner === this && ctx.epoch !== this._txEpoch)
            this.util.throwError('transaction fenced (M-16): write from epoch ' + ctx.epoch +
                ' after teardown (current epoch ' + this._txEpoch + '); zombie write rejected');
    }

    // fail-closed backstop for the action-scoped price barrier. The block loop skips
    // the price/oracle mirror barriers when priceReadPredicate proved the block carries no
    // transaction-borne price reader. That predicate cannot see the end-of-block passes:
    // processCrossChainCalls injects XEXEC actions and runs XCALL callback isolates from
    // hub-mirror state on blocks with no transaction at all, and the VM exposes
    // oracle.getPrice to contract code. Rather than predict those (their due sets are
    // queried inside the block transaction and the mirror keeps syncing concurrently, so any
    // prediction is racy), every price-mirror read asserts here: if this block skipped the
    // barrier and something reads anyway, fail the block instead of reading an uncovered
    // mirror. The block rolls back, priceBarrierForceBlock makes the retry take the barrier,
    // and it commits on the second attempt. Same machinery the watchdog path already uses.
    //
    // Scoped to block processing by the txEpochStore context's `consensus` flag, which only
    // runInTxEpoch sets and which propagates across awaits into sibling Database instances (the
    // hub mirror reads run on this exact path). Two ways out, and BOTH are needed: no stored
    // context = an API / healthcheck read, and a stored context with consensus false = the
    // fee-quote dry run, which installs a context of its own for the M-16 fence.
    // Either is free to read whatever the mirror currently holds, because neither commits
    // anything - only a block can carry an uncovered mirror read into consensus state. Testing
    // for the flag rather than for the context's mere existence is what actually stops a
    // concurrent api.js fee quote from tripping a consensus guard; testing for existence alone
    // did not, and cost three sweep drives and a wrong "fee price unavailable" on screen.
    // The deferral is thrown as a typed Error carrying PRICE_BARRIER_DEFERRED, because the
    // readers this backstop fires on sit INSIDE action catches that swallow deterministic
    // contract failures (xexec's execution catch, the XCALL/ATTEST callback catches). A bare
    // string carries no code and no errno, so faultGuard read it as a contract outcome and the
    // block committed a validator-local 'error' verdict instead of retrying with the barrier
    // (every injected XEXEC on a transaction-less block recorded result_status='error'
    // while healthy peers recorded 'ok'). The code is what makes rethrowIfInfraFault propagate.
    _assertPriceBarrierNotSkipped(site){
        const ctx = txEpochStore.getStore();
        if(ctx === undefined || ctx.consensus !== true) return;
        const ix = this.indexer;
        if(!ix || !ix.priceBarrierSkipped) return;
        // Escalate THIS block: the retry must not skip again, or it loops forever.
        ix.priceBarrierForceBlock = ix.priceBarrierBlock;
        const err = new Error('price barrier skipped but ' + site + ' read the price mirror at block ' +
            ix.priceBarrierBlock + '; deferring the block so it re-runs with the barrier enforced');
        err.code = 'PRICE_BARRIER_DEFERRED';
        this.util.throwError(err);
    }

    // Handle beginning a SQL transaction.
    // `opts.acquireTimeoutMs` time-boxes the wait for the transaction mutex and
    // throws TX_LOCK_BUSY instead of queueing; unset (every block-loop and reorg caller)
    // keeps the unbounded wait.
    async beginTransaction(opts){
        await this._acquireTxLock(opts && opts.acquireTimeoutMs);
        if(this.transactionConnection != null)
            await this.releaseConnection();
        try {
            this.transactionConnection = await this.getConnection();
            await this.transactionConnection.beginTransaction();
            // Fresh epoch for this transaction (M-16). The block loop reads it via
            // currentTxEpoch() and fences the block promise to it.
            this._txEpoch++;
        } catch(e){
            if(this.transactionConnection != null){
                try { await this.transactionConnection.release(); } catch(_){}
                this.transactionConnection = null;
            }
            this._releaseTxLock();
            this.util.throwError('beginTransaction error=' + e);
        }
    }

    // Handle rolling back a SQL transaction and releasing the connection
    async rollbackTransaction(){
        if(this.transactionConnection != null){
            console.log("rolling back");
            try {
                await this.transactionConnection.rollback();
            } finally {
                await this.transactionConnection.release();
                this.transactionConnection = null;
                // Fence any zombie of the block that just rolled back (M-16): bumping the
                // epoch here closes even the window before the next block's beginTransaction,
                // so a post-rollback zombie write cannot land as a stray auto-committed row.
                this._txEpoch++;
                // The abort just un-assigned every dense index id this transaction handed
                // out, so the id -> name memos it filled are now lies about ids the next
                // caller will be given. In the finally, beside the epoch bump, for
                // the same reason: a throw out of rollback() must not be able to skip it.
                this.clearSmtNameCaches();
                this._releaseTxLock();
            }
        }
    }

    // Handle commiting a SQL transaction and releasing the connection
    async commitTransaction(){
        if(this.transactionConnection != null){
            try {
                await this.transactionConnection.commit();
                await this.transactionConnection.release();
                this.transactionConnection = null;
                // Fence any zombie of the block that just committed (M-16).
                this._txEpoch++;
                this._releaseTxLock();
                return true;
            } catch (e){
                console.error('Error committing transaction:', e)
                try {
                    await this.transactionConnection.rollback();
                } finally {
                    await this.transactionConnection.release();
                    this.transactionConnection = null;
                    this._txEpoch++;
                    // A failed commit aborts, so its id assignments are gone too.
                    this.clearSmtNameCaches();
                    this._releaseTxLock();
                }
                this.util.throwError('commitTransaction error=' + e);
            }
        }
        return false;
    }

    // Handle running a query and returning the results
    async doQuery(query, args){
        this._assertTxNotFenced();
        let results = [];
        if(!this.util.isNull(query)){
            // Normalize args: convert any boxed primitives (e.g. mathjs BigNumber) to plain values.
            // Skip Buffers - the mariadb driver inserts them as binary into BLOB columns; calling
            // .toString() on them would UTF-8-decode the bytes and replace invalid sequences with
            // U+FFFD, corrupting binary payloads (e.g. FILE raw_data ciphertext).
            if(Array.isArray(args)){
                for(let i = 0; i < args.length; i++){
                    if(args[i] !== null && args[i] !== undefined && typeof args[i] === 'object' && !Buffer.isBuffer(args[i]))
                        args[i] = args[i].toString();
                }
            }
            let tx = this.transactionConnection != null;
            let db = await this.getConnection();
            try {
                results = await db.query(query, args);
            } catch (error){
                this.util.logError('Error running database query :', error);
                // Inside a transaction, re-throw so the block-level catch triggers a rollback
                // This prevents silent data loss from failed writes within an ACID transaction
                if(tx)
                    throw error;
            }
            // Release the connection if we are not in the middle of a ACID transaction
            if(!tx)
                await db.release();
        }
        return results;
    }

    // Like doQuery, but a query error ALWAYS throws, transactional or not.
    // For consensus-input reads: doQuery collapses a non-transactional query
    // error into [], indistinguishable from a genuinely empty result, so a
    // transient DB fault becomes "no data" on this node only and can fork the
    // ledger (M-17: the hub-DB price read). Callers inside block processing
    // let the throw roll back and retry the block.
    async doQueryStrict(query, args){
        this._assertTxNotFenced();
        let results = [];
        if(!this.util.isNull(query)){
            if(Array.isArray(args)){
                for(let i = 0; i < args.length; i++){
                    if(args[i] !== null && args[i] !== undefined && typeof args[i] === 'object' && !Buffer.isBuffer(args[i]))
                        args[i] = args[i].toString();
                }
            }
            let tx = this.transactionConnection != null;
            let db = await this.getConnection();
            try {
                results = await db.query(query, args);
            } catch (error){
                this.util.logError('Error running database query :', error);
                throw error;
            } finally {
                if(!tx)
                    await db.release();
            }
        }
        return results;
    }

    /* 
     * General database functions
     */

    // Handle normalizing data values before inserting in the database tables
    normalizeDataValues(data){
        // Operate on a shallow copy so the caller's object is never mutated in
        // place. This routine stringifies object fields (e.g. the TX_OUTPUTS
        // array) and nulls non-numeric NUMBER_FIELDS purely for storage; mutating
        // the shared action `data` corrupts any later read of it. AIRDROP's
        // multi-tick loop reuses one `data` across ticks - after tick 1's
        // createAirdrop ran this in place, tick 2 saw a stringified TX_OUTPUTS, so
        // detectFeePaymentMode's Array.isArray guard failed and the native fee
        // output went undetected ('native coin output required' on LTC/DOGE; BTC's
        // xchain balance fallback masked it). Every caller already reassigns from
        // the return value, so returning a copy is transparent to them.
        data = Object.assign({}, data);
        // Handle converting any boxed primitives (e.g. mathjs Decimal) to plain primitives.
        // Buffers (e.g. FILE raw_data) must pass through unchanged - String(buffer) would
        // UTF-8-decode the bytes and replace any invalid sequences with U+FFFD, corrupting
        // binary payloads like AES-GCM ciphertext.
        for(let key in data){
            if(!this.util.isNull(data[key]) && typeof data[key] === 'object' && !Buffer.isBuffer(data[key]))
                data[key] = this.util.safeToString(data[key]);
        }
        // Set LIST field values to numeric value or NULL
        for(let field of this.config['LIST_FIELDS'] ){
            if(!this.util.isNull(data[field]) && !this.util.isNumeric(data[field]))
                data[field] = null;
        }
        // Set NUMBER field values to numeric or NULL
        for(let field of this.config['NUMBER_FIELDS'] ){
            // TYPE is numeric for LIST (the list type 1/2) - the reason it
            // sits in NUMBER_FIELDS - but for FILE it is the MIME type
            // string. Numeric-normalizing it for FILE nulled every stored
            // MIME type (files.type_id was always NULL), which also broke
            // inline serving of on-chain media (the explorer's raw endpoint
            // fell back to octet-stream + attachment). Storage-only: FILE
            // validation reads the raw wire value before normalization.
            if(field=='TYPE' && data['ACTION']=='FILE') continue;
            if(this.util.isNull(data[field]) || !this.util.isNumeric(data[field]))
                data[field] = null;
        }
        // Null any INTEGER-backed wire field the storage column cannot represent. The
        // NUMBER_FIELDS pass above bounds TYPE, not MAGNITUDE, so a wire EXPIRATION of
        // '18446744073709551616' survives it and reaches a BIGINT UNSIGNED bind: strict
        // sql_mode throws inside the block transaction and the retry loop re-runs the same
        // deterministic transaction forever, permissive sql_mode clamps and stores a value
        // no other node stores. A negative value is the same hazard against an UNSIGNED
        // column, and the action handlers write their row even when the action is invalid.
        // See config['INTEGER_FIELDS'] for why the amount fields are excluded.
        for(let field in this.config['INTEGER_FIELDS']){
            if(this.util.isNull(data[field])) continue;
            if(this.util.exceedsUnsignedColumn(data[field], this.config['INTEGER_FIELDS'][field]))
                data[field] = null;
        }
        // set LOCK field values to explicitly unlocked (0), locked (1), or null
        for(let field of this.config['LOCK_FIELDS']){
            // Convert bignumber/string lock values to plain integers before checking
            let lockVal = data[field];
            if(lockVal !== null && lockVal !== undefined && typeof lockVal === 'object' && typeof lockVal.toNumber === 'function')
                lockVal = lockVal.toNumber();
            else if(typeof lockVal === 'string' && this.util.isNumeric(lockVal))
                lockVal = parseInt(lockVal);
            if([0,1].indexOf(lockVal) == -1)
                data[field] = null;
            else
                data[field] = lockVal;
        }
        // Set DECIMALS to null if it is outside of the acceptable range
        if(!this.util.isNull(data['DECIMALS']) && (data['DECIMALS'] < this.config.MIN_TOKEN_DECIMALS || data['DECIMALS'] > this.config.MAX_TOKEN_DECIMALS))
            data['DECIMALS'] = null;
        // Handle ACTION specific customizations
        let action = (!this.util.isNull(data['ACTION'])) ? data['ACTION'] : 'UNKNOWN';
        if(action=='BROADCAST'){
            // Truncate MESSAGE value to 250 characters
            if(!this.util.isNull(data['MESSAGE']))
                data['MESSAGE'] = String(data['MESSAGE']).substring(0,250);
            // Truncate VALUE value to 25 characters
            if(!this.util.isNull(data['VALUE']))
                data['VALUE'] = String(data['VALUE']).substring(0,25);
            // Truncate FEE value to 11 characters (0.00000000)
            if(!this.util.isNull(data['FEE']))
                data['FEE']  = String(data['FEE']).substring(0,11);
        } else if(action=='FILE'){
            // Truncate NAME value to 250 characters
            if(!this.util.isNull(data['NAME']))
                data['NAME'] = String(data['NAME']).substring(0,250);
            // Truncate TITLE value to 250 characters
            if(!this.util.isNull(data['TITLE']))
                data['TITLE'] = String(data['TITLE']).substring(0,250);
        } else if(action=='ISSUE'){
            // Truncate DESCRIPTION to MAX_TOKEN_DESCRIPTION
            if(!this.util.isNull(data['DESCRIPTION']))  
                data['DESCRIPTION'] = String(data['DESCRIPTION']).substring(0,this.config['MAX_TOKEN_DESCRIPTION']);
        } else if(action=='SLEEP'){
            // Truncate RESUME_BLOCK to 25 characters
            if(!this.util.isNull(data['RESUME_BLOCK'])) 
                data['RESUME_BLOCK'] = String(data['RESUME_BLOCK']).substring(0,25);
        }
        // Truncate MEMO  to 250 characters
        if(!this.util.isNull(data['MEMO']))
            data['MEMO'] = String(data['MEMO']).substring(0,250);
        return data;
    }

    // Get EVERY decoder reorg event newer than the one the indexer last processed, oldest
    // first, each as {id, block_index} where block_index is that event's deepest (lowest)
    // orphaned block. A single-newest-event reader would drop the older, deeper reorg when
    // two reorgs land between indexer iterations and the newer one is shallower, leaving
    // orphaned rows below the rollback point.
    // Processing the full set (and rolling back to the minimum block across it) closes that
    // gap. afterId is the decoder event id from getLastProcessedReorgId (null = none yet).
    // Stable hash of a decoder REORG event's `data` payload, used as the reorg-marker witness
    // (#2735). sha256 hex; null/undefined data hashes the empty string so a missing payload has a
    // deterministic witness rather than throwing.
    _hashReorgData(data){
        const crypto = require('crypto');
        return crypto.createHash('sha256').update(String(data == null ? '' : data), 'utf8').digest('hex');
    }

    // Build the canonical RE-1 (reorg cursor incoherent) error. One shared shape + operator
    // recovery guidance for every incoherence cause (over-cursor, missing cursor row, witness
    // mismatch), so the message never drifts. `detail` names the specific cause.
    _reorgCursorIncoherentError(detail){
        return new Error('Reorg cursor incoherent (RE-1): ' + detail + ' The decoder DB was likely ' +
            'rebuilt or restored out-of-band; rollback detection would be silently disabled. ' +
            'Recovery: rebuild decoder+indexer jointly (clean reindex), or restore a matching decoder DB.');
    }

    // Handle getting block transaction data for a given block from xchain-decoder database
    async getDecoderBlockData(block_index){
        let data = [];
        let query = `SELECT
                        t1.data,
                        t1.raw_data,
                        t2.hash as tx_hash,
                        a1.address as source,
                        a2.address as destination,
                        t1.fee,
                        t1.block_index,
                        b1.block_time,
                        t3.vout,
                        t3.amount as coin_amount,
                        a3.address as output_destination,
                        p1.pubkey as source_pubkey
                    FROM
                        transactions t1
                        INNER JOIN blocks              b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_transactions  t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN transaction_outputs t3 ON (t3.tx_index=t1.tx_index)
                        LEFT  JOIN index_addresses     a1 ON (a1.id=t1.source_id)
                        LEFT  JOIN index_addresses     a2 ON (a2.id=t1.destination_id)
                        LEFT  JOIN index_addresses     a3 ON (a3.id=t3.destination_id)
                        LEFT  JOIN pubkeys             p1 ON (p1.address_id=t1.source_id)
                    WHERE
                        t1.block_index=?
                    ORDER BY
                        t1.tx_index ASC,
                        t3.vout ASC`;
        // doQueryStrict (not doQuery): this reads block transactions from decoderDb, which
        // never opens a transaction, so doQuery would collapse a transient read fault to []
        // - indistinguishable from a genuinely empty block. The caller would then commit an
        // empty block and advance lastIndexerBlock, permanently dropping every action in the
        // block and forking the hash chain. Throwing instead lets the block-level catch roll
        // back and retry (lastIndexerBlock stays un-advanced). A genuinely empty block still
        // returns [] via the length check below; only a failed query throws.
        let results = await this.doQueryStrict(query, [block_index]);
        if(results.length > 0){
            // First pass: collect the stored outputs for each transaction so every emitted row can
            // carry the full output set. The indexer uses this for native-coin fee detection
            // (xchain-indexer/src/utility.js detectFeePaymentMode / validateNativeCoinFee). The
            // decoder persists the fee-destination output (and COINPAY/dispense outputs) to
            // transaction_outputs.
            let outputsByTx = {};
            for(let row of results){
                if(this.util.isNull(row.output_destination))
                    continue;
                let key = row.tx_hash;
                if(!outputsByTx[key])
                    outputsByTx[key] = [];
                outputsByTx[key].push({
                    vout:    this.util.isNull(row.vout) ? 0 : row.vout,
                    address: row.output_destination,
                    value:   row.coin_amount
                });
            }
            for(let key in outputsByTx)
                outputsByTx[key].sort((a, b) => Number(a.vout) - Number(b.vout));

            for(let row of results){
                if(!this.util.isNull(row.output_destination))
                    row.destination = row.output_destination;
                row.amount = this.util.isNull(row.coin_amount) ? null : row.coin_amount;
                if(this.util.isNull(row.vout))
                    row.vout = 0;
                // Full output set for this transaction (used by native-coin fee validation)
                row.tx_outputs = outputsByTx[row.tx_hash] || [];
                delete row.output_destination;
                delete row.coin_amount;
                data.push(row);
            }
        }
        return data;
    }

    // Handle getting block time for a given block. Memoized (last-block-wins, see
    // this._blockTimeCache in the constructor): block_time is constant per block_index, and
    // protocol_changes.isEnabled() calls this repeatedly per block under the hot per-action path.
    // PROTOCOL time for a block: what every time-keyed consensus reader should use.
    //
    // On networks switched to median-time-past (see protocol_time.js) this is the
    // median of the previous 11 block timestamps rather than the block's own stamp.
    // The raw stamp is chosen by whoever mined the block and Bitcoin accepts it up
    // to ~2h ahead of network-adjusted time; on testnet4 that is not hypothetical,
    // the chain rides its 20-minute minimum-difficulty rule and stamps every block
    // ~1201s ahead of its parent. Reading mirrored hub data at a future instant is
    // what forced the mirror barriers to wait for wall clock to catch up, which is
    // what made a confirmed transaction take hours to index.
    //
    // Applied HERE rather than at each call site on purpose: this is the single
    // seam every protocol reader already flows through (actions.js, protocol
    // changes, the six mirror barriers), so they all move together. A reader left
    // on the raw stamp while the barriers move is the combination that forks.
    // Storage and display must NOT use this - createBlock and the chain-tip push
    // take getRawBlockTime, so the timestamp we persist and show stays the real one.
    async getBlockTime(block_index){
        let key = Number(block_index);
        // Lazily created: this method is also reached through hand-built Database
        // doubles that predate the memo, and an absent cache must degrade to "always
        // recompute" rather than throwing on the consensus path.
        if(!this._protocolTimeCache)
            this._protocolTimeCache = { block_index: null, block_time: null };
        if(this._protocolTimeCache.block_index === key)
            return this._protocolTimeCache.block_time;
        let raw = await this.getRawBlockTime(block_index);
        let network = (this.config) ? this.config['NETWORK'] : undefined;
        let protocolTimeValue = raw;
        if(protocolTime.isProtocolTimeMtpActive(network) && raw !== false){
            let previous = await this.getPreviousBlockTimes(key, protocolTime.MEDIAN_TIME_SPAN);
            protocolTimeValue = protocolTime.protocolTime(network, raw, previous);
        }
        // Never memoize an unresolvable lookup, for the same reason the raw reader
        // does not: the retry must re-query against a healthy DB.
        if(raw !== false){
            this._protocolTimeCache.block_index = key;
            this._protocolTimeCache.block_time  = protocolTimeValue;
        }
        return protocolTimeValue;
    }

    // Invalidate the single-entry getBlockTime() memo. A reorg replaces the content of an
    // already-processed height: the decoder re-inserts the new-chain block with a new
    // block_time, and the indexer's blocks row for that height is deleted by rollback. The
    // memo is keyed by height ONLY, so on a depth-1 reorg the replay of the same height would
    // otherwise return the orphaned chain's stale block_time (a cache hit), feeding the wrong
    // timestamp into time-gated consensus logic (ProtocolChanges.isEnabled, fee-price gate,
    // createBlock). Rollback calls this on BOTH DB instances after commit so the replay
    // re-reads the new chain's block_time. Mirrors the decoder's per-height reorg clear.
    clearBlockTimeCache(){
        this._blockTimeCache    = { block_index: null, block_time: null };
        // The protocol-time memo is derived from the raw one AND from the 11 blocks
        // below it, so a reorg invalidates it for the same reason and then some: the
        // replayed height can shift the median even when its own stamp is unchanged.
        this._protocolTimeCache = { block_index: null, block_time: null };
    }

    // Invalidate the light-client touched-key resolver memos (_smtTickNameCache /
    // _smtAddressNameCache), which map a dense surrogate id to its canonical name.
    //
    // THE MEMOS ARE ONLY VALID FOR AS LONG AS THE ID ASSIGNMENTS THEY SAW SURVIVE.
    // A dense id is handed out as MAX(id)+1 (getNextTickerId / getNextAddressId), so
    // anything that REMOVES the row hands the same id straight back to the next
    // caller. A reorg is one way (rollback.js deletes rows and commits, and clears
    // these there). A TRANSACTION ROLLBACK is the other, and it was missed for three
    // investigations: the ids an aborted transaction assigned are un-assigned by the
    // abort, while the id -> name memo it filled survives in process memory.
    //
    // The rolled-back writer that matters is not the block loop, it is the READ-ONLY
    // dry run behind /feequote and /preflight (actions.js computeDryRun): it runs the
    // real handler inside a transaction it ALWAYS rolls back, so an ISSUE that is
    // merely quoted still interns its tick, still reaches createLedgerChangeRecord,
    // and still fills this memo with id -> the quoted name. Nothing is ever
    // broadcast, the id is freed, and the next real ISSUE/MINT/SEND takes that id -
    // at which point the choke point records the touched key under the QUOTED name.
    // The ledger names the real one, the commitment applies the quoted one, and the
    // touched-set guard refuses the block. That is a HARD WEDGE: the block retries
    // forever, because the poisoned entry lives in memory that no retry clears, which
    // is why a process restart (and only a process restart) fixed it every time.
    //
    // Called from rollbackTransaction() and from commitTransaction()'s failure
    // rollback, i.e. wherever assigned ids are un-assigned. Clearing is cheap (pure
    // memoisation, refilled lazily on the next block's first touch of each id);
    // invalidating per id would mean enumerating rows the abort has already erased.
    clearSmtNameCaches(){
        this._smtTickNameCache    = null;
        this._smtAddressNameCache = null;
    }

    // True when the poll's cached fingerprint equals `fingerprint` (no input changed since the
    // last tally, so the full re-tally can be skipped). Missing entry (first sight this process,
    // or just-cleared by a reorg) never matches, forcing a full tally.
    pollTallyWatermarkMatches(pollIndex, fingerprint){
        return this._pollTallyWatermark.get(Number(pollIndex)) === fingerprint;
    }

    // Record the fingerprint at which the poll was last tallied WITHOUT early-deciding.
    setPollTallyWatermark(pollIndex, fingerprint){
        this._pollTallyWatermark.set(Number(pollIndex), fingerprint);
    }

    // Drop a single poll's watermark (called once it finalizes so a reused action_index can never
    // rehydrate a stale hit).
    clearPollTallyWatermarkEntry(pollIndex){
        this._pollTallyWatermark.delete(Number(pollIndex));
    }

    // Drop ALL cached poll watermarks. Called from rollback.js after a reorg commits, alongside
    // clearBlockTimeCache: a reorg can delete and re-add ledger/vote/delegation rows at or above
    // the reorg block (and reuse action_index values), so every cached fingerprint is suspect.
    clearPollTallyWatermark(){
        this._pollTallyWatermark = new Map();
    }

    // Return the canonical per-block leaf rows (ledger/actions/contracts) in the
    // EXACT order getBlockHashes hashes them, for the light-client block_merkle_root
    // (SPV spec §5.1). Reuses the warm getBlockHashes stash; recomputes only if the
    // stash is cold/stale (e.g. a standalone proof-rebuild path).
    async getBlockLeafRows(block_index){
        if(!this._lastGatheredBlockRows || Number(this._lastGatheredBlockRows.block_index) !== Number(block_index))
            await this.getBlockHashes(block_index);
        return this._lastGatheredBlockRows;
    }

    // F1a recovery reward apply hook. Called from createAddress right after an address
    // first receives its deterministic in-block id. Cheap-gates on a one-time-probed count
    // of unapplied staged rewards so normal indexing (no recovery in progress) pays a single
    // COUNT(*) and then short-circuits on every later call. See the constructor flags above
    // and recovery.js for the staging side.
    async _maybeApplyPendingRewards(address, source_id, materializedBlock){
        if(source_id === null || source_id === undefined)
            return;
        if(!await this._probeRecoveryPending())
            return;
        // Stamp applied_block = the block this address was first seen at (createAddress
        // passes its block context). It is the forward-window key xchain-sync streams
        // these by; without it a materialization whose earn-block sits below a follower's
        // incremental cursor never reaches the follower (the reorg re-drain is the acute
        // case, but a recovery-then-incremental-catch-up has the same gap).
        let applied = await this._applyPendingRewardsForAddress(address, source_id, materializedBlock);
        this._recoveryPendingRemaining -= applied;
    }

    // The block a recovery-restored reward claims as its MATERIALIZATION block, from the
    // earn-block the ANCHOR archive carries. Thin wrapper so both the apply path and the
    // due sweep read the one rule (anchor_reward_activation.restoredRewardDeriveHeight):
    // the restored row claims the height the LIVE fleet derived it at
    // (earn + ANCHOR_REWARD_MIRROR_MATURITY), never the height recovery re-applied it at.
    // null below the derive flag-day / on an inert network, where the legacy NULL stamp stands.
    _restoredRewardDeriveBlock(earnBlock){
        let network = String((this.config && this.config['NETWORK']) || '');
        return ar.restoredRewardDeriveHeight(earnBlock, network);
    }

    // Whether the strict `^<id>` rejection is in effect at `block_index` on
    // this indexer's chain. Wrapper so handlers gate on the same predicate
    // resolveAddressRefChecked uses without re-deriving network/coin.
    // @param {block_index}  integer  block being processed
    isCaretRefStrictActive(block_index){
        return caretRefStrict.isCaretRefStrictActive(block_index, this.config['NETWORK'], this.config['COIN']);
    }

    // Resolve a wire ^<id> address reference AND state the activation-gated verdict
    // on it. THE call action handlers should use: resolveAddressRef alone reports a
    // malformed/dangling reference only by leaving the value untouched, which is safe
    // solely while every caller remembers to format-check the field afterwards (see
    // caret_ref_strict_activation.js for the three call sites where that does not
    // hold, and for what the same omission cost on SEND).
    //
    // Returns { value, rejected }:
    //   value    - the resolved address, or the input unchanged when resolution failed.
    //              IDENTICAL in both eras: the verdict never rides inside the value,
    //              because handlers persist their cloned `data` row even for invalid
    //              actions and a sentinel would silently rewrite the stored bytes.
    //   rejected - true only at/after the flag-day AND when the value is still a
    //              caret reference (resolution failed). Below the flag-day, or with no
    //              block context, always false: legacy fail-open, replay byte-identical.
    // @param {value}        string   wire field value (may be a full address, a ^<id>, or null)
    // @param {block_index}  integer  block being processed (data['BLOCK_INDEX'])
    async resolveAddressRefChecked(value, block_index){
        let resolved = await this.resolveAddressRef(value);
        let rejected = caretRefStrict.isUnresolvedCaretRef(resolved)
            && this.isCaretRefStrictActive(block_index);
        return { value: resolved, rejected: rejected };
    }

    // Handles returning the highest tx_index from transactions table
    async getNextTxIndex(){
        let idx   = 0;
        let query = "SELECT tx_index FROM transactions ORDER BY tx_index DESC LIMIT 1";
        let results = await this.doQuery(query);
        if(results.length > 0)
            idx = Number(results[0].tx_index);
        // Increase current tx_index by 1 to get the next tx_index
        idx++;
        return idx;
    }

    // Lookup a record in the `transactions` table and return record id
    async getTxIndex(hash){
        let tx_index = null;
        let hash_id  = await this.createTransaction(hash);
        let query = "SELECT tx_index FROM transactions WHERE tx_hash_id=? LIMIT 1";
        let results = await this.doQuery(query, [hash_id]);
        if(results.length > 0)
            tx_index = Number(results[0].tx_index);
        return tx_index;
    }

    // Create records in the 'transactions' table and return record id
    async createTxIndex(data){
        let tx_index = await this.getTxIndex(data.TX_HASH);
        // Handle creating record
        if(tx_index==null){
            tx_index        = await this.getNextTxIndex();
            let block_index = data.BLOCK_INDEX;
            let source_id   = await this.createAddress(data.SOURCE);
            let tx_hash_id  = await this.createTransaction(data.TX_HASH);
            let fee         = (data.FEE !== undefined && data.FEE !== null) ? data.FEE : null;
            let tx_data     = (data.TX_DATA !== undefined && data.TX_DATA !== null) ? data.TX_DATA : null;
            let query       = "INSERT INTO transactions (tx_index, block_index, tx_hash_id, source_id, fee, data) values (?, ?, ?, ?, ?, ?)";
            let results     = await this.doQuery(query, [tx_index, block_index, tx_hash_id, source_id, fee, tx_data]);
            // Store source pubkey mapping if the decoder provided one
            if(data.SOURCE_PUBKEY && source_id)
                await this.createPubkey(source_id, data.SOURCE_PUBKEY);
        }
        return tx_index;
    }

    // Get token supply for a given ticker from tokens table
    async getTokenSupplyToken(tick){
        let supply   = 0;
        let tick_id  = await this.createTicker(tick);
        let decimals = await this.getTokenDecimalPrecision(tick_id);
        let query = `SELECT supply FROM tokens WHERE tick_id=? LIMIT 1`;
        let results = await this.doQuery(query, [tick_id]);
        if(results.length > 0 && !this.util.isNull(results[0].supply))
            supply = results[0].supply;
        return supply;
    }

    // Determine if an ticker is distributed to users (held by more than owner)
    // @param {tick}            string  Ticker name
    // @param {block_index}     integer Block Index 
    // @param {action_index}    integer action_index of action
    async isDistributed(tick, block_index, action_index, tokenInfo=null){
        let info    = tokenInfo ?? await this.getTokenInfo(tick, block_index, action_index);
        let holders = (info) ? await this.getHolders(tick, block_index, action_index) : [];
        // More than one holder
        if(Object.keys(holders).length>1)
            return true;
        // Holder that is not OWNER
        for(let address in holders)
            if(address!=info['OWNER'])
                return true;
        return false;
    }

    // Validate if a list is a valid type
    // @param {action_index}  integer  ACTION_INDEX to a list
    // @param {type}          string   List Type (1=TICK, 2=ADDRESS)
    async isValidList(action_index, type){
        let list_type = await this.getListType(action_index);
        if(list_type==type)
            return true;
        return false;
    }

    // Whether the LIST edit-chain resolution is in effect at `block_index`
    // on this indexer's chain. Wrapper so action handlers gate on the same
    // predicate getList uses without re-deriving network/coin.
    // @param {block_index}  integer  block being processed
    isListEditResolutionActive(block_index){
        return listEditResolution.isListEditResolutionActive(block_index, this.config['NETWORK'], this.config['COIN']);
    }

    // Create/Update record in `tokens` table
    async createToken(data){
        data                   = this.normalizeDataValues(data);
        let supply             = (!this.util.isNull(data['SUPPLY']) &&               this.util.isNumeric(data['SUPPLY'])) ? data['SUPPLY'] : 0;
        let max_supply         = (!this.util.isNull(data['MAX_SUPPLY']) &&           this.util.isNumeric(data['MAX_SUPPLY'])) ? data['MAX_SUPPLY'] : 0;
        let max_mint           = (!this.util.isNull(data['MAX_MINT']) &&             this.util.isNumeric(data['MAX_MINT'])) ? data['MAX_MINT'] : 0;
        let mint_supply        = (!this.util.isNull(data['MINT_SUPPLY']) &&          this.util.isNumeric(data['MINT_SUPPLY'])) ? data['MINT_SUPPLY'] : 0;
        let mint_address_max   = (!this.util.isNull(data['MINT_ADDRESS_MAX']) &&     this.util.isNumeric(data['MINT_ADDRESS_MAX'])) ? data['MINT_ADDRESS_MAX'] : 0;
        let mint_start_block   = (!this.util.isNull(data['MINT_START_BLOCK']) &&     this.util.isNumeric(data['MINT_START_BLOCK'])) ? data['MINT_START_BLOCK'] : 0;
        let mint_stop_block    = (!this.util.isNull(data['MINT_STOP_BLOCK']) &&      this.util.isNumeric(data['MINT_STOP_BLOCK'])) ? data['MINT_STOP_BLOCK'] : 0;
        let callback_amount    = (!this.util.isNull(data['CALLBACK_AMOUNT']) &&      this.util.isNumeric(data['CALLBACK_AMOUNT'])) ? data['CALLBACK_AMOUNT'] : 0;
        let allow_list         = (!this.util.isNull(data['ALLOW_LIST']) &&           this.util.isNumeric(data['ALLOW_LIST'])) ? parseInt(data['ALLOW_LIST']) : null;
        let block_list         = (!this.util.isNull(data['BLOCK_LIST']) &&           this.util.isNumeric(data['BLOCK_LIST'])) ? parseInt(data['BLOCK_LIST']) : null;
        let decimals           = (!this.util.isNull(data['DECIMALS']) &&             this.util.isNumeric(data['DECIMALS'])) ? parseInt(data['DECIMALS']) : 0;
        // Token-bridge opt-in, PARSED state (the issues row above keeps the raw wire text).
        // The '-' sentinel is the wire spelling of "no destination chains" and lands here as
        // NULL, so this column always reads as the effective destination list: empty means
        // not bridgeable, which is what the explorer, the wallet and the hub's poll want.
        // MIN_DEPTH is raise-only, so an absent value is NULL and the federation falls back
        // to the platform confirmation depth. `bridged` is deliberately NOT written here: it
        // is set by the first applied XBRIDGE v3 lock and no ISSUE may set or clear it.
        let bridge_chains      = (!this.util.isNull(data['BRIDGE_CHAINS']) && String(data['BRIDGE_CHAINS']) !== '-') ? String(data['BRIDGE_CHAINS']) : null;
        let min_depth          = (!this.util.isNull(data['MIN_DEPTH']) &&            this.util.isNumeric(data['MIN_DEPTH'])) ? parseInt(data['MIN_DEPTH']) : null;
        let lock_bridge        = (data['LOCK_BRIDGE']==1) ? 1 : 0;
        // Force any amount values to the correct decimal precision
        if(this.util.isNumeric(decimals) && decimals >= this.config.MIN_TOKEN_DECIMALS && decimals <= this.config.MAX_TOKEN_DECIMALS){
            max_supply         = this.util.bcformat(max_supply, decimals);
            max_mint           = this.util.bcformat(max_mint, decimals);
            mint_supply        = this.util.bcformat(mint_supply, decimals);
            mint_address_max   = this.util.bcformat(mint_address_max, decimals);
            // callback_amount    = this.util.bcformat(callback_amount, decimals);
        }
        let description        = data['DESCRIPTION'];
        let action_index       = data['ACTION_INDEX'];
        // Force lock fields to integer values 
        let lock_max_supply    = (data['LOCK_MAX_SUPPLY']==1) ? 1 : 0;
        let lock_mint          = (data['LOCK_MINT']==1) ? 1 : 0;
        // LOCK_MINT_SUPPLY is the seventh token lock and is folded by getTokenInfo() from the
        // issues rows like the other six. It was missing from this derivation (and from the
        // INSERT/UPDATE below), so tokens.lock_mint_supply sat at its column default forever
        // and every read API reported the lock unset even where the chain enforces it (#).
        // Consensus never depended on this column (issue.js re-folds `issues`), but the wallet's
        // mint form and lock matrix read it and would offer a mint/lock the chain then rejects.
        let lock_mint_supply   = (data['LOCK_MINT_SUPPLY']==1) ? 1 : 0;
        let lock_max_mint      = (data['LOCK_MAX_MINT']==1) ? 1 : 0;
        let lock_description   = (data['LOCK_DESCRIPTION']==1) ? 1 : 0;
        let lock_sleep         = (data['LOCK_SLEEP']==1) ? 1 : 0;
        let lock_callback      = (data['LOCK_CALLBACK']==1) ? 1 : 0;
        let callback_block     = (data['CALLBACK_BLOCK']>0) ? data['CALLBACK_BLOCK'] : 0;
        let callback_tick_id   = await this.createTicker(data['CALLBACK_TICK']);
        let tick_id            = await this.createTicker(data['TICK']);
        let owner_id           = await this.createAddress(data['OWNER']);
        // Check if record already exists for this token
        let query  = "SELECT id FROM tokens WHERE tick_id=? LIMIT 1";
        let exists = false;
        let results = await this.doQuery(query, [tick_id]);
        if(results.length > 0)
            exists = true;
        let args = [];
        if(exists){
            // UPDATE record
            query = `UPDATE
                        tokens
                    SET
                        max_supply=?,
                        max_mint=?,
                        decimals=?,
                        description=?,
                        lock_max_supply=?,
                        lock_mint=?,
                        lock_mint_supply=?,
                        lock_max_mint=?,
                        lock_description=?,
                        lock_sleep=?,
                        lock_callback=?,
                        callback_block=?,
                        callback_tick_id=?,
                        callback_amount=?,
                        allow_list=?,
                        block_list=?,
                        mint_address_max=?,
                        mint_start_block=?,
                        mint_stop_block=?,
                        bridge_chains=?,
                        min_depth=?,
                        lock_bridge=?,
                        supply=?,
                        owner_id=?,
                        last_action_index=?
                    WHERE
                        tick_id=?`;
            args = [max_supply, max_mint, decimals, description, lock_max_supply, lock_mint, lock_mint_supply, lock_max_mint,lock_description, lock_sleep, lock_callback, callback_block, callback_tick_id, callback_amount, allow_list, block_list, mint_address_max, mint_start_block, mint_stop_block, bridge_chains, min_depth, lock_bridge, supply, owner_id, action_index, tick_id];
        } else {
            // INSERT record
            query = `INSERT INTO tokens (
                        max_supply, 
                        max_mint, 
                        decimals, 
                        description, 
                        lock_max_supply,
                        lock_mint,
                        lock_mint_supply,
                        lock_max_mint,
                        lock_description,
                        lock_sleep,
                        lock_callback,
                        callback_block,
                        callback_tick_id,
                        callback_amount,
                        allow_list,
                        block_list,
                        mint_address_max,
                        mint_start_block,
                        mint_stop_block,
                        bridge_chains,
                        min_depth,
                        lock_bridge,
                        supply,
                        owner_id,
                        action_index,
                        last_action_index,
                        tick_id
                    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            args    = [max_supply, max_mint, decimals, description, lock_max_supply, lock_mint, lock_mint_supply, lock_max_mint,lock_description, lock_sleep, lock_callback, callback_block, callback_tick_id, callback_amount, allow_list, block_list, mint_address_max, mint_start_block, mint_stop_block, bridge_chains, min_depth, lock_bridge, supply, owner_id, action_index, action_index, tick_id];
        }
        results = await this.doQuery(query, args);

    }

    // Create / Update record in `credits` table
    async createCredit(action_index, tick, amount, address){
        await this.createLedgerChangeRecord('credits', action_index, tick, amount, address);
    }

    // Create / Update record in `debits` table
    async createDebit(action_index, tick, amount, address){
        await this.createLedgerChangeRecord('debits', action_index, tick, amount, address);
    }

    // Create / Update record in `escrows` table
    async createEscrow(action_index, tick, amount, address){
        await this.createLedgerChangeRecord('escrows', action_index, tick, amount, address);
    }

    // Get address balances using credits/debits table data
    async getAddressBalances(address, tick, block_index, action_index){
        let type       = typeof address;
        let address_id = null;
        if(type==='number' && this.util.isNumeric(address))
            address_id = address;
        if(type==='string')
            address_id = await this.createAddress(address);
        let [credits, debits] = await Promise.all([
            this.getAddressCreditDebit('credits', address_id, null, block_index, action_index),
            this.getAddressCreditDebit('debits',  address_id, null, block_index, action_index)
        ]);
        let balances = {}; // Object to store tick_id/balance
        // Build out balances (credits - debits).
        // Compute at full (18-decimal) precision rather than the token's own
        // precision: rounding here per-address causes sum-of-rounded-balances
        // to drift from rounded-sum-of-ledger when a token's decimals are too
        // low to represent the underlying ledger values (e.g. fractional VM
        // gas fees against a tick issued with decimals=0). The sanityCheck's
        // DECIMAL(60, decimals) cast rounds the aggregate sum the same way on
        // both sides, so as long as per-address balances stay exact, both
        // paths agree.
        for(let tick_id in credits){
            let credit  = credits[tick_id];
            let debit   = (!this.util.isNull(debits[tick_id])) ? debits[tick_id] : 0;
            let balance = null;
            try {
                balance = this.util.bcsub(credit, debit, 18);
            } catch(err){
                balance = this.util.bcadd(0, 0, 18);
            }
            // Pass forward any numeric values (including 0 balance)
            if(this.util.isNumeric(balance))
                balances[tick_id] = balance;
        }
        return balances;
    }

    // Handle updating token information (supply, price, etc)
    // @param {tickers} boolean Full update
    // @param {tickers} string  Ticker 
    // @param {tickers} array   Array of Tickers
    async updateTokens(tickers, rollback){
        let tokens = [];
        let type   = typeof tickers;
        if(type==='object'){
            for(let tick of tickers){
                if(!this.util.isNull(tick))
                    tokens.push(tick);
            }
        }
        if(type==='string')
            tokens.push(tickers);
        // Dump full list of tokens
        if(type==='boolean' && tickers===true){
            console.log('Updating all tokens...');
            let query = "SELECT t2.tick FROM tokens t1, index_tickers t2 WHERE t1.tick_id=t2.id";
            let results = await this.doQuery(query);
            if(results.length > 0)
                for(let row of results)
                    tokens.push(row.tick);
        }
        // Loop through tokens and update basic info
        await Promise.all(tokens.map(t => this.updateTokenInfo(t)));
    }

    // Handle getting token info (supply, price, etc) and updating the `tokens` table
    async updateTokenInfo(tick){
        // createTicker and getTokenInfo are independent; run them concurrently.
        // tick_id is unused here - createToken calls createTicker internally.
        const [, data] = await Promise.all([this.createTicker(tick), this.getTokenInfo(tick)]);
        // Update the record in `tokens` table
        if(data)
            await this.createToken(data);
    }

    // Mark a token's ownership as held in escrow by an ORDER/SWAP/DISPENSER action.
    // While set, owner-only actions targeting this tick are rejected; on cancel/expire/match
    // the corresponding action handler calls clearTokenEscrow() to release.
    async setTokenEscrow(tick, action_index){
        let tick_id = await this.createTicker(tick);
        let query   = "UPDATE tokens SET escrow_action_index=? WHERE tick_id=?";
        await this.doQuery(query, [action_index, tick_id]);
    }

    // Release a token's ownership escrow.
    async clearTokenEscrow(tick){
        let tick_id = await this.createTicker(tick);
        let query   = "UPDATE tokens SET escrow_action_index=NULL WHERE tick_id=?";
        await this.doQuery(query, [tick_id]);
    }

    // Returns the action_index of the offer holding this tick's ownership in escrow, or null
    // if ownership is not currently escrowed. Used by ISSUE v1-5 / CALLBACK / SLEEP / LINK /
    // FILE / child-ISSUE handlers to reject owner-only actions during escrow.
    async getTokenEscrow(tick){
        if(this.util.isNull(tick))
            return null;
        let tick_id = await this.createTicker(tick);
        let query   = "SELECT escrow_action_index FROM tokens WHERE tick_id=? LIMIT 1";
        let results = await this.doQuery(query, [tick_id]);
        if(results.length === 0 || this.util.isNull(results[0].escrow_action_index))
            return null;
        return results[0].escrow_action_index;
    }

    // Convenience wrapper - true if this tick's ownership is currently escrowed.
    async isOwnershipEscrowed(tick){
        return (await this.getTokenEscrow(tick)) !== null;
    }

    // Validate if a ticker exists before before a given action_index
    async validTickerBeforeTxIndex(tick, action_index){
        let issue_index = await this.getFirstIssueActionIndex(tick);
        if(issue_index !== false && issue_index < action_index)
            return true;
        return false;
    }

    // Is `address` well-formed for THIS chain, or - at/above
    // TOKEN_POLICY_INHERITANCE_ACTIVATION - for ANY coin the platform supports on this
    // network? A loop over the existing coin-and-network-aware validator, never a new
    // validator, so the address rules stay in one place.
    //
    // WHY THE WIDENING EXISTS: a bridged copy inherits ONE list from its origin row, so that
    // list has to be able to name holders on every chain a copy lives on. Below the flag the
    // one-argument call resolves to this chain's coin and a foreign-format address is simply
    // not an address here, which is the historical rule and stays byte-identical on replay.
    //
    // Prefix sharing makes some strings valid on more than one chain (regtest BTC, LTC and
    // DOGE all use p2pkh 0x6f / p2sh 0xc4). That is harmless in both consumers: membership
    // matching is exact string equality, so a string valid on two chains is simply that
    // string on both.
    // @param {address}      string   address to judge
    // @param {block_index}  integer  block being processed; gates the widening
    isAnyCoinAddress(address, block_index){
        if(this.util.isCryptoAddress(address))
            return true;
        if(!tokenPolicyActivation.isTokenPolicyInheritanceActive(block_index, this.config['NETWORK']))
            return false;
        for(let coin of (this.config['COINS'] || []))
            if(this.util.isCryptoAddress(address, coin, this.config['NETWORK']))
                return true;
        return false;
    }

    // Check if an address is allowed to perform an action
    // Validations: 
    // - Ticker  is allowed to perform actions (sleep)
    // - Address is allowed to perform actions (sleep)
    // - Address is allowed to hold tick (allow/block lists)
    async isActionAllowed(address, tick, block_index){
        let allow = true;
        // Validate block_index is good
        if(allow && !this.util.isNull(block_index) && this.util.isNumeric(block_index)){
            // Validate TICK and ADDRESS sleep status in parallel
            const [tickSleeping, addressSleeping] = await Promise.all([
                (!this.util.isNull(tick))     ? this.isTickSleeping(tick, block_index)       : Promise.resolve(false),
                (!this.util.isNull(address))  ? this.isAddressSleeping(address, block_index) : Promise.resolve(false)
            ]);
            if(tickSleeping || addressSleeping)
                allow = false;
        }
        // Validate address against any tick allow/block lists
        if(allow && !this.util.isNull(address) && !this.util.isNull(tick)){
            let info = await this.getTokenInfo(tick, block_index);
            // Fetch allow/block lists in parallel if both exist
            const hasAllowList = info && !this.util.isNull(info['ALLOW_LIST']) && this.util.isNumeric(info['ALLOW_LIST']);
            const hasBlockList = info && !this.util.isNull(info['BLOCK_LIST']) && this.util.isNumeric(info['BLOCK_LIST']);
            const [allowList, blockList] = await Promise.all([
                hasAllowList ? this.getList(info['ALLOW_LIST'], block_index) : Promise.resolve(null),
                hasBlockList ? this.getList(info['BLOCK_LIST'], block_index) : Promise.resolve(null)
            ]);
            // False if we have an ALLOW_LIST and address is NOT on it
            if(allow && allowList && !allowList.includes(address))
                allow = false;
            // False if we have a BLOCK_LIST and address IS on it
            if(allow && blockList && blockList.includes(address))
                allow = false;
        }
        return allow;
    }

    // Get total amount of credit or debit records for a given address, ticker, and action
    async getActionCreditDebitAmount(table, action, tick, address, action_index){
        let total   = 0;
        let tick_id = await this.createTicker(tick);
        let addr_id = await this.createAddress(address);
        let data    = await this.getAddressCreditDebit(table, addr_id, action, null, action_index);
        if(data[tick_id])
            total = data[tick_id];
        return total;
    }

    // Validate that token supplys match credits/debits/balances information
    async sanityCheck(block_index){
        // Ignore any calls without a block index
        if(this.util.isNull(block_index))
            return;
        let tickers  = {};
        let decimals = {};
        // Get list of tickers and supply from credits/debits/escrows/tokens tables using block_index
        let query   = `SELECT
                        DISTINCT(x.tick_id),
                        t2.tick,
                        t1.decimals
                    FROM
                        (
                            -- Scope the touched-tick set by the ACTION's own block_index, NOT by
                            -- joining transactions on tx_index: a block whose only ledger effect is
                            -- a synthetic action (e.g. an UNSTAKE v2 cooldown completion, tx_index
                            -- NULL) would otherwise contribute no tick and skip the sanity check for
                            -- it, hiding the imbalance until a later real-tx block for that tick.
                            SELECT
                                c.tick_id
                            FROM
                                credits c
                                INNER JOIN actions a ON (c.action_index=a.action_index)
                            WHERE
                                a.block_index=?
                            UNION
                            SELECT
                                d.tick_id
                            FROM
                                debits d
                                INNER JOIN actions a ON (d.action_index=a.action_index)
                            WHERE
                                a.block_index=?
                            UNION
                            SELECT
                                e.tick_id
                            FROM
                                escrows e
                                INNER JOIN actions a ON (e.action_index=a.action_index)
                            WHERE
                                a.block_index=?
                        ) as x
                        INNER JOIN tokens        t1 ON (t1.tick_id=x.tick_id)
                        INNER JOIN index_tickers t2 ON (t2.id=x.tick_id)
                    ORDER BY 
                        t2.tick ASC`;
        let results = await this.doQuery(query, [block_index, block_index, block_index]);
        if(results.length >0){
            for(let row of results){
                // Add ticker, decimal, and supply info to assoc arrays
                tickers[row.tick]  = Number(row.tick_id);
                decimals[row.tick] = row.decimals;
            };
        }
        // Batch the four per-tick aggregates into GROUP BY queries over the block's
        // touched-tick set, reusing the tick_id/decimals already selected above (#1842).
        // The former per-tick loop issued getTokenSupply/Token/Balance/Escrow serially,
        // each re-running createTicker + getTokenDecimalPrecision and (getTokenSupply with
        // no block scope) three FULL-HISTORY SUM scans, so cost grew ~14 round-trips per
        // touched tick per block and tracked ledger history. This collapses to a handful
        // of queries per block regardless of tick count. Semantics are preserved exactly:
        // the same DECIMAL(60,d) CAST (grouped by d so the scale stays per-tick-correct),
        // the same action-scoped ledger sums vs unjoined balances/escrow-total sums, the
        // same three-way compare and SanityError messages.
        let tickList = Object.keys(tickers);
        if(tickList.length === 0)
            return;
        // tick_id -> tick name, and the flat id list.
        let idToTick = {};
        let allIds   = [];
        for(let tick of tickList){
            let id = tickers[tick];
            idToTick[id] = tick;
            allIds.push(id);
        }
        // Run ONE GROUP BY SUM over the touched-tick set per table. joinActions mirrors
        // getTokenSupply's `INNER JOIN actions` for the ledger credit/debit/escrow sums;
        // the balances and escrow-TOTAL sums are unjoined, exactly like
        // getTokenSupplyBalance/getTokenSupplyEscrow. Returns tick_id -> summed string.
        //
        // Summed at the EXACT ledger scale (18 dp), not per-tick DECIMAL(60,d), so
        // the per-decimal query grouping is gone with it. The three
        // projections compared below each round ONCE, at the tick's own scale: the
        // ledger side rounds when escrows are folded in, the total side when
        // balances and escrows are added. That is the only shape that agrees when
        // the ledger carries amounts finer than the tick (fees at 8 dp against a
        // 0-decimal gas tick), because round(C) - round(D) + round(E) is not
        // round(C - D + E). Pre-flag-day rows sit on the tick's own grid, so both
        // shapes give the same number for them.
        let sumByTick = async (table, joinActions) => {
            let out          = {};
            let placeholders = allIds.map(() => '?').join(', ');
            let from         = joinActions
                ? table + ' m INNER JOIN actions a ON (a.action_index=m.action_index)'
                : table + ' m';
            let q = 'SELECT m.tick_id AS tick_id, ' + ledgerPrecision.exactSumSql('m.amount') + ' AS s'
                  + ' FROM ' + from + ' WHERE m.tick_id IN (' + placeholders + ') GROUP BY m.tick_id';
            let rows = await this.doQuery(q, allIds);
            for(let row of rows){
                if(!this.util.isNull(row.s)) out[Number(row.tick_id)] = row.s;
            }
            return out;
        };
        // Ledger components (action-scoped) and total components (unjoined).
        let creditsById       = await sumByTick('credits', true);
        let debitsById        = await sumByTick('debits',  true);
        let escrowsLedgerById = await sumByTick('escrows', true);
        let balancesById      = await sumByTick('balances', false);
        let escrowsTotalById  = await sumByTick('escrows',  false);
        // tokens.supply per touched tick (raw string, no CAST - matches getTokenSupplyToken).
        let tokenById = {};
        {
            let placeholders = allIds.map(() => '?').join(', ');
            let rows = await this.doQuery(
                'SELECT tick_id, supply FROM tokens WHERE tick_id IN (' + placeholders + ')', allIds);
            for(let row of rows){
                if(!this.util.isNull(row.supply)) tokenById[Number(row.tick_id)] = row.supply;
            }
        }
        // Loop through the tickers and validate token supply match credits/debits/balances info
        for(let tick in tickers){
            let tick_id = tickers[tick];
            let d       = decimals[tick];
            let credits = (creditsById[tick_id]       != null) ? creditsById[tick_id]       : 0;
            let debitsV = (debitsById[tick_id]        != null) ? debitsById[tick_id]        : 0;
            let escLdg  = (escrowsLedgerById[tick_id] != null) ? escrowsLedgerById[tick_id] : 0;
            // Ledger (credits - debits + escrows), identical to getTokenSupply's final
            // bcadd/bcsub: net at the exact scale, round ONCE at the tick's decimals.
            let ledger  = this.util.bcnum(this.util.bcadd(
                this.util.bcsub(credits, debitsV, ledgerPrecision.LEDGER_AMOUNT_PRECISION), escLdg, d));
            let token   = this.util.bcnum((tokenById[tick_id]        != null) ? tokenById[tick_id]        : 0); // Supply from tokens
            let balance = this.util.bcnum((balancesById[tick_id]     != null) ? balancesById[tick_id]     : 0); // Supply from balances
            let escrow  = this.util.bcnum((escrowsTotalById[tick_id] != null) ? escrowsTotalById[tick_id] : 0); // Supply from escrows
            let total   = this.util.bcadd(balance, escrow, decimals[tick]);        // Total (balances + escrows)
            if(String(token)!=String(ledger) || String(token)!=String(total)){
                console.log("Tick,   tick_id =", tick, tick_id);
                console.log("token   supply =", token);
                console.log("ledger  supply =", ledger);  // Credits / Debits / Escrows
                console.log("balance supply =", balance); // balances table
                console.log("escrow  supply =", escrow);  // Escrows
                console.log("total   supply =", total);   // balance + escrow
            }
            if(String(token)!=String(ledger))
                this.util.throwError("SanityError: ledger supply does not match token supply : " + tick + " (" + ledger + " != " + token + ")");
            if(String(token)!=String(total))
                this.util.throwError("SanityError: total supply does not match token supply : " + tick + " (" + total + " != " + token + ")");
        }
    }

    // Get tokens owned by a given address. Ticks whose ownership is currently
    // escrowed by an open ORDER/SWAP/DISPENSER (escrow_action_index set) are in
    // protocol custody, not in the address's ownership records, so they are
    // excluded - per SWEEP.md, escrowed ownership is reachable only through the
    // offer-close path, never through the OWNERSHIPS snapshot.
    async getAddressOwnerships(address){
        let id   = await this.createAddress(address);
        let data = [];
        // Lookup the address preferences
        // Order pinned to binary collation: the SWEEP settlement loop mints a consensus-hashed
        // ACTION_INDEX per swept ownership in this result's order (sweep.js), so an unpinned sort
        // would follow each node's default collation and fork the per-block actions hash. Same
        // house rule as the other consensus reads, and it matches the byte order the SWEEP
        // controller-guard loops already sort by.
        let query = `SELECT
                        t2.tick
                    FROM
                        tokens t1
                        INNER JOIN index_tickers t2 ON (t2.id=t1.tick_id)
                    WHERE
                        t1.owner_id=?
                        AND t1.escrow_action_index IS NULL
                    ORDER BY
                        t2.tick COLLATE utf8mb4_bin`;
        let results = await this.doQuery(query, [id]);
        if(results.length > 0)
            for(let row of results)
                data.push(row.tick);
        return data;
    }

    // Record a VOTE v3 delegation set/clear as an append-only event row. A null
    // delegate (blank DELEGATE_TO) is a clear; the latest row per (tick, delegator)
    // wins at read time (getActiveDelegations), so there is nothing to mutate and
    // rollback is the generic action_index delete. Named createVoteDelegation to
    // avoid colliding with createDelegation (the validator signing-key DELEGATE).
    async createVoteDelegation(data){
        let action_index = data['ACTION_INDEX'];
        let block_index  = data['BLOCK_INDEX'];
        let tick_id      = await this.createTicker(data['TICK']);
        let delegator_id = await this.createAddress(data['SOURCE']);
        let cleared      = this.util.isNull(data['DELEGATE_TO']) || String(data['DELEGATE_TO']).trim() === '';
        let delegate_id  = cleared ? null : await this.createAddress(String(data['DELEGATE_TO']).trim());
        let status_id    = await this.createStatus(data['STATUS']);
        await this.doQuery(
            `INSERT INTO vote_delegations
                (action_index, block_index, tick_id, delegator_address_id, delegate_address_id, status_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [action_index, block_index, tick_id, delegator_id, delegate_id, status_id]);
    }

    // Active delegations for a token at/before a block: {delegatorAddress:
    // delegateAddress}. Latest row per delegator wins (highest action_index, the
    // monotonic per-block tiebreak); a delegator whose latest row is a CLEAR is
    // omitted. Used by getPollTally to flow weight one hop.
    async getActiveDelegations(tick_id, block_index){
        let rows = await this.doQuery(
            `SELECT da.address AS delegator, dg.address AS delegate
               FROM vote_delegations vd
               INNER JOIN (
                    SELECT delegator_address_id, MAX(action_index) AS max_ai
                      FROM vote_delegations
                     WHERE tick_id = ? AND block_index <= ?
                     GROUP BY delegator_address_id
               ) latest ON latest.delegator_address_id = vd.delegator_address_id
                       AND latest.max_ai = vd.action_index
               INNER JOIN index_addresses da ON da.id = vd.delegator_address_id
               LEFT  JOIN index_addresses dg ON dg.id = vd.delegate_address_id
              WHERE vd.delegate_address_id IS NOT NULL`,
            [tick_id, Number(block_index)]);
        let out = {};
        for(let r of rows) out[r.delegator] = r.delegate;
        return out;
    }

    // Write a voter's ballot (VOTE v1) as an atomic set. Wholesale last-write-wins:
    // delete the voter's prior rows for this poll, then insert one row per selected
    // option. Only called for a VALID ballot (an invalid one is a no-op on the
    // voter's standing ballot). `selections` is [{choice, share}, ...].
    async createBallot(data, selections){
        let action_index     = data['ACTION_INDEX'];
        let block_index      = data['BLOCK_INDEX'];
        let poll_index       = data['POLL_REF'];
        let voter_address_id = await this.createAddress(data['SOURCE']);
        let status_id        = await this.createStatus(data['STATUS']);
        let memo             = data['MEMO'];
        // APPEND-ONLY: never delete the voter's prior ballot rows. A re-vote inserts
        // a new action_index set and the tally reads the voter's MAX(action_index)
        // set (getPollTally). Deleting priors here is unrecoverable on a reorg that
        // orphans the replacement (the prior ballot's block never reprocesses),
        // forking a reorged node's tally from a from-genesis replay.
        for(let sel of selections){
            let query = `INSERT INTO votes
                            (action_index, block_index, poll_index, voter_address_id, choice, share, memo, status_id)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
            let args  = [action_index, block_index, poll_index, voter_address_id, sel.choice, sel.share, memo, status_id];
            await this.doQuery(query, args);
        }
    }

    async getPollTally(pollIndex, measureBlock=null){
        let poll = await this.getPoll(pollIndex);
        if(this.util.isNull(poll)) return null;
        let end_block   = Number(poll.end_block);
        if(this.util.isNull(measureBlock)) measureBlock = end_block;
        measureBlock    = Math.min(Number(measureBlock), end_block);
        let tick        = await this.getTicker(poll.tick_id);
        let options     = JSON.parse(poll.options || '[]');
        let optionCount = options.length;
        let tally_mode  = poll.tally_mode  || 'approval';
        let weight_mode = poll.weight_mode || 'balance';
        let minVoteBal  = this.util.isNull(poll.min_vote_balance) ? '0' : String(poll.min_vote_balance);
        // Close-block holders (deterministic, address-tiebroken); supply = sum
        let holders = await this.getHolders(tick, measureBlock, null);
        // time_weighted maps each voter's close eligibility to their average
        // balance over [creation_block, close]; preloaded once (windowed ledger
        // aggregation, Section 12.2). Other modes derive weight from closeBal.
        let twBalances = (weight_mode === 'time_weighted')
            ? await this.getTimeWeightedBalances(tick, Number(poll.block_index), measureBlock)
            : null;
        let supply  = '0';
        for(let addr in holders) supply = this.util.bcadd(supply, holders[addr], 18);
        // Current ballots for the poll, grouped by voter. votes is append-only
        // (every re-vote is a new action_index set), so the voter's CURRENT ballot
        // is their rows at MAX(action_index); earlier sets stay in the table purely
        // for reorg safety (rolling back the latest set re-exposes the prior one).
        let rows = await this.doQuery(
            `SELECT a.address AS address, v.choice AS choice, v.share AS share
               FROM votes v INNER JOIN index_addresses a ON (a.id=v.voter_address_id)
              WHERE v.poll_index=?
                AND v.action_index = (SELECT MAX(v2.action_index) FROM votes v2
                                       WHERE v2.poll_index=v.poll_index
                                         AND v2.voter_address_id=v.voter_address_id)`, [pollIndex]);
        let byVoter = {};
        for(let r of rows){
            if(this.util.isNull(byVoter[r.address])) byVoter[r.address] = [];
            byVoter[r.address].push({ choice: Number(r.choice), share: this.util.isNull(r.share) ? '1' : String(r.share) });
        }
        // Map a close-eligible voter's close balance to a weight number under the
        // active mode. balance = close holdings; flat = one-address-one-vote;
        // quadratic = sqrt(close) to flatten whales; time_weighted = average
        // holdings over the window. Weight eligibility is hold-to-count only (a
        // positive close balance); MIN_VOTE_BALANCE is NOT a floor on weight - it
        // gates only the qualifyingVoters headcount below. So quadratic weight has
        // no dust floor: splitting stake across many sub-floor addresses still
        // yields sqrt-amplified weight (Sybil-resistant, not Sybil-proof), bounded
        // only by per-address transaction fees.
        const weightFor = (addr, closeBal) => {
            if(weight_mode === 'flat')          return '1';
            if(weight_mode === 'quadratic')     return this.util.bcsqrt(closeBal, 18);
            if(weight_mode === 'time_weighted') return (twBalances && !this.util.isNull(twBalances[addr])) ? twBalances[addr] : '0';
            return closeBal;
        };

        // One-hop delegation (Section 13): a holder who did NOT vote directly and
        // still holds at close lends their weight to their delegate's ballot, if
        // the delegate cast one. Standing per-token delegation resolved at the
        // close block. inbound[delegate] = summed delegated weight; folded into the
        // delegate's own weight in the loop below.
        let inbound = {};
        if(!this.util.isNull(poll.tick_id)){
            let delegations = await this.getActiveDelegations(poll.tick_id, measureBlock);
            for(let delegator in delegations){
                let delegate = delegations[delegator];
                if(this.util.isNull(delegate)) continue;                  // cleared delegation
                if(!this.util.isNull(byVoter[delegator])) continue;       // voted directly -> overrides
                if(this.util.isNull(byVoter[delegate])) continue;         // idle delegate -> weight unused
                let dBal = holders[delegator];
                if(this.util.isNull(dBal) || !this.util.bcgt(dBal, 0)) continue; // hold-to-count on delegator
                let dWeight = weightFor(delegator, dBal);
                inbound[delegate] = this.util.bcadd(this.util.isNull(inbound[delegate]) ? '0' : inbound[delegate], dWeight, 18);
            }
        }

        let totals = [];
        let optionVoters = [];
        for(let i=0;i<optionCount;i++){ totals.push('0'); optionVoters.push(0); }
        let totalCountedWeight = '0';
        let qualifyingVoters   = 0;
        for(let addr in byVoter){
            let closeBal = holders[addr];
            // Hold-to-count: the ballot counts only if the voter still holds the token
            // at close (applies to every weight mode; the dust floor below also reads
            // closeBal, so eligibility is always the close snapshot, never the transform).
            if(this.util.isNull(closeBal) || !this.util.bcgt(closeBal, 0)) continue;
            // The voter's own weight plus any weight delegated to them (one-hop).
            let weight = this.util.bcadd(weightFor(addr, closeBal), this.util.isNull(inbound[addr]) ? '0' : inbound[addr], 18);
            // Participation gate counts a direct voter only above the dust floor
            // (delegators add weight but not headcount; see spec).
            if(this.util.bcgte(closeBal, minVoteBal)) qualifyingVoters++;
            let picks = byVoter[addr];
            if(tally_mode==='split'){
                let sumShares = '0';
                for(let p of picks) sumShares = this.util.bcadd(sumShares, p.share, 18);
                if(!this.util.bcgt(sumShares, 0)) continue;
                for(let p of picks){
                    if(p.choice < 0 || p.choice >= optionCount) continue;
                    let portion = this.util.bcmul(weight, this.util.bcdiv(p.share, sumShares, 18), 18);
                    totals[p.choice] = this.util.bcadd(totals[p.choice], portion, 18);
                    optionVoters[p.choice]++;
                }
            } else {
                for(let p of picks){
                    if(p.choice < 0 || p.choice >= optionCount) continue;
                    totals[p.choice] = this.util.bcadd(totals[p.choice], weight, 18);
                    optionVoters[p.choice]++;
                }
            }
            // Counted once per voter for the weight-quorum turnout fraction
            totalCountedWeight = this.util.bcadd(totalCountedWeight, weight, 18);
        }
        // Winner: highest weight, lowest option index on a tie
        let winning_option = null, best = '0';
        for(let i=0;i<optionCount;i++)
            if(this.util.bcgt(totals[i], best)){ best = totals[i]; winning_option = i; }
        // Validity gates (both fractions of supply / counts; either may be unset)
        let quorum_met = true, min_voters_met = true;
        if(!this.util.isNull(poll.quorum) && this.util.bcgt(poll.quorum, 0)){
            let turnout = this.util.bcgt(supply, 0) ? this.util.bcdiv(totalCountedWeight, supply, 18) : '0';
            quorum_met  = this.util.bcgte(turnout, poll.quorum);
        }
        if(!this.util.isNull(poll.min_voters) && Number(poll.min_voters) > 0)
            min_voters_met = (qualifyingVoters >= Number(poll.min_voters));
        let passed = quorum_met && min_voters_met;
        let latest = await this.getLatestBlockIndex();
        let closed = (latest >= end_block);
        let status = !passed ? 'failed_quorum' : (closed ? 'finalized' : 'open');
        let optionResults = [];
        // bcstr, not String(): a dust weight below 1e-7 (18-decimal governance
        // token) would render exponentially and persist that way in poll_results.
        for(let i=0;i<optionCount;i++)
            optionResults.push({ index: i, label: options[i], weight: this.util.bcstr(totals[i]), voters: optionVoters[i] });
        return {
            poll_index: Number(pollIndex), tick, measure_block: measureBlock, end_block,
            tally_mode, weight_mode, options: optionResults,
            supply: this.util.bcstr(supply), total_counted_weight: this.util.bcstr(totalCountedWeight),
            total_voters: qualifyingVoters, quorum_met, min_voters_met, winning_option, status
        };
    }

    // ── Cross-chain bridge action records (XBRIDGE) ─────────────────────────────

    /**
     * Persist one user-broadcast XBRIDGE action (v0 lock XCHAIN, v1 burn XCHAIN, v3 lock a
     * token, v4 burn a bridged copy) in `xbridges`, valid or refused, the way createSend
     * records a SEND. The system-injected settle legs (v2, v5) never reach here: they are
     * applied from a mirrored bridge_transfers row and recorded in `bridge_settlements`.
     *
     * WHY THE ROW EXISTS. The hub's CrossChainBridgeEngine polls this chain for confirmed
     * locks and burns to sign into a transfer record; `getpendingbridgetransfers` reads
     * this table, so without the row a lock debits the source here and is never signed
     * anywhere. A refused action keeps its row, carrying the verdict in status_id, so the
     * record says what the action asked for.
     *
     * ONE ROW PER ACTION, and the exists-check is keyed on action_index alone: unlike a
     * multi-SEND or multi-DESTROY, an XBRIDGE carries exactly one tick and one destination,
     * so there are no legs to separate. A re-parse of the same block (a rollback and
     * reindex) updates that row in place instead of duplicating it.
     *
     * THE TICK IS DERIVED THE WAY THE HANDLER DERIVES IT, not read off the wire clone: v0
     * and v1 move the GAS tick by construction (the wire carries no TICK field for them),
     * v3 and v4 carry it. Keyed on the version rather than on "TICK is empty" so a v3 whose
     * TICK field is missing records as the tickless action it was, never as an XCHAIN one.
     *
     * @param {Object} data - the handler's raw wire clone plus the fields the lock stamps.
     *                        Reads ACTION_INDEX, FORMAT, TICK (v3/v4), DEST_CHAIN,
     *                        DEST_ADDRESS (v0/v3) or BTC_ADDRESS (v1) or ORIGIN_ADDRESS
     *                        (v4), AMOUNT, DECIMALS, MIN_DEPTH, MEMO, STATUS, BLOCK_INDEX
     * @returns {Promise<void>}
     */
    async createXbridge(data){
        data                = this.normalizeDataValues(data);
        // Numeric-or-NULL, the normalization every other wire-derived integer column gets:
        // an action refused 'invalid: VERSION (unknown)' can carry no version at all, and a
        // NaN bound to a TINYINT throws under STRICT_TRANS_TABLES, which wedges the block
        // loop instead of recording the refusal (the 2026-07-05 DEPOSIT|0|null class).
        let version         = (!this.util.isNull(data['FORMAT']) && this.util.isNumeric(data['FORMAT'])) ? parseInt(data['FORMAT']) : null;
        // v0 and v1 are the GAS tick by construction; v3 and v4 name it on the wire.
        let tick            = (version === 0 || version === 1) ? this.config['GAS'] : data['TICK'];
        // The one destination field this version actually carries. A lock names an address
        // on DEST_COIN, a v1 burn names a BTC address, a v4 burn names an address on the
        // bridged row's origin chain; all three are "where the value lands", so they share
        // one column rather than three mutually-null ones.
        let destination     = (version === 1) ? data['BTC_ADDRESS']
                            : (version === 4) ? data['ORIGIN_ADDRESS']
                            :                   data['DEST_ADDRESS'];
        let tick_id         = await this.createTicker(tick);
        let dest_address_id = await this.createAddress(destination);
        let memo_id         = await this.createMemo(data['MEMO']);
        let status_id       = await this.createStatus(data['STATUS']);
        let action_index    = data['ACTION_INDEX'];
        let dest_chain      = this.util.isNull(data['DEST_CHAIN']) ? null : String(data['DEST_CHAIN']);
        let amount          = data['AMOUNT'];
        // DECIMALS and MIN_DEPTH are stamped by the apply path only, so a refusal that
        // never reached the token read leaves them NULL rather than 0: "not known" and
        // "the issuer set none" are different answers and the hub treats them differently.
        let decimals        = (!this.util.isNull(data['DECIMALS']) && this.util.isNumeric(data['DECIMALS'])) ? parseInt(data['DECIMALS']) : null;
        let min_depth       = (!this.util.isNull(data['MIN_DEPTH']) && this.util.isNumeric(data['MIN_DEPTH'])) ? parseInt(data['MIN_DEPTH']) : null;
        let block_index     = data['BLOCK_INDEX'];
        // Check if record already exists for this action
        let query   = "SELECT action_index FROM xbridges WHERE action_index=? LIMIT 1";
        let results = await this.doQuery(query, [action_index]);
        let args    = [];
        if(results.length > 0){
            // UPDATE record (a re-parse of the same block, after a rollback)
            query = `UPDATE
                        xbridges
                    SET
                        version=?,
                        tick_id=?,
                        dest_chain=?,
                        dest_address_id=?,
                        amount=?,
                        decimals=?,
                        min_depth=?,
                        memo_id=?,
                        status_id=?,
                        block_index=?
                    WHERE
                        action_index=?`;
            args  = [version, tick_id, dest_chain, dest_address_id, amount, decimals, min_depth, memo_id, status_id, block_index, action_index];
        } else {
            // INSERT record
            query = `INSERT INTO xbridges (version, tick_id, dest_chain, dest_address_id, amount, decimals, min_depth, memo_id, status_id, block_index, action_index) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            args  = [version, tick_id, dest_chain, dest_address_id, amount, decimals, min_depth, memo_id, status_id, block_index, action_index];
        }
        await this.doQuery(query, args);
    }

    /**
     * Set a native token row's `bridged` bit, the way setTokenEscrow sets
     * escrow_action_index: a targeted UPDATE rather than a field of the createToken
     * derivation. createToken rebuilds `tokens` from the `issues` rows and no ISSUE may
     * set or clear this bit, so it has no derivation to ride.
     *
     * Set by the FIRST applied XBRIDGE v3 lock and never cleared in milestone 1 (token
     * spec section 8): emptying BRIDGE_CHAINS after bridging must not reopen policy
     * binding while copies are outstanding on another chain. `bridged=0` in the WHERE
     * makes the write a no-op for every later lock of the same tick.
     *
     * `block_index` is the applying block. It is not stored: the bit carries no height
     * because nothing in milestone 1 reads "when", and a reorg of the first lock
     * deliberately leaves the bit set (the conservative direction, since the copies it
     * refuses policy binding for may still exist on the destination chain).
     *
     * @param {string} tick        - the NATIVE tick being locked (never the rooted form)
     * @param {number} block_index - the block the lock applied at; logged, not stored
     * @returns {Promise<void>}
     */
    async setTokenBridged(tick, block_index){
        let tick_id = await this.createTicker(tick);
        if(tick_id === null)
            return;
        let query = "UPDATE tokens SET bridged=1 WHERE tick_id=? AND bridged=0";
        let res   = await this.doQuery(query, [tick_id]);
        // One line per token, ever, because the WHERE excludes an already-set bit.
        if(res && res.affectedRows)
            console.log('\t Token ' + tick + ' marked bridged at block ' + block_index);
    }

    // The pending-leg SELECT shared by both paths of getPendingBridgeTransfers, so the
    // columns, joins, verdict filter and ordering the RPC handler maps stay one text.
    // `extraWhere` is the path's own predicate (the NOT EXISTS exclusion, or the keyset
    // cursor) and carries no caller input; its placeholders bind ahead of the LIMIT.
    _pendingBridgeTransfersSql(extraWhere){
        return `SELECT
                x.action_index, x.version, x.block_index, x.amount, x.decimals, x.min_depth,
                x.dest_chain, t.tick AS tick, da.address AS dest_address, sa.address AS src_address,
                it.hash AS tx_hash
             FROM
                xbridges x
                INNER JOIN actions            a  ON (a.action_index=x.action_index)
                INNER JOIN index_statuses     s  ON (s.id=x.status_id)
                INNER JOIN index_tickers      t  ON (t.id=x.tick_id)
                INNER JOIN index_addresses    da ON (da.id=x.dest_address_id)
                INNER JOIN index_addresses    sa ON (sa.id=a.source_id)
                INNER JOIN transactions       tx ON (tx.tx_index=a.tx_index)
                INNER JOIN index_transactions it ON (it.id=tx.tx_hash_id)
             WHERE
                s.status='valid' AND x.version IN (0,1,3,4)
                ${extraWhere}
             ORDER BY
                x.action_index ASC
             LIMIT ?`;
    }

    // ── Cross-chain contract calls (XCALL) ──────────────────────────────────────

    // Persist an XCALL v0 request row (the source-chain side of a cross-chain call).
    async createCrossChainCallRequest(data){
        data = this.normalizeDataValues(data);
        let status_id = await this.createStatus(data['STATUS']);
        await this.doQuery(
            `INSERT INTO xcalls
             (action_index, version, call_id, contract_index, target_chain, target_contract_index,
              method, params_json, gas_limit, cross_hops, callback_method, callback_params_json,
              deadline_block, request_status, block_index, status_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [data['ACTION_INDEX'], 0, String(data['CALL_ID']).toLowerCase(), data['CONTRACT_INDEX'],
             data['TARGET_CHAIN'], data['TARGET_CONTRACT_INDEX'], data['METHOD'], data['PARAMS_JSON'],
             data['GAS_LIMIT'], data['CROSS_HOPS'], data['CALLBACK_METHOD'], data['CALLBACK_PARAMS'],
             data['DEADLINE_BLOCK'], data['REQUEST_STATUS'], data['BLOCK_INDEX'], status_id]);
    }

    // Latest VALID v0 request row for a call_id.
    async getCrossChainCallRequestById(call_id){
        let rows = await this.doQuery(
            `SELECT x.* FROM xcalls x
             JOIN index_statuses s ON s.id = x.status_id
             WHERE x.call_id = ? AND x.version = 0 AND s.status = 'valid'
             ORDER BY x.action_index DESC LIMIT 1`,
            [String(call_id).toLowerCase()]);
        return rows.length > 0 ? rows[0] : null;
    }

    // Flip a request to a terminal status and capture the delivered outcome
    // (the exactly-once interlock + the xchain.crossChain.getCallResult source).
    async updateCrossChainCallRequestStatus(call_id, request_status, result_status, result_payload, resolved_block){
        await this.doQuery(
            `UPDATE xcalls SET request_status = ?, result_status = ?, result_payload = ?, resolved_block = ?
             WHERE call_id = ? AND version = 0`,
            [request_status, result_status, String(result_payload == null ? '' : result_payload),
             resolved_block, String(call_id).toLowerCase()]);
    }

    async setCrossChainCallCallbackIndex(call_id, callback_action_index){
        await this.doQuery(
            `UPDATE xcalls SET callback_action_index = ? WHERE call_id = ? AND version = 0`,
            [callback_action_index, String(call_id).toLowerCase()]);
    }

    // Pending requests whose deadline has passed (drives the v2 expiry synthesis).
    // Pending requests whose deadline has passed, capped at `cap` per block (carry-forward: the
    // remainder is picked up in later blocks). The cap is load-bearing for liveness: deadline_block
    // is caller-chosen in [10,4000], so an attacker can align many requests' deadlines onto one
    // block; without a bound the expiry pass would synthesize an XCALL v2 + run a VM callback isolate
    // for every one of them inside a single block transaction, blowing BLOCK_PROCESS_TIMEOUT and
    // wedging every indexer on the chain at the identical block. Ordering is deterministic and
    // node-invariant (deadline_block, then per-chain action_index), so the capped subset and the
    // carry-forward converge byte-identically across operators (matches the dispatch/result caps).
    async getExpiredCrossChainCallRequests(block_index, cap){
        let limit = (Number.isInteger(cap) && cap > 0) ? cap : Number.MAX_SAFE_INTEGER;
        return await this.doQuery(
            `SELECT x.call_id FROM xcalls x
             JOIN index_statuses s ON s.id = x.status_id
             WHERE x.version = 0 AND s.status = 'valid'
               AND x.request_status = 'pending' AND x.deadline_block < ?
             ORDER BY x.deadline_block ASC, x.action_index ASC
             LIMIT ?`,
            [block_index, limit]);
    }

    // Pending requests for the federation relay (getpendingcrosschaincalls RPC).
    async getPendingCrossChainCallRequests(limit){
        return await this.doQuery(
            `SELECT x.call_id, x.action_index, x.block_index, x.contract_index AS source_contract_index,
                    x.target_chain, x.target_contract_index, x.method, x.params_json, x.gas_limit,
                    x.cross_hops, x.deadline_block
             FROM xcalls x
             JOIN index_statuses s ON s.id = x.status_id
             WHERE x.version = 0 AND s.status = 'valid' AND x.request_status = 'pending'
             ORDER BY x.action_index ASC LIMIT ?`,
            [limit]);
    }

    // Get action information for a given action_index
    async getActionData(action_index){
        let data = null;
        let sql  = null;
        let type = await this.getActionType(action_index);
        if(type){
            // Placeholders for queries and arguments
            // ADDRESS action
            if(type=='ADDRESS'){
                sql = `SELECT
                            a3.action,
                            a1.action_index,
                            a4.address as source,
                            a1.fee_preference,
                            a1.require_memo,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m1.memo,
                            s1.status
                        FROM
                            addresses a1
                            INNER JOIN actions            a2 ON (a2.action_index=a1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a2.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a3 ON (a3.id=a2.action_id)
                            INNER JOIN index_addresses    a4 ON (a4.id=a2.source_id)
                            LEFT  JOIN index_memos        m1 ON (m1.id=a1.memo_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=a1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        WHERE 
                            a1.action_index=?
                        LIMIT 1`;
            }
            // AIRDROP action
            if(type=='AIRDROP'){
                sql = `SELECT
                            a3.action,
                            a1.action_index,
                            a4.address as source,
                            t3.tick,
                            a1.list_action_index,
                            a1.amount,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m1.memo,
                            s1.status
                        FROM
                            airdrops a1
                            INNER JOIN actions            a2 ON (a2.action_index=a1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a2.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a3 ON (a3.id=a2.action_id)
                            INNER JOIN index_addresses    a4 ON (a4.id=a2.source_id)
                            LEFT  JOIN index_memos        m1 ON (m1.id=a1.memo_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=a1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_tickers      t3 ON (t3.id=a1.tick_id)
                        WHERE 
                            a1.action_index=?
                        LIMIT 1`;
            }
            // BATCH action
            if(type=='BATCH'){
                sql = `SELECT
                            a3.action,
                            b1.action_index,
                            a4.address as source,
                            b2.block_index,
                            b2.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            s1.status
                        FROM
                            batches b1
                            INNER JOIN actions            a2 ON (a2.action_index=b1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a2.tx_index)
                            INNER JOIN blocks             b2 ON (b2.block_index=t1.block_index)
                            INNER JOIN index_actions      a3 ON (a3.id=a2.action_id)
                            INNER JOIN index_addresses    a4 ON (a4.id=a2.source_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=b1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        WHERE 
                            b1.action_index=?
                        LIMIT 1`;
            }
            // BROADCAST action
            if(type=='BROADCAST'){
                sql = `SELECT
                            a2.action,
                            b1.action_index,
                            b1.message,
                            b1.value,
                            b1.fee,
                            b1.broadcast_action_index,
                            a3.address as source,
                            b2.block_index,
                            b2.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m1.memo,
                            s1.status
                        FROM
                            broadcasts b1
                            INNER JOIN actions            a1 ON (a1.action_index=b1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b2 ON (b2.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                            LEFT  JOIN index_memos        m1 ON (m1.id=b1.memo_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=b1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        WHERE 
                            b1.action_index=?
                        LIMIT 1`;
            }
            // CALLBACK action
            if(type=='CALLBACK'){
                sql = `SELECT
                            a2.action,
                            c1.action_index,
                            a3.address as source,
                            t3.tick,
                            t4.tick as callback_tick,
                            c1.callback_amount,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m1.memo,
                            s1.status
                        FROM
                            callbacks c1
                            INNER JOIN actions            a1 ON (a1.action_index=c1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                            LEFT  JOIN index_memos        m1 ON (m1.id=c1.memo_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=c1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_tickers      t3 ON (t3.id=c1.tick_id)
                            INNER JOIN index_tickers      t4 ON (t4.id=c1.callback_tick_id)
                        WHERE 
                            c1.action_index=?
                        LIMIT 1`;
            }
            // DESTROY action
            //
            // A multi-destroy has one row per leg under this action_index, and this
            // summary shows one of them: ORDER BY leg_ordinal makes that "the first leg
            // as broadcast" instead of whichever row the engine happened to hand back.
            if(type=='DESTROY'){
                sql = `SELECT
                            a2.action,
                            d1.action_index,
                            a3.address as source,
                            t3.tick,
                            d1.amount,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m1.memo,
                            s1.status
                        FROM
                            destroys d1
                            INNER JOIN actions            a1 ON (a1.action_index=d1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                            LEFT  JOIN index_memos        m1 ON (m1.id=d1.memo_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=d1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_tickers      t3 ON (t3.id=d1.tick_id)
                        WHERE
                            d1.action_index=?
                        ORDER BY
                            d1.action_index ASC,
                            d1.leg_ordinal ASC
                        LIMIT 1`;
            }
            // DISPENSER action
            if(type=='DISPENSER'){
                // TODO
            }
            // DISPENSE action
            if(type=='DISPENSE'){
                // TODO
            }
            // FILE action
            if(type=='FILE'){
                sql = `SELECT
                            a2.action,
                            f1.action_index,
                            f1.name,
                            f1.title,
                            t3.type as type,
                            a3.address as source,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m1.memo,
                            s1.status
                        FROM
                            files f1
                            INNER JOIN actions            a1 ON (a1.action_index=f1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                            LEFT  JOIN index_memos        m1 ON (m1.id=f1.memo_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=f1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_mime_types   t3 ON (t3.id=f1.type_id)
                        WHERE 
                            f1.action_index=?
                        LIMIT 1`;
                // TODO: Add code to lookup actual file data from transactions and return an `data` item
            }
            // ISSUE action
            if(type=='ISSUE'){
                sql = `SELECT
                            a2.action,
                            i1.action_index,
                            t3.tick,
                            i1.max_supply,
                            i1.max_mint,
                            i1.decimals,
                            i1.description,
                            i1.mint_supply,
                            a4.address as transfer,
                            a5.address as transfer_supply,
                            i1.lock_max_supply,
                            i1.lock_mint,
                            i1.lock_mint_supply,
                            i1.lock_max_mint,
                            i1.lock_description,
                            i1.lock_sleep,
                            i1.lock_callback,
                            i1.callback_block,
                            t4.tick as callback_tick,
                            i1.callback_amount,
                            i1.allow_list,
                            i1.block_list,
                            i1.mint_address_max,
                            i1.mint_start_block,
                            i1.mint_stop_block,
                            a3.address as source,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            s1.status
                        FROM
                            issues i1
                            INNER JOIN actions            a1 ON (a1.action_index=i1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                            LEFT  JOIN index_addresses    a4 ON (a4.id=i1.transfer_id)
                            LEFT  JOIN index_addresses    a5 ON (a5.id=i1.transfer_supply_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=i1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_tickers      t3 ON (t3.id=i1.tick_id)
                            LEFT  JOIN index_tickers      t4 ON (t4.id=i1.callback_tick_id)
                        WHERE 
                            i1.action_index=?
                        LIMIT 1`;
            }
            // LINK action
            if(type=='LINK'){
                sql = `SELECT
                            a2.action,
                            l1.action_index,
                            c1.coin as coin1,
                            c2.coin as coin2,
                            l1.coin1_action_index,
                            l1.coin2_action_index,
                            a3.address as source,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m1.memo,
                            s1.status
                        FROM
                            links l1
                            INNER JOIN actions            a1 ON (a1.action_index=l1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                            LEFT  JOIN index_memos        m1 ON (m1.id=l1.memo_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=l1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_coins        c1 ON (c1.id=l1.coin1_id)
                            INNER JOIN index_coins        c2 ON (c2.id=l1.coin2_id)
                        WHERE 
                            l1.action_index=?
                        LIMIT 1`;
            }
            // LIST action
            if(type=='LIST'){
                sql = `SELECT
                            a2.action,
                            l1.action_index,
                            l1.type,
                            l1.edit,
                            l1.list_action_index,
                            a3.address as source,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            s1.status
                        FROM
                            lists l1
                            INNER JOIN actions            a1 ON (a1.action_index=l1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=l1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        WHERE 
                            l1.action_index=?
                        LIMIT 1`;
            }
            // MESSAGE action
            if(type=='MESSAGE'){
                sql = `SELECT
                            a2.action,
                            m1.action_index,
                            a3.address as source,
                            a4.address as destination,
                            m1.encryption_method,
                            m1.encryption_key,
                            m1.encrypted_message,
                            m1.plaintext_message,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            s1.status
                        FROM
                            messages m1
                            INNER JOIN actions            a1 ON (a1.action_index=m1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                            INNER JOIN index_addresses    a4 ON (a4.id=m1.destination_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=m1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        WHERE 
                            m1.action_index=?
                        LIMIT 1`;
            }
            // MINT action
            if(type=='MINT'){
                sql = `SELECT
                            a2.action,
                            m1.action_index,
                            a3.address as source,
                            a4.address as destination,
                            t3.tick,
                            m1.amount,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m2.memo,
                            s1.status
                        FROM
                            mints m1
                            INNER JOIN actions            a1 ON (a1.action_index=m1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                            INNER JOIN index_addresses    a4 ON (a4.id=m1.destination_id)
                            LEFT  JOIN index_memos        m2 ON (m2.id=m1.memo_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=m1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_tickers      t3 ON (t3.id=m1.tick_id)
                        WHERE 
                            m1.action_index=?
                        LIMIT 1`;
            }
            // ORDER action
            if(type=='ORDER'){
                sql = `SELECT
                            a2.action,
                            o1.action_index,
                            c1.coin as give_coin,
                            t3.tick as give_tick,
                            o1.give_amount,
                            c2.coin as get_coin,
                            t4.tick as get_tick,
                            o1.get_amount,
                            a3.address as source,
                            a4.address as get_address,
                            o1.expiration,
                            o1.allow_list,
                            o1.block_list,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m2.memo,
                            s1.status
                        FROM
                            orders o1
                            INNER JOIN actions            a1 ON (a1.action_index=o1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                            INNER JOIN index_addresses    a4 ON (a4.id=o1.get_address_id)
                            LEFT  JOIN index_memos        m2 ON (m2.id=o1.memo_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=o1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_coins        c1 ON (c1.id=o1.give_coin_id)
                            INNER JOIN index_coins        c2 ON (c2.id=o1.get_coin_id)
                            INNER JOIN index_tickers      t3 ON (t3.id=o1.give_tick_id)
                            INNER JOIN index_tickers      t4 ON (t4.id=o1.get_tick_id)
                        WHERE 
                            o1.action_index=?
                        LIMIT 1`;
            }
            // ORDER_CANCEL action
            if(type=='ORDER_CANCEL'){
                sql = `SELECT
                        a2.action,
                        o1.action_index,
                        o1.order_action_index,
                        a3.address as source,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m2.memo,
                        s1.status
                    FROM
                        order_cancels o1
                        INNER JOIN actions            a1 ON (a1.action_index=o1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                        LEFT  JOIN index_memos        m2 ON (m2.id=o1.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=o1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE 
                        o1.action_index=?
                    LIMIT 1`;
            }
            // ORDER_EDIT action
            if(type=='ORDER_EDIT'){
                sql = `SELECT
                        a2.action,
                        o1.action_index,
                        o1.order_action_index,
                        a3.address as source,
                        o1.expiration,
                        o1.allow_list,
                        o1.block_list,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m2.memo,
                        s1.status
                    FROM
                        order_edits o1
                        INNER JOIN actions            a1 ON (a1.action_index=o1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                        LEFT  JOIN index_memos        m2 ON (m2.id=o1.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=o1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE 
                        o1.action_index=?
                    LIMIT 1`;
            }
            // ORDER_MATCH action
            if(type=='ORDER_MATCH'){
                sql = `SELECT
                            a2.action,
                            m1.action_index,
                            c1.coin as give_coin,
                            m1.give_action_index,
                            c2.coin as get_coin,
                            m1.get_action_index,
                            b1.block_index,
                            b1.block_time as timestamp,
                            s1.status
                        FROM
                            order_matches m1
                            INNER JOIN actions            a1 ON (a1.action_index=m1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=m1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_coins        c1 ON (c1.id=m1.give_coin_id)
                            INNER JOIN index_coins        c2 ON (c2.id=m1.get_coin_id)
                        WHERE 
                            m1.action_index=?
                        LIMIT 1`;
            }
            // SEND action
            // TODO: Revisit this code and optimize it to support Multi-sends (right now shows first send status instead of every send status as it should)
            // Until then, "first" is at least well defined: ORDER BY leg_ordinal pins the
            // returned leg to the first one as broadcast rather than an engine-arbitrary row.
            if(type=='SEND'){
                sql = `SELECT
                            a2.action,
                            s1.action_index,
                            a3.address as source,
                            a4.address as destination,
                            t3.tick,
                            s1.amount,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m2.memo,
                            s2.status
                        FROM
                            sends s1
                            INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                            INNER JOIN index_addresses    a4 ON (a4.id=s1.destination_id)
                            LEFT  JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                            INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_tickers      t3 ON (t3.id=s1.tick_id)
                        WHERE
                            s1.action_index=?
                        ORDER BY
                            s1.action_index ASC,
                            s1.leg_ordinal ASC
                        LIMIT 1`;
            }
            // SLEEP action
            if(type=='SLEEP'){
                sql = `SELECT
                            a2.action,
                            s1.action_index,
                            s1.type,
                            a3.address as source,
                            t3.tick,
                            s1.resume_block,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m2.memo,
                            s2.status
                        FROM
                            sleeps s1
                            INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                            LEFT  JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                            INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            LEFT JOIN index_tickers       t3 ON (t3.id=s1.tick_id)
                        WHERE 
                            s1.action_index=?
                        LIMIT 1`;
            }
            // SWAP action
            if(type=='SWAP'){
                sql = `SELECT
                            a2.action,
                            s1.action_index,
                            c1.coin as give_coin,
                            t3.tick as give_tick,
                            s1.give_amount,
                            c2.coin as get_coin,
                            t4.tick as get_tick,
                            s1.get_amount,
                            a3.address as source,
                            a4.address as get_address,
                            s1.expiration,
                            s1.allow_list,
                            s1.block_list,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m2.memo,
                            s2.status
                        FROM
                            swaps s1
                            INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                            INNER JOIN index_addresses    a4 ON (a4.id=s1.get_address_id)
                            LEFT  JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                            INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_coins        c1 ON (c1.id=s1.give_coin_id)
                            INNER JOIN index_coins        c2 ON (c2.id=s1.get_coin_id)
                            INNER JOIN index_tickers      t3 ON (t3.id=s1.give_tick_id)
                            INNER JOIN index_tickers      t4 ON (t4.id=s1.get_tick_id)
                        WHERE 
                            s1.action_index=?
                        LIMIT 1`;
            }
            // SWAP_CANCEL action
            if(type=='SWAP_CANCEL'){
                sql = `SELECT
                        a2.action,
                        s1.action_index,
                        s1.swap_action_index,
                        a3.address as source,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m2.memo,
                        s2.status
                    FROM
                        swap_cancels s1
                        INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                        LEFT  JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                        INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE 
                        s1.action_index=?
                    LIMIT 1`;
            }
            // SWAP_EDIT action
            if(type=='SWAP_EDIT'){
                sql = `SELECT
                        a2.action,
                        s1.action_index,
                        s1.swap_action_index,
                        a3.address as source,
                        s1.expiration,
                        s1.allow_list,
                        s1.block_list,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m2.memo,
                        s2.status
                    FROM
                        swap_edits s1
                        INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                        LEFT  JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                        INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE 
                        s1.action_index=?
                    LIMIT 1`;
            }
            // SWAP_MATCH action
            if(type=='SWAP_MATCH'){
                sql = `SELECT
                            a2.action,
                            m1.action_index,
                            c1.coin as give_coin,
                            m1.give_action_index,
                            c2.coin as get_coin,
                            m1.get_action_index,
                            b1.block_index,
                            b1.block_time as timestamp,
                            s1.status
                        FROM
                            swap_matches m1
                            INNER JOIN actions            a1 ON (a1.action_index=m1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=m1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_coins        c1 ON (c1.id=m1.give_coin_id)
                            INNER JOIN index_coins        c2 ON (c2.id=m1.get_coin_id)
                        WHERE 
                            m1.action_index=?
                        LIMIT 1`;
            }
            // SWEEP
            if(type=='SWEEP'){
                sql = `SELECT
                            a2.action,
                            s1.action_index,
                            a3.address as source,
                            a4.address as destination,
                            s1.balances,
                            s1.ownerships,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m2.memo,
                            s2.status
                        FROM
                            sweeps s1
                            INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                            INNER JOIN index_addresses    a4 ON (a4.id=s1.destination_id)
                            LEFT  JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                            INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        WHERE 
                            s1.action_index=?
                        LIMIT 1`;
            }
            // UNKNOWN
            if(type=='UNKNOWN'){
                sql = `SELECT
                            a2.action,
                            a1.action_index,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index
                        FROM
                            actions                       a1
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                        WHERE 
                            a1.action_index=?
                        LIMIT 1`;
            }
            // Run the SQL query to get the information on the action_index
            if(sql){
                let results = await this.doQuery(sql, [action_index]);
                if(results && results.length)
                    data = results[0];
            }
        }
        return data;
    }

    // Get market_id for given ticker ids
    async getMarketId(tick1_id, tick2_id){
        let row = await this.getMarketRow(tick1_id, tick2_id);
        return (row) ? row.id : null;
    }

    // Handle finding and updating markets
    async updateMarkets(markets, block_index){
        let block_time = await this.getBlockTime(block_index);
        await Promise.all(markets.map(async (pair) => {
            let market_id = await this.getMarketId(pair.tick1_id, pair.tick2_id);
            if(market_id){
                let data = await this.getMarketInfo(market_id, block_time);
                await this.updateMarketInfo(data);
            }
        }));
    }

    // Create record in `delegations` table with 'revoked' status
    async createRevokeDelegation(data){
        // Set status to reflect revocation intent, then create as normal delegation record
        await this.createDelegation(data);
    }

    /*
     * Hub push retry queue (`pending_hub_pushes`)
     *
     * Durable backing for best-effort hub pushes (PRICE v0 round / PRICE v1
     * oracle price). When a live push fails, the payload is parked here and the
     * HubPushQueue poller drains it later with exponential backoff.
     *
     * These methods deliberately bypass doQuery()/getConnection(): the poller
     * runs concurrently with block processing on this same `indexerDb` instance,
     * and getConnection() returns the open block's `transactionConnection` while
     * a block is being processed. Routing queue writes through it would attach
     * operational queue I/O to the block's ACID transaction (committed/rolled
     * back with the block) and risk two statements sharing one physical
     * connection. _poolQuery() always draws an independent pooled connection.
     */

    // Run a query on a fresh pooled connection, isolated from any in-progress
    // block transaction. Always releases the connection.
    async _poolQuery(query, args){
        let conn = await this.pool.getConnection();
        try {
            return await conn.query(query, args);
        } finally {
            await conn.release();
        }
    }

    // API-path view of this DB instance: same methods, but every doQuery()
    // draws an independent pooled connection (_poolQuery) instead of routing
    // through getConnection(), which returns the open block's
    // transactionConnection while a block is processing. Any federation RPC
    // handler that WRITES must use this view. There is none today (the last one,
    // pushvalidatorrewards, was retired), and the rule is what made that safe: a
    // write landing mid-block would otherwise join the block's ACID transaction
    // and be rolled back on a reorg/throw AFTER the API already acked it (the
    // caller never retries), and its statements would share the block's physical
    // connection with commitTransaction()'s release. The view also sees only
    // COMMITTED state, so stake-source resolution never reads rows the block
    // may still roll back. Do NOT use it for anything that opens its own
    // transaction (e.g. the dry-run path): the override bypasses
    // transactionConnection entirely.
    apiView(){
        if(!this._apiView){
            this._apiView = Object.create(this);
            this._apiView.doQuery = (query, args) => this._poolQuery(query, args);
            // doQueryStrict must also bypass transactionConnection. _poolQuery already throws on a
            // query error (no swallow), so it satisfies the strict contract. Without this override,
            // a method that internally calls doQueryStrict (e.g. createReorg) would still adopt an
            // open foreign transaction when invoked on the view - defeating the reorg-path isolation
            // that routes createReorg / the rollback read-phase through this view (REORG-1).
            this._apiView.doQueryStrict = (query, args) => this._poolQuery(query, args);
            // Own block_time memo so a federation read's getBlockTime (XCC-2 expiration filter)
            // can never torn-write or evict the block loop's shared _blockTimeCache, which feeds
            // the consensus-path ProtocolChanges.isEnabled. Without this the view inherits the
            // instance's single-entry memo by reference (Object.create) and the two paths race.
            this._apiView._blockTimeCache = { block_index: null, block_time: null };
        }
        return this._apiView;
    }

    // Stage a hub push (already durably written via enqueueHubPushTx inside the open block
    // transaction) for an immediate live delivery attempt AFTER the block commits. XChainIndexer
    // installs a fresh _stagedHubPushes array at the start of each block and drains it post-commit
    // (mirroring rollback.js's post-commit retraction delivery). A rollback simply never drains the
    // array (it is replaced at the next block start), and the durable rows were rolled back with the
    // transaction, so nothing phantom survives. Inert (no-op) when no array is installed.
    stageHubPush(entry){
        if(Array.isArray(this._stagedHubPushes)) this._stagedHubPushes.push(entry);
    }

    // Return the staged hub pushes for this block and clear the buffer, so a post-commit drain
    // consumes each entry exactly once. Returns [] when nothing was staged.
    takeStagedHubPushes(){
        let staged = Array.isArray(this._stagedHubPushes) ? this._stagedHubPushes : [];
        this._stagedHubPushes = Array.isArray(this._stagedHubPushes) ? [] : this._stagedHubPushes;
        return staged;
    }

    // Source-keyed all-staker weights at `blockIndex` - the STAKE_WEIGHTED_QUORUM
    // counterpart of getActiveValidators (the config-change PBFT's whole-federation
    // set). Every source with ANY active stake (no MIN_STAKE floor) and all its
    // effective keys, each carrying the source address + the source's aggregate
    // weight, so Σ weight over DISTINCT sources = S. Used by xchain-hub's Consensus
    // when weighting governance/config quorum by stake. CONSENSUS-CRITICAL: shares
    // the DELEGATE-additive _stakeWeightsSql with getStakeWeightsByCapability, so it
    // resolves identically on every hub (a divergence forks config consensus).
    async getActiveStakeWeights(blockIndex){
        let valid_id = await this.getStatusId('valid');
        if(valid_id === null) return [];
        // Safety cap - see getActiveValidators. No MIN_STAKE floor (minStake '0').
        let { rows, truncated } = await this._stakeWeightsWithCap(valid_id, blockIndex, '0', 'getActiveStakeWeights');
        let result = rows;
        // Surface truncation to callers (the RPC layer alarms on it) the same way
        // the capability variants do - the console.warn alone is invisible to a hub.
        result.truncated = truncated;
        return result;
    }

    // ── Stake-weighted quorum (STAKE_WEIGHTED_QUORUM) ─────────────────────────
    // Source-keyed validator weights for a capability at a BTC-anchored block.
    // Weight belongs to the staking ADDRESS (source), NOT the signing key: DELEGATE
    // v0 is additive - one source may authorize many keys, all backed by the source's
    // aggregate stake (DELEGATE.md "Effective signer set") - so a pubkey-keyed weight
    // would let one stake vote (N+1)x by delegating N keys. Returns one row per
    // effective signer key, each carrying its `source` (address) + the source's
    // aggregate `weight`. Σ weight over DISTINCT sources = S. CONSENSUS-CRITICAL:
    // must resolve identically on the hub and every indexer or validation forks.
    async getStakeWeightsByCapability(capability, blockIndex, minStakeOverride){
        // Off-BTC chains have no local capability stakes - read the source-keyed
        // weights from the hub-mirrored capability_snapshots. Routed through the SAME
        // predicate as getValidatorsByCapability so the count set and the weight set can
        // never come from different sources; see usesCapabilitySnapshot.
        if(usesCapabilitySnapshot(this.config, capability))
            return await this.getCapabilitySnapshotWeights(capability, blockIndex);
        let caps = (this.config['STAKING'] && this.config['STAKING']['CAPABILITIES']) ? this.config['STAKING']['CAPABILITIES'] : {};
        let capConfig = caps[capability];
        if(!capConfig) return [];
        // Caller-supplied threshold (the hub's authoritative, signed/governance-
        // anchored MIN_STAKE) is honoured VERBATIM, identically to
        // getValidatorsByCapability/getActiveCapabilityCount/hasCapability - this
        // keeps the count path and weight path symmetric AND keeps every indexer
        // computing the same set for the same block (cross-hub/cross-indexer
        // determinism). The local floor is ONLY the default when no override is
        // supplied; it never clamps an explicit caller value. Anti-inflation lives
        // at the hub + on-chain-validation layers, not in this read path.
        let localFloor = capConfig['MIN_STAKE'] || '0';
        let minStake = (minStakeOverride !== undefined && minStakeOverride !== null)
            ? String(minStakeOverride)
            : localFloor;
        let valid_id = await this.getStatusId('valid');
        if(valid_id === null) return [];
        let { rows, truncated } = await this._stakeWeightsWithCap(valid_id, blockIndex, minStake, 'getStakeWeightsByCapability(' + capability + ')');
        let result = rows;
        result.truncated = truncated;
        return result;
    }

    // Run the source-keyed stake-weight query under the cap regime in force for this
    // chain at `blockIndex`, returning { rows:[{pubkey,source,weight}], truncated }.
    //   at/after SWQ_SOURCE_CAP_ACTIVATION -> windowed source-cap (_cappedStakeWeightsSql):
    //       truncated ONLY when a genuinely >maxSources federation is seen; a
    //       key-spamming source is bounded (maxKeys) without truncating.
    //   below it -> legacy uncapped key-row LIMIT: truncated at >= VALIDATOR_QUERY_LIMIT.
    // The gate (network/coin/blockIndex) + caps + _cappedStakeWeightsSql are byte-mirrored
    // in xchain-sync so the stakes_root set is identical on both sides of the height.
    async _stakeWeightsWithCap(valid_id, blockIndex, minStake, label){
        let sw = this._stakeWeightsSql(valid_id, blockIndex, minStake);
        // Ordering collation for BOTH regimes (stake_weight_collation_activation.js);
        // the legacy LIMIT branch truncates on the same order the capped branch ranks on.
        let binCollation = stakeWeightCollation.isStakeWeightBinCollationActive(
            blockIndex, this.config['NETWORK'], this.config['COIN']);
        let swc = stakeWeightCollation.stakeWeightCollate(binCollation);
        if(swqCap.isSwqSourceCapActive(blockIndex, this.config['NETWORK'], this.config['COIN'])){
            let maxSources = swqCap.STAKE_WEIGHT_MAX_SOURCES;
            let maxKeys    = swqCap.STAKE_WEIGHT_MAX_KEYS_PER_SOURCE;
            let capped = this._cappedStakeWeightsSql(sw, maxSources, maxKeys, binCollation);
            let raw = await this.doQuery(capped.sql, capped.args);
            let truncated = raw.some(r => Number(r._sr) > maxSources);
            if(truncated)
                console.warn(label + ' saw more than ' + maxSources + ' distinct staking sources at block ' + blockIndex + ' - snapshot truncated; stake-weighted quorum fails closed. Raise STAKE_WEIGHT_MAX_SOURCES (coordinated flag-day upgrade) if the federation has grown.');
            let rows = (truncated ? raw.filter(r => Number(r._sr) <= maxSources) : raw).map(r => ({
                pubkey: String(r.pubkey),
                source: String(r.source),
                weight: requireStakeWeight(r.weight, label)
            }));
            return { rows, truncated };
        }
        let limit = this.config['VALIDATOR_QUERY_LIMIT'];
        let query = `${sw.sql} ORDER BY source${swc}, pubkey${swc} LIMIT ?`;
        let raw = await this.doQuery(query, [...sw.args, limit]);
        let truncated = raw.length >= limit;
        if(truncated)
            console.warn(label + ' hit the result cap of ' + limit + ' rows at block ' + blockIndex + ' - set may be truncated. Raise the frozen VALIDATOR_QUERY_LIMIT consensus constant (coordinated fleet upgrade) if the federation has grown.');
        let rows = raw.map(r => ({
            pubkey: String(r.pubkey),
            source: String(r.source),
            weight: requireStakeWeight(r.weight, label)
        }));
        return { rows, truncated };
    }

    // Re-derive ONE hub-mirrored capability_snapshots row against this node's OWN
    // authoritative stakes at the row's snapshot_block, and say whether the hub's
    // claim contradicts what this chain can prove.
    //
    // capability_snapshots is the only mirrored table with no authentication on the
    // wire: rows arrive over a bare SELECT and land via INSERT IGNORE, and they are the
    // verification authority every off-BTC resolver reads (cross_chain, oracle_publish,
    // price, attestation). The full remedy is an SMT membership proof against the BTC
    // state_checkpoints stakes_root, which needs a new hub endpoint, a trust anchor, an
    // activation height and a grandfathering watermark. This is the FIRST step of that
    // ladder and nothing more: falsifiability, not coverage.
    //
    // Its honest limit, stated so no caller mistakes it for the proof: it protects BTC
    // ONLY, because BTC is the one chain whose capability stakes are local and therefore
    // the one chain that can re-derive a row without trusting anyone. It is also the one
    // chain that does NOT read the mirror to resolve a capability (usesCapabilitySnapshot
    // is false on BTC). What it buys is that a hub serving FORGED validator sets is
    // caught on the BTC indexers rather than being silently mirrored everywhere.
    //
    // Verdict shape is anchor_proof_client.js's, deliberately:
    //   'verified' - the row's (signing_pubkey, source, amount) matches this node's own
    //                effective-signer set and source aggregate at snapshot_block.
    //   'refused'  - this node CAN re-derive that block and the row contradicts it.
    //   'unknown'  - this node cannot judge (block not reached, capability not local,
    //                set truncated, read failed). The caller applies the row as before:
    //                an unjudgeable row must never become a mirror hole.
    //
    // The local set is re-derived with minStake '0' ON PURPOSE. The hub filters its rows
    // by its OWN authoritative MIN_STAKE, which can legitimately differ from this node's
    // local floor, so re-deriving at the local floor would refuse honest rows the moment
    // the two drifted. At '0' the local set is the widest superset (every source with any
    // active stake, every effective key of it), and per-source weight is the source
    // aggregate, which no threshold changes. So this check asks only "could this key, under
    // this source, carry this weight here?" - a contradiction is real, and the rows the hub
    // legitimately withheld simply are not examined. Completeness (a row the hub SHOULD
    // have served and did not) is NOT checkable without knowing the hub's MIN_STAKE and is
    // deliberately out of scope for this step.
    async verifyCapabilitySnapshotRow(row){
        if(!row) return { verdict: 'unknown', reason: 'no row' };
        let capability = row.capability == null ? '' : String(row.capability);
        // A chain that RESOLVES this capability from the mirror has no local stakes to
        // re-derive from; asking it would compare the mirror against itself.
        if(usesCapabilitySnapshot(this.config, capability))
            return { verdict: 'unknown', reason: 'this chain resolves ' + capability + ' from the mirror' };
        if(!this.isCapabilityConfigured(capability))
            return { verdict: 'unknown', reason: 'capability ' + capability + ' is not configured on this node' };
        let block = Number(row.snapshot_block);
        if(!Number.isFinite(block) || block < 0 || Math.floor(block) !== block)
            return { verdict: 'unknown', reason: 'unusable snapshot_block ' + String(row.snapshot_block).slice(0, 32) };
        // Availability fence. Below our own tip the stake history at `block` is whatever
        // we have parsed so far, which for an unreached block is nothing - refusing there
        // would reject every honest row served ahead of our sync.
        let tip = await this.getLatestBlockIndex();
        if(!(Number(tip) >= block))
            return { verdict: 'unknown', reason: 'local tip ' + tip + ' has not reached snapshot_block ' + block };
        let local;
        try {
            local = await this.getStakeWeightsByCapability(capability, block, '0');
        } catch(e) {
            return { verdict: 'unknown', reason: 'local stake re-derivation failed: ' + (e && e.message ? e.message : e) };
        }
        if(!Array.isArray(local))
            return { verdict: 'unknown', reason: 'local stake re-derivation returned no set' };
        // A truncated set is a PARTIAL set: a row missing from it may be missing only
        // because the cap cut it off, so no refusal can be drawn from this block.
        if(local.truncated)
            return { verdict: 'unknown', reason: 'local stake set truncated at block ' + block };
        let pubkey = String(row.signing_pubkey == null ? '' : row.signing_pubkey).toLowerCase();
        let source = String(row.source == null ? '' : row.source).toLowerCase();
        let match = null;
        for(let r of local){
            if(String(r.pubkey).toLowerCase() === pubkey &&
               String(r.source == null ? '' : r.source).toLowerCase() === source){ match = r; break; }
        }
        if(match === null)
            return { verdict: 'refused',
                     reason: 'no local stake makes ' + pubkey.slice(0, 16) + ' an effective signer for source ' +
                             source.slice(0, 24) + ' at block ' + block };
        if(normalizeStakeAmount(match.weight) !== normalizeStakeAmount(row.amount))
            return { verdict: 'refused',
                     reason: 'weight for ' + pubkey.slice(0, 16) + '/' + source.slice(0, 24) + ' at block ' + block +
                             ' is locally ' + String(match.weight).slice(0, 32) + ', hub served ' +
                             String(row.amount).slice(0, 32) };
        return { verdict: 'verified' };
    }

    // Whether `capability` is present in this indexer's STAKING.CAPABILITIES config.
    // Lets the hub-facing getcapabilityvalidators RPC distinguish a genuinely empty
    // validator set from a capability this indexer doesn't know about - the latter
    // signals config drift during a capability rollout and must surface as an error
    // rather than an empty set that looks identical to "no qualified validators".
    isCapabilityConfigured(capability){
        let caps = (this.config['STAKING'] && this.config['STAKING']['CAPABILITIES']) ? this.config['STAKING']['CAPABILITIES'] : {};
        return !!caps[capability];
    }

    // Connection for hub-mirrored tables (price_snapshots, oracle_prices,
    // cross_chain_matches, capability_snapshots). In distributed deployments these live in
    // the local hub-DB copy; single-host falls back to this indexer DB. Mirrors the
    // `(this.actions.hubDb || this.indexerDb)` idiom used at the oracle read sites.
    _mirrorDb(){
        return (this.indexer && this.indexer.hubDb) ? this.indexer.hubDb : this;
    }

    // Whether this indexer binds mirrored rows by admission height at block B: the consumer
    // side of the mirror-admission flag day for (COIN, NETWORK). A caller that passes no
    // height reads as below the activation, which is today's clock form, so every existing
    // call shape keeps its meaning; the block loop's callers all pass their block index.
    _mirrorAdmissionActiveAt(blockHeight){
        if(blockHeight === null || blockHeight === undefined) return false;
        return isMirrorAdmissionConsumerActive(this.config['COIN'], this.config['NETWORK'], blockHeight);
    }

    // This chain's admission column on the mirrored cross-chain tables, `admit_block_<c>` in
    // the hub's own DDL spelling, built from the configured coin and never from anything read
    // off the wire. The columns arrive with the indexer's dated admission migration; nothing
    // reads them below the activation, which is every network in this train.
    _admitColumn(){
        return 'admit_block_' + String(this.config['COIN'] || '').toLowerCase();
    }

    // The binding clause of a mirrored select at block B, with its bindings.
    //
    // Below the activation this is `effective_time <= ?`, byte for byte the text the select
    // has always issued, with one binding. Above it, the C33 form for this chain's column:
    //
    //   (admit_block_<c> IS NULL AND effective_time <= ?) OR (admit_block_<c> IS NOT NULL AND admit_block_<c> <= ?)
    //
    // wrapped in one more pair of parentheses so it composes under the select's own ANDs, and
    // NEVER a bare `admit_block_<c> <= ?`: a bare comparison on a nullable column evaluates to
    // NULL for every legacy row and silently drops it, the silent consensus change this file's
    // own eff_expiration case study documents. The IS NULL arm is the legacy-row rule and it
    // holds at every height, so a row finalized below the producer activation, and a row whose
    // map never named this chain, both bind exactly as they do today (C38).
    //
    // `alias` prefixes every column for a select that aliases its table; `column` overrides the
    // chain column for the one table that carries a single fixed column (attestation_responses,
    // BTC-only by its call-site guard). bridge_settle.js carries the same clause text for its
    // two selects and the admission-binding suite pins the two spellings equal.
    _mirrorBindClause(blockTime, blockHeight, alias, column){
        let p   = alias ? alias + '.' : '';
        if(!this._mirrorAdmissionActiveAt(blockHeight))
            return { sql: p + 'effective_time <= ?', args: [blockTime] };
        let col = p + (column || this._admitColumn());
        return {
            sql:  '((' + col + ' IS NULL AND ' + p + 'effective_time <= ?) OR (' + col + ' IS NOT NULL AND ' + col + ' <= ?))',
            args: [blockTime, Number(blockHeight)]
        };
    }

    // The usable v2 continuation chunks stored for an archive batch: rejected
    // rows (status 'invalid: ...') are excluded and the result is deduped to
    // ONE row per chunk_index (lowest action_index wins, deterministically).
    // anchor_actions stores a row for EVERY parsed ANCHOR (the verdict lives
    // in STATUS) and idx_anchor_batch is NON-unique, so a permissionless junk
    // v2 tx adds a countable row for an existing (batch, index): unfiltered,
    // that row inflated the readers' chunk counts - the duplicate guard then
    // stamped the LEGITIMATE chunk 'invalid: CHUNK_INDEX (duplicate)', the
    // live invalid_archive CRC check never fired, and AnchorRecovery threw
    // 'incomplete batch' forever (finding #2269). 'orphan' rows are KEPT: a
    // chunk that landed before its parent v1 carries legitimate archive
    // bytes. Mirrors rollback.js's valid-chunk self-join and the recovery.js
    // v1 status filter. #3075 added the authorship term and moved the whole
    // query into anchor-action-query.js (ARCHIVE_CHUNK_SET_SQL), which
    // recovery._verifyBatch now requires verbatim, so the two can no longer
    // drift by hand-copy: only chunks authored by the CANONICAL archive head
    // count, which is what stops a junk chunk broadcast BEFORE the head (stored
    // 'orphan', so it carries no rejection verdict of its own) from squatting a
    // slot and denying the batch permanently.
    // `author`, when supplied, replaces "authored by the canonical head" with
    // "authored by THIS address", the read-path half of publisher-scoped archive
    // batches. anchor.js supplies it (gated) so the chunk set a head reassembles - and
    // the occupancy set the duplicate guard reads - belong to that head's own
    // publisher, not to whoever happened to broadcast the earliest row for the seq.
    // Omitted / null runs the legacy canonical-head query unchanged.
    async getAnchorChunks(batchSeq, author){
        let rows = (author !== undefined && author !== null)
            ? await this.doQuery(ARCHIVE_CHUNK_SET_BY_AUTHOR_SQL, [batchSeq, String(author)])
            : await this.doQuery(ARCHIVE_CHUNK_SET_SQL, [batchSeq, batchSeq]);
        return dedupeArchiveChunks(rows);
    }

    // CONTENT-ADDRESSED archive-head lookup: the archive-anchor head for one batch
    // identified by WHAT IT CONTAINS (checkpoint identity + batch_crc32 + match_count)
    // rather than by the match_batch_seq it happened to be published under.
    //
    // getAnchorV1ByBatchSeq above cannot serve this question at all. Its key is
    // match_batch_seq, and the caller that needs this read (the hub's archive publish
    // path, recovering from a crash between "head broadcast" and "batch recorded") has
    // by definition lost that seq: the re-election allocates a fresh one. The content
    // key is the only identity that survives the restart, and the publisher signs it
    // into the v1 canonical, so both sides can compute it.
    //
    // `author` scopes the answer to one publishing address. Supplied, the question
    // becomes "did THIS publisher already publish this batch", which is the only form
    // safe to act on: unscoped, a copy of an already-mined head broadcast by anyone
    // answers yes for a batch whose chunks that party never sent.
    //
    // Returns the head row (with `source` = author address and `txid`) plus the chunk
    // rows already on-chain for it, so a partially published batch is resumable:
    // { head, chunks } with head null when nothing matches (chunks then empty).
    // Status is NOT filtered here for the reason ARCHIVE_CHUNK_SET_SQL is not
    // status-filtered either: a mirrored and an unmirrored node store the same head
    // under different statuses, and the caller applies its own verdict.
    async getArchiveAnchorByContent(chain, network, block_index, checkpoint_seq, batch_crc32, match_count, author){
        let rows = await this.doQuery(ARCHIVE_ANCHOR_BY_CONTENT_SQL,
            [chain, network, Number(block_index), Number(checkpoint_seq),
             String(batch_crc32).toLowerCase(), Number(match_count)]);
        let head = selectArchiveHeadRow(rows, { author: (author != null && author !== '') ? author : null });
        if(!head) return { head: null, chunks: [] };
        // Chunks are read under the head's OWN seq and author, never the caller's:
        // that pairing is what lets a resuming publisher address slots allocated by a
        // process that is gone. A head with an unresolvable author has no chunk set
        // that can be attributed, so report none rather than the whole seq's rows.
        let chunks = head.source != null
            ? await this.getAnchorChunks(Number(head.match_batch_seq), String(head.source))
            : [];
        return { head, chunks };
    }

    // Rewrite one contract_stakes / contract_unstakes row's signing key and journal the previous
    // value so a reorg can restore it verbatim (see rollback.js) and xchain-sync can carry the
    // mutated surviving row to followers (updatedRows.js). Shared by the rotate and revert passes
    // above. `table` is a fixed literal from this method, never caller input.
    async _rotateContractStakeKey(table, stakeRow, delegationActionIndex, newPubkeyId, blockIndex){
        await this.doQuery('UPDATE ' + table + ' SET signing_pubkey_id=? WHERE action_index=?',
            [newPubkeyId, stakeRow.action_index]);
        await this.createContractDelegationRotation(table, delegationActionIndex, stakeRow.action_index,
            stakeRow.signing_pubkey_id, newPubkeyId, blockIndex);
        return {
            target_table:            table,
            stake_action_index:      Number(stakeRow.action_index),
            delegation_action_index: Number(delegationActionIndex),
            prev_signing_pubkey_id:  Number(stakeRow.signing_pubkey_id),
            new_signing_pubkey_id:   Number(newPubkeyId),
            block_index:             Number(blockIndex)
        };
    }

    /*
     * Programmable policy layer - controller bindings (token_controllers / address_controllers).
     *
     * A token (ISSUE format 7) or an account (ADDRESS format 1) defers a chosen action-class to a
     * guard contract. These two tables are APPEND-ONLY event logs: every bind/unbind is one
     * immutable row keyed by its own action_index. The EFFECTIVE controller for a (subject, class)
     * at block X is the latest event with block_index <= X - a `bind` gates; an `unbind` gates ONLY
     * while X < cooldown_end_block (the drop-cooldown's teeth: a thief can't instantly drop a
     * spend-limit), and stops gating once X reaches it. Cooldown expiry is therefore computed at
     * READ time, never swept - so no row ever mutates, and both tables roll back cleanly as plain
     * dataTables (DELETE WHERE action_index >= orphan, then forward replay re-creates the events).
     * "At most one live controller per (subject, class)" is enforced by the handlers: a BIND is
     * rejected when an effective controller already gates that class (replace = unbind-then-bind,
     * which preserves the cooldown's teeth). action_class ∈ {transfer, trade, burn, mint, stake,
     * ownership}, validated by the handler. See Controller_Bound_Tokens.md.
     */

    // Append a token controller bind/unbind event. `evt` carries action_index, tick_id, action_class,
    // contract_index, bound_by_id, is_unbind, cooldown_blocks, cooldown_end_block, block_index.
    async recordTokenControllerEvent(evt){
        let query = `INSERT INTO token_controllers
                        (action_index, tick_id, action_class, contract_index, bound_by_id,
                         is_unbind, cooldown_blocks, cooldown_end_block, block_index)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        await this.doQuery(query, [evt.action_index, evt.tick_id, evt.action_class, evt.contract_index,
            evt.bound_by_id, evt.is_unbind ? 1 : 0, evt.cooldown_blocks, evt.cooldown_end_block, evt.block_index]);
    }

    // Read-time cooldown rule: a `bind` event gates; an `unbind` event gates only while
    // atBlock < cooldown_end_block. Returns the row when it is still gating, else null.
    controllerEventIfGating(row, atBlock){
        if(!row) return null;
        if(Number(row.is_unbind) === 1){
            if(this.util.isNull(row.cooldown_end_block)) return null;
            return (Number(atBlock) < Number(row.cooldown_end_block)) ? row : null;
        }
        return row;
    }

    // Effective (still-gating) controller for one (subject, class), or null.
    async getEffectiveTokenController(tick_id, action_class, atBlock, atActionIndex){
        let row = await this.readLatestControllerEvent('token_controllers', 'tick_id', tick_id, action_class, atBlock, atActionIndex);
        return this.controllerEventIfGating(row, atBlock);
    }

    async getEffectiveAddressController(address_id, action_class, atBlock, atActionIndex){
        let row = await this.readLatestControllerEvent('address_controllers', 'address_id', address_id, action_class, atBlock, atActionIndex);
        return this.controllerEventIfGating(row, atBlock);
    }

    // Guard-resolution: which single controller gates an ACTION of this class. Most-specific-wins -
    // a class-specific binding overrides the catch-all 'all' binding; if none, fall back to 'all'.
    // Exactly one row out → one guard runs → no stacking. Enforcement-ONLY: bind/unbind validation
    // must use the exact getters above (the fallback would falsely report a class as "already bound"
    // when only 'all' is bound, blocking the intended specific-class override).
    async getEffectiveTokenControllerForGuard(tick_id, action_class, atBlock, atActionIndex){
        let row = await this.getEffectiveTokenController(tick_id, action_class, atBlock, atActionIndex);
        if(row) return row;
        if(action_class === 'all') return null;
        return this.getEffectiveTokenController(tick_id, 'all', atBlock, atActionIndex);
    }

    async getEffectiveAddressControllerForGuard(address_id, action_class, atBlock, atActionIndex){
        let row = await this.getEffectiveAddressController(address_id, action_class, atBlock, atActionIndex);
        if(row) return row;
        if(action_class === 'all') return null;
        return this.getEffectiveAddressController(address_id, 'all', atBlock, atActionIndex);
    }

    // Effective controllers for a subject: Map<action_class, contract_index> over the latest gating
    // event per class (read-time cooldown applied). For Phase B enforcement reads.
    async getTokenControllers(tick_id, atBlock, atActionIndex){
        return this.readEffectiveControllerMap('token_controllers', 'tick_id', tick_id, atBlock, atActionIndex);
    }

    async getAddressControllers(address_id, atBlock, atActionIndex){
        return this.readEffectiveControllerMap('address_controllers', 'address_id', address_id, atBlock, atActionIndex);
    }

    // Create record in `withdrawals` table
    async createWithdrawal(data){
        data             = this.normalizeDataValues(data);
        let status_id    = await this.createStatus(data['STATUS']);
        let source_id    = await this.getAddressId(data['SOURCE']);
        let tick_id      = await this.createTicker(data['TICK']);
        let action_index = data['ACTION_INDEX'];
        let contract_index = data['CONTRACT_ACTION_INDEX'];
        let amount       = data['AMOUNT'];
        let block_index  = data['BLOCK_INDEX'];
        let query  = "SELECT action_index FROM withdrawals WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE withdrawals SET
                        contract_index=?, source_id=?, tick_id=?, amount=?, status_id=?, block_index=?
                    WHERE action_index=?`;
            args = [contract_index, source_id, tick_id, amount, status_id, block_index, action_index];
        } else {
            query = `INSERT INTO withdrawals
                        (contract_index, source_id, tick_id, amount, status_id, block_index, action_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`;
            args = [contract_index, source_id, tick_id, amount, status_id, block_index, action_index];
        }
        await this.doQuery(query, args);
    }

    /*****************************************************************
     * VM Integration - Savepoints
     ****************************************************************/

    // Create a savepoint within the current transaction
    async createSavepoint(name){
        this._assertTxNotFenced();
        if(!this.transactionConnection)
            throw new Error('createSavepoint requires an active transaction');
        await this.transactionConnection.query('SAVEPOINT ' + name);
        return name;
    }

    // Release a savepoint
    async releaseSavepoint(name){
        this._assertTxNotFenced();
        if(!this.transactionConnection)
            throw new Error('releaseSavepoint requires an active transaction');
        await this.transactionConnection.query('RELEASE SAVEPOINT ' + name);
    }

    // Rollback to a savepoint
    async rollbackToSavepoint(name){
        this._assertTxNotFenced();
        if(!this.transactionConnection)
            throw new Error('rollbackToSavepoint requires an active transaction');
        await this.transactionConnection.query('ROLLBACK TO SAVEPOINT ' + name);
    }

    // Build the balance + token-info snapshot the VM gateway exposes through
    // xchain.getBalance(address, tick) and xchain.getTokenInfo(tick). Scoped to
    // the explicitly passed addresses (the EXECUTE/DEPLOY SOURCE + the contract's
    // own derived address) - arbitrary-address reads inside a contract resolve to
    // null because they cannot be pre-loaded deterministically.
    //
    // Determinism: every read is bounded by `action_index < ?` (pre-action ledger
    // state - the contract's own mid-execution emissions are not yet persisted, so
    // a contract sees the balance it held going in, identical on every validator).
    // Amounts are mathjs-bignumber strings (no float). Reads run SERIALLY: during
    // block processing these share the single transaction connection, which cannot
    // serve concurrent queries (see updateAddressBalances).
    //
    // Returns the nested, SYMBOL-keyed shapes the gateway consumes:
    //   balances  = { addressString: { tickSymbol: amount } }
    //   tokenInfo = { tickSymbol: { TICK, TICK_ID, DECIMALS, SUPPLY, OWNER, ... } }
    async buildVmBalancesAndTokenInfo(addresses, blockIndex, actionIndex){
        let balances  = {};
        let tokenInfo = {};
        let tickCache = {}; // tick_id -> symbol, reused across addresses (avoids N+1)

        for(let address of addresses){
            if(this.util.isNull(address))
                continue;
            // Flat { tick_id: amount } at pre-action state.
            let flat = await this.getAddressBalances(address, null, blockIndex, actionIndex);
            let bySymbol = {};
            for(let tick_id in flat){
                let symbol = tickCache[tick_id];
                if(symbol === undefined){
                    symbol = await this.getTicker(tick_id);
                    tickCache[tick_id] = symbol; // cache null too - avoids re-querying a missing id
                }
                if(this.util.isNull(symbol))
                    continue;
                // getAddressBalances returns mathjs-bignumber OBJECTS (via bcsub/bcnum).
                // The gateway exposes these to contracts that feed them straight into
                // xchain.math (gte/subtract/...), and the value is copied across the
                // isolated-vm boundary - where a bignumber object degrades to a plain
                // object and math throws "[DecimalError] Invalid argument: [object Object]".
                // Stringify to the canonical numeric form (matches getAddressBalances'
                // other consumer in getBalancesForAddress).
                bySymbol[symbol] = String(flat[tick_id]);
                // Load token metadata once per referenced symbol (getTokenInfo
                // returns false when the tick does not exist at this action_index).
                if(tokenInfo[symbol] === undefined){
                    let info = await this.getTokenInfo(symbol, blockIndex, actionIndex);
                    if(info)
                        tokenInfo[symbol] = info;
                }
            }
            balances[address] = bySymbol;
        }

        return { balances, tokenInfo };
    }

}

// Published before the mixins load, so a mixin that reads the class for its statics
// resolves to the class itself rather than to a half-built export.
module.exports = Database

// Startup DB-connect resilience (#3168). Cap transient connect retries so a boot never
// hangs silently forever; a non-retryable auth/grant error fails fast so pm2 surfaces it
// (a crash-loop is a visible signal, an unbounded silent hang is not).
Database.DB_CONNECT_MAX_ATTEMPTS = 12; // ~60s of 5s backoff before giving up on a transient fault
Database._isNonRetryableDbError = function(e){
    if(!e) return false;
    // MariaDB/MySQL auth + grant errnos: 1045 access denied (bad password),
    // 1044 access denied to database, 1698 auth-plugin denied. These never self-heal.
    let errno = e.errno;
    if(errno === 1045 || errno === 1044 || errno === 1698) return true;
    let code = String(e.code || '');
    return code === 'ER_ACCESS_DENIED_ERROR' || code === 'ER_DBACCESS_DENIED_ERROR';
};

// Applied-migration files whose checksum may be healed in place. Each entry maps
// a `from` predecessor hash (or a list of them) to a single `to` hash pinned to a
// reviewed edit; anything else still fails the immutability guard in runMigrations().
// `from` may be a list because one reviewed edit can supersede several historical
// file revisions and each DB recorded whichever revision it applied first (mirrors
// the sibling xchain-decoder ledger).
Database.MIGRATION_CHECKSUM_REBASELINES = {
    // ba430f8 retagged the DROP from mode=auto to mode=manual (safety fix);
    // the executable statement is unchanged.
    '2026-06-16-drop-orphaned-contract-balances.sql': {
        from: '287d7bdb0b1a27308bdfd5a433f659aa466e3856f55b361a8b2e89a4ad146f76',
        to:   '70de5f0ee1146c569b62c75cddb77be8eba72b9963a066b5059f05de15ccdef2',
    },
    // Added `AFTER state_key` so the migration lands the generated column in the same
    // position contract_state.sql declares it (column-order convergence, aged vs fresh).
    // A DB that already applied the old file has the column at the tail; the clause is
    // guarded by IF NOT EXISTS, so re-reading the new file is a no-op there and only the
    // ledger checksum needs to heal. The tail position itself is converged by a SEPARATE
    // migration, 2026-07-16-reposition-state-key-bin.sql (MODIFY ... AFTER state_key,
    // mode=manual), which is what makes an aged install match a fresh SHOW CREATE TABLE;
    // this entry heals the ledger only and moves no column.
    //
    // NOT A PRECEDENT. It is the one executable edit rebaselined here, and only because
    // IF NOT EXISTS makes the re-read a true no-op AND that follow-up migration carries the
    // real convergence. An executable edit that changes what an already-applied file DOES
    // still needs its own dated migration, never an entry in this table.
    '2026-07-10-contract-state-bin-key-index.sql': {
        from: '04656bbe931851e254f51c2f4552e8e0ab2c47067cb7eb39dcbb7f4695d38dd1',
        to:   '15599a2f13a372767468cd72ec05b7dff50d03e095e77cd40ee16bcba52754c6',
    },
    // Two of the three renamed legacy migrations carry their own filename inside
    // the "HOW TO RUN" comment block, so 81960e2 (the rename) had to update that comment
    // line as well. The ledger rename heal re-keys the ROW NAME but deliberately carries
    // the recorded checksum over unchanged, so every DB migrated before 2026-07-12 (the
    // whole prod fleet) then compared a pre-rename hash against the post-rename file and
    // logged `content CHANGED` on every single start. A guard that always fires cannot
    // report a real migration edit, so both files are rebaselined here.
    //
    // Each `from` list is the file's complete set of pre-current committed revisions since
    // the ledgered runner existed (351604c); every delta between them and `to` is a comment
    // line only, verified by diff:
    //   351604c-era -> 81960e2 : the HOW TO RUN path comment gained the dated filename.
    //   397e373     -> 88469e6 : the license-header sweep prepended a 14-line banner and
    //                            was reverted the same day for exactly this reason; a DB
    //                            that migrated inside that window recorded the banner hash.
    // The executable DDL is byte-identical across all of them, so re-reading the current
    // file against a DB on any of these revisions would be a no-op. Revisions older than
    // 351604c are intentionally NOT listed: no ledger existed to record them.
    '2026-06-03-unique-full-column-index-addresses.sql': {
        from: [
            '9fdbbcbda36b860a3214d5fcc3d057f3bdf413a99c9d5407e7ef9951a318fb1e', // 351604c, pre-rename
            '8193fe4eca04ac802b5963a7f3b100bf2b3f3103aaeb18e8eb5ff88b8f5f557d', // 397e373, header sweep
        ],
        to: 'a5ffca0798dc5e58c15f2dce7d678452666fef4814d7b560bc4b39c89c1f7dc5',
    },
    '2026-06-09-cross-chain-matches-partial-fill-columns.sql': {
        from: [
            '289d9fe5fb41f8012e7cbcdb3d6c2e2a8c983ca84afd920d73b386a33d64e602', // 351604c, pre-rename
            '7fe66226c936023b72121c24fb3cfbea5bd4e52e70964542a6617f12b2a74451', // 397e373, header sweep
        ],
        to: '5adb9505a4986bd5a0d0c82bf1fff46a39621c7a2d17b4846d5d51eb224bc20e',
    },
    // The licence-header sweep (f1161ec) rewrote the comment block at the top of every
    // migration file AFTER the fleet had applied these ten, so every database that ran
    // them before the sweep records the pre-sweep hash. Verified one by one rather than
    // assumed: strip `--` lines and blanks and the residue hashes IDENTICALLY to HEAD for
    // all ten, so no executable SQL moved and the ordinary contract above is met.
    //
    // FIVE of the ten had to be recovered from ORPHANED BLOBS: the published-history
    // rewrite left their pre-sweep revisions unreachable from any commit, so a `git log`
    // range finds nothing and only a scan of the whole object store (6241 blob candidates)
    // turns them up. Note the recorded value is a SHA-256 of CONTENT while git object names
    // are SHA-1, which is why the recorded hash never appears as an object name.
    // BTC, LTC and DOGE mainnet all record the SAME hash per file, so one `from` each.
    '2026-07-05-polls-binding-callback-columns.sql': {
        from: '2c6bb959768a2fd2c87bbefadefdd51710c305652c31146cdb8f8996ad0b38e4',
        to:   'abcd714f3fbf1e42919b09240329165cc1a811b5615d7c993e9534ed97dcfa73',
    },
    '2026-07-16-mirror-id-unsigned-align.sql': {
        from: '9e03175bbec77d4143e32ee5cbe71324937fac970291a65b041a964bf93aafa0',
        to:   '59fa518e404d94638b802c2a1db7ec2cc67df5ce4575148eca265048a794b92a',
    },
    '2026-07-18-status-tables-status-action-composite-idx.sql': {
        from: 'e85523f8acb1baa97d62d10f638de660ab850eb453a11411a9da3b8199aeede0',
        to:   '4cf53571267b133ca276dc5dd83b12e3ca94befd009757d6c2c1c9fe213459ae',
    },
    '2026-07-21-anchor-reward-attestations-table.sql': {
        from: '3ccac829d5c9ad0a0f4f8e3c216ad15c1923ebd4bc61e747dd76928c3d3f8e3d',
        to:   '5574ccc85e4a11dc24956fc2ea2efac4846c4768b03a24bba442cd7c1f2efe00',
    },
    '2026-07-26-bet-cancel-resolve-status-tables.sql': {
        from: '4fa4a1ad6f5c31b8ba1417159110263d94f6b63f83636e42c089238fbf49eead',
        to:   'd24b3fe5395e7d77a8640822efaa6239779d538cc705d67fec48999276cded85',
    },
    '2026-07-28-escrow-leaf-journal-table.sql': {
        from: '8d55e8c4e54cdfe63339ba6acc8a5e719c1a4a3a00953906704a1d6ea63a46f2',
        to:   '7bc8813dee9e63245b65f4ec91a377ff47ecbad031286ce5d04a69ccad21fe2e',
    },
    '2026-07-28-state-tree-roots-contract-state-root.sql': {
        from: '85dcb71f52a46f18a37f25949b04d3fc6b3b98b0bb31e43a3fd5a1d9b7220ac5',
        to:   'c3d1c8e4ef77a026de76b4fc17024cb043315e42f059f15b70727212e83aa7d5',
    },
    '2026-07-28-state-tree-roots-escrow-shadow.sql': {
        from: 'd83b25e94261e24b7a545999e0332aab44364d5a1efc39c9a36786daae53bc10',
        to:   '3240968ff925d609b9a5d699f16f7226f05bda884cc4b367d29923352a5c3c64',
    },
    '2026-07-29-gated-files-threshold-and-publisher.sql': {
        from: '2e93b7eda5ca01be23dfc18c9ea137cbf72d3c4c0279150be9930e46f28b72b9',
        to:   '6d900aac43b92e41c6fac1ee3ea1fb27785803751ec1e94b9440919a64621b36',
    },
    '2026-07-30-attests-add-relay-origin-columns.sql': {
        from: '27a69b77def4039fc199963c2c4523e45db5e896c36f5ca34c43a81f07b5d9d7',
        to:   'e8c3645589499c3d5331bb1a7d4e2d4afd8cf52230f2db149508a35db16e554b',
    },
    // Added the `deploy-precondition=required` header tag (and the comment explaining
    // it) so the deploy tool can see, from the source tree it is about to deploy, that
    // this migration is a startup-assertion precondition. Comment lines only; the
    // executable ALTER is byte-identical. All three mainnet indexers applied this file
    // on 2026-08-09 and recorded the single pre-tag revision (68b65e7, its only
    // committed revision), so one `from` covers the fleet.
    '2026-07-24-pubkeys-widen-uncompressed.sql': {
        from: '2275f44bb043fe473b7781f08e5ce30253c1148e52ba2709efb5fb1214f282d2',
        to:   '45a8fd3f4ce71360a1777bd1b86f14eb534259cffa651f76be5c15afafd50657',
    },
    // Corrected a FALSE provenance note. The file claimed it was a no-op "on any install
    // whose boot-time drift reconciler has already converged the column in", but the
    // reconciler can never converge attest_validator_stats.id: parseExpectedColumns reads
    // AUTO_INCREMENT / PRIMARY KEY as NOT NULL with no DEFAULT and alterTableForDrift skips
    // that shape outright, so this migration is the SOLE convergence path for an aged
    // install. That note is what a later baselining or squash pass reads, and believing it
    // would drop the file and strand every replay-converged replica without the paging
    // primary key. Comment lines only; the single ALTER TABLE is byte-identical (verified by
    // comparing the comment-stripped residue). 55a9621 is the file's only committed
    // revision, so one `from` covers every DB that applied it; where none has, the entry is
    // simply inert.
    '2026-08-19-attest-validator-stats-surrogate-id.sql': {
        from: '0f8f54622b7022134b140d1f68a86ea91d763c6a51e9886ee0b741961df34dc7',
        to:   'ecb9c206ebda43ba932603d60d6d470ab47704db428ff81f42d16c36b983acbb',
    },
    // The header claimed mode=manual coordinated the fleet; it cannot (the drift
    // reconciler converges all three objects at verifyTables(), before runMigrations()
    // reads the gate), so the WHY/mode block was rewritten to state what the tag does
    // and does not do. Comment lines only: the three ALTER TABLE statements are
    // byte-identical, verified by comparing the comment-stripped residue. Both of the
    // file's pre-current committed revisions are listed - afee252f (the original) and
    // 758fc1db (a comment cleanup) - since each fleet DB recorded whichever it applied
    // first; on any database that never applied the file by hand the entry is inert.
    '2026-08-12-validator-rewards-derive-block-index.sql': {
        from: [
            '8f6f8b6bae2026128b0b298892fc0b5601a67f2ff12cc05fb4da9ae9cfdd1100', // afee252f, as authored
            '8496c4f75647ad9768d8128e8f9341e3d4de9a1db5ca2f66d4328762ab0a9ec3', // 758fc1db, comment cleanup
        ],
        to: 'a911c38ca928743bb65c763c8143a5a3ad63de18da72b32da83a4971c1735ed8',
    },
    // The same 758fc1db comment cleanup (internal-reference scrub) caught three more
    // already-applied files, and unlike the entry above these were never rebaselined, so
    // every aged testnet/regtest DB logged `content CHANGED` on each start AND - the part
    // that actually bites - `node src/migrate.js` FAILED CLOSED on the first of them, which
    // made the whole pending manual backlog unappliable on those hosts. Found 2026-08-26
    // while working that backlog; the startup warning had been dismissed as noise for two
    // weeks, which is exactly the failure mode a guard that always fires produces.
    //
    // Comment lines only in all three, verified by comparing the comment-stripped residue
    // rather than assumed: the scrub removed internal ticket ids and an internal tracker
    // reference from the header prose. The executable SQL is byte-identical.
    //
    // The third file's predecessor was an ORPHANED BLOB, unreachable from any commit (the
    // published-history rewrite, same cause as the five noted above), so `git log` finds
    // nothing for it; it was recovered by scanning the whole object store (2586 blob
    // candidates) and only then compared. Mainnet is NOT affected: the BTC mainnet ledger
    // already records the current hash for all three, so this heals aged non-mainnet DBs.
    '2026-07-16-mirror-twin-bigint-unsigned-align.sql': {
        from: '1d981cd5d128c2ec8de391289b11fdc43932f65ee5d3fd8a61c32e7b01be0569', // fd9267e2, pre-scrub
        to:   'fac090271fd2cebaea9b914d344f94483d97d0ec5b7854bf42263df0153c1d48',
    },
    '2026-07-26-tokens-backfill-lock-mint-supply.sql': {
        from: '03ec334fdfafd207d5ca7d39887422175ab0ed9f83947c21a6d30c2391419215', // ef66d9e3, pre-scrub
        to:   'f2e53e5a3de9f08b162528323b6cb78bbbddf9591859bf555313801929689c84',
    },
    '2026-07-29-state-checkpoints-uq-chain-seq.sql': {
        from: '05dfd2ef7d246929a451521aa7c4c6e0f21faf019dd06f1f16384a450675267c', // orphaned blob 8a293ccf, pre-scrub
        to:   '0796c26842434c39b056e9875ba5ee7dbbcfd92d340e2899f7921e03147c5458',
    },
    // Added the `deploy-precondition=required` header tag (and the DEPLOY PRECONDITION
    // comment block explaining it) when the reward-identity startup assertion landed, the
    // same retag the pubkeys widen carries above. Comment lines only: the four ALTER TABLE
    // statements are byte-identical, verified by comparing the comment-stripped residue
    // against the pre-tag revision rather than assumed. a0dd6d08 is the file's only
    // committed revision, so one `from` covers every database that applied it by hand;
    // where none has, the entry is inert.
    '2026-08-24-validator-rewards-round-qualifier.sql': {
        from: '069f0e73f1cb6179d0dcab361832204c96aa1cb4072454ddcd7e6a8acd2d31ab', // a0dd6d08, pre-tag
        to:   '37ff284b7f11f248e9f52979f70e5fe8f13c9cad7a7e719b4633866e8c81dc1a',
    },
};

// Applicability preconditions the runner evaluates against the LIVE schema before it
// applies a migration (see _migrationPreconditionSkip). Each entry is a parameterised
// information_schema query taking the database name, plus a predicate returning a reason
// string when the migration does not apply to this database and null when it does.
//
// The guard lives HERE rather than inside the .sql file on purpose: a migration file's
// sha256 is its identity in schema_migrations, so adding a guard clause to an already
// applied file would trip the immutability check on every node that ran it, and healing
// that needs a MIGRATION_CHECKSUM_REBASELINES entry whose documented contract is that the
// executable SQL is byte-identical across pinned revisions. A runner-side predicate keeps
// both properties intact and covers every invocation route (startup, blanket
// `node src/migrate.js`, and a targeted `--file` rollout), since all three funnel through
// this loop. Mirrors xchain-decoder/src/db.js.
Database.MIGRATION_PRECONDITIONS = {
    // Widens pubkeys.pubkey to hold an uncompressed key (130 hex chars). It is
    // mode=manual, so it stays PENDING on a database created from the current
    // src/sql/pubkeys.sql (already VARCHAR(130) or wider) - and a fresh install never
    // needs the widen a prior narrower column required. Baseline only while the live
    // column is already 130 characters or more, the same threshold
    // _assertPubkeyColumnIsUncompressedWide enforces at startup.
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
    // ONE bind parameter: _migrationPreconditionSkip passes [this.dbName] and nothing
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
    // ONE bind parameter: _migrationPreconditionSkip passes [this.dbName] and nothing else, so
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
};

// One-time ledger rename map (old undated filename -> new dated filename). Three
// legacy migrations predated the dated-prefix convention; renaming them to their
// authored dates restores lexical=chronological apply order. The ledger is keyed
// by filename, so an already-migrated DB has rows under the OLD names; runMigrations
// re-keys those rows to the new names before the applied-vs-pending comparison so
// the renamed files are recognized as applied instead of re-running. File content
// (and therefore checksum) is unchanged by the rename. Fresh DBs have no old rows,
// so they simply apply the files under their new dated names.
Database.MIGRATION_LEDGER_RENAMES = {
    'add_balances_composite_index.sql':                 '2026-05-30-balances-composite-index.sql',
    'unique_full_column_index_addresses.sql':           '2026-06-03-unique-full-column-index-addresses.sql',
    'add_cross_chain_matches_partial_fill_columns.sql': '2026-06-09-cross-chain-matches-partial-fill-columns.sql',
    // v0.17.0 regtest-first rehearsal (2026-09-11): both files sorted before an
    // already-applied migration (2026-09-08-deploy-deferred-assembly.sql), so they
    // were renamed forward to 2026-09-11- to restore lexical=chronological order.
    // The fleet already recorded them applied under their 2026-09-08- names, so
    // without these entries the rename alone makes both look pending again and the
    // auto path re-applies an ADD COLUMN that is already there.
    '2026-09-08-contract-meta-columns.sql':      '2026-09-11-contract-meta-columns.sql',
    '2026-09-08-cross-chain-btc-chain-id.sql':   '2026-09-11-cross-chain-btc-chain-id.sql',
    // The leg-ordinal migration was authored and committed alongside the two renames
    // just above but was itself left undated-forward: it sorted before
    // 2026-09-11-cross-chain-btc-chain-id.sql, which the fleet had already applied by
    // the time this file merged, so every boot logged a backdating warning and applied
    // it out of its dated position. Renamed past every migration in the tree today so
    // it cannot land behind a frontier again; the fleet already recorded it applied
    // under the old name, so the re-key is required, not optional.
    '2026-09-09-destroys-sends-leg-ordinal.sql': '2026-09-13-destroys-sends-leg-ordinal.sql',
};

// Pure planner for the one-time ledger rename heal. Given the names already recorded
// in schema_migrations, return the {from,to} re-keys to apply: only for legacy names
// that are present and whose dated target is not already recorded. Idempotent - a DB
// already re-keyed (or a fresh DB) yields no operations. Unit-tested directly.
Database.planLedgerRenames = function(appliedNames){
    const have = new Set(appliedNames);
    const ops  = [];
    for(const [oldName, newName] of Object.entries(Database.MIGRATION_LEDGER_RENAMES)){
        if(have.has(oldName) && !have.has(newName)) ops.push({ from: oldName, to: newName });
    }
    return ops;
};

// Backdating guard for the auto-apply path. Apply order is lexical, so a migration
// added with a date EARLIER than one already applied runs in a different position on
// a fresh database (in its date slot) than on an aged one (after the frontier), and
// the two schemas diverge across the fleet. Given a pending filename and the names
// already in the ledger, return the offending applied name when the pending file
// sorts before the lexical maximum of them, else null. Empty ledger (fresh install)
// never trips. Pure string logic (no DB), unit-tested directly.
//
// Callers must pass this ONLY auto-mode files, and that restriction is the whole
// correctness argument, not an optimization. A mode=manual file legitimately sits
// unapplied behind the frontier for as long as the operator defers it (eleven such
// files ship today), so it is indistinguishable at runtime from a backdated one and
// guarding it would hard-fail `node src/migrate.js` on every aged fleet DB. An auto
// file has no such state: it applies unattended at the first startup that sees it,
// so an unapplied auto file behind the frontier is always newly backdated.
//
// Only DATED ledger names are eligible to be the frontier, and that filter is
// load-bearing rather than tidiness. Four undated migrations shipped before the
// dated-prefix convention; three are re-keyed by MIGRATION_LEDGER_RENAMES, but
// add_controller_bound_token_columns.sql was deleted (7f1142e added it, 1c728c5
// removed it) rather than renamed, so a DB migrated inside that window carries
// that row forever with no heal path. An undated name sorts ABOVE every 2026-*
// name in ASCII ('a' 0x61 > '2' 0x32), so taking the max over raw names would
// make the frontier a garbage maximum that every ordinary new migration sorts
// below, hard-failing `node src/migrate.js` on exactly the aged fleet DBs this
// guard must not break.
Database.backdatedFrontierViolation = function(pendingName, appliedNames){
    let frontier = null;
    for(const name of (appliedNames || [])){
        const n = String(name);
        if(!/^\d{4}-\d{2}-\d{2}-/.test(n)) continue;
        if(frontier === null || n > frontier) frontier = n;
    }
    if(frontier === null) return null;
    return (String(pendingName) < frontier) ? frontier : null;
};

// The header token that marks a migration as a DEPLOY PRECONDITION: code in this
// tree asserts it at startup, so a build carrying that assertion must not be
// deployed against a database that has not applied it. It rides on the existing
// `-- xchain:migration` directive line, next to `mode=`:
//
//   -- xchain:migration mode=manual deploy-precondition=required
//
// Only a mode=manual file needs it. An `auto` file applies itself at the first
// startup that sees it, so it can never be the missing precondition.
Database.DEPLOY_PRECONDITION_TAG = 'deploy-precondition=required';

// Migrations this tree ASSERTS at startup: the service refuses to run when the
// target database has not applied them.
//
// WHY THIS LIST EXISTS
// --------------------
// 2026-08-09: deploying 3bc9771 put all three mainnet indexers (BTC, DOGE, LTC)
// into Restarting(1) crash-loops on _assertPubkeyColumnIsUncompressedWide, because
// 2026-07-24-pubkeys-widen-uncompressed.sql is mode=manual and had never been
// applied on mainnet. Both halves were individually right - the migration is a COPY
// rebuild under a metadata lock, so it wants the writer quiesced, and the assertion
// is what stops a narrow column silently truncating source_pubkey - but they shipped
// with nothing checking the precondition at DEPLOY time, so the only thing that
// discovered the requirement was a production outage.
//
// The registry is the in-code half of the fix. The machine-readable half is the
// DEPLOY_PRECONDITION_TAG in each listed migration's own header, which the deploy
// tool (xchain-node's MigrationPreconditionService) reads out of the source tree it
// is about to deploy and checks against the target DB's schema_migrations BEFORE the
// container is recreated. test/unit/migration-preconditions.test.js keeps the halves
// in step: every entry here must exist, be mode=manual, and carry the tag.
//
// ADDING A STARTUP ASSERTION: register it here and tag its migration file, or the
// next fleet deploy discovers the requirement the way 2026-08-09 did.
Database.STARTUP_ASSERTED_MIGRATIONS = [
    {
        file:      '2026-07-24-pubkeys-widen-uncompressed.sql',
        assertion: '_assertPubkeyColumnIsUncompressedWide',
        symptom:   'Fatal indexer error: pubkeys.pubkey holds 66 chars but VARCHAR(130) is required'
    },
    {
        file:      '2026-08-24-validator-rewards-round-qualifier.sql',
        assertion: '_assertRewardUniqueKeyCarriesQualifier',
        symptom:   'Fatal indexer error: validator_rewards.reward_unique does not include round_qualifier'
    },
    {
        file:      '2026-09-12-bridge-tables.sql',
        assertion: '_assertBridgeTablesPresent',
        symptom:   'Fatal indexer error: the bridge tables bridge_transfers, bridge_settlements, policy_snapshots are absent'
    }
];

// Registry lookup by assertion method name. Throws rather than returning undefined:
// an assertion that names a migration nobody registered would otherwise render as
// "--file undefined" in the very error an operator reads mid-outage.
Database.startupAssertedMigrationFile = function(assertion){
    const entry = Database.STARTUP_ASSERTED_MIGRATIONS.find(m => m.assertion === assertion);
    if(!entry) throw new Error('startupAssertedMigrationFile: ' + assertion +
        ' is not registered in Database.STARTUP_ASSERTED_MIGRATIONS');
    return entry.file;
};

// Does this migration file's header declare itself a deploy precondition?
// Prologue-anchored exactly like _migrationMode (the scan stops at the first
// non-blank, non-comment line), so a token buried in body prose or a data literal
// cannot arm it. Pure string logic, unit-tested directly.
//
// Twin: xchain-node/src/services/MigrationPreconditionService.js carries the same
// parser, because the deploy tool reads these files from a source tree it has only
// cloned and cannot require this module. Keep the two in step.
Database.migrationDeclaresDeployPrecondition = function(raw){
    const prologue = [];
    for(const line of String(raw).split('\n')){
        const trimmed = line.trim();
        if(trimmed === '' || trimmed.startsWith('--')){ prologue.push(line); continue; }
        break;
    }
    return /^\s*--\s*xchain:migration\b[^\n]*\bdeploy-precondition\s*=\s*required\b/im.test(prologue.join('\n'));
};

// Exposed for the unit suite (and the sync-twin drift check): the weightless-row
// guard is consensus-relevant, so it is tested directly, not only through a query.
Database.requireStakeWeight = requireStakeWeight;

// What `markets.tick1_id` / `tick2_id` hold for a side that is the native coin
// rather than a token. NOT NULL, because MariaDB treats NULL as distinct inside a
// UNIQUE index: a NULL-keyed side slips past uq_markets_pair, so the pair loses the
// one-row-per-market guarantee every other pair has. index_tickers ids start at 1,
// so 0 can never collide with a real ticker. Which coin the side actually is comes
// from the row's coin1_id / coin2_id.
Database.MARKET_NATIVE_TICK_ID = 0;

// Decimal precision of a native-coin market side. Tokens carry their own precision
// in `tokens.decimals`; the coin has no such row, and every chain the indexer follows
// denominates in 1e-8 units. Only the 24h volume accumulator reads it, so a coin that
// ever differed would misprint a display total, not a ledger amount.
Database.MARKET_NATIVE_DECIMALS = 8;

// A market side's tick id as `markets` stores it. `orders` and `order_matches`
// carry NULL on a tickerless side; this is the one place that translation happens.
Database.marketTickId = function(tick_id){
    if(tick_id === null || tick_id === undefined || tick_id === '')
        return Database.MARKET_NATIVE_TICK_ID;
    return Number(tick_id);
};

// One mixin per DDL family in src/sql/; index.js keeps the constructor, the pool, the
// migrations, the transaction plumbing and the statics. Installed NON-ENUMERABLE,
// which is what the class body they came from produced: the suites stub them through
// sinon.stub(Database.prototype, name), and an enumerable prototype would also put
// every query into for-in and Object.keys over an instance.
for(const mixin of [
    require('./actions.js'),
    require('./addresses.js'),
    require('./airdrops.js'),
    require('./anchors.js'),
    require('./attests.js'),
    require('./balances.js'),
    require('./batches.js'),
    require('./bets.js'),
    require('./blocks.js'),
    require('./bridges.js'),
    require('./broadcasts.js'),
    require('./callbacks.js'),
    require('./capabilities.js'),
    require('./coinpays.js'),
    require('./contracts.js'),
    require('./credits.js'),
    require('./cross_chain.js'),
    require('./delegations.js'),
    require('./deploys.js'),
    require('./deposits.js'),
    require('./destroys.js'),
    require('./dispensers.js'),
    require('./dispenses.js'),
    require('./dividends.js'),
    require('./escrows.js'),
    require('./events.js'),
    require('./fees.js'),
    require('./files.js'),
    require('./full_node_verifications.js'),
    require('./hub_pushes.js'),
    require('./index_tables.js'),
    require('./issues.js'),
    require('./links.js'),
    require('./lists.js'),
    require('./mappings.js'),
    require('./markets.js'),
    require('./messages.js'),
    require('./mints.js'),
    require('./misc.js'),
    require('./orders.js'),
    require('./polls.js'),
    require('./prices.js'),
    require('./pubkeys.js'),
    require('./rewards.js'),
    require('./rollcalls.js'),
    require('./sends.js'),
    require('./slashes.js'),
    require('./sleeps.js'),
    require('./stakes.js'),
    require('./swaps.js'),
    require('./sweeps.js'),
]){
    const descriptors = Object.getOwnPropertyDescriptors(mixin);
    for(const key of Reflect.ownKeys(descriptors)) descriptors[key].enumerable = false;
    Object.defineProperties(Database.prototype, descriptors);
}
