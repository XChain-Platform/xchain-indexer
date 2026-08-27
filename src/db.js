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

// Load required libraries
const mariadb = require('mariadb');
const fs      = require('fs');
const path    = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { buildStateHashData, ARCHIVE_HEAD_VERSIONS, ARCHIVE_HEAD_VERSIONS_SQL } = require('./stateHash');
const { canonicalizeHashAddress } = require('./protocolAddressRoles');
// Single decoder for the decoder's REORG event payload, shared with the getreorghistory RPC
// so the array-of-{block_index, block_hash} contract is defined once. Pure leaf module (no
// requires of its own), so no cycle.
const reorgHistoryQuery = require('./reorg-history-query');
const protocolTime = require('./protocol_time');
const swqCap = require('./swq_source_cap_activation');
const dispenseCancellingMatch = require('./dispense_cancelling_match_activation');
const stateKeyCollation = require('./state_key_collation_activation');
const snapshotAgeCausality = require('./oracle_snapshot_age_causality_activation');
const staleRoundVisibility = require('./oracle_stale_round_visibility_activation');
const listEditResolution = require('./list_edit_resolution_activation');
const caretRefStrict = require('./caret_ref_strict_activation');
const ledgerPrecision = require('./ledger_amount_precision_activation');
const dispenserSendCompare = require('./dispenser_send_amount_compare_activation');
const stakeWeightCollation = require('./stake_weight_collation_activation');
// Per-block cap on the ATTEST deadline-expiry sweep. Vendored
// byte-identical from xchain-documentation/protocol/constants.js, same convention
// as the XCALL_MAX_CALLS_PER_BLOCK sibling it mirrors.
const { ATTEST_MAX_EXPIRIES_PER_BLOCK,
        CROSS_SETTLE_MAX_PER_BLOCK } = require('./protocol/constants.js');
const { CHECKPOINT_VERSIONS: ANCHOR_CHECKPOINT_VERSIONS,
        ARCHIVE_CHUNK_SET_SQL, ARCHIVE_CHUNK_SET_BY_AUTHOR_SQL,
        ARCHIVE_ANCHOR_BY_CONTENT_SQL, selectArchiveHeadRow,
        dedupeArchiveChunks } = require('./anchor-action-query');
const { rethrowIfInfraFault } = require('./actions/faultGuard');
// The validator_rewards ledger-key qualifier rule, shared with the two JS writers so the
// SQL predicate here and they cannot disagree about which reward type is qualified.
const arKey = require('./anchor_reward_key.js');

// A stake weight, as stake_weighted_quorum.bcnum accepts one (plain decimal string).
// Kept identical to that predicate's pattern so this producer can never emit a row the
// predicate then has to fail closed on.
const STAKE_WEIGHT_NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)$/;

// Fail CLOSED on a weightless stake-weight row. Every source-keyed weight
// producer routes through here instead of resolving a missing weight to '0'. The '0'
// looks harmless and is not: the source stays in the quorum's dedupe map carrying no
// stake, so the denominator S shrinks while a signer keeps the full numerator, and a
// smaller real stake clears 3*tally > 2*S. stake_weighted_quorum already rejects such a
// row, but it never sees one - every consumer re-maps the set through
// `String(v.weight != null ? v.weight : '0')`, which launders the missing weight into a
// well-formed zero before the predicate runs. The weight columns behind these queries
// (stakes.amount, capability_snapshots.amount) are NOT NULL and the source-aggregate is
// HAVING-filtered, so a null here is a corrupt read, not a stakeless source; a live
// regtest sweep over BTC/LTC/DOGE (all capabilities, several block boundaries) found
// zero weightless rows. Throwing surfaces to the hub as an RPC error, which every
// consensus caller already treats as "decline the round" - the same posture the hub
// takes when CHECKPOINT_COMMITMENT is unarmed: refuse to sign rather than emit a
// degraded row. A legitimate '0' still passes.
function requireStakeWeight(weight, label){
    if(weight === null || weight === undefined)
        throw new Error((label || 'stake weights') + ': missing validator weight would silently lower the stake-quorum denominator S');
    let w = String(weight).trim();
    if(w === '' || !STAKE_WEIGHT_NUMERIC.test(w))
        throw new Error((label || 'stake weights') + ': nonnumeric validator weight "' + w.slice(0, 32) + '" would silently lower the stake-quorum denominator S');
    // Return the value UNTRIMMED: the accepted set is unchanged from the old
    // String(r.weight) coercion for every weight a live producer emits, so the
    // stakes_root leaves this feeds keep hashing byte-for-byte what they did before.
    return String(weight);
}

// Tables whose highest-`id`-survivor dedupe rule is validated and safe to auto-apply at
// startup (see dedupeForUniqueIndex: an upsert that degraded to plain INSERT appended a
// fresh row per change, so the highest id is the live value). reconcileTableIndexes will
// only DELETE rows to force a UNIQUE index for a table on this allow-list; any other table
// with blocking duplicates is left intact with a loud warning for a manual migration, so a
// mis-declared UNIQUE index can never silently destroy rows on an unvalidated table.
const AUTO_DEDUP_TABLES = new Set(['balances']);

// Watchdog-fence context (M-16). The block loop runs each block's processing inside
// txEpochStore.run(epoch, ...) so every DB call it makes carries the transaction epoch
// it was issued under. If the block watchdog fires, the outer catch rolls back and the
// abandoned (zombie) block-processing promise can still resume and try to write on the
// SHARED transactionConnection, which by then belongs to a LATER block's transaction.
// The epoch a write carries is compared against the db's current epoch (_txEpoch); the
// epoch is bumped on every transaction teardown, so a zombie write carries a stale epoch
// and is rejected before it reaches the driver. AsyncLocalStorage propagates the epoch
// across every await inside the block promise (including the zombie continuation) without
// threading it through every call site, and is absent for non-block-loop callers (RPC
// reads, health checks), which are therefore never fenced.
const txEpochStore = new AsyncLocalStorage();

// Consensus block-hash scheme version. Folded into the preimage of every per-block
// ledger/actions/contract hash (see getBlockHashes), so changing it changes every hash.
// The scheme hashes the RESOLVED canonical strings (address/tick/action/status) rather
// than the raw AUTO_INCREMENT lookup ids (address_id/tick_id/action_id/source_id/
// caller_id/status_id). Hashing raw ids was considered and rejected: ids are assigned on
// first reference and survive reorgs, so a shallow reorg containing a first-seen address/
// ticker/etc. would permanently fork id assignment between nodes and diverge the hashes.
// Resolving to canonical strings makes the hashes depend only on the canonical chain
// (id-independent). The resolved-string scheme is the only one that has ever shipped, so
// it is version 1; the id-based design never carried a version number.
// Bumping this is a consensus break requiring a coordinated all-validator re-baseline of
// checkpoints from an agreed height (already-anchored hashes stay on their original scheme).
// MUST stay identical to xchain-sync/src/BlockHasher.js BLOCK_HASH_VERSION; the two hashers
// are a byte-for-byte conformance pair (guarded by the xchain-e2e-test conformance scenario
// and the xchain-sync block-hash-vectors golden). This is a fixed protocol constant, never
// env-overridable.
const BLOCK_HASH_VERSION = 1;

// Canonical form of a wire `^<id>` index reference: a caret followed by decimal digits
// with no leading zero (ids start at 1, so `^0` is invalid too). This is the ONE accepted
// byte-form, so a given entity has exactly one wire id form. Tested against the substring
// AFTER the '^'. Non-canonical caret strings (`^007`, `^1.5`, `^-1`, `^0x10`, `^1e3`,
// `^ 1`, `^`) are rejected so they cannot alias to a canonical id or coerce onto an
// integer FK column; the digit string is handed to SQL verbatim (never via Number()) so a
// large id keeps full precision. See xchain-documentation/protocol/Index_Id_References.md.
const CANONICAL_CARET_ID = /^[1-9][0-9]*$/;

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
        let dir   = path.join(__dirname, 'sql');
        let files = fs.readdirSync(dir);
        let file  = null;
        let db    = await this.getConnection();
        // One summary line instead of a per-table pair; error paths below still
        // name the table, so a failure stays attributable.
        console.log('Verifying database and tables...');
        let checked = 0;
        let created = 0;
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
        return true;
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
        const dir           = path.join(__dirname, 'sql', 'migrations');
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
        const dir      = path.join(__dirname, 'sql');
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
    }

    // Parse standalone `CREATE [UNIQUE] INDEX <name> ON <table> (<cols>)` statements
    // from a table's SQL source. Returns [{name, unique, columns:[...]}]. Inline
    // PRIMARY KEY / UNIQUE clauses inside CREATE TABLE are created with the table and
    // are not reconciled here. Index/column names come from the trusted SQL files.
    parseExpectedIndexes(sqlData, table){
        sqlData = this.stripSqlLineComments(sqlData);
        const re = /CREATE\s+(UNIQUE\s+)?INDEX\s+`?(\w+)`?\s+ON\s+`?(\w+)`?\s*\(\s*([\s\S]+?)\s*\)\s*;/gi;
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
            if(columns.length) out.push({ name: m[2], unique: !!m[1], columns, prefixes, directions });
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
            const dir      = path.join(__dirname, 'sql');
            const data     = fs.readFileSync(dir + '/' + file, "utf8");
            const table    = file.substring(0, file.indexOf('.sql'));
            const expected = this.parseExpectedIndexes(data, table);
            if(!expected.length) return;

            // Live indexes -> map keyed by ordered column-set: "c1,c2" => {unique}
            const rows = await db.query(
                "SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX, SUB_PART FROM information_schema.statistics " +
                "WHERE table_schema = ? AND table_name = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX",
                [this.dbName, table]);
            const byName = new Map();
            const liveNames = new Set();
            for(const r of rows){
                liveNames.add(r.INDEX_NAME.toLowerCase());
                if(!byName.has(r.INDEX_NAME)) byName.set(r.INDEX_NAME, { unique: Number(r.NON_UNIQUE) === 0, cols: [], subParts: [] });
                byName.get(r.INDEX_NAME).cols.push(r.COLUMN_NAME.toLowerCase());
                byName.get(r.INDEX_NAME).subParts.push(r.SUB_PART == null ? null : Number(r.SUB_PART));
            }
            const liveByCols = new Map();
            for(const info of byName.values()) liveByCols.set(info.cols.join(','), info);

            for(const idx of expected){
                const key  = idx.columns.map(c => c.toLowerCase()).join(',');
                const live = liveByCols.get(key);
                if(live && (!idx.unique || live.unique)){
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
                        ? (liveInfo.unique ? 'UNIQUE' : 'non-unique') + ' on (' + liveInfo.cols.join(',') + ')'
                        : 'a differently-defined index';
                    console.warn('Schema drift on ' + table + ': declared ' + (idx.unique ? 'UNIQUE ' : '') +
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
    // (doubled quotes treated as escapes); a `--` or `#` outside any quote or
    // block comment skips to the end of its line. Newlines are kept so error
    // positions stay meaningful.
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
    // (single/double-quote and backtick spans, doubled quotes treated as escapes).
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
        const dir     = path.join(__dirname, 'sql');
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
    // Used only by the block loop; behavior on the non-timeout path is unchanged because the
    // installed epoch always equals the current _txEpoch until the transaction is torn down.
    // The context records WHICH Database instance owns the guarded transaction: the indexer
    // process holds several instances of this class (indexer DB, decoder DB, hub-DB mirror),
    // and the fence must only guard the owner's shared transactionConnection. A read through
    // a sibling instance inside the same async context (e.g. a hub-mirror price read during
    // fee validation) draws from that instance's own pool and can never land in the guarded
    // transaction, so it must not be fenced (its epoch counter never advances, so comparing
    // across instances fences every such read; caught live on regtest 2026-07-08).
    runInTxEpoch(epoch, fn){
        return txEpochStore.run({ owner: this, epoch: epoch }, fn);
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
    // Scoped to block processing by the txEpochStore context, which only the block loop
    // installs and which propagates across awaits into sibling Database instances (the hub
    // mirror reads run on this exact path). No stored context = an API / healthcheck read,
    // which is free to read whatever the mirror currently holds and is never fenced. That
    // scoping is what stops a concurrent api.js fee quote from tripping a consensus guard.
    // The deferral is thrown as a typed Error carrying PRICE_BARRIER_DEFERRED, because the
    // readers this backstop fires on sit INSIDE action catches that swallow deterministic
    // contract failures (xexec's execution catch, the XCALL/ATTEST callback catches). A bare
    // string carries no code and no errno, so faultGuard read it as a contract outcome and the
    // block committed a validator-local 'error' verdict instead of retrying with the barrier
    // (every injected XEXEC on a transaction-less block recorded result_status='error'
    // while healthy peers recorded 'ok'). The code is what makes rethrowIfInfraFault propagate.
    _assertPriceBarrierNotSkipped(site){
        if(txEpochStore.getStore() === undefined) return;
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

    // Handle getting block index for a given component and request type
    async getBlockIndex(component, type){
        let block_index = null;
        // Bail out on any invalid request type
        var componentTypes = ['decoder', 'indexer'];
        if(!componentTypes.includes(component)){
            this.util.logError('Invalid component');
            return null;
        }
        // Bail out on any invalid request type. Only block-extent reads remain; the
        // legacy 'reorg' single-newest-row reader was removed (its newest-only, bare-height
        // shape silently dropped shallower-after-deeper reorgs). The live reorg path uses
        // getLastProcessedReorgId() + getReorgsSince() exclusively.
        var validTypes = ['first', 'last'];
        if(!validTypes.includes(type)){
            this.util.logError('Invalid type');
            return null;
        }
        let func  = (type=='first') ? 'MIN' : 'MAX';
        let query = 'SELECT ' + func + '(block_index) AS block_index FROM blocks';
        let results = await this.doQuery(query);
        if(results.length > 0 && !this.util.isNull(results[0]["block_index"]))
            block_index = Number(results[0]["block_index"]);
        return block_index;
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

    // `cursorWitness` (optional #2735): { time, hash } captured for the cursor's decoder REORG
    // event when the marker was recorded. Non-null enables the additive under-cursor check;
    // null (legacy marker) falls back to the pre-existing one-directional over-cursor guard.
    async getReorgsSince(afterId, cursorWitness){
        let query, args;
        if(afterId === null || afterId === undefined){
            query = `SELECT id, data FROM events WHERE code='REORG' ORDER BY id ASC`;
            args  = [];
        } else {
            query = `SELECT id, data FROM events WHERE code='REORG' AND id > ? ORDER BY id ASC`;
            args  = [Number(afterId)];
        }
        // #2735 (witness the cursor row): closes the UNDER-cursor silent skip that the
        // length===0 && maxId<afterId guard below cannot see. BEFORE the id>afterId select,
        // confirm the exact decoder REORG event the cursor points at still exists; and, for a
        // marker recorded WITH a witness, that its live time + payload hash still match what we
        // recorded. A rebuilt decoder whose fresh id space overtook a stranded cursor returns
        // non-empty id>afterId results, so without this it would silently drop new-incarnation
        // REORG events at/below the cursor. Additive: a legacy (null-witness) marker keeps only
        // the old over-cursor guard so upgrades are unaffected.
        if(afterId !== null && afterId !== undefined){
            let witnessRows = await this.doQueryStrict(
                `SELECT time, data FROM events WHERE id = ? AND code='REORG'`, [Number(afterId)]);
            if(witnessRows.length === 0)
                throw this._reorgCursorIncoherentError('indexer cursor decoder_event_id=' + afterId +
                    ' points at no live decoder REORG event (the cursor row is gone).');
            if(cursorWitness && cursorWitness.time != null && cursorWitness.hash != null){
                let live     = witnessRows[0];
                let liveHash = this._hashReorgData(live.data);
                if(String(live.time) !== String(cursorWitness.time) || liveHash !== String(cursorWitness.hash))
                    throw this._reorgCursorIncoherentError('indexer cursor decoder_event_id=' + afterId +
                        ' witness mismatch (the live decoder REORG event at that id has a different ' +
                        'time/payload than when it was recorded).');
            }
        }
        // doQueryStrict (not doQuery): this runs on decoderDb, which never opens a
        // transaction, so doQuery would collapse any read fault to [] - indistinguishable
        // from "no unprocessed reorgs". That silently suppresses the rollback trigger and
        // lets the catch-up loop commit and publish blocks on un-rolled-back old-chain
        // state. Throwing instead aborts the pass with no block committed; the loop retries
        // on the next tick. Mirrors the throwing sibling read on the indexer side.
        let results = await this.doQueryStrict(query, args);
        // Incarnation guard (/ RE-1): the cursor is a decoder events.id, and the
        // decoder never deletes events rows, so a cursor ABOVE the decoder's newest REORG
        // id can only mean the decoder DB was rebuilt or restored out-of-band (AUTO_INCREMENT
        // reset). With the old behavior that stranded cursor made this query return [] forever,
        // silently disabling every future rollback while the indexer kept committing blocks.
        // Fail loud instead: the throw aborts the pass with no block committed (same contract
        // as a read fault above), so the incoherence pages the operator rather than rotting.
        if(afterId !== null && afterId !== undefined && results.length === 0){
            let maxRow = await this.doQueryStrict(`SELECT MAX(id) AS max_id FROM events WHERE code='REORG'`);
            let maxId  = (maxRow.length > 0) ? maxRow[0]["max_id"] : null;
            if(maxId === null || Number(maxId) < Number(afterId)){
                throw this._reorgCursorIncoherentError('indexer cursor decoder_event_id=' + afterId +
                    ' exceeds the decoder\'s newest REORG event id (' + maxId + ').');
            }
        }
        let reorgs = [];
        for(let row of results){
            // ONE decoder for the decoder's REORG payload, shared with the getreorghistory
            // RPC (reorg-history-query.parseReorgEvent). Both consumers used to hand-roll the
            // array-of-{block_index, block_hash} contract with different acceptance rules, so a
            // payload reshape could be absorbed by one and silently dropped by the other: the
            // hub-facing RPC answering "not orphaned" while this path still rolled back, or the
            // reverse. Defining the contract once means a reshape breaks in exactly one place.
            // min_block_index is the deepest (lowest) orphaned block, the rollback target.
            // parseReorgEvent swallows a JSON parse fault and yields no blocks, which lands on
            // the same LOUD drop below that the old inline try/catch did.
            let block_index = reorgHistoryQuery.parseReorgEvent(row).min_block_index;
            // A malformed or empty payload must never be treated as a valid rollback target
            // (a null/non-finite block_index here would let `lastIndexerBlock >= null` coerce
            // true and call rollback(null), whose predicates match no rows - a silently missed
            // rollback). We SKIP rather than throw - a benign payload reshape must not halt
            // indexing, and three regression tests pin skip-not-throw - but the skip must not be
            // SILENT: getLastProcessedReorgId can later advance the cursor PAST this id via a
            // newer well-formed marker, permanently losing this rollback with zero operator
            // signal. Log LOUD (the decoder REORG contract is [{block_index, block_hash}]) so a
            // payload-shape drift pages the operator instead of rotting.
            if(!Number.isFinite(block_index)){
                console.error('getReorgsSince: DROPPING malformed REORG event id=' + row.id +
                    ' (afterId=' + afterId + '): payload yields no finite block_index, so it has no ' +
                    'rollback target and the cursor may later pass this id and miss the rollback. ' +
                    'Expected decoder contract [{block_index, block_hash}]; got data=' +
                    String(row.data).slice(0, 200));
                continue;
            }
            reorgs.push({ id: Number(row.id), block_index: block_index });
        }
        return reorgs;
    }

    // #2736: probe for a durable REORG_HALT marker the decoder writes when it halts (e.g. a
    // reorg deeper than it can safely rewind). getReorgsSince only ever selects code='REORG',
    // so without this a halted decoder is invisible to the indexer and merely presents as idle
    // or lagging. Runs on decoderDb with the SAME throwing read contract as getReorgsSince
    // (doQueryStrict): a swallowed read fault must not masquerade as "not halted". Returns
    // { halted:boolean, payload:(string|null) } - the payload is the marker's `data` column
    // (operator context: why the decoder halted), null when not halted or absent.
    async isReorgHalted(){
        let rows = await this.doQueryStrict(
            `SELECT data FROM events WHERE code='REORG_HALT' ORDER BY id DESC LIMIT 1`);
        if(rows.length === 0) return { halted: false, payload: null };
        return { halted: true, payload: (rows[0].data != null) ? String(rows[0].data) : null };
    }

    // Get the decoder event id of the most-recent reorg the indexer has already recorded,
    // or null if none. getReorgsSince() selects every decoder reorg with an id greater than
    // this value - an IDENTITY check, not a block-height compare.
    async getLastProcessedReorgId(){
        // Scan REORG markers newest-first and return the newest one that carries a decoder_event_id
        // (REORG-4). The previous code inspected ONLY the single newest row and returned null if it
        // was a legacy plain-block-number payload - so on a partially-migrated DB whose newest marker
        // is legacy but older markers are new-format, it wrongly reported "no reorg ever processed",
        // and getReorgsSince(null) then re-replayed the decoder's entire reorg history (a massive
        // spurious rollback). Scanning back finds the real cursor whenever any new-format marker
        // exists. LIMIT bounds the scan; new-format markers are the steady state, so in practice this
        // returns on the first row.
        let query = `SELECT data FROM events WHERE code='REORG' ORDER BY id DESC LIMIT 200`;
        // doQueryStrict (not doQuery): symmetry with getReorgsSince/createReorg. A swallowed
        // read fault here would return [] -> null, indistinguishable from "no reorg ever
        // processed", causing getReorgsSince(null) to replay the entire decoder reorg history.
        // Fail loud so the cursor read cannot silently collapse into a full-history rollback.
        let results = await this.doQueryStrict(query);
        if(results.length === 0)
            return null;
        for(let row of results){
            try {
                let parsed = JSON.parse(row["data"]);
                if(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.decoder_event_id !== undefined)
                    return Number(parsed.decoder_event_id);
            } catch(e){
                // Legacy plain-block-number rows carry no decoder event id; keep scanning.
            }
        }
        // Only legacy markers found. Returning null makes getReorgsSince replay the full decoder reorg
        // history; on a synced node upgraded from a pre-decoder_event_id release that has not reorged
        // since, that is a large spurious rollback. We deliberately do NOT auto-seed a baseline here
        // (that could silently skip a reorg that landed between the last legacy-scheme processing and
        // the upgrade); warnOnLegacyReorgCursor() surfaces the condition at startup so an operator can
        // do the one-time clean reindex the platform already treats as the norm.
        return null;
    }

    // #2735: read back the stored witness ({ time, hash }) for the CURRENT reorg cursor - the
    // newest new-format marker, the same one getLastProcessedReorgId returns an id for. Returns
    // null when that marker predates the witness columns (legacy), so getReorgsSince falls back
    // to the one-directional over-cursor guard. Runs on the indexer marker DB (doQueryStrict
    // symmetry with getLastProcessedReorgId).
    async getLastProcessedReorgWitness(){
        let results = await this.doQueryStrict(
            `SELECT data, witness_time, witness_hash FROM events WHERE code='REORG' ORDER BY id DESC LIMIT 200`);
        for(let row of results){
            try {
                let parsed = JSON.parse(row["data"]);
                if(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.decoder_event_id !== undefined){
                    if(row.witness_time != null && row.witness_hash != null)
                        return { time: row.witness_time, hash: String(row.witness_hash) };
                    return null; // newest new-format marker predates the witness columns
                }
            } catch(e){ /* legacy bare-number row; keep scanning */ }
        }
        return null;
    }

    // #2735: capture the witness ({ time, hash }) for a decoder REORG event by id, so the caller
    // can persist it via createReorg. Runs on decoderDb (SELECT time, data ... code='REORG').
    // Returns null when the event is absent. doQueryStrict for the throwing read contract shared
    // with getReorgsSince.
    async getReorgEventWitness(decoder_event_id){
        let rows = await this.doQueryStrict(
            `SELECT time, data FROM events WHERE id = ? AND code='REORG'`, [Number(decoder_event_id)]);
        if(rows.length === 0) return null;
        return { time: rows[0].time, hash: this._hashReorgData(rows[0].data) };
    }

    // Startup probe: warn loudly if the indexer has REORG markers but NONE carry a decoder_event_id
    // (all legacy format). On a synced node that means the first reorg detection after upgrade would
    // replay the decoder's entire reorg history (REORG-4). Surfaced, not auto-fixed, because there is
    // no safe way to derive the correct new-format cursor from legacy rows. No-op on a clean DB.
    async warnOnLegacyReorgCursor(){
        try {
            let rows = await this.doQuery(`SELECT data FROM events WHERE code='REORG' ORDER BY id DESC LIMIT 200`);
            if(rows.length === 0) return;
            let hasNewFormat = false;
            for(let row of rows){
                try {
                    let parsed = JSON.parse(row["data"]);
                    if(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.decoder_event_id !== undefined){
                        hasNewFormat = true; break;
                    }
                } catch(e){ /* legacy row */ }
            }
            if(!hasNewFormat)
                console.warn('Reorg cursor invariant: all REORG event markers are legacy (no decoder_event_id). ' +
                    'The next reorg detection would replay the full decoder reorg history. A clean genesis reindex ' +
                    'is recommended to restore the new-format cursor.');
        } catch(e){
            console.warn('Reorg cursor invariant probe failed (non-fatal):', e.message);
        }
    }

    // Handle creating a record of a block reorg. Persists the decoder event id alongside the
    // block index so reorgs can be matched by identity (see getLastProcessedReorgId), not by
    // block-height magnitude - which silently misses every reorg after the first.
    // `witnessTime`/`witnessHash` (optional #2735) witness the decoder REORG event this marker
    // records: its `time` and a sha256 of its `data` payload, captured so getReorgsSince can
    // later detect an out-of-band decoder rebuild that reused this cursor id for a different
    // event. NULL when the caller does not supply them (legacy behavior / back-compat).
    async createReorg(block_index, decoder_event_id, witnessTime, witnessHash){
        let payload = JSON.stringify({ block_index: Number(block_index), decoder_event_id: Number(decoder_event_id) });
        let query = `INSERT INTO events (time, code, data, witness_time, witness_hash) values (now(), 'REORG', ?, ?, ?)`;
        let args  = [payload, (witnessTime != null ? witnessTime : null), (witnessHash != null ? String(witnessHash) : null)];
        // doQueryStrict (not doQuery): this marker advances the processed-reorg cursor and runs
        // outside any transaction, where doQuery would swallow an INSERT failure into []. A
        // swallowed failure leaves the cursor un-advanced while the loop replays past minReorgBlock,
        // so the next iteration re-detects the same reorg and performs a full spurious re-rollback of
        // already-canonical blocks (plus a redundant push-generation bump + hub retractions). Throwing
        // instead crashes to a clean restart where the committed rollback makes the reorg a no-op and
        // the marker is retried, matching the crash-safety ordering the call site documents.
        let results = await this.doQueryStrict(query, args);
    }

    // Read-only reorg observability counters for the /health payload (#1813): the total
    // number of processed reorgs, plus the block index and timestamp of the most recent
    // one. Sourced from the durable REORG markers in the events table (see createReorg).
    // Uses doQuery (not strict) and never throws: health must degrade to null fields, not
    // fail, when the DB read hiccups or the events table is absent.
    async getReorgHealthStats(){
        let stats = { reorgsProcessed: 0, lastReorgBlock: null, lastReorgAt: null };
        try {
            let countRows = await this.doQuery("SELECT COUNT(*) AS n FROM events WHERE code='REORG'");
            if(countRows.length > 0 && countRows[0].n != null)
                stats.reorgsProcessed = Number(countRows[0].n);
            let lastRows = await this.doQuery("SELECT time, data FROM events WHERE code='REORG' ORDER BY id DESC LIMIT 1");
            if(lastRows.length > 0){
                let ms = new Date(lastRows[0].time).getTime();
                stats.lastReorgAt = Number.isFinite(ms) ? ms : null;
                try {
                    let parsed = JSON.parse(lastRows[0].data);
                    if(parsed && typeof parsed === 'object' && parsed.block_index != null)
                        stats.lastReorgBlock = Number(parsed.block_index);
                } catch(e){ /* legacy/plain payload: leave lastReorgBlock null */ }
            }
        } catch(e){
            // DB unreachable / events table absent; return the null-safe defaults.
        }
        return stats;
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

    // The block's own recorded timestamp, unmodified. This is the value to persist
    // and to show a user; it is NOT the value time-keyed consensus logic should read
    // on a chain whose miners can date blocks into the future (see getBlockTime).
    async getRawBlockTime(block_index){
        let key = Number(block_index);
        if(this._blockTimeCache.block_index === key)
            return this._blockTimeCache.block_time;
        let query   = `SELECT block_time from blocks where block_index=?`;
        let results;
        try {
            // doQueryStrict (not doQuery): getBlockTime feeds ProtocolChanges.isEnabled on
            // the consensus path, and doQuery collapses any decoder-DB fault to [] - which is
            // indistinguishable from "no such block" and returns the `false` sentinel. `false`
            // then coerces to 0 in isEnabled's `change.mainnet_time > current.block_time`
            // compare, silently marking every armed time-gated protocol change INACTIVE on this
            // node only (a unilateral contract_hash fork), while the fail-loud catch at
            // protocol_changes.js:583 - written precisely for a transient getBlockTime fault -
            // never fires because nothing was thrown. Throwing propagates to that catch so the
            // block rolls back and retries. See finding #898.
            results = await this.doQueryStrict(query, [block_index]);
        } catch(e){
            // Infrastructure faults (lock-wait timeout, connection loss - any errno other than
            // the benign missing-table/column 1146/1054) must reach the fail-loud gate. A failed
            // lookup is NEVER memoized, so the retry re-queries against a healthy DB.
            rethrowIfInfraFault(e);
            // Benign older-schema gap only: treat as an unresolvable block_time, uncached.
            return false;
        }
        let block_time = (results.length > 0) ? results[0]['block_time'] : false;
        this._blockTimeCache.block_index = key;
        this._blockTimeCache.block_time  = block_time;
        return block_time;
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

    // The timestamps of the `span` blocks immediately below `block_index`, newest
    // first. Feeds the median-time-past calculation in getBlockTime. Returns what
    // exists rather than failing when fewer are available (a fresh chain near
    // genesis), matching Bitcoin, which medians whatever history it has.
    async getPreviousBlockTimes(block_index, span){
        let key   = Number(block_index);
        let count = parseInt(span);
        if(!Number.isFinite(key) || !Number.isFinite(count) || count <= 0) return [];
        let query = `SELECT block_time FROM blocks
                     WHERE block_index < ? AND block_time IS NOT NULL
                     ORDER BY block_index DESC LIMIT ?`;
        let results;
        try {
            // doQueryStrict for the same reason getRawBlockTime uses it: this feeds the
            // consensus clock, and collapsing a DB fault to [] would silently fall back
            // to the raw stamp on this node only, which is a unilateral divergence.
            results = await this.doQueryStrict(query, [key, count]);
        } catch(e){
            rethrowIfInfraFault(e);
            return [];
        }
        return (results || []).map((r) => r['block_time']);
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

    // Early-decide watermark helpers. See the _pollTallyWatermark comment in the
    // constructor and processVoteFinalizations step 2. The fingerprint is the highest
    // action_index present in each of the poll's three tally-input tables (votes for the poll,
    // delegations for the tick, and the tick's credits/debits ledger). All three are append-only
    // during forward processing, so a strictly-higher MAX means a new input row landed; an
    // unchanged tuple proves no input changed and the tally is byte-identical. action_index (not
    // block_index) is used so the fingerprint moves even for multiple input rows within one block.
    async getPollTallyInputWatermark(pollIndex, tick_id){
        let rows = await this.doQuery(
            `SELECT
                (SELECT COALESCE(MAX(action_index),0) FROM votes WHERE poll_index=?)            AS v,
                (SELECT COALESCE(MAX(action_index),0) FROM vote_delegations WHERE tick_id=?)     AS d,
                (SELECT COALESCE(MAX(action_index),0) FROM (
                    SELECT action_index FROM credits WHERE tick_id=?
                    UNION ALL
                    SELECT action_index FROM debits  WHERE tick_id=?
                 ) led)                                                                          AS l`,
            [pollIndex, tick_id, tick_id, tick_id]);
        let r = (rows && rows[0]) ? rows[0] : {};
        return String(r.v || 0) + ':' + String(r.d || 0) + ':' + String(r.l || 0);
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

    // Get block hashes using credits/debits/actions table data and previous hash
    async getBlockHashes(block_index){
        let query   = null;
        // Placeholders for actions data
        let actions = [];
        // Placeholer for ledger data (credits + debits + escrows)
        let ledger  = {
            credits:  [],
            debits:   [],
            escrows:  []
        };
        let info    = [];
        let hashes  = [];
        // CONSENSUS: every query below scopes the block by the ACTION's own block_index
        // (a.block_index), NOT by joining transactions on tx_index. Protocol-generated actions
        // (ORDER_MATCH / SWAP_MATCH / *_EXPIRE, etc.) carry tx_index = NULL with no transactions
        // row, so the old `INNER JOIN transactions ... WHERE t.block_index` silently dropped them
        // and their ledger effects (match settlements, expiry refunds) from the hash. actions.block_index
        // is set for EVERY row (createActionIndex) and equals the tx's block for tx-bearing actions,
        // so this is purely additive: tx-only blocks hash identically, blocks with synthetic actions
        // now cover them. ORDER BY action_index already gives those rows a deterministic position.
        // (BLOCK_HASH_VERSION unchanged: same preimage structure, more rows; everything re-bases
        // atomically pre-launch. xchain-sync/src/BlockHasher.js is the byte-for-byte conformance pair.)
        // Get data from credits table
        // These rows feed the consensus ledger hash. We hash the RESOLVED address/ticker
        // strings (LEFT JOIN through the lookup tables), never the raw address_id/tick_id -
        // those are local AUTO_INCREMENT ids that diverge across nodes after a reorg (see
        // BLOCK_HASH_VERSION). LEFT JOIN preserves rows whose address_id/tick_id is NULL
        // (native-coin movements) as a NULL string, matching every node.
        // credits/debits/escrows have no primary key: ORDER BY action_index alone leaves the
        // order of an action's multiple rows (e.g. an ISSUE's fee credit + mint credit)
        // engine-unspecified, which forks the hash across nodes. Sort on every selected
        // (resolved) column, pinning a BINARY collation so the order is independent of each
        // node's default collation (index_addresses is utf8_general_ci = case/accent-folding).
        query = `SELECT
                    c.action_index,
                    a1.address AS address,
                    t1.tick    AS tick,
                    c.amount
                FROM
                    credits c
                    INNER JOIN actions        a  ON (a.action_index=c.action_index)                    LEFT  JOIN index_addresses a1 ON (a1.id=c.address_id)
                    LEFT  JOIN index_tickers   t1 ON (t1.id=c.tick_id)
                WHERE
                    a.block_index=?
                ORDER BY
                    c.action_index ASC, a1.address COLLATE utf8_bin ASC, t1.tick COLLATE utf8mb4_bin ASC, c.amount ASC`;
        ledger.credits = await this.doQuery(query, [block_index]);
        // Get data from debits table
        query = `SELECT
                    d.action_index,
                    a1.address AS address,
                    t1.tick    AS tick,
                    d.amount
                FROM
                    debits d
                    INNER JOIN actions        a  ON (a.action_index=d.action_index)                    LEFT  JOIN index_addresses a1 ON (a1.id=d.address_id)
                    LEFT  JOIN index_tickers   t1 ON (t1.id=d.tick_id)
                WHERE
                    a.block_index=?
                ORDER BY
                    d.action_index ASC, a1.address COLLATE utf8_bin ASC, t1.tick COLLATE utf8mb4_bin ASC, d.amount ASC`;
        ledger.debits = await this.doQuery(query, [block_index]);
        // Get data from escrows table
        query = `SELECT
                    e.action_index,
                    a1.address AS address,
                    t1.tick    AS tick,
                    e.amount
                FROM
                    escrows e
                    INNER JOIN actions        a  ON (a.action_index=e.action_index)                    LEFT  JOIN index_addresses a1 ON (a1.id=e.address_id)
                    LEFT  JOIN index_tickers   t1 ON (t1.id=e.tick_id)
                WHERE
                    a.block_index=?
                ORDER BY
                    e.action_index ASC, a1.address COLLATE utf8_bin ASC, t1.tick COLLATE utf8mb4_bin ASC, e.amount ASC`;
        ledger.escrows = await this.doQuery(query, [block_index]);
        // CONSENSUS: canonicalize protocol special addresses (BURN/GAS/DONATE/REWARD)
        // to their chain-independent role token in the hash preimage. A per-chain
        // special address (e.g. an issuance fee credited to DONATE1) otherwise leaks
        // the chain's address encoding into the consensus hash, forking the hash chain
        // across BTC/LTC/DOGE for identical actions. Done here so BOTH the flat ledger
        // hash below AND the block_merkle_root (which reuses these stashed rows) see the
        // same canonical strings; balances still track the real address (rows are not
        // mutated in the DB, only this gathered copy used for hashing). See
        // protocolAddressRoles.js; xchain-sync/src/BlockHasher.js mirrors this byte-for-byte.
        for (const row of ledger.credits) row.address = canonicalizeHashAddress(row.address);
        for (const row of ledger.debits)  row.address = canonicalizeHashAddress(row.address);
        for (const row of ledger.escrows) row.address = canonicalizeHashAddress(row.address);
        // Get data from actions table
        // Hash the RESOLVED action-type string (e.g. 'SEND'), not the raw action_id - that
        // is an index_actions AUTO_INCREMENT id assigned on first reference (createAction)
        // and so diverges across nodes after a reorg, exactly like address_id/tick_id.
        query = `SELECT
                    a.action_index,
                    a.tx_index,
                    ia.action AS action
                FROM
                    actions a                    LEFT  JOIN index_actions ia ON (ia.id=a.action_id)
                WHERE
                    a.block_index=?
                ORDER BY
                    a.action_index ASC`;
        actions = await this.doQuery(query, [block_index]);
        // Contract hash data
        let contracts_data = {
            contracts:   [],
            state:       [],
            executions:  [],
            emissions:   [],
            deposits:    [],
            withdrawals: []
        };
        // New deployments. Resolve source_id -> address and status_id -> status string
        // (id-independent, see BLOCK_HASH_VERSION). action_index is unique on contracts so
        // ORDER BY action_index alone is a total order.
        // NOTE: `deploy_chunks` is intentionally NOT a checkpoint-hash input. A chunked
        // DEPLOY's assembled `code` (every consumed chunk's bytes, in pinned order) is
        // sha256-bound into `c.code_hash` at assembly time (actions/deploy.js), so the
        // chunk bytes are already covered here via code_hash. The table itself holds only
        // un-consumed/orphan chunk metadata, derived identically on same-version nodes.
        query = `SELECT c.action_index, a1.address AS source_address, c.code_hash, s1.status AS status
                 FROM contracts c
                 INNER JOIN actions a ON (a.action_index=c.action_index)
                 LEFT  JOIN index_addresses a1 ON (a1.id=c.source_id)
                 LEFT  JOIN index_statuses  s1 ON (s1.id=c.status_id)
                 WHERE a.block_index=?
                 ORDER BY c.action_index ASC`;
        contracts_data.contracts = await this.doQuery(query, [block_index]);
        // Contract state (latest value per key written in this block).
        // state_key collation is flag-day gated (state_key_collation_activation.js):
        // contract_state is utf8_general_ci (case/accent-folding), so the legacy
        // GROUP BY/ORDER BY treat distinct keys like "Key"/"key" as EQUAL - the
        // folding GROUP BY collapses them to one MAX(id) row, silently dropping the
        // other key's value from the contract_hash preimage. At/after the activation
        // height state_key is pinned COLLATE utf8_bin (the same hazard the
        // address/tick sorts above already pin against); below it the folding form
        // is kept so historical block hashes replay byte-identically.
        // xchain-sync/src/BlockHasher.js mirrors this gate byte-for-byte.
        let stateKeyBin = stateKeyCollation.isStateKeyBinCollationActive(
            block_index, this.config['NETWORK'], this.config['COIN']);
        let stateKeyCollate = stateKeyBin ? ' COLLATE utf8_bin' : '';
        query = `SELECT cs.contract_index, cs.state_key, cs.state_value
                 FROM contract_state cs
                 INNER JOIN (
                     SELECT MAX(id) as max_id
                     FROM contract_state
                     WHERE block_index=?
                     GROUP BY contract_index, state_key` + stateKeyCollate + `
                 ) latest ON cs.id = latest.max_id
                 ORDER BY cs.contract_index ASC, cs.state_key` + stateKeyCollate + ` ASC`;
        contracts_data.state = await this.doQuery(query, [block_index]);
        // Executions. Resolve caller_id -> address and status_id -> status string. contract_index
        // is the deploy's action_index (deterministic, not a surrogate id). action_index is unique.
        query = `SELECT ce.action_index, ce.contract_index, a1.address AS caller_address, ce.gas_used, s1.status AS status, ce.emitted_count
                 FROM contract_executions ce
                 INNER JOIN actions a ON (a.action_index=ce.action_index)
                 LEFT  JOIN index_addresses a1 ON (a1.id=ce.caller_id)
                 LEFT  JOIN index_statuses  s1 ON (s1.id=ce.status_id)
                 WHERE a.block_index=?
                 ORDER BY ce.action_index ASC`;
        contracts_data.executions = await this.doQuery(query, [block_index]);
        // Emissions (join through executions to get block scope)
        query = `SELECT em.execution_index, em.emitted_action, em.action_index, em.position
                 FROM contract_emissions em
                 INNER JOIN contract_executions ce ON (ce.action_index=em.execution_index)
                 INNER JOIN actions a ON (a.action_index=ce.action_index)
                 WHERE a.block_index=?
                 ORDER BY em.execution_index ASC, em.position ASC`;
        contracts_data.emissions = await this.doQuery(query, [block_index]);
        // Deposits. Resolve source_id -> address, tick_id -> tick, status_id -> status. The
        // secondary sort keys (kept from the tie-order fix) now use the resolved strings with a
        // pinned BINARY collation so the order is id- and collation-independent across nodes.
        query = `SELECT d.action_index, d.contract_index, a1.address AS source_address, t1.tick AS tick, d.amount, s1.status AS status
                 FROM deposits d
                 INNER JOIN actions a ON (a.action_index=d.action_index)
                 LEFT  JOIN index_addresses a1 ON (a1.id=d.source_id)
                 LEFT  JOIN index_tickers   t1 ON (t1.id=d.tick_id)
                 LEFT  JOIN index_statuses  s1 ON (s1.id=d.status_id)
                 WHERE a.block_index=?
                 ORDER BY d.action_index ASC, d.contract_index ASC, a1.address COLLATE utf8_bin ASC, t1.tick COLLATE utf8mb4_bin ASC, d.amount ASC, s1.status COLLATE utf8_bin ASC`;
        contracts_data.deposits = await this.doQuery(query, [block_index]);
        // Withdrawals. Same resolution + tie-order treatment as deposits.
        query = `SELECT w.action_index, w.contract_index, a1.address AS source_address, t1.tick AS tick, w.amount, s1.status AS status
                 FROM withdrawals w
                 INNER JOIN actions a ON (a.action_index=w.action_index)
                 LEFT  JOIN index_addresses a1 ON (a1.id=w.source_id)
                 LEFT  JOIN index_tickers   t1 ON (t1.id=w.tick_id)
                 LEFT  JOIN index_statuses  s1 ON (s1.id=w.status_id)
                 WHERE a.block_index=?
                 ORDER BY w.action_index ASC, w.contract_index ASC, a1.address COLLATE utf8_bin ASC, t1.tick COLLATE utf8mb4_bin ASC, w.amount ASC, s1.status COLLATE utf8_bin ASC`;
        contracts_data.withdrawals = await this.doQuery(query, [block_index]);
        // Stash the gathered canonical rows so the light-client block_merkle_root
        // (stateCommitment.js, SPV spec §5) can build leaves over the EXACT same
        // rows + ORDER BY as these flat hashes, without re-querying or duplicating
        // the consensus SQL. createBlock() calls getBlockHashes() once per block
        // just before the state-commitment hook runs, so this stash is warm.
        this._lastGatheredBlockRows = { block_index: block_index, ledger: ledger, actions: actions, contracts: contracts_data };
        // Subtract one block from current block
        let prev_block_index = block_index -1;
        // Get hashes from the previous block to include in this blocks hash
        query = `SELECT
                t1.hash as ledger,
                t2.hash as actions,
                t3.hash as contracts
            FROM
                blocks b
                LEFT JOIN index_transactions t1 ON (t1.id=b.ledger_hash_id)
                LEFT JOIN index_transactions t2 ON (t2.id=b.actions_hash_id)
                LEFT JOIN index_transactions t3 ON (t3.id=b.contract_hash_id)
            WHERE
                b.block_index=?`;
        let results = await this.doQuery(query, [prev_block_index]);
        if(results.length >0){
            hashes['ledger']    = results[0].ledger;
            hashes['actions']   = results[0].actions;
            hashes['contracts'] = results[0].contracts;
        }
        // Define list of data to hash
        let tables = ['ledger','actions','contracts'];
        // Loop through the tables, add previous hash to data, then create new block hash
        tables.forEach(table => {
            var data = null;
            if(table=='ledger')    data = ledger;
            if(table=='actions')   data = actions;
            if(table=='contracts') data = contracts_data;
            // Include the block_index and previous block hash in the hash calculation for this block hash
            data['block_index']   = block_index;
            data['previous_hash'] = hashes[table];
            // Fold the consensus hash-scheme version into the preimage so a future scheme
            // change can never collide with or be compared as equal to the current scheme.
            data['hash_version']  = BLOCK_HASH_VERSION;
            info[table] = [];
            info[table]['hash'] = this.util.getDataHash(data);
        });
        // Fourth, NON-consensus integrity hash over the in-place mutations + backdated
        // refund credits the three hashes above structurally cannot cover (rows created in
        // an EARLIER block, mutated in place - replicated via xchain-sync's updated_rows /
        // cooldownCredits channels; see stateHash.js). Additive: NOT chained, NOT folded into
        // ledger/actions/contract, NOT in BLOCK_HASH_VERSION, NOT in getStoredBlockHashes /
        // the hub-signed checkpoint. Its sole consumer is xchain-sync's apply-time recompute,
        // which HALTS a follower that silently failed to apply one of those mutations.
        // ACTIVATION_DELAY_BLOCKS lives nested under config['STAKING'] (calibrated per chain:
        // BTC 6 / LTC 24 / DOGE 60); the top-level key is unset. Resolve it nested-first exactly
        // as every other reader does (delegate.js:128, stake.js, unstake.js, rollback.js). The
        // old top-level read returned undefined, so delay became null and buildStateHashData
        // skipped the entire deactivation_block class on the SOURCE, while the follower (ClientSync)
        // recomputes with the real per-chain delay and INCLUDES it: a guaranteed state-hash
        // divergence HALT on the first deactivation-bearing block, and the feature's primary row
        // class never hashed.
        let staking = this.config['STAKING'];
        let activationDelay = (staking && staking['ACTIVATION_DELAY_BLOCKS']) ? staking['ACTIVATION_DELAY_BLOCKS'] : this.config['ACTIVATION_DELAY_BLOCKS'];
        let stateData = await buildStateHashData(this, block_index, {
            activationDelay: activationDelay,
            gasTick:         this.config['GAS'],
            // network gates the additive index-map class (id-determinism P4); coin extends
            // the lookup to the per-chain '<COIN>:<network>' keys the mid-chain-armed
            // classes (poll_finalize / token_supply) use. The sync follower's recompute
            // (BlockHasher.computeStateHash) MUST pass the same pair or the conformance
            // hash diverges at the activation heights.
            network:         this.config['NETWORK'],
            coin:            this.config['COIN']
        });
        info['state'] = [];
        info['state']['hash'] = this.util.getDataHash(stateData);
        return info;
    }

    // Read the STORED per-block hash triple (ledger/actions/contracts) for a block
    // from the blocks table - the values createBlock() committed, NOT a recompute.
    // Powers the getblockhashes RPC the hub's StateCheckpointEngine signs over.
    // LEFT JOINs the additive light-client roots (state_tree_roots): null before
    // the STATE_COMMITMENT flag-day, present after. Additive: the three flat hashes
    // above are unchanged whether or not the roots exist.
    async getStoredBlockHashes(block_index){
        let query = `SELECT
                b.block_index,
                b.block_time,
                t1.hash as ledger_hash,
                t2.hash as actions_hash,
                t3.hash as contract_hash,
                str.balances_root,
                str.stakes_root,
                str.state_root,
                str.block_merkle_root
            FROM
                blocks b
                LEFT JOIN index_transactions t1 ON (t1.id=b.ledger_hash_id)
                LEFT JOIN index_transactions t2 ON (t2.id=b.actions_hash_id)
                LEFT JOIN index_transactions t3 ON (t3.id=b.contract_hash_id)
                LEFT JOIN state_tree_roots  str ON (str.block_index=b.block_index)
            WHERE
                b.block_index=?`;
        let results = await this.doQuery(query, [block_index]);
        return results.length > 0 ? results[0] : null;
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

    // Lookup a record in the `index_transactions` table and return record id
    async getTransactionId(hash){
        // Genesis intern cache: the same synthetic tx hash is resolved several times per
        // action (createTxIndex/createActionIndex/mappings); serve non-null hits from memory.
        if(this._internCache !== null){
            let hit = this._internCache.tx.get(hash);
            if(hit !== undefined)
                return hit;
        }
        let id    = null;
        let query = "SELECT id FROM index_transactions WHERE `hash`=? LIMIT 1"
        let results = await this.doQuery(query, [hash]);
        if(results.length > 0)
            id = Number(results[0].id);
        if(id !== null && this._internCache !== null)
            this._internCache.tx.set(hash, id);
        return id;
    }

    // Create records in the 'index_transactions' table and return record id
    async createTransaction(hash){
        // Ignore empty hash and return NULL
        if(this.util.isNull(hash))
            return null;
        // Truncate to 250 characters
        hash = String(hash).substring(0,250);
        let id = await this.getTransactionId(hash);
        // Create transaction if it does not already exist
        if(id === null){
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index: a
            // concurrent insert of the same hash is skipped (no duplicate-key throw),
            // and the refetch resolves to the canonical row id.
            let query   = "INSERT IGNORE INTO index_transactions (`hash`) values (?)";
            await this.doQuery(query, [hash]);
            id = await this.getTransactionId(hash);
        }
        // Convert id to a number
        if(id !== null)
            id = Number(id);
        return id;
    }

    // Lookup a record in the `index_addresses` table and return record id
    async getAddressId(address){
        let id  = null;
        let str = String(address);
        let pid = str.substring(1); // Possible ADDRESS ID (everything after the ^ prefix)
        // A wire ^<id> address reference resolves directly to the numeric id (mirrors
        // getTickerId). Real crypto addresses (base58/bech32) and the contract-derived
        // C:<CHAIN>:<index> form never begin with '^', so this caret check cannot collide
        // with a legitimate address string. Only the CANONICAL form is accepted (no leading
        // zero, id >= 1) and only when a backing row actually exists in the deterministic
        // set (block_index IS NOT NULL), matching resolveAddressRef: a non-canonical or
        // dangling/out-of-band caret yields null rather than a phantom id. pid is handed to
        // SQL verbatim (never Number()) so a large id keeps full precision.
        if(str.substring(0,1)=='^' && CANONICAL_CARET_ID.test(pid)){
            let results = await this.doQuery("SELECT id FROM index_addresses WHERE id=? AND block_index IS NOT NULL LIMIT 1", [pid]);
            if(results.length > 0)
                id = Number(results[0].id);
            return id;
        }
        // Genesis intern cache: serve a non-null hit from memory (see _internCache).
        if(this._internCache !== null){
            let hit = this._internCache.addr.get(str);
            if(hit !== undefined)
                return hit;
        }
        // Otherwise look the id up by the canonical address string.
        if(this.util.isNull(id)){
            let query   = "SELECT id FROM index_addresses WHERE `address`=? LIMIT 1";
            let results = await this.doQuery(query, [address]);
            if(results.length > 0)
                id = Number(results[0].id);
        }
        if(id !== null && this._internCache !== null)
            this._internCache.addr.set(str, id);
        return id;
    }

    // XChain-local dispenser fresh-address verdict (b7ecae51 /; gated by
    // dispenser_freshness_activation.js). Returns true iff `address` has PRIOR
    // XChain-tagged activity as of `blockIndex`: an index_addresses row assigned a
    // block_index STRICTLY before blockIndex (BLOCK_INDEX-1 semantics). Used, at/after
    // the freshness flag-day, in place of the external utxo-tracker getFirstSeen HTTP
    // call so the verdict is a deterministic function of chain state (an external,
    // per-node-reachability call in a hashed verdict forks the ledger). An address
    // first interned in THIS block has block_index == blockIndex and does NOT count as
    // prior activity, so a same-block-only GET_ADDRESS is fresh. `block_index IS NOT
    // NULL` excludes out-of-band legacy ids that are never part of the deterministic set.
    async hasXChainActivityBefore(address, blockIndex){
        let results = await this.doQuery(
            "SELECT id FROM index_addresses WHERE `address`=? AND block_index IS NOT NULL AND block_index < ? LIMIT 1",
            [address, blockIndex]);
        return results.length > 0;
    }

    // Handle returning the next explicit id for the `index_addresses` table.
    // Mirrors getNextActionIndex: the surviving MAX(id)+1 (1 on an empty table).
    // Assigning ids explicitly (rather than via AUTO_INCREMENT, which never rewinds
    // on DELETE) lets rollback delete orphaned-block ids and a reapply reproduce the
    // exact same ids, so a wire ^<id> address reference resolves identically on every
    // node. The block-processing loop is single-threaded, so reading MAX then
    // inserting cannot race.
    async getNextAddressId(){
        let id      = 0;
        let results = await this.doQuery("SELECT id FROM index_addresses ORDER BY id DESC LIMIT 1");
        if(results.length > 0)
            id = Number(results[0].id);
        id++;
        return id;
    }

    // Startup invariant probe (#5052): count index rows with a NULL block_index. These are
    // out-of-band (legacy AUTO_INCREMENT) ids that are invisible to ^<id> resolution but
    // inflate the dense counter and signal the DB was not cleanly reindexed from genesis.
    // Warns loudly with the count rather than throwing, so an in-progress migration node is
    // not bricked; the planned clean reindex drives both counts to zero. No-op on a clean DB.
    async warnOnOrphanIndexIds(){
        try {
            let a = await this.doQuery("SELECT COUNT(*) AS c FROM index_addresses WHERE block_index IS NULL");
            let t = await this.doQuery("SELECT COUNT(*) AS c FROM index_tickers WHERE block_index IS NULL");
            let addrOrphans = (a.length > 0) ? Number(a[0].c) : 0;
            let tickOrphans = (t.length > 0) ? Number(t[0].c) : 0;
            if(addrOrphans > 0 || tickOrphans > 0)
                console.warn('Index id invariant: ' + addrOrphans + ' index_addresses and ' + tickOrphans +
                    ' index_tickers rows have a NULL block_index (out-of-band ids). These inflate the ' +
                    'deterministic id counter; a clean genesis reindex is required to restore the invariant.');
        } catch(e){
            // Tolerate a partially-migrated DB (column may not exist yet): degrade to silent.
            console.warn('Index id invariant probe failed (non-fatal):', e.message);
        }
    }

    // Create records in the 'index_addresses' table and return record id
    // @param {address}     string  Address string (or already-resolved value)
    // @param {blockIndex}  integer Block at which the id is first assigned (defaults to
    //                              the block-processing context, this.blockIndex)
    async createAddress(address, blockIndex){
        // Ignore empty address and return NULL
        if(this.util.isNull(address))
            return null;
        // Truncate to 120 characters
        address = String(address).substring(0,120);
        // Defense-in-depth: a raw wire ^<id> reference must be resolved by resolveAddressRef
        // BEFORE it reaches createAddress; it is never a value to intern. If one ever arrives
        // here (a future mis-wired caller), refuse to create a literal "^…" address row.
        // A canonical, existing ^<id> still resolves via getAddressId below; anything else
        // returns null so the caller treats it as a no-op rather than minting a bogus row.
        if(address.substring(0,1) === '^')
            return await this.getAddressId(address);
        let id = await this.getAddressId(address);
        // Create address if it does not already exist
        if(id === null){
            // Rollback refresh phase: resolve-only, never assign a new id. An address that
            // no longer exists here existed only in the just-rolled-back blocks; recreating
            // it would resurrect the deleted id and re-open the wire ^<id> fork. See
            // suppressIndexIdCreation (constructor) and rollback.js. Returns null; the
            // refresh callers treat a null address_id as a no-op (no balances to update).
            if(this.suppressIndexIdCreation)
                return null;
            if(this.transactionConnection != null){
                // Block-processing context: assign a deterministic dense id and stamp the
                // block, so the id is reorg-reproducible and ^<id> resolves identically on
                // every node. Ids are assigned in caller order; Actions.assignActionAddressIds
                // registers an action's new wire-field addresses FIRST, in byte-sorted VALUE
                // order, so the within-action id order is pinned by value, not field layout.
                // INSERT IGNORE keeps this race-safe against the UNIQUE address index (a
                // concurrent same-address insert is skipped; the refetch resolves the row);
                // the explicit id is MAX(id)+1 so it cannot collide with an existing row.
                let bi = (blockIndex !== undefined && blockIndex !== null) ? blockIndex : this.blockIndex;
                id = await this.getNextAddressId();
                let query = "INSERT IGNORE INTO index_addresses (`id`, `address`, `block_index`) values (?, ?, ?)";
                await this.doQuery(query, [id, address, (this.util.isNull(bi) ? null : bi)]);
                id = await this.getAddressId(address);
                // F1a apply hook: this address just received its deterministic in-block id.
                // If recovery staged any rewards for it (recovery_pending_rewards, keyed by the
                // raw address string), materialize them now into validator_rewards under this
                // deterministic source_id. Normal indexing pays one COUNT(*) probe and then
                // short-circuits forever (no recovery in progress => remaining stays 0).
                await this._maybeApplyPendingRewards(address, id, bi);
            } else {
                // Outside block processing (API read paths, recovery seed): keep the legacy
                // AUTO_INCREMENT path with a NULL block_index. These ids are not assigned
                // during consensus block processing, so they are not part of the
                // deterministic/rollback-tracked set. If this fires AFTER deterministic
                // indexing has begun it would bump MAX(id) and offset the dense counter, so
                // warn loudly: it must never happen during the indexing lifetime (#5052).
                if(this.deterministicIndexingStarted)
                    console.warn('Index id invariant: out-of-band index_addresses insert ("' + address +
                        '") after deterministic indexing began; this offsets the id counter.');
                let query = "INSERT IGNORE INTO index_addresses (`address`) values (?)";
                await this.doQuery(query, [address]);
                id = await this.getAddressId(address);
            }
        }
        // Convert id to a number
        if(id !== null)
            id = Number(id);
        return id;
    }

    // F1a recovery reward apply hook. Called from createAddress right after an address
    // first receives its deterministic in-block id. Cheap-gates on a one-time-probed count
    // of unapplied staged rewards so normal indexing (no recovery in progress) pays a single
    // COUNT(*) and then short-circuits on every later call. See the constructor flags above
    // and recovery.js for the staging side.
    async _maybeApplyPendingRewards(address, source_id, materializedBlock){
        if(source_id === null || source_id === undefined)
            return;
        if(!this._recoveryPendingChecked){
            // One-time probe. The table is auto-created by verifyTables, so it always exists;
            // guard anyway so a partially-migrated DB degrades to "no pending" instead of throwing.
            try {
                let probe = await this.doQuery("SELECT COUNT(*) AS c FROM recovery_pending_rewards WHERE applied=0");
                this._recoveryPendingRemaining = (probe.length > 0) ? Number(probe[0].c) : 0;
            } catch(e){
                this._recoveryPendingRemaining = 0;
            }
            this._recoveryPendingChecked = true;
        }
        if(this._recoveryPendingRemaining <= 0)
            return;
        // Stamp applied_block = the block this address was first seen at (createAddress
        // passes its block context). It is the forward-window key xchain-sync streams
        // these by; without it a materialization whose earn-block sits below a follower's
        // incremental cursor never reaches the follower (the reorg re-drain is the acute
        // case, but a recovery-then-incremental-catch-up has the same gap).
        let applied = await this._applyPendingRewardsForAddress(address, source_id, materializedBlock);
        this._recoveryPendingRemaining -= applied;
    }

    // Materialize every unapplied staged reward for this source address into validator_rewards
    // under the just-assigned deterministic source_id, byte-identical to the in-block
    // createValidatorReward row shape (same columns, same UNIQUE dedup). Stamps the staging row
    // with the resolved source_id and marks it applied (so a reorg re-arm can find rows whose
    // source id was rolled back). Returns the number of rows applied. The archived block_index
    // is carried verbatim onto validator_rewards (it is the reward's earn-block, not the
    // address's first-seen block). validator_rewards is NOT consensus-hashed (parity-only), so
    // the bar here is COLLECT-correctness + from-genesis parity, not block-hash byte-identity.
    // materializedBlock (optional): the block at which this materialization happens (the
    // address's first-seen block, or the reorg point B on a rollback re-drain). Recorded
    // on the staging row as applied_block, the forward-window key xchain-sync streams the
    // row by when its validator_rewards block_index (earn-block) sits below the replication
    // window. Left NULL when not supplied (legacy callers); the collector skips NULL rows.
    async _applyPendingRewardsForAddress(source_address, source_id, materializedBlock){
        let rows = await this.doQuery(
            "SELECT id, validator_pubkey, reward_type, round_reference, amount, block_index FROM recovery_pending_rewards WHERE source_address=? AND applied=0",
            [source_address]);
        let appliedBlock = (materializedBlock === undefined || materializedBlock === null)
            ? null : Number(materializedBlock);
        let count = 0;
        for(let r of rows){
            let pubkey_id = await this.getOrCreatePubkeyId(String(r.validator_pubkey).toLowerCase());
            if(pubkey_id === null)
                continue;   // leave unapplied; surfaces as a parity gap rather than a bad FK
            // round_qualifier keeps this row's key identical to what the live writers
            // produce, which is what "same UNIQUE dedup" above promises. The staging table
            // carries no snapshot_block, but it does not need one: for 'anchor_archive' the
            // reward's EARN block IS the snapshot block (both live writers pass
            // SNAPSHOT_BLOCK as block_index), so the archived block_index is the qualifier.
            // Every other reward type resolves to 0 and is written exactly as before.
            // Without this a recovered node would key archive rewards at 0 while a live node
            // keys them at snapshot_block, so a pair sharing a reissued MATCH_BATCH_SEQ would
            // collapse under INSERT IGNORE here and the recovered node's COLLECT total would
            // sit one archive reward below a from-genesis replay's.
            await this.doQuery(
                `INSERT IGNORE INTO validator_rewards
                    (source_id, signing_pubkey_id, reward_type, round_reference, round_qualifier, amount, block_index)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [source_id, pubkey_id, String(r.reward_type), r.round_reference,
                 arKey.rewardRoundQualifier(r.reward_type, r.block_index),
                 String(r.amount), Number(r.block_index)]);
            await this.doQuery("UPDATE recovery_pending_rewards SET applied=1, source_id=?, applied_block=? WHERE id=?",
                [source_id, appliedBlock, r.id]);
            count++;
        }
        return count;
    }

    // Resolve a wire ^<id> address reference to its canonical address string.
    // Action handlers call this BEFORE validating an address field so the compact
    // ^<id> form the SDK emits by default (addressResolver.compactAddresses) is
    // accepted and credited identically to the full address. The reverse of
    // getAddressId (string -> id), it is deterministic across nodes: index_addresses
    // ids are assigned by the explicit dense counter on the canonical chain
    // (getNextAddressId), so id -> address is the same on every node and reorg-stable.
    //
    // Only a STRICTLY canonical ^<digits> reference is resolved. Any other caret
    // string (^007, ^1.5, ^0x10, ^-1, ^1e3, ^ 1, ^, ^abc) is returned UNCHANGED so the
    // caller's existing isCryptoAddress() format check rejects it; this also keeps a
    // non-integer / out-of-range id off the integer FK columns. Leading zeros are
    // rejected (^007 must not alias to ^7) so a single entity has exactly one wire
    // byte-form. A dangling reference (no such id yet, e.g. a forward reference) is
    // likewise returned unchanged and rejected. The digit string is handed to SQL
    // verbatim (never via Number()), so a large id keeps full precision and an
    // out-of-range id simply matches no row.
    //
    // returning the value unchanged states no verdict, so rejection depends on
    // the caller's own format check. Prefer resolveAddressRefChecked below, which
    // resolves identically and additionally reports the activation-gated hard-invalid
    // verdict; this raw form stays for callers with no block context.
    async resolveAddressRef(value){
        if(this.util.isNull(value))
            return value;
        let str = String(value);
        if(str.substring(0,1) !== '^')
            return value;
        let pid = str.substring(1);
        if(!CANONICAL_CARET_ID.test(pid))
            return value;
        // F2 (deterministic-set gate): resolve a wire ^<id> ONLY to an id in the
        // deterministic set (block_index IS NOT NULL). Ids assigned out-of-band
        // (recovery pre-seed; see createAddress) are NOT reproducible across nodes, so
        // resolving a ^id to one would fork. A non-deterministic / nonexistent id leaves
        // the value unchanged, so the caller's isCryptoAddress check rejects it the same
        // way on every node. No-op on current data (no out-of-band ids exist outside
        // dormant recovery). See.
        let results = await this.doQuery("SELECT address FROM index_addresses WHERE id=? AND block_index IS NOT NULL LIMIT 1", [pid]);
        if(results.length > 0 && !this.util.isNull(results[0].address))
            return String(results[0].address);
        return value;
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

    // Lookup a record in the `blocks` table and return record id
    async getBlockId(block_index){
        let id    = null;
        let query = "SELECT id FROM blocks WHERE block_index=? LIMIT 1"
        let results = await this.doQuery(query, [block_index]);
        if(results.length > 0)
            id = Number(results[0].id);
        return id;
    }

    // Handle creating/updating a block in the `blocks` table
    async createBlock(block_index, block_time){
        // Ignore empty hashes and return hardcoded record id
        if(block_index==null||block_index==='')
            return false;
        let block_id = await this.getBlockId(block_index);
        let hashes   = await this.getBlockHashes(block_index);
        // Create transaction hashes in the `index_transactions` table and get the hash id
        let ledger_hash_id   = await this.createTransaction(hashes.ledger.hash);
        let actions_hash_id  = await this.createTransaction(hashes.actions.hash);
        let contract_hash_id = await this.createTransaction(hashes.contracts.hash);
        // Replication-integrity state hash (additive; see getBlockHashes). Interned like the
        // other three but stored in its own blocks.state_hash_id column - NOT part of the
        // hub-signed checkpoint (getStoredBlockHashes does not read it back).
        // NOTE: this column was added after genesis with no historical backfill, so a
        // long-running node keeps state_hash_id = NULL for blocks indexed BEFORE the feature
        // shipped, while a from-genesis replay computes it for every block. A whole-table
        // `blocks` diff on state_hash_id for that pre-feature band is EXPECTED and is not a
        // rollback/consensus defect (it is outside any reorg window and the column is not
        // hub-signed). A live TP-03 blocks comparison should scope to the post-feature band.
        let state_hash_id    = await this.createTransaction(hashes.state.hash);
        // Create data
        let query = "INSERT INTO blocks (block_time, ledger_hash_id, actions_hash_id, contract_hash_id, state_hash_id, block_index) values (?, ?, ?, ?, ?, ?)";
        if(block_id!=null){
            query = `UPDATE
                        blocks
                    SET
                        block_time=?,
                        ledger_hash_id=?,
                        actions_hash_id=?,
                        contract_hash_id=?,
                        state_hash_id=?
                    WHERE
                        block_index=?`;
        }
        let results = await this.doQuery(query, [block_time, ledger_hash_id, actions_hash_id, contract_hash_id, state_hash_id, block_index]);
        // Display status message
        let ledger    = String(hashes.ledger.hash).substring(0,5);
        let actions   = String(hashes.actions.hash).substring(0,5);
        let contracts = String(hashes.contracts.hash).substring(0,5);
        return [ledger, actions, contracts];
    }

    // Lookup a record in the `index_actions` table and return record id
    async getActionId(action){
        let id    = null;
        let query = "SELECT id FROM index_actions WHERE action=? LIMIT 1";
        let results = await this.doQuery(query, [action]);
        if(results.length > 0)
            id = Number(results[0].id);
        return id;
    }

    // Create records in the 'index_actions' table and return record id
    async createAction(action){
        var id = await this.getActionId(action);
        // Handle creating record
        if(id==null){
            // INSERT IGNORE + refetch keeps this consistent with the other index_*
            // upserts. NOTE: index_actions carries only a non-unique index, so IGNORE
            // does not itself prevent duplicate rows under true concurrency - the
            // single-threaded block-processing loop is what serializes these inserts.
            let query = "INSERT IGNORE INTO index_actions (action) values (?)";
            await this.doQuery(query, [action]);
            id = await this.getActionId(action);
        }
        return id;
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

    // Handles returning the highest action_index from `actions` table
    async getNextActionIndex(){
        let idx   = 0;
        let query = "SELECT action_index FROM actions ORDER BY action_index DESC LIMIT 1";
        let results = await this.doQuery(query);
        if(results.length > 0)
            idx = Number(results[0].action_index);
        // Increase current action_index by 1 to get the next action_index
        idx++;
        return idx;
    }

    // Source-chain reorg fence (item 5308). The current monotonic push generation for `coin`,
    // 0 when no rollback has ever bumped it (matches the DEFAULT 0 hub rows stamp before the
    // first reorg, all of which are then always deletable). Read fresh on every push + rollback;
    // the value lives only in the DB so it survives a crash and is never rolled back.
    async getPushGeneration(coin){
        let results = await this.doQuery('SELECT generation FROM push_generations WHERE coin = ? LIMIT 1', [coin]);
        return (results.length > 0) ? Number(results[0].generation) : 0;
    }

    // Bump `coin`'s push generation by one (creating the row at 1 on first bump) and return the
    // NEW value. Called once at the start of every rollback, BEFORE forward replay, so rows the
    // replay re-publishes carry the bumped generation while the orphaned rows keep the prior one.
    // The retraction carries the PRE-bump generation (newGen - 1), so the fence deletes the
    // orphans (gen <= pre) and the re-published rows (gen == new) survive. Monotonic: a skipped
    // value from a crashed-then-retried rollback is harmless since the fence only needs <=.
    async bumpPushGeneration(coin){
        await this.doQuery(
            'INSERT INTO push_generations (coin, generation) VALUES (?, 1) ON DUPLICATE KEY UPDATE generation = generation + 1',
            [coin]);
        return await this.getPushGeneration(coin);
    }

    // Lookup action_index records in the `actions` table and return them
    async getActionIndex(data){
        let action_index  = null;
        let block_index   = data['BLOCK_INDEX'];
        let tx_index      = data['TX_INDEX'];
        let tx_vout       = data['TX_VOUT'];
        let action_format = data['FORMAT'];
        let action_id     = await this.createAction(data['ACTION']);
        let query = `SELECT
                        a.action_index
                    FROM
                        actions a
                    WHERE
                        a.block_index=? AND 
                        a.tx_index=? AND 
                        a.tx_vout=? AND
                        a.action_id=? AND
                        a.action_format=?`;
        let args = [block_index, tx_index, tx_vout, action_id, action_format];
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            action_index = Number(results[0].action_index);
        return action_index;
    }

    // Create records in the 'actions' table and return record id
    async createActionIndex(data, force=false){
        // Set values to NULL if it is not already set. TX_VOUT is normalized here too so a
        // hub-mirror-injected action ({ ACTION, BLOCK_INDEX [, FORMAT] }) carries an explicit
        // null rather than leaking `undefined` into getActionIndex's args and the INSERT below,
        // where it only reached NULL via sqlstring's undefined->NULL coercion.
        data['BLOCK_INDEX'] = (!this.util.isNull(data['BLOCK_INDEX'])) ? data['BLOCK_INDEX'] : null;
        data['TX_INDEX']    = (!this.util.isNull(data['TX_INDEX'])) ? data['TX_INDEX'] : null;
        data['TX_VOUT']     = (!this.util.isNull(data['TX_VOUT'])) ? data['TX_VOUT'] : null;
        data['FORMAT']      = (!this.util.isNull(data['FORMAT'])) ? data['FORMAT'] : null;
        // Check if the action index already exists. LOAD-BEARING NULL-blindness: for
        // synthetic/injected rows block_index/tx_index/tx_vout are NULL, and SQL `col = NULL`
        // matches nothing, so this probe never fires and every injected CROSS_SETTLE / XEXEC /
        // XCALL mints a FRESH action_index (required - multiple per block must not collapse into
        // one). Do NOT "harden" the getActionIndex predicate to NULL-safe `<=>`: that would merge
        // same-block injections into one action_index and corrupt settlement.
        let action_index = await this.getActionIndex(data);
        // Handle creating record
        if(action_index==null || force==true){
            action_index      = await this.getNextActionIndex();
            let block_index   = data['BLOCK_INDEX'];
            let tx_index      = data['TX_INDEX'];
            let tx_vout       = data['TX_VOUT'];
            let action_format = data['FORMAT'];
            let action_id     = await this.createAction(data['ACTION']);
            // Persist the action's TRUE source so it is never re-derived from the transaction.
            // For user actions this is the tx sender (identical to transactions.source_id); for
            // contract emissions it is the contract's derived address (the caller's EXECUTE tx
            // would otherwise mis-attribute it). createAddress returns null for null/undefined,
            // so system/synthetic actions (which pass no SOURCE) store NULL.
            let source_id     = await this.createAddress(data['SOURCE']);
            let query         = "INSERT INTO actions (action_index, block_index, tx_index, tx_vout, action_id, action_format, source_id) values (?, ?, ?, ?, ?, ?, ?)";
            let args          = [action_index, block_index, tx_index, tx_vout, action_id, action_format, source_id];
            let results       = await this.doQuery(query, args);
        }
        return action_index;
    }

    // Update records in the 'actions' table and return record id
    async updateActionIndex(action_index, action){
        if(action_index){
            let action_id = await this.createAction(action);
            let query     = "UPDATE actions SET action_id=? WHERE action_index=?";
            let args      = [action_id, action_index];
            let results   = await this.doQuery(query, args);
        }
    }

    // Delete records in the 'actions' table
    async deleteActionIndex(action_index){
        if(action_index){
            let query   = "DELETE FROM actions WHERE action_index=?";
            let args    = [action_index];
            let results = await this.doQuery(query, args);
        }
    }

    // Lookup a record in the `index_tickers` table and return record tick
    async getTicker(tick_id){
        let tick    = null;
        let query   = "SELECT tick FROM index_tickers WHERE id=? LIMIT 1";
        let results = await this.doQuery(query, [tick_id]);
        if(results.length > 0)
            tick = results[0].tick;
        return tick;
    }

    // Cached tick_id -> canonical name resolver for the light-client touched-key
    // set. A resolved mapping is stable WITHIN a chain segment, so the name is
    // cached; it is NOT immutable across a reorg, because a rollback deletes
    // index_tickers rows above the reorg point and frees their dense ids for
    // createTicker to reassign. rollback.js therefore drops this cache on
    // completion. A stale entry here keys the touched set to the OLD
    // tick name, which commits no leaf at all and moves no root.
    //
    // AN ABSENCE IS NOT CACHED, and that distinction is the whole point.
    // The immutability argument covers names only: an id with no row *right now*
    // can have one moments later, because tickers are interned during block
    // processing, and a rollback can delete an id that is then re-interned. If a
    // null were cached, createLedgerChangeRecord's `canonTick != null` guard would
    // skip EVERY later touch for that tick, permanently, for the connection
    // lifetime, and the balance leaf would silently never be committed. That is
    // all-or-nothing per ticker, which is exactly the shape found on BTC regtest:
    // 4 tickers of 276 with every one of their keys missing from the committed
    // balances_root, and 0 tickers missing only some.
    //
    // The read is STRICT for the same reason (M-17): through doQuery a transient
    // fault returns [], which this function cannot distinguish from "no such
    // ticker". Soft-failing into a cached absence is the two defects composing
    // into a permanent, silent consensus omission, so the read throws instead and
    // the block is retried.
    // Cached address_id -> canonical address resolver, the address-axis twin of
    // _smtTickName and subject to exactly the same rules: an ABSENCE is never
    // cached, the read is STRICT so a transient fault throws instead of being
    // indistinguishable from "no such address", and the cache is only valid
    // WITHIN a chain segment. A rollback frees dense ids for reuse, so
    // rollback.js drops this cache when it completes. Do not restore the
    // old "the mapping is immutable" justification: it is true only until a
    // reorg reassigns the id.
    async _smtAddressName(address_id){
        if(!this._smtAddressNameCache) this._smtAddressNameCache = new Map();
        if(this._smtAddressNameCache.has(address_id)) return this._smtAddressNameCache.get(address_id);
        let rows = await this.doQueryStrict("SELECT address FROM index_addresses WHERE id=? LIMIT 1", [address_id]);
        let name = (rows.length > 0) ? rows[0].address : null;
        if(name != null && name !== '')
            this._smtAddressNameCache.set(address_id, name);
        return name;
    }

    async _smtTickName(tick_id){
        if(!this._smtTickNameCache) this._smtTickNameCache = new Map();
        if(this._smtTickNameCache.has(tick_id)) return this._smtTickNameCache.get(tick_id);
        let rows = await this.doQueryStrict("SELECT tick FROM index_tickers WHERE id=? LIMIT 1", [tick_id]);
        let name = (rows.length > 0) ? rows[0].tick : null;
        if(name != null && name !== '')
            this._smtTickNameCache.set(tick_id, name);
        return name;
    }

    // Lookup a record in the `index_tickers` table and return record id
    async getTickerId(tick){
        let id  = null;
        let str = String(tick);
        let pid = str.substring(1); // Possible TICK ID (everything after the ^ prefix)
        // A wire ^<id> ticker reference resolves directly to the numeric id. Unlike the
        // address axis there is no resolveTickerRef shim, so this IS the live consumption
        // path for a wire ^<tickid>; it must be as strict as resolveAddressRef. Only the
        // CANONICAL form is accepted (no leading zero, id >= 1) and only when a backing row
        // exists in the deterministic set (block_index IS NOT NULL): a non-canonical or
        // dangling/out-of-band caret yields null so the handler rejects it as an unknown
        // ticker. pid is handed to SQL verbatim (never Number()) to keep full precision.
        if(str.substring(0,1)=='^' && CANONICAL_CARET_ID.test(pid)){
            let results = await this.doQuery("SELECT id FROM index_tickers WHERE id=? AND block_index IS NOT NULL LIMIT 1", [pid]);
            if(results.length > 0)
                id = Number(results[0].id);
            return id;
        }
        // Genesis intern cache: serve a non-null hit from memory, keyed by LOWER(tick) to
        // match the case-insensitive lookup below (see _internCache).
        let lc = String(tick).toLowerCase();
        if(this._internCache !== null){
            let hit = this._internCache.tick.get(lc);
            if(hit !== undefined)
                return hit;
        }
        // Try to lookup id using tick passed
        if(this.util.isNull(id)){
            let query   = "SELECT id FROM index_tickers WHERE LOWER(tick)=? LIMIT 1";
            let args    = [lc];
            let results = await this.doQuery(query, args);
            if(results.length > 0)
                id = Number(results[0].id);
        }
        if(id !== null && this._internCache !== null)
            this._internCache.tick.set(lc, id);
        return id;
    }

    // Handle returning the next explicit id for the `index_tickers` table.
    // Same deterministic dense-counter role as getNextAddressId (see its note): a wire
    // ^<id> ticker reference resolves through this id, so it must be rollback-reproducible.
    async getNextTickerId(){
        let id      = 0;
        let results = await this.doQuery("SELECT id FROM index_tickers ORDER BY id DESC LIMIT 1");
        if(results.length > 0)
            id = Number(results[0].id);
        id++;
        return id;
    }

    // Create records in the 'index_tickers' table and return record id
    // @param {tick}        string  Ticker name (or already-resolved value)
    // @param {blockIndex}  integer Block at which the id is first assigned (defaults to
    //                              the block-processing context, this.blockIndex)
    async createTicker(tick, blockIndex){
        // Ignore empty tick and return NULL
        if(this.util.isNull(tick))
            return null;
        // Defense-in-depth: a raw wire ^<id> ticker reference is resolved by getTickerId, never
        // interned as a literal "^…" tick row. A canonical, existing ^<id> still resolves via
        // getTickerId below; anything else returns null rather than minting a bogus row.
        if(String(tick).substring(0,1) === '^')
            return await this.getTickerId(tick);
        let id = await this.getTickerId(tick);
        // Create ticker if it does not already exist
        if(id === null){
            // Rollback refresh phase: resolve-only, never assign a new id. A tick that no
            // longer exists here existed only in the just-rolled-back blocks; recreating it
            // would resurrect the deleted id and re-open the wire ^<id> fork. See
            // suppressIndexIdCreation (constructor) and rollback.js. Returns null; the
            // refresh callers treat a null tick_id as a no-op (getTokenInfo finds no row).
            if(this.suppressIndexIdCreation)
                return null;
            if(this.transactionConnection != null){
                // Block-processing context: assign a deterministic dense id and stamp the
                // block (reorg-reproducible; see createAddress). One ISSUE introduces one
                // new tick under its own action_index, so action ordering already pins the
                // tick id order; the explicit counter + block_index make it rollback-safe.
                // The get-first lookup is retained because getTickerId() matches
                // case-insensitively (LOWER(tick)) while the UNIQUE index is binary;
                // refetching through getTickerId keeps that case-folding behaviour.
                let bi = (blockIndex !== undefined && blockIndex !== null) ? blockIndex : this.blockIndex;
                id = await this.getNextTickerId();
                let query = "INSERT IGNORE INTO index_tickers (`id`, `tick`, `block_index`) values (?, ?, ?)";
                await this.doQuery(query, [id, tick, (this.util.isNull(bi) ? null : bi)]);
                id = await this.getTickerId(tick);
            } else {
                // Outside block processing: keep the legacy AUTO_INCREMENT path (NULL block_index).
                // As with createAddress, an out-of-band insert after deterministic indexing began
                // offsets the dense id counter and must never happen during indexing (#5052).
                if(this.deterministicIndexingStarted)
                    console.warn('Index id invariant: out-of-band index_tickers insert ("' + tick +
                        '") after deterministic indexing began; this offsets the id counter.');
                let query = "INSERT IGNORE INTO index_tickers (tick) values (?)";
                await this.doQuery(query, [tick]);
                id = await this.getTickerId(tick);
            }
        }
        // Convert id to a number
        if(id !== null)
            id = Number(id);
        return id;
    }

    // Handle getting token information using issues table
    // @param {tick}            string  Ticker name or Ticker ID
    // @param {block_index}     integer Block Index 
    // @param {action_index}    integer action_index of action
    async getTokenInfo(tick, block_index, action_index){
        let data = false,
            sql  = '',
            args = [];
        // Only query database if we actually have a tick or tick_id passed
        if(!this.util.isNull(tick)){
            // Get the tick_id for the given ticker
            let tick_id = await this.createTicker(tick);
            // Add tick_id to SQL query arguments
            args.push(tick_id);
            // If a block_index was given, only lookup tokens created before or in given block_index
            if(!this.util.isNull(block_index) && this.util.isNumeric(block_index)){
                sql += " AND t1.block_index <= ?";
                args.push(parseInt(block_index));
            }
            // If a action_index was given, only lookup tokens created before given action_index
            if(!this.util.isNull(action_index) && this.util.isNumeric(action_index)){
                sql += " AND a1.action_index < ?";
                args.push(parseInt(action_index));
            }
            // Build out SQL query based on search params
            let query = `SELECT 
                            i.max_supply,
                            i.max_mint,
                            i.decimals,
                            i.description,
                            i.lock_max_supply,
                            i.lock_mint_supply,
                            i.lock_mint,
                            i.lock_max_mint,
                            i.lock_description,
                            i.lock_sleep,
                            i.lock_callback,
                            i.callback_block,
                            i.callback_amount,
                            i.mint_address_max,
                            i.mint_start_block,
                            i.mint_stop_block,
                            i.allow_list,
                            i.block_list,
                            i.action_index,
                            t1.block_index,
                            t2.tick,
                            t3.tick as callback_tick,            
                            a2.address as owner,
                            a3.address as transfer
                        FROM 
                            issues i
                            INNER JOIN actions            a1 ON (a1.action_index=i.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN index_tickers      t2 ON (t2.id=i.tick_id)
                            INNER JOIN index_addresses    a2 ON (a2.id=a1.source_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=i.status_id)
                            LEFT  JOIN index_addresses    a3 ON (a3.id=i.transfer_id)
                            LEFT  JOIN index_tickers      t3 ON (t3.id=i.callback_tick_id)
                        WHERE
                            s1.status='valid' AND
                            i.tick_id=?` + sql + `
                        ORDER BY 
                            i.action_index ASC`;
            let results = await this.doQuery(query, args);
            if(results.length > 0){
                // Define data object
                if(!data)
                    data = {};
                // Loop through ISSUE transactions for the given ticker
                for(let row of results){
                    // Define object of values for this ISSUE tx
                    let arr  = {};
                    arr['ACTION_INDEX']      = row.action_index;
                    arr['TICK']              = row.tick;
                    arr['TICK_ID']           = tick_id;
                    arr['OWNER']             = (row.transfer) ? row.transfer : row.owner;
                    arr['MAX_SUPPLY']        = row.max_supply;
                    arr['MAX_MINT']          = row.max_mint;
                    // Force decimal precision to a integer value
                    arr['DECIMALS']          = (!this.util.isNull(row.decimals)) ? parseInt(row.decimals) : 0;
                    arr['DESCRIPTION']       = row.description;
                    arr['LOCK_MAX_SUPPLY']   = row.lock_max_supply;
                    arr['LOCK_MINT_SUPPLY']  = row.lock_mint_supply;
                    arr['LOCK_MINT']         = row.lock_mint;
                    arr['LOCK_MAX_MINT']     = row.lock_max_mint;
                    arr['LOCK_DESCRIPTION']  = row.lock_description;
                    arr['LOCK_SLEEP']        = row.lock_sleep;
                    arr['LOCK_CALLBACK']     = row.lock_callback;
                    arr['CALLBACK_TICK']     = row.callback_tick;
                    arr['CALLBACK_BLOCK']    = row.callback_block;
                    arr['CALLBACK_AMOUNT']   = row.callback_amount;
                    arr['ALLOW_LIST']        = row.allow_list;
                    arr['BLOCK_LIST']        = row.block_list;
                    arr['MINT_ADDRESS_MAX']  = row.mint_address_max;
                    arr['MINT_START_BLOCK']  = row.mint_start_block;
                    arr['MINT_STOP_BLOCK']   = row.mint_stop_block;
                    // build out token state
                    // TODO: will need to massage the data a bit more to build out accurate token state... this is quick and dirty
                    for(let key in arr){
                        let value = arr[key];
                        // Only set the ACTION_INDEX on the first valid issuance
                        if(key=='ACTION_INDEX' && this.util.isNull(data[key]))
                            data[key] = value;
                        // Disallow unsetting of LOCK flags
                        if(String(key).substr(0,5)=='LOCK_')
                            if(data[key]==1)
                                continue;
                        // Prevent changing decimal precision 
                        if(key=='DECIMALS' && data[key] > value)
                            continue;
                        // Skip setting value if value is null or empty (use last explicit value)
                        if(this.util.isNull(value) || value==='')
                            continue;
                        // Update data object with value from this ISSUE tx
                        data[key] = value;
                    }
                }
            }
        }
        // Get token supply at the given action_index
        if(data)
            data['SUPPLY'] = await this.getTokenSupply(tick, block_index, action_index); 
        return data;
    }

    // Handle getting decimal precision for a given tick_id
    async getTokenDecimalPrecision(tick_id){
        let decimals = 0;
        // Lookup decimal precision using the issues table 
        // DO NOT lookup precision using getTokenInfo() (avoid recursive queries)
        let query = `SELECT
                        i.decimals
                    FROM
                        issues i,
                        index_statuses s
                    WHERE
                        i.status_id=s.id AND
                        i.tick_id=? AND
                        s.status='valid'`;
        let results = await this.doQuery(query, [tick_id]);
        if(results.length > 0){
            // Loop through ISSUE transactions for the given ticker
            for(let row of results){
                if(!this.util.isNull(row.decimals) && row.decimals > decimals)
                    decimals = row.decimals;
            }
        }
        // Clamp decimals to valid range [0, 18] to prevent SQL injection via DECIMAL CAST
        decimals = Math.max(0, Math.min(18, parseInt(decimals) || 0));
        return decimals;
    }

    // Get token supply from credits/debits table (credits - debits + escrows = supply)
    // @param {tick}            string  Ticker name
    // @param {block_index}     integer Block Index 
    // @param {action_index}    integer action_index of action
    async getTokenSupply(tick, block_index, action_index){
        let credits = 0;
        let debits  = 0;
        let escrows = 0;
        let supply  = 0;
        let sql     = '',
            query   = '',
            args    = [],
            results = null,
            tick_id = await this.createTicker(tick);
        // Get info on decimal precision
        let decimals = await this.getTokenDecimalPrecision(tick_id);
        // Add tick_id to SQL query arguments
        args.push(tick_id);
        // Scope by the ACTION's own block_index (a.block_index), NOT by joining transactions
        // on tx_index. Protocol-generated / synthetic actions (ORDER_MATCH, *_EXPIRE, VOTE v2,
        // the UNSTAKE v2 cooldown completion, etc.) carry tx_index = NULL with no transactions
        // row, so the old `INNER JOIN transactions` silently dropped their ledger effects from
        // this supply sum. That stayed invisible only while every synthetic effect was net-zero
        // on supply (matched credit+debit / escrow release); the UNSTAKE v2 completion is the
        // first synthetic NET-MINT credit, so it exposed the gap as a balances>ledger SanityError.
        // Mirrors the identical fix in getBlockHashes. actions.block_index is set for every row.
        if(!this.util.isNull(block_index) && this.util.isNumeric(block_index)){
            sql += " AND a.block_index <= ?";
            args.push(parseInt(block_index));
        }
        // If a action_index was given, only lookup tokens created before given action_index
        if(!this.util.isNull(action_index) && this.util.isNumeric(action_index)){
            sql += " AND m.action_index < ?";
            args.push(parseInt(action_index));
        }
        // Each component is summed EXACTLY (18 dp) and the combination is rounded
        // ONCE at the tick's own scale. Rounding each component first
        // and then combining is not the same number: round(C) - round(D) + round(E)
        // can differ from round(C - D + E) by a whole unit when the ledger carries
        // amounts finer than the tick (fees at 8 dp against a 0-decimal gas tick),
        // and the balances-side projection in sanityCheck rounds only once, so a
        // per-component rounding here forks the two sides into a SanityError.
        // On rows written before the exact-ledger flag-day every amount is already
        // an exact multiple of 10^-decimals, so this is value-identical to the old
        // per-row SUM(CAST(m.amount AS DECIMAL(60,decimals))).
        let sumExpr = ledgerPrecision.exactSumSql('m.amount');
        // Get Credits
        query = `SELECT
                    ` + sumExpr + ` as credits
                FROM
                    credits m
                    INNER JOIN actions a ON (a.action_index=m.action_index)
                WHERE
                    m.tick_id=?` + sql;
        results = await this.doQuery(query, args);
        if(results.length > 0 && !this.util.isNull(results[0].credits))
            credits = results[0].credits;
        // Get Debits
        query = `SELECT
                    ` + sumExpr + ` as debits
                FROM
                    debits m
                    INNER JOIN actions a ON (a.action_index=m.action_index)
                WHERE
                    m.tick_id=?` + sql;
        results = await this.doQuery(query, args);
        if(results.length > 0 && !this.util.isNull(results[0].debits))
            debits = results[0].debits;
        // Get Escrows
        query = `SELECT
                    ` + sumExpr + ` as escrows
                FROM
                    escrows m
                    INNER JOIN actions a ON (a.action_index=m.action_index)
                WHERE
                    m.tick_id=?` + sql;
        results = await this.doQuery(query, args);
        if(results.length > 0 && !this.util.isNull(results[0].escrows))
            escrows = results[0].escrows;
        // Determine total supply ((credits - debits) + escrows), rounded once.
        let exact = ledgerPrecision.LEDGER_AMOUNT_PRECISION;
        supply = this.util.bcadd(this.util.bcsub(credits, debits, exact), escrows, decimals);
        return supply;
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

    // Get token supply for a given ticker from balances table
    async getTokenSupplyBalance(tick){
        let supply   = 0;
        let tick_id  = await this.createTicker(tick);
        let decimals = await this.getTokenDecimalPrecision(tick_id);
        let query = `SELECT SUM(CAST(amount AS DECIMAL(60, ` + decimals + `))) as supply FROM balances WHERE tick_id=? LIMIT 1`;
        let results = await this.doQuery(query, [tick_id]);
        if(results.length > 0 && !this.util.isNull(results[0].supply))
            supply = results[0].supply;
        return supply;
    }

    // Get escrowed token supply for a given ticker from escrows table
    async getTokenSupplyEscrow(tick){
        let supply   = 0;
        let tick_id  = await this.createTicker(tick);
        let decimals = await this.getTokenDecimalPrecision(tick_id);
        let query = `SELECT SUM(CAST(amount AS DECIMAL(60, ` + decimals + `))) as supply FROM escrows WHERE tick_id=? LIMIT 1`;
        let results = await this.doQuery(query, [tick_id]);
        if(results.length > 0 && !this.util.isNull(results[0].supply))
            supply = results[0].supply;
        return supply;
    }


    // Handle getting a list of TICK holders and amounts
    // @param {tick}            string  Ticker name
    // @param {block_index}     integer Block Index 
    // @param {action_index}    integer action_index of action
    // TODO: Add support for 'escrowed' tokens (dispensers, orders, bets)
    // TODO(j-dog): Can optimize this function to allow getting list of holders from balances table instead of credits/debits
    async getHolders(tick, block_index, action_index){
        let holders = {};
        let sql     = '',
            query   = '',
            results = null,
            args    = [],
            tick_id = null;
        // Get the tick_id for the given ticker
        if(!this.util.isNull(tick) && this.util.isNull(tick_id))
            tick_id = await this.createTicker(tick);
        // NOTE: the tick's decimal precision is no longer read here. Holder
        // balances are netted at the exact ledger scale (below), so the lookup
        // was a wasted round-trip per call.
        // Add tick_id to SQL query arguments
        args.push(tick_id);
        // If a block_index was given, only lookup tokens created before or in given block_index
        if(!this.util.isNull(block_index) && this.util.isNumeric(block_index)){
            sql += " AND a1.block_index <= ?";
            args.push(parseInt(block_index));
        }
        // If a action_index was given, only lookup tokens created before given action_index
        if(!this.util.isNull(action_index) && this.util.isNumeric(action_index)){
            sql += " AND m.action_index < ?";
            args.push(parseInt(action_index));
        }
        // Per-holder credits and debits are summed EXACTLY (18 dp) and netted at
        // that scale, matching getAddressBalances / getNetBalance. The
        // former per-row cast to the tick's scale made sum-of-rounded-holdings
        // drift from the rounded ledger sum as soon as any row was finer than the
        // tick; on pre-flag-day rows (already on the tick's grid) it is identical.
        let holderSumExpr = ledgerPrecision.exactSumSql('m.amount');
        let exact         = ledgerPrecision.LEDGER_AMOUNT_PRECISION;
        // Get Credits
        query = `SELECT
                    ` + holderSumExpr + ` as credits,
                    a2.address
                FROM 
                    credits m
                    INNER JOIN actions         a1 ON (a1.action_index=m.action_index)
                    INNER JOIN index_addresses a2 ON (a2.id=m.address_id)
                WHERE 
                    m.tick_id=?` + sql + `
                GROUP BY a2.address`;
        results = await this.doQuery(query, args);
        if(results.length > 0)
            for(let row of results)
                holders[row.address] = row.credits;
        // Get Debits
        query = `SELECT
                    ` + holderSumExpr + ` as debits,
                    a2.address
                FROM 
                    debits m
                    INNER JOIN actions         a1 ON (a1.action_index=m.action_index)
                    INNER JOIN index_addresses a2 ON (a2.id=m.address_id)
                WHERE 
                    m.tick_id=?` + sql + `
                GROUP BY a2.address`;
        results = await this.doQuery(query, args);
        if(results.length > 0){
            for(let row of results){
                let balance = this.util.bcsub(holders[row.address], row.debits, exact);
                if(this.util.bcgt(balance, 0))
                    holders[row.address] = balance;
                else
                   delete holders[row.address];
            }
        }
        // Sort holders list from biggest to smallest. Equal balances fall back to a
        // lexicographic address tiebreak so the iteration order is deterministic across
        // nodes - the GROUP BY queries above carry no ORDER BY, so equal-balance holders
        // would otherwise iterate in engine-arbitrary order, forking the DIVIDEND/AIRDROP/
        // CALLBACK credit INSERT sequence (and therefore the ledger hash) across validators.
        holders = Object.fromEntries(Object.entries(holders).sort(([addrA, a], [addrB, b]) => {
            if(this.util.bcgt(b, a)) return  1;
            if(this.util.bclt(b, a)) return -1;
            return addrA < addrB ? -1 : addrA > addrB ? 1 : 0;
        }));
        return holders;
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

    // Return a list type given a tx_hash
    async getListType(action_index){
        let type  = false;
        if(!this.util.isNull(action_index) && this.util.isNumeric(action_index)){
            let query = "SELECT type FROM lists WHERE action_index=? LIMIT 1";
            let args  = [action_index];
            let results = await this.doQuery(query, args);
            if(results.length > 0)
                type = parseInt(results[0].type);

        }
        return type;
    }

    // Whether the LIST edit-chain resolution is in effect at `block_index`
    // on this indexer's chain. Wrapper so action handlers gate on the same
    // predicate getList uses without re-deriving network/coin.
    // @param {block_index}  integer  block being processed
    isListEditResolutionActive(block_index){
        return listEditResolution.isListEditResolutionActive(block_index, this.config['NETWORK'], this.config['COIN']);
    }

    // Walk a LIST reference up to the CREATE action that roots its edit chain.
    // An edit row carries the index of the list it edits in lists.list_action_index;
    // a create row carries NULL. Post-flag-day list.js normalizes every edit to
    // point straight at the root, so this is a single hop in practice; the bounded
    // loop covers legacy rows that named another edit (and can never spin on a
    // cycle, which a malformed chain could otherwise produce).
    // @param {action_index}  integer  ACTION_INDEX of any LIST create or edit
    async getListRootIndex(action_index){
        let root = action_index;
        let seen = {};
        for(let hop = 0; hop < 16; hop++){
            if(seen[String(root)]) break;
            seen[String(root)] = true;
            let rows = await this.doQuery("SELECT list_action_index FROM lists WHERE action_index=? LIMIT 1", [root]);
            if(rows.length == 0) break;
            let parent = rows[0]['list_action_index'];
            if(this.util.isNull(parent)) break;
            root = parent;
        }
        return root;
    }

    // Resolve a LIST reference to the action whose list_items rows ARE the list's
    // CURRENT membership: the newest VALID action in its edit chain, or the create
    // itself when it has no valid edits. Every valid edit persists a COMPLETE
    // membership snapshot (list.js splices the final item array and writes all of
    // it), so the head's rows are the whole list, never a delta. Ordering is by
    // action_index DESC, a total order (action_index is unique and monotonic), so
    // independently-built nodes resolve the same head. Invalid edits are excluded:
    // they write no list_items rows at all, so picking one would empty the list.
    // @param {action_index}  integer  ACTION_INDEX of any LIST create or edit
    async getListHeadIndex(action_index){
        let root = await this.getListRootIndex(action_index);
        let query = `SELECT
                        l.action_index
                    FROM
                        lists l
                        INNER JOIN index_statuses s ON (s.id=l.status_id)
                    WHERE
                        l.list_action_index=?
                        AND s.status='valid'
                    ORDER BY l.action_index DESC
                    LIMIT 1`;
        let rows = await this.doQuery(query, [root]);
        return (rows.length > 0) ? rows[0]['action_index'] : root;
    }

    // Return a list given a tx_hash
    // @param {action_index}  integer  ACTION_INDEX of a LIST (as pinned by consumers)
    // @param {block_index}   integer  block being processed; gates edit resolution
    async getList(action_index, block_index){
        let type = await this.getListType(action_index);
        let list = [];
        if(type){
            // a LIST edit writes its resulting items under the EDIT's own
            // action_index and never touches the parent's rows, so reading the
            // pinned (create) index returned create-time membership forever and
            // on-chain lists were immutable. Resolve the edit chain's head
            // instead. Flag-day gated per chain (list_edit_resolution_activation.js)
            // because it changes which actions the allow/block gates accept, hence
            // historical replay; below the height (or with no block context) the
            // legacy create-index read runs unchanged.
            let resolved = action_index;
            if(listEditResolution.isListEditResolutionActive(block_index, this.config['NETWORK'], this.config['COIN']))
                resolved = await this.getListHeadIndex(action_index);
            let query = '';
            let args  = [resolved];
            // CONSENSUS: list_items has no ORDER BY on the AUTO_INCREMENT insert
            // order, so the row order MariaDB returns is engine/plan-arbitrary. The
            // consuming AIRDROP recipient loop (airdrop.js) builds credits in this
            // order, so an unordered list makes the credit-insert order (and any
            // order-sensitive step) diverge across independently-built nodes. Pin a
            // deterministic total order on the resolved item string with a BINARY
            // collation, mirroring the getHolders/getBlockHashes hardening
            // (index_addresses is utf8_general_ci = case/accent-folding). Duplicate
            // items resolve to byte-identical strings, so the ordering is total for
            // consensus purposes (a tie is byte-identical and the consumer dedups).
            // Left UNGATED, mirroring getHolders' own ungated sort: the ledger hash is
            // invariant to this order because getBlockHashes re-sorts credits on the
            // resolved (address, tick, amount) columns and never hashes a surrogate
            // id, so ordered and unordered produce byte-identical block hashes; this
            // removes the engine-order dependency at the source (3c05dcb9).
            if(type==1){
                query = `SELECT
                            t.tick as item
                        FROM
                            list_items l
                            INNER JOIN index_tickers t ON (l.item_id=t.id)
                        WHERE
                            l.action_index=?
                        ORDER BY t.tick COLLATE utf8mb4_bin ASC`;
            }
            if(type==2){
                query = `SELECT
                            a.address as item
                        FROM
                            list_items l
                            INNER JOIN index_addresses a ON (l.item_id=a.id)
                        WHERE
                            l.action_index=?
                        ORDER BY a.address COLLATE utf8_bin ASC`;
            }
            let results = await this.doQuery(query, args);
            if(results.length > 0)
                for(let row of results)
                    list.push(row['item']);
        }
        return list;
    }

    // Create record in `lists` table
    async createList(data){
        data                  = this.normalizeDataValues(data);
        let action_index      = data['ACTION_INDEX'];
        let status_id         = await this.createStatus(data['STATUS']);
        let list_type         = data['TYPE'];
        let list_edit         = data['EDIT'];
        let list_action_index = data['LIST_ACTION_INDEX'];
        // LIST carries an optional MEMO like every other action; createMemo returns
        // NULL for an absent one, which is also what a pre-MEMO list row holds, so
        // the two are indistinguishable and there is nothing to backfill.
        let memo_id           = await this.createMemo(data['MEMO']);
        // Check if record already exists for this token
        let query  = "SELECT action_index FROM lists WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                            lists
                        SET
                            type=?,
                            edit=?,
                            list_action_index=?,
                            memo_id=?,
                            status_id=?
                        WHERE
                            action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO lists (type, edit, list_action_index, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?)`;
        }
        args    = [list_type, list_edit, list_action_index, memo_id, status_id, action_index];
        results = await this.doQuery(query, args);
    }

    // Lookup a record in the `index_statuses` table and return record id
    async getStatusId(status){
        let id    = null;
        let query = "SELECT id FROM index_statuses WHERE status=? LIMIT 1";
        let results = await this.doQuery(query, [status]);
        if(results.length > 0)
            id = Number(results[0].id);
        return id;
    }

    // Create records in the 'index_statuses' table and return record id
    async createStatus(status){
        // Ignore empty status and return NULL
        if(this.util.isNull(status))
            return null;
        var id = await this.getStatusId(status);
        // Handle creating record
        if(id==null){
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index.
            let query = "INSERT IGNORE INTO index_statuses (status) values (?)";
            await this.doQuery(query, [status]);
            id = await this.getStatusId(status);
        }
        return id;
    }

    // Create/Update record in `issues` table
    async createIssue(data){
        data                   = this.normalizeDataValues(data);
        let action_index       = data['ACTION_INDEX'];
        let description        = data['DESCRIPTION'];
        let max_supply         = data['MAX_SUPPLY'];
        let max_mint           = data['MAX_MINT'];
        let mint_supply        = data['MINT_SUPPLY'];
        let mint_address_max   = data['MINT_ADDRESS_MAX'];
        let mint_start_block   = data['MINT_START_BLOCK'];
        let mint_stop_block    = data['MINT_STOP_BLOCK'];
        let decimals           = data['DECIMALS'];
        let status             = data['STATUS'];
        let lock_max_supply    = data['LOCK_MAX_SUPPLY'];
        let lock_mint          = data['LOCK_MINT'];
        let lock_mint_supply   = data['LOCK_MINT_SUPPLY'];
        let lock_max_mint      = data['LOCK_MAX_MINT'];
        let lock_description   = data['LOCK_DESCRIPTION'];
        let lock_sleep         = data['LOCK_SLEEP'];
        let lock_callback      = data['LOCK_CALLBACK'];
        let callback_block     = data['CALLBACK_BLOCK'];
        let callback_amount    = data['CALLBACK_AMOUNT'];
        let allow_list         = data['ALLOW_LIST'];
        let block_list         = data['BLOCK_LIST'];
        let callback_tick_id   = await this.createTicker(data['CALLBACK_TICK']);
        let tick_id            = await this.createTicker(data['TICK']);
        let transfer_id        = await this.createAddress(data['TRANSFER']);
        let transfer_supply_id = await this.createAddress(data['TRANSFER_SUPPLY']);
        let memo_id            = await this.createMemo(data['MEMO']);
        let status_id          = await this.createStatus(data['STATUS']);
        // Check if record already exists for this ISSUE action
        let query = `SELECT action_index FROM issues WHERE action_index=?`;
        let args  = [action_index]
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        issues
                    SET
                        tick_id=?,
                        max_supply=?,
                        max_mint=?,
                        decimals=?,
                        description=?,
                        mint_supply=?,
                        transfer_id=?,
                        transfer_supply_id=?,
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
                        memo_id=?,
                        status_id=?
                    WHERE
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO issues (
                        tick_id, 
                        max_supply, 
                        max_mint, 
                        decimals, 
                        description, 
                        mint_supply, 
                        transfer_id, 
                        transfer_supply_id, 
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
                        memo_id,
                        status_id,
                        action_index
                    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        }
        args    = [tick_id, max_supply, max_mint, decimals, description, mint_supply, transfer_id, transfer_supply_id, lock_max_supply, lock_mint, lock_mint_supply, lock_max_mint, lock_description, lock_sleep, lock_callback, callback_block, callback_tick_id, callback_amount, allow_list, block_list, mint_address_max, mint_start_block, mint_stop_block, memo_id, status_id, action_index ];
        results = await this.doQuery(query, args);
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
                        supply=?,
                        owner_id=?,
                        last_action_index=?
                    WHERE
                        tick_id=?`;
            args = [max_supply, max_mint, decimals, description, lock_max_supply, lock_mint, lock_mint_supply, lock_max_mint,lock_description, lock_sleep, lock_callback, callback_block, callback_tick_id, callback_amount, allow_list, block_list, mint_address_max, mint_start_block, mint_stop_block, supply, owner_id, action_index, tick_id];
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
                        supply,
                        owner_id,
                        action_index,
                        last_action_index,
                        tick_id
                    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            args    = [max_supply, max_mint, decimals, description, lock_max_supply, lock_mint, lock_mint_supply, lock_max_mint,lock_description, lock_sleep, lock_callback, callback_block, callback_tick_id, callback_amount, allow_list, block_list, mint_address_max, mint_start_block, mint_stop_block, supply, owner_id, action_index, action_index, tick_id];
        }
        results = await this.doQuery(query, args);

    }

    // Create / Update ledger change records (credits / debits / escrows)
    async createLedgerChangeRecord(table, action_index, tick, amount, address){
        // Whitelist valid ledger table names to prevent SQL injection
        const VALID_LEDGER_TABLES = ['credits', 'debits', 'escrows'];
        if(!VALID_LEDGER_TABLES.includes(table))
            throw new Error('Invalid ledger table: ' + table);
        let tick_id    = await this.createTicker(tick);
        let address_id = await this.createAddress(address);
        // Light-client SMT touched-key accumulation (SPV spec §4). Record the
        // (address, CANONICAL tick name) identity actually mutated this block so
        // stateCommitment updates the right balance leaf. The `tick` argument may
        // be a NAME or a "^TICK_ID" reference, and NAME refs resolve case-
        // insensitively, but the SMT balance leaf is keyed by the canonical stored
        // name: capturing the raw, unresolved tick let ^id / case-variant sends
        // silently miss their leaf (incremental balances_root drift). Resolve
        // through tick_id first. Capturing at this single ledger choke point is
        // robust to backdated cooldown-refund credits (which reuse an EARLIER
        // block's action_index, so a block-range query would miss them). Active
        // only while the indexer has installed a per-block set.
        // BOTH axes must be canonical, and for a long time only the tick one was
        // The address argument has the SAME hazards the tick argument
        // has: getAddressId accepts a wire "^<id>" reference and resolves it to a
        // row whose stored `address` is the real address, so a handler passing
        // "^123" wrote a correct credit row and then recorded the touched key as
        // the literal "^123".
        //
        // What that costs is not a wrong leaf, it is NO leaf and no error:
        // getNetBalance('^123', tick) joins index_addresses.address = '^123',
        // matches nothing, returns 0, and _leafOrNull turns 0 into null, which
        // makes stateCommitment DELETE a key that never existed. The update is a
        // no-op, balances_root does not move for that block, and the real
        // address's leaf is simply never written. On BTC regtest that presented
        // as 15 of 1531 ledger-changing blocks committing a byte-identical
        // balances_root to their predecessor, and a key was lost permanently
        // only when no later block happened to touch it again.
        if(this._smtTouched && address != null && tick_id != null && address_id != null){
            let canonTick = await this._smtTickName(tick_id);
            let canonAddr = await this._smtAddressName(address_id);
            if(canonTick != null && canonTick !== '' && canonAddr != null && canonAddr !== '')
                this._smtTouched.add(canonAddr + '\t' + canonTick);
        }
        // Quantize the amount before storing.
        //
        // LEGACY rule: round to the TICK's own decimal precision. That kept the
        // stored row on the same grid the supply projections rounded to, which is
        // why it stopped the SanityError, but it also OVERCHARGED every fee finer
        // than the gas tick can express: fees are computed at 8 dp, so a 0.5 XCHAIN
        // fee against a decimals=0 XCHAIN was recorded as 0.5 in `fees` and debited
        // as 1, and a 51-sub-command batch spent 51 rather than 25.5.
        //
        // EXACT rule (flag-day, ledger_amount_precision_activation.js): store the
        // amount at 18 dp, i.e. exactly, and let the projections round ONCE. The
        // aggregation sites below (getTokenSupply / getHolders / sanityCheck /
        // getAddressCreditDebit) sum at 18 dp and round once at the tick's scale,
        // so ledger, balances+escrows and tokens.supply still agree; see that
        // module for why round(C)-round(D)+round(E) != round(C-D+E) is the whole
        // reason the legacy write-side rounding was load-bearing.
        let decimals = ledgerPrecision.ledgerWriteScale(
            await this.getTokenDecimalPrecision(tick_id),
            this.blockIndex, this.config['NETWORK'], this.config['COIN']);
        amount = this.util.bcadd(amount, 0, decimals);
        // Convert any BigNumber amount to a plain decimal string before inserting.
        // Must be normal notation: String() renders sub-1e-7 amounts exponentially
        // ("3e-8"), which the SMT leaf encoder rejects at parse time (block wedge).
        amount = this.util.bcstr(amount);
        // Check if record already exists for this token
        let query = `SELECT
                        action_index
                    FROM
                        ` + table + `
                    WHERE
                        action_index=? AND
                        address_id=? AND 
                        tick_id=?`;
        let exists = false;
        let args    = [action_index, address_id, tick_id];
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        ` + table + `
                    SET
                        amount=?
                    WHERE 
                        action_index=? AND
                        address_id=? AND 
                        tick_id=?`;
        } else {
            // INSERT record
            query = `INSERT INTO ` + table + ` (amount, action_index, address_id, tick_id) values (?, ?, ?, ?)`;
        }
        args    = [amount, action_index, address_id, tick_id];
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

    // Handle updating address balances (credits-debits=balance)
    // @param {address}  boolean Full update
    // @param {address}  string  Address string
    // @param {address}  array   Array of address strings
    // @param {rollback} boolean Rollback
    async updateBalances(address, rollback){
        let addrs = [];
        let type  = typeof address;
        // Handle arrays and objects
        if(type==='object'){
            for(let addr of address){
                if(!this.util.isNull(addr) && addr!='')
                    addrs.push(addr);
            }
        }
        if(type==='string')
            addrs.push(address);
        // Dump full list of addresses
        if(type==='boolean' && address===true){
            console.log('Updating all balances...');
            let query = "SELECT address FROM index_addresses";
            let results = await this.doQuery(query);
            if(results.length > 0)
                for(let row of results)
                    addrs.push(row.address);
        }
        // Loop through addresses and update balances SERIALLY. During block
        // processing these run on the single shared transaction connection
        // (getConnection() returns this.transactionConnection mid-transaction),
        // which cannot serve concurrent queries - a Promise.all here interleaves
        // each address's read-compute-write and corrupts balances (observed:
        // AIRDROP double-counted token supply, 200 != 100, tripping the supply
        // sanity check and crash-looping the indexer). The N+1->UPSERT win in
        // updateAddressBalance still applies; only the parallelism is unsafe.
        for(const addr of addrs)
            await this.updateAddressBalance(addr, rollback);
    }

    // Create/Update/Delete records in the 'balances' table
    async updateAddressBalance(address, rollback){
        let type        = typeof address;
        let address_id  = null;
        let balance     = 0;
        let old_balance = 0;
        let query       = false;
        let results     = null;
        if(type==='number' && this.util.isNumeric(address))
            address_id = address;
        if(type==='string')
            address_id = await this.createAddress(address);
        // Get list of address balances based on credits/debits tables
        let balances = await this.getAddressBalances(address_id);
        // Get list of address balances based on balances table. Only the rollback
        // branch below reads this, so skip the query entirely on the forward path:
        // it is one wasted round-trip per touched address per action, and fan-out
        // actions (DIVIDEND / AIRDROP) run this loop once per holder. Keep the read
        // HERE rather than inside the rollback branch, since it must observe the
        // balances table BEFORE the UPSERT/DELETE loop rewrites it.
        let old_balances = (rollback) ? await this.getAddressTableBalances(address_id) : {};
        // Handle updating any current balances based on credits/debits table records
        for(let tick_id in balances){
            balance = balances[tick_id];
            let args = [];
            if(balance==0){
                query = "DELETE FROM balances WHERE address_id=? AND tick_id=?";
                args.push(address_id, tick_id);
            } else {
                // Convert BigNumber to a plain decimal string so the mariadb driver
                // serializes it correctly. Normal notation is required: String()
                // renders sub-1e-7 balances exponentially ("3e-8"), which the SMT
                // leaf encoder rejects (block wedge) and drifts the byte-form vs sync.
                balance = this.util.bcstr(balance);
                query = "INSERT INTO balances (tick_id, address_id, amount) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE amount = VALUES(amount)";
                args.push(tick_id, address_id, balance);
            }
            results = await this.doQuery(query, args);
        }
        // If this is a rollback, then handle detecting records in balances table which should not exist and delete them
        // TODO: Test this code a bit better with various random rollbacks and verify all is working without any sanity check issues
        if(rollback){
            for(let tick_id in old_balances){
                old_balance = old_balances[tick_id];
                balance     = balances[tick_id];
                if(!this.util.isNull(old_balance) && (this.util.isNull(balance) || balance==0 )){
                    query   = "DELETE FROM balances WHERE address_id=? AND tick_id=?";
                    results = await this.doQuery(query, [address_id, tick_id]);
                }
            }
        }
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

    // Get address balances using balances table data
    async getAddressTableBalances(address){
        let type       = typeof address;
        let address_id = null;
        let balances   = {}; // Object to store tick/balance
        if(type==='number' && this.util.isNumeric(address))
            address_id = address;
        if(type==='string')
            address_id = await this.createAddress(address);
        let query = "SELECT tick_id, amount FROM balances WHERE address_id=?";
        let results = await this.doQuery(query, [address_id]);
        if(results.length > 0)
            for(let row of results)
                balances[row.tick_id] = row.amount;
        return balances;
    }

    // Handle getting credits or debits records for a given address
    async getAddressCreditDebit(table, address, action, block_index, action_index){
        let data       = [];
        let type       = typeof address;
        let address_id = null;
        if(type==='number' && this.util.isNumeric(address))
            address_id = address;
        if(type==='string')
            address_id = await this.createAddress(address);
        let sql  = '';
        let args = [address_id];
        // Query using either block_index OR action_index
        if(!this.util.isNull(action_index) && this.util.isNumeric(action_index)){
            sql += " AND m.action_index < ?";
            args.push(action_index);
        } else if(!this.util.isNull(block_index) && this.util.isNumeric(block_index)){
            sql += " AND t1.block_index < ?";
            args.push(block_index);
        }
        // Support querying using action
        if(!this.util.isNull(action)){
            let action_id  = await this.createAction(action);
            sql += " AND a1.action_id=?";
            args.push(action_id);
        }
        if(['credits','debits'].indexOf(table) != -1){
            let query = `SELECT 
                    m.tick_id,
                    m.amount,
                    t2.decimals
                FROM
                    ` + table + ` m
                    INNER JOIN actions       a1 ON (a1.action_index=m.action_index)
                    LEFT  JOIN transactions  t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN tokens        t2 ON (t2.tick_id=m.tick_id)
                    INNER JOIN index_actions a2 ON (a2.id=a1.action_id)
                WHERE 
                    m.address_id=?` + sql;
            let results = await this.doQuery(query, args);
            if(results.length > 0){
                for(let row of results){
                    if(!data[row.tick_id])
                        data[row.tick_id] = 0;
                    // Accumulate at the exact ledger scale, NOT the tick's own
                    // decimals. Rounding the RUNNING TOTAL per row is
                    // what made a 0.5-XCHAIN fee meter as a whole unit against a
                    // decimals=0 gas tick, and it compounds: 51 rows of 0.5 came
                    // out as 51, not 25.5. Rows written before the exact-ledger
                    // flag-day are already exact multiples of 10^-decimals, so
                    // this is value-identical for them.
                    data[row.tick_id] = this.util.bcadd(
                        data[row.tick_id], row.amount, ledgerPrecision.LEDGER_AMOUNT_PRECISION);
                }
            }
        }
        return data;
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

    // Return the tick associated with an ISSUE action_index, or null if the
    // action_index does not resolve to a valid ISSUE. Used by LINK to decide
    // whether a linked action is targeting a TICK (and thus subject to the
    // owner / ownership-escrow rules).
    async getIssueTick(action_index){
        let query = `SELECT
                        t.tick
                    FROM
                        issues i
                        INNER JOIN index_tickers t ON (t.id=i.tick_id)
                        INNER JOIN index_statuses s ON (s.id=i.status_id)
                    WHERE
                        i.action_index=? AND
                        s.status='valid'
                    LIMIT 1`;
        let results = await this.doQuery(query, [action_index]);
        if(results.length > 0)
            return results[0].tick;
        return null;
    }

    // Get action_index of the first valid ISSUE action for a given ticker
    async getFirstIssueActionIndex(tick){
        let tick_id      = await this.createTicker(tick);
        let action_index = false;
        let query = `SELECT 
                        i.action_index 
                    FROM
                        issues i
                        INNER JOIN index_statuses s ON (s.id=i.status_id)
                    WHERE 
                        i.tick_id=? AND 
                        s.status='valid'
                    ORDER BY 
                        action_index ASC 
                    LIMIT 1`;
        let args = [tick_id];
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            action_index = Number(results[0].action_index);
        return action_index;
    }

    // Validate if a ticker exists before before a given action_index
    async validTickerBeforeTxIndex(tick, action_index){
        let issue_index = await this.getFirstIssueActionIndex(tick);
        if(issue_index !== false && issue_index < action_index)
            return true;
        return false;
    }

    // Validate if ADDRESS is in SLEEP mode
    async isAddressSleeping(address, block_index){
        let sleep = false;
        if(!this.util.isNull(address) && this.util.isCryptoAddress(address) && !this.util.isNull(block_index) && this.util.isNumeric(block_index)){
            let id    = await this.createAddress(address);
            let query = `SELECT 
                            s1.resume_block 
                        FROM 
                            sleeps s1
                            INNER JOIN actions        a1 ON (a1.action_index=s1.action_index)
                            INNER JOIN transactions   t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN index_statuses s2 ON (s2.id=s1.status_id)
                        WHERE 
                            s1.type=? AND
                            t1.source_id=? AND
                            s2.status=?
                        ORDER BY 
                            s1.action_index DESC
                        LIMIT 1`;
            let args = [1, id, 'valid'];
            let results = await this.doQuery(query, args);
            if(results.length > 0){
                let resume_block = Number(results[0].resume_block);
                if(resume_block ==  -1 || resume_block > block_index)
                    sleep = true;
            }
        }
        return sleep;
    }

    // Validate if TICK is in SLEEP mode
    async isTickSleeping(tick, block_index){
        let sleep = false;
        if(!this.util.isNull(tick) && !this.util.isNull(block_index) && this.util.isNumeric(block_index)){
            let id    = await this.createTicker(tick);
            let query = `SELECT 
                            s1.resume_block 
                        FROM 
                            sleeps s1
                            INNER JOIN index_statuses s2 ON (s2.id=s1.status_id)
                        WHERE 
                            s1.type=? AND
                            s1.tick_id=? AND
                            s2.status=?
                        ORDER BY 
                            s1.action_index DESC
                        LIMIT 1`;
            let args = [2, id, 'valid'];
            let results = await this.doQuery(query, args);
            if(results.length > 0){
                let resume_block = Number(results[0].resume_block);
                if(resume_block ==  -1 || resume_block > block_index)
                    sleep = true;
            }
        }
        return sleep;
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

    // Get total amount SELF-MINTED (valid MINT actions authored by `address`) for a ticker
    // before `action_index`. Unlike getActionCreditDebitAmount('credits','MINT',...), which
    // also counts MINT credits the address merely received as another mint's DESTINATION,
    // this measures the mints table by the action's source, so only mints the address
    // itself authored count toward MINT_ADDRESS_MAX (MINT_SELF_MINTED_ONLY flag-day).
    async getSelfMintedAmount(tick, address, action_index){
        let total   = 0;
        let tick_id = await this.createTicker(tick);
        let addr_id = await this.createAddress(address);
        let query = `SELECT
                m1.amount,
                t2.decimals
            FROM
                mints m1
                INNER JOIN actions        a1 ON (a1.action_index=m1.action_index)
                INNER JOIN tokens         t2 ON (t2.tick_id=m1.tick_id)
                INNER JOIN index_statuses s1 ON (s1.id=m1.status_id)
            WHERE
                m1.tick_id=? AND a1.source_id=? AND s1.status='valid' AND m1.action_index < ?`;
        let results = await this.doQuery(query, [tick_id, addr_id, action_index]);
        for(let row of results)
            total = this.util.bcadd(total, row.amount, row.decimals);
        return total;
    }

    // Lookup a record in the `index_memos` table and return record id
    async getMemoId(memo){
        let id    = null;
        let query = "SELECT id FROM index_memos WHERE memo=? LIMIT 1";
        let results = await this.doQuery(query, [memo]);
        if(results.length > 0)
            id = Number(results[0].id);
        return id;
    }

    // Create records in the 'index_memos' table and return record id
    async createMemo(memo){
        // Ignore empty memo and return NULL
        if(this.util.isNull(memo))
            return null;
        // Truncate memos to 250 characters
        memo = String(memo).substring(0,250);
        var id = await this.getMemoId(memo);
        // Handle creating record
        if(id==null){
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index.
            let query = "INSERT IGNORE INTO index_memos (memo) values (?)";
            await this.doQuery(query, [memo]);
            id = await this.getMemoId(memo);
        }
        return id;
    }

    // Create/Update record in `mints` table
    async createMint(data){
        data               = this.normalizeDataValues(data);
        let tick_id        = await this.createTicker(data['TICK']);
        let destination_id = await this.createAddress(data['DESTINATION']);
        let memo_id        = await this.createMemo(data['MEMO']);
        let status_id      = await this.createStatus(data['STATUS']);
        let action_index   = data['ACTION_INDEX'];
        let amount         = data['AMOUNT'];
        // Check if record already exists for this mint
        let exists  = false;
        let query   = "SELECT action_index FROM mints WHERE action_index=? LIMIT 1";
        let args    = [action_index];
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        mints
                    SET
                        tick_id=?,
                        amount=?,
                        destination_id=?,
                        memo_id=?,
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO mints (tick_id, amount, destination_id, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?)`;
        }
        args = [tick_id, amount, destination_id, memo_id, status_id, action_index];
        results = await this.doQuery(query, args);
    }

    // Create record in `list_edits` table
    async createListEdit(data, item, status){
        let action_index = data['ACTION_INDEX'];
        let status_id = await this.createStatus(status);
        let item_id   = null;
        if(data['TYPE']==1)
            item_id = await this.createTicker(item);
        if(data['TYPE']==2)
            item_id = await this.createAddress(item);
        // Check if record already exists for this list
        let query  = "SELECT item_id FROM list_edits WHERE action_index=? AND item_id=? AND status_id=? LIMIT 1";
        let args   = [action_index, item_id, status_id];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        // INSERT record
        if(!exists){
            query = "INSERT INTO list_edits (action_index, item_id, status_id) values (?, ?, ?)";
            results = await this.doQuery(query, args);
        }
    }

    // Create record in `list_items` table
    async createListItem(data, item){
        let action_index = data['ACTION_INDEX'];
        let item_id      = null;
        if(data['TYPE']==1)
            item_id = await this.createTicker(item);
        if(data['TYPE']==2)
            item_id = await this.createAddress(item);
        // Check if record already exists for this list
        let query  = "SELECT item_id FROM list_items WHERE action_index=? AND item_id=? LIMIT 1";
        let args   = [action_index, item_id];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        // INSERT record
        if(!exists){
            query = "INSERT INTO list_items (action_index, item_id) values (?, ?)";
            results = await this.doQuery(query, args);
        }
    }

    // Create record in `list_items_invalid` table
    async createListItemInvalid(data, item, status){
        let action_index = data['ACTION_INDEX'];
        let status_id    = await this.createStatus(status);
        let item_id      = null;
        if(data['TYPE']==1)
            item_id = await this.createTicker(item);
        if(data['TYPE']==2)
            item_id = await this.createAddress(item);
        // Check if record already exists for this list
        let query  = "SELECT item_id FROM list_items_invalid WHERE action_index=? AND item_id=? AND status_id=? LIMIT 1";
        let args   = [action_index, item_id, status_id];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        // INSERT record
        if(!exists){
            query = "INSERT INTO list_items_invalid (action_index, item_id, status_id) values (?, ?, ?)";
            results = await this.doQuery(query, args);
        }
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

    // Create record in `addresses` table
    async createAddressOption(data){
        data                     = this.normalizeDataValues(data);
        let status_id            = await this.createStatus(data['STATUS']);
        let memo_id              = await this.createMemo(data['MEMO']);
        let action_index         = data['ACTION_INDEX'];
        let fee_preference       = data['FEE_PREFERENCE'];
        let require_memo         = data['REQUIRE_MEMO'];
        let dispenser_preference = data['DISPENSER_PREFERENCE'];
        // Check if record already exists for this address
        let query  = "SELECT action_index FROM addresses WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE
                        addresses
                    SET
                        fee_preference=?,
                        require_memo=?,
                        dispenser_preference=?,
                        memo_id=?,
                        status_id=?
                    WHERE
                        action_index=?`;
        } else {
            query = "INSERT INTO addresses (fee_preference, require_memo, dispenser_preference, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?)";
        }
        args    = [fee_preference, require_memo, dispenser_preference, memo_id, status_id, action_index];
        results = await this.doQuery(query, args);
    }

    // Create record in `batches` table
    async createBatch(data){
        data             = this.normalizeDataValues(data);
        let status_id    = await this.createStatus(data['STATUS']);
        let action_index = data['ACTION_INDEX'];
        // Check if record already exists for this address
        let query = "SELECT action_index FROM batches WHERE action_index=? LIMIT 1";
        let args  = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE
                        batches
                    SET
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            query = "INSERT INTO batches (status_id, action_index) values (?, ?)";
        }
        args    = [status_id, action_index];
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `sends` table
    async createSend(data){
        data               = this.normalizeDataValues(data);
        let tick_id        = await this.createTicker(data['TICK']);
        let destination_id = await this.createAddress(data['DESTINATION']);
        let memo_id        = await this.createMemo(data['MEMO']);
        let status_id      = await this.createStatus(data['STATUS']);
        let action_index   = data['ACTION_INDEX'];
        let amount         = data['AMOUNT'];
        // Check if record already exists for this send
        let query  = `SELECT
                            action_index
                        FROM
                            sends
                        WHERE
                            tick_id=? AND
                            destination_id=? AND
                            amount=? AND
                            action_index=?`;
        let args = [tick_id, destination_id, amount, action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record, scoped to the LEG the exists-check matched.
            //
            // A multi-send puts several legs under one ACTION_INDEX (that is why the
            // sends index is non-unique), so `WHERE action_index=?` rewrote EVERY leg
            // of the action with this leg's values. On a re-parse of the same block
            // that also cascaded: once leg 1's update had stamped its values over the
            // other rows, leg 2's per-leg exists-check no longer matched anything and
            // INSERTed a duplicate. Same leg identity the exists-check above uses.
            query = `UPDATE
                        sends
                    SET
                        memo_id=?,
                        status_id=?
                    WHERE
                        action_index=? AND
                        tick_id=? AND
                        destination_id=? AND
                        amount=?`;
            args = [memo_id, status_id, action_index, tick_id, destination_id, amount];
        } else {
            // INSERT record
            query = `INSERT INTO sends (tick_id, destination_id, amount, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?)`;
            args = [tick_id, destination_id, amount, memo_id, status_id, action_index];
        }
        results = await this.doQuery(query, args);
    }

    // Get address preferences for a given address
    async getAddressPreferences(address, block_index, action_index){
        let id   = await this.createAddress(address);
        // Set default address preferences
        let data = {};
        data['FEE_PREFERENCE']       = 2; // 2=Donate FEES to development
        data['REQUIRE_MEMO']         = 0; // 0=Do NOT Require memo on SENDs to this address
        data['DISPENSER_PREFERENCE'] = 1; // 1=Only owner can open dispenser on this address
        // Build out the SQL query and arguments
        let sql  = '';
        let args = [id, 'valid'];
        // Query using either block_index OR action_index
        if(!this.util.isNull(action_index) && this.util.isNumeric(action_index)){
            sql += " AND a1.action_index < ?";
            args.push(action_index);
        } else if(!this.util.isNull(block_index) && this.util.isNumeric(block_index)){
            sql += " AND t1.block_index < ?";
            args.push(block_index);
        }
        // Lookup the address preferences.
        //
        // Format 1 is excluded on purpose: a controller bind writes an `addresses` row so its verdict is
        // readable, but that row carries no preferences, and Number(NULL) here would read back
        // as fee_preference=0 (destroy) for every later action by that address. The guard names the one
        // format rather than filtering on NULL columns, because a format-0 row with a blank preference
        // has always read back as 0 and must keep doing so.
        let query = `SELECT
                a1.fee_preference,
                a1.require_memo,
                a1.dispenser_preference
            FROM
                addresses                 a1
                INNER JOIN actions        a2 ON (a1.action_index=a2.action_index)
                INNER JOIN transactions   t1 ON (t1.tx_index=a2.tx_index)
                INNER JOIN index_statuses s1 ON (s1.id=a1.status_id)
            WHERE
                t1.source_id=? AND
                (a2.action_format IS NULL OR a2.action_format!=1) AND
                s1.status=?` + sql + `
            ORDER BY
                a1.action_index ASC`;
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            for(let row of results){
                data['FEE_PREFERENCE'] = Number(row.fee_preference);
                data['REQUIRE_MEMO']   = Number(row.require_memo);
                if(!this.util.isNull(row.dispenser_preference))
                    data['DISPENSER_PREFERENCE'] = Number(row.dispenser_preference);
            }
        }
        return data;
    }

    // Get escrowed tokens for a given address
    async getAddressEscrows(address, block_index, action_index){
        let id      = await this.createAddress(address);
        let escrows = [];
        let args    = [id];
        // Get list of orders with escrowed tokens
        let query = `SELECT 
                        o1.action_index
                    FROM
                        orders                    o1
                        INNER JOIN order_statuses s1 ON (s1.order_action_index=o1.action_index)
                        INNER JOIN actions        a1 ON (a1.action_index=o1.action_index)        
                        INNER JOIN transactions   t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN index_statuses s2 ON (s2.id=s1.status_id)
                    WHERE 
                        s1.action_index = (
                            SELECT
                                MAX(s3.action_index)
                            FROM
                                order_statuses s3
                            WHERE
                                s3.order_action_index=o1.action_index
                        ) AND
                        a1.source_id=? AND
                        s2.status='open'
                    ORDER BY 
                        a1.action_index ASC`;
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            for(let row of results)
                escrows.push({
                    type: 'order',
                    action_index: Number(row.action_index)
                });
        }
        // Get list of swaps with escrowed tokens
        query = `SELECT 
                    s1.action_index
                FROM
                    swaps                     s1
                    INNER JOIN swap_statuses  s2 ON (s2.swap_action_index=s1.action_index)
                    INNER JOIN actions        a1 ON (a1.action_index=s1.action_index)        
                    INNER JOIN transactions   t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN index_statuses s3 ON (s3.id=s2.status_id)
                WHERE 
                    s2.action_index = (
                        SELECT
                            MAX(s4.action_index)
                        FROM
                            swap_statuses s4
                        WHERE
                            s4.swap_action_index=s1.action_index
                    ) AND
                    a1.source_id=? AND
                    s3.status='open'
                ORDER BY 
                    a1.action_index ASC`;
        results = await this.doQuery(query, args);
        if(results.length > 0){
            for(let row of results)
                escrows.push({
                    type: 'swap',
                    action_index: Number(row.action_index)
                });

        } 
        // Get list of dispensers with escrowed tokens
        query = `SELECT 
                    d1.action_index
                FROM
                    dispensers                    d1
                    INNER JOIN dispenser_statuses s1 ON (s1.dispenser_action_index=d1.action_index)
                    INNER JOIN actions            a1 ON (a1.action_index=d1.action_index)        
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                WHERE 
                    s1.action_index = (
                        SELECT
                            MAX(s3.action_index)
                        FROM
                            dispenser_statuses s3
                        WHERE
                            s3.dispenser_action_index=d1.action_index
                    ) AND
                    a1.source_id=? AND
                    s2.status='open'
                ORDER BY 
                    a1.action_index ASC`;
        results = await this.doQuery(query, args);
        if(results.length > 0){
            for(let row of results)
                escrows.push({
                    type: 'dispenser',
                    action_index: Number(row.action_index)
                });

        } 
        return escrows;
    }

    // Create/Update record in `airdrops` table
    async createAirdrop(data){
        data                  = this.normalizeDataValues(data);
        let tick_id           = await this.createTicker(data['TICK']);
        let memo_id           = await this.createMemo(data['MEMO']);
        let status_id         = await this.createStatus(data['STATUS']);
        let action_index      = data['ACTION_INDEX'];
        let amount            = data['AMOUNT'];
        let list_action_index = (!this.util.isNumeric(data['LIST_ACTION_INDEX'])) ? null : data['LIST_ACTION_INDEX'];
        // Check if record already exists for this airdrop
        let query = `SELECT
                        action_index
                    FROM
                        airdrops
                    WHERE
                        tick_id=? AND
                        memo_id=? AND
                        list_action_index=? AND
                        amount=? AND
                        action_index=?`;
        let args  = [tick_id, memo_id, list_action_index, amount, action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        // Define list of arguments for sql insert/update
        if(exists){
            // UPDATE record
            query = `UPDATE
                        airdrops
                    SET
                        tick_id=?,
                        list_action_index=?,
                        amount=?,
                        memo_id=?,
                        status_id=?
                    WHERE
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO airdrops (tick_id, list_action_index, amount, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?)`;
        }
        args    = [tick_id, list_action_index, amount, memo_id, status_id, action_index];
        results = await this.doQuery(query, args);
    }

    // Read the fee row a handler staged for an action (createFeeRecord above). The feequote
    // dry-run calls this INSIDE its still-open forced-rollback transaction to extract the
    // handler-computed XCHAIN-denominated fee before the rollback discards the row; `amount`
    // is XCHAIN-denominated in every payment mode (mode 1 records the native output separately
    // in native_coin_amount). Returns null when the handler recorded no fee (zero-fee action,
    // or it rejected before fee processing).
    async getFeeRecord(actionIndex){
        if(this.util.isNull(actionIndex))
            return null;
        let query   = `SELECT amount, gas_cost, gas_price, xchain_amount, payment_mode FROM fees WHERE action_index=?`;
        let results = await this.doQuery(query, [actionIndex]);
        return (results && results.length > 0) ? results[0] : null;
    }

    // Create/Update record in `fees` table
    async createFeeRecord(data){
        data               = this.normalizeDataValues(data);
        let tick_id        = await this.createTicker(data['TICK']);
        let destination_id = await this.createAddress(data['DESTINATION']);
        let action_index   = data['ACTION_INDEX'];
        let amount         = data['AMOUNT'];
        let method         = data['METHOD'];
        // Unified gas fields (default to legacy values if not present)
        let gas_cost           = data['GAS_COST'] || 0;
        let gas_price          = data['GAS_PRICE'] || '0';
        let xchain_amount      = data['XCHAIN_AMOUNT'] || amount || '0';
        let payment_mode       = data['PAYMENT_MODE'] || 2;
        let fee_preference     = data['FEE_PREFERENCE'] || method || 2;
        let fee_version        = data['FEE_VERSION'] || 1;
        // Native coin fields (Track B - null for XCHAIN balance payments)
        let native_coin_amount = data['NATIVE_COIN_AMOUNT'] || null;
        let native_coin        = data['NATIVE_COIN'] || null;
        let oracle_round       = data['ORACLE_ROUND'] || null;
        // Check if record already exists
        let query = `SELECT action_index FROM fees WHERE action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE fees SET
                        tick_id=?, destination_id=?, amount=?, method=?,
                        gas_cost=?, gas_price=?, xchain_amount=?,
                        payment_mode=?, fee_preference=?, fee_version=?,
                        native_coin_amount=?, native_coin=?, oracle_round=?
                    WHERE action_index=?`;
            args = [tick_id, destination_id, amount, method,
                    gas_cost, gas_price, xchain_amount,
                    payment_mode, fee_preference, fee_version,
                    native_coin_amount, native_coin, oracle_round, action_index];
        } else {
            query = `INSERT INTO fees
                        (tick_id, destination_id, amount, method,
                         gas_cost, gas_price, xchain_amount,
                         payment_mode, fee_preference, fee_version,
                         native_coin_amount, native_coin, oracle_round, action_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            args = [tick_id, destination_id, amount, method,
                    gas_cost, gas_price, xchain_amount,
                    payment_mode, fee_preference, fee_version,
                    native_coin_amount, native_coin, oracle_round, action_index];
        }
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `destroys` table
    async createDestroy(data){
        data               = this.normalizeDataValues(data);
        let tick_id        = await this.createTicker(data['TICK']);
        let memo_id        = await this.createMemo(data['MEMO']);
        let status_id      = await this.createStatus(data['STATUS']);
        let action_index   = data['ACTION_INDEX'];
        let amount         = data['AMOUNT'];
        // Check if record already exists for THIS LEG of the destroy.
        //
        // A multi-destroy (FORMAT 1/2) settles several TICK legs under one
        // ACTION_INDEX, exactly like a multi-send. Keyed on action_index alone,
        // leg 2 matched leg 1's row and UPDATEd it, so every leg but the last was
        // overwritten and an N-tick destroy recorded a single destruction. The
        // parse consolidates legs by TICK|MEMO before anything is written here, so
        // (action_index, tick_id, memo_id) is the leg identity and cannot repeat;
        // AMOUNT and STATUS are the values a re-parse of the block may rewrite.
        // memo_id is compared NULL-safely because createMemo returns NULL for an
        // absent MEMO, and `memo_id=NULL` is never true.
        let query  = `SELECT
                            action_index
                        FROM
                            destroys
                        WHERE
                            action_index=? AND
                            tick_id=? AND
                            memo_id<=>?`;
        let args = [action_index, tick_id, memo_id];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record (scoped to this leg, never the whole action)
            query = `UPDATE
                        destroys
                    SET
                        amount=?,
                        status_id=?
                    WHERE
                        action_index=? AND
                        tick_id=? AND
                        memo_id<=>?`;
            args  = [amount, status_id, action_index, tick_id, memo_id];
        } else {
            // INSERT record
            query = `INSERT INTO destroys (tick_id, amount, memo_id, status_id, action_index) values (?, ?, ?, ?, ?)`;
            args  = [tick_id, amount, memo_id, status_id, action_index];
        }
        results = await this.doQuery(query, args);
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

    // Create/Update record in `sweeps` table
    async createSweep(data){
        data               = this.normalizeDataValues(data);
        let tick_id        = await this.createTicker(data['TICK']);
        let destination_id = await this.createAddress(data['DESTINATION']);
        let memo_id        = await this.createMemo(data['MEMO']);
        let status_id      = await this.createStatus(data['STATUS']);
        let action_index   = data['ACTION_INDEX'];
        let balances       = data['BALANCES'];
        let ownerships     = data['OWNERSHIPS'];
        let orders         = data['ORDERS'];
        let swaps          = data['SWAPS'];
        let dispensers     = data['DISPENSERS'];
        // Check if record already exists for this sweep
        let query = `SELECT
                        action_index
                    FROM
                        sweeps
                    WHERE
                        action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        sweeps
                    SET
                        destination_id=?,
                        balances=?,
                        ownerships=?,
                        orders=?,
                        swaps=?,
                        dispensers=?,
                        memo_id=?,
                        status_id=?
                    WHERE
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO sweeps (destination_id, balances, ownerships, orders, swaps, dispensers, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        }
        args    = [destination_id, balances, ownerships, orders, swaps, dispensers, memo_id, status_id, action_index];
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `dividends` table
    async createDividend(data){
        data                 = this.normalizeDataValues(data);
        let tick_id          = await this.createTicker(data['TICK']);
        let dividend_tick_id = await this.createTicker(data['DIVIDEND_TICK']);
        let memo_id          = await this.createMemo(data['MEMO']);
        let status_id        = await this.createStatus(data['STATUS']);
        let action_index     = data['ACTION_INDEX'];
        let amount           = data['AMOUNT'];
        // Check if record already exists for this dividend
        let query  = `SELECT
                            action_index
                        FROM
                            dividends
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        dividends
                    SET
                        tick_id=?,
                        dividend_tick_id=?,
                        amount=?,
                        memo_id=?,
                        status_id=?
                    WHERE 
                        action_index=?`;

        } else {
            // INSERT record
            query = `INSERT INTO dividends (tick_id, dividend_tick_id, amount, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?)`;
        }
        args    = [tick_id, dividend_tick_id, amount, memo_id, status_id, action_index];
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `callbacks` table
    async createCallback(data){
        data                 = this.normalizeDataValues(data);
        let tick_id          = await this.createTicker(data['TICK']);
        let callback_tick_id = await this.createTicker(data['CALLBACK_TICK']);
        let memo_id          = await this.createMemo(data['MEMO']);
        let status_id        = await this.createStatus(data['STATUS']);
        let action_index     = data['ACTION_INDEX'];
        let callback_amount  = data['CALLBACK_AMOUNT'];
        // Check if record already exists for this callback
        let query = `SELECT
                        action_index
                    FROM
                        callbacks
                    WHERE
                        action_index=?`; 
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        callbacks
                    SET
                        tick_id=?,
                        callback_tick_id=?,
                        callback_amount=?,
                        memo_id=?,
                        status_id=?
                    WHERE 
                        action_index=?`;

        } else {
            // INSERT record
            query = `INSERT INTO callbacks (tick_id, callback_tick_id, callback_amount, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?)`;
        }
        args    = [tick_id, callback_tick_id, callback_amount, memo_id, status_id,  action_index];
        results = await this.doQuery(query, args);
    }

    // Lookup a record in the `index_mime_types` table and return record id
    async getMimeTypeId(type){
        let id    = null;
        let query = "SELECT id FROM index_mime_types WHERE `type`=? LIMIT 1";
        let args  = [type];
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            id = Number(results[0].id);
        return id;
    }

    // Create records in the 'index_mime_types' table and return record id
    async createMimeType(type){
        // Ignore empty mime type and return NULL
        if(this.util.isNull(type))
            return null;
        var id = await this.getMimeTypeId(type);
        // Handle creating record
        if(id==null){
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index.
            let query = "INSERT IGNORE INTO index_mime_types (`type`) values (?)";
            let args  = [type];
            await this.doQuery(query, args);
            id = await this.getMimeTypeId(type);
        }
        return id;
    }

    // Create/Update record in `files` table
    async createFile(data){
        data             = this.normalizeDataValues(data);
        let type_id      = await this.createMimeType(data['TYPE']);
        let memo_id      = await this.createMemo(data['MEMO']);
        let status_id    = await this.createStatus(data['STATUS']);
        let action_index = data['ACTION_INDEX'];
        let name         = data['NAME'];
        let title        = data['TITLE'];
        // Check if record already exists for this file
        let query  = `SELECT
                            action_index
                        FROM
                            files
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        files
                    SET
                        name=?,
                        title=?,
                        type_id=?,
                        memo_id=?,
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO files (name, title, type_id, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?)`;
        }
        args    = [name, title, type_id, memo_id, status_id, action_index];
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `gated_files` table.
    // Called by the FILE handler when GATE_TICKER is non-empty.
    // Mirrors the ciphertext bytes (data['RAW_DATA']) so the explorer can
    // serve them via /api/file/{action_index}/raw without reaching across
    // databases. See xchain-documentation/protocol/TOKEN_GATED_CONTENT.md.
    async createGatedFile(data){
        data              = this.normalizeDataValues(data);
        let action_index  = data['ACTION_INDEX'];
        let gate_ticker   = data['GATE_TICKER'];
        let enc_method    = Number(data['ENCRYPTION_METHOD']) || 1;
        let key_hash      = String(data['KEY_HASH'] || '').toLowerCase();
        // PC-29: the publishing SOURCE scopes the pack, and the threshold governs it.
        // An empty/absent threshold is stored as NULL, never '': the pack rule reads
        // "any file with no threshold makes the pack unconditional", and having two
        // spellings of "no threshold" would make that rule depend on which one landed.
        let publisher     = String(data['SOURCE'] || '');
        let min_amount    = (data['GATE_MIN_AMOUNT'] === undefined || data['GATE_MIN_AMOUNT'] === null ||
                             String(data['GATE_MIN_AMOUNT']) === '') ? null : String(data['GATE_MIN_AMOUNT']);
        let status_id     = await this.createStatus(data['STATUS']);
        let raw_data      = data['RAW_DATA'] || null;

        let exists = false;
        let q = `SELECT action_index FROM gated_files WHERE action_index=?`;
        let r = await this.doQuery(q, [action_index]);
        if(r.length > 0) exists = true;

        let query;
        let args;
        if(exists){
            query = `UPDATE gated_files SET gate_ticker=?, encryption_method=?, key_hash=?, publisher_address=?, gate_min_amount=?, status_id=?, raw_data=? WHERE action_index=?`;
            args  = [gate_ticker, enc_method, key_hash, publisher, min_amount, status_id, raw_data, action_index];
        } else {
            query = `INSERT INTO gated_files (action_index, gate_ticker, encryption_method, key_hash, publisher_address, gate_min_amount, status_id, raw_data) values (?, ?, ?, ?, ?, ?, ?, ?)`;
            args  = [action_index, gate_ticker, enc_method, key_hash, publisher, min_amount, status_id, raw_data];
        }
        await this.doQuery(query, args);
    }

    // Fetch the raw ciphertext bytes for a gated FILE by ACTION_INDEX.
    // Returns null when no such gated file exists. Used by the explorer's
    // /api/file/{action_index}/raw endpoint.
    async getGatedFileRaw(action_index){
        let q = `SELECT raw_data FROM gated_files WHERE action_index=? LIMIT 1`;
        let r = await this.doQuery(q, [action_index]);
        if(r.length === 0) return null;
        return r[0].raw_data;
    }

    // Return the set of distinct KEY_HASH values across all currently-active
    // gated FILE v1 actions for a given token. Used by the SEND processor
    // to determine whether a transfer requires a paired MESSAGE handoff.
    // A pack of N files contributes one entry. Returns [] if the token has
    // no gated content.
    // PC-29: the gated PACKS for a token, with each pack's effective threshold.
    //
    // A pack is (publisher_address, gate_ticker, key_hash): files that share one key
    // and unlock together. Its EFFECTIVE THRESHOLD is the MINIMUM gate_min_amount
    // across its files, and any file with no threshold makes the whole pack
    // unconditional, because that file is readable by anyone holding the key and the
    // key is shared across the pack.
    //
    // The minimum is computed HERE IN JS, not with SQL MIN(). gate_min_amount is a
    // VARCHAR, so SQL MIN() compares lexicographically: it would rank '100' below
    // '9' and pick a threshold ten times too small. Decimal comparison has to go
    // through the same bignumber helpers consensus uses everywhere else.
    //
    // Returns [{ publisher, keyHash, threshold }] where threshold === null means the
    // pack is unconditional. Ordered deterministically so two nodes building the same
    // list from the same rows agree, for the same reason #3085 needed an ORDER BY.
    async getGatedPackThresholds(tick){
        let q = `SELECT gf.publisher_address, gf.key_hash, gf.gate_min_amount
                 FROM gated_files gf
                 INNER JOIN index_statuses s ON s.id = gf.status_id
                 WHERE gf.gate_ticker = ?
                   AND s.status = 'valid'
                 ORDER BY gf.publisher_address ASC, gf.key_hash ASC, gf.action_index ASC`;
        let rows = await this.doQuery(q, [tick]);
        let packs = new Map();
        for(let r of rows){
            let publisher = r.publisher_address == null ? '' : String(r.publisher_address);
            let keyHash   = String(r.key_hash || '').toLowerCase();
            let key       = publisher + '|' + keyHash;
            let raw       = (r.gate_min_amount == null || String(r.gate_min_amount) === '')
                          ? null : String(r.gate_min_amount);
            let pack = packs.get(key);
            if(pack === undefined){
                packs.set(key, { publisher, keyHash, threshold: raw, unconditional: (raw === null) });
                continue;
            }
            // Once any file in the pack carries no threshold the pack is
            // unconditional, and no later file can re-impose one.
            if(pack.unconditional) continue;
            if(raw === null){ pack.unconditional = true; pack.threshold = null; continue; }
            if(this.util.bclt(raw, pack.threshold)) pack.threshold = raw;
        }
        return Array.from(packs.values()).map(p => ({
            publisher: p.publisher, keyHash: p.keyHash,
            threshold: p.unconditional ? null : p.threshold
        }));
    }

    async getActiveGatedKeyHashes(tick){
        // Active = status maps to 'valid' (the canonical accepted status id).
        let q = `SELECT DISTINCT gf.key_hash
                 FROM gated_files gf
                 INNER JOIN index_statuses s ON s.id = gf.status_id
                 WHERE gf.gate_ticker = ?
                   AND s.status = 'valid'`;
        let r = await this.doQuery(q, [tick]);
        return r.map((row) => String(row.key_hash).toLowerCase());
    }

    // Lookup a record in the `index_coins` table and return record id
    async getCoinId(coin){
        let id    = null;
        let query = "SELECT id FROM index_coins WHERE `coin`=? LIMIT 1";
        let args  = [coin];
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            id = Number(results[0].id);
        return id;
    }

    // Create records in the 'index_coins' table and return record id
    async createCoin(coin){
        // Ignore empty coin and return NULL
        if(this.util.isNull(coin))
            return null;
        var id = await this.getCoinId(coin);
        // Handle creating record
        if(id==null){
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index.
            let query = "INSERT IGNORE INTO index_coins (`coin`) values (?)";
            let args  = [coin];
            await this.doQuery(query, args);
            id = await this.getCoinId(coin);
        }
        return id;
    }

    // Lookup a record in the `index_fiats` table and return record id
    async getFiatId(code){
        let id    = null;
        let query = "SELECT id FROM index_fiats WHERE `code`=? LIMIT 1";
        let args  = [code];
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            id = Number(results[0].id);
        return id;
    }

    // Create records in the 'index_fiats' table and return record id
    async createFiat(code){
        // Ignore empty fiat and return NULL
        if(this.util.isNull(code))
            return null;
        var id = await this.getFiatId(code);
        // Handle creating record
        if(id==null){
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index.
            let query = "INSERT IGNORE INTO index_fiats (`code`) values (?)";
            let args  = [code];
            await this.doQuery(query, args);
            id = await this.getFiatId(code);
        }
        return id;
    }    


    // Lookup table associated with an action
    async getActionIndexTable(action_index){
        let table  = null;
        let query  = `SELECT 
                        LCASE(a2.action) as action
                    FROM 
                        actions a1
                        INNER JOIN index_actions a2 ON (a2.id=a1.action_id)
                    WHERE
                        a1.action_index=?
                    LIMIT 1`;
        let args   = [action_index];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            let action = results[0].action;
            if(['address','batch','dispense'].includes(action)){
                table = action + 'es';
            } else {
                table = action + 's';
            }
        }
        return table;
    }

    // Verify that a given action_index is associated with a `valid` transaction
    async isActionIndexValid(action_index){
        let valid = false;
        let table = await this.getActionIndexTable(action_index);
        if(!this.util.isNull(table)){
            let query = `SELECT 
                            m.action_index
                        FROM 
                            ` + table + ` m
                            LEFT JOIN index_statuses s ON (s.id=m.status_id)
                        WHERE
                            m.action_index=? AND
                            s.status='valid'`;
            let args = [action_index];
            let results = await this.doQuery(query, args);
            if(results.length > 0)
                valid = true;
        }
        return valid;
    }

    // Create/Update record in `links` table
    async createLink(data){
        data                   = this.normalizeDataValues(data);
        let coin1_id           = await this.createCoin(data['COIN1']);
        let coin2_id           = await this.createCoin(data['COIN2']);
        let memo_id            = await this.createMemo(data['MEMO']);
        let status_id          = await this.createStatus(data['STATUS']);
        let action_index       = data['ACTION_INDEX'];
        let coin1_action_index = data['COIN1_ACTION_INDEX'];
        let coin2_action_index = data['COIN2_ACTION_INDEX'];
        // Check if record already exists for this link
        let query  = `SELECT
                            action_index
                        FROM
                            links
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        links
                    SET
                        coin1_id=?,
                        coin1_action_index=?,
                        coin2_id=?,
                        coin2_action_index=?,
                        memo_id=?,
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO links (coin1_id, coin1_action_index, coin2_id, coin2_action_index, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?, ?)`;
        }
        args    = [coin1_id, coin1_action_index, coin2_id, coin2_action_index, memo_id, status_id, action_index];
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `broadcasts` table
    async createBroadcast(data){
        data                       = this.normalizeDataValues(data);
        let memo_id                = await this.createMemo(data['MEMO']);
        let status_id              = await this.createStatus(data['STATUS']);
        let action_index           = data['ACTION_INDEX'];
        let broadcast_action_index = data['BROADCAST_ACTION_INDEX'];
        let message                = data['MESSAGE'];
        let value                  = data['VALUE'];
        let fee                    = data['FEE'];
        // Check if record already exists for this broadcast
        let query  = `SELECT
                            action_index
                        FROM
                            broadcasts
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        broadcasts
                    SET
                        message=?,
                        value=?,
                        fee=?,
                        broadcast_action_index=?,
                        memo_id=?,
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO broadcasts (message, value, fee, broadcast_action_index, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?, ?)`;
        }
        args    = [message, value, fee, broadcast_action_index, memo_id, status_id, action_index];
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `messages` table
    async createMessage(data){
        data                  = this.normalizeDataValues(data);
        let destination_id    = await this.createAddress(data['DESTINATION']);
        let status_id         = await this.createStatus(data['STATUS']);
        let action_index      = data['ACTION_INDEX'];
        let coin              = data['COIN'];
        let encryption_method = data['ENCRYPTION_METHOD'];
        let encryption_key    = data['ENCRYPTION_KEY'];
        let encrypted_message = data['ENCRYPTED_MESSAGE'];
        let plaintext_message = data['PLAINTEXT_MESSAGE'];
        // Check if record already exists for this message
        let query  = `SELECT
                            action_index
                        FROM
                            messages
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        messages
                    SET
                        coin=?,
                        encryption_method=?,
                        encryption_key=?,
                        encrypted_message=?,
                        plaintext_message=?,
                        destination_id=?,
                        status_id=?
                    WHERE
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO messages (coin, encryption_method, encryption_key, encrypted_message, plaintext_message, destination_id, status_id, action_index) values (?, ?, ?, ?, ?, ?, ?, ?)`;
        }
        args    = [coin, encryption_method, encryption_key, encrypted_message, plaintext_message, destination_id, status_id, action_index];
        results = await this.doQuery(query, args);
    }

    // Create/Update a poll record (VOTE v0). Keyed by the create action_index,
    // which is the poll's id. OPTIONS are stored as a JSON array, index-addressed
    // by ballots. Defaults (max_selections=1, tally_mode=approval,
    // weight_mode=balance) are applied by the handler before this is called.
    async createPoll(data){
        let action_index     = data['ACTION_INDEX'];
        let block_index      = data['BLOCK_INDEX'];
        let tick_id          = await this.createTicker(data['TICK']);
        let status_id        = await this.createStatus(data['STATUS']);
        let end_block        = data['END_BLOCK'];
        let optionsArr       = String(data['OPTIONS']).split(',').map(o => o.trim());
        let options          = JSON.stringify(optionsArr);
        let max_selections   = data['MAX_SELECTIONS'];
        let tally_mode       = data['TALLY_MODE'];
        let weight_mode      = data['WEIGHT_MODE'];
        let quorum           = data['QUORUM'];
        let min_voters       = data['MIN_VOTERS'];
        let min_vote_balance = data['MIN_VOTE_BALANCE'];
        let decide_threshold = data['DECIDE_THRESHOLD'];
        let question         = data['QUESTION'];
        // Creation deposit (anti-spam): _parseCreate normalizes DEPOSIT to a numeric
        // string ('0' when none). Store the amount and the creator address id (the
        // refund target) so VOTE v2 can release the escrow without re-deriving SOURCE.
        let deposit_amount   = this.util.isNull(data['DEPOSIT']) ? '0' : String(data['DEPOSIT']);
        // Binding-poll callback fields (null on a signaling poll). callback_params is
        // stored as the raw JSON array string; gas_escrow defaults to '0'.
        let binding          = !this.util.isNull(data['CALLBACK_CONTRACT']) && String(data['CALLBACK_CONTRACT']).trim() !== '';
        let cb_contract      = binding ? parseInt(data['CALLBACK_CONTRACT']) : null;
        let cb_method        = binding ? data['CALLBACK_METHOD'] : null;
        let cb_params        = binding ? (this.util.isNull(data['CALLBACK_PARAMS']) ? null : String(data['CALLBACK_PARAMS'])) : null;
        let cb_on            = binding ? (data['CALLBACK_ON'] || 'pass') : null;
        let gas_escrow       = binding ? (this.util.isNull(data['GAS_ESCROW']) ? '0' : String(data['GAS_ESCROW'])) : null;
        // CALLBACK_DELAY_BLOCKS timelock: _parseCreate nulls the field below
        // the VOTE_CALLBACK_TIMELOCK flag-day, so a stored value is always gate-legal.
        let cb_delay         = (binding && !this.util.isNull(data['CALLBACK_DELAY_BLOCKS'])) ? parseInt(data['CALLBACK_DELAY_BLOCKS']) : null;
        // deposit_address_id is the escrow PAYER (= creator), stored whenever any GAS
        // is locked (deposit OR gas_escrow) so v2 can resolve the refund target.
        let has_escrow       = this.util.bcgt(deposit_amount, 0) || (binding && this.util.bcgt(gas_escrow, 0));
        let deposit_addr_id  = has_escrow ? await this.createAddress(data['SOURCE']) : null;
        // INSERT/UPDATE keyed by action_index (poll definition is immutable, but
        // reprocessing the same action must be idempotent)
        let query   = `SELECT action_index FROM polls WHERE action_index=?`;
        let results = await this.doQuery(query, [action_index]);
        let exists  = (results.length > 0);
        if(exists){
            query = `UPDATE polls SET
                        block_index=?, tick_id=?, end_block=?, options=?, max_selections=?,
                        tally_mode=?, weight_mode=?, quorum=?, min_voters=?, min_vote_balance=?,
                        decide_threshold=?, question=?, deposit_amount=?, deposit_address_id=?,
                        callback_contract_index=?, callback_method=?, callback_params=?,
                        callback_on=?, gas_escrow=?, callback_delay_blocks=?, status_id=?
                     WHERE action_index=?`;
        } else {
            query = `INSERT INTO polls
                        (block_index, tick_id, end_block, options, max_selections,
                         tally_mode, weight_mode, quorum, min_voters, min_vote_balance,
                         decide_threshold, question, deposit_amount, deposit_address_id,
                         callback_contract_index, callback_method, callback_params,
                         callback_on, gas_escrow, callback_delay_blocks, status_id, action_index)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        }
        let args = [block_index, tick_id, end_block, options, max_selections,
                    tally_mode, weight_mode, quorum, min_voters, min_vote_balance,
                    decide_threshold, question, deposit_amount, deposit_addr_id,
                    cb_contract, cb_method, cb_params, cb_on, gas_escrow, cb_delay, status_id, action_index];
        await this.doQuery(query, args);
    }

    // Fetch a poll definition row by its id (the VOTE v0 action_index). Returns
    // null if no such poll exists.
    async getPoll(pollIndex){
        let results = await this.doQuery(`SELECT * FROM polls WHERE action_index=? LIMIT 1`, [pollIndex]);
        if(!results || results.length === 0) return null;
        return results[0];
    }

    // Resolve a deterministic index_addresses id back to its address string. Used by
    // VOTE v2 to find the deposit refund target (deposit_address_id was assigned via
    // createAddress at creation, so it is in the deterministic set). Null if missing.
    async getAddressById(id){
        if(this.util.isNull(id)) return null;
        let results = await this.doQuery(`SELECT address FROM index_addresses WHERE id=? LIMIT 1`, [id]);
        return (results.length > 0 && !this.util.isNull(results[0].address)) ? String(results[0].address) : null;
    }

    // Mark a poll's creation deposit as released ('refunded' or 'forfeited'). Called
    // by VOTE v2 after the escrow ledger change so a reprocessed finalize is a no-op
    // (the escrow itself is idempotent via action_index, this records the outcome).
    async setPollDepositResolved(pollIndex, resolved){
        await this.doQuery(`UPDATE polls SET deposit_resolved=? WHERE action_index=?`, [resolved, pollIndex]);
    }

    // Record the action_index of the EXECUTE that VOTE v2 injected for a binding
    // poll's callback. Cleared on rollback re-open so a re-synthesized v2 re-fires.
    async setPollCallbackIndex(pollIndex, executeActionIndex){
        await this.doQuery(`UPDATE polls SET callback_execute_action_index=? WHERE action_index=?`, [executeActionIndex, pollIndex]);
    }

    // timelock: stamp the block a deferred binding callback fires at
    // (resolved_block + CALLBACK_DELAY_BLOCKS). Written by VOTE v2 in place of the
    // immediate injection; cleared by the rollback re-open reset.
    async setPollCallbackDue(pollIndex, dueBlock){
        await this.doQuery(`UPDATE polls SET callback_due_block=? WHERE action_index=?`, [dueBlock, pollIndex]);
    }

    // timelock: terminal polls whose deferred callback comes due exactly at
    // block_index and has not fired. Equality (not <=) mirrors the immediate path's
    // fire-once-at-v2 semantics; the IS NULL guard makes a same-block reprocess
    // idempotent. Returns the full row (the sweep reconstructs the frozen result
    // from it).
    async getDueCallbackPolls(block_index){
        return await this.doQuery(
            `SELECT * FROM polls
              WHERE poll_status IN ('finalized','failed_quorum')
                AND callback_due_block = ?
                AND callback_execute_action_index IS NULL
              ORDER BY action_index ASC`, [block_index]);
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

    // Compute a poll's tally deterministically (Phase 1 lazy tally; the same logic
    // the system-injected VOTE v2 will freeze on-chain in Phase 2). Weight is the
    // voter's balance at the measure block (default = the poll's close block);
    // callers may pass the current tip for a provisional standing on an open poll.
    // Enforces the close-time backing rule (a voter must still hold the token at
    // the measure block) and the dust floor on participation counting.
    // Time-weighted average balance of every holder over [startBlock, endBlock],
    // for the time_weighted VOTE weight mode (Section 12.2). Resists
    // flash-acquisition voting: weight reflects sustained holding, not a close
    // snapshot. Derived from the credits/debits ledger (each event joined to its
    // action's block), NOT an O(blocks) scan: balance at startBlock + the signed
    // window events reconstruct the trajectory; each segment contributes
    // balance*blocks_held, summed and divided by the window length. All mathjs
    // fixed-precision; same-block events have zero-length segments so intra-block
    // ordering never affects the result (deterministic). Returns {address: avg}.
    async getTimeWeightedBalances(tick, startBlock, endBlock){
        startBlock = Number(startBlock);
        endBlock   = Number(endBlock);
        let windowLen = endBlock - startBlock;
        let startBal  = await this.getHolders(tick, startBlock, null);
        let tick_id   = await this.createTicker(tick);
        // Signed balance-change events in (startBlock, endBlock], oldest first.
        let rows = await this.doQuery(
            `SELECT ia.address AS address, ac.block_index AS block_index, c.amount AS amount, 1 AS sign
               FROM credits c
               INNER JOIN actions ac        ON ac.action_index = c.action_index
               INNER JOIN index_addresses ia ON ia.id = c.address_id
              WHERE c.tick_id = ? AND ac.block_index > ? AND ac.block_index <= ?
             UNION ALL
             SELECT ia.address AS address, ac.block_index AS block_index, d.amount AS amount, -1 AS sign
               FROM debits d
               INNER JOIN actions ac        ON ac.action_index = d.action_index
               INNER JOIN index_addresses ia ON ia.id = d.address_id
              WHERE d.tick_id = ? AND ac.block_index > ? AND ac.block_index <= ?
              ORDER BY block_index ASC`,
            [tick_id, startBlock, endBlock, tick_id, startBlock, endBlock]);
        let evByAddr = {};
        for(let r of rows){
            if(this.util.isNull(evByAddr[r.address])) evByAddr[r.address] = [];
            let delta = (Number(r.sign) < 0) ? this.util.bcmul(String(r.amount), '-1', 18) : String(r.amount);
            evByAddr[r.address].push({ block: Number(r.block_index), delta: delta });
        }
        let result = {};
        let addrs  = new Set([...Object.keys(startBal), ...Object.keys(evByAddr)]);
        for(let addr of addrs){
            let bal = this.util.isNull(startBal[addr]) ? '0' : String(startBal[addr]);
            // Degenerate window (close == creation): no integral, average is the
            // start balance (avoids divide-by-zero; a poll closing at its own
            // creation block can only happen via an immediate early-decide).
            if(windowLen <= 0){ result[addr] = bal; continue; }
            let prevBlock = startBlock;
            let integral  = '0';
            for(let ev of (evByAddr[addr] || [])){
                let segLen = ev.block - prevBlock;
                if(segLen > 0) integral = this.util.bcadd(integral, this.util.bcmul(bal, String(segLen), 18), 18);
                bal = this.util.bcadd(bal, ev.delta, 18);
                prevBlock = ev.block;
            }
            let tailLen = endBlock - prevBlock;
            if(tailLen > 0) integral = this.util.bcadd(integral, this.util.bcmul(bal, String(tailLen), 18), 18);
            result[addr] = this.util.bcdiv(integral, String(windowLen), 18);
        }
        return result;
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

    // Select open polls whose voting window has closed by block_index (time
    // trigger for finalization). Mirrors getExpiredAttestationRequests: the
    // per-block sweep injects a synthetic VOTE v2 for each. end_block is the
    // effective close for these (balances measured there even if the v2 lands
    // a block late).
    async getDuePolls(block_index){
        return await this.doQuery(
            `SELECT action_index, end_block FROM polls
              WHERE poll_status='open' AND end_block <= ?
              ORDER BY action_index ASC`, [block_index]);
    }

    // Select open polls that are armed for early-decide (a decide_threshold is
    // set) and not yet time-due (end_block still in the future; a poll at its
    // end_block finalizes via the time path). The sweep evaluates each one's
    // provisional tally at the current block to decide whether to close early.
    async getArmedPolls(block_index){
        // tick_id / weight_mode / decide_threshold are returned alongside action_index so the
        // sweep can compute the tally watermark and evaluate the threshold without a second
        // getPoll() round-trip per armed poll per block. These are immutable poll
        // definition columns, so carrying them here is equivalent to the prior separate fetch.
        return await this.doQuery(
            `SELECT action_index, tick_id, weight_mode, decide_threshold FROM polls
              WHERE poll_status='open'
                AND decide_threshold IS NOT NULL AND decide_threshold <> ''
                AND end_block > ?
              ORDER BY action_index ASC`, [block_index]);
    }

    // Freeze a poll's result on-chain (system-injected VOTE v2). Computes the
    // deterministic tally at the effective close block (reusing getPollTally, the
    // single source of truth for the math), writes one poll_results row per option,
    // and flips the polls row terminal. Returns the computed tally for logging.
    //
    // `data` carries the v2 action's ACTION_INDEX + BLOCK_INDEX and the sweep's
    // EFFECTIVE_CLOSE_BLOCK / DECIDED_EARLY. A poll that fails either validity gate
    // terminates 'failed_quorum' with no winner (results still recorded).
    async finalizePoll(data){
        let pollIndex     = Number(data['POLL_REF']);
        let actionIndex   = data['ACTION_INDEX'];
        let block_index   = data['BLOCK_INDEX'];
        let closeBlock    = Number(data['EFFECTIVE_CLOSE_BLOCK']);
        let decidedEarly  = data['DECIDED_EARLY'] ? 1 : 0;
        let status_id     = await this.createStatus(data['STATUS']);

        let tally = await this.getPollTally(pollIndex, closeBlock);
        if(this.util.isNull(tally)) return null;

        let passed   = tally.quorum_met && tally.min_voters_met;
        let terminal = passed ? 'finalized' : 'failed_quorum';
        let fail_reason = null;
        if(!passed){
            if(!tally.quorum_met && !tally.min_voters_met) fail_reason = 'both';
            else if(!tally.quorum_met)                     fail_reason = 'quorum';
            else                                           fail_reason = 'min_voters';
        }
        // No winner is recorded for a poll that failed its gates.
        let winning_option = passed ? tally.winning_option : null;

        // One poll_results row per option (per-option weight + distinct voter count)
        for(let opt of tally.options){
            await this.doQuery(
                `INSERT INTO poll_results
                    (action_index, block_index, poll_index, option_index, total_weight, voter_count, resolved_block, status_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [actionIndex, block_index, pollIndex, opt.index, String(opt.weight), opt.voters, block_index, status_id]);
        }

        // Flip the polls summary terminal. resolved_block anchors the reorg reset.
        await this.doQuery(
            `UPDATE polls SET
                poll_status=?, winning_option=?, total_weight=?, total_voters=?,
                quorum_met=?, min_voters_met=?, fail_reason=?, decided_early=?,
                effective_close_block=?, finalized_action_index=?, resolved_block=?
             WHERE action_index=?`,
            [terminal, winning_option, String(tally.total_counted_weight), tally.total_voters,
             tally.quorum_met ? 1 : 0, tally.min_voters_met ? 1 : 0, fail_reason, decidedEarly,
             closeBlock, actionIndex, block_index, pollIndex]);

        return Object.assign({}, tally, { poll_status: terminal, fail_reason, decided_early: decidedEarly, winning_option });
    }

    // Read a poll's frozen result (the VM host function xchain.getPollResult and
    // the explorer read this). Returns the polls summary plus per-option rows. For
    // an open (not-yet-finalized) poll, poll_status is 'open' and the finalization
    // fields are null, so a contract can tell "not decided yet" from a real result.
    async getPollResult(pollIndex){
        let poll = await this.getPoll(pollIndex);
        if(this.util.isNull(poll)) return null;
        let options = JSON.parse(poll.options || '[]');
        // Resolve the poll's electorate ticker: the read/explorer path
        // always carries it; the consensus VM snapshot gates it (getPollResultsForVM).
        let tick = this.util.isNull(poll.tick_id) ? null : await this.getTicker(poll.tick_id);
        let rows = await this.doQuery(
            `SELECT option_index, total_weight, voter_count FROM poll_results
              WHERE poll_index=? ORDER BY option_index ASC`, [pollIndex]);
        let optionResults = [];
        for(let i=0;i<options.length;i++){
            let r = rows.find(x => Number(x.option_index) === i);
            optionResults.push({
                index: i, label: options[i],
                weight: r ? String(r.total_weight) : '0',
                voters: r ? Number(r.voter_count) : 0
            });
        }
        return {
            poll_index: Number(pollIndex),
            tick: this.util.isNull(tick) ? null : String(tick),
            poll_status: poll.poll_status,
            winning_option: this.util.isNull(poll.winning_option) ? null : Number(poll.winning_option),
            total_weight: this.util.isNull(poll.total_weight) ? null : String(poll.total_weight),
            total_voters: this.util.isNull(poll.total_voters) ? null : Number(poll.total_voters),
            quorum_met: this.util.isNull(poll.quorum_met) ? null : !!Number(poll.quorum_met),
            min_voters_met: this.util.isNull(poll.min_voters_met) ? null : !!Number(poll.min_voters_met),
            fail_reason: poll.fail_reason || null,
            decided_early: this.util.isNull(poll.decided_early) ? null : !!Number(poll.decided_early),
            effective_close_block: this.util.isNull(poll.effective_close_block) ? null : Number(poll.effective_close_block),
            options: optionResults
        };
    }

    // Serializable snapshot of finalized poll results for the VM (backs
    // xchain.getPollResult). The VM worker rebuilds the getPollResult accessor
    // from this plain map (keys are poll indices).
    //
    // CONSENSUS RULE (mirrors getCrossChainDataForVM): only polls finalized in
    // blocks STRICTLY BEFORE the current one are exposed (resolved_block <
    // block_index). A poll is finalized by the per-block sweep AFTER that block's
    // actions run, so this bound also guarantees a poll never reads as decided
    // within its own finalization block, identically on every node and on replay.
    //
    // `includeTick` is the VOTE_POLL_TICK_VISIBLE flag-day gate (resolved by the
    // caller from the host block): below it the entry shape is byte-identical to
    // the pre-flag snapshot (no `tick` key); at/above it each entry gains a
    // `tick` field (the poll's immutable electorate, resolved through
    // index_tickers). Gating the KEY's presence, not just its value, keeps a
    // from-genesis replay of a pre-flag block identical on every node.
    async getPollResultsForVM(block_index, includeTick=false){
        let polls = {};
        let rows = await this.doQuery(
            `SELECT p.action_index, p.poll_status, p.winning_option, p.total_weight,
                    p.total_voters, p.decided_early, t.tick
               FROM polls p
               LEFT JOIN index_tickers t ON (t.id = p.tick_id)
              WHERE p.poll_status IN ('finalized','failed_quorum')
                AND p.resolved_block IS NOT NULL AND p.resolved_block < ?`,
            [Number(block_index) || 0]);
        for(let r of rows){
            let resultRows = await this.doQuery(
                `SELECT option_index, total_weight, voter_count FROM poll_results
                  WHERE poll_index=? ORDER BY option_index ASC`, [r.action_index]);
            let options = resultRows.map(o => ({
                index: Number(o.option_index),
                weight: String(o.total_weight),
                voters: Number(o.voter_count)
            }));
            let entry = {
                status:         r.poll_status,
                winning_option: this.util.isNull(r.winning_option) ? null : Number(r.winning_option),
                total_weight:   this.util.isNull(r.total_weight) ? null : String(r.total_weight),
                total_voters:   this.util.isNull(r.total_voters) ? null : Number(r.total_voters),
                decided_early:  this.util.isNull(r.decided_early) ? null : !!Number(r.decided_early),
                options:        options
            };
            if(includeTick) entry.tick = this.util.isNull(r.tick) ? null : String(r.tick);
            polls[String(r.action_index)] = entry;
        }
        return { polls: polls };
    }

    // Create/Update record in `sleeps` table
    async createSleep(data){
        // Capture the sleep TYPE *before* normalizeDataValues runs: TYPE is a
        // NUMBER_FIELD, so the non-numeric string 'TICK'/'ADDRESS' gets nulled
        // there. Reading it after normalize made (data['TYPE']=='TICK') always
        // false, so every TICK sleep (SLEEP v1) was stored as an ADDRESS sleep
        // (type=1) - wrongly sleeping the token owner's whole address and never
        // pausing the tick (isTickSleeping looks for type=2).
        let type         = (data['TYPE']=='TICK') ? 2 : 1;
        data             = this.normalizeDataValues(data);
        let tick_id      = await this.createTicker(data['TICK']);
        let memo_id      = await this.createMemo(data['MEMO']);
        let status_id    = await this.createStatus(data['STATUS']);
        let action_index = data['ACTION_INDEX'];
        let resume_block = data['RESUME_BLOCK'];
        // Check if record already exists for this sleep
        let query  = `SELECT
                            action_index
                        FROM
                            sleeps
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        sleeps
                    SET
                        type=?,
                        tick_id=?,
                        resume_block=?,
                        memo_id=?,
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO sleeps (type, tick_id, resume_block, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?)`;
        }
        args    = [type, tick_id, resume_block, memo_id, status_id, action_index];
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `swaps` table
    async createSwap(data){
        data               = this.normalizeDataValues(data);
        let give_coin_id   = await this.createCoin(data['GIVE_COIN']);
        let give_tick_id   = await this.createTicker(data['GIVE_TICK']);
        let get_coin_id    = await this.createCoin(data['GET_COIN']);
        let get_tick_id    = await this.createTicker(data['GET_TICK']);
        let get_address_id = await this.createAddress(data['GET_ADDRESS']);
        let memo_id        = await this.createMemo(data['MEMO']);
        let status_id      = await this.createStatus(data['STATUS']);
        let action_index   = data['ACTION_INDEX'];
        let give_amount    = data['GIVE_AMOUNT'];
        let get_amount     = data['GET_AMOUNT'];
        let give_ownership = (data['GIVE_OWNERSHIP']==1) ? 1 : 0;
        let get_ownership  = (data['GET_OWNERSHIP']==1)  ? 1 : 0;
        let expiration     = data['EXPIRATION'];
        let allow_list     = data['ALLOW_LIST'];
        let block_list     = data['BLOCK_LIST'];
        // Programmable policy: JSON [{to,bps}] royalty/fee split of the seller's proceeds (set as a
        // string by the handler from the create-side guard's payoutLegs; NULL = no split).
        let payout_legs    = (this.util.isNull(data['PAYOUT_LEGS'])) ? null : String(data['PAYOUT_LEGS']);
        // Check if record already exists for this swap
        let query  = `SELECT
                            action_index
                        FROM
                            swaps
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        swaps
                    SET
                        give_coin_id=?,
                        give_tick_id=?,
                        give_amount=?,
                        give_ownership=?,
                        get_coin_id=?,
                        get_tick_id=?,
                        get_amount=?,
                        get_ownership=?,
                        get_address_id=?,
                        expiration=?,
                        allow_list=?,
                        block_list=?,
                        memo_id=?,
                        status_id=?,
                        payout_legs=?
                    WHERE
                        action_index=?`;
            args = [give_coin_id, give_tick_id, give_amount, give_ownership, get_coin_id, get_tick_id, get_amount, get_ownership, get_address_id, expiration, allow_list, block_list, memo_id, status_id, payout_legs, action_index];
        } else {
            // INSERT record
            query = `INSERT INTO swaps (give_coin_id, give_tick_id, give_amount, give_ownership, get_coin_id, get_tick_id, get_amount, get_ownership, get_address_id, expiration, allow_list, block_list, memo_id, status_id, payout_legs, action_index) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            args = [give_coin_id, give_tick_id, give_amount, give_ownership, get_coin_id, get_tick_id, get_amount, get_ownership, get_address_id, expiration, allow_list, block_list, memo_id, status_id, payout_legs, action_index];
        }
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `swap_statuses` table
    // @param {action_index}     integer Action index of action
    // @param {swap_action_tick} integer Action index of swap
    // @param {status}           string  Status of the referenced swap (open/complete/cancelled/expired)
    async createSwapStatus(action_index, swap_action_index, status){
        // Normalize data
        let status_id = await this.createStatus(status);
        // Check if record already exists for this in swap_statuses table
        let query  = `SELECT
                            action_index
                        FROM
                            swap_statuses
                        WHERE
                            action_index=? AND
                            swap_action_index=?`;
        let args = [action_index, swap_action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        swap_statuses
                    SET
                        status_id=?
                    WHERE 
                        action_index=? AND
                        swap_action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO swap_statuses (status_id, action_index, swap_action_index) values (?, ?, ?)`;
        }
        args    = [status_id, action_index, swap_action_index];
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `swap_cancels` table
    async createSwapCancel(data){
        data                  = this.normalizeDataValues(data);
        let memo_id           = await this.createMemo(data['MEMO']);
        let status_id         = await this.createStatus(data['STATUS']);
        let action_index      = data['ACTION_INDEX'];
        let swap_action_index = data['SWAP_ACTION_INDEX'];
        // Check if record already exists for this swap_cancel
        let query  = `SELECT
                            action_index
                        FROM
                            swap_cancels
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        swap_cancels
                    SET
                        memo_id=?,
                        status_id=?,
                        swap_action_index=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO swap_cancels (memo_id, status_id, swap_action_index, action_index) values (?, ?, ?, ?)`;
        }
        args    = [memo_id, status_id, swap_action_index, action_index];
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `swap_statuses` table
    // @param {action_index}     integer Action index of action
    // @param {swap_action_tick} integer Action index of swap
    // @param {status}           string  Status of the expire (valid/invalid)
    async createSwapExpire(action_index, swap_action_index, status){
        // Normalize data
        let status_id = await this.createStatus(status);
        // Check if record already exists for this in swap_expires table
        let query  = `SELECT
                            action_index
                        FROM
                            swap_expires
                        WHERE
                            action_index=? AND
                            swap_action_index=?`;
        let args = [action_index, swap_action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        swap_expires
                    SET
                        status_id=?
                    WHERE 
                        action_index=? AND
                        swap_action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO swap_expires (status_id, action_index, swap_action_index) values (?, ?, ?)`;
        }
        args    = [status_id, action_index, swap_action_index];
        results = await this.doQuery(query, args);
    }

    // Return swap info for given action_index
    // Resolve a single swap by its (locally-unique) action_index. `coin` matches the
    // swap's GET coin (same-chain: the local coin; cross-chain: the counterparty coin).
    // Pass the counterparty coin (e.g. cross_settle) to assert the get side, or null to
    // look up purely by action_index - what cancel/expire must do, since they operate on
    // a local swap by index and cannot assume its get_coin is local.
    async getSwapInfo(coin, action_index){
        let swap = false;
        let query = `SELECT
                        s1.action_index,
                        t2.tick as give_tick,
                        s1.give_amount,
                        s1.give_ownership,
                        c1.coin as get_coin,
                        t3.tick as get_tick,
                        s1.get_amount,
                        s1.get_ownership,
                        a2.address as source,
                        a3.address as get_address,
                        s1.expiration,
                        s1.allow_list,
                        s1.block_list,
                        m1.memo,
                        s3.status,
                        s4.status as swap_status,
                        s1.payout_legs,
                        b1.block_index,
                        b1.block_time
                    FROM
                        swaps s1
                        INNER JOIN actions         a1 ON (a1.action_index=s1.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN blocks          b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses a2 ON (a2.id=a1.source_id)
                        INNER JOIN index_addresses a3 ON (a3.id=s1.get_address_id)
                        INNER JOIN index_tickers   t2 ON (t2.id=s1.give_tick_id)
                        INNER JOIN index_tickers   t3 ON (t3.id=s1.get_tick_id)
                        INNER JOIN index_coins     c1 ON (c1.id=s1.get_coin_id)
                        LEFT  JOIN index_memos     m1 ON (m1.id=s1.memo_id)
                        INNER JOIN swap_statuses   s2 ON (s2.swap_action_index=s1.action_index)
                        INNER JOIN index_statuses  s3 ON (s3.id=s1.status_id)
                        INNER JOIN index_statuses  s4 ON (s4.id=s2.status_id)
                    WHERE 
                        s2.action_index = (
                            SELECT
                                MAX(s5.action_index)
                            FROM
                                swap_statuses s5
                            WHERE
                                s5.swap_action_index=s1.action_index
                        ) AND
                        ${coin ? 'c1.coin=? AND' : ''}
                        s1.action_index=?
                    LIMIT 1`;
        let args  = coin ? [coin, action_index] : [action_index];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            swap = {};
            swap['GIVE_COIN'] = this.config['COIN'];
            for(let key in results[0]){
                let name  = String(key).toUpperCase()
                let value = results[0][key];
                if(['ACTION_INDEX', 'BLOCK_INDEX', 'BLOCK_TIME', 'EXPIRATION', 'ALLOW_LIST', 'BLOCK_LIST', 'GIVE_OWNERSHIP', 'GET_OWNERSHIP'].includes(name))
                    value = Number(value);
                swap[name] = value;
            }
            // Ownership swaps expose virtual '1' for the ownership side's GIVE_AMOUNT /
            // GET_AMOUNT so the matching engine can compare amounts uniformly. Settlement
            // code branches on GIVE_OWNERSHIP / GET_OWNERSHIP flags rather than the
            // synthetic amount.
            if(swap['GIVE_OWNERSHIP'] == 1 && this.util.isNull(swap['GIVE_AMOUNT']))
                swap['GIVE_AMOUNT'] = '1';
            if(swap['GET_OWNERSHIP']  == 1 && this.util.isNull(swap['GET_AMOUNT']))
                swap['GET_AMOUNT']  = '1';
            // Get updated swap properties from the swap_edits table
            let edit = await this.getSwapEdits(action_index);
            if(edit.expiration)
                swap['EXPIRATION'] = edit.expiration;
            if(edit.allow_list)
                swap['ALLOW_LIST'] = edit.allow_list;
            if(edit.block_list)
                swap['BLOCK_LIST'] = edit.block_list;
        }
        return swap;
    }

    // Return swap edit information for given action_index
    async getSwapEdits(action_index){
        // Define empty edit object
        let edit  = {
            expiration: false,
            allow_list: false,
            block_list: false
        };
        let query  = `SELECT 
                        s1.expiration,
                        s1.allow_list,
                        s1.block_list
                    FROM 
                        swap_edits s1
                        INNER JOIN index_statuses s2 ON (s2.id=s1.status_id)
                    WHERE 
                        s1.swap_action_index=? AND
                        s2.status=?
                    ORDER BY
                        s1.action_index ASC`;
        let args  = [action_index, 'valid'];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            for(let row of results){
                if(!this.util.isNull(row.expiration) && this.util.isNumeric(row.expiration)) edit.expiration = Number(row.expiration);
                if(!this.util.isNull(row.allow_list) && this.util.isNumeric(row.allow_list)) edit.allow_list = Number(row.allow_list);
                if(!this.util.isNull(row.block_list) && this.util.isNumeric(row.block_list)) edit.block_list = Number(row.block_list);
            }
        }
        return edit;
    }

    // Create/Update record in `swap_edits` table
    async createSwapEdit(data){
        data = this.normalizeDataValues(data);
        // Standardize LIST values to numeric or NULL
        for(let list of this.config['LIST_FIELDS']){
            if(this.util.isNull(data[list]) || !this.util.isNumeric(data[list]))
                delete data[list];
        }
        // Normalize data
        let memo_id           = await this.createMemo(data['MEMO']);
        let status_id         = await this.createStatus(data['STATUS']);
        let action_index      = data['ACTION_INDEX'];
        let swap_action_index = data['SWAP_ACTION_INDEX'];
        let expiration        = data['EXPIRATION'];
        let allow_list        = data['ALLOW_LIST'];
        let block_list        = data['BLOCK_LIST'];
        // Check if record already exists for this swap_edits
        let query  = `SELECT
                            action_index
                        FROM
                            swap_edits
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        swap_edits
                    SET
                        expiration=?,
                        allow_list=?,
                        block_list=?,
                        memo_id=?,
                        status_id=?,
                        swap_action_index=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO swap_edits (expiration, allow_list, block_list, memo_id, status_id, swap_action_index, action_index) values (?, ?, ?, ?, ?, ?, ?)`;
        }
        args    = [expiration, allow_list, block_list, memo_id, status_id, swap_action_index, action_index];
        results = await this.doQuery(query, args);
    }

    // Handle looking up potential swap matches
    async findSwapMatches(data){
        let matches = false;
        // Normalize data
        let source_id    = await this.createAddress(data['SOURCE']);
        let action_index = data['ACTION_INDEX'];
        // Lookup any matching swaps from different addresses (not SOURCE)
        let query = `SELECT
                        c1.coin,
                        s2.action_index
                    FROM
                        swaps s1,
                        swaps s2
                        INNER JOIN index_coins    c1 ON (c1.id=s2.get_coin_id)
                        INNER JOIN actions        a1 ON (a1.action_index=s2.action_index)
                        INNER JOIN transactions   t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN swap_statuses  s3 ON (s3.swap_action_index=s2.action_index)
                        INNER JOIN index_statuses s4 ON (s4.id=s3.status_id)
                    WHERE
                        s3.action_index = (
                            SELECT
                                MAX(s4.action_index)
                            FROM
                                swap_statuses s4
                            WHERE
                                s4.swap_action_index=s2.action_index
                        ) AND
                        s1.give_coin_id=s2.get_coin_id AND
                        s1.give_tick_id=s2.get_tick_id AND
                        -- Reverse leg: what s1 GETS must be exactly what s2 GIVES. The give leg and
                        -- the two amount equalities below bind everything EXCEPT the reverse tick/coin,
                        -- so a taker could receive a DIFFERENT (freely chosen, valuable) token than the
                        -- maker escrowed as long as the amounts matched; swap_match settlement then
                        -- credits swapInfo.GET_TICK, minting that token from the global escrow pool
                        -- (the +credit / -phantom-escrow net to zero, so the supply sanityCheck never
                        -- trips) while the maker's real GIVE token is stranded. NULL-safe (native-coin
                        -- sides carry a NULL tick), matching the give-leg / findOrderMatches handling.
                        s1.get_coin_id=s2.give_coin_id AND
                        -- Enforced only when both reverse ticks are real tokens (the token-for-token
                        -- path, where the mint bug lives); a NULL-tick leg is left to its own routing.
                        (s1.get_tick_id=s2.give_tick_id OR s1.get_tick_id IS NULL OR s2.give_tick_id IS NULL) AND
                        -- Ownership legs store NULL amounts; in SQL, NULL = NULL is NULL (not
                        -- true), so a bare equality silently drops every ownership swap
                        -- (ownership-for-ownership = both NULL, ownership-for-balance = one
                        -- NULL) before it can be returned. Pair on NULL-equals-NULL too, the
                        -- way findOrderMatches handles its null sides (#3749).
                        (s1.give_amount=s2.get_amount OR (s1.give_amount IS NULL AND s2.get_amount IS NULL)) AND
                        (s1.get_amount=s2.give_amount OR (s1.get_amount IS NULL AND s2.give_amount IS NULL)) AND
                        s1.action_index=? AND
                        a1.source_id!=? AND
                        s4.status='open'
                    ORDER BY
                        s2.action_index ASC`;
        let args = [action_index, source_id];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            // Loop through possible matches and get full information on the swap match
            for(let row of results){
                let swapInfo = await this.getSwapInfo(row.coin, row.action_index);
                if(!matches)
                    matches = [];
                matches.push(swapInfo);
            }
        }
        return matches;
    }

    // Create/Update record in `swap_matches` table
    async createSwapMatch(data, swap, match){
        data                  = this.normalizeDataValues(data);
        let give_coin_id      = await this.createCoin(match['GIVE_COIN']);
        let get_coin_id       = await this.createCoin(match['GET_COIN']);
        let give_tick_id      = await this.createTicker(match['GIVE_TICK']);
        let get_tick_id       = await this.createTicker(match['GET_TICK']);
        let status_id         = await this.createStatus(data['STATUS']);
        let give_amount       = match['GIVE_AMOUNT']
        let get_amount        = match['GET_AMOUNT']
        let action_index      = data['ACTION_INDEX'];
        let give_action_index = match['ACTION_INDEX']
        let get_action_index  = swap['ACTION_INDEX'];
        // Check if record already exists for this swap_matches
        let query  = `SELECT
                            action_index
                        FROM
                            swap_matches
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        swap_matches
                    SET
                        give_coin_id=?,
                        give_tick_id=?,
                        give_amount=?,
                        give_action_index=?,
                        get_coin_id=?,
                        get_tick_id=?,
                        get_amount=?,
                        get_action_index=?,
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO swap_matches (give_coin_id, give_tick_id, give_amount, give_action_index, get_coin_id, get_tick_id, get_amount, get_action_index, status_id, action_index) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        }
        args    = [give_coin_id, give_tick_id, give_amount, give_action_index, get_coin_id, get_tick_id, get_amount, get_action_index, status_id, action_index];
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `orders` table
    async createOrder(data){
        data               = this.normalizeDataValues(data);
        let give_coin_id   = await this.createCoin(data['GIVE_COIN']);
        let give_tick_id   = await this.createTicker(data['GIVE_TICK']);
        let get_coin_id    = await this.createCoin(data['GET_COIN']);
        let get_tick_id    = await this.createTicker(data['GET_TICK']);
        let get_address_id = await this.createAddress(data['GET_ADDRESS']);
        let memo_id        = await this.createMemo(data['MEMO']);
        let status_id      = await this.createStatus(data['STATUS']);
        let action_index   = data['ACTION_INDEX'];
        let give_amount    = data['GIVE_AMOUNT'];
        let get_amount     = data['GET_AMOUNT'];
        let give_ownership = (data['GIVE_OWNERSHIP']==1) ? 1 : 0;
        let get_ownership  = (data['GET_OWNERSHIP']==1)  ? 1 : 0;
        let expiration     = data['EXPIRATION'];
        let allow_list     = data['ALLOW_LIST'];
        let block_list     = data['BLOCK_LIST'];
        // Programmable policy: JSON [{to,bps}] royalty/fee split of the seller's proceeds (set as a
        // string by the handler from the create-side guard's payoutLegs; NULL = no split).
        let payout_legs    = (this.util.isNull(data['PAYOUT_LEGS'])) ? null : String(data['PAYOUT_LEGS']);
        // Check if record already exists for this order
        let query  = `SELECT
                            action_index
                        FROM
                            orders
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        orders
                    SET
                        give_coin_id=?,
                        give_tick_id=?,
                        give_amount=?,
                        give_ownership=?,
                        get_coin_id=?,
                        get_tick_id=?,
                        get_amount=?,
                        get_ownership=?,
                        get_address_id=?,
                        expiration=?,
                        allow_list=?,
                        block_list=?,
                        memo_id=?,
                        status_id=?,
                        payout_legs=?
                    WHERE
                        action_index=?`;
            args = [give_coin_id, give_tick_id, give_amount, give_ownership, get_coin_id, get_tick_id, get_amount, get_ownership, get_address_id, expiration, allow_list, block_list, memo_id, status_id, payout_legs, action_index];
        } else {
            // INSERT record
            query = `INSERT INTO orders (give_coin_id, give_tick_id, give_amount, give_ownership, get_coin_id, get_tick_id, get_amount, get_ownership, get_address_id, expiration, allow_list, block_list, memo_id, status_id, payout_legs, action_index) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            args = [give_coin_id, give_tick_id, give_amount, give_ownership, get_coin_id, get_tick_id, get_amount, get_ownership, get_address_id, expiration, allow_list, block_list, memo_id, status_id, payout_legs, action_index];
        }
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `order_statuses` table
    // @param {action_index}      integer Action index of action
    // @param {order_action_tick} integer Action index of order
    // @param {status}            string  Status of the referenced order (open/complete/cancelled/expired)
    async createOrderStatus(action_index, order_action_index, status){
        // Normalize data
        let status_id = await this.createStatus(status);
        // Check if record already exists for this in order_statuses table
        let query  = `SELECT
                            action_index
                        FROM
                            order_statuses
                        WHERE
                            action_index=? AND
                            order_action_index=?`;
        let args = [action_index, order_action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        order_statuses
                    SET
                        status_id=?
                    WHERE 
                        action_index=? AND
                        order_action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO order_statuses (status_id, action_index, order_action_index) values (?, ?, ?)`;
        }
        args    = [status_id, action_index, order_action_index];
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `order_expires` table
    // @param {action_index}      integer Action index of action
    // @param {order_action_tick} integer Action index of order
    // @param {status}            string  Status of the expire (valid/invalid)
    async createOrderExpire(action_index, order_action_index, status){
        // Normalize data
        let status_id = await this.createStatus(status);
        // Check if record already exists for this in order_expires table
        let query  = `SELECT
                            action_index
                        FROM
                            order_expires
                        WHERE
                            action_index=? AND
                            order_action_index=?`;
        let args = [action_index, order_action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        order_expires
                    SET
                        status_id=?
                    WHERE 
                        action_index=? AND
                        order_action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO order_expires (status_id, action_index, order_action_index) values (?, ?, ?)`;
        }
        args    = [status_id, action_index, order_action_index];
        results = await this.doQuery(query, args);
    }


    // Handle looking up potential order matches
    async findOrderMatches(data){
        let matches = false;
        // Normalize data
        let source_id    = await this.createAddress(data['SOURCE']);
        let action_index = data['ACTION_INDEX'];
        // Lookup any matching orders from different addresses (not SOURCE)
        let query = `SELECT
                        c1.coin,
                        o2.action_index
                    FROM
                        orders o1,
                        orders o2
                        INNER JOIN index_coins    c1 ON (c1.id=o2.get_coin_id)
                        INNER JOIN actions        a1 ON (a1.action_index=o2.action_index)
                        INNER JOIN transactions   t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN order_statuses s1 ON (s1.order_action_index=o2.action_index)
                        INNER JOIN index_statuses s2 ON (s2.id=s1.status_id)
                    WHERE
                        s1.action_index = (
                            SELECT
                                MAX(s3.action_index)
                            FROM
                                order_statuses s3
                            WHERE
                                s3.order_action_index=o2.action_index
                        ) AND
                        o1.give_coin_id=o2.get_coin_id AND
                        (o1.give_tick_id=o2.get_tick_id OR (o1.give_tick_id IS NULL AND o2.get_tick_id IS NULL)) AND
                        -- Reverse leg: what o1 GETS must be exactly what o2 GIVES. Without this the
                        -- predicate binds only the forward side (o1.give == o2.get), so a taker
                        -- offering o1.give could match a maker giving a DIFFERENT token than o1.get,
                        -- and order_match settlement (which hardcodes reciprocity via orderInfo.GET_TICK)
                        -- would credit the taker a token the maker never escrowed - minting it from the
                        -- global escrow pool while the maker's real token is stranded, and the
                        -- +credit / -phantom-escrow net to zero so the supply sanityCheck never trips.
                        -- NULL-safe like the give leg (native-coin sides carry a NULL tick).
                        o1.get_coin_id=o2.give_coin_id AND
                        -- Enforced only when both reverse ticks are real tokens (the instant
                        -- token-for-token path, where the mint bug lives). If either side is a
                        -- native-coin leg (NULL tick) the match routes through the two-phase
                        -- COINPay settlement, which is intentionally asymmetric, so leave it alone.
                        (o1.get_tick_id=o2.give_tick_id OR o1.get_tick_id IS NULL OR o2.give_tick_id IS NULL) AND
                        o1.action_index=? AND
                        a1.source_id!=? AND
                        s2.status='open'
                    ORDER BY
                        o2.action_index ASC`;
        let args = [action_index, source_id];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            // Loop through possible matches and get full information on the order match
            for(let row of results){
                let orderInfo = await this.getOrderInfo(row.coin, row.action_index);
                if(!matches)
                    matches = [];
                matches.push(orderInfo);
            }
        }
        // Sort matches by price, then by action_index
        if(matches)
            matches = this.util.sortPriceActionIndex(matches);
        return matches;
    }

    // Return order info for given action_index
    // Resolve a single order by its (locally-unique) action_index. `coin` matches the
    // order's GET coin: for a SAME-chain order get_coin == the local coin, and for a
    // CROSS-chain order get_coin == the counterparty coin. Pass the counterparty coin
    // (e.g. cross_settle) to assert the get side, or pass null to look up purely by
    // action_index - which is what cancel/expire/edit must do, since those operate on a
    // local order by index and cannot assume its get_coin is local (that assumption is
    // exactly what hid cross-chain offers from the cancel/expire paths).
    /*
     * BET parimutuel betting
     */

    // Create/Update record in `bet_feeds` table
    async createBetFeed(data){
        data               = this.normalizeDataValues(data);
        let tick_id        = await this.createTicker(data['TICK']);
        let memo_id        = await this.createMemo(data['MEMO']);
        let status_id      = await this.createStatus(data['STATUS']);
        let feed_status_id = await this.createStatus(data['FEED_STATUS']);
        let action_index   = data['ACTION_INDEX'];
        let label          = data['LABEL'];
        let outcomes       = data['OUTCOMES'];
        let fee            = data['FEE'];
        let deadline       = data['DEADLINE'];
        let refund_window  = data['REFUND_WINDOW'];
        let expire_at      = data['EXPIRE_AT'];
        let min_amount     = data['MIN_AMOUNT'];
        let allow_list     = data['ALLOW_LIST'];
        let block_list     = data['BLOCK_LIST'];
        let details        = data['DETAILS'];
        // Check if record already exists for this feed
        let query  = `SELECT
                            action_index
                        FROM
                            bet_feeds
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record (the latch/terminal stamps are OWNED by
            // latchBetFeedClosed / setBetFeedTerminal and never touched here)
            query = `UPDATE
                        bet_feeds
                    SET
                        label=?,
                        outcomes=?,
                        tick_id=?,
                        fee=?,
                        deadline=?,
                        refund_window=?,
                        expire_at=?,
                        min_amount=?,
                        allow_list=?,
                        block_list=?,
                        details=?,
                        memo_id=?,
                        status_id=?,
                        feed_status_id=?
                    WHERE
                        action_index=?`;
            args = [label, outcomes, tick_id, fee, deadline, refund_window, expire_at, min_amount, allow_list, block_list, details, memo_id, status_id, feed_status_id, action_index];
        } else {
            // INSERT record (stamps start NULL: not latched, not terminal)
            query = `INSERT INTO bet_feeds (label, outcomes, tick_id, fee, deadline, refund_window, expire_at, min_amount, allow_list, block_list, details, memo_id, status_id, feed_status_id, closed_block, terminal_block, action_index) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`;
            args = [label, outcomes, tick_id, fee, deadline, refund_window, expire_at, min_amount, allow_list, block_list, details, memo_id, status_id, feed_status_id, action_index];
        }
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `bets` table
    async createBet(data){
        data              = this.normalizeDataValues(data);
        let tick_id       = await this.createTicker(data['TICK']);
        let memo_id       = await this.createMemo(data['MEMO']);
        let status_id     = await this.createStatus(data['STATUS']);
        let bet_status_id = await this.createStatus(data['BET_STATUS']);
        let action_index  = data['ACTION_INDEX'];
        let feed_index    = data['FEED_ACTION_INDEX'];
        let outcome       = data['OUTCOME'];
        let amount        = data['AMOUNT'];
        // Check if record already exists for this bet
        let query  = `SELECT
                            action_index
                        FROM
                            bets
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record (settled_block is OWNED by setBetSettled)
            query = `UPDATE
                        bets
                    SET
                        feed_action_index=?,
                        outcome=?,
                        tick_id=?,
                        amount=?,
                        memo_id=?,
                        status_id=?,
                        bet_status_id=?
                    WHERE
                        action_index=?`;
            args = [feed_index, outcome, tick_id, amount, memo_id, status_id, bet_status_id, action_index];
        } else {
            // INSERT record
            query = `INSERT INTO bets (feed_action_index, outcome, tick_id, amount, memo_id, status_id, bet_status_id, settled_block, action_index) values (?, ?, ?, ?, ?, ?, ?, NULL, ?)`;
            args = [feed_index, outcome, tick_id, amount, memo_id, status_id, bet_status_id, action_index];
        }
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `bet_cancels` table (BET format 1). Written for every
    // cancel action whatever its parse status - that is the table's reason to exist:
    // a rejected cancel used to write nothing at all, so no API consumer
    // could distinguish it from a successful one. `status_id` is the PARSE status;
    // the feed's lifecycle status lives in bet_feed_statuses / bet_feeds
    async createBetCancel(data){
        data                  = this.normalizeDataValues(data);
        let memo_id           = await this.createMemo(data['MEMO']);
        let status_id         = await this.createStatus(data['STATUS']);
        let action_index      = data['ACTION_INDEX'];
        let feed_action_index = data['FEED_ACTION_INDEX'];
        // Check if record already exists for this cancel
        let query  = `SELECT
                            action_index
                        FROM
                            bet_cancels
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        bet_cancels
                    SET
                        feed_action_index=?,
                        memo_id=?,
                        status_id=?
                    WHERE
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO bet_cancels (feed_action_index, memo_id, status_id, action_index) values (?, ?, ?, ?)`;
        }
        args    = [feed_action_index, memo_id, status_id, action_index];
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `bet_resolves` table (BET format 3). Same discipline as
    // createBetCancel: stored whatever the parse status. `outcome` is the outcome the
    // oracle CLAIMED, so on an invalid row it settles nothing and is audit data only
    async createBetResolve(data){
        data                  = this.normalizeDataValues(data);
        let memo_id           = await this.createMemo(data['MEMO']);
        let status_id         = await this.createStatus(data['STATUS']);
        let action_index      = data['ACTION_INDEX'];
        let feed_action_index = data['FEED_ACTION_INDEX'];
        let outcome           = data['OUTCOME'];
        // Check if record already exists for this resolve
        let query  = `SELECT
                            action_index
                        FROM
                            bet_resolves
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        bet_resolves
                    SET
                        feed_action_index=?,
                        outcome=?,
                        memo_id=?,
                        status_id=?
                    WHERE
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO bet_resolves (feed_action_index, outcome, memo_id, status_id, action_index) values (?, ?, ?, ?, ?)`;
        }
        args    = [feed_action_index, outcome, memo_id, status_id, action_index];
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `bet_feed_statuses` table (status history; the
    // causing action's index + the feed's index, order_statuses pattern). The
    // `closed` latch writes NO row here - it has no causing action; its durable
    // record is bet_feeds.closed_block
    async createBetFeedStatus(action_index, feed_action_index, status){
        // Normalize data
        let status_id = await this.createStatus(status);
        // Check if record already exists in bet_feed_statuses table
        let query  = `SELECT
                            action_index
                        FROM
                            bet_feed_statuses
                        WHERE
                            action_index=? AND
                            feed_action_index=?`;
        let args = [action_index, feed_action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        bet_feed_statuses
                    SET
                        status_id=?
                    WHERE
                        action_index=? AND
                        feed_action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO bet_feed_statuses (status_id, action_index, feed_action_index) values (?, ?, ?)`;
        }
        args    = [status_id, action_index, feed_action_index];
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `bet_statuses` table (status history per bet)
    async createBetStatus(action_index, bet_action_index, status){
        // Normalize data
        let status_id = await this.createStatus(status);
        // Check if record already exists in bet_statuses table
        let query  = `SELECT
                            action_index
                        FROM
                            bet_statuses
                        WHERE
                            action_index=? AND
                            bet_action_index=?`;
        let args = [action_index, bet_action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        bet_statuses
                    SET
                        status_id=?
                    WHERE
                        action_index=? AND
                        bet_action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO bet_statuses (status_id, action_index, bet_action_index) values (?, ?, ?)`;
        }
        args    = [status_id, action_index, bet_action_index];
        results = await this.doQuery(query, args);
    }

    // Return information on a bet feed for the given action_index
    async getBetFeedInfo(action_index){
        let feed  = false;
        let query = `SELECT
                        f.action_index,
                        f.label,
                        f.outcomes,
                        t1.tick,
                        f.fee,
                        f.deadline,
                        f.refund_window,
                        f.expire_at,
                        f.min_amount,
                        f.allow_list,
                        f.block_list,
                        f.details,
                        m1.memo,
                        s1.status,
                        s2.status as feed_status,
                        f.closed_block,
                        f.terminal_block,
                        a2.address as source,
                        b1.block_index,
                        b1.block_time
                    FROM
                        bet_feeds f
                        INNER JOIN actions         a1 ON (a1.action_index=f.action_index)
                        INNER JOIN transactions    tx ON (tx.tx_index=a1.tx_index)
                        LEFT  JOIN blocks          b1 ON (b1.block_index=tx.block_index)
                        INNER JOIN index_addresses a2 ON (a2.id=a1.source_id)
                        LEFT  JOIN index_tickers   t1 ON (t1.id=f.tick_id)
                        LEFT  JOIN index_memos     m1 ON (m1.id=f.memo_id)
                        INNER JOIN index_statuses  s1 ON (s1.id=f.status_id)
                        INNER JOIN index_statuses  s2 ON (s2.id=f.feed_status_id)
                    WHERE
                        f.action_index=?
                    LIMIT 1`;
        let results = await this.doQuery(query, [action_index]);
        if(results.length > 0){
            feed = {};
            for(let key in results[0]){
                let name  = String(key).toUpperCase();
                let value = results[0][key];
                // Convert numerics but PRESERVE NULL: Number(null) is 0, and a
                // NULL allow_list collapsing to 0 would make every ungated feed
                // read as gated by the (nonexistent) list at action_index 0,
                // rejecting all bets. Amount-ish fields (fee/min_amount) stay
                // strings for bignumber math
                if(!this.util.isNull(value) && ['ACTION_INDEX', 'BLOCK_INDEX', 'BLOCK_TIME', 'DEADLINE', 'REFUND_WINDOW', 'EXPIRE_AT', 'ALLOW_LIST', 'BLOCK_LIST', 'CLOSED_BLOCK', 'TERMINAL_BLOCK'].includes(name))
                    value = Number(value);
                feed[name] = value;
            }
        }
        return feed;
    }

    // Return the `open` bets on a feed, action_index ASC (the normative
    // settlement/refund selection: spec section 7 pool predicate)
    async getOpenBetsByFeed(feed_action_index){
        let open_id = await this.createStatus('open');
        let query = `SELECT
                        b.action_index,
                        b.outcome,
                        b.amount,
                        a2.address as source
                    FROM
                        bets b
                        INNER JOIN actions         a1 ON (a1.action_index=b.action_index)
                        INNER JOIN index_addresses a2 ON (a2.id=a1.source_id)
                    WHERE
                        b.feed_action_index=? AND
                        b.bet_status_id=?
                    ORDER BY b.action_index ASC`;
        let results = await this.doQuery(query, [feed_action_index, open_id]);
        let bets = [];
        for(let row of results){
            bets.push({
                'ACTION_INDEX': Number(row.action_index),
                'OUTCOME':      Number(row.outcome),
                'AMOUNT':       row.amount,
                'SOURCE':       row.source
            });
        }
        return bets;
    }

    // Count the `open` bets on a feed (MAX_BETS_PER_FEED bound at place time)
    async countOpenBetsByFeed(feed_action_index){
        let open_id = await this.createStatus('open');
        let query   = `SELECT COUNT(*) as cnt FROM bets WHERE feed_action_index=? AND bet_status_id=?`;
        let results = await this.doQuery(query, [feed_action_index, open_id]);
        return (results.length > 0) ? Number(results[0].cnt) : 0;
    }

    // Latch a feed `closed` (end-of-block pass step 1). Idempotence-guarded in
    // the WHERE: only an `open`, never-latched feed takes the write, so a
    // crash-restart replay of the block cannot latch twice or overwrite the
    // original latch block. One `closed` transition per feed lifetime, one-way
    async latchBetFeedClosed(feed_action_index, block_index){
        let open_id   = await this.createStatus('open');
        let closed_id = await this.createStatus('closed');
        let query = `UPDATE
                        bet_feeds
                    SET
                        feed_status_id=?,
                        closed_block=?
                    WHERE
                        action_index=? AND
                        feed_status_id=? AND
                        closed_block IS NULL`;
        await this.doQuery(query, [closed_id, block_index, feed_action_index, open_id]);
    }

    // Move a feed to a terminal status (resolved / resolved_void / cancelled /
    // expired), stamping terminal_block in the same write. The stamp keys the
    // reorg reset, the state-hash class, and the sync updated_rows forward
    // class (in-place mutation on a surviving row, polls.resolved_block pattern)
    async setBetFeedTerminal(feed_action_index, status, block_index){
        let status_id = await this.createStatus(status);
        let query = `UPDATE
                        bet_feeds
                    SET
                        feed_status_id=?,
                        terminal_block=?
                    WHERE
                        action_index=?`;
        await this.doQuery(query, [status_id, block_index, feed_action_index]);
    }

    // Move a bet to a terminal status (won / lost / refunded), stamping
    // settled_block in the same write (same stamp discipline as above)
    async setBetSettled(bet_action_index, status, block_index){
        let status_id = await this.createStatus(status);
        let query = `UPDATE
                        bets
                    SET
                        bet_status_id=?,
                        settled_block=?
                    WHERE
                        action_index=?`;
        await this.doQuery(query, [status_id, block_index, bet_action_index]);
    }

    // Paged bet-feed listing for the JSON-RPC read surface (ops tooling / e2e;
    // the PUBLIC api is the explorer REST layer, which queries this DB directly).
    // Filters: feed status / oracle (source) address / wager tick; keyset paging
    // on action_index ASC
    async getBetFeedRows(opts = {}){
        let limit = parseInt(opts.limit);
        if(!Number.isFinite(limit) || limit <= 0) limit = 100;
        let sql  = '';
        let args = [];
        if(!this.util.isNull(opts.status)){
            sql += ' AND s2.status=?';
            args.push(String(opts.status));
        }
        if(!this.util.isNull(opts.source)){
            sql += ' AND a2.address=?';
            args.push(String(opts.source));
        }
        if(!this.util.isNull(opts.tick)){
            sql += ' AND t1.tick=?';
            args.push(String(opts.tick));
        }
        if(!this.util.isNull(opts.after_action_index) && this.util.isNumeric(opts.after_action_index)){
            sql += ' AND f.action_index > ?';
            args.push(parseInt(opts.after_action_index));
        }
        let query = `SELECT
                        f.action_index,
                        f.label,
                        f.outcomes,
                        t1.tick,
                        f.fee,
                        f.deadline,
                        f.refund_window,
                        f.expire_at,
                        f.min_amount,
                        f.allow_list,
                        f.block_list,
                        m1.memo,
                        s2.status as feed_status,
                        f.closed_block,
                        f.terminal_block,
                        a2.address as source,
                        b1.block_index
                    FROM
                        bet_feeds f
                        INNER JOIN actions         a1 ON (a1.action_index=f.action_index)
                        INNER JOIN transactions    tx ON (tx.tx_index=a1.tx_index)
                        LEFT  JOIN blocks          b1 ON (b1.block_index=tx.block_index)
                        INNER JOIN index_addresses a2 ON (a2.id=a1.source_id)
                        LEFT  JOIN index_tickers   t1 ON (t1.id=f.tick_id)
                        LEFT  JOIN index_memos     m1 ON (m1.id=f.memo_id)
                        INNER JOIN index_statuses  s2 ON (s2.id=f.feed_status_id)
                    WHERE
                        1=1` + sql + `
                    ORDER BY f.action_index ASC
                    LIMIT ${limit}`;
        return await this.doQuery(query, args);
    }

    // Per-outcome pool sums for one feed (open bets only, the settlement
    // predicate). Sums as strings (CAST to CHAR) so the driver never coerces
    // through a float
    async getBetFeedPools(feed_action_index){
        let open_id = await this.createStatus('open');
        let query = `SELECT
                        b.outcome,
                        CAST(SUM(CAST(b.amount AS DECIMAL(60,18))) AS CHAR) as pool,
                        COUNT(*) as bets
                    FROM
                        bets b
                    WHERE
                        b.feed_action_index=? AND
                        b.bet_status_id=?
                    GROUP BY b.outcome
                    ORDER BY b.outcome ASC`;
        return await this.doQuery(query, [feed_action_index, open_id]);
    }

    // Paged bet listing for the JSON-RPC read surface. Filters: feed / bettor
    // address / bet status; keyset paging on action_index ASC
    async getBetRows(opts = {}){
        let limit = parseInt(opts.limit);
        if(!Number.isFinite(limit) || limit <= 0) limit = 100;
        let sql  = '';
        let args = [];
        if(!this.util.isNull(opts.feed) && this.util.isNumeric(opts.feed)){
            sql += ' AND b.feed_action_index=?';
            args.push(parseInt(opts.feed));
        }
        if(!this.util.isNull(opts.source)){
            sql += ' AND a2.address=?';
            args.push(String(opts.source));
        }
        if(!this.util.isNull(opts.status)){
            sql += ' AND s2.status=?';
            args.push(String(opts.status));
        }
        if(!this.util.isNull(opts.after_action_index) && this.util.isNumeric(opts.after_action_index)){
            sql += ' AND b.action_index > ?';
            args.push(parseInt(opts.after_action_index));
        }
        let query = `SELECT
                        b.action_index,
                        b.feed_action_index,
                        b.outcome,
                        t1.tick,
                        b.amount,
                        s2.status as bet_status,
                        b.settled_block,
                        a2.address as source,
                        bl.block_index
                    FROM
                        bets b
                        INNER JOIN actions         a1 ON (a1.action_index=b.action_index)
                        INNER JOIN transactions    tx ON (tx.tx_index=a1.tx_index)
                        LEFT  JOIN blocks          bl ON (bl.block_index=tx.block_index)
                        INNER JOIN index_addresses a2 ON (a2.id=a1.source_id)
                        LEFT  JOIN index_tickers   t1 ON (t1.id=b.tick_id)
                        INNER JOIN index_statuses  s2 ON (s2.id=b.bet_status_id)
                    WHERE
                        1=1` + sql + `
                    ORDER BY b.action_index ASC
                    LIMIT ${limit}`;
        return await this.doQuery(query, args);
    }

    // Feeds due to latch: `open` with DEADLINE reached, deadline ASC then
    // action_index ASC (the deterministic pass order), capped per block
    async getBetFeedsDueLatch(block_time, limit){
        let open_id = await this.createStatus('open');
        let query = `SELECT
                        f.action_index
                    FROM
                        bet_feeds f
                    WHERE
                        f.feed_status_id=? AND
                        f.deadline <= ?
                    ORDER BY f.deadline ASC, f.action_index ASC
                    LIMIT ${parseInt(limit)}`;
        return await this.doQuery(query, [open_id, block_time]);
    }

    // Feeds due to expire: `open`/`closed` with expire_at reached, expire_at ASC
    // then action_index ASC, capped per block by feed count; each row carries its
    // `open`-bet count so the pass can also enforce the refund-credit budget
    async getBetFeedsDueExpiry(block_time, limit){
        let open_id   = await this.createStatus('open');
        let closed_id = await this.createStatus('closed');
        let query = `SELECT
                        f.action_index,
                        f.expire_at,
                        (SELECT COUNT(*) FROM bets b WHERE b.feed_action_index=f.action_index AND b.bet_status_id=?) as open_bets
                    FROM
                        bet_feeds f
                    WHERE
                        f.feed_status_id IN (?, ?) AND
                        f.expire_at <= ?
                    ORDER BY f.expire_at ASC, f.action_index ASC
                    LIMIT ${parseInt(limit)}`;
        return await this.doQuery(query, [open_id, open_id, closed_id, block_time]);
    }

    async getOrderInfo(coin, action_index){
        let order = false;
        let query = `SELECT
                        o1.action_index,
                        t2.tick as give_tick,
                        o1.give_amount,
                        o1.give_ownership,
                        c1.coin as get_coin,
                        t3.tick as get_tick,
                        o1.get_amount,
                        o1.get_ownership,
                        a2.address as source,
                        a3.address as get_address,
                        o1.expiration,
                        o1.allow_list,
                        o1.block_list,
                        m1.memo,
                        s2.status,
                        s3.status as order_status,
                        o1.payout_legs,
                        b1.block_index,
                        b1.block_time
                    FROM
                        orders o1
                        INNER JOIN actions         a1 ON (a1.action_index=o1.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN blocks          b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses a2 ON (a2.id=a1.source_id)
                        INNER JOIN index_addresses a3 ON (a3.id=o1.get_address_id)
                        LEFT  JOIN index_tickers   t2 ON (t2.id=o1.give_tick_id)
                        LEFT  JOIN index_tickers   t3 ON (t3.id=o1.get_tick_id)
                        INNER JOIN index_coins     c1 ON (c1.id=o1.get_coin_id)
                        LEFT  JOIN index_memos     m1 ON (m1.id=o1.memo_id)
                        INNER JOIN order_statuses  s1 ON (s1.order_action_index=o1.action_index)
                        INNER JOIN index_statuses  s2 ON (s2.id=o1.status_id)
                        INNER JOIN index_statuses  s3 ON (s3.id=s1.status_id)
                    WHERE 
                        s1.action_index = (
                            SELECT
                                MAX(s4.action_index)
                            FROM
                                order_statuses s4
                            WHERE
                                s4.order_action_index=o1.action_index
                        ) AND
                        ${coin ? 'c1.coin=? AND' : ''}
                        o1.action_index=?
                    LIMIT 1`;
        let args  = coin ? [coin, action_index] : [action_index];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            order = {};
            order['GIVE_COIN'] = this.config['COIN'];
            for(let key in results[0]){
                let name  = String(key).toUpperCase()
                let value = results[0][key];
                if(['ACTION_INDEX', 'BLOCK_INDEX', 'BLOCK_TIME', 'EXPIRATION', 'ALLOW_LIST', 'BLOCK_LIST', 'GIVE_OWNERSHIP', 'GET_OWNERSHIP'].includes(name))
                    value = Number(value);
                order[name] = value;
            }
        }
        // Get additional information on this order
        if(order){
            // Get updated order properties from the order_edits table
            let edit = await this.getOrderEdits(action_index);
            if(edit.expiration)
                order['EXPIRATION'] = edit.expiration;
            if(edit.allow_list)
                order['ALLOW_LIST'] = edit.allow_list;
            if(edit.block_list)
                order['BLOCK_LIST'] = edit.block_list;
            // Ownership orders carry no amount on the ownership side. Expose virtual '1'
            // so price math + match comparison work uniformly. Settlement code branches on
            // GIVE_OWNERSHIP / GET_OWNERSHIP flags rather than the synthetic amount.
            if(order['GIVE_OWNERSHIP'] == 1 && this.util.isNull(order['GIVE_AMOUNT']))
                order['GIVE_AMOUNT'] = '1';
            if(order['GET_OWNERSHIP']  == 1 && this.util.isNull(order['GET_AMOUNT']))
                order['GET_AMOUNT']  = '1';
            // Determine order get/give prices
            order['GIVE_PRICE'] = this.util.getPrice(order['GET_AMOUNT'],  order['GIVE_AMOUNT']);
            order['GET_PRICE']  = this.util.getPrice(order['GIVE_AMOUNT'], order['GET_AMOUNT']);
            // Determine order amounts remaining
            let [give_remaining, get_remaining] = await this.getOrderAmountsRemaining(action_index);
            order['GIVE_REMAINING'] = give_remaining;
            order['GET_REMAINING']  = get_remaining;
        }
        return order;
    }

    // Return order edit information for given action_index
    async getOrderEdits(action_index){
        // Define empty edit object
        let edit  = {
            expiration: false,
            allow_list: false,
            block_list: false
        };
        let query  = `SELECT 
                        o.expiration,
                        o.allow_list,
                        o.block_list
                    FROM 
                        order_edits o
                        INNER JOIN index_statuses s ON (s.id=o.status_id)
                    WHERE 
                        o.order_action_index=? AND
                        s.status=?
                    ORDER BY
                        o.action_index ASC`;
        let args  = [action_index, 'valid'];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            for(let row of results){
                if(!this.util.isNull(row.expiration) && this.util.isNumeric(row.expiration)) edit.expiration = Number(row.expiration);
                if(!this.util.isNull(row.allow_list) && this.util.isNumeric(row.allow_list)) edit.allow_list = Number(row.allow_list);
                if(!this.util.isNull(row.block_list) && this.util.isNumeric(row.block_list)) edit.block_list = Number(row.block_list);
            }
        }
        return edit;
    }

    // Handle getting total amounts remaining for a given order
    async getOrderAmountsRemaining(action_index){
        // Placeholders for amount escrowed and amount matched
        let give_coin_id   = 0,
            give_tick_id   = 0,
            give_remaining = 0,
            get_coin_id    = 0,
            get_tick_id    = 0,
            get_remaining  = 0;
        // Get initial amounts from the orders table
        let query  = `SELECT
                        o.give_coin_id,
                        o.give_tick_id,
                        o.give_amount,
                        o.give_ownership,
                        o.get_coin_id,
                        o.get_tick_id,
                        o.get_amount,
                        o.get_ownership
                    FROM
                        orders o
                        INNER JOIN index_statuses s ON (s.id=o.status_id)
                    WHERE
                        o.action_index=? AND
                        s.status=?`;
        let args  = [action_index, 'valid'];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            let info = results[0];
            give_coin_id   = info.give_coin_id;
            give_tick_id   = info.give_tick_id;
            // Ownership orders carry no GIVE_AMOUNT/GET_AMOUNT in the schema; expose
            // virtual '1' so the matcher's bignumber math (price ratios, single-fill
            // subtraction) works uniformly with token-balance orders.
            give_remaining = (info.give_ownership == 1) ? '1' : info.give_amount;
            get_coin_id    = info.get_coin_id;
            get_tick_id    = info.get_tick_id;
            get_remaining  = (info.get_ownership  == 1) ? '1' : info.get_amount;
        }
        // Lookup amounts matched in order_matches
        query = `SELECT
                    m.give_action_index,
                    m.get_action_index,
                    m.give_amount,
                    m.get_amount
                FROM
                    order_matches m
                    INNER JOIN index_statuses s ON (s.id=m.status_id)
                WHERE
                    (m.give_action_index=? OR m.get_action_index=?) AND
                    s.status IN (?, ?)
                ORDER BY action_index ASC`;
        args = [action_index, action_index, 'valid', 'pending_coinpay'];
        results = await this.doQuery(query, args);
        if(results.length > 0){
            // Loop through each order match and deduct amount from remaining
            for(let row of results){
                let give_amount = (row.get_action_index==action_index) ? row.give_amount : row.get_amount;
                let get_amount  = (row.get_action_index==action_index) ? row.get_amount  : row.give_amount;
                give_remaining  = this.util.bcsub(give_remaining, give_amount, 64);
                get_remaining   = this.util.bcsub(get_remaining,  get_amount, 64);
            }
        }
        return [give_remaining, get_remaining];
    }

    // Create/Update record in `order_edits` table
    async createOrderEdit(data){
        data                   = this.normalizeDataValues(data);
        let memo_id            = await this.createMemo(data['MEMO']);
        let status_id          = await this.createStatus(data['STATUS']);
        let action_index       = data['ACTION_INDEX'];
        let order_action_index = data['ORDER_ACTION_INDEX'];
        let expiration         = data['EXPIRATION'];
        let allow_list         = data['ALLOW_LIST'];
        let block_list         = data['BLOCK_LIST'];
        // Check if record already exists for this order_edits
        let query  = `SELECT
                            action_index
                        FROM
                            order_edits
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        order_edits
                    SET
                        expiration=?,
                        allow_list=?,
                        block_list=?,
                        memo_id=?,
                        status_id=?,
                        order_action_index=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO order_edits (expiration, allow_list, block_list, memo_id, status_id, order_action_index, action_index) values (?, ?, ?, ?, ?, ?, ?)`;
        }
        args    = [expiration, allow_list, block_list, memo_id, status_id, order_action_index, action_index];
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `order_cancels` table
    async createOrderCancel(data){
        data                  = this.normalizeDataValues(data);
        let memo_id           = await this.createMemo(data['MEMO']);
        let status_id         = await this.createStatus(data['STATUS']);
        let action_index      = data['ACTION_INDEX'];
        let order_action_index = data['ORDER_ACTION_INDEX'];
        // Check if record already exists for this swap_cancel
        let query  = `SELECT
                            action_index
                        FROM
                            order_cancels
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        order_cancels
                    SET
                        memo_id=?,
                        status_id=?,
                        order_action_index=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO order_cancels (memo_id, status_id, order_action_index, action_index) values (?, ?, ?, ?)`;
        }
        args    = [memo_id, status_id, order_action_index, action_index];
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `order_matches` table
    async createOrderMatch(data, order, match){
        data                  = this.normalizeDataValues(data);
        let give_coin_id      = await this.createCoin(order['GIVE_COIN']);
        let give_tick_id      = await this.createTicker(order['GIVE_TICK']);
        let get_coin_id       = await this.createCoin(order['GET_COIN']);
        let get_tick_id       = await this.createTicker(order['GET_TICK']);
        let status_id         = await this.createStatus(data['STATUS']);
        let give_amount       = data['MATCH_GIVE_AMOUNT'];
        let get_amount        = data['MATCH_GET_AMOUNT'];
        let settlement_type   = data['SETTLEMENT_TYPE'] || 'instant';
        let action_index      = data['ACTION_INDEX'];
        let give_action_index = match['ACTION_INDEX']
        let get_action_index  = order['ACTION_INDEX'];
        // Check if record already exists for this order_matches
        let query  = `SELECT
                            action_index
                        FROM
                            order_matches
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        order_matches
                    SET
                        give_coin_id=?,
                        give_tick_id=?,
                        give_amount=?,
                        give_action_index=?,
                        get_coin_id=?,
                        get_tick_id=?,
                        get_amount=?,
                        get_action_index=?,
                        settlement_type=?,
                        status_id=?
                    WHERE
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO order_matches (give_coin_id, give_tick_id, give_amount, give_action_index, get_coin_id, get_tick_id, get_amount, get_action_index, settlement_type, status_id, action_index) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        }
        args    = [give_coin_id, give_tick_id, give_amount, give_action_index, get_coin_id, get_tick_id, get_amount, get_action_index, settlement_type, status_id, action_index];
        results = await this.doQuery(query, args);
    }


    //////////////////////////////////////////////////////////////////////////
    // COINPay Methods
    //////////////////////////////////////////////////////////////////////////

    // Create/Update record in `coinpay_obligations` table
    // @param {data} object COINPay obligation data
    async createCoinpayObligation(data){
        data = this.normalizeDataValues(data);
        let action_index     = data['ACTION_INDEX'];
        let payer_address_id = await this.createAddress(data['PAYER_ADDRESS']);
        let payee_address_id = await this.createAddress(data['PAYEE_ADDRESS']);
        let coin_id          = await this.createCoin(data['COIN']);
        let coin_amount      = data['COIN_AMOUNT'];
        let expiration       = data['EXPIRATION'];
        let block_index      = data['BLOCK_INDEX'];
        // Check if record already exists
        let query  = `SELECT
                            action_index
                        FROM
                            coinpay_obligations
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        coinpay_obligations
                    SET
                        payer_address_id=?,
                        payee_address_id=?,
                        coin_id=?,
                        coin_amount=?,
                        expiration=?,
                        block_index=?
                    WHERE
                        action_index=?`;
            args = [payer_address_id, payee_address_id, coin_id, coin_amount, expiration, block_index, action_index];
        } else {
            // INSERT record
            query = `INSERT INTO coinpay_obligations (action_index, payer_address_id, payee_address_id, coin_id, coin_amount, expiration, block_index) values (?, ?, ?, ?, ?, ?, ?)`;
            args = [action_index, payer_address_id, payee_address_id, coin_id, coin_amount, expiration, block_index];
        }
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `coinpay_statuses` table
    // @param {action_index}         integer Action index of action that caused this status change
    // @param {coinpay_action_index} integer Action index of the coinpay obligation (ORDER_MATCH action_index)
    // @param {status}               string  Status value (pending_coinpay/fulfilled/expired/cancelled)
    async createCoinpayStatus(action_index, coinpay_action_index, status){
        let status_id = await this.createStatus(status);
        // Check if record already exists
        let query  = `SELECT
                            action_index
                        FROM
                            coinpay_statuses
                        WHERE
                            action_index=? AND
                            coinpay_action_index=?`;
        let args = [action_index, coinpay_action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        coinpay_statuses
                    SET
                        status_id=?
                    WHERE
                        action_index=? AND
                        coinpay_action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO coinpay_statuses (status_id, action_index, coinpay_action_index) values (?, ?, ?)`;
        }
        args    = [status_id, action_index, coinpay_action_index];
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `coinpay_expires` table
    // @param {action_index}            integer Action index of this COINPAY_EXPIRE action
    // @param {obligation_action_index} integer Action index of the coinpay obligation (ORDER_MATCH action_index)
    // @param {status}                  string  Status of the expire (valid/invalid)
    async createCoinpayExpire(action_index, obligation_action_index, status){
        let status_id = await this.createStatus(status);
        // Check if record already exists
        let query  = `SELECT
                            action_index
                        FROM
                            coinpay_expires
                        WHERE
                            action_index=? AND
                            obligation_action_index=?`;
        let args = [action_index, obligation_action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        coinpay_expires
                    SET
                        status_id=?
                    WHERE
                        action_index=? AND
                        obligation_action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO coinpay_expires (status_id, action_index, obligation_action_index) values (?, ?, ?)`;
        }
        args    = [status_id, action_index, obligation_action_index];
        results = await this.doQuery(query, args);
    }

    // Get COINPay obligation info by action_index
    // @param {action_index} integer The ORDER_MATCH action_index that created the obligation
    async getCoinpayObligationInfo(action_index){
        let obligation = false;
        let query = `SELECT
                        co.action_index,
                        a1.address as payer_address,
                        a2.address as payee_address,
                        c1.coin,
                        co.coin_amount,
                        co.expiration,
                        co.block_index,
                        s2.status as coinpay_status
                    FROM
                        coinpay_obligations co
                        INNER JOIN index_addresses a1 ON (a1.id=co.payer_address_id)
                        INNER JOIN index_addresses a2 ON (a2.id=co.payee_address_id)
                        INNER JOIN index_coins     c1 ON (c1.id=co.coin_id)
                        INNER JOIN coinpay_statuses s1 ON (s1.coinpay_action_index=co.action_index)
                        INNER JOIN index_statuses   s2 ON (s2.id=s1.status_id)
                    WHERE
                        s1.action_index = (
                            SELECT
                                MAX(s3.action_index)
                            FROM
                                coinpay_statuses s3
                            WHERE
                                s3.coinpay_action_index=co.action_index
                        ) AND
                        co.action_index=?
                    LIMIT 1`;
        let args = [action_index];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            obligation = {};
            for(let key in results[0]){
                let name  = String(key).toUpperCase();
                let value = results[0][key];
                if(['ACTION_INDEX', 'BLOCK_INDEX', 'EXPIRATION'].includes(name))
                    value = Number(value);
                obligation[name] = value;
            }
        }
        return obligation;
    }

    // Get all expired COINPay obligations (status=pending_coinpay and expiration < block_time)
    // @param {block_time} integer Current block timestamp
    async getExpiredCoinpayObligations(block_time){
        let expired = [];
        let query = `SELECT
                        co.action_index,
                        co.expiration
                    FROM
                        coinpay_obligations co
                        INNER JOIN coinpay_statuses s1 ON (s1.coinpay_action_index=co.action_index)
                        INNER JOIN index_statuses   s2 ON (s2.id=s1.status_id)
                    WHERE
                        s1.action_index = (
                            SELECT
                                MAX(s3.action_index)
                            FROM
                                coinpay_statuses s3
                            WHERE
                                s3.coinpay_action_index=co.action_index
                        ) AND
                        s2.status='pending_coinpay' AND
                        co.expiration < ?
                    ORDER BY co.action_index ASC`;
        let args = [block_time];
        let results = await this.doQuery(query, args);
        for(let row of results){
            expired.push({
                action_index: Number(row.action_index),
                expiration:   Number(row.expiration)
            });
        }
        return expired;
    }

    // Get order action_indexes from an ORDER_MATCH
    // @param {match_action_index} integer The ORDER_MATCH action_index
    // Returns {give_action_index, get_action_index} or false
    async getOrderMatchOrders(match_action_index){
        let query = `SELECT
                        give_action_index,
                        get_action_index
                    FROM
                        order_matches
                    WHERE
                        action_index=?
                    LIMIT 1`;
        let args = [match_action_index];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            return {
                give_action_index: Number(results[0].give_action_index),
                get_action_index:  Number(results[0].get_action_index)
            };
        }
        return false;
    }

    // Get pending COINPay obligations for a given order
    // @param {order_action_index} integer Action index of the order to check
    async getPendingCoinpayObligationsByOrder(order_action_index){
        let pending = [];
        let query = `SELECT
                        co.action_index
                    FROM
                        coinpay_obligations co
                        INNER JOIN order_matches om ON (om.action_index=co.action_index)
                        INNER JOIN coinpay_statuses s1 ON (s1.coinpay_action_index=co.action_index)
                        INNER JOIN index_statuses   s2 ON (s2.id=s1.status_id)
                    WHERE
                        s1.action_index = (
                            SELECT
                                MAX(s3.action_index)
                            FROM
                                coinpay_statuses s3
                            WHERE
                                s3.coinpay_action_index=co.action_index
                        ) AND
                        s2.status='pending_coinpay' AND
                        (om.give_action_index=? OR om.get_action_index=?)
                    ORDER BY co.action_index ASC`;
        let args = [order_action_index, order_action_index];
        let results = await this.doQuery(query, args);
        for(let row of results){
            pending.push(Number(row.action_index));
        }
        return pending;
    }

    // List this chain's OPEN cross-chain offers (SWAP + ORDER, give_coin != get_coin) for the
    // xchain-hub federation's unified matching view (XCC-2). SWAP and ORDER offers are drawn in a
    // single `UNION ALL` so ONE global `ORDER BY action_index ASC LIMIT ?` bounds the whole book
    // and the returned cursor is correct across both kinds - the previous per-kind LIMIT capped
    // swaps and orders independently, so a full page of one kind silently dropped the newest of
    // that kind while the concat lost the global keyset order. Every action carries a unique
    // global action_index (swaps and orders never collide), so the merged keyset is well defined.
    //
    // @param {limit}              integer Max rows over the merged book (caller clamps)
    // @param {after_action_index} integer Keyset cursor - return rows with action_index > this
    // @param {to_coin}            string  Optional filter: only offers whose GET_COIN equals this
    // @param {block_time}         integer Optional current block_time; when finite, offers already
    //                                     past their EFFECTIVE expiration (edit-overlaid, mirroring
    //                                     getExpiredItems: expired iff eff_expiration < block_time)
    //                                     are excluded so a stale 'open' offer awaiting its next
    //                                     block-loop expiry pass cannot occupy a bounded slot. A
    //                                     NULL/never expiration is always kept.
    //
    // Returns an array of merged offers (each tagged `kind`), carrying two out-of-band props:
    //   .truncated   - true when the page filled (rows === limit), so newer offers were dropped
    //                  and the hub must page/alarm instead of matching a partial book.
    //   .next_cursor - the largest action_index returned (feed back as after_action_index), or
    //                  null on an empty page.
    async getOpenCrossChainOffers(limit, after_action_index, to_coin, block_time){
        // Per-kind base filters: latest status is 'open' + cross-chain (give != get) + optional
        // to_coin. The effective-expiration overlay (last valid non-null edit wins, else base
        // expiration) mirrors getExpiredItems so the read filter agrees with the block loop's
        // own expiry rule. Each branch exposes the identical column list so UNION ALL is legal.
        let swapArgs  = [];
        let orderArgs = [];
        let swapWhere = [
            `ss.action_index = (SELECT MAX(s3.action_index) FROM swap_statuses s3 WHERE s3.swap_action_index=s1.action_index)`,
            `st.status='open'`,
            `s1.give_coin_id != s1.get_coin_id`
        ];
        let orderWhere = [
            `os.action_index = (SELECT MAX(s3.action_index) FROM order_statuses s3 WHERE s3.order_action_index=o1.action_index)`,
            `st.status='open'`,
            `o1.give_coin_id != o1.get_coin_id`
        ];
        // Guard null explicitly on the cursor too: Number(null) === 0 is finite, which would
        // append a pointless `action_index > 0` clause on the "no cursor" call.
        let hasCursor = !this.util.isNull(after_action_index) && Number.isFinite(Number(after_action_index));
        if(!this.util.isNull(to_coin)){ swapWhere.push(`cc.coin=?`);  swapArgs.push(to_coin); }
        if(hasCursor){ swapWhere.push(`s1.action_index>?`); swapArgs.push(Number(after_action_index)); }
        if(!this.util.isNull(to_coin)){ orderWhere.push(`cc.coin=?`); orderArgs.push(to_coin); }
        if(hasCursor){ orderWhere.push(`o1.action_index>?`); orderArgs.push(Number(after_action_index)); }
        let swapBranch = `SELECT
                        'swap' as kind,
                        s1.action_index,
                        gc.coin    as give_coin,
                        gt.tick    as give_tick,
                        s1.give_amount,
                        s1.give_ownership,
                        cc.coin    as get_coin,
                        rt.tick    as get_tick,
                        s1.get_amount,
                        s1.get_ownership,
                        ga.address as get_address,
                        sa.address as source,
                        s1.expiration,
                        s1.allow_list,
                        s1.block_list,
                        s1.payout_legs,
                        t1.block_index,
                        COALESCE((SELECT se.expiration FROM swap_edits se INNER JOIN index_statuses ses ON (ses.id=se.status_id) WHERE se.swap_action_index=s1.action_index AND ses.status='valid' AND se.expiration IS NOT NULL ORDER BY se.action_index DESC LIMIT 1), s1.expiration) as effective_expiration
                    FROM
                        swaps s1
                        INNER JOIN actions         a1 ON (a1.action_index=s1.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN index_addresses sa ON (sa.id=a1.source_id)
                        INNER JOIN index_addresses ga ON (ga.id=s1.get_address_id)
                        INNER JOIN index_coins     gc ON (gc.id=s1.give_coin_id)
                        INNER JOIN index_coins     cc ON (cc.id=s1.get_coin_id)
                        INNER JOIN index_tickers   gt ON (gt.id=s1.give_tick_id)
                        LEFT  JOIN index_tickers   rt ON (rt.id=s1.get_tick_id)
                        INNER JOIN swap_statuses   ss ON (ss.swap_action_index=s1.action_index)
                        INNER JOIN index_statuses  st ON (st.id=ss.status_id)
                    WHERE ` + swapWhere.join(' AND ');
        let orderBranch = `SELECT
                        'order' as kind,
                        o1.action_index,
                        gc.coin    as give_coin,
                        gt.tick    as give_tick,
                        o1.give_amount,
                        o1.give_ownership,
                        cc.coin    as get_coin,
                        rt.tick    as get_tick,
                        o1.get_amount,
                        o1.get_ownership,
                        ga.address as get_address,
                        sa.address as source,
                        o1.expiration,
                        o1.allow_list,
                        o1.block_list,
                        o1.payout_legs,
                        t1.block_index,
                        COALESCE((SELECT oe.expiration FROM order_edits oe INNER JOIN index_statuses oes ON (oes.id=oe.status_id) WHERE oe.order_action_index=o1.action_index AND oes.status='valid' AND oe.expiration IS NOT NULL ORDER BY oe.action_index DESC LIMIT 1), o1.expiration) as effective_expiration
                    FROM
                        orders o1
                        INNER JOIN actions         a1 ON (a1.action_index=o1.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN index_addresses sa ON (sa.id=a1.source_id)
                        INNER JOIN index_addresses ga ON (ga.id=o1.get_address_id)
                        INNER JOIN index_coins     gc ON (gc.id=o1.give_coin_id)
                        INNER JOIN index_coins     cc ON (cc.id=o1.get_coin_id)
                        LEFT  JOIN index_tickers   gt ON (gt.id=o1.give_tick_id)
                        LEFT  JOIN index_tickers   rt ON (rt.id=o1.get_tick_id)
                        INNER JOIN order_statuses  os ON (os.order_action_index=o1.action_index)
                        INNER JOIN index_statuses  st ON (st.id=os.status_id)
                    WHERE ` + orderWhere.join(' AND ');
        // Merge, then apply the expiration filter + global keyset order + single LIMIT on the
        // unified set (args ordered: swap branch, order branch, [expiration], limit).
        let args = swapArgs.concat(orderArgs);
        let outerWhere = '';
        // Guard null/undefined explicitly: Number(null) === 0 is finite, which would wrongly
        // apply a `>= 0` filter (a no-op that still diverges from the "no filter" contract).
        if(!this.util.isNull(block_time) && Number.isFinite(Number(block_time))){
            outerWhere = ` WHERE (u.effective_expiration IS NULL OR u.effective_expiration >= ?)`;
            args.push(Number(block_time));
        }
        let query = `SELECT * FROM (
                        ` + swapBranch + `
                        UNION ALL
                        ` + orderBranch + `
                    ) u` + outerWhere + `
                    ORDER BY u.action_index ASC
                    LIMIT ?`;
        args.push(Number(limit));
        let results = await this.doQuery(query, args);
        let offers = [];
        for(let row of results){
            let isOwnGive = (Number(row.give_ownership) === 1 && this.util.isNull(row.give_amount));
            let isOwnGet  = (Number(row.get_ownership)  === 1 && this.util.isNull(row.get_amount));
            let offer = {
                kind:           (row.kind === 'order') ? 'order' : 'swap',
                action_index:   Number(row.action_index),
                give_coin:      row.give_coin,
                give_tick:      row.give_tick,
                // Ownership offers carry no amount - expose virtual '1' so the hub's committed
                // ledger + amount compare work uniformly (matches getOrderInfo's convention).
                give_amount:    isOwnGive ? '1' : row.give_amount,
                give_ownership: Number(row.give_ownership),
                get_coin:       row.get_coin,
                get_tick:       row.get_tick,
                get_amount:     isOwnGet ? '1' : row.get_amount,
                get_ownership:  Number(row.get_ownership),
                get_address:    row.get_address,
                source:         row.source,
                expiration:     Number(row.expiration),
                allow_list:     row.allow_list,
                block_list:     row.block_list,
                // Controller-guard royalty split (JSON [{to,bps}] or null). The hub copies it
                // into the match row so settlement can apply it on the proceeds chain.
                payout_legs:    row.payout_legs || null,
                block_index:    Number(row.block_index)
            };
            if(offer.kind === 'order'){
                // Remaining (give/get) reflects all fills - local order_matches AND cross-chain
                // settlements (both recorded in order_matches) - so the hub's reservation is exact.
                let [give_remaining, get_remaining] = await this.getOrderAmountsRemaining(row.action_index);
                offer.give_remaining = String(give_remaining);
                offer.get_remaining  = String(get_remaining);
            }
            offers.push(offer);
        }
        // Surface truncation the same way the validator-set RPCs do: a full page means the OLDEST
        // `limit` open cross-chain offers were returned and newer ones are absent, so the hub can
        // page (via next_cursor) or alarm rather than silently matching against a partial book.
        // Results are ORDER BY action_index ASC, so the last row carries the max action_index.
        offers.truncated   = results.length >= Number(limit);
        offers.next_cursor = results.length > 0 ? Number(results[results.length - 1].action_index) : null;
        return offers;
    }

    // Record a cross-chain ORDER partial fill in order_matches so getOrderAmountsRemaining
    // deducts it - the single source of truth for an order's remaining (local fills and
    // cross-chain fills both live here, so the offer book + completion logic stay consistent).
    // The local order is the GET side of the synthetic row (get_action_index = local order),
    // so the subtract loop maps give_amount→give_remaining and get_amount→get_remaining.
    // The cross counterparty has no local order, so give_action_index = the CROSS_SETTLE
    // action_index (rollback-able: a reorg drops this row and the order's remaining restores).
    async recordCrossChainOrderFill(settlement_action_index, order_action_index, give_amount, get_amount, give_coin, give_tick, get_coin, get_tick){
        let give_coin_id = await this.createCoin(give_coin);
        let get_coin_id  = await this.createCoin(get_coin);
        let give_tick_id = this.util.isNull(give_tick) ? null : await this.createTicker(give_tick);
        let get_tick_id  = this.util.isNull(get_tick)  ? null : await this.createTicker(get_tick);
        let status_id    = await this.createStatus('valid');
        let exists = await this.doQuery(`SELECT action_index FROM order_matches WHERE action_index=?`, [settlement_action_index]);
        if(exists.length > 0) return;                          // idempotent (one fill per settlement)
        await this.doQuery(
            `INSERT INTO order_matches (give_coin_id, give_tick_id, give_amount, give_action_index, get_coin_id, get_tick_id, get_amount, get_action_index, settlement_type, status_id, action_index)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'instant', ?, ?)`,
            [give_coin_id, give_tick_id, give_amount, settlement_action_index, get_coin_id, get_tick_id, get_amount, order_action_index, status_id, settlement_action_index]);
    }

    // Finalized cross-chain matches that involve THIS chain, are effective at/before
    // block_time, and have not yet been settled locally. Drives the settlement pass.
    // cross_chain_matches is a hub-mirrored table (read via _mirrorDb), while
    // cross_chain_settlements is a local indexer table (read via this) - so we filter in JS
    // rather than join across two databases.
    //
    // Capped per block, mirroring getEffectiveUndispatchedCalls (overflow carries
    // forward; never dropped). Without it a hub backlog injected an unbounded number
    // of escrow-releasing CROSS_SETTLE actions into one block transaction.
    // The slice lands AFTER the settled-set exclusion so the cap counts real work, and
    // the ORDER BY above is a total order on quorum-agreed content, so every operator
    // takes the identical prefix. See CROSS_SETTLE_MAX_PER_BLOCK in protocol/constants.js
    // for why the cap is consensus-visible and why it lands behind the
    // CROSS_SETTLE_PER_BLOCK_CAP flag day (operator ruling of 2026-08-11).
    //
    // The `limit` is the CALLER's decision because that caller (processCrossChainSettlements)
    // is the one holding the block index the flag day is evaluated against: it passes the
    // protocol cap once the gate is on, and MAX_SAFE_INTEGER before, which is the legacy
    // uncapped pass. This method never evaluates the gate itself, so it can never disagree
    // with the caller about which side of the flag day a block is on.
    async getEffectiveUnsettledMatches(coin, block_time, limit){
        // network filter: a match only settles on the indexer of the network it was matched
        // + signed on (also bound into the signed canonical - see cross_settle._canonical).
        // ORDER BY (snapshot_block, match_id) - quorum-agreed row content, so the
        // settlement order is identical no matter which hub DB this indexer mirrors
        // (the hub-assigned id is per-hub AUTO_INCREMENT and MUST NOT order consensus
        // state).
        let network = this.config['NETWORK'];
        let matches = await this._mirrorDb().doQuery(
            `SELECT * FROM cross_chain_matches
             WHERE status = 'finalized' AND network = ? AND effective_time <= ? AND (a_chain = ? OR b_chain = ?)
             ORDER BY snapshot_block ASC, match_id ASC`,
            [network, block_time, coin, coin]);
        if(matches.length === 0) return [];
        let ids = matches.map(m => m.match_id);
        let placeholders = ids.map(() => '?').join(',');
        let settled = await this.doQuery(
            `SELECT match_id FROM cross_chain_settlements WHERE match_id IN (${placeholders})`, ids);
        // match_id is stored and compared verbatim on both sides; do not add normalization to
        // only one side (unlike call_id, the match_id is never lowercased on write, so a one-
        // sided .toLowerCase() here would DESYNC the compare rather than fix it).
        let settledSet = new Set(settled.map(r => r.match_id));
        // The no-limit default reads the protocol constant rather than repeating its value,
        // so the cap has ONE definition. A literal here would be a second copy of a
        // consensus-visible number that no test compares against the first, and the caller
        // that omitted the limit would then settle a different prefix than the one that
        // passed it. The `|| 25` tail keeps the "no uncapped path" property even if the
        // constant is ever exported as 0 or undefined, since slice(0, undefined) returns
        // the whole backlog.
        return matches.filter(m => !settledSet.has(m.match_id))
                      .slice(0, Number(limit) || CROSS_SETTLE_MAX_PER_BLOCK || 25);
    }

    // Record that this chain settled its leg of a cross-chain match (idempotent on
    // match_id). The action_index is rollback-able, so a reorg drops this row and the
    // match re-applies. Both leg references are captured here because the mirror row
    // may later be deleted by a reorg retraction - the VM's crossChain.isSettled
    // snapshot reads this local table, never the mirror (getCrossChainDataForVM).
    async recordCrossChainSettlement(action_index, match, local_action_index, block_index){
        await this.doQuery(
            `INSERT IGNORE INTO cross_chain_settlements
             (action_index, match_id, local_action_index, block_index, a_chain, a_action_index, b_chain, b_action_index)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [action_index, match.match_id, local_action_index, block_index,
             match.a_chain, Number(match.a_action_index), match.b_chain, Number(match.b_action_index)]);
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

    // Effective, unexecuted dispatch rows targeting THIS chain - drives the XEXEC
    // injection pass. cross_chain_calls is hub-mirrored (read via _mirrorDb) while
    // cross_chain_call_executions is local, so the exclusion is filtered in JS.
    // ORDER BY (snapshot_block, call_id) - both quorum-agreed row content, so the
    // injection order is identical no matter which hub DB this indexer mirrors
    // (the hub-assigned id is per-hub AUTO_INCREMENT and MUST NOT order consensus
    // state). Cap per block (overflow carries forward; never dropped).
    async getEffectiveUndispatchedCalls(coin, network, block_time, limit){
        let calls = await this._mirrorDb().doQuery(
            `SELECT * FROM cross_chain_calls
             WHERE phase = 'dispatch' AND status = 'finalized' AND network = ?
               AND target_chain = ? AND effective_time <= ?
             ORDER BY snapshot_block ASC, call_id ASC`,
            [network, coin, block_time]);
        if(calls.length === 0) return [];
        let ids = calls.map(c => c.call_id);
        let placeholders = ids.map(() => '?').join(',');
        let executed = await this.doQuery(
            `SELECT call_id FROM cross_chain_call_executions WHERE call_id IN (${placeholders})`, ids);
        // Local writes lowercase every call_id; a hub-mirrored call_id may arrive uppercase. The
        // case-insensitive collation lets the SQL prefilter match, but the executions row comes
        // back lowercase, so an unnormalized Set.has() would miss an uppercase mirror call_id and
        // re-dispatch a call already executed. Compare both sides lowercased. No-op for all-
        // lowercase data (no consensus change on the current chain).
        let executedSet = new Set(executed.map(r => String(r.call_id).toLowerCase()));
        return calls.filter(c => !executedSet.has(String(c.call_id).toLowerCase())).slice(0, Number(limit) || 25);
    }

    // Effective, unprocessed result rows for requests THIS chain originated -
    // drives the callback delivery pass. Same mirror/local split and ordering.
    //
    // cross_chain_calls is hub-mirrored (read via _mirrorDb) while the
    // cross_chain_call_callbacks idempotency table is local. When the mirror IS the
    // local DB (the hub / single-DB deployments, including the test + regtest env) we
    // push the already-processed exclusion, the deterministic ordering, and the cap
    // into one SQL statement via NOT EXISTS + ORDER BY + LIMIT, so the DB never
    // materializes the already-delivered rows into JS. This is exactly equivalent to
    // the JS path below: both tables are utf8_general_ci and every call_id is canonical
    // lowercase on both sides, so NOT EXISTS matches iff the JS Set would, the ORDER BY
    // is byte-identical, and LIMIT after the exclusion == the current filter-then-slice.
    // When the mirror is a SEPARATE hub connection the callbacks table is not reachable
    // from it, so we keep the original two-query JS filter unchanged; that remote-mirror
    // path still materializes the full effective result set each tick (finalized result
    // rows accumulate on the mirror and are re-scanned every block), a residual cost that
    // a cross-database exclusion cannot address without a cross-DB join.
    async getEffectiveUnprocessedCallResults(coin, network, block_time, limit){
        let cap = Number(limit) || 25;
        let mirror = this._mirrorDb();
        if(mirror === this){
            return await this.doQuery(
                `SELECT c.* FROM cross_chain_calls c
                 WHERE c.phase = 'result' AND c.status = 'finalized' AND c.network = ?
                   AND c.source_chain = ? AND c.effective_time <= ?
                   AND NOT EXISTS (
                       SELECT 1 FROM cross_chain_call_callbacks k WHERE k.call_id = c.call_id)
                 ORDER BY c.snapshot_block ASC, c.call_id ASC
                 LIMIT ?`,
                [network, coin, block_time, cap]);
        }
        let results = await mirror.doQuery(
            `SELECT * FROM cross_chain_calls
             WHERE phase = 'result' AND status = 'finalized' AND network = ?
               AND source_chain = ? AND effective_time <= ?
             ORDER BY snapshot_block ASC, call_id ASC`,
            [network, coin, block_time]);
        if(results.length === 0) return [];
        let ids = results.map(r => r.call_id);
        let placeholders = ids.map(() => '?').join(',');
        let processed = await this.doQuery(
            `SELECT call_id FROM cross_chain_call_callbacks WHERE call_id IN (${placeholders})`, ids);
        // Lowercase both sides: local callbacks are stored lowercase, a mirror call_id may be
        // uppercase (see getEffectiveUndispatchedCalls). No-op for all-lowercase data.
        let processedSet = new Set(processed.map(r => String(r.call_id).toLowerCase()));
        return results.filter(r => !processedSet.has(String(r.call_id).toLowerCase())).slice(0, cap);
    }

    // Record an injected target-chain execution (idempotent on call_id; the
    // action_index is rollback-able so a reorg drops this row and the call re-applies).
    async recordCrossChainCallExecution(action_index, call_id, execute_action_index, result_status, return_payload_b64, gas_used, block_index){
        await this.doQuery(
            `INSERT IGNORE INTO cross_chain_call_executions
             (action_index, call_id, execute_action_index, result_status, return_payload_b64, gas_used, block_index)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [action_index, String(call_id).toLowerCase(), execute_action_index,
             result_status, return_payload_b64, gas_used, block_index]);
        // The call made it in: any refusal diagnostics recorded while it was
        // starved (cross_chain_call_rejections) are now stale evidence.
        await this.clearCrossChainCallRejection(call_id);
    }

    // Record a REFUSED injection attempt for a dispatch row (XDISP-1 visibility).
    // Node-local diagnostics only: upserted per attempt, never consulted by the
    // injection pass (the call keeps retrying every block), deleted when the call
    // finally executes. See src/sql/cross_chain_call_rejections.sql.
    async recordCrossChainCallRejection(call_id, reason, detail, block_index){
        await this.doQuery(
            `INSERT INTO cross_chain_call_rejections
             (call_id, reason, detail, attempts, first_block, last_block)
             VALUES (?, ?, ?, 1, ?, ?)
             ON DUPLICATE KEY UPDATE
                reason     = VALUES(reason),
                detail     = VALUES(detail),
                attempts   = attempts + 1,
                last_block = VALUES(last_block)`,
            [String(call_id).toLowerCase(), String(reason),
             detail == null ? null : String(detail).substring(0, 250),
             block_index, block_index]);
    }

    // Drop the refusal diagnostics for a call (called once it executes).
    async clearCrossChainCallRejection(call_id){
        await this.doQuery(
            `DELETE FROM cross_chain_call_rejections WHERE call_id = ?`,
            [String(call_id).toLowerCase()]);
    }

    // Refusal diagnostics for a single call (getcrosschaincallresult enrichment).
    async getCrossChainCallRejectionById(call_id){
        let rows = await this.doQuery(
            `SELECT * FROM cross_chain_call_rejections WHERE call_id = ? LIMIT 1`,
            [String(call_id).toLowerCase()]);
        return rows.length > 0 ? rows[0] : null;
    }

    // Execution outcome for a call on THIS (target) chain (getcrosschaincallresult RPC).
    async getCrossChainCallExecutionById(call_id){
        let rows = await this.doQuery(
            `SELECT * FROM cross_chain_call_executions WHERE call_id = ? LIMIT 1`,
            [String(call_id).toLowerCase()]);
        return rows.length > 0 ? rows[0] : null;
    }

    // Record a processed result row (idempotent on call_id; rollback-able).
    async recordCrossChainCallCallback(action_index, call_id, result_status, block_index){
        await this.doQuery(
            `INSERT IGNORE INTO cross_chain_call_callbacks
             (action_index, call_id, result_status, block_index)
             VALUES (?, ?, ?, ?)`,
            [action_index, String(call_id).toLowerCase(), result_status, block_index]);
    }

    // Create/Update record in `coinpays` table (fulfilled COINPay payments)
    // @param {data} object COINPay payment data
    async createCoinpay(data){
        data = this.normalizeDataValues(data);
        let action_index            = data['ACTION_INDEX'];
        let obligation_action_index = data['OBLIGATION_ACTION_INDEX'];
        let coin_amount             = data['COIN_AMOUNT'];
        let txid                    = data['TXID'];
        let vout                    = data['VOUT'];
        let status_id               = await this.createStatus(data['STATUS']);
        let block_index             = data['BLOCK_INDEX'];
        // Check if record already exists
        let query  = `SELECT
                            action_index
                        FROM
                            coinpays
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        coinpays
                    SET
                        obligation_action_index=?,
                        coin_amount=?,
                        txid=?,
                        vout=?,
                        status_id=?,
                        block_index=?
                    WHERE
                        action_index=?`;
            args = [obligation_action_index, coin_amount, txid, vout, status_id, block_index, action_index];
        } else {
            // INSERT record
            query = `INSERT INTO coinpays (action_index, obligation_action_index, coin_amount, txid, vout, status_id, block_index) values (?, ?, ?, ?, ?, ?, ?)`;
            args = [action_index, obligation_action_index, coin_amount, txid, vout, status_id, block_index];
        }
        results = await this.doQuery(query, args);
    }

    // Get ORDER_MATCH give/get amounts
    // @param {match_action_index} integer The ORDER_MATCH action_index
    // Returns {give_action_index, get_action_index, give_amount, get_amount} or false
    async getOrderMatchAmounts(match_action_index){
        let query = `SELECT
                        give_action_index,
                        get_action_index,
                        give_amount,
                        get_amount
                    FROM
                        order_matches
                    WHERE
                        action_index=?
                    LIMIT 1`;
        let args = [match_action_index];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            return {
                give_action_index: Number(results[0].give_action_index),
                get_action_index:  Number(results[0].get_action_index),
                give_amount:       results[0].give_amount,
                get_amount:        results[0].get_amount
            };
        }
        return false;
    }


    // Create records in the 'mappings_actions' table
    async createActionMapping(action_index, type, value){
        let type_id = null,
            id      = null;
        if(type=='tick'){
            type_id = 1;
            id      = await this.createTicker(value);
        }
        if(type=='address'){
            type_id = 2;
            id      = await this.createAddress(value);
        }
        // A wire ^<id> reference that does not resolve to an existing block-stamped row
        // yields a null id (getAddressId/getTickerId, commit 0b023b2). There is no entity
        // to map, so skip the row rather than INSERT NULL into the NOT-NULL id column,
        // which aborts the whole block on a reindex. Matches 0b023b2's "treat as a no-op
        // rather than mint a bogus row" contract; mappings_actions is a lookup index, not
        // consensus-hashed, so skipping a dangling-ref mapping changes no block hashes.
        if(this.util.isNull(id))
            return;
        // Check if record already exists
        let query  = `SELECT
                            action_index
                        FROM
                            mappings_actions
                        WHERE
                            action_index=? AND
                            type_id=? AND
                            id=?`;
        let args = [action_index, type_id, id];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        // Create record if it does not already exist
        if(!exists){
            query   = `INSERT INTO mappings_actions (action_index, type_id, id) values (?, ?, ?)`;
            results = await this.doQuery(query, args);
        }
    }

    // Batched sibling of createActionMapping(): resolves every value's id and writes all
    // rows for one (action_index, type) in as few round-trips as possible instead of one
    // SELECT+INSERT pair per value. Used by mapper.js for recipient-scaling actions
    // (DIVIDEND/AIRDROP/CALLBACK) where the address/tick list can hold thousands of entries.
    // Preserves createActionMapping's semantics exactly: same dangling-^<id>-reference skip,
    // same existing-row de-duplication, no rows written for an empty list.
    async createActionMappings(action_index, type, values){
        if(this.util.isNull(values) || values.length === 0)
            return;
        let type_id = null;
        if(type=='tick')
            type_id = 1;
        if(type=='address')
            type_id = 2;
        if(this.util.isNull(type_id))
            return;

        // Resolve ids one at a time (createTicker/createAddress are themselves cached lookups),
        // skipping dangling ^<id> references (null id) and de-duplicating within this batch.
        let ids = [];
        for(let value of values){
            let id = (type=='tick') ? await this.createTicker(value) : await this.createAddress(value);
            if(this.util.isNull(id))
                continue;
            if(!ids.includes(id))
                ids.push(id);
        }
        if(ids.length === 0)
            return;

        // Skip ids that already carry a mapping row for this action_index/type, matching
        // createActionMapping's existing-record guard, so the batched INSERT never collides.
        let existsQuery = `SELECT id FROM mappings_actions WHERE action_index=? AND type_id=? AND id IN (${ids.map(() => '?').join(', ')})`;
        let existsRows  = await this.doQuery(existsQuery, [action_index, type_id, ...ids]);
        let existingIds = existsRows.map(row => row.id);
        let toInsert    = ids.filter(id => !existingIds.includes(id));
        if(toInsert.length === 0)
            return;

        // Chunk the multi-row INSERT so a very large recipient list cannot exceed the
        // driver's bound-parameter limit.
        let chunkSize = 500;
        for(let i = 0; i < toInsert.length; i += chunkSize){
            let chunk        = toInsert.slice(i, i + chunkSize);
            let placeholders = chunk.map(() => '(?, ?, ?)').join(', ');
            let args         = [];
            for(let id of chunk)
                args.push(action_index, type_id, id);
            let query = `INSERT INTO mappings_actions (action_index, type_id, id) values ${placeholders}`;
            await this.doQuery(query, args);
        }
    }

    // Create records in the 'mappings_files' table
    async createFileMapping(action_index, type, value){
        let type_id = null,
            id      = null;
        if(type=='tick'){
            type_id = 1;
            id      = await this.createTicker(value);
        }
        // Same null-guard as createActionMapping: a dangling ^<id> ticker reference
        // resolves to null (0b023b2); skip the lookup-index row instead of inserting NULL
        // into the NOT-NULL id column and aborting the block. mappings_files is not
        // consensus-hashed, so this changes no block hashes.
        if(this.util.isNull(id))
            return;
        // Check if record already exists
        let query  = `SELECT
                            action_index
                        FROM
                            mappings_files
                        WHERE
                            action_index=? AND
                            type_id=? AND
                            id=?`;
        let args = [action_index, type_id, id];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        // Create record if it does not already exist
        if(!exists){
            query   = `INSERT INTO mappings_files (action_index, type_id, id) values (?, ?, ?)`;
            results = await this.doQuery(query, args);
        }
    }

    // Get existence + block height + type for a given action_index. Serves the
    // getactionconfirmations API method, which lets the xchain-hub federation
    // confirm that a proposed cross-chain source action really exists on this
    // chain (and at what depth) before co-signing an attestation.
    async getActionInfo(action_index){
        let args = [action_index];
        let sql  = `SELECT
                        a1.action_index,
                        a1.block_index,
                        a2.action
                    FROM
                        actions a1
                        INNER JOIN index_actions a2 ON (a2.id=a1.action_id)
                    WHERE
                        a1.action_index=?
                    LIMIT 1`;
        let results = await this.doQuery(sql, args);
        return (results && results.length) ? results[0] : null;
    }

    // Get action type for a given action_index
    async getActionType(action_index){
        let type = null;
        // Lookup the ACTION based on the action_index
        let args = [action_index];
        let sql  = `SELECT 
                        a2.action
                    FROM
                        actions a1
                        INNER JOIN index_actions a2 ON (a2.id=a1.action_id)
                    WHERE
                        a1.action_index=?`;
        let results = await this.doQuery(sql, args);
        if(results && results.length)
            type = results[0].action;
        return type;
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

    // Lookup items that need to be expired and return a list
    //
    // The expiration cut is applied IN SQL. It used to pull the ENTIRE
    // open order/swap/dispenser book back to the client every block, resolve the
    // edits overlay with a second batched query per type, and only then apply the
    // cutoff in JS, so per-block row transfer and memory scaled with the whole
    // open book rather than the (usually tiny) set expiring this block. The
    // returned rows, their order, and their values are unchanged.
    //
    // NULL expiration semantics - CONSENSUS-CRITICAL, preserved exactly:
    // all six `expiration` columns (orders/swaps/dispensers and their `_edits`)
    // are nullable. The old JS predicate was `info.expiration < block_time`,
    // where JS coerces a null expiration to 0, so a null effective expiration
    // meant "expired at time 0" and the item expired on the first block that
    // swept it. A naive SQL `eff_expiration < ?` evaluates to NULL for those
    // rows, drops them, and that item would NEVER expire - a silent consensus
    // change. `COALESCE(eff_expiration, 0) < ?` is the byte-equivalent form and
    // is what is used below. Note this deliberately does NOT agree with
    // getOpenCrossChainOffers, which keeps a null-expiration offer as
    // never-expiring; that divergence is pre-existing and out of scope here.
    // In practice a null BASE expiration is unreachable on current code: the
    // ORDER/SWAP/DISPENSER create handlers all fill in util.getDefaultExpiration()
    // when the field is absent. Null EDIT expirations are normal and mean "leave
    // the expiration unchanged".
    //
    // Effective expiration = the last `valid` edit carrying a non-null expiration
    // (highest edit action_index), else the base row's expiration. That is the
    // same rule the old ascending "last non-null wins" JS loop implemented, and
    // the same overlay getOpenCrossChainOffers applies.
    async getExpiredItems(block_time){
        let expired = [];
        let types   = ['order','swap','dispenser'];
        let query   = '';
        let args    = [];
        // A non-numeric block_time made every old JS compare false (`x < undefined`,
        // `x < null` compared against 0), so nothing expired. Return that same answer
        // instead of binding NULL/NaN into SQL, where comparison semantics differ.
        let cutoff = Number(block_time);
        if(this.util.isNull(block_time) || !Number.isFinite(cutoff))
            return expired;
        // Build out the query for each of the table types to get 'open' items whose
        // effective expiration has already passed.
        for(let type of types){
            if(query!='')
                query += 'UNION ';
            // Scalar subquery for the edits overlay: newest `valid` edit that actually
            // set an expiration wins, NULL when the item has no such edit.
            let editExpiration = `(
                            SELECT
                                e1.expiration
                            FROM
                                ` + type + `_edits e1
                                INNER JOIN index_statuses e2 ON (e2.id=e1.status_id)
                            WHERE
                                e1.` + type + `_action_index=m.action_index AND
                                e2.status='valid' AND
                                e1.expiration IS NOT NULL
                            ORDER BY
                                e1.action_index DESC
                            LIMIT 1
                        )`;
            query += `SELECT
                        m.action_index,
                        COALESCE(` + editExpiration + `, m.expiration) as expiration,
                        '` + type + `' as type
                    FROM
                        ` + type + `s m
                        INNER JOIN ` + type + `_statuses s1 ON (s1.` + type + `_action_index=m.action_index)
                        INNER JOIN index_statuses        s2 ON (s2.id=s1.status_id)
                    WHERE
                        s1.action_index = (
                            SELECT
                                MAX(s3.action_index)
                            FROM
                                ` + type + `_statuses s3
                            WHERE
                                s3.` + type + `_action_index=m.action_index
                        ) AND
                        s2.status='open' AND
                        COALESCE(` + editExpiration + `, m.expiration, 0) < ? `;
            args.push(cutoff);
        }
        // Process expirations in ascending global action_index order so every
        // instance derives identical AUTO_INCREMENT IDs for the same block.
        // (UNION result: order by the output column name, not a table alias.)
        query += ' ORDER BY action_index ASC';
        let results = await this.doQuery(query, args);
        for(let info of results){
            expired.push({
                type:         info.type,
                action_index: Number(info.action_index),
                // Number(null) === 0, matching the old null-coerced expiration value.
                expiration:   Number(info.expiration)
            });
        }
        return expired;
    }

    // Lookup market pairs by block
    // TODO: Circle back and add support for cross-chain market data (different coin_id)
    async getMarkets(block_index, update){
        let markets    = [];
        // Orientation-free keys of the pairs already collected, so the dedupe below is a lookup
        // instead of a full rescan of `markets` per row (the old scan never broke on a hit, so
        // the cost was O(rows x pairs) on the block path). Spans every order type, matching the
        // array it shadows. NULL tick ids are deliberately left OUT of the key set: a NULL never
        // loose-equalled a stored Number, so the old scan pushed those rows unconditionally, and
        // both consumers (createMarket / updateMarkets) are idempotent on the repeats.
        let marketKeys = new Set();
        let args       = [block_index];
        let counts     = false;
        let query      = '';
        let where      = 'b1.block_index=? AND ';
        // Get the time right now and the time 24 hours ago
        let time_now   = await this.getBlockTime(block_index),
            time_24hr  = this.util.bcsub(time_now, 86400);
        // Quickly check if we have any ORDER, ORDER_MATCH, ORDER_EXPIRE, or ORDER_CANCEL events for the given block
        query = `SELECT
                    count(*) as count,
                    a2.action as type
                FROM
                    actions a1
                    INNER JOIN index_actions a2 ON (a2.id=a1.action_id)
                WHERE
                    a1.block_index=? AND
                    a2.action IN ('ORDER','ORDER_MATCH','ORDER_EXPIRE','ORDER_CANCEL')
                GROUP BY a2.action
                ORDER BY a2.action`;
        counts = await this.doQuery(query, args);
        // Updates to find markets which have not been updated in the last 24 hours
        if(update){
            where = `(a1.block_index=? OR b1.block_time < ? ) AND `;
            let types = ['ORDER','ORDER_MATCH','ORDER_EXPIRE','ORDER_CANCEL'];
            for(let type of types){
                let found = false;
                for(let item of counts){
                    if(item.type==type)
                        found = true;
                }
                if(!found){
                    counts.push({
                        count: 1,
                        type: type
                    });
                }
            }
        }
        // Loop through order action types and get list of market pairs
        for(let info of counts){
            let pairs = [],
                query = false,
                type  = info.type,
                table = String(type).toLowerCase() + ((type.includes('_MATCH')) ? 'es' : 's');
            // Set the arguments
            if(update){
                args = [block_index, time_24hr, 'valid'];
            } else {
                args = [block_index, 'valid'];
            }
            if(['ORDER','ORDER_MATCH'].includes(type)){
                query = `SELECT 
                            o1.action_index,
                            o1.get_tick_id  as tick1_id,
                            o1.give_tick_id as tick2_id
                        FROM
                            ` + table + ` o1
                            INNER JOIN actions        a1 ON (a1.action_index=o1.action_index)
                            INNER JOIN blocks         b1 ON (b1.block_index=a1.block_index)
                            INNER JOIN index_coins    c1 ON (c1.id=o1.give_coin_id)
                            INNER JOIN index_statuses s1 ON (s1.id=o1.status_id)
                        WHERE
                            ` + where + `
                            o1.give_coin_id=o1.get_coin_id AND
                            s1.status=?
                        ORDER BY o1.action_index ASC`;
            } else if(['ORDER_CANCEL','ORDER_EXPIRE'].includes(type)){
                query = `SELECT 
                            o1.action_index,
                            o2.get_tick_id  as tick1_id,
                            o2.give_tick_id as tick2_id
                        FROM
                            ` + table + ` o1
                            INNER JOIN orders         o2 ON (o2.action_index=o1.order_action_index)
                            INNER JOIN actions        a1 ON (a1.action_index=o1.action_index)
                            INNER JOIN blocks         b1 ON (b1.block_index=a1.block_index)
                            INNER JOIN index_statuses s1 ON (s1.id=o1.status_id)
                        WHERE
                            ` + where + `
                            s1.status=?
                        ORDER BY o1.action_index ASC`;
            }
            if(query){
                let results = await this.doQuery(query, args);
                if(results.length > 0){
                    for(let row of results){
                        // Check if this pair already exists (either orientation)
                        let tick1_id = Number(row.tick1_id);
                        let tick2_id = Number(row.tick2_id);
                        // order_matches carries a NULL tick id on the native-coin side of a
                        // COINPay match; keep those rows on the old unconditional-push path.
                        let keyed = !this.util.isNull(row.tick1_id) && !this.util.isNull(row.tick2_id);
                        let key   = Math.min(tick1_id, tick2_id) + ':' + Math.max(tick1_id, tick2_id);
                        if(!keyed || !marketKeys.has(key)){
                            if(keyed)
                                marketKeys.add(key);
                            markets.push({ tick1_id, tick2_id });
                        }
                    }
                }
           }
        }
        return markets;
    }

    // Get market_id for given ticker ids
    async getMarketId(tick1_id, tick2_id){
        let id     = null;
        let query  = `SELECT
                            id
                        FROM
                            markets m
                        WHERE
                            (m.tick1_id=? AND m.tick2_id=?) OR
                            (m.tick1_id=? AND m.tick2_id=?)`;
        let args = [tick1_id, tick2_id, tick2_id, tick1_id];
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            id = results[0].id;
        return id;
    }

    // Create record in `markets` table
    async createMarket(tick1_id, tick2_id){
        let id = await this.getMarketId(tick1_id, tick2_id);
        if(id==null){
            // ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id) makes a concurrent
            // insert of the same pair a no-op while still returning the existing
            // row's id via insertId. Combined with the UNIQUE(tick1_id, tick2_id)
            // key this prevents two rows ever being created for the same pair if
            // two inserts race past the getMarketId check above.
            let query = `INSERT INTO markets (tick1_id, tick2_id) values (?, ?)
                         ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`;
            let args  = [tick1_id, tick2_id];
            let results = await this.doQuery(query, args);
            if(results.insertId)
                id = Number(results.insertId);
        }
        return id;
    }

    // Handle getting information on a given market
    async getMarketInfo(market_id, block_time){
        // Define response object
        let data = {
            tick1_price       : 0,
            tick1_bid         : 0,
            tick1_ask         : 0,
            tick1_24hr_price  : 0,
            tick1_24hr_high   : 0,
            tick1_24hr_low    : 0,
            tick1_24hr_change : 0,
            tick1_24hr_volume : 0,
            tick2_price       : 0,
            tick2_bid         : 0,
            tick2_ask         : 0,
            tick2_24hr_price  : 0,
            tick2_24hr_high   : 0,
            tick2_24hr_low    : 0,
            tick2_24hr_change : 0,
            tick2_24hr_volume : 0,
        };
        // Get the time right now and the time 24 hours ago
        let time_now  = block_time,
            time_24hr = this.util.bcsub(time_now, 86400);
        // Set the last time this info was updated to now
        data.last_updated = time_now;
        // Lookup basic information on this market (tick, tick_id, decimals)
        let query = `SELECT
                            m1.id       as market_id,
                            t3.tick     as tick1,
                            t1.tick_id  as tick1_id,
                            t1.decimals as tick1_decimals,
                            t4.tick     as tick2,
                            t2.tick_id  as tick2_id,
                            t2.decimals as tick2_decimals
                        FROM
                            markets m1
                            INNER JOIN tokens        t1 ON (t1.tick_id=m1.tick1_id)
                            INNER JOIN tokens        t2 ON (t2.tick_id=m1.tick2_id)
                            INNER JOIN index_tickers t3 ON (t3.id=t1.tick_id)
                            INNER JOIN index_tickers t4 ON (t4.id=t2.tick_id)
                        WHERE 
                            m1.id=?`;
        let args  = [market_id];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            let row = results[0];
            // Convert the ids from BIGINT to Number
            row.market_id = Number(row.market_id);
            row.tick1_id  = Number(row.tick1_id);
            row.tick2_id  = Number(row.tick2_id);
            Object.assign(data, row);
        }
        // Lookup last trade prices
        query = `SELECT
                m1.give_tick_id,
                m1.give_amount,
                m1.get_tick_id,
                m1.get_amount
            FROM 
                order_matches m1
                INNER JOIN index_statuses s1 ON (s1.id=m1.status_id)
            WHERE
                m1.give_coin_id=m1.get_coin_id AND 
                ((m1.give_tick_id=? AND m1.get_tick_id=?) OR (m1.give_tick_id=? AND m1.get_tick_id=?))  AND
                s1.status=?
            ORDER BY m1.action_index DESC 
            LIMIT 1`;
        args    = [data.tick1_id, data.tick2_id, data.tick2_id, data.tick1_id, 'valid'];
        results = await this.doQuery(query, args);
        if(results.length > 0){
            let row = results[0];
            let give_amount = (row.give_tick_id==data.tick1_id) ? row.give_amount : row.get_amount;
            let get_amount  = (row.give_tick_id==data.tick1_id) ? row.get_amount  : row.give_amount;
            data.tick1_price = this.util.getPrice(get_amount, give_amount);
            data.tick2_price = this.util.getPrice(give_amount, get_amount);
        }
        // Lookup trade prices 24-hours ago
        query = `SELECT
                m1.give_tick_id,
                m1.give_amount,
                m1.get_tick_id,
                m1.get_amount
            FROM 
                order_matches m1
                INNER JOIN index_statuses s1 ON (s1.id=m1.status_id)
                INNER JOIN actions        a1 ON (a1.action_index=m1.action_index)
                INNER JOIN blocks         b1 ON (b1.block_index=a1.block_index)
            WHERE
                m1.give_coin_id=m1.get_coin_id AND 
                ((m1.give_tick_id=? AND m1.get_tick_id=?) OR (m1.give_tick_id=? AND m1.get_tick_id=?))  AND
                s1.status=? AND
                b1.block_time <= ?
            ORDER BY m1.action_index DESC 
            LIMIT 1`;
        args    = [data.tick1_id, data.tick2_id, data.tick2_id, data.tick1_id, 'valid', time_24hr];
        results = await this.doQuery(query, args);
        if(results.length > 0){
            let row = results[0];
            let give_amount = (row.give_tick_id==data.tick1_id) ? row.give_amount : row.get_amount;
            let get_amount  = (row.give_tick_id==data.tick1_id) ? row.get_amount  : row.give_amount;
            data.tick1_24hr_price = this.util.getPrice(get_amount, give_amount);
            data.tick2_24hr_price = this.util.getPrice(give_amount, get_amount);
        }
        // Lookup 'bid' prices
        query = `SELECT
                o1.give_tick_id,
                o1.give_amount,
                o1.get_tick_id,
                o1.get_amount
            FROM 
                orders o1
                INNER JOIN order_statuses s1 ON (s1.order_action_index=o1.action_index)
                INNER JOIN index_statuses s2 ON (s2.id=o1.status_id)
                INNER JOIN index_statuses s3 ON (s3.id=s1.status_id)
            WHERE
                o1.give_coin_id=o1.get_coin_id AND 
                ((o1.give_tick_id=? AND o1.get_tick_id=?) OR (o1.give_tick_id=? AND o1.get_tick_id=?))  AND
                s2.status=? AND
                s3.status=? AND
                s1.action_index = (
                    SELECT
                        MAX(s4.action_index)
                    FROM
                        order_statuses s4
                    WHERE
                        s4.order_action_index = o1.action_index
                )
            ORDER BY o1.action_index DESC`;
        args    = [data.tick1_id, data.tick2_id, data.tick2_id, data.tick1_id, 'valid', 'open'];
        results = await this.doQuery(query, args);
        if(results.length > 0){
            let tick1_bid = 0,
                tick2_bid = 0;
            for(let row of results){
                let give_amount = (row.give_tick_id==data.tick1_id) ? row.give_amount : row.get_amount;
                let get_amount  = (row.give_tick_id==data.tick1_id) ? row.get_amount : row.give_amount;
                let price1      = this.util.getPrice(get_amount, give_amount);
                let price2      = this.util.getPrice(give_amount, get_amount);
                if(price1==0||price2==0)
                    continue;
                if(tick1_bid==0) tick1_bid = price1;
                if(tick2_bid==0) tick2_bid = price2;
                if(price1 > tick1_bid) tick1_bid = price1;
                if(price2 > tick2_bid) tick2_bid = price2;
            }
            data.tick1_bid  = tick1_bid;
            data.tick2_bid  = tick2_bid;
        }
        // Lookup 'ask' prices
        query = `SELECT
                o1.give_tick_id,
                o1.give_amount,
                o1.get_tick_id,
                o1.get_amount
            FROM 
                orders o1
                INNER JOIN order_statuses s1 ON (s1.order_action_index=o1.action_index)
                INNER JOIN index_statuses s2 ON (s2.id=o1.status_id)
                INNER JOIN index_statuses s3 ON (s3.id=s1.status_id)
            WHERE
                o1.give_coin_id=o1.get_coin_id AND 
                ((o1.give_tick_id=? AND o1.get_tick_id=?) OR (o1.give_tick_id=? AND o1.get_tick_id=?))  AND
                s2.status=? AND
                s3.status=? AND
                s1.action_index = (
                    SELECT
                        MAX(s4.action_index)
                    FROM
                        order_statuses s4
                    WHERE
                        s4.order_action_index = o1.action_index
                )
            ORDER BY o1.action_index DESC`;
        args    = [data.tick1_id, data.tick2_id, data.tick2_id, data.tick1_id, 'valid', 'open'];
        results = await this.doQuery(query, args);
        if(results.length > 0){
            let tick1_ask = 0,
                tick2_ask = 0;
            for(let row of results){
                let give_amount = (row.give_tick_id==data.tick1_id) ? row.give_amount : row.get_amount;
                let get_amount  = (row.give_tick_id==data.tick1_id) ? row.get_amount : row.give_amount;
                let price1      = this.util.getPrice(get_amount, give_amount);
                let price2      = this.util.getPrice(give_amount, get_amount);
                if(price1==0||price2==0)
                    continue;
                if(tick1_ask==0) tick1_ask = price1;
                if(tick2_ask==0) tick2_ask = price2;
                if(price1 < tick1_ask) tick1_ask = price1;
                if(price2 < tick2_ask) tick2_ask = price2;
            }
            data.tick1_ask = tick1_ask;
            data.tick2_ask = tick2_ask;
        }
        // Lookup all order matches in the last 24-hours
        query = `SELECT
                m1.give_tick_id,
                m1.give_amount,
                m1.get_tick_id,
                m1.get_amount
            FROM 
                order_matches m1
                INNER JOIN index_statuses s1 ON (s1.id=m1.status_id)
                INNER JOIN actions        a1 ON (a1.action_index=m1.action_index)
                INNER JOIN blocks         b1 ON (b1.block_index=a1.block_index)
            WHERE
                m1.give_coin_id=m1.get_coin_id AND 
                ((m1.give_tick_id=? AND m1.get_tick_id=?) OR (m1.give_tick_id=? AND m1.get_tick_id=?))  AND
                s1.status=? AND
                b1.block_time >= ?
            ORDER BY m1.action_index DESC`;
        args    = [data.tick1_id, data.tick2_id, data.tick2_id, data.tick1_id, 'valid', time_24hr];
        results = await this.doQuery(query, args);
        if(results.length > 0){
            let tick1_high   = 0,
                tick1_low    = 0,
                tick1_volume = 0,
                tick2_high   = 0,
                tick2_low    = 0,
                tick2_volume = 0;
            for(let row of results){
                let give_amount = (row.give_tick_id==data.tick1_id) ? row.give_amount : row.get_amount;
                let get_amount  = (row.give_tick_id==data.tick1_id) ? row.get_amount : row.give_amount;
                let price1      = this.util.getPrice(get_amount, give_amount);
                let price2      = this.util.getPrice(give_amount, get_amount);
                // Set tick high/low prices
                if(tick1_high==0 && tick1_low==0){
                    tick1_high = price1;
                    tick1_low  = price1;
                }
                if(tick2_high==0 && tick2_low==0){
                    tick2_high = price2;
                    tick2_low  = price2;
                }
                // 24-hour high
                if(price1 > tick1_high) tick1_high = price1;
                if(price2 > tick2_high) tick2_high = price2;
                // 24-hour low
                if(price1 < tick1_low) tick1_low = price1;
                if(price2 < tick2_low) tick2_low = price2;
                // 24-hour volumes
                tick1_volume = this.util.bcadd(tick1_volume, give_amount);
                tick2_volume = this.util.bcadd(tick2_volume, get_amount);
            }
            data.tick1_24hr_high   = tick1_high;
            data.tick1_24hr_low    = tick1_low;
            data.tick1_24hr_volume = tick1_volume;
            data.tick2_24hr_high   = tick2_high;
            data.tick2_24hr_low    = tick2_low;
            data.tick2_24hr_volume = tick2_volume;
        }
        // Calculate 24-hour price change percentage
        let tick1_change = 0.00;
        let tick2_change = 0.00;
        if(this.util.bcgt(data.tick1_price, 0) && this.util.bcgt(data.tick1_24hr_price, 0))
            tick1_change = this.util.bcmul(this.util.bcdiv(this.util.bcsub(data.tick1_price, data.tick1_24hr_price,8), data.tick1_24hr_price,8), 100, 2);
        if(this.util.bcgt(data.tick2_price, 0) && this.util.bcgt(data.tick2_24hr_price, 0))
            tick2_change = this.util.bcmul(this.util.bcdiv(this.util.bcsub(data.tick2_price, data.tick2_24hr_price,8), data.tick2_24hr_price,8), 100, 2);
        data.tick1_24hr_change = tick1_change;
        data.tick2_24hr_change = tick2_change;
        // Sort the market data object 
        data = this.util.ksort(data);
        return data;
    }

    // Update market information for a given market_id
    async updateMarketInfo(data){
        let market_id    = data.market_id;
        let tick1_price       = data.tick1_price;
        let tick1_bid         = data.tick1_bid;
        let tick1_ask         = data.tick1_ask;
        let tick1_24hr_price  = data.tick1_24hr_price;
        let tick1_24hr_high   = data.tick1_24hr_high;
        let tick1_24hr_low    = data.tick1_24hr_low;
        let tick1_24hr_change = data.tick1_24hr_change;
        let tick1_24hr_volume = data.tick1_24hr_volume;
        let tick2_price       = data.tick2_price;
        let tick2_bid         = data.tick2_bid;
        let tick2_ask         = data.tick2_ask;
        let tick2_24hr_price  = data.tick2_24hr_price;
        let tick2_24hr_high   = data.tick2_24hr_high;
        let tick2_24hr_low    = data.tick2_24hr_low;
        let tick2_24hr_change = data.tick2_24hr_change;
        let tick2_24hr_volume = data.tick2_24hr_volume;
        let last_updated      = data.last_updated;
        let query = `UPDATE 
                        markets
                    SET
                        tick1_price=?,
                        tick1_bid=?,
                        tick1_ask=?,
                        tick1_24hr_price=?,
                        tick1_24hr_high=?,
                        tick1_24hr_low=?,
                        tick1_24hr_change=?,
                        tick1_24hr_volume=?,
                        tick2_price=?,
                        tick2_bid=?,
                        tick2_ask=?,
                        tick2_24hr_price=?,
                        tick2_24hr_high=?,
                        tick2_24hr_low=?,
                        tick2_24hr_change=?,
                        tick2_24hr_volume=?,
                        last_updated=?
                    WHERE
                        id=?`;
        let args    = [tick1_price, tick1_bid, tick1_ask, tick1_24hr_price, tick1_24hr_high, tick1_24hr_low, tick1_24hr_change, tick1_24hr_volume, tick2_price, tick2_bid, tick2_ask, tick2_24hr_price, tick2_24hr_high, tick2_24hr_low, tick2_24hr_change, tick2_24hr_volume, last_updated, market_id];
        let results = await this.doQuery(query, args);
    }

    // Bounded batch of the most-stale existing market rows for the throttled 24h rolling-stats
    // ageing sweep (processMarketUpdates). Returns market ids whose stats were last refreshed
    // before `time_24hr` (NULL = never), oldest-first, capped at `limit`, so per-block refresh
    // cost is bounded by the cap rather than the total active-market count. The `markets` table is
    // unhashed / snapshot-replicated with no consensus reader (see rollback.js IDX-2), so a
    // node-local sweep cadence cannot diverge block state. ORDER BY (last_updated, id) is stable.
    async getStaleMarkets(time_24hr, limit){
        let max = Number(limit);
        if(!Number.isFinite(max) || max <= 0) max = 25;
        let rows = await this.doQuery(
            `SELECT id
             FROM markets
             WHERE last_updated IS NULL OR last_updated < ?
             ORDER BY (last_updated IS NULL) DESC, last_updated ASC, id ASC
             LIMIT ?`,
            [time_24hr, max]);
        return rows || [];
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


    // Create/Update record in `dispenses` table
    async createDispense(data){
        data                       = this.normalizeDataValues(data);
        let give_coin_id           = await this.createCoin(data['GIVE_COIN']);
        let give_tick_id           = await this.createTicker(data['GIVE_TICK']);
        let get_coin_id            = await this.createCoin(data['GET_COIN']);
        let get_tick_id            = await this.createTicker(data['GET_TICK']);
        let destination_id         = await this.createAddress(data['DESTINATION']);
        let status_id              = await this.createStatus(data['STATUS']);
        let action_index           = data['ACTION_INDEX'];
        let give_amount            = data['GIVE_AMOUNT'];
        let get_amount             = data['GET_AMOUNT'];
        let dispenser_action_index = data['DISPENSER_ACTION_INDEX'];
        // Check if record already exists for this dispenser
        let query  = `SELECT
                            action_index
                        FROM
                            dispenses
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        dispenses
                    SET
                        dispenser_action_index=?,
                        give_coin_id=?,
                        give_tick_id=?,
                        give_amount=?,
                        get_coin_id=?,
                        get_tick_id=?,
                        get_amount=?,
                        destination_id=?,
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO dispenses (dispenser_action_index, give_coin_id, give_tick_id, give_amount, get_coin_id, get_tick_id, get_amount, destination_id, status_id, action_index) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        }
        args    = [dispenser_action_index, give_coin_id, give_tick_id, give_amount, get_coin_id, get_tick_id, get_amount, destination_id, status_id, action_index];
        results = await this.doQuery(query, args);
    }    

    // Create/Update record in `dispensers` table
    async createDispenser(data){
        data                  = this.normalizeDataValues(data);
        let give_coin_id      = await this.createCoin(data['GIVE_COIN']);
        let give_tick_id      = await this.createTicker(data['GIVE_TICK']);
        let get_coin_id       = await this.createCoin(data['GET_COIN']);
        let get_tick_id       = await this.createTicker(data['GET_TICK']);
        let get_address_id    = await this.createAddress(data['GET_ADDRESS']);
        let fiat_id           = await this.createFiat(data['FIAT_CODE']);
        let oracle_address_id = (!this.util.isNull(data['ORACLE_ADDRESS'])) ? await this.createAddress(data['ORACLE_ADDRESS']) : null;
        let memo_id           = await this.createMemo(data['MEMO']);
        let status_id         = await this.createStatus(data['STATUS']);
        let action_index      = data['ACTION_INDEX'];
        let give_amount       = data['GIVE_AMOUNT'];
        let get_amount        = data['GET_AMOUNT'];
        let give_escrow       = data['GIVE_ESCROW'];
        let give_ownership    = (data['GIVE_OWNERSHIP']==1) ? 1 : 0;
        let fiat_amount       = data['FIAT_AMOUNT'];
        let expiration        = data['EXPIRATION'];
        let allow_list        = data['ALLOW_LIST'];
        let block_list        = data['BLOCK_LIST'];
        // Check if record already exists for this dispenser
        let query  = `SELECT
                            action_index
                        FROM
                            dispensers
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        dispensers
                    SET
                        give_coin_id=?,
                        give_tick_id=?,
                        give_amount=?,
                        give_escrow=?,
                        give_ownership=?,
                        get_coin_id=?,
                        get_tick_id=?,
                        get_amount=?,
                        get_address_id=?,
                        fiat_id=?,
                        fiat_amount=?,
                        oracle_address_id=?,
                        expiration=?,
                        allow_list=?,
                        block_list=?,
                        memo_id=?,
                        status_id=?
                    WHERE
                        action_index=?`;
            args = [give_coin_id, give_tick_id, give_amount, give_escrow, give_ownership, get_coin_id, get_tick_id, get_amount, get_address_id, fiat_id, fiat_amount, oracle_address_id, expiration, allow_list, block_list, memo_id, status_id, action_index];
        } else {
            // INSERT record
            query = `INSERT INTO dispensers (give_coin_id, give_tick_id, give_amount, give_escrow, give_ownership, get_coin_id, get_tick_id, get_amount, get_address_id, fiat_id, fiat_amount, oracle_address_id, expiration, allow_list, block_list, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            args = [give_coin_id, give_tick_id, give_amount, give_escrow, give_ownership, get_coin_id, get_tick_id, get_amount, get_address_id, fiat_id, fiat_amount, oracle_address_id, expiration, allow_list, block_list, memo_id, status_id, action_index];
        }
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `dispenser_statuses` table
    // @param {action_index}            integer Action index of action
    // @param {dispenser_action_index}  integer Action index of dispenser
    // @param {status}                  string  Status of the referenced dispenser (open/complete/closing/cancelled/expired)
    // @param {cancelled_by}            string  (optional) Address that triggered the cancel - recorded for the 'cancelling' status so dispenser_close can route escrow correctly
    async createDispenserStatus(action_index, dispenser_action_index, status, cancelled_by){
        // Normalize data
        let status_id       = await this.createStatus(status);
        let cancelled_by_id = (!this.util.isNull(cancelled_by)) ? await this.createAddress(cancelled_by) : null;
        // Check if record already exists for this in order_statuses table
        let query  = `SELECT
                            action_index
                        FROM
                            dispenser_statuses
                        WHERE
                            action_index=? AND
                            dispenser_action_index=?`;
        let args = [action_index, dispenser_action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        dispenser_statuses
                    SET
                        status_id=?,
                        cancelled_by_id=?
                    WHERE
                        action_index=? AND
                        dispenser_action_index=?`;
            args = [status_id, cancelled_by_id, action_index, dispenser_action_index];
        } else {
            // INSERT record
            query = `INSERT INTO dispenser_statuses (status_id, cancelled_by_id, action_index, dispenser_action_index) values (?, ?, ?, ?)`;
            args  = [status_id, cancelled_by_id, action_index, dispenser_action_index];
        }
        results = await this.doQuery(query, args);
    }

    // Return dispenser info for given action_index
    async getDispenserInfo(coin, action_index, block_time){
        let dispenser = false;
        let query = `SELECT
                        d1.action_index,
                        t2.tick as give_tick,
                        d1.give_amount,
                        d1.give_ownership,
                        c1.coin as get_coin,
                        t3.tick as get_tick,
                        d1.get_amount,
                        d1.give_escrow,
                        a2.address as source,
                        a3.address as get_address,
                        d1.expiration,
                        d1.allow_list,
                        d1.block_list,
                        f1.code as fiat,
                        d1.fiat_amount,
                        a4.address as oracle_address,
                        m1.memo,
                        s2.status,
                        s3.status as dispenser_status,
                        b1.block_index,
                        b1.block_time
                    FROM
                        dispensers d1
                        INNER JOIN actions             a1 ON (a1.action_index=d1.action_index)
                        INNER JOIN transactions        t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN blocks              b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses     a2 ON (a2.id=a1.source_id)
                        INNER JOIN index_addresses     a3 ON (a3.id=d1.get_address_id)
                        LEFT  JOIN index_addresses     a4 ON (a4.id=d1.oracle_address_id)
                        INNER JOIN index_tickers       t2 ON (t2.id=d1.give_tick_id)
                        LEFT  JOIN index_tickers       t3 ON (t3.id=d1.get_tick_id)
                        INNER JOIN index_coins         c1 ON (c1.id=d1.get_coin_id)
                        LEFT  JOIN index_memos         m1 ON (m1.id=d1.memo_id)
                        LEFT  JOIN index_fiats         f1 ON (f1.id=d1.fiat_id)
                        INNER JOIN dispenser_statuses  s1 ON (s1.dispenser_action_index=d1.action_index)
                        INNER JOIN index_statuses      s2 ON (s2.id=d1.status_id)
                        INNER JOIN index_statuses      s3 ON (s3.id=s1.status_id)
                    WHERE
                        s1.action_index = (
                            SELECT
                                MAX(s4.action_index)
                            FROM
                                dispenser_statuses s4
                            WHERE
                                s4.dispenser_action_index=d1.action_index
                        ) AND
                        c1.coin=? AND
                        d1.action_index=?
                    LIMIT 1`;
        let args  = [coin, action_index];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            dispenser = {};
            dispenser['GIVE_COIN'] = this.config['COIN'];
            for(let key in results[0]){
                let name  = String(key).toUpperCase()
                let value = results[0][key];
                if(['ACTION_INDEX', 'BLOCK_INDEX', 'BLOCK_TIME', 'EXPIRATION', 'ALLOW_LIST', 'BLOCK_LIST', 'GIVE_OWNERSHIP'].includes(name))
                    value = Number(value);
                dispenser[name] = value;
            }
        }
        // Get additional information on this order
        if(dispenser){
            // Get updated dispenser properties from the dispenser_edits table
            let edit = await this.getDispenserEdits(action_index, block_time);
            if(edit.expiration)
                dispenser['EXPIRATION'] = edit.expiration;
            if(edit.allow_list)
                dispenser['ALLOW_LIST'] = edit.allow_list;
            if(edit.block_list)
                dispenser['BLOCK_LIST'] = edit.block_list;
            // Ownership dispensers expose virtual '1' for GIVE_AMOUNT / GIVE_ESCROW so the
            // matching engine and dispense flow can compare amounts uniformly. Settlement
            // code branches on GIVE_OWNERSHIP rather than the synthetic amount.
            if(dispenser['GIVE_OWNERSHIP'] == 1){
                if(this.util.isNull(dispenser['GIVE_AMOUNT']))  dispenser['GIVE_AMOUNT']  = '1';
                if(this.util.isNull(dispenser['GIVE_ESCROW'])) dispenser['GIVE_ESCROW'] = '1';
                // Virtual remaining: 1 if no dispense yet, 0 once dispensed (single-shot).
                // getDispenserAmountRemaining returns 0 for a fresh ownership dispenser
                // (give_escrow is null in the DB) and goes negative after a successful
                // DISPENSE has been recorded with give_amount='1'.
                let dispensed = await this.getDispenserAmountRemaining(action_index);
                dispenser['GIVE_REMAINING'] = this.util.bclt(dispensed, 0) ? '0' : '1';
            } else {
                // Determine dispenser amounts remaining
                dispenser['GIVE_REMAINING'] = await this.getDispenserAmountRemaining(action_index);
            }
        }
        return dispenser;
    }

    // Origin-standing check for DISPENSER creates (DISPENSER_ORIGIN_STANDING
    // protocol change): true when `source` is the SOURCE of at least one prior
    // VALID dispenser create on `getAddress` (action_index strictly earlier
    // than the create being validated). Later status changes (closed /
    // canceled / expired) do not revoke standing; only the create's own
    // validity counts, so invalid create attempts confer nothing.
    async hasDispenserOriginStanding(source, getAddress, action_index){
        let query = `SELECT
                        d1.action_index
                    FROM
                        dispensers d1
                        INNER JOIN actions         a1 ON (a1.action_index=d1.action_index)
                        INNER JOIN index_addresses a2 ON (a2.id=a1.source_id)
                        INNER JOIN index_addresses a3 ON (a3.id=d1.get_address_id)
                        INNER JOIN index_statuses  s1 ON (s1.id=d1.status_id)
                    WHERE
                        a2.address=? AND
                        a3.address=? AND
                        s1.status='valid' AND
                        d1.action_index<?
                    LIMIT 1`;
        let results = await this.doQuery(query, [source, getAddress, action_index]);
        return results.length > 0;
    }

    // Create/Update record in `dispenser_edits` table
    async createDispenserEdit(data){
        data                       = this.normalizeDataValues(data);
        let memo_id                = await this.createMemo(data['MEMO']);
        let status_id              = await this.createStatus(data['STATUS']);
        let action_index           = data['ACTION_INDEX'];
        let dispenser_action_index = data['DISPENSER_ACTION_INDEX'];
        let give_escrow            = data['GIVE_ESCROW'];
        let expiration             = data['EXPIRATION'];
        let allow_list             = data['ALLOW_LIST'];
        let block_list             = data['BLOCK_LIST'];
        // Check if record already exists for this dispenser_edits
        let query  = `SELECT
                            action_index
                        FROM
                            dispenser_edits
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        dispenser_edits
                    SET
                        give_escrow=?,
                        expiration=?,
                        allow_list=?,
                        block_list=?,
                        memo_id=?,
                        status_id=?,
                        dispenser_action_index=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO dispenser_edits (give_escrow, expiration, allow_list, block_list, memo_id, status_id, dispenser_action_index, action_index) values (?, ?, ?, ?, ?, ?, ?, ?)`;
        }
        args    = [give_escrow, expiration, allow_list, block_list, memo_id, status_id, dispenser_action_index, action_index];
        results = await this.doQuery(query, args);
    }

    // Return dispenser edit information for given action_index
    async getDispenserEdits(action_index, block_time){
        // Define empty edit object
        let edit  = {
            give_escrow: 0,
            expiration: false,
            allow_list: false,
            block_list: false
        };
        let query  = `SELECT 
                        e1.give_escrow,
                        e1.expiration,
                        e1.allow_list,
                        e1.block_list,
                        b1.block_time
                    FROM 
                        dispenser_edits e1
                        INNER JOIN actions        a1 ON (a1.action_index=e1.action_index)
                        INNER JOIN blocks         b1 ON (b1.block_index=a1.block_index)
                        INNER JOIN index_statuses s1 ON (s1.id=e1.status_id)
                    WHERE 
                        e1.dispenser_action_index=? AND
                        s1.status=?
                    ORDER BY
                        e1.action_index ASC`;
        let args  = [action_index, 'valid'];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            for(let row of results){
                // refilling dispensers and updating expiration are immediately active
                if(!this.util.isNull(row.give_escrow)) 
                    edit.give_escrow = this.util.bcadd(edit.give_escrow, row.give_escrow);
                if(!this.util.isNull(row.expiration) && this.util.isNumeric(row.expiration))   
                    edit.expiration  = Number(row.expiration);
                // Determine if the list edits are active or not
                let active = this.util.bcgt(block_time, this.util.bcadd(row.block_time, this.config['DISPENSER_LIST_DELAY']));
                if(active){
                    if(!this.util.isNull(row.allow_list) && this.util.isNumeric(row.allow_list))   
                        edit.allow_list  = Number(row.allow_list);
                    if(!this.util.isNull(row.block_list) && this.util.isNumeric(row.block_list))   
                        edit.block_list  = Number(row.block_list);
                }
            }
        }
        return edit;
    }

    // Create/Update record in `dispenser_closes` table
    async createDispenserClose(data){
        data                       = this.normalizeDataValues(data);
        let status_id              = await this.createStatus(data['STATUS']);
        let action_index           = data['ACTION_INDEX'];
        let dispenser_action_index = data['DISPENSER_ACTION_INDEX'];
        // Check if record already exists for this in dispenser_closes
        let query  = `SELECT
                            action_index
                        FROM
                            dispenser_closes
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        dispenser_closes
                    SET
                        status_id=?,
                        dispenser_action_index=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO dispenser_closes (status_id, dispenser_action_index, action_index) values (?, ?, ?)`;
        }
        args    = [status_id, dispenser_action_index, action_index];
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `dispenser_cancels` table
    async createDispenserCancel(data){
        data                       = this.normalizeDataValues(data);
        let memo_id                = await this.createMemo(data['MEMO']);
        let status_id              = await this.createStatus(data['STATUS']);
        let action_index           = data['ACTION_INDEX'];
        let dispenser_action_index = data['DISPENSER_ACTION_INDEX'];
        // Check if record already exists for this in dispenser_cancels
        let query  = `SELECT
                            action_index
                        FROM
                            dispenser_cancels
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        dispenser_cancels
                    SET
                        memo_id=?,
                        status_id=?,
                        dispenser_action_index=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO dispenser_cancels (memo_id, status_id, dispenser_action_index, action_index) values (?, ?, ?, ?)`;
        }
        args    = [memo_id, status_id, dispenser_action_index, action_index];
        results = await this.doQuery(query, args);
    }

    // Handle getting total escrowed and available in a dispenser for a given action_index
    async getDispenserAmountRemaining(action_index){
        let remaining = 0;
        // Get initial amounts from the dispensers table
        let query  = `SELECT 
                        d.give_escrow
                    FROM 
                        dispensers d
                        INNER JOIN index_statuses s ON (s.id=d.status_id)
                    WHERE 
                        d.action_index=? AND
                        s.status=?`;
        let args  = [action_index, 'valid'];
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            remaining = results[0].give_escrow;
        // Get any amounts added to escrow via edits and add to remaining
        query = `SELECT 
                    d.give_escrow
                FROM 
                    dispenser_edits d
                    INNER JOIN index_statuses s ON (s.id=d.status_id)
                WHERE 
                    d.dispenser_action_index=? AND
                    s.status=?
                ORDER BY
                    d.action_index ASC`;
        results = await this.doQuery(query, args);
        if(results.length > 0){
            for(let row of results){
                if(!this.util.isNull(row.give_escrow))
                    remaining = this.util.bcadd(remaining, row.give_escrow, 64);
            }
        }
        // Lookup amounts paid out already from dispenses table
        query = `SELECT
                    d.give_amount
                FROM
                    dispenses d
                    INNER JOIN index_statuses s ON (s.id=d.status_id)
                WHERE
                    d.dispenser_action_index=?  AND
                    s.status=?
                ORDER BY action_index ASC`;
        args = [action_index, 'valid'];
        results = await this.doQuery(query, args);
        if(results.length > 0){
            for(let row of results){
                if(!this.util.isNull(row.give_amount))
                    remaining = this.util.bcsub(remaining, row.give_amount, 64);
            }
        }
        return remaining;
    }

    // DISPENSER caps (dispenser_caps_activation.js). Both counts are
    // DERIVED from existing rollback-covered tables (dispenses / dispenser_edits),
    // matching the house pattern that recomputes GIVE_REMAINING rather than storing
    // a mutable counter: a reorg that deletes those rows automatically corrects the
    // count, so no new column/table and no migration are needed.

    // Count of VALID refills (a dispenser_edits row that tops up GIVE_ESCROW, i.e.
    // give_escrow > 0) for this dispenser. Used to reject the 6th refill (MAX_REFILLS).
    async getDispenserRefillCount(action_index){
        let query = `SELECT COUNT(*) AS c
                     FROM dispenser_edits e
                     INNER JOIN index_statuses s ON (s.id=e.status_id)
                     WHERE e.dispenser_action_index=? AND s.status='valid'
                       AND e.give_escrow IS NOT NULL AND e.give_escrow > 0`;
        let rows = await this.doQuery(query, [action_index]);
        return (rows.length > 0) ? Number(rows[0].c) : 0;
    }

    // Count of VALID dispenses for this dispenser SINCE its most recent refill.
    // A refill resets the dispense count (Counterparty parity), so only dispenses
    // recorded after the last refill's action_index count toward MAX_DISPENSES; no
    // refill -> all valid dispenses (since 0). The just-settled dispense is already
    // persisted when dispense.js calls this, so the returned count includes it.
    async getDispenserDispenseCount(action_index){
        let refillQ = `SELECT MAX(e.action_index) AS r
                       FROM dispenser_edits e
                       INNER JOIN index_statuses s ON (s.id=e.status_id)
                       WHERE e.dispenser_action_index=? AND s.status='valid'
                         AND e.give_escrow IS NOT NULL AND e.give_escrow > 0`;
        let refillRows = await this.doQuery(refillQ, [action_index]);
        let sinceIndex = (refillRows.length > 0 && refillRows[0].r !== null) ? refillRows[0].r : 0;
        let countQ = `SELECT COUNT(*) AS c
                      FROM dispenses d
                      INNER JOIN index_statuses s ON (s.id=d.status_id)
                      WHERE d.dispenser_action_index=? AND s.status='valid' AND d.action_index > ?`;
        let rows = await this.doQuery(countQ, [action_index, sinceIndex]);
        return (rows.length > 0) ? Number(rows[0].c) : 0;
    }

    // Lookup items that need to be cancelled and return a list
    async findCancelledDispensers(block_time){
        let cancels = [];
        // Find dispensers where latest status is 'cancelling`
        let args  = [];
        let query = `SELECT 
                        m.action_index,
                        b1.block_time
                    FROM 
                        dispensers m
                        INNER JOIN dispenser_statuses s1 ON (s1.dispenser_action_index=m.action_index)
                        INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                        INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                    WHERE 
                        s1.action_index = (
                            SELECT
                                MAX(s3.action_index)
                            FROM
                                dispenser_statuses s3
                            WHERE
                                s3.dispenser_action_index=m.action_index
                        ) AND
                        s2.status='cancelling'
                    ORDER BY m.action_index ASC`
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            for(let row of results)
                if(this.util.bcgt(block_time, this.util.bcadd(row.block_time, this.config['DISPENSER_CLOSE_DELAY'])))
                    cancels.push(Number(row.action_index));
        }
        return cancels;
    }

    // Create/Update record in `order_expires` table
    // @param {action_index}          integer Action index of action
    // @param {dispenser_action_tick} integer Action index of dispenser
    // @param {status}                string  Status of the expire (valid/invalid)
    async createDispenserExpire(action_index, dispenser_action_index, status){
        // Normalize data
        let status_id = await this.createStatus(status);
        // Check if record already exists for this in order_expires table
        let query  = `SELECT
                            action_index
                        FROM
                            dispenser_expires
                        WHERE
                            action_index=? AND
                            dispenser_action_index=?`;
        let args = [action_index, dispenser_action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        dispenser_expires
                    SET
                        status_id=?
                    WHERE 
                        action_index=? AND
                        dispenser_action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO dispenser_expires (status_id, action_index, dispenser_action_index) values (?, ?, ?)`;
        }
        args    = [status_id, action_index, dispenser_action_index];
        results = await this.doQuery(query, args);
    }

    // Handle finding any sends to an address with active dispenser(s)
    //
    // Affordability predicate (flag-day gated, see
    // dispenser_send_amount_compare_activation.js). `sends.amount` and
    // `dispensers.get_amount` are both VARCHAR(250), so the legacy
    // `s1.amount >= d1.get_amount` compares them as TEXT under the column
    // collation: get_amount '9' against a send of '10' is false as a string and
    // true as a number. This query is the ONLY gate deciding whether a token
    // SEND becomes a DISPENSE (utility.processDispenserSends iterates exactly
    // these rows), so a lexicographic false negative strands the sender's
    // tokens at the dispenser address on a legal overpayment. At/after the
    // activation both operands are CAST to DECIMAL before comparing, the
    // CAST-before-compare idiom every sibling amount query in this file uses.
    // Correcting it changes how already-valid blocks evaluate, so the legacy
    // predicate is emitted byte-identically below the height, and a caller with
    // no block context (out-of-band writes, API-side readers) stays on it.
    async findDispenserSends(action_index, block_index){
        let sends = [];
        let amountCompare = dispenserSendCompare.sendAmountComparePredicate(
            block_index, this.config['NETWORK'], this.config['COIN']);
        let query  = `SELECT
                            a2.address as source,
                            a3.address as destination,
                            c1.coin,
                            t2.tick,
                            s1.amount
                        FROM
                            sends s1
                            INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN dispensers         d1 ON (d1.get_address_id=s1.destination_id)
                            INNER JOIN dispenser_statuses s2 ON (s2.dispenser_action_index=d1.action_index)
                            INNER JOIN index_statuses     s3 ON (s3.id=s1.status_id)
                            INNER JOIN index_statuses     s4 ON (s4.id=s2.status_id)
                            INNER JOIN index_addresses    a2 ON (a2.id=a1.source_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=s1.destination_id)
                            INNER JOIN index_tickers      t2 ON (t2.id=s1.tick_id)
                            INNER JOIN index_coins        c1 ON (c1.id=d1.get_coin_id)
                        WHERE
                            s2.action_index = (
                                SELECT
                                    MAX(s5.action_index)
                                FROM
                                    dispenser_statuses s5
                                WHERE
                                    s5.dispenser_action_index=d1.action_index
                            ) AND
                            s3.status='valid' AND 
                            s4.status IN ('open', 'cancelling') AND 
                            s1.tick_id=d1.get_tick_id AND
                            ` + amountCompare + ` AND
                            s1.action_index=?
                        GROUP BY s1.action_index`;
        let args = [action_index];
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            sends = results;
        return sends;
    }

    // Handle finding any open dispensers for a given coin/tick/amount/destination combination
    async findMatchingDispensers(data){
        let dispensers = [];
        // Normalize data
        let coin_id        = await this.createCoin(data['COIN']);
        let tick_id        = await this.createTicker(data['COIN_TICK']);
        let destination_id = await this.createAddress(data['COIN_DESTINATION']);
        let coin_amount    = this.util.bcnum(data['COIN_AMOUNT']);
        let args           = [coin_id, destination_id];
        let where          = '';
        let dispenses      = [];
        // Include the ticker in the query if we have one
        if(!this.util.isNull(tick_id)){
            where = ' AND d1.get_tick_id=?';
            args.push(tick_id);
        } else if(dispenseCancellingMatch.isDispenseCancellingMatchActive(data['BLOCK_TIME'], this.config['NETWORK'])){
            // Native-coin trigger: a bare native payment carries no COIN_TICK (only the
            // token-SEND channel sets it, utility.js), so tick_id is null. Without a
            // predicate the native branch left `where` empty and matched EVERY open
            // dispenser at the address, including token-priced ones (get_tick_id non-null),
            // then dispense.js settled the seller's escrow by comparing a native amount to a
            // token-denominated GET_AMOUNT with no unit check - escrow dispensed against
            // payment in the WRONG asset. A native trigger must only settle native-priced
            // dispensers (get_tick_id IS NULL). Correcting the match set changes how
            // already-valid blocks evaluate, so it rides the coordinated 2.0.0 flag-day
            // shared by dispense_cancelling_match_activation (which gates the sibling
            // correction in this same function): below the flag-day the legacy unbounded
            // match is kept so historical replay stays byte-identical; at/after it the
            // native branch is constrained to get_tick_id IS NULL.
            where = ' AND d1.get_tick_id IS NULL';
        }
        // Latest-status correlation column (flag-day gated, see
        // dispense_cancelling_match_activation.js). The MAX(action_index) subquery must
        // correlate on the DISPENSER's action index (d1.action_index), the idiom every
        // sibling query uses (getDispenserInfo / findDispenserSends / getSweepDestination /
        // findCancelledDispensers). The legacy predicate correlated on s1.action_index -
        // the STATUS row's own action index, a different id domain - which only resolves
        // while the dispenser's sole status row is the initial 'open' one; after a cancel
        // writes a 'cancelling' row the dispenser matches nothing and the buyer's coin-paid
        // DISPENSE trigger is silently dropped. Correcting it changes how already-valid
        // blocks evaluate, so the legacy column is kept below the activation time.
        let latestStatusCorrelate = dispenseCancellingMatch.isDispenseCancellingMatchActive(
            data['BLOCK_TIME'], this.config['NETWORK']) ? 'd1.action_index' : 's1.action_index';
        let query  = `SELECT
                            d1.action_index,
                            d1.get_amount,
                            d1.fiat_id
                        FROM
                            dispensers d1
                            INNER JOIN dispenser_statuses s1 ON (s1.dispenser_action_index=d1.action_index)
                            INNER JOIN index_statuses     s2 ON (s2.id=d1.status_id)
                            INNER JOIN index_statuses     s3 ON (s3.id=s1.status_id)
                        WHERE
                            s1.action_index = (
                                SELECT
                                    MAX(s4.action_index)
                                FROM
                                    dispenser_statuses s4
                                WHERE
                                    s4.dispenser_action_index=` + latestStatusCorrelate + `
                            ) AND
                            s2.status='valid' AND
                            s3.status IN ('open', 'cancelling') AND
                            d1.get_coin_id=? AND
                            d1.get_address_id=?` + where + `
                        ORDER BY d1.action_index ASC`;
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            for(let row of results){
                // FIAT dispensers: include regardless of coin_amount (matching happens in dispense.js via reverse price lookup)
                // Non-FIAT dispensers: only include if coin_amount >= get_amount
                if(!this.util.isNull(row.fiat_id) || this.util.bcgte(coin_amount, row.get_amount))
                    dispensers.push(Number(row.action_index));
            }
        }
        return dispensers;
    }

    // Observability helper (read-only): given the COIN network and a paid address,
    // return the most recent dispenser at that address whose LATEST status is
    // 'cancelled' or 'expired', or false if none. Used by dispense.js to tag a
    // DISPENSE trigger that matched no open dispenser: when the address DID hold a
    // dispenser the indexer has since closed or re-dated, this identifies which one
    // and why. Purely for metrics - it changes no validation or state outcome, and
    // uses the same latest-status idiom as findMatchingDispensers / getDispenserInfo.
    async getClosedDispenserAtAddress(coin, address){
        let query = `SELECT
                        d1.action_index,
                        s3.status
                    FROM
                        dispensers d1
                        INNER JOIN index_addresses    a3 ON (a3.id=d1.get_address_id)
                        INNER JOIN index_coins        c1 ON (c1.id=d1.get_coin_id)
                        INNER JOIN dispenser_statuses s1 ON (s1.dispenser_action_index=d1.action_index)
                        INNER JOIN index_statuses     s3 ON (s3.id=s1.status_id)
                    WHERE
                        s1.action_index = (
                            SELECT
                                MAX(s4.action_index)
                            FROM
                                dispenser_statuses s4
                            WHERE
                                s4.dispenser_action_index=d1.action_index
                        ) AND
                        c1.coin=? AND
                        a3.address=? AND
                        s3.status IN ('cancelled', 'expired')
                    ORDER BY d1.action_index DESC
                    LIMIT 1`;
        let results = await this.doQuery(query, [coin, address]);
        if(results.length > 0)
            return { ACTION_INDEX: Number(results[0].action_index), REASON: results[0].status };
        return false;
    }


    // Return the address recorded as the canceller for a dispenser's most recent
    // 'cancelling' status row, or null if there isn't one. Used by dispenser_close
    // to route escrow per DISPENSER.md (canceller == GET_ADDRESS → escrow to GET_ADDRESS;
    // canceller == SOURCE → escrow to SOURCE).
    async getDispenserCanceller(action_index){
        let address = null;
        let query = `SELECT
                        a1.address
                    FROM
                        dispenser_statuses s1
                        INNER JOIN index_addresses a1 ON (a1.id=s1.cancelled_by_id)
                    WHERE
                        s1.dispenser_action_index=? AND
                        s1.cancelled_by_id IS NOT NULL
                    ORDER BY
                        s1.action_index DESC
                    LIMIT 1`;
        let results = await this.doQuery(query, [action_index]);
        if(results.length > 0)
            address = results[0].address;
        return address;
    }

    // Return the SWEEP DESTINATION address if the most recent 'cancelling' status
    // row on the given order_action_index was triggered by a SWEEP, else null.
    // Used by coinpay.js / coinpay_expire.js to route residual escrow (or ownership)
    // to the sweeper's DESTINATION rather than the order's original SOURCE.
    async getOrderSweepDestination(order_action_index){
        let address = null;
        let query = `SELECT
                        a1.address
                    FROM
                        order_statuses    s1
                        INNER JOIN index_statuses   s2 ON (s2.id=s1.status_id)
                        INNER JOIN sweeps           sw ON (sw.action_index=s1.action_index)
                        INNER JOIN index_statuses   s3 ON (s3.id=sw.status_id)
                        INNER JOIN index_addresses  a1 ON (a1.id=sw.destination_id)
                    WHERE
                        s1.order_action_index=? AND
                        s2.status='cancelling' AND
                        s3.status='valid'
                    ORDER BY
                        s1.action_index DESC
                    LIMIT 1`;
        let results = await this.doQuery(query, [order_action_index]);
        if(results.length > 0)
            address = results[0].address;
        return address;
    }

    // Handle getting the sweep destination address for a given dispenser action_index
    async getSweepDestination(action_index){
        let address = null;
        // Normalize data
        let query  = `SELECT
                            a1.address
                        FROM
                            dispensers d1
                            INNER JOIN dispenser_statuses s1 ON (s1.dispenser_action_index=d1.action_index)
                            LEFT  JOIN sweeps             s2 ON (s2.action_index=s1.action_index)
                            LEFT  JOIN index_addresses    a1 ON (a1.id=s2.destination_id)
                            LEFT  JOIN index_statuses     s3 ON (s3.id=s2.status_id)
                        WHERE
                            s1.action_index = (
                                SELECT
                                    MAX(s4.action_index)
                                FROM
                                    dispenser_statuses s4
                                WHERE
                                    s4.dispenser_action_index=d1.action_index
                            ) AND
                            d1.action_index=? AND
                            s3.status='valid'
                        ORDER BY 
                            d1.action_index ASC
                        LIMIT 1`;
        let args = [action_index];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            for(let row of results)
                address = row.address;
        }
        return address;
    }

    /*
     * Pubkeys table methods (address → pubkey mapping)
     */

    // Store an address_id → pubkey mapping in the pubkeys table (idempotent)
    async createPubkey(address_id, pubkey){
        if(!address_id || !pubkey) return;
        let query = "INSERT IGNORE INTO pubkeys (address_id, pubkey) VALUES (?, ?)";
        await this.doQuery(query, [address_id, String(pubkey)]);
    }

    /*
     * Pubkey index methods (index_pubkeys table)
     */

    // Get pubkey id from index_pubkeys table
    async getPubkeyId(pubkey){
        let id    = null;
        let query = "SELECT id FROM index_pubkeys WHERE `pubkey`=? LIMIT 1";
        let results = await this.doQuery(query, [pubkey]);
        if(results.length > 0)
            id = Number(results[0].id);
        return id;
    }

    // Create record in index_pubkeys table and return record id
    async getOrCreatePubkeyId(pubkey){
        // Ignore empty pubkey and return NULL
        if(this.util.isNull(pubkey))
            return null;
        // Normalize to lowercase hex
        pubkey = String(pubkey).toLowerCase().substring(0, 64);
        let id = await this.getPubkeyId(pubkey);
        // Create pubkey if it does not already exist
        if(id === null){
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index.
            let query   = "INSERT IGNORE INTO index_pubkeys (`pubkey`) values (?)";
            await this.doQuery(query, [pubkey]);
            id = await this.getPubkeyId(pubkey);
        }
        return id;
    }

    /*
     * Staking action methods
     */

    // Create/Update record in `stakes` table.
    // Capability model: each STAKE action (v1 create or v2 top-up) gets its own row.
    // Active stake amount for a pubkey is SUM(amount) across all valid rows.
    async createStake(data){
        data                  = this.normalizeDataValues(data);
        let status_id         = await this.createStatus(data['STATUS']);
        let source_id         = await this.getAddressId(data['SOURCE']);
        let signing_pubkey_id = await this.getOrCreatePubkeyId(data['SIGNING_PUBKEY']);
        let action_index      = data['ACTION_INDEX'];
        let version           = data['VERSION'] || 1;
        let amount            = data['AMOUNT'] || '0';
        let block_index       = data['BLOCK_INDEX'];
        let activation_block  = data['ACTIVATION_BLOCK'] || 0;
        // Check if record already exists
        let query  = "SELECT action_index FROM stakes WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE stakes SET
                        source_id=?, version=?, signing_pubkey_id=?,
                        amount=?, status_id=?, block_index=?, activation_block=?
                    WHERE action_index=?`;
            args = [source_id, version, signing_pubkey_id, amount, status_id, block_index, activation_block, action_index];
        } else {
            query = `INSERT INTO stakes
                        (source_id, version, signing_pubkey_id, amount, status_id, block_index, activation_block, action_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
            args = [source_id, version, signing_pubkey_id, amount, status_id, block_index, activation_block, action_index];
        }
        await this.doQuery(query, args);
    }

    // Set deactivation_block for the ALREADY-ACTIVE stake rows owned by the given pubkey.
    // Used by createUnstake to mark when a pubkey's stake (original + activated top-ups) should be
    // removed from the active set. The `currentBlock` filter (activation_block <= currentBlock) is
    // load-bearing: the unstake AMOUNT is summed from active rows only (getActiveStakeByPubkey), so a
    // pending-activation top-up (activation_block > currentBlock) must NOT be deactivated here - it
    // was never counted in the unstake and the cooldown sweep would never refund it, orphaning the
    // tokens. It correctly stays an active stake until a later UNSTAKE covers it.
    async setStakeDeactivationByPubkey(pubkey, deactivationBlock, currentBlock){
        let pubkey_id = await this.getPubkeyId(String(pubkey).toLowerCase());
        if(pubkey_id === null) return false;
        let valid_id = await this.getStatusId('valid');
        let query = `UPDATE stakes SET deactivation_block=?
                     WHERE signing_pubkey_id=? AND status_id=? AND deactivation_block IS NULL
                       AND activation_block <= ?`;
        await this.doQuery(query, [deactivationBlock, pubkey_id, valid_id, currentBlock]);
        return true;
    }

    // Create/Update record in `unstakes` table
    async createUnstake(data){
        data                  = this.normalizeDataValues(data);
        let status_id         = await this.createStatus(data['STATUS']);
        let source_id         = await this.getAddressId(data['SOURCE']);
        let signing_pubkey_id = await this.getOrCreatePubkeyId(data['SIGNING_PUBKEY']);
        let action_index      = data['ACTION_INDEX'];
        let cooldown_end_block = data['COOLDOWN_END_BLOCK'];
        let amount            = data['AMOUNT'] || '0';
        let block_index       = data['BLOCK_INDEX'];
        // Check if record already exists
        let query  = "SELECT action_index FROM unstakes WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE unstakes SET
                        source_id=?, signing_pubkey_id=?, cooldown_end_block=?,
                        amount=?, status_id=?, block_index=?
                    WHERE action_index=?`;
            args = [source_id, signing_pubkey_id, cooldown_end_block, amount, status_id, block_index, action_index];
        } else {
            query = `INSERT INTO unstakes
                        (source_id, signing_pubkey_id, cooldown_end_block, amount, status_id, block_index, action_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`;
            args = [source_id, signing_pubkey_id, cooldown_end_block, amount, status_id, block_index, action_index];
        }
        await this.doQuery(query, args);
    }

    // Create/Update record in `delegations` table
    async createDelegation(data){
        data                  = this.normalizeDataValues(data);
        let status_id         = await this.createStatus(data['STATUS']);
        let source_id         = await this.getAddressId(data['SOURCE']);
        let signing_pubkey_id = await this.getOrCreatePubkeyId(data['SIGNING_PUBKEY']);
        let action_index      = data['ACTION_INDEX'];
        let block_index       = data['BLOCK_INDEX'];
        let activation_block  = data['ACTIVATION_BLOCK'] || 0;
        // Check if record already exists
        let query  = "SELECT action_index FROM delegations WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE delegations SET
                        source_id=?, signing_pubkey_id=?, status_id=?, block_index=?, activation_block=?
                    WHERE action_index=?`;
            args = [source_id, signing_pubkey_id, status_id, block_index, activation_block, action_index];
        } else {
            query = `INSERT INTO delegations
                        (source_id, signing_pubkey_id, status_id, block_index, activation_block, action_index)
                    VALUES (?, ?, ?, ?, ?, ?)`;
            args = [source_id, signing_pubkey_id, status_id, block_index, activation_block, action_index];
        }
        await this.doQuery(query, args);
    }

    // Create record in `delegations` table with 'revoked' status
    async createRevokeDelegation(data){
        // Set status to reflect revocation intent, then create as normal delegation record
        await this.createDelegation(data);
    }

    // Set the deactivation_block for an active delegation
    // Used by createRevokeDelegation flow to mark when the delegation should be removed
    async setDelegationDeactivation(source, pubkey, deactivationBlock){
        let source_id = await this.getAddressId(source);
        let pubkey_id = await this.getPubkeyId(String(pubkey).toLowerCase());
        if(source_id === null || pubkey_id === null) return false;
        let valid_id = await this.getStatusId('valid');
        let query = `UPDATE delegations SET deactivation_block=?
                     WHERE source_id=? AND signing_pubkey_id=? AND status_id=? AND deactivation_block IS NULL`;
        await this.doQuery(query, [deactivationBlock, source_id, pubkey_id, valid_id]);
        return true;
    }

    // Create/Update record in `stake_key_revocations` table (DELEGATE v2 against
    // the source's ORIGINAL stake signing key - the delegation-row revoke path
    // stays in `delegations`). `deactivation_block` is when the key stops being
    // a valid signer; a LATER re-stake of the same key (higher action_index)
    // clears the revocation (see _effectiveCapabilitySetSql).
    async createStakeKeyRevocation(data){
        data                  = this.normalizeDataValues(data);
        let status_id         = await this.createStatus(data['STATUS']);
        let source_id         = await this.getAddressId(data['SOURCE']);
        let signing_pubkey_id = await this.getOrCreatePubkeyId(data['SIGNING_PUBKEY']);
        let action_index      = data['ACTION_INDEX'];
        let block_index       = data['BLOCK_INDEX'];
        let deactivation_block = data['DEACTIVATION_BLOCK'] || 0;
        let query  = "SELECT action_index FROM stake_key_revocations WHERE action_index=? LIMIT 1";
        let results = await this.doQuery(query, [action_index]);
        let args;
        if(results.length > 0){
            query = `UPDATE stake_key_revocations SET
                        source_id=?, signing_pubkey_id=?, status_id=?, block_index=?, deactivation_block=?
                    WHERE action_index=?`;
            args = [source_id, signing_pubkey_id, status_id, block_index, deactivation_block, action_index];
        } else {
            query = `INSERT INTO stake_key_revocations
                        (source_id, signing_pubkey_id, status_id, block_index, deactivation_block, action_index)
                    VALUES (?, ?, ?, ?, ?, ?)`;
            args = [source_id, signing_pubkey_id, status_id, block_index, deactivation_block, action_index];
        }
        await this.doQuery(query, args);
    }

    // Get the latest valid stake-key revocation for (source, pubkey) that applies
    // to stakes at or before `sinceActionIndex` (i.e. would suppress that stake row).
    async getStakeKeyRevocation(source, pubkey, sinceActionIndex){
        let source_id = await this.getAddressId(source);
        let pubkey_id = await this.getPubkeyId(String(pubkey).toLowerCase());
        if(source_id === null || pubkey_id === null) return null;
        let valid_id = await this.getStatusId('valid');
        let query = `SELECT * FROM stake_key_revocations
                     WHERE source_id=? AND signing_pubkey_id=? AND status_id=?
                       AND action_index > ?
                     ORDER BY action_index DESC LIMIT 1`;
        let results = await this.doQuery(query, [source_id, pubkey_id, valid_id, Number(sinceActionIndex) || 0]);
        return results.length > 0 ? results[0] : null;
    }

    // Get the source's active stake row bound to a specific signing pubkey at a block
    async getActiveStakeBySourceAndPubkey(source, pubkey, blockIndex){
        let source_id = await this.getAddressId(source);
        let pubkey_id = await this.getPubkeyId(String(pubkey).toLowerCase());
        if(source_id === null || pubkey_id === null) return null;
        let valid_id = await this.getStatusId('valid');
        let query = `SELECT * FROM stakes
                     WHERE source_id=? AND signing_pubkey_id=? AND status_id=?
                       AND activation_block <= ?
                       AND (deactivation_block IS NULL OR deactivation_block > ?)
                     ORDER BY action_index DESC LIMIT 1`;
        let results = await this.doQuery(query, [source_id, pubkey_id, valid_id, blockIndex, blockIndex]);
        return results.length > 0 ? results[0] : null;
    }

    // Create record in `reward_claims` table
    // Create a validator reward record. Two writers:
    //   - deterministic block processing (PRICE v0 oracle_round split, ATTEST fee
    //     settlement) - replayable on reindex by construction
    //   - the hub's pushvalidatorrewards RPC (anchor publish rewards) - restored
    //     on reindex from the ANCHOR archive via recovery.js
    // pubkeyHex: 64-char hex Ed25519 signing pubkey of the validator that earned the reward
    // roundReference: round number (oracle_round) or attestation index
    // rewardType: 'oracle_round', 'attest_fee', 'attest_bcast', 'anchor_<chain>', 'anchor_archive'
    // amount: reward amount as decimal string
    // blockIndex: block height when the reward was earned
    // Resolve the source_id (index_addresses id) of the active staking source
    // backing `pubkey_id` at `blockIndex`, or null. Active-row predicates are
    // IDENTICAL to stake-source.js getStakeSourceByPubkey (and thus to
    // _effectiveCapabilitySetSql membership): status=valid, activation/deactivation
    // window, stake-key revocation, permanent slash. Reward writers MUST use this so
    // the source_id stored during block processing matches the source the ANCHOR
    // archive pins and recovery restores, keeping validator_rewards (block-scoped
    // replicated state) byte-identical across the recovery boundary. The earlier
    // writers took the latest stake by action_index with no predicates, which could
    // diverge from the archive and break byte-identical recovery.
    async _resolveActiveStakeSourceId(pubkey_id, blockIndex){
        if(pubkey_id === null || pubkey_id === undefined) return null;
        let blockIdx = Number(blockIndex);
        let valid_id = await this.getStatusId('valid');
        if(valid_id === null) return null;
        let rows = await this.doQuery(
            `SELECT s.source_id AS source_id FROM stakes s
             WHERE s.signing_pubkey_id = ? AND s.status_id = ?
               AND s.activation_block <= ?
               AND (s.deactivation_block IS NULL OR s.deactivation_block > ?)
               AND NOT EXISTS (
                   SELECT 1 FROM stake_key_revocations r
                   WHERE r.source_id = s.source_id
                     AND r.signing_pubkey_id = s.signing_pubkey_id
                     AND r.status_id = ?
                     AND r.deactivation_block <= ?
                     AND r.action_index > s.action_index)
               AND NOT EXISTS (
                   SELECT 1 FROM capability_slash_events cse
                   WHERE cse.signing_pubkey_id = s.signing_pubkey_id
                     AND cse.block_index <= ?)
             ORDER BY s.action_index DESC LIMIT 1`,
            [pubkey_id, valid_id, blockIdx, blockIdx, valid_id, blockIdx, blockIdx]);
        if(!rows || rows.length === 0){
            rows = await this.doQuery(
                `SELECT d.source_id AS source_id FROM delegations d
                 WHERE d.signing_pubkey_id = ? AND d.status_id = ?
                   AND d.activation_block <= ?
                   AND (d.deactivation_block IS NULL OR d.deactivation_block > ?)
                   AND NOT EXISTS (
                       SELECT 1 FROM capability_slash_events cse
                       WHERE cse.signing_pubkey_id = d.signing_pubkey_id
                         AND cse.block_index <= ?)
                 ORDER BY d.action_index DESC LIMIT 1`,
                [pubkey_id, valid_id, blockIdx, blockIdx, blockIdx]);
        }
        return (rows && rows.length > 0) ? rows[0].source_id : null;
    }

    // Option C (derive-on-BTC-side): mirrored anchor_reward_attestations rows whose
    // reward has NOT yet been derived into validator_rewards, matured to `maxSnapshotBlock`.
    //
    // `maxSnapshotBlock` is the MATURITY WATERMARK the caller computed, i.e. the current BTC
    // block MINUS ANCHOR_REWARD_MIRROR_MATURITY, not the current block itself. Keying on the
    // current block matured a row the instant its snapshot_block was reached, but
    // snapshot_block is a height already in the PAST when the row is written (the hub writes
    // only after the DOGE anchor buries, after the publisher failover ladder, and after the
    // hub-to-hub federation hop), so two nodes whose mirrors differed by one row derived the
    // same reward at different heights and forked the ledger hash. See
    // anchor_reward_activation.ANCHOR_REWARD_MIRROR_MATURITY for the watermark and
    // HubDbSync.waitForAnchorAttestationSync for the completeness half of the rule.
    // Returned flat, ordered by (reward_type, round_reference, publisher) so the
    // caller can group each logical reward and reconcile the smallest-pubkey winner across a
    // failover double-publish. NOT-EXISTS-scoped so a group already derived is skipped and a
    // reorg that block-scoped-deletes the reward at snapshot_block re-exposes it for replay.
    //
    // The exclusion is PUBLISHER-scoped, not round-scoped. A round-scoped
    // `NOT EXISTS (... reward_type + round_reference)` drops the WHOLE round the moment any
    // publisher is derived, so a failover publisher whose attestation mirrors in AFTER that
    // first derive is never inserted and reconcileAnchorRewardWinner never compares it. The
    // smallest-pubkey winner rule is then order-dependent: a node (or a from-genesis replay)
    // that saw both publishers in one fetch keeps MIN(pubkey), while a node that saw the
    // smaller one late keeps the larger - divergent COLLECT credit with no self-healing path,
    // since this is the only surviving materialization path at/above the derive flag-day.
    // Comparing against the already-derived pubkey restores order-independence: an attestation
    // that would LOSE to (sorts >= ) a derived winner stays excluded, so a settled round never
    // re-derives, while one that would WIN is re-admitted, inserted, and collapses the round to
    // the true minimum. Self-terminating - after the promotion the new winner excludes both.
    // Compared under the shared utf8_general_ci collation, the same one MIN(pk.pubkey) in
    // reconcileAnchorRewardWinner elects, so the two predicates cannot disagree. Driven
    // against a real MariaDB in test/integration/anchor-reward-late-publisher.test.js: the
    // unit tier stubs doQuery, and doQuery swallows a non-transactional query error, so a
    // shape-only test cannot tell this predicate from one that derives nothing at all.
    async getPendingAnchorRewardAttestations(network, maxSnapshotBlock){
        return await this.doQuery(
            'SELECT ara.chain, ara.network, ara.reward_type, ara.round_reference, ara.snapshot_block, ' +
            '       ara.publisher, ara.publisher_attestations, ara.doge_anchor_txid ' +
            '  FROM anchor_reward_attestations ara ' +
            ' WHERE ara.network = ? AND ara.snapshot_block <= ? ' +
            // The exclusion is also QUALIFIER-scoped. Matching on (reward_type,
            // round_reference) alone made this the FIRST place the archive collapse bit:
            // 'anchor_archive' round_reference is MATCH_BATCH_SEQ, a dense hub counter a
            // wipe-and-replay rebase reissues, so once ONE archive anchor was derived, a
            // genuinely distinct later archive anchor that happened to reuse that seq matched
            // this NOT EXISTS and was never returned as pending at all - suppressed before
            // reconcile ever saw it, so no amount of reconcile-side fixing could recover it.
            // Comparing the qualifier a derived row WOULD carry (snapshot_block for the
            // archive leg, 0 otherwise - the SQL twin of anchor_reward_key.rewardRoundQualifier,
            // emitted from that module so the two forms cannot drift) makes the exclusion
            // speak about the same logical reward the ledger key does.
            '   AND NOT EXISTS (SELECT 1 FROM validator_rewards vr ' +
            '                     JOIN index_pubkeys pk ON pk.id = vr.signing_pubkey_id ' +
            '                    WHERE vr.reward_type = ara.reward_type ' +
            '                      AND vr.round_reference = ara.round_reference ' +
            '                      AND vr.round_qualifier = ' + arKey.sqlRoundQualifier('ara.reward_type', 'ara.snapshot_block') + ' ' +
            '                      AND pk.pubkey <= LOWER(ara.publisher)) ' +
            // Tiebreak on snapshot_block, the remaining component of uq_reward_tuple, BEFORE
            // ara.id. Two rows can share (reward_type, round_reference, publisher) and differ
            // only in snapshot_block, and deriveAnchorRewards upserts each one in this order
            // while validator_rewards' UNIQUE key omits snapshot_block, so the LAST row
            // processed decides the reward's earn-block block_index. ara.id is a per-node
            // AUTO_INCREMENT (arrival order on this mirror, reassigned by a from-genesis
            // re-mirror), so leaving it as the deciding term let two nodes credit the reward at
            // different heights, which COLLECT's `block_index <= ?` SUM and the block-scoped
            // rollback both read: a ledger-hash fork. Same discipline getOraclePrice states.
            // ara.id stays last only as a total-order fallback; it can no longer decide.
            ' ORDER BY ara.reward_type, ara.round_reference, ara.publisher, ara.snapshot_block, ara.id',
            [network, maxSnapshotBlock]);
    }

    // upsert: deterministic block-processing writers pass true so their value
    //         always wins over a best-effort hub push that raced them - the
    //         derived row is the consensus row (replay produces it byte-equal)
    // deriveBlockIndex: the block that MATERIALIZED the row, when that differs from the
    // reward's earn-block (blockIndex). Only the BTC-side anchor/archive
    //         derivation passes it: that path earns at the checkpoint's SNAPSHOT_BLOCK but
    //         writes while processing a much later BTC block, so rollback needs the creating
    // block to know the row must disappear. Every other writer earns and
    //         writes in the same block and leaves it NULL.
    // roundQualifier: the remaining component of the reward's UNIQUE identity. It is
    //         snapshot_block for 'anchor_archive' and 0 for every other reward type, because the
    //         archive leg's round_reference is MATCH_BATCH_SEQ - a dense hub counter a
    //         wipe-and-replay rebase reissues - so it alone does not name one logical reward.
    //         Callers compute it with anchor_reward_key.rewardRoundQualifier(); an omitted
    //         argument lands on 0, the value every pre-column row already carries, so every
    //         non-archive writer stays byte-identical.
    async createValidatorReward(pubkeyHex, roundReference, rewardType, amount, blockIndex, upsert, deriveBlockIndex, roundQualifier){
        let pubkey_id = await this.getPubkeyId(String(pubkeyHex).toLowerCase());
        if(pubkey_id === null){
            console.warn('createValidatorReward: unknown pubkey ' + pubkeyHex);
            return false;
        }
        // Strict active-row source resolution at this reward's block, matching the
        // ANCHOR archive + recovery (see _resolveActiveStakeSourceId).
        let source_id = await this._resolveActiveStakeSourceId(pubkey_id, blockIndex);
        if(source_id === null || source_id === undefined){
            console.warn('createValidatorReward: no active stake or delegation for pubkey ' + pubkeyHex + ' at block ' + blockIndex);
            return false;
        }
        // Insert the reward (idempotent via UNIQUE INDEX on
        // source_id+signing_pubkey_id+reward_type+round_reference+round_qualifier).
        // Deterministic writers upsert so their amount/block_index always win.
        let derive_block_index = (deriveBlockIndex === undefined || deriveBlockIndex === null)
            ? null : Number(deriveBlockIndex);
        // NEVER NULL. MariaDB treats NULLs as distinct in a UNIQUE index, so a nullable
        // qualifier would silently stop this key deduplicating rows at all - the opposite of
        // what the column is for. Coerced here so a caller that passes undefined/null still
        // writes the legacy 0.
        let round_qualifier = Number(roundQualifier);
        if(!Number.isFinite(round_qualifier) || round_qualifier < 0) round_qualifier = 0;
        round_qualifier = Math.floor(round_qualifier);
        let query = upsert
            ? `INSERT INTO validator_rewards
                    (source_id, signing_pubkey_id, reward_type, round_reference, round_qualifier, amount, block_index, derive_block_index)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE amount=VALUES(amount), block_index=VALUES(block_index),
                                         derive_block_index=VALUES(derive_block_index)`
            : `INSERT IGNORE INTO validator_rewards
                    (source_id, signing_pubkey_id, reward_type, round_reference, round_qualifier, amount, block_index, derive_block_index)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
        let args = [source_id, pubkey_id, rewardType, roundReference, round_qualifier, amount, blockIndex, derive_block_index];
        await this.doQuery(query, args);
        return true;
    }

    // Keep exactly ONE validator_reward per (reward_type, round_reference) for
    // anchor rewards: the row whose signing pubkey sorts lexicographically
    // smallest - the SAME deterministic winner the hub's RewardTracker elects
    // (recordAnchorReward). One logical anchor → one reward. In a failover
    // double-publish the loser's pubkey can be pushed to THIS indexer before
    // (or, because the hub's pushes are fire-and-forget, after) the winner's;
    // the hub dedups its own DB but has no path to retract an already-pushed
    // loser row from the indexer. Applying the identical smallest-pubkey rule
    // here is order-independent and keeps the COLLECT rail + recovery
    // single-winner fleet-wide (#3963). No-op for non-anchor reward types
    // (those are derived deterministically per block and never pushed).
    // The min-pubkey is materialised in a derived table so the DELETE doesn't
    // self-reference its target table (MariaDB forbids that inline).
    //
    // RB-ANCHOR: before the DELETE, pre-image each loser row into
    // anchor_reward_reconcile_log so a reorg that orphans THIS reconcile (the
    // ANCHOR action's block) can restore the deleted losers. The losers sit in
    // EARLIER surviving blocks (block_index = the checkpoint's SNAPSHOT_BLOCK),
    // so the generic block delete never touches them and a from-genesis replay
    // to reorg_block-1 (where the orphaned ANCHOR never re-ran the reconcile)
    // still has them; without the log the reorged node keeps a spuriously-
    // collapsed reward set, lowering a later COLLECT's SUM(validator_rewards)
    // vs a fresh replay (a ledger-hashed divergence). Logging is scoped to the
    // reconcile block, so callers that cannot name a block (legacy test paths)
    // pass null and skip the log (the DELETE behaviour is unchanged).
    //
    // Scoped by round_qualifier as well, and that scoping is the whole point for the archive
    // leg: 'anchor_archive' rounds are MATCH_BATCH_SEQ, a dense hub counter a wipe-and-replay
    // rebase reissues, so a (reward_type, round_reference) collapse reaches ACROSS two
    // genuinely distinct archive anchors and deletes a real, quorum-attested publisher's pay
    // as if it were a failover loser. The qualifier (snapshot_block for the archive leg, 0
    // everywhere else) is what the signed XANCPUB tuple already used to tell them apart.
    // An omitted qualifier is 0, so every per-chain caller behaves exactly as before.
    async reconcileAnchorRewardWinner(roundReference, rewardType, reconcileBlockIndex, anchorActionIndex, roundQualifier){
        if(!/^anchor_[A-Za-z_]+$/.test(String(rewardType))) return 0;
        let round_qualifier = Number(roundQualifier);
        if(!Number.isFinite(round_qualifier) || round_qualifier < 0) round_qualifier = 0;
        round_qualifier = Math.floor(round_qualifier);
        if(reconcileBlockIndex !== null && reconcileBlockIndex !== undefined){
            // Same loser predicate as the DELETE (pubkey > min_pubkey), capturing each
            // row's verbatim pre-image + its ORIGINAL earn-block (reward_block_index).
            // reward_derive_block_index carries the loser's MATERIALIZATION block
            // the earn-block alone cannot tell the restore whether a replay to reorg-1 would
            // have minted this loser at all, because a derived reward's earn-block is the far
            // earlier SNAPSHOT_BLOCK. NULL for a loser written by a same-block writer.
            let logQuery = `INSERT INTO anchor_reward_reconcile_log
                                (anchor_action_index, reward_type, round_reference, round_qualifier,
                                 source_id, signing_pubkey_id, amount, reward_block_index,
                                 reward_derive_block_index, block_index)
                            SELECT ?, vr.reward_type, vr.round_reference, vr.round_qualifier,
                                   vr.source_id, vr.signing_pubkey_id, vr.amount, vr.block_index,
                                   vr.derive_block_index, ?
                              FROM validator_rewards vr
                              JOIN index_pubkeys pk ON pk.id = vr.signing_pubkey_id
                              JOIN (
                                  SELECT MIN(pk2.pubkey) AS min_pubkey
                                  FROM validator_rewards vr2
                                  JOIN index_pubkeys pk2 ON pk2.id = vr2.signing_pubkey_id
                                  WHERE vr2.reward_type = ? AND vr2.round_reference = ?
                                    AND vr2.round_qualifier = ?
                              ) m
                              WHERE vr.reward_type = ? AND vr.round_reference = ?
                                AND vr.round_qualifier = ?
                                AND pk.pubkey > m.min_pubkey`;
            await this.doQuery(logQuery, [
                (anchorActionIndex === undefined ? null : anchorActionIndex), reconcileBlockIndex,
                rewardType, roundReference, round_qualifier,
                rewardType, roundReference, round_qualifier]);
        }
        let query = `DELETE vr FROM validator_rewards vr
                     JOIN index_pubkeys pk ON pk.id = vr.signing_pubkey_id
                     JOIN (
                         SELECT MIN(pk2.pubkey) AS min_pubkey
                         FROM validator_rewards vr2
                         JOIN index_pubkeys pk2 ON pk2.id = vr2.signing_pubkey_id
                         WHERE vr2.reward_type = ? AND vr2.round_reference = ?
                           AND vr2.round_qualifier = ?
                     ) m
                     WHERE vr.reward_type = ? AND vr.round_reference = ?
                       AND vr.round_qualifier = ?
                       AND pk.pubkey > m.min_pubkey`;
        let res = await this.doQuery(query, [rewardType, roundReference, round_qualifier,
                                             rewardType, roundReference, round_qualifier]);
        return res && res.affectedRows ? res.affectedRows : 0;
    }

    async createRewardClaim(data){
        data             = this.normalizeDataValues(data);
        let status_id    = await this.createStatus(data['STATUS']);
        let source_id    = await this.getAddressId(data['SOURCE']);
        let action_index = data['ACTION_INDEX'];
        let amount       = data['AMOUNT'] || '0';
        let block_index  = data['BLOCK_INDEX'];
        // Check if record already exists
        let query  = "SELECT action_index FROM reward_claims WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE reward_claims SET
                        source_id=?, amount=?, status_id=?, block_index=?
                    WHERE action_index=?`;
            args = [source_id, amount, status_id, block_index, action_index];
        } else {
            query = `INSERT INTO reward_claims
                        (source_id, amount, status_id, block_index, action_index)
                    VALUES (?, ?, ?, ?, ?)`;
            args = [source_id, amount, status_id, block_index, action_index];
        }
        await this.doQuery(query, args);
    }

    /*
     * Staking query methods
     */

    // Get active stake for a source address (existence/source check; returns any one of the source's active stake rows).
    // blockIndex enforces the 6-block activation/deactivation delay for BTC reorg safety.
    async getActiveStakeBySource(source, blockIndex){
        let source_id = await this.getAddressId(source);
        if(source_id === null)
            return null;
        let valid_id = await this.getStatusId('valid');
        let query = `SELECT
                        s.*, ip.pubkey as signing_pubkey
                    FROM stakes s
                        LEFT JOIN index_pubkeys ip ON (ip.id=s.signing_pubkey_id)
                    WHERE s.source_id=? AND s.status_id=?`;
        let args = [source_id, valid_id];
        if(blockIndex !== undefined && blockIndex !== null){
            query += ' AND s.activation_block <= ? AND (s.deactivation_block IS NULL OR s.deactivation_block > ?)';
            args.push(blockIndex);
            args.push(blockIndex);
        }
        query += ' ORDER BY s.action_index DESC LIMIT 1';
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            return results[0];
        return null;
    }

    // Count distinct active validators (by pubkey) qualified for the given capability.
    // Used for PBFT quorum calculation: quorum = max(2 * floor((N - 1) / 3) + 1, ceil((N + 1) / 2)).
    async getActiveCapabilityCount(capability, blockIndex, minStakeOverride){
        let caps = (this.config['STAKING'] && this.config['STAKING']['CAPABILITIES']) ? this.config['STAKING']['CAPABILITIES'] : {};
        let capConfig = caps[capability];
        if(!capConfig) return 0;
        // A caller-supplied threshold (the hub's authoritative MIN_STAKE) is
        // honoured VERBATIM (see getValidatorsByCapability). The local floor is
        // only the default when NO override is supplied; it is never used to clamp
        // an explicit caller value, so the quorum N counted here matches the
        // qualifying set membership of every other hub/indexer for the same block.
        let localFloor = capConfig['MIN_STAKE'] || '0';
        let minStake = (minStakeOverride !== undefined && minStakeOverride !== null)
            ? String(minStakeOverride)
            : localFloor;
        let valid_id = await this.getStatusId('valid');
        if(valid_id === null) return 0;
        // Count over the SAME effective signer set as getValidatorsByCapability
        // (stake keys minus revocations, plus delegated keys) - quorum thresholds
        // computed from this count must agree with set membership exactly.
        // All callers pass blockIndex; a missing one means "current tip".
        if(blockIndex === undefined || blockIndex === null)
            blockIndex = await this.getLatestBlockIndex();
        let eff = this._effectiveCapabilitySetSql(valid_id, blockIndex, minStake);
        let query = `SELECT COUNT(DISTINCT pubkey) AS cnt FROM (${eff.sql}) eff`;
        let results = await this.doQuery(query, eff.args);
        return results.length > 0 ? Number(results[0].cnt) : 0;
    }

    // Create/Update record in `prices` table (PRICE action log)
    // Stores the raw on-chain PRICE action data; the hub aggregates these into price_snapshots/oracle_prices
    async createPrice(data){
        data                = this.normalizeDataValues(data);
        let status_id       = await this.createStatus(data['STATUS']);
        let source_id       = await this.getAddressId(data['SOURCE']);
        let action_index    = data['ACTION_INDEX'];
        let version         = data['VERSION'];
        let validation      = data['VALIDATION_STATUS'] || 'pending';
        // v0 fields (round_number holds FIRST_ROUND on a v2 batch row; see prices.sql)
        let round_number    = data['ROUND'] || null;
        let round_timestamp = data['TIMESTAMP'] || null;
        let pair_count      = data['PAIR_COUNT'] || null;
        let pairs_json      = data['PAIRS_JSON'] || null;
        let sig_count       = data['SIG_COUNT'] || null;
        let sigs_json       = data['SIGS_JSON'] || null;
        // v2 fields (BATCH window; NULL on a v0/v1 row)
        let batch_first_round = data['BATCH_FIRST_ROUND'] || null;
        let batch_last_round  = data['BATCH_LAST_ROUND'] || null;
        let round_count       = data['ROUND_COUNT'] || null;
        let rounds_json       = data['ROUNDS_JSON'] || null;
        // v1 fields
        let coin_id         = (data['V1_COIN'])  ? await this.createCoin(data['V1_COIN'])     : null;
        let tick_id         = (data['V1_TICK'])  ? await this.createTicker(data['V1_TICK'])   : null;
        let fiat_id         = (data['V1_FIAT'])  ? await this.createFiat(data['V1_FIAT'])     : null;
        let value           = data['V1_VALUE'] || null;
        let fee             = data['V1_FEE']   || null;
        let memo_id         = (data['MEMO'])     ? await this.createMemo(data['MEMO'])         : null;
        // Check if record exists (idempotent for retries)
        let query   = "SELECT action_index FROM prices WHERE action_index=? LIMIT 1";
        let args    = [action_index];
        let exists  = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE prices SET
                        version=?, source_id=?, round_number=?, round_timestamp=?,
                        pair_count=?, pairs_json=?, sig_count=?, sigs_json=?,
                        batch_first_round=?, batch_last_round=?, round_count=?, rounds_json=?,
                        coin_id=?, tick_id=?, fiat_id=?, value=?, fee=?, memo_id=?,
                        validation_status=?, status_id=?
                    WHERE action_index=?`;
            args = [version, source_id, round_number, round_timestamp,
                    pair_count, pairs_json, sig_count, sigs_json,
                    batch_first_round, batch_last_round, round_count, rounds_json,
                    coin_id, tick_id, fiat_id, value, fee, memo_id,
                    validation, status_id, action_index];
        } else {
            query = `INSERT INTO prices
                        (version, source_id, round_number, round_timestamp,
                         pair_count, pairs_json, sig_count, sigs_json,
                         batch_first_round, batch_last_round, round_count, rounds_json,
                         coin_id, tick_id, fiat_id, value, fee, memo_id,
                         validation_status, status_id, action_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            args = [version, source_id, round_number, round_timestamp,
                    pair_count, pairs_json, sig_count, sigs_json,
                    batch_first_round, batch_last_round, round_count, rounds_json,
                    coin_id, tick_id, fiat_id, value, fee, memo_id,
                    validation, status_id, action_index];
        }
        await this.doQuery(query, args);
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
    // transactionConnection while a block is processing. Federation RPC
    // handlers that WRITE (pushvalidatorrewards) must use this view: a push
    // landing mid-block would otherwise join the block's ACID transaction and
    // be rolled back on a reorg/throw AFTER the API already acked it (the hub
    // never retries), and its statements would share the block's physical
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

    // Park a failed hub push for later retry. `payload` is the exact argument
    // object the HubClient method expects; it is serialized to JSON. The source
    // action_index is lifted out into its own column so a reorg can purge queued
    // pushes for orphaned actions via the rollback dataTables loop.
    async enqueueHubPush(pushType, payload){
        let actionIndex = (payload && payload.action_index != null) ? payload.action_index : 0;
        let query = `INSERT INTO pending_hub_pushes (push_type, action_index, payload, status, attempts, created_at)
                     VALUES (?, ?, ?, 'pending', 0, NOW())`;
        await this._poolQuery(query, [pushType, actionIndex, JSON.stringify(payload)]);
    }

    // Like enqueueHubPush, but routes through the OPEN transaction connection (doQuery, not
    // _poolQuery) so the row commits atomically with the caller's transaction, and returns the new
    // row id. Used by rollback.js to write-ahead its hub retractions inside the rollback transaction
    // (HUB-RETRACT-2): the durable row survives a crash between commit and live delivery, and the id
    // lets the caller markHubPushDelivered() on a successful immediate delivery. MUST be called with a
    // transaction open (getConnection() then returns transactionConnection); otherwise it would land
    // on a pooled connection and not be atomic with the rollback.
    async enqueueHubPushTx(pushType, payload){
        let actionIndex = (payload && payload.action_index != null) ? payload.action_index : 0;
        let query = `INSERT INTO pending_hub_pushes (push_type, action_index, payload, status, attempts, created_at)
                     VALUES (?, ?, ?, 'pending', 0, NOW())`;
        let res = await this.doQuery(query, [pushType, actionIndex, JSON.stringify(payload)]);
        return (res && res.insertId != null) ? Number(res.insertId) : null;
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

    // Fetch the oldest DUE pending rows for the poller (`failed` rows are excluded
    // - they are terminal). The backoff due-time predicate mirrors HubPushQueue's
    // JS-side _isDue formula (delay = LEAST(base * 2^(attempts-1), max)) directly
    // in the WHERE clause, so rows still parked in backoff no longer occupy the
    // LIMIT batch slots. Before this, a row that is pending-but-not-due still
    // counted against LIMIT, so a hub outage that accumulates more than `limit`
    // parked rows could starve every newer due row from ever being fetched
    // (review finding 01178748: head-of-line blocking). `baseBackoffMs` and
    // `maxBackoffMs` MUST be the same values HubPushQueue uses for _isDue, or the
    // two due-ness checks drift; the caller passes its own configured values.
    // The queue keeps _isDue as a cheap belt-and-braces re-check after fetch.
    async getPendingHubPushes(limit, backoffOpts){
        let max = Number(limit);
        if(!Number.isFinite(max) || max <= 0) max = 50;
        backoffOpts = backoffOpts || {};
        let baseSec = Math.max(1, Math.floor((Number(backoffOpts.baseBackoffMs) || 30000) / 1000));
        let maxSec  = Math.max(1, Math.floor((Number(backoffOpts.maxBackoffMs)  || 600000) / 1000));
        let query = `SELECT id, push_type, payload, attempts, last_attempted_at, status
                     FROM pending_hub_pushes
                     WHERE status='pending'
                       AND (last_attempted_at IS NULL
                            OR last_attempted_at <= DATE_SUB(NOW(), INTERVAL LEAST(? * POW(2, GREATEST(attempts - 1, 0)), ?) SECOND))
                     ORDER BY id ASC
                     LIMIT ?`;
        return await this._poolQuery(query, [baseSec, maxSec, max]);
    }

    // Drop a row once the hub has accepted it (delivered rows aren't retained).
    async markHubPushDelivered(id){
        await this._poolQuery('DELETE FROM pending_hub_pushes WHERE id=?', [id]);
    }

    // Delete terminal `failed` rows older than maxAgeSeconds and report how many
    // went. Retiring a row to `failed` takes it out of the poller's reach but NOT
    // out of the table: markHubPushDelivered drops only delivered rows, and the
    // rollback purge is scoped to an orphaned action range, so before this sweep a
    // sustained hub outage parked its terminal rows in pending_hub_pushes forever,
    // against the bounded-growth claim the queue makes for itself (item 3462).
    // Age-based rather than delete-on-terminal so the recent failures getStats
    // reports to the health endpoint stay readable. COALESCE covers a row marked
    // failed with no attempt stamp (unparseable payload, unknown push_type). A
    // non-positive age means retain forever and prunes nothing.
    async pruneFailedHubPushes(maxAgeSeconds){
        let age = Number(maxAgeSeconds);
        if(!Number.isFinite(age) || age <= 0) return 0;
        let res = await this._poolQuery(
            `DELETE FROM pending_hub_pushes
                     WHERE status = 'failed'
                       AND COALESCE(last_attempted_at, created_at) <= DATE_SUB(NOW(), INTERVAL ? SECOND)`,
            [Math.floor(age)]);
        return Number(res && res.affectedRows ? res.affectedRows : 0);
    }

    // Record a failed delivery attempt: bump the counter, stamp the time, keep
    // the last error, and retire the row to `failed` once it hits maxAttempts.
    // Retirement ends the retries; pruneFailedHubPushes above is what keeps the
    // table bounded once a row is terminal.
    async recordHubPushAttempt(id, errMsg, maxAttempts){
        let max = Number(maxAttempts);
        if(!Number.isFinite(max) || max <= 0) max = 10;
        let query = `UPDATE pending_hub_pushes
                     SET attempts = attempts + 1,
                         last_attempted_at = NOW(),
                         last_error = ?,
                         status = IF(attempts + 1 >= ?, 'failed', 'pending')
                     WHERE id = ?`;
        await this._poolQuery(query, [errMsg, max, id]);
    }

    // Get aggregate DIRECT active stake for a pubkey (SUM of amount across the pubkey's own
    // active stake rows). Returns { source_id, signing_pubkey_id, signing_pubkey, amount,
    // activation_block, ... } or null. blockIndex enforces the 6-block activation/deactivation
    // delay for BTC reorg safety.
    //
    // CONSENSUS-PATH, stake-ownership view. This is the load-bearing primitive for STAKE/UNSTAKE/
    // DELEGATE block processing (unstake.js, stake.js, delegate.js): it answers "does THIS pubkey
    // own a direct stake, and how much" for collision, ownership and unstake-AMOUNT decisions. It
    // deliberately does NOT apply the DELEGATE v2 revocation exclusion or resolve delegated keys to
    // their backing source. Those are capability-membership semantics that belong to the federation
    // effective-set view (getEffectiveStakeByPubkey / _effectiveCapabilitySetSql), not to stake
    // ownership: an UNSTAKE on a delegated-only key has no stake rows to deactivate, so crediting
    // the source's aggregate here would inflate balances (the cooldown sweep credits unstakes.AMOUNT
    // regardless of what was deactivated). Keep this query direct-stake-only.
    async getActiveStakeByPubkey(pubkey, blockIndex, opts){
        let pubkey_id = await this.getPubkeyId(String(pubkey).toLowerCase());
        if(pubkey_id === null)
            return null;
        let valid_id = await this.getStatusId('valid');
        let query = `SELECT
                        MIN(s.source_id)                       AS source_id,
                        s.signing_pubkey_id                    AS signing_pubkey_id,
                        SUM(CAST(s.amount AS DECIMAL(30,8)))   AS amount,
                        MIN(s.activation_block)                AS activation_block,
                        MIN(s.block_index)                     AS block_index,
                        MIN(s.status_id)                       AS status_id,
                        ip.pubkey                              AS signing_pubkey
                     FROM stakes s
                         LEFT JOIN index_pubkeys ip ON (ip.id = s.signing_pubkey_id)
                     WHERE s.signing_pubkey_id=? AND s.status_id=?`;
        let args = [pubkey_id, valid_id];
        if(blockIndex !== undefined && blockIndex !== null){
            if(opts && opts.undeactivatedOnly){
                // UNSTAKE path: only stakes not already being unstaked (deactivation_block
                // IS NULL). A stake already deactivating from a prior UNSTAKE in the same
                // activation-delay window stays "active" (deactivation_block is a future
                // block) and would otherwise be re-unstaked here, double-crediting the
                // staker at cooldown end (item 4617).
                query += ' AND s.activation_block <= ? AND s.deactivation_block IS NULL';
                args.push(blockIndex);
            } else {
                query += ' AND s.activation_block <= ? AND (s.deactivation_block IS NULL OR s.deactivation_block > ?)';
                args.push(blockIndex);
                args.push(blockIndex);
            }
        }
        query += ' GROUP BY s.signing_pubkey_id, ip.pubkey LIMIT 1';
        let results = await this.doQuery(query, args);
        if(results.length === 0) return null;
        let row = results[0];
        return {
            source_id:         row.source_id,
            signing_pubkey_id: row.signing_pubkey_id,
            signing_pubkey:    row.signing_pubkey,
            amount:            (row.amount === null || row.amount === undefined) ? '0' : String(row.amount),
            activation_block:  row.activation_block,
            block_index:       row.block_index,
            status_id:         row.status_id
        };
    }

    // Effective-set / capability view of a pubkey's stake, mirroring _effectiveCapabilitySetSql.
    // Returns { source_id, signing_pubkey_id, signing_pubkey, amount, activation_block, ... } or null.
    //
    // READ-ONLY (federation self-qualification). Used by the getownstake RPC so a hub whose only
    // stake authority comes via DELEGATE still sees itself as qualified, matching the federation's
    // view. NOT a consensus block-processing primitive: do NOT call this from STAKE/UNSTAKE/DELEGATE
    // handlers (use getActiveStakeByPubkey for stake-ownership there).
    //   Path 1: direct stake key, excluding DELEGATE v2 revocations active at blk.
    //   Path 2: delegated-only key, resolving to the delegating source's aggregate active stake.
    async getEffectiveStakeByPubkey(pubkey, blockIndex){
        let pubkey_id = await this.getPubkeyId(String(pubkey).toLowerCase());
        if(pubkey_id === null)
            return null;
        let valid_id = await this.getStatusId('valid');
        let blk = (blockIndex !== undefined && blockIndex !== null) ? blockIndex : null;

        // Path 1: direct stake key, excluding any revocations active at blk.
        // Mirrors the stake-key branch of hasCapability (stake_key_revocations NOT-EXISTS).
        let q1 = `SELECT
                        MIN(s.source_id)                       AS source_id,
                        s.signing_pubkey_id                    AS signing_pubkey_id,
                        SUM(CAST(s.amount AS DECIMAL(30,8)))   AS amount,
                        MIN(s.activation_block)                AS activation_block,
                        MIN(s.block_index)                     AS block_index,
                        MIN(s.status_id)                       AS status_id,
                        ip.pubkey                              AS signing_pubkey
                     FROM stakes s
                         LEFT JOIN index_pubkeys ip ON (ip.id = s.signing_pubkey_id)
                     WHERE s.signing_pubkey_id=? AND s.status_id=?
                       AND NOT EXISTS (
                           SELECT 1 FROM stake_key_revocations r
                           WHERE r.source_id = s.source_id
                             AND r.signing_pubkey_id = s.signing_pubkey_id
                             AND r.status_id = ?
                             AND r.deactivation_block <= ?
                             AND r.action_index > s.action_index)
                       AND NOT EXISTS (
                           SELECT 1 FROM capability_slash_events cse
                           WHERE cse.signing_pubkey_id = s.signing_pubkey_id
                             AND cse.block_index <= ?)`;
        let a1 = [pubkey_id, valid_id, valid_id, blk !== null ? blk : 0, blk !== null ? blk : 0];
        if(blk !== null){
            q1 += ' AND s.activation_block <= ? AND (s.deactivation_block IS NULL OR s.deactivation_block > ?)';
            a1.push(blk, blk);
        }
        q1 += ' GROUP BY s.signing_pubkey_id, ip.pubkey LIMIT 1';
        let results = await this.doQuery(q1, a1);
        if(results.length > 0){
            let row = results[0];
            return {
                source_id:         row.source_id,
                signing_pubkey_id: row.signing_pubkey_id,
                signing_pubkey:    row.signing_pubkey,
                amount:            (row.amount === null || row.amount === undefined) ? '0' : String(row.amount),
                activation_block:  row.activation_block,
                block_index:       row.block_index,
                status_id:         row.status_id
            };
        }

        // Path 2: delegated key. If this pubkey has an active delegation row, return the
        // delegating source's aggregate active stake (mirrors the delegated-key branch of
        // hasCapability). The returned amount is the source's total so the hub self-qualifies
        // when delegation-only; source_id/activation_block are from the delegation row.
        let q2 = `SELECT d.source_id AS source_id,
                         d.signing_pubkey_id AS signing_pubkey_id,
                         ip.pubkey AS signing_pubkey,
                         d.activation_block AS activation_block,
                         d.block_index AS block_index,
                         d.status_id AS status_id,
                         SUM(CAST(s2.amount AS DECIMAL(30,8))) AS amount
                  FROM delegations d
                  JOIN stakes s2 ON s2.source_id = d.source_id
                  LEFT JOIN index_pubkeys ip ON ip.id = d.signing_pubkey_id
                  WHERE d.signing_pubkey_id = ?
                    AND d.status_id = ?
                    AND s2.status_id = ?
                    AND NOT EXISTS (
                        SELECT 1 FROM capability_slash_events cse
                        WHERE cse.signing_pubkey_id = d.signing_pubkey_id
                          AND cse.block_index <= ?)`;
        let a2 = [pubkey_id, valid_id, valid_id, blk !== null ? blk : 0];
        if(blk !== null){
            q2 += ' AND d.activation_block <= ? AND (d.deactivation_block IS NULL OR d.deactivation_block > ?)';
            q2 += ' AND s2.activation_block <= ? AND (s2.deactivation_block IS NULL OR s2.deactivation_block > ?)';
            a2.push(blk, blk, blk, blk);
        }
        q2 += ' GROUP BY d.source_id, d.signing_pubkey_id LIMIT 1';
        let drows = await this.doQuery(q2, a2);
        if(drows.length > 0 && drows[0].amount !== null){
            let row = drows[0];
            return {
                source_id:         row.source_id,
                signing_pubkey_id: row.signing_pubkey_id,
                signing_pubkey:    row.signing_pubkey,
                amount:            String(row.amount),
                activation_block:  row.activation_block,
                block_index:       row.block_index,
                status_id:         row.status_id
            };
        }

        return null;
    }

    // Latest parsed block index (highest entry in blocks table), or 0 if none.
    async getLatestBlockIndex(){
        let results = await this.doQuery('SELECT MAX(block_index) AS max_block FROM blocks');
        if(!results || results.length === 0) return 0;
        let max = results[0].max_block;
        return (max === null || max === undefined) ? 0 : Number(max);
    }

    // Return all pubkeys with ANY active stake at `blockIndex`, regardless
    // of capability. Used by xchain-hub's Consensus (config-change PBFT) to
    // snapshot the whole-federation validator set at a block boundary -
    // governance/config quorum is over every staker, not just a capability
    // subset (OracleConsensus uses getValidatorsByCapability('price', ...)
    // when the quorum is capability-scoped).
    async getActiveValidators(blockIndex){
        let valid_id = await this.getStatusId('valid');
        if(valid_id === null) return [];
        // Safety cap on the result set. This query runs on every cache miss
        // (and in-process, uncached, inside block processing), so an unbounded
        // result on an unexpectedly large validator set is a latency/liveness
        // risk. The cap is generous relative to any realistic federation size;
        // hitting it is logged so operators get early warning that the set is
        // outgrowing the assumption. VALIDATOR_QUERY_LIMIT is a frozen consensus
        // constant; raising it requires a coordinated fleet upgrade, not a per-node override.
        let limit = this.config['VALIDATOR_QUERY_LIMIT'];
        // Same effective-signer resolution as the capability set (DELEGATE
        // additive-until-revoked semantics) with no MIN_STAKE floor: the
        // governance quorum is over every staker's effective keys.
        let eff = this._effectiveCapabilitySetSql(valid_id, blockIndex, '0');
        let query = `SELECT pubkey, MAX(total) AS total FROM (${eff.sql}) eff
                     GROUP BY pubkey
                     ORDER BY pubkey
                     LIMIT ?`;
        let rows = await this.doQuery(query, [...eff.args, limit]);
        let truncated = rows.length >= limit;
        if(truncated)
            console.warn('getActiveValidators hit the result cap of ' + limit + ' rows at block ' + blockIndex + ' - validator set may be truncated. Raise the frozen VALIDATOR_QUERY_LIMIT consensus constant (coordinated fleet upgrade) if the federation has grown.');
        let result = rows.map(r => ({
            pubkey: String(r.pubkey),
            amount: (r.total === null || r.total === undefined) ? '0' : String(r.total)
        }));
        // Surface truncation to callers (the RPC layer alarms on it) the same way
        // the capability variants do - the console.warn alone is invisible to a hub.
        result.truncated = truncated;
        return result;
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

    // Return all pubkeys whose SUM(active stake) at `blockIndex` meets the
    // capability's MIN_STAKE. Used by xchain-hub's CapabilitySnapshot to lock
    // the validator set at a block boundary for PBFT quorum calculations -
    // every hub independently calling this against the same blockIndex must
    // arrive at the same set, so consensus on quorum N is deterministic.
    // Spec: capability-staking model §6 (deterministic quorum selection).
    async getValidatorsByCapability(capability, blockIndex, minStakeOverride){
        // Off-BTC chains have no local capability stakes (capability staking is BTC-only),
        // so resolve the qualifying set from the hub-mirrored capability_snapshots at the
        // (BTC-anchored) block. Scoped to the capabilities verified on a non-BTC chain:
        // `cross_chain` (cross-chain match settlement) and `oracle_publish` (the DOGE-only
        // ANCHOR action); other capabilities keep the existing local-stakes path (which is
        // empty off BTC, exactly as before).
        if(this.config['COIN'] !== 'BTC' && (capability === 'cross_chain' || capability === 'oracle_publish'))
            return await this.getCapabilitySnapshotValidators(capability, blockIndex);
        let caps = (this.config['STAKING'] && this.config['STAKING']['CAPABILITIES']) ? this.config['STAKING']['CAPABILITIES'] : {};
        let capConfig = caps[capability];
        if(!capConfig) return [];
        // A caller-supplied threshold (the hub passes its own authoritative,
        // signed/governance-anchored MIN_STAKE) is honoured VERBATIM on both the
        // count path and the weight path. The local config can drift between
        // independently-operated indexers, so honouring the caller's value (never
        // clamping it to this indexer's own floor) keeps every hub/indexer
        // computing the SAME qualifying set for the same block - that cross-hub /
        // cross-indexer determinism is the consensus invariant. The local floor is
        // ONLY the default when NO override is supplied (non-hub callers); it is
        // never a clamp on an explicit caller value. Anti-inflation is enforced at
        // the hub layer (signed/governance-anchored MIN_STAKE) and by on-chain
        // validation (which uses the local floor), NOT by this read-path clamp.
        // getStakeWeightsByCapability resolves minStake identically, so the
        // count/set-membership path and the weight path stay symmetric.
        let localFloor = capConfig['MIN_STAKE'] || '0';
        let minStake = (minStakeOverride !== undefined && minStakeOverride !== null)
            ? String(minStakeOverride)
            : localFloor;
        let valid_id = await this.getStatusId('valid');
        if(valid_id === null) return [];
        // Safety cap - see getActiveValidators. Bounds the result set so a
        // cache miss (or the uncached in-process call during block processing)
        // can't return an unbounded set on a large federation. VALIDATOR_QUERY_LIMIT
        // is a frozen consensus constant; raising it requires a coordinated fleet
        // upgrade, not a per-node override.
        let limit = this.config['VALIDATOR_QUERY_LIMIT'];
        let eff = this._effectiveCapabilitySetSql(valid_id, blockIndex, minStake);
        let query = `SELECT pubkey, MAX(total) AS total FROM (${eff.sql}) eff
                     GROUP BY pubkey
                     ORDER BY pubkey
                     LIMIT ?`;
        let rows = await this.doQuery(query, [...eff.args, limit]);
        let truncated = rows.length >= limit;
        if(truncated)
            console.warn('getValidatorsByCapability(' + capability + ') hit the result cap of ' + limit + ' rows at block ' + blockIndex + ' - validator set may be truncated. Raise the frozen VALIDATOR_QUERY_LIMIT consensus constant (coordinated fleet upgrade) if the federation has grown.');
        let result = rows.map(r => ({
            pubkey: String(r.pubkey),
            amount: (r.total === null || r.total === undefined) ? '0' : String(r.total)
        }));
        result.truncated = truncated;
        return result;
    }

    // Effective signer set for a capability at a block (DELEGATE semantics,
    // additive-until-revoked). A source's effective keys are:
    //   stake keys     - per-pubkey aggregate active stake >= MIN_STAKE, EXCLUDING
    //                    keys revoked via DELEGATE v2 (stake_key_revocations). A
    //                    revocation only applies to stake rows that predate it
    //                    (r.action_index > s.action_index), so re-staking the same
    //                    key later restores it.
    //   delegated keys - active `delegations` rows whose SOURCE's aggregate active
    //                    stake >= MIN_STAKE. Delegated keys are backed by the
    //                    source's whole stake; they add signers, they never change
    //                    staked amounts (spec: DELEGATE.md).
    // Every PBFT-quorum read (capability snapshots, signature verification, quorum
    // counts) MUST resolve through this one query so all consumers agree -
    // CONSENSUS-CRITICAL: any change here forks validation.
    _effectiveCapabilitySetSql(valid_id, blockIndex, minStake){
        // Permanent disqualification (WI-2 bump 2): a signing key proven to have
        // equivocated is PERMANENTLY barred from the effective signer set - not just
        // until its current bond burns to 0, but against any future re-stake/re-delegation
        // of the same key. The exclusion is GLOBAL (any capability the key was slashed in
        // bars it everywhere - an equivocating key has proven byzantine) and block-gated
        // (`cse.block_index <= ?`) so re-deriving a historical block before the slash is
        // byte-identical, and reorg-safe (the slash event rolls back ⇒ eligibility returns).
        // Applied identically in _stakeWeightsSql and hasCapability so every quorum read agrees.
        const slashExcl = (keyCol) =>
            `AND NOT EXISTS (SELECT 1 FROM capability_slash_events cse
                             WHERE cse.signing_pubkey_id = ${keyCol} AND cse.block_index <= ?)`;
        let sql = `SELECT ip.pubkey AS pubkey,
                          SUM(CAST(s.amount AS DECIMAL(30,8))) AS total
                   FROM stakes s
                   JOIN index_pubkeys ip ON ip.id = s.signing_pubkey_id
                   WHERE s.status_id = ?
                     AND s.activation_block <= ?
                     AND (s.deactivation_block IS NULL OR s.deactivation_block > ?)
                     AND NOT EXISTS (
                         SELECT 1 FROM stake_key_revocations r
                         WHERE r.source_id = s.source_id
                           AND r.signing_pubkey_id = s.signing_pubkey_id
                           AND r.status_id = ?
                           AND r.deactivation_block <= ?
                           AND r.action_index > s.action_index)
                     ${slashExcl('s.signing_pubkey_id')}
                   GROUP BY ip.pubkey
                   HAVING total >= CAST(? AS DECIMAL(30,8))
                   UNION ALL
                   SELECT ip2.pubkey AS pubkey, src.total AS total
                   FROM delegations d
                   JOIN index_pubkeys ip2 ON ip2.id = d.signing_pubkey_id
                   JOIN (
                       SELECT s2.source_id AS source_id,
                              SUM(CAST(s2.amount AS DECIMAL(30,8))) AS total
                       FROM stakes s2
                       WHERE s2.status_id = ?
                         AND s2.activation_block <= ?
                         AND (s2.deactivation_block IS NULL OR s2.deactivation_block > ?)
                       GROUP BY s2.source_id
                       HAVING total >= CAST(? AS DECIMAL(30,8))
                   ) src ON src.source_id = d.source_id
                   WHERE d.status_id = ?
                     AND d.activation_block <= ?
                     AND (d.deactivation_block IS NULL OR d.deactivation_block > ?)
                     ${slashExcl('d.signing_pubkey_id')}`;
        let args = [valid_id, blockIndex, blockIndex, valid_id, blockIndex, blockIndex, minStake,
                    valid_id, blockIndex, blockIndex, minStake,
                    valid_id, blockIndex, blockIndex, blockIndex];
        return { sql, args };
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
        // weights from the hub-mirrored capability_snapshots (same capability scoping
        // as getValidatorsByCapability).
        if(this.config['COIN'] !== 'BTC' && (capability === 'cross_chain' || capability === 'oracle_publish'))
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

    // Source-keyed effective-signer query (DELEGATE.md additive model).
    //   qualifying sources - per-source aggregate active stake >= MIN_STAKE.
    //   effective keys     - the source's own active stake keys (EXCLUDING keys
    //                        revoked via DELEGATE v2 in effect at the block, applied
    //                        only to stake rows predating the revocation) UNION the
    //                        source's active delegated keys.
    // One output row per (effective key): { pubkey, source(address), weight(=source
    // aggregate) }. Every key of a source carries the SAME source + weight, so a
    // source-deduped tally counts that stake once. CONSENSUS-CRITICAL - mirrors the
    // qualification/revocation/delegation semantics of _effectiveCapabilitySetSql.
    _stakeWeightsSql(valid_id, blockIndex, minStake){
        // Precision: DECIMAL(30,8) (22 integer digits, 8 fractional) is sufficient because the
        // staking tick is XCHAIN at 8 decimals and total supply stays far below 10^22; every
        // same-version node truncates identically, so the stake-weight tally is deterministic.
        // If a >8-decimal staking tick is ever introduced, widen these casts to
        // DECIMAL(60, <tick-decimals>) AND pin a consistent sql_mode fleet-wide (an overflow at
        // >22 integer digits is otherwise sql_mode-dependent) before that tick can stake.
        // Permanent disqualification - see _effectiveCapabilitySetSql. Excludes equivocation-
        // slashed keys from the effective-key set (both stake-key and delegated-key branches)
        // so the source-deduped stake-weight tally matches the count-quorum set exactly.
        const slashExcl = (keyCol) =>
            `AND NOT EXISTS (SELECT 1 FROM capability_slash_events cse
                             WHERE cse.signing_pubkey_id = ${keyCol} AND cse.block_index <= ?)`;
        let sql = `SELECT ip.pubkey AS pubkey,
                          sa.address AS source,
                          q.total    AS weight
                   FROM (
                       SELECT s.source_id AS source_id,
                              SUM(CAST(s.amount AS DECIMAL(30,8))) AS total
                       FROM stakes s
                       WHERE s.status_id = ?
                         AND s.activation_block <= ?
                         AND (s.deactivation_block IS NULL OR s.deactivation_block > ?)
                       GROUP BY s.source_id
                       HAVING total >= CAST(? AS DECIMAL(30,8))
                   ) q
                   JOIN index_addresses sa ON sa.id = q.source_id
                   JOIN (
                       SELECT s2.source_id AS source_id, s2.signing_pubkey_id AS pubkey_id
                       FROM stakes s2
                       WHERE s2.status_id = ?
                         AND s2.activation_block <= ?
                         AND (s2.deactivation_block IS NULL OR s2.deactivation_block > ?)
                         AND NOT EXISTS (
                             SELECT 1 FROM stake_key_revocations r
                             WHERE r.source_id = s2.source_id
                               AND r.signing_pubkey_id = s2.signing_pubkey_id
                               AND r.status_id = ?
                               AND r.deactivation_block <= ?
                               AND r.action_index > s2.action_index)
                         ${slashExcl('s2.signing_pubkey_id')}
                       GROUP BY s2.source_id, s2.signing_pubkey_id
                       UNION
                       SELECT d.source_id AS source_id, d.signing_pubkey_id AS pubkey_id
                       FROM delegations d
                       WHERE d.status_id = ?
                         AND d.activation_block <= ?
                         AND (d.deactivation_block IS NULL OR d.deactivation_block > ?)
                         ${slashExcl('d.signing_pubkey_id')}
                   ) ek ON ek.source_id = q.source_id
                   JOIN index_pubkeys ip ON ip.id = ek.pubkey_id`;
        let args = [valid_id, blockIndex, blockIndex, minStake,
                    valid_id, blockIndex, blockIndex, valid_id, blockIndex, blockIndex,
                    valid_id, blockIndex, blockIndex, blockIndex];
        return { sql, args };
    }

    // SWQ source-cap wrapper (SWQ-TRUNC-1 liveness half). Wraps an inner source-keyed
    // stake-weight builder ({sql,args} from _stakeWeightsSql or the sync AsOf variant)
    // and replaces the raw key-row LIMIT with a windowed cap on the consensus UNIT:
    // DISTINCT staking SOURCES (DENSE_RANK over source) plus a per-source key bound
    // (ROW_NUMBER per source). One source can no longer fill the window and evict
    // honest sources. Over-fetches one extra source (_sr <= maxSources + 1) so the
    // caller can flag a genuinely >maxSources federation as truncated (the primitive
    // then fails closed); the per-source key cap only bounds the row/leaf count and
    // never sets truncated (dropping a source's excess keys does not change its
    // weight). Row order is consensus-irrelevant (the stakes_root SMT keys on
    // pubkey+capability); only the returned SET is. CONSENSUS-CRITICAL: feeds the
    // hashed stakes_root at/after SWQ_SOURCE_CAP_ACTIVATION and MUST stay byte-identical
    // to the xchain-sync twin (cross-repo drift guard in rollback-coverage.test.js).
    //
    // `binCollation` (stake_weight_collation_activation.js) pins the ordering to a
    // binary collation. `source` and `pubkey` resolve through index_addresses.address
    // and index_pubkeys.pubkey, both declared utf8_general_ci (folding), and every
    // other consensus read of those columns already pins utf8_bin. Order is a
    // consensus quantity HERE and only here: the two window ranks are what the caps
    // truncate on, so the collation decides which sources and which keys survive into
    // the hashed stakes_root. Below the height the emitted SQL is byte-identical to
    // what shipped before the gate; the suffix is '' and concatenates away.
    _cappedStakeWeightsSql(inner, maxSources, maxKeys, binCollation){
        let c = stakeWeightCollation.stakeWeightCollate(binCollation);
        let sql = `SELECT r.pubkey AS pubkey, r.source AS source, r.weight AS weight, r._sr AS _sr
                   FROM (
                       SELECT b.pubkey AS pubkey, b.source AS source, b.weight AS weight,
                              DENSE_RANK() OVER (ORDER BY b.source${c})                        AS _sr,
                              ROW_NUMBER() OVER (PARTITION BY b.source${c} ORDER BY b.pubkey${c})  AS _kr
                       FROM (${inner.sql}) b
                   ) r
                   WHERE r._sr <= ? AND r._kr <= ?
                   ORDER BY r.source${c}, r.pubkey${c}`;
        let args = [...inner.args, maxSources + 1, maxKeys];
        return { sql, args };
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

    // Read the hub-mirrored SOURCE-KEYED weights for a capability at a snapshot block
    // (non-BTC chains). Carries `source` so the verifier can dedupe by staking address.
    // ORDER BY is CONSENSUS-CRITICAL here. This feeds
    // stake-weighted quorum for off-BTC chains, and an unordered SELECT hands the
    // row order to the storage engine, so two nodes can return the same rows in
    // different sequences. That is harmless only for as long as every consumer is
    // order-insensitive; the moment one dedupes, tie-breaks or truncates, the two
    // nodes disagree about the validator set and validation forks.
    //
    // The ordering deliberately does NOT use `id`. It is the obvious choice and it
    // is wrong here: the schema documents `id` as a LOCAL surrogate with NO hub
    // parity (hubs persist independently and AnchorRecovery rebuilds rows id-less,
    // so the mirror strips wire ids). Ordering by it would be stable per node and
    // divergent across the fleet, which is the worst shape a bug can take.
    //
    // Use the natural key instead. The WHERE already pins (capability,
    // snapshot_block), so within the result set the remaining components of
    // uq_cap_snap (snapshot_block, capability, signing_pubkey, source) are
    // (signing_pubkey, source), and the unique key guarantees that pair is
    // distinct. Exactly one ordering is therefore valid, and it is computed from
    // mirrored natural-key columns that every node holds identically. The unique
    // key and this ORDER BY are compared under the same table collation, so the
    // pair cannot tie here while being accepted as distinct by the index.
    async getCapabilitySnapshotWeights(capability, snapshotBlock){
        let query = `SELECT signing_pubkey AS pubkey, source, amount AS weight
                     FROM capability_snapshots
                     WHERE capability = ? AND snapshot_block = ?
                     ORDER BY signing_pubkey ASC, source ASC`;
        let rows = await this._mirrorDb().doQuery(query, [capability, snapshotBlock]);
        return rows.map(r => ({
            pubkey: String(r.pubkey),
            source: r.source == null ? '' : String(r.source),
            // The query aliases `amount AS weight`, so the value lands on r.weight -
            // reading r.amount (undefined) collapsed EVERY weight to '0', which made
            // stake-weighted quorum fail closed (S=0) for off-BTC chains (DOGE/LTC).
            // capability_snapshots.amount is NOT NULL, so a missing weight here means
            // the mirror is corrupt, not that a source has no stake: THROW
            // rather than resolve it to '0', which would keep the source in the dedupe
            // map with no stake and quietly shrink the quorum denominator S.
            weight: requireStakeWeight(r.weight, 'getCapabilitySnapshotWeights(' + capability + ')')
        }));
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

    // Check whether a pubkey's active stake qualifies for a capability.
    // Returns true if SUM(active stake amount for pubkey) >= governance.min_stake[capability].
    async hasCapability(pubkey, capability, blockIndex, minStakeOverride){
        // Off-BTC chains verify cross_chain (match settlement) and oracle_publish (the
        // DOGE-only ANCHOR action) against the hub-mirrored capability snapshot
        // (presence = qualified) since capability stakes live only on BTC. Other
        // capabilities keep the local-stakes path. See getValidatorsByCapability.
        if(this.config['COIN'] !== 'BTC' && (capability === 'cross_chain' || capability === 'oracle_publish'))
            return await this.isPubkeyInCapabilitySnapshot(pubkey, capability, blockIndex);
        let caps = (this.config['STAKING'] && this.config['STAKING']['CAPABILITIES']) ? this.config['STAKING']['CAPABILITIES'] : {};
        let capConfig = caps[capability];
        if(!capConfig) return false;
        // A caller-supplied threshold (the hub's authoritative MIN_STAKE) is
        // honoured VERBATIM (see getValidatorsByCapability). The local floor is
        // only the default when NO override is supplied; it never clamps an
        // explicit caller value, so this per-pubkey membership test agrees with
        // the qualifying set that every other hub/indexer resolves for the block.
        let localFloor = capConfig['MIN_STAKE'] || '0';
        let minStake = (minStakeOverride !== undefined && minStakeOverride !== null)
            ? String(minStakeOverride)
            : localFloor;
        let valid_id = await this.getStatusId('valid');
        if(valid_id === null) return false;
        let pubkey_id = await this.getPubkeyId(String(pubkey).toLowerCase());
        if(pubkey_id === null) return false;
        if(blockIndex === undefined || blockIndex === null)
            blockIndex = await this.getLatestBlockIndex();
        // Permanent disqualification (WI-2 bump 2): an equivocation-slashed key is barred
        // from ALL capabilities - must agree with the effective-set queries
        // (_effectiveCapabilitySetSql / _stakeWeightsSql), which exclude it too.
        if(await this._isPubkeySlashedAt(pubkey_id, blockIndex)) return false;
        // Per-pubkey membership test against the SAME effective signer set as
        // getValidatorsByCapability (stake keys minus DELEGATE v2 revocations,
        // plus delegated keys backed by the source's aggregate stake) - the
        // signature-verification paths and the quorum-set paths must agree.
        // Stake-key path: per-pubkey aggregate of active, non-revoked stakes.
        let query = `SELECT SUM(CAST(s.amount AS DECIMAL(30,8))) AS total
                     FROM stakes s
                     WHERE s.signing_pubkey_id = ?
                       AND s.status_id = ?
                       AND s.activation_block <= ?
                       AND (s.deactivation_block IS NULL OR s.deactivation_block > ?)
                       AND NOT EXISTS (
                           SELECT 1 FROM stake_key_revocations r
                           WHERE r.source_id = s.source_id
                             AND r.signing_pubkey_id = s.signing_pubkey_id
                             AND r.status_id = ?
                             AND r.deactivation_block <= ?
                             AND r.action_index > s.action_index)`;
        let rows = await this.doQuery(query, [pubkey_id, valid_id, blockIndex, blockIndex, valid_id, blockIndex]);
        if(rows.length > 0 && rows[0].total !== null && this.util.bcgte(String(rows[0].total), minStake))
            return true;
        // Delegated-key path: an active delegation row for this pubkey qualifies
        // iff the delegating SOURCE's aggregate active stake meets the threshold.
        query = `SELECT SUM(CAST(s2.amount AS DECIMAL(30,8))) AS total
                 FROM stakes s2
                 WHERE s2.status_id = ?
                   AND s2.activation_block <= ?
                   AND (s2.deactivation_block IS NULL OR s2.deactivation_block > ?)
                   AND s2.source_id IN (
                       SELECT d.source_id FROM delegations d
                       WHERE d.signing_pubkey_id = ?
                         AND d.status_id = ?
                         AND d.activation_block <= ?
                         AND (d.deactivation_block IS NULL OR d.deactivation_block > ?))`;
        rows = await this.doQuery(query, [valid_id, blockIndex, blockIndex, pubkey_id, valid_id, blockIndex, blockIndex]);
        if(rows.length > 0 && rows[0].total !== null && this.util.bcgte(String(rows[0].total), minStake))
            return true;
        return false;
    }

    // ── Full-node possession proofs (NODEPROOF / verified-validator tier) ──────
    // Record that `pubkeyHex` was verified (by a quorum-signed NODEPROOF verdict)
    // to have answered the possession challenge for `epochHeight`. Resolves the
    // staking source the same way createValidatorReward does. Idempotent on
    // (epoch_height, signing_pubkey) so a replayed/duplicate verdict is a no-op.
    async createNodeProofVerification(pubkeyHex, challengeId, epochHeight, targetHeight, actionIndex, blockIndex){
        let pubkey_id = await this.getPubkeyId(String(pubkeyHex).toLowerCase());
        if(pubkey_id === null){
            console.warn('createNodeProofVerification: unknown pubkey ' + pubkeyHex);
            return false;
        }
        // Source = the staking address active at this block, strict active-row
        // resolution matching createValidatorReward + the ANCHOR archive/recovery.
        let source_id = await this._resolveActiveStakeSourceId(pubkey_id, blockIndex);
        if(source_id === null || source_id === undefined){
            console.warn('createNodeProofVerification: no active stake or delegation for pubkey ' + pubkeyHex + ' at block ' + blockIndex);
            return false;
        }
        let query = `INSERT IGNORE INTO full_node_verifications
                        (action_index, challenge_id, epoch_height, target_height, signing_pubkey_id, source_id, passed, block_index)
                     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`;
        await this.doQuery(query, [actionIndex, String(challengeId).toLowerCase(), epochHeight, targetHeight, pubkey_id, source_id, blockIndex]);
        return true;
    }

    // Validators with a `passed` possession-proof inside PROOF_WINDOW_BLOCKS of
    // `blockIndex` - the "verified full node" set (before the live-stake intersect,
    // which callers apply via hasCapability('full_node')). Returns one row per
    // verified pubkey carrying its staking `source` so the equal reward split can
    // dedupe per source (one operator = one full node = one share). Deterministic -
    // depends only on earlier on-chain verdicts.
    async getVerifiedFullNodeSet(blockIndex){
        let window = parseInt((this.config['FULLNODE'] || {})['PROOF_WINDOW_BLOCKS']) || 0;
        let low    = parseInt(blockIndex) - window;
        // Safety cap matching the sibling validator-set RPCs (getActiveValidators,
        // getValidatorsByCapability, etc.) so this path can't return an unbounded
        // set on a large federation. VALIDATOR_QUERY_LIMIT is a frozen consensus
        // constant; raising it requires a coordinated fleet upgrade, not a
        // per-node override.
        let limit = this.config['VALIDATOR_QUERY_LIMIT'];
        let query = `SELECT DISTINCT ip.pubkey AS pubkey, sa.address AS source, fv.source_id AS source_id
                     FROM full_node_verifications fv
                     JOIN index_pubkeys   ip ON ip.id = fv.signing_pubkey_id
                     JOIN index_addresses sa ON sa.id = fv.source_id
                     WHERE fv.passed = 1
                       AND fv.block_index >  ?
                       AND fv.block_index <= ?
                     ORDER BY ip.pubkey ASC, sa.address ASC
                     LIMIT ?`;
        // ORDER BY is required: this set feeds the equal full-node reward split, so a
        // LIMIT without a deterministic order would truncate a different subset on each
        // node (storage/join order differs) and diverge the ledger. Order on
        // consensus-stable columns (pubkey, then source address) - NOT source_id, which
        // is a local AUTO_INCREMENT surrogate that differs per node.
        let rows = await this.doQuery(query, [low, blockIndex, limit]);
        let truncated = rows.length >= limit;
        if(truncated)
            console.warn('getVerifiedFullNodeSet hit the result cap of ' + limit + ' rows at block ' + blockIndex + ' - full-node verifier set may be truncated. Raise the frozen VALIDATOR_QUERY_LIMIT consensus constant (coordinated fleet upgrade) if the federation has grown.');
        let result = rows.map(r => ({
            pubkey:    String(r.pubkey),
            source:    r.source == null ? '' : String(r.source),
            source_id: r.source_id
        }));
        result.truncated = truncated;
        return result;
    }

    // Participation-rate inputs for the full-node REWARD gate (price.js). Earning the
    // full-node tranche is a carrot, not a stick - there is NO slashing; a node that
    // doesn't run a full node simply doesn't pass challenges and doesn't get paid.
    // Over the trailing FULLNODE.REWARD_PASS_WINDOW_BLOCKS ending at `blockIndex` this
    // returns:
    //   - totalEpochs: the number of DISTINCT challenge epochs that produced at least
    //     one PASSING verdict (the denominator - counting only epochs the federation
    //     actually ran, so an outage never penalizes a node), and
    //   - sources: one entry per staking SOURCE that passed in the window, carrying
    //     passed_epochs (DISTINCT epochs that source answered) and the lowercased set of
    //     its passing pubkeys (so price.js can pick a representative round-signer).
    // Deterministic - depends only on earlier on-chain NODEPROOF verdicts; all counts
    // are integers (the gate compares passed*10000 >= bps*total, never floats).
    async getFullNodeParticipation(blockIndex){
        let fn     = this.config['FULLNODE'] || {};
        let window = parseInt(fn['REWARD_PASS_WINDOW_BLOCKS']) || parseInt(fn['PROOF_WINDOW_BLOCKS']) || 0;
        let result = { totalEpochs: 0, sources: [] };
        if(window <= 0) return result;
        let low = parseInt(blockIndex) - window;
        // Denominator - distinct challenge epochs with >=1 passing verdict in the window.
        let totRows = await this.doQuery(
            `SELECT COUNT(DISTINCT epoch_height) AS epochs
               FROM full_node_verifications
              WHERE passed = 1 AND block_index > ? AND block_index <= ?`,
            [low, blockIndex]);
        result.totalEpochs = (totRows.length && totRows[0].epochs != null) ? Number(totRows[0].epochs) : 0;
        if(result.totalEpochs === 0) return result;
        // Numerator rows - (source, epoch, pubkey) for every passing verdict in the
        // window. ORDER BY consensus-stable columns (address, epoch_height, pubkey) -
        // a total order identical fleet-wide, NOT fv.source_id, a local index_addresses
        // AUTO_INCREMENT surrogate that differs per node (the same house rule the sibling
        // getVerifiedFullNodeSet states). The Map/Set aggregation below is order-insensitive
        // today, but a future LIMIT or first-source dust allocation would make this row
        // order consensus-visible, so keep the deterministic total order.
        let rows = await this.doQuery(
            `SELECT fv.source_id AS source_id, sa.address AS source,
                    fv.epoch_height AS epoch_height, ip.pubkey AS pubkey
               FROM full_node_verifications fv
               JOIN index_pubkeys   ip ON ip.id = fv.signing_pubkey_id
               JOIN index_addresses sa ON sa.id = fv.source_id
              WHERE fv.passed = 1 AND fv.block_index > ? AND fv.block_index <= ?
              ORDER BY sa.address, fv.epoch_height, ip.pubkey`,
            [low, blockIndex]);
        let bySource = new Map();
        for(let r of rows){
            let sid   = String(r.source_id);
            let entry = bySource.get(sid);
            if(!entry){
                entry = { source_id: r.source_id, source: r.source == null ? '' : String(r.source),
                          epochs: new Set(), pubkeys: new Set() };
                bySource.set(sid, entry);
            }
            entry.epochs.add(Number(r.epoch_height));
            entry.pubkeys.add(String(r.pubkey).toLowerCase());
        }
        for(let entry of bySource.values())
            result.sources.push({
                source_id:     entry.source_id,
                source:        entry.source,
                passed_epochs: entry.epochs.size,
                pubkeys:       entry.pubkeys
            });
        return result;
    }

    // Connection for hub-mirrored tables (price_snapshots, oracle_prices,
    // cross_chain_matches, capability_snapshots). In distributed deployments these live in
    // the local hub-DB copy; single-host falls back to this indexer DB. Mirrors the
    // `(this.actions.hubDb || this.indexerDb)` idiom used at the oracle read sites.
    _mirrorDb(){
        return (this.indexer && this.indexer.hubDb) ? this.indexer.hubDb : this;
    }

    // Read the hub-mirrored qualifying validator set for a capability at a BTC-anchored
    // snapshot block. Presence in capability_snapshots = qualified (the hub only mirrors
    // pubkeys already past min_stake). Lets a non-BTC indexer resolve the cross_chain set.
    // Ordered for the same reason as the sibling getCapabilitySnapshotWeights
    // this resolves the cross_chain validator set on non-BTC indexers,
    // so an engine-dependent row order is a fork waiting for the first consumer that
    // dedupes or truncates. Same natural-key ordering, and `source` is ordered on
    // even though it is not selected: a pubkey delegated by two sources produces two
    // rows here, so pubkey alone is not a total order.
    async getCapabilitySnapshotValidators(capability, snapshotBlock){
        let query = `SELECT signing_pubkey AS pubkey, amount
                     FROM capability_snapshots
                     WHERE capability = ? AND snapshot_block = ?
                     ORDER BY signing_pubkey ASC, source ASC`;
        let rows = await this._mirrorDb().doQuery(query, [capability, snapshotBlock]);
        // Guard a NULL amount to '0' so all three snapshot read methods render it
        // identically: the sibling getCapabilitySnapshotWeights (r.weight == null ?
        // '0') and the BTC local path both coerce NULL to '0'; without this an
        // unguarded NULL would surface as the literal string 'null'.
        return rows.map(r => ({ pubkey: String(r.pubkey), amount: r.amount == null ? '0' : String(r.amount) }));
    }

    // Whether a pubkey is in the mirrored capability snapshot at a block (qualified).
    async isPubkeyInCapabilitySnapshot(pubkey, capability, snapshotBlock){
        let query = `SELECT 1 FROM capability_snapshots
                     WHERE capability = ? AND snapshot_block = ? AND signing_pubkey = ? LIMIT 1`;
        let rows = await this._mirrorDb().doQuery(query, [capability, snapshotBlock, String(pubkey).toLowerCase()]);
        return rows.length > 0;
    }

    /*
     * ANCHOR action methods (DOGE-only on-chain state commitments).
     * anchor_actions is the permanent on-chain record (action-indexed, rolled back
     * like any data table); the hub-mirrored state_checkpoints copy is the live
     * verification source. Spec: xchain-documentation/protocol/actions/ANCHOR.md
     */

    // Create/Update record in `anchor_actions` table (one row per ANCHOR action_index).
    async createAnchorAction(data){
        data            = this.normalizeDataValues(data);
        let status_id   = await this.createStatus(data['STATUS']);
        let action_index = data['ACTION_INDEX'];
        let version      = Number(data['FORMAT']);
        // Publisher tail (#2486): v4/v5/v6 only; NULL otherwise. Mirrors validator_signatures
        // exactly: anchor.js pre-serializes the XANCPUB sig list to a JSON string (as it does
        // VALIDATOR_SIGNATURES = JSON.stringify(sigs)) before dispatch, so both are stored as-is.
        let publisher = data['PUBLISHER'] || null;
        let publisherAttestations = data['PUBLISHER_ATTESTATIONS'] || null;
        let args = [
            version,
            data['CHAIN'] || null,
            data['NETWORK'] || null,
            (data['BLOCK_INDEX_CHECKPOINTED'] != null) ? Number(data['BLOCK_INDEX_CHECKPOINTED']) : null,
            data['BLOCK_HASH'] || null,
            data['LEDGER_HASH'] || null,
            data['ACTIONS_HASH'] || null,
            data['CONTRACT_HASH'] || null,
            (data['CHECKPOINT_SEQ'] != null) ? Number(data['CHECKPOINT_SEQ']) : null,
            (data['SNAPSHOT_BLOCK'] != null) ? Number(data['SNAPSHOT_BLOCK']) : null,
            data['STATE_ROOT'] || null,
            (data['STATE_ROOT_VERSION'] != null) ? Number(data['STATE_ROOT_VERSION']) : null,
            data['BLOCK_MERKLE_ROOT'] || null,
            (data['BLOCK_MERKLE_VERSION'] != null) ? Number(data['BLOCK_MERKLE_VERSION']) : null,
            (data['MATCH_BATCH_SEQ'] != null) ? Number(data['MATCH_BATCH_SEQ']) : null,
            (data['MATCH_COUNT'] != null) ? Number(data['MATCH_COUNT']) : null,
            data['BATCH_CRC32'] || null,
            (data['TOTAL_CHUNKS'] != null) ? Number(data['TOTAL_CHUNKS']) : null,
            (data['CHUNK_INDEX'] != null) ? Number(data['CHUNK_INDEX']) : null,
            data['ARCHIVE_B64'] || null,
            data['VALIDATOR_SIGNATURES'] || null,
            // v4/v5/v6 publisher-attestation tail (#2486). Both NULL for v0-v3. anchor.js must set
            // data['PUBLISHER_ATTESTATIONS'] = JSON.stringify(publisherSigs) for the attestations
            // to flow (that one-line hand-off is owned in anchor.js).
            publisher,
            publisherAttestations,
            status_id,
            data['BLOCK_INDEX']
        ];
        let exists = (await this.doQuery("SELECT action_index FROM anchor_actions WHERE action_index=? LIMIT 1", [action_index])).length > 0;
        if(exists){
            await this.doQuery(
                `UPDATE anchor_actions SET version=?, chain=?, network=?, block_index=?, block_hash=?,
                        ledger_hash=?, actions_hash=?, contract_hash=?, checkpoint_seq=?, snapshot_block=?,
                        state_root=?, state_root_version=?, block_merkle_root=?, block_merkle_version=?,
                        match_batch_seq=?, match_count=?, batch_crc32=?, total_chunks=?, chunk_index=?,
                        archive_b64=?, validator_signatures=?, publisher=?, publisher_attestations=?,
                        status_id=?, block_index_doge=?
                 WHERE action_index=?`, args.concat([action_index]));
        } else {
            await this.doQuery(
                `INSERT INTO anchor_actions
                        (version, chain, network, block_index, block_hash, ledger_hash, actions_hash,
                         contract_hash, checkpoint_seq, snapshot_block, state_root, state_root_version,
                         block_merkle_root, block_merkle_version, match_batch_seq, match_count,
                         batch_crc32, total_chunks, chunk_index, archive_b64, validator_signatures,
                         publisher, publisher_attestations,
                         status_id, block_index_doge, action_index)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, args.concat([action_index]));
        }
    }

    // Highest VALID checkpoint_seq recorded for (chain, network) - the ANCHOR
    // replay guard. Only status 'valid'/'unverified' rows count (an 'invalid: ...'
    // replay attempt must not poison the watermark).
    async getMaxAnchorCheckpointSeq(chain, network){
        // Version set is the single source of truth in anchor-action-query.js
        // (shared with getAnchorActionByCheckpoint + the RPC) so the replay
        // watermark can never drift from the checkpoint-bearing definition
        // (a hand-copied literal here once omitted v4/v5, freezing the guard).
        let versions = ANCHOR_CHECKPOINT_VERSIONS;
        let query = `SELECT MAX(a.checkpoint_seq) AS max_seq
                     FROM anchor_actions a
                     JOIN index_statuses s ON s.id = a.status_id
                     WHERE a.chain = ? AND a.network = ?
                       AND a.version IN (${versions.map(() => '?').join(', ')})
                       AND s.status IN ('valid', 'unverified')`;
        let rows = await this.doQuery(query, [chain, network, ...versions]);
        return (rows.length > 0 && rows[0].max_seq != null) ? Number(rows[0].max_seq) : null;
    }

    // Look up the on-chain ANCHOR checkpoint record for one checkpoint identity
    // (chain, network, block_index, checkpoint_seq), joined to its status. Only
    // checkpoint-bearing versions (0/1/3/4/5/6, per the ANCHOR_CHECKPOINT_VERSIONS
    // constant below; version 2 is an archive continuation chunk with no checkpoint
    // identity of its own, and v6 is the publisher-bearing archive anchor that
    // DOES carry a checkpoint identity). Returns the highest action_index
    // match (a reorg-replayed re-anchor supersedes an earlier one) or null. Read path
    // for the getanchoraction RPC: it lets the hub confirm an announced anchor actually
    // landed on-chain, with the matching payload, at DOGE depth, before trusting an
    // anchor-gossip stamp/reward (the block_index_doge column carries the DOGE height).
    async getAnchorActionByCheckpoint(chain, network, block_index, checkpoint_seq){
        // Version set is the single source of truth in anchor-action-query.js (shared
        // with the RPC + tests) so the SQL filter can never drift from it.
        let versions = ANCHOR_CHECKPOINT_VERSIONS;
        let query = `SELECT a.action_index, a.version, a.chain, a.network, a.block_index,
                            a.block_hash, a.ledger_hash, a.actions_hash, a.contract_hash,
                            a.checkpoint_seq, a.snapshot_block, a.state_root, a.state_root_version,
                            a.block_merkle_root, a.block_merkle_version, a.block_index_doge, s.status
                     FROM anchor_actions a
                     JOIN index_statuses s ON s.id = a.status_id
                     WHERE a.chain = ? AND a.network = ? AND a.block_index = ? AND a.checkpoint_seq = ?
                       AND a.version IN (${versions.map(() => '?').join(', ')})
                     ORDER BY a.action_index DESC
                     LIMIT 1`;
        let rows = await this.doQuery(query,
            [chain, network, Number(block_index), Number(checkpoint_seq), ...versions]);
        return rows.length > 0 ? rows[0] : null;
    }

    // The two watermarks the v1/v6 archive replay guard needs, read from ONE row
    // set so they cannot disagree: the highest archive batch seq recorded, and the
    // highest wrapper checkpoint seq among those same archive-head rows.
    //
    // They are returned together deliberately. The guard rejects a stale
    // batch seq only when the wrapper checkpoint is ALSO not advancing, so two
    // independently-read watermarks could describe row sets that never coexisted
    // (one stubbed, one live; one filtered on a drifted version list) and the guard
    // would then reject a legitimate archive or admit a replay. Reading both in one
    // statement makes the impossible combination unrepresentable, and the version
    // predicate comes from ARCHIVE_HEAD_VERSIONS rather than a literal IN (1, 6)
    // for the same reason getMaxAnchorCheckpointSeq stopped hand-copying its set
    // (a copied literal once omitted v4/v5 and froze that guard).
    //
    // 'unverified' is included for the same reason it is in getMaxAnchorCheckpointSeq:
    // a node with no mirrored oracle_publish snapshot cannot verify signatures and
    // stores every well-formed ANCHOR unverified, so excluding it would make the
    // watermark differ between mirrored and unmirrored nodes. Note the direction of
    // that exposure: a poisoned row can only push either watermark UP, which makes
    // the guard stricter, never more permissive.
    async getArchiveReplayWatermarks(){
        let versions = ARCHIVE_HEAD_VERSIONS;
        let query = `SELECT MAX(a.match_batch_seq) AS max_batch_seq,
                            MAX(a.checkpoint_seq)  AS max_checkpoint_seq
                     FROM anchor_actions a
                     JOIN index_statuses s ON s.id = a.status_id
                     WHERE a.version IN (${versions.map(() => '?').join(', ')})
                       AND s.status IN ('valid', 'unverified')`;
        let rows = await this.doQuery(query, [...versions]);
        let row  = rows.length > 0 ? rows[0] : {};
        return {
            batchSeq:      (row.max_batch_seq      != null) ? Number(row.max_batch_seq)      : null,
            checkpointSeq: (row.max_checkpoint_seq != null) ? Number(row.max_checkpoint_seq) : null,
        };
    }

    // The archive-head anchor (v1, or the publisher-bearing v6) that started an
    // archive batch (status irrelevant - chunk geometry checks belong to the caller).
    // match_batch_seq is NOT unique: the replay guard in anchor.js _parseCheckpoint accepts
    // an EQUAL MATCH_BATCH_SEQ ('never below the recorded max; equal is allowed'), so a
    // permissionless re-broadcast or failover double-publish stores a SECOND v1/v6 row for
    // the same batch. The returned parent feeds a consensus-visible geometry/CRC verdict in
    // anchor.js _parseContinuation (TOTAL_CHUNKS gate + batch_crc32 reassembly, which stamps
    // setAnchorArchiveStatus(parent.action_index,'invalid_archive')), so the pick MUST be a
    // deterministic total order or two honest nodes select different parents and persist
    // divergent anchor_actions status fleet-wide. ORDER BY action_index ASC picks the EARLIEST
    // (canonical) head - the one that actually STARTED the batch - matching the 'lowest
    // action_index wins' tie-break the v2-continuation dedup below already uses. Order on
    // action_index (consensus-visible, unique on this single-network table), never the local
    // AUTO_INCREMENT id, which differs per node.
    // The row also carries `source`: the head's AUTHOR address, resolved through
    // actions.source_id (#3075). anchor.js binds every v2 continuation chunk to it, so a
    // junk chunk can no longer squat a slot and deny the batch. LEFT JOINed so the head
    // PICK is unchanged from the pre-#3075 query (an inner join would skip an unlinked
    // head and select a different one, moving a consensus-visible geometry verdict); an
    // unresolvable author arrives as null and anchor.js fails the chunk closed.
    // `author`, when supplied, narrows the candidates to heads authored by
    // that address, i.e. the batch key becomes (match_batch_seq, head author). The
    // caller (anchor.js, gated on the flag day) passes it so a junk head broadcast at
    // another publisher's batch seq can no longer be the parent that governs that
    // publisher's chunks. Omitted / null keeps the legacy canonical-head pick exactly,
    // including the query text, so nothing moves below the flag day. The narrowing
    // rides on the SAME LEFT-joined address the row already exposes as `source`: a head
    // whose author cannot be resolved compares unequal and is skipped, which is
    // fail-closed (the chunk lands 'orphan' rather than authenticated against nothing).
    async getAnchorV1ByBatchSeq(batchSeq, author){
        let scoped = (author !== undefined && author !== null);
        // Version set from ARCHIVE_HEAD_VERSIONS, never a literal IN (1, 6), for the
        // reason getArchiveReplayWatermarks states above: this is the same earliest-head
        // pick as ARCHIVE_HEAD_AUTHOR_SQL in anchor-action-query.js, and it feeds the
        // consensus-visible geometry/CRC verdict in anchor.js _parseContinuation. A
        // hand-copied set drifts the moment a new publisher-bearing head version is
        // added, and the two head picks would then disagree fleet-wide.
        let rows = await this.doQuery(
            `SELECT a.*, adr.address AS source
             FROM anchor_actions a
             LEFT JOIN actions         act ON act.action_index = a.action_index
             LEFT JOIN index_addresses adr ON adr.id           = act.source_id
             WHERE a.version ${ARCHIVE_HEAD_VERSIONS_SQL} AND a.match_batch_seq = ?` +
            (scoped ? ` AND adr.address = ?` : ``) +
            ` ORDER BY a.action_index ASC LIMIT 1`,
            scoped ? [batchSeq, String(author)] : [batchSeq]);
        return rows.length > 0 ? rows[0] : null;
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

    // Flag an anchor row (e.g. 'invalid_archive' when chunk reassembly fails CRC).
    async setAnchorArchiveStatus(actionIndex, status){
        let status_id = await this.createStatus(status);
        await this.doQuery("UPDATE anchor_actions SET status_id = ? WHERE action_index = ?", [status_id, actionIndex]);
    }

    /*
     * Contract-targeted staking methods (STAKE v3 / UNSTAKE v1 / DELEGATE v1)
     * Parallel to the capability staking system; tracked in separate tables to keep
     * capability-staking queries unchanged.
     */

    // Create/Update record in `contract_stakes` table.
    // Each STAKE v3 action gets its own row; active stake for (target, pubkey, tick)
    // is SUM(amount) across all valid rows. Top-up vs. new is determined by caller.
    async createContractStake(data){
        data                    = this.normalizeDataValues(data);
        let status_id           = await this.createStatus(data['STATUS']);
        let source_id           = await this.getAddressId(data['SOURCE']);
        let signing_pubkey_id   = await this.getOrCreatePubkeyId(data['SIGNING_PUBKEY']);
        let tick_id             = await this.createTicker(data['TICK']);
        let action_index        = data['ACTION_INDEX'];
        let version             = data['VERSION'] || 3;
        let target_contract_index = Number(data['TARGET_CONTRACT_INDEX']);
        let amount              = data['AMOUNT'] || '0';
        let block_index         = data['BLOCK_INDEX'];
        let activation_block    = data['ACTIVATION_BLOCK'] || 0;
        let query  = "SELECT action_index FROM contract_stakes WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE contract_stakes SET
                        source_id=?, version=?, signing_pubkey_id=?, target_contract_index=?, tick_id=?,
                        amount=?, status_id=?, block_index=?, activation_block=?
                    WHERE action_index=?`;
            args = [source_id, version, signing_pubkey_id, target_contract_index, tick_id,
                    amount, status_id, block_index, activation_block, action_index];
        } else {
            query = `INSERT INTO contract_stakes
                        (source_id, version, signing_pubkey_id, target_contract_index, tick_id,
                         amount, status_id, block_index, activation_block, action_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            args = [source_id, version, signing_pubkey_id, target_contract_index, tick_id,
                    amount, status_id, block_index, activation_block, action_index];
        }
        await this.doQuery(query, args);
    }

    // Set deactivation_block for the ALREADY-ACTIVE contract_stakes rows matching (target, pubkey, tick).
    // Used by createContractUnstake to start the cooldown on a staker's active (target, tick) rows.
    // Same load-bearing `currentBlock` filter as setStakeDeactivationByPubkey: a pending-activation
    // top-up (activation_block > currentBlock) is excluded from the unstake amount, so deactivating it
    // here would orphan its tokens (cooldown sweep never refunds it). It stays active until a later UNSTAKE.
    async setContractStakeDeactivationByPubkey(targetContractIndex, pubkey, tick, deactivationBlock, currentBlock){
        let pubkey_id = await this.getPubkeyId(String(pubkey).toLowerCase());
        if(pubkey_id === null) return false;
        let tick_id = await this.getTickerId(tick);
        if(tick_id === null) return false;
        let valid_id = await this.getStatusId('valid');
        let query = `UPDATE contract_stakes SET deactivation_block=?
                     WHERE target_contract_index=? AND signing_pubkey_id=? AND tick_id=?
                       AND status_id=? AND deactivation_block IS NULL
                       AND activation_block <= ?`;
        await this.doQuery(query, [deactivationBlock, Number(targetContractIndex), pubkey_id, tick_id, valid_id, currentBlock]);
        return true;
    }

    // Get aggregate active contract-stake for (target, pubkey, tick).
    // Returns { source_id, signing_pubkey_id, signing_pubkey, tick_id, tick, amount, activation_block } or null.
    //
    // SIGNING-KEY ROTATIONS (#4366). `pubkey` is the CURRENT key on the stake row, so once a
    // DELEGATE v1 rotation has been materialized (CONTRACT_DELEGATION_MATERIALIZE) an UNSTAKE
    // names the rotated key, not the original - the same key getContractStakeDataForVM shows the
    // contract. The caller (UNSTAKE v1) still checks that SOURCE owns the aggregate, so a
    // rotation never lets the delegate's holder move someone else's stake.
    async getActiveContractStakeByPubkey(targetContractIndex, pubkey, tick, blockIndex, opts){
        let pubkey_id = await this.getPubkeyId(String(pubkey).toLowerCase());
        if(pubkey_id === null) return null;
        let tick_id = await this.getTickerId(tick);
        if(tick_id === null) return null;
        let valid_id = await this.getStatusId('valid');
        // Select the raw per-row amount strings instead of a SQL SUM. Contract-staked tokens may
        // carry up to MAX_TOKEN_DECIMALS (18) decimals, but SUM(CAST(... AS DECIMAL(30,8))) truncates
        // anything finer than 8 dp before it reaches the refund, and the mariadb driver could further
        // coerce a wide DECIMAL aggregate to a lossy JS Number. Aggregating the raw VARCHAR amounts
        // with the bignumber wrapper at the staked tick's own precision keeps XCHAIN(8) output
        // byte-identical to the old path and makes >8-dp tokens exact (item 5303).
        let query = `SELECT
                        cs.source_id          AS source_id,
                        cs.amount             AS amount,
                        cs.activation_block   AS activation_block,
                        cs.block_index        AS block_index,
                        ip.pubkey             AS signing_pubkey,
                        t.tick                AS tick
                     FROM contract_stakes cs
                         LEFT JOIN index_pubkeys ip ON (ip.id = cs.signing_pubkey_id)
                         LEFT JOIN index_tickers t  ON (t.id  = cs.tick_id)
                     WHERE cs.target_contract_index=? AND cs.signing_pubkey_id=? AND cs.tick_id=? AND cs.status_id=?`;
        let args = [Number(targetContractIndex), pubkey_id, tick_id, valid_id];
        if(blockIndex !== undefined && blockIndex !== null){
            if(opts && opts.undeactivatedOnly){
                // UNSTAKE path: only contract-stakes not already being unstaked
                // (deactivation_block IS NULL). A stake already deactivating from a prior
                // UNSTAKE in the same activation-delay window keeps a future deactivation_block
                // and would otherwise be re-unstaked here, double-crediting the cooldown refund.
                // Mirrors the v0 stakes path (getActiveStakeByPubkey, item 4617).
                query += ' AND cs.activation_block <= ? AND cs.deactivation_block IS NULL';
                args.push(blockIndex);
            } else {
                query += ' AND cs.activation_block <= ? AND (cs.deactivation_block IS NULL OR cs.deactivation_block > ?)';
                args.push(blockIndex);
                args.push(blockIndex);
            }
        }
        query += ' ORDER BY cs.action_index ASC';
        let results = await this.doQuery(query, args);
        if(results.length === 0) return null;
        // Sum the raw amounts at the token's own decimal precision. MIN(source_id/activation_block/
        // block_index) is replicated in JS so the returned shape matches the prior GROUP BY row.
        let decimals = await this.getTokenDecimalPrecision(tick_id);
        let amount = '0';
        let source_id = null, activation_block = null, block_index = null;
        for(let row of results){
            amount = this.util.bcadd(amount, row.amount, decimals);
            let rSource = (row.source_id === null || row.source_id === undefined) ? null : Number(row.source_id);
            if(rSource !== null && (source_id === null || rSource < source_id)) source_id = rSource;
            let rAct = (row.activation_block === null || row.activation_block === undefined) ? null : Number(row.activation_block);
            if(rAct !== null && (activation_block === null || rAct < activation_block)) activation_block = rAct;
            let rBlk = (row.block_index === null || row.block_index === undefined) ? null : Number(row.block_index);
            if(rBlk !== null && (block_index === null || rBlk < block_index)) block_index = rBlk;
        }
        // bcadd returns a bignumber; emit the canonical fixed-precision string the callers expect
        // (matches the prior String(SUM(...)) representation for XCHAIN at 8 dp).
        amount = this.util.bcformat(amount, decimals);
        return {
            source_id:         source_id,
            signing_pubkey_id: pubkey_id,
            signing_pubkey:    results[0].signing_pubkey,
            tick_id:           tick_id,
            tick:              results[0].tick,
            amount:            amount,
            activation_block:  activation_block,
            block_index:       block_index
        };
    }

    // Check whether the (target, source) combination already owns an active stake for (pubkey, tick).
    // Used by STAKE v3 to detect "new vs. top-up" - top-up requires the existing stake be owned by the same source.
    async getContractStakeOwner(targetContractIndex, pubkey, tick){
        let pubkey_id = await this.getPubkeyId(String(pubkey).toLowerCase());
        if(pubkey_id === null) return null;
        let tick_id = await this.getTickerId(tick);
        if(tick_id === null) return null;
        let valid_id = await this.getStatusId('valid');
        let query = `SELECT source_id FROM contract_stakes
                     WHERE target_contract_index=? AND signing_pubkey_id=? AND tick_id=? AND status_id=?
                     ORDER BY action_index ASC LIMIT 1`;
        let results = await this.doQuery(query, [Number(targetContractIndex), pubkey_id, tick_id, valid_id]);
        if(results.length === 0) return null;
        return Number(results[0].source_id);
    }

    // Create/Update record in `contract_unstakes` table
    async createContractUnstake(data){
        data                  = this.normalizeDataValues(data);
        let status_id         = await this.createStatus(data['STATUS']);
        let source_id         = await this.getAddressId(data['SOURCE']);
        let signing_pubkey_id = await this.getOrCreatePubkeyId(data['SIGNING_PUBKEY']);
        let tick_id           = await this.createTicker(data['TICK']);
        let target_contract_index = Number(data['TARGET_CONTRACT_INDEX']);
        let action_index      = data['ACTION_INDEX'];
        let cooldown_end_block = data['COOLDOWN_END_BLOCK'];
        let amount            = data['AMOUNT'] || '0';
        let block_index       = data['BLOCK_INDEX'];
        let query  = "SELECT action_index FROM contract_unstakes WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE contract_unstakes SET
                        source_id=?, signing_pubkey_id=?, target_contract_index=?, tick_id=?,
                        cooldown_end_block=?, amount=?, status_id=?, block_index=?
                    WHERE action_index=?`;
            args = [source_id, signing_pubkey_id, target_contract_index, tick_id,
                    cooldown_end_block, amount, status_id, block_index, action_index];
        } else {
            query = `INSERT INTO contract_unstakes
                        (source_id, signing_pubkey_id, target_contract_index, tick_id,
                         cooldown_end_block, amount, status_id, block_index, action_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            args = [source_id, signing_pubkey_id, target_contract_index, tick_id,
                    cooldown_end_block, amount, status_id, block_index, action_index];
        }
        await this.doQuery(query, args);
    }

    // Create/Update record in `contract_delegations` table
    async createContractDelegation(data){
        data                  = this.normalizeDataValues(data);
        let status_id         = await this.createStatus(data['STATUS']);
        let source_id         = await this.getAddressId(data['SOURCE']);
        let signing_pubkey_id = await this.getOrCreatePubkeyId(data['SIGNING_PUBKEY']);
        let tick_id           = await this.createTicker(data['TICK']);
        let target_contract_index = Number(data['TARGET_CONTRACT_INDEX']);
        let action_index      = data['ACTION_INDEX'];
        let block_index       = data['BLOCK_INDEX'];
        let activation_block  = data['ACTIVATION_BLOCK'] || 0;
        let query  = "SELECT action_index FROM contract_delegations WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE contract_delegations SET
                        source_id=?, signing_pubkey_id=?, target_contract_index=?, tick_id=?,
                        status_id=?, block_index=?, activation_block=?
                    WHERE action_index=?`;
            args = [source_id, signing_pubkey_id, target_contract_index, tick_id,
                    status_id, block_index, activation_block, action_index];
        } else {
            query = `INSERT INTO contract_delegations
                        (source_id, signing_pubkey_id, target_contract_index, tick_id,
                         status_id, block_index, activation_block, action_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
            args = [source_id, signing_pubkey_id, target_contract_index, tick_id,
                    status_id, block_index, activation_block, action_index];
        }
        await this.doQuery(query, args);
    }

    // Materialize matured DELEGATE v1 signing-key rotations onto contract_stakes (#4366,
    // gated by CONTRACT_DELEGATION_MATERIALIZE; the caller,
    // utility.processContractDelegationMaterializations, owns the gate).
    //
    // WHY THIS EXISTS. DELEGATE v1 wrote contract_delegations and stopped there, but all THREE
    // contract-stake lookup surfaces key on contract_stakes.signing_pubkey_id:
    // getContractStakeDataForVM (what a contract sees through getStake/getStakers/
    // getTotalStaked), getActiveContractStakeByPubkey (the UNSTAKE refund aggregate) and
    // slashContractStake (the SLASH deduction). So a rotated key owned nothing: it never
    // appeared in getStakers, and a SLASH against it deducted zero while the contract recorded
    // the punishment. Rewriting the key HERE, on the row itself, is what makes the three
    // surfaces agree - remapping only the reads would leave SLASH naming a key the ledger
    // cannot debit, which is strictly worse than the coherent gap it replaces.
    //
    // WHEN. Called once per block, BEFORE the block's transactions, so a rotation is visible to
    // everything in its activation block; that matches the `activation_block <= blockIndex`
    // semantics every other contract-stake read uses. Runs inside the block transaction, so the
    // rewrites and their journal rows commit (or roll back) with the block.
    //
    // WHICH ROWS. One delegation GOVERNS each (target, source, tick) slot: the matured, un-revoked
    // delegation with the greatest (activation_block, action_index). Selecting all matured
    // delegations instead would let two live delegations rewrite the same rows in opposite
    // directions on every block forever. Its key is written to every valid, never-unstaked
    // contract_stakes row on that slot, INCLUDING rows still inside their activation delay: a
    // pending top-up left on the old key would surface as a second, phantom staker under the old
    // pubkey the moment it activates.
    //
    // BOTH STAKE TABLES. The still-slashable contract_unstakes rows on the slot rotate too, even
    // though nothing shows them to a contract. slashContractStake Pass 2 finds cooldown-locked
    // tokens by (target, pubkey, tick); leaving those rows on the old key while the contract is
    // shown the new one would let the cooldown-locked portion of a rotated staker's balance
    // escape every slash - a rotation would become a way to shield funds. 'completed' rows are
    // skipped: they were already refunded and are not slashable. The cooldown sweep keys on
    // action_index/source, never on the pubkey, so refunds are unaffected.
    //
    // REVOKE. DELEGATE v3 ends a delegation's authority (deactivation_block). A slot whose
    // rotation was revoked and has no other governing delegation is reverted to the key the
    // stake was created with, read back from the FIRST journal row for that stake row - a
    // revoked (typically compromised) key must not keep owning the stake in the VM snapshot.
    // The revert is skipped, deterministically, when another source has since claimed that
    // pubkey on any contract stake or delegation: merging two owners under one pubkey would
    // fold them into a single staker entry in the VM snapshot. Such a claim is only possible
    // because the DELEGATE v1 / STAKE v3 collision checks do not reserve a pre-rotation key;
    // reserving it is a separate validity change and would need its own flag-day.
    //
    // DETERMINISM. Every ordering key is replay-stable (block_index, activation_block,
    // action_index); the AUTO_INCREMENT journal id is never ordered on. Returns the applied
    // rotations (audit/tests); an empty array is the common case.
    async materializeContractDelegations(currentBlock){
        let applied  = [];
        let valid_id = await this.getStatusId('valid');
        if(valid_id === null) return applied;
        let block = Number(currentBlock);

        // 1. Governing delegations: matured, not revoked as-of this block, and the LATEST such
        //    delegation for their (target, source, tick) slot.
        let govQuery = `SELECT d.action_index, d.source_id, d.signing_pubkey_id,
                               d.target_contract_index, d.tick_id
                        FROM contract_delegations d
                        WHERE d.status_id=? AND d.tick_id IS NOT NULL
                          AND d.activation_block <= ?
                          AND (d.deactivation_block IS NULL OR d.deactivation_block > ?)
                          AND NOT EXISTS (
                              SELECT 1 FROM contract_delegations d2
                              WHERE d2.target_contract_index = d.target_contract_index
                                AND d2.source_id             = d.source_id
                                AND d2.tick_id               = d.tick_id
                                AND d2.status_id             = ?
                                AND d2.activation_block     <= ?
                                AND (d2.deactivation_block IS NULL OR d2.deactivation_block > ?)
                                AND (d2.activation_block > d.activation_block
                                     OR (d2.activation_block = d.activation_block
                                         AND d2.action_index > d.action_index)))
                        ORDER BY d.activation_block ASC, d.action_index ASC`;
        let governing = await this.doQuery(govQuery, [valid_id, block, block, valid_id, block, block]);

        // The cooldown table's slashable statuses mirror slashContractStake Pass 2 exactly
        // ('valid' plus 'pending'); a 'completed' row was already refunded and cannot be slashed,
        // so rewriting its key would be noise in the journal.
        let pending_id       = await this.getStatusId('pending');
        let unstakeStatusIds = (pending_id === null) ? [valid_id] : [valid_id, pending_id];
        let unstakePlace     = unstakeStatusIds.map(() => '?').join(',');

        // Slots under an active delegation; the revert pass below must leave these alone.
        let governedSlots = new Set();
        for(let d of governing){
            governedSlots.add(String(d.target_contract_index) + '|' + String(d.source_id) + '|' + String(d.tick_id));
            // Rows that already carry the delegated key are skipped, so a materialized rotation
            // is a no-op on every later block (and writes no further journal rows).
            let stakeRows = await this.doQuery(
                `SELECT action_index, signing_pubkey_id FROM contract_stakes
                 WHERE target_contract_index=? AND source_id=? AND tick_id=? AND status_id=?
                   AND deactivation_block IS NULL
                   AND signing_pubkey_id<>?
                 ORDER BY action_index ASC`,
                [Number(d.target_contract_index), d.source_id, d.tick_id, valid_id, d.signing_pubkey_id]);
            for(let row of stakeRows)
                applied.push(await this._rotateContractStakeKey('contract_stakes', row, d.action_index, d.signing_pubkey_id, block));
            let unstakeRows = await this.doQuery(
                `SELECT action_index, signing_pubkey_id FROM contract_unstakes
                 WHERE target_contract_index=? AND source_id=? AND tick_id=?
                   AND status_id IN (${unstakePlace})
                   AND signing_pubkey_id<>?
                 ORDER BY action_index ASC`,
                [Number(d.target_contract_index), d.source_id, d.tick_id, ...unstakeStatusIds, d.signing_pubkey_id]);
            for(let row of unstakeRows)
                applied.push(await this._rotateContractStakeKey('contract_unstakes', row, d.action_index, d.signing_pubkey_id, block));
        }

        // 2. Revert pass: rows whose slot no longer has a governing delegation but that still
        //    carry a delegated key. The FIRST journal row per (table, row) carries the
        //    pre-rotation (original) key in prev_signing_pubkey_id; (block_index,
        //    delegation_action_index) is the deterministic order (at most one journal row per
        //    row per block, so the tiebreak is defensive).
        for(let spec of [{ table: 'contract_stakes',   extra: 'AND t.deactivation_block IS NULL', args: [valid_id] },
                         { table: 'contract_unstakes', extra: '', args: unstakeStatusIds }]){
            let statusPredicate = (spec.table === 'contract_stakes')
                ? 't.status_id=?'
                : `t.status_id IN (${spec.args.map(() => '?').join(',')})`;
            let revertQuery = `SELECT r.stake_action_index, r.delegation_action_index,
                                      r.prev_signing_pubkey_id AS original_pubkey_id,
                                      t.signing_pubkey_id      AS current_pubkey_id,
                                      t.target_contract_index, t.source_id, t.tick_id
                               FROM contract_delegation_rotations r
                                   JOIN ${spec.table} t ON (t.action_index = r.stake_action_index)
                               WHERE r.target_table=? AND ${statusPredicate} ${spec.extra}
                                 AND t.signing_pubkey_id <> r.prev_signing_pubkey_id
                                 AND NOT EXISTS (
                                     SELECT 1 FROM contract_delegation_rotations e
                                     WHERE e.stake_action_index = r.stake_action_index
                                       AND e.target_table       = r.target_table
                                       AND (e.block_index < r.block_index
                                            OR (e.block_index = r.block_index
                                                AND e.delegation_action_index < r.delegation_action_index)))
                               ORDER BY t.action_index ASC`;
            let rotated = await this.doQuery(revertQuery, [spec.table, ...spec.args]);
            for(let row of rotated){
                let slot = String(row.target_contract_index) + '|' + String(row.source_id) + '|' + String(row.tick_id);
                if(governedSlots.has(slot)) continue;
                if(String(row.current_pubkey_id) === String(row.original_pubkey_id)) continue;
                if(await this._contractPubkeyClaimedElsewhere(row.original_pubkey_id, row, valid_id)) continue;
                applied.push(await this._rotateContractStakeKey(spec.table,
                    { action_index: row.stake_action_index, signing_pubkey_id: row.current_pubkey_id },
                    row.delegation_action_index, row.original_pubkey_id, block));
            }
        }
        return applied;
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

    // True when `pubkeyId` is held by a contract stake outside this (target, source, tick) slot,
    // or by any active contract delegation. Guards the revert pass: handing a slot back its
    // original key while someone else holds that key would merge two owners into one staker
    // entry in the VM snapshot.
    async _contractPubkeyClaimedElsewhere(pubkeyId, slotRow, validStatusId){
        let stakeRows = await this.doQuery(
            `SELECT 1 FROM contract_stakes
             WHERE signing_pubkey_id=? AND status_id=?
               AND NOT (target_contract_index=? AND source_id=? AND tick_id=?)
             LIMIT 1`,
            [pubkeyId, validStatusId, Number(slotRow.target_contract_index), slotRow.source_id, slotRow.tick_id]);
        if(stakeRows.length > 0) return true;
        let delegationRows = await this.doQuery(
            `SELECT 1 FROM contract_delegations
             WHERE signing_pubkey_id=? AND status_id=? AND deactivation_block IS NULL
             LIMIT 1`,
            [pubkeyId, validStatusId]);
        return delegationRows.length > 0;
    }

    // Append a signing-key rotation to the reorg-restore journal. Mirrors
    // createContractSlashDebit: prev_signing_pubkey_id is copied back verbatim on rollback, so
    // the restored value is byte-identical to a from-genesis replay's.
    async createContractDelegationRotation(targetTable, delegationActionIndex, stakeActionIndex, prevPubkeyId, newPubkeyId, blockIndex){
        let query = `INSERT INTO contract_delegation_rotations
                        (target_table, delegation_action_index, stake_action_index,
                         prev_signing_pubkey_id, new_signing_pubkey_id, block_index)
                     VALUES (?, ?, ?, ?, ?, ?)`;
        await this.doQuery(query, [String(targetTable), Number(delegationActionIndex), Number(stakeActionIndex),
            Number(prevPubkeyId), Number(newPubkeyId), Number(blockIndex)]);
    }

    // Snapshot the contract's stake state at blockIndex into an in-memory accessor
    // returned to the VM execution context. Methods on the returned object are
    // synchronous since they query the pre-loaded snapshot only.
    //
    // The snapshot is scoped to THIS contract (targetContractIndex) - a contract
    // calling xchain.contract.* cannot see other contracts' stakes through this
    // accessor (implicit slash authorization). The 1000-staker cap on getStakers
    // is applied here at query time (LIMIT clause).
    //
    // SIGNING-KEY ROTATIONS (#4366). This reads contract_stakes.signing_pubkey_id and nothing
    // else - deliberately, and it must stay that way. A DELEGATE v1 rotation reaches the
    // snapshot because materializeContractDelegations rewrites the stake row itself at the
    // delegation's activation block (CONTRACT_DELEGATION_MATERIALIZE), so the pubkey a contract
    // sees in getStakers is by construction the same one slashContractStake can debit. Joining
    // contract_delegations in HERE instead would hand the contract a key the SLASH path cannot
    // find, and the emitted punishment would silently no-op at execute.js's zero-slashed guard.
    async getContractStakeDataForVM(targetContractIndex, blockIndex){
        let valid_id = await this.getStatusId('valid');
        let stakes = [];
        if(valid_id !== null){
            let query = `SELECT cs.signing_pubkey_id, ip.pubkey AS pubkey, cs.tick_id, t.tick AS tick, cs.amount,
                                cs.activation_block, cs.deactivation_block
                         FROM contract_stakes cs
                             LEFT JOIN index_pubkeys ip ON (ip.id = cs.signing_pubkey_id)
                             LEFT JOIN index_tickers t  ON (t.id  = cs.tick_id)
                         WHERE cs.target_contract_index=? AND cs.status_id=?
                           AND cs.activation_block <= ?
                           AND (cs.deactivation_block IS NULL OR cs.deactivation_block > ?)`;
            stakes = await this.doQuery(query, [Number(targetContractIndex), valid_id, blockIndex, blockIndex]);
        }
        // Aggregate (pubkey, tick) → amount; also build per-tick stakers map for getStakers/getTotalStaked.
        let perPubkeyTick = new Map();      // key: pubkey + '|' + tick → string amount
        let perTickStakers = new Map();     // key: tick → Map(pubkey → string amount)
        let util = this.util;
        // Contract stakes accept any tick up to MAX_TOKEN_DECIMALS (18), so aggregate each at its
        // own token precision. A flat 8-dp bcadd truncates the amounts the VM observes through
        // getStake/getTotalStaked/getStakers for >8-dp tokens (and would then drive a wrong slash);
        // XCHAIN(8) is unaffected. Per-tick decimals are precomputed here because the aggregation
        // below is synchronous (item 5303).
        let tickDecimals = new Map();       // tick string → decimals
        for(let row of stakes){
            let tk = String(row.tick || '');
            if(tk && !tickDecimals.has(tk))
                tickDecimals.set(tk, await this.getTokenDecimalPrecision(row.tick_id));
        }
        for(let row of stakes){
            let pubkey = String(row.pubkey || '').toLowerCase();
            let tick   = String(row.tick || '');
            if(!pubkey || !tick) continue;
            let dec = tickDecimals.has(tick) ? tickDecimals.get(tick) : 8;
            let key = pubkey + '|' + tick;
            perPubkeyTick.set(key, util.bcadd((perPubkeyTick.get(key) || '0'), row.amount, dec));
            if(!perTickStakers.has(tick)) perTickStakers.set(tick, new Map());
            let m = perTickStakers.get(tick);
            m.set(pubkey, util.bcadd((m.get(pubkey) || '0'), row.amount, dec));
        }
        // Return a SERIALIZABLE snapshot (plain data), not closures: the VM runs
        // in a forked worker and the read-only data must cross the IPC boundary.
        // xchain-vm/src/readonly-accessors.js rebuilds the sync getStake/
        // getTotalStaked/getStakers accessors from this shape inside the worker.
        let stakeByPubkeyTick = {};
        for(let [key, amt] of perPubkeyTick.entries()) stakeByPubkeyTick[key] = amt;

        let totalByTick   = {};
        let stakersByTick = {};
        for(let [tick, stakers] of perTickStakers.entries()){
            let dec = tickDecimals.has(tick) ? tickDecimals.get(tick) : 8;
            let total = '0';
            let arr = [];
            for(let [pk, amt] of stakers.entries()){
                total = util.bcadd(total, amt, dec);
                arr.push({ pubkey: pk, amount: amt });
            }
            // Sort stakers biggest to smallest. Equal amounts fall back to a lexicographic
            // pubkey tiebreak so the order is deterministic across nodes - the source query
            // carries no ORDER BY, so without this, equal-amount stakers would order in
            // engine-arbitrary row order. That matters twice: it sets the iteration order a
            // contract's getStakers() observes, AND it decides which stakers survive the
            // 1000-cap slice below when ties straddle the boundary - either of which would
            // fork getStakers() membership (and any contract branching on it) across
            // validators. pubkey is unique per tick here (aggregated), so this is a total order.
            arr.sort((a, b) => {
                if(util.bcgt(b.amount, a.amount)) return  1;
                if(util.bcgt(a.amount, b.amount)) return -1;
                return a.pubkey < b.pubkey ? -1 : a.pubkey > b.pubkey ? 1 : 0;
            });
            totalByTick[tick]   = total;
            stakersByTick[tick] = arr.slice(0, 1000);
        }
        return { stakeByPubkeyTick, totalByTick, stakersByTick };
    }

    // Build the read-only attestation-response snapshot the VM exposes through
    // xchain.attestation.getResponse(requestId). Scoped to fulfilled requests emitted by
    // THIS contract (the v0 request row's contract_index), visible as-of blockIndex.
    // Returns a SERIALIZABLE snapshot { responses: { [request_id]: { status, payload,
    // providerId, blockIndex, validatorCount } } }; xchain-vm/src/readonly-accessors.js
    // rebuilds the synchronous getResponse accessor from it inside the forked worker
    // (so this returns plain data, not closures, exactly like getContractStakeDataForVM).
    // Only wired into the snapshot at/after the VM_ATTESTATION_GETRESPONSE flag-day; below
    // it execute.js passes attestationData:null and getResponse() returns null.
    //
    // Dedup (#4373): the retry-then-ok lifecycle can write MULTIPLE v1 rows per request_id
    // (a retryable no_quorum/provider_error round, then the terminal ok). getResponse must
    // surface the response the callback fired on - the terminal ok - so we select only
    // response_status='ok' rows and, on the (defensive) chance more than one exists, keep
    // the EARLIEST by (block_index, action_index). A fulfilled request has exactly one ok
    // in practice, but the tie-break keeps the choice deterministic regardless.
    //
    // Determinism + bounding: only 'valid' rows with block_index <= blockIndex are visible
    // (an ok response that lands in a later block, or is rolled back, is not observable
    // as-of this block). The result is capped at the most-recent GETRESPONSE_MAX fulfilled
    // requests, ordered newest-first, so the surviving set is identical on every node; a
    // contract reading a request older than the cap deterministically sees null on all
    // nodes (the callback already delivered that response at fulfillment time, and a
    // contract needing it long-term persists it to its own state).
    async getAttestationDataForVM(contractIndex, blockIndex){
        // Most-recent-N cap. Keeps the per-EXECUTE snapshot bounded (each payload can be
        // up to the provider's max_response_bytes) while covering the re-consult-recent
        // use case; the value is consensus-critical (it decides snapshot membership), so
        // a change is a flag-day, not a config knob.
        const GETRESPONSE_MAX = 100;
        let responses = {};
        let valid_id = await this.getStatusId('valid');
        if(valid_id === null) return { responses };
        let query = `SELECT v1.request_id, v1.provider_id, v1.response_payload, v1.response_status,
                            v1.validator_signatures, v1.block_index, v1.action_index
                     FROM attests v1
                         INNER JOIN attests v0 ON (v0.request_id = v1.request_id AND v0.version = 0)
                     WHERE v1.version = 1
                       AND v1.response_status = 'ok'
                       AND v1.status_id = ?
                       AND v1.block_index <= ?
                       AND v0.contract_index = ?
                       AND v0.status_id = ?
                     ORDER BY v1.block_index DESC, v1.action_index DESC
                     LIMIT ?`;
        let rows = await this.doQuery(query, [valid_id, Number(blockIndex), Number(contractIndex), valid_id, GETRESPONSE_MAX]);
        // rid -> chosen row's (block, action), so the earliest-ok tie-break is explicit
        // and does not rely on the SQL ordering alone.
        let chosen = {};
        for(let row of rows){
            let rid = String(row.request_id || '').toLowerCase();
            if(!rid) continue;
            let cb = Number(row.block_index);
            let ca = Number(row.action_index);
            let prev = chosen[rid];
            if(prev !== undefined && !(cb < prev.block || (cb === prev.block && ca < prev.action)))
                continue;
            // validatorCount = number of verified federation signatures inlined on the
            // response row (JSON array); a malformed/absent column reads as 0.
            let vc = 0;
            if(row.validator_signatures){
                try { let arr = JSON.parse(row.validator_signatures); if(Array.isArray(arr)) vc = arr.length; }
                catch(e){ vc = 0; }
            }
            responses[rid] = {
                status:         String(row.response_status),
                payload:        row.response_payload != null ? String(row.response_payload) : '',
                providerId:     String(row.provider_id || ''),
                blockIndex:     cb,
                validatorCount: vc
            };
            chosen[rid] = { block: cb, action: ca };
        }
        return { responses };
    }

    // Slash a staker. Deducts `amount` from active contract_stakes rows first (LIFO by
    // activation_block / action_index), then from contract_unstakes rows if any remainder.
    // Returns the actual amount slashed (may be less than `amount` if available balance is lower).
    // Does NOT credit the destination or emit the slash_events row - caller (_processSlashEmission)
    // wires those side effects.
    //
    // SIGNING-KEY ROTATIONS (#4366). `pubkeyId` is resolved from the pubkey the contract emitted,
    // which it read out of the same snapshot getContractStakeDataForVM built, and that snapshot
    // reads the stake row's CURRENT key. Because materializeContractDelegations rewrites the row
    // at the delegation's activation block, a SLASH against a rotated staker lands on the very
    // rows the contract was shown, instead of matching nothing and returning '0' (which
    // _processSlashEmission's zero-slashed path then records as a punishment the ledger never
    // applied). No rotation-aware lookup belongs here: the row IS the rotation.
    async slashContractStake(targetContractIndex, pubkeyId, tickId, amount, blockIndex, executionIndex, slashPosition){
        let valid_id = await this.getStatusId('valid');
        if(valid_id === null) return '0';
        let remaining = String(amount);
        let totalSlashed = '0';
        // The staked tick may carry up to MAX_TOKEN_DECIMALS (18); do all slash arithmetic at its own
        // precision so an >8-dp token isn't truncated mid-deduction (which would leave dust unslashed
        // or corrupt the residual stake). XCHAIN(8) math is unchanged (item 5303).
        let dec = await this.getTokenDecimalPrecision(tickId);
        // Pass 1: deduct from ACTIVE (never-unstaked) contract_stakes rows (LIFO - highest
        // action_index first). The deactivation filter is load-bearing: UNSTAKE v1 leaves the
        // contract_stakes row's `amount` intact (it only sets a FUTURE deactivation_block =
        // block + ACTIVATION_DELAY_BLOCKS) AND mirrors the tokens into a contract_unstakes
        // cooldown row that the block-end sweep refunds in full. So the tokens exist in exactly
        // one slashable place per lifecycle stage: contract_stakes while deactivation_block IS
        // NULL, contract_unstakes once UNSTAKE has run. Pass 1 must therefore skip EVERY row that
        // carries a deactivation_block (Pass 2 slashes those from contract_unstakes). Filtering on
        // `deactivation_block > blockIndex` was wrong: because the block is in the future, that
        // predicate is TRUE throughout the [unstake, unstake+delay) window, so a slash landing in
        // the window slashed the phantom contract_stakes copy (crediting the destination) while the
        // sweep still refunded the contract_unstakes row - +X to the destination AND +X back to the
        // staker against one debit (silent supply inflation + total slash evasion).
        let stakesQ = `SELECT action_index, amount FROM contract_stakes
                       WHERE target_contract_index=? AND signing_pubkey_id=? AND tick_id=? AND status_id=?
                         AND CAST(amount AS DECIMAL(60,18)) > 0
                         AND deactivation_block IS NULL
                       ORDER BY action_index DESC`;
        let stakeRows = await this.doQuery(stakesQ, [Number(targetContractIndex), pubkeyId, tickId, valid_id]);
        for(let row of stakeRows){
            if(!this.util.bcgt(remaining, '0')) break;
            let rowAmt = String(row.amount);
            let take = this.util.bcgte(rowAmt, remaining) ? remaining : rowAmt;
            let newAmt = this.util.bcsub(rowAmt, take, dec);
            await this.doQuery('UPDATE contract_stakes SET amount=? WHERE action_index=?', [newAmt, row.action_index]);
            // Record the in-place debit so a reorg can restore rowAmt verbatim (see rollback.js).
            await this.createContractSlashDebit(executionIndex, slashPosition, 'contract_stakes', row.action_index, rowAmt, take, blockIndex);
            remaining = this.util.bcsub(remaining, take, dec);
            totalSlashed = this.util.bcadd(totalSlashed, take, dec);
        }
        if(!this.util.bcgt(remaining, '0')) return totalSlashed;
        // Pass 2: deduct from contract_unstakes rows (cooldown-locked but still slashable)
        let pendingId = await this.getStatusId('pending');
        let unstakeStatusIds = [valid_id];
        if(pendingId !== null) unstakeStatusIds.push(pendingId);
        let placeholders = unstakeStatusIds.map(() => '?').join(',');
        let unstakesQ = `SELECT action_index, amount FROM contract_unstakes
                         WHERE target_contract_index=? AND signing_pubkey_id=? AND tick_id=?
                           AND status_id IN (${placeholders})
                           AND CAST(amount AS DECIMAL(60,18)) > 0
                         ORDER BY action_index DESC`;
        let unstakeRows = await this.doQuery(unstakesQ, [Number(targetContractIndex), pubkeyId, tickId, ...unstakeStatusIds]);
        for(let row of unstakeRows){
            if(!this.util.bcgt(remaining, '0')) break;
            let rowAmt = String(row.amount);
            let take = this.util.bcgte(rowAmt, remaining) ? remaining : rowAmt;
            let newAmt = this.util.bcsub(rowAmt, take, dec);
            await this.doQuery('UPDATE contract_unstakes SET amount=? WHERE action_index=?', [newAmt, row.action_index]);
            // Record the in-place debit so a reorg can restore rowAmt verbatim (see rollback.js).
            await this.createContractSlashDebit(executionIndex, slashPosition, 'contract_unstakes', row.action_index, rowAmt, take, blockIndex);
            remaining = this.util.bcsub(remaining, take, dec);
            totalSlashed = this.util.bcadd(totalSlashed, take, dec);
        }
        return totalSlashed;
    }

    // Record one in-place slash debit, enabling reorg restoration of stake amounts.
    // slashContractStake reduces contract_stakes/contract_unstakes.amount IN PLACE on
    // rows created in earlier (surviving) blocks; the generic rollback delete cannot
    // revert that. This row captures `prev_amount` - the row's EXACT amount string
    // before the debit - so rollback.js can copy it back verbatim (string copy, no
    // arithmetic → byte-identical on source + replica, and identical to a from-genesis
    // replay where the slash was never re-mined). `amount` is the per-row delta (audit).
    async createContractSlashDebit(executionIndex, slashPosition, targetTable, stakeActionIndex, prevAmount, amount, blockIndex){
        let query = `INSERT INTO contract_slash_debits
                        (execution_index, slash_position, target_table, stake_action_index,
                         prev_amount, amount, block_index)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`;
        await this.doQuery(query, [executionIndex, slashPosition, targetTable, stakeActionIndex,
                                   String(prevAmount), this.util.bcstr(amount), blockIndex]);
    }

    // Burn an equivocating validator's ENTIRE capability bond (active `stakes` + cooldown-
    // locked `unstakes`), recording each in-place reduction in capability_slash_debits so a
    // reorg restores the pre-slash amounts verbatim (see rollback.js). Returns the total
    // XCHAIN burned as a string.
    //
    // Unlike slashContractStake (per-contract, per-tick, partial `amount`), capability stake
    // is a single XCHAIN bond per signing pubkey (XCHAIN-only - no contract/tick), and a
    // cryptographic equivocation proof burns the WHOLE bond in one shot. The deactivation-
    // window guard on Pass 1 is the same supply-inflation correctness point as the contract
    // path: after UNSTAKE a `stakes` row keeps its `amount` intact (only deactivation_block is
    // set) AND its tokens are mirrored into a cooldown `unstakes` row, so Pass 1 must skip that
    // phantom copy (Pass 2 burns the cooldown row) - each token burned exactly once. The
    // (pubkey,capability) dedup that makes a first slash idempotent lives in the SLASH handler.
    // ownerSourceId: when the offender is a DELEGATED signing key, the bond
    // lives on the OWNING source's stakes, not on rows keyed by the delegated pubkey.
    // Callers resolve it with getStakeSourceForDelegatedPubkey() AT THE EQUIVOCATION
    // HEIGHT and pass it here; null keeps the original signing_pubkey_id targeting for
    // a key that stakes in its own name.
    //
    // The burn is min(target, remaining) by construction rather than by arithmetic:
    // each row is zeroed for exactly the amount it still holds, and rows already at 0
    // are skipped. So a bond that has since fully unstaked and been withdrawn burns
    // ZERO and the SLASH still records as valid, which is the pinned resolution: the
    // outcome must not depend on stake motion after the offence.
    async slashCapabilityStake(pubkeyId, blockIndex, slashActionIndex, burnPending, ownerSourceId = null){
        let valid_id = await this.getStatusId('valid');
        if(valid_id === null) return '0';
        let totalSlashed = '0';
        // Pass 1: ACTIVE (never-unstaked) stakes rows (LIFO - highest action_index first). Same
        // correctness point as slashContractStake: after UNSTAKE the `stakes` row keeps its amount
        // but carries a FUTURE deactivation_block and its tokens are mirrored into a cooldown
        // `unstakes` row (Pass 2). Pass 1 must skip any row with a deactivation_block set, else a
        // slash in the [unstake, unstake+delay) window burns BOTH the stakes row here AND the
        // unstakes row in Pass 2 (which has no `remaining` gate), doubling `totalSlashed` and
        // inflating the bounty/treasury base computed from it. `deactivation_block > blockIndex`
        // was the inverted predicate (future block => TRUE in-window).
        // SLASH-1 (gated by SLASH_BURNS_PENDING_STAKE, caller passes burnPending): a byzantine key's
        // ENTIRE locked bond must burn, activated or NOT. A pending-activation top-up
        // (activation_block > blockIndex) was already debited from the staker at STAKE time, so the
        // legacy `activation_block <= ?` filter let it survive the burn and be UNSTAKEd/refunded
        // later (the sibling slashContractStake never had this filter). At/after the flag-day the
        // predicate is dropped; below it the legacy activation-gated burn is preserved for
        // replay/fleet consistency. The `deactivation_block IS NULL` guard is INDEPENDENT and stays
        // in both regimes (it is the Pass-1/Pass-2 double-burn defense, not an activation gate).
        let activationClause = burnPending ? '' : 'AND activation_block <= ?';
        // Target the owning source when the offender was a delegated key (#3163),
        // otherwise the offender's own signing key. Exactly one column is matched, so
        // there is no chance of double-counting a row across both spellings.
        let targetCol = (ownerSourceId !== null && ownerSourceId !== undefined) ? 'source_id' : 'signing_pubkey_id';
        let targetVal = (ownerSourceId !== null && ownerSourceId !== undefined) ? ownerSourceId : pubkeyId;
        let stakesQ = `SELECT action_index, amount FROM stakes
                       WHERE ${targetCol}=? AND status_id=?
                         ${activationClause}
                         AND CAST(amount AS DECIMAL(30,8)) > 0
                         AND deactivation_block IS NULL
                       ORDER BY action_index DESC`;
        let stakeArgs = burnPending ? [targetVal, valid_id] : [targetVal, valid_id, blockIndex];
        let stakeRows = await this.doQuery(stakesQ, stakeArgs);
        for(let row of stakeRows){
            let rowAmt = String(row.amount);
            if(!this.util.bcgt(rowAmt, '0')) continue;
            await this.doQuery('UPDATE stakes SET amount=? WHERE action_index=?', ['0', row.action_index]);
            // prev_amount = the whole row (we burn it entirely); delta = the same.
            await this.createCapabilitySlashDebit(slashActionIndex, 'stakes', row.action_index, rowAmt, rowAmt, blockIndex);
            totalSlashed = this.util.bcadd(totalSlashed, rowAmt, 8);
        }
        // Pass 2: cooldown-locked unstakes rows (status valid/pending) - slashable too (closes R-4:
        // capability unstakes are NOT slashable under the legacy contract-only path).
        let pendingId = await this.getStatusId('pending');
        let unstakeStatusIds = [valid_id];
        if(pendingId !== null) unstakeStatusIds.push(pendingId);
        let placeholders = unstakeStatusIds.map(() => '?').join(',');
        // Same owner-vs-own-key targeting as Pass 1 (#3163): cooldown-locked tokens of a
        // delegated key's OWNER are part of the bond and must burn with it.
        let unstakesQ = `SELECT action_index, amount FROM unstakes
                         WHERE ${targetCol}=? AND status_id IN (${placeholders})
                           AND CAST(amount AS DECIMAL(30,8)) > 0
                         ORDER BY action_index DESC`;
        let unstakeRows = await this.doQuery(unstakesQ, [targetVal, ...unstakeStatusIds]);
        for(let row of unstakeRows){
            let rowAmt = String(row.amount);
            if(!this.util.bcgt(rowAmt, '0')) continue;
            await this.doQuery('UPDATE unstakes SET amount=? WHERE action_index=?', ['0', row.action_index]);
            await this.createCapabilitySlashDebit(slashActionIndex, 'unstakes', row.action_index, rowAmt, rowAmt, blockIndex);
            totalSlashed = this.util.bcadd(totalSlashed, rowAmt, 8);
        }
        return totalSlashed;
    }

    // Record one in-place capability-stake slash debit so a reorg can restore the row's
    // amount byte-identically (verbatim `prev_amount` string copy - no arithmetic, so
    // source + replica + from-genesis replay all converge). Mirrors createContractSlashDebit
    // but keyed on the SLASH wire action_index (capability slashes are permissionless wire
    // actions, not VM emissions - there is no execution_index/slash_position).
    async createCapabilitySlashDebit(slashActionIndex, targetTable, stakeActionIndex, prevAmount, amount, blockIndex){
        let query = `INSERT INTO capability_slash_debits
                        (slash_action_index, target_table, stake_action_index, prev_amount, amount, block_index)
                     VALUES (?, ?, ?, ?, ?, ?)`;
        await this.doQuery(query, [slashActionIndex, targetTable, stakeActionIndex,
                                   String(prevAmount), this.util.bcstr(amount), blockIndex]);
    }

    // Record a capability-stake slash event (audit). Caller (the SLASH handler) has already
    // burned the bond via slashCapabilityStake and computed the bounty/treasury split.
    // Separate from slash_events because that table carries a non-null target_contract_index
    // FK that capability (contract-less) slashes have no value for.
    async createCapabilitySlashEvent(data){
        data                  = this.normalizeDataValues(data);
        let slash_action_index = data['SLASH_ACTION_INDEX'];
        let signing_pubkey_id  = data['SIGNING_PUBKEY_ID'];
        let capability         = data['CAPABILITY'];
        let equiv_key          = data['EQUIV_KEY'];
        let amount             = data['AMOUNT'];
        let bounty_amount      = data['BOUNTY_AMOUNT']   || '0';
        let treasury_amount    = data['TREASURY_AMOUNT'] || '0';
        let submitter_id       = data['SUBMITTER_ID']    != null ? data['SUBMITTER_ID']    : null;
        let destination_id     = data['DESTINATION_ID']  != null ? data['DESTINATION_ID']  : null;
        let block_index        = data['BLOCK_INDEX'];
        let query = `INSERT INTO capability_slash_events
                        (slash_action_index, signing_pubkey_id, capability, equiv_key, amount,
                         bounty_amount, treasury_amount, submitter_id, destination_id, block_index)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        await this.doQuery(query, [slash_action_index, signing_pubkey_id, capability, equiv_key,
                                   this.util.bcstr(amount), this.util.bcstr(bounty_amount), this.util.bcstr(treasury_amount),
                                   submitter_id, destination_id, block_index]);
    }

    // Whether a (pubkey, capability) pair has already been slashed - the SLASH handler's
    // idempotency gate (a first equivocation proof burns the whole bond; later proofs for the
    // same pair are no-ops). Block-scoped tables, so a reorg that orphans the slash also drops
    // this row and the check re-opens deterministically.
    async hasCapabilitySlashEvent(pubkeyId, capability){
        let rows = await this.doQuery(
            'SELECT id FROM capability_slash_events WHERE signing_pubkey_id=? AND capability=? LIMIT 1',
            [pubkeyId, String(capability)]);
        return rows.length > 0;
    }

    // Permanent disqualification (WI-2 bump 2): whether a signing key has been slashed for
    // equivocation in ANY capability at or before `blockIndex`. A slashed key is barred from
    // the effective signer set everywhere - not just until its bond burns to 0, but against
    // any future re-stake/re-delegation. GLOBAL (capability-agnostic - an equivocating key is
    // byzantine), block-gated for deterministic historical re-derivation, and reorg-safe (the
    // block-scoped event row rolls back ⇒ the key re-qualifies). The SQL counterpart inside
    // _effectiveCapabilitySetSql / _stakeWeightsSql excludes it from the SET queries; this is
    // the per-pubkey check used by hasCapability so both paths agree.
    async _isPubkeySlashedAt(pubkeyId, blockIndex){
        if(pubkeyId === null || pubkeyId === undefined) return false;
        let rows = await this.doQuery(
            'SELECT id FROM capability_slash_events WHERE signing_pubkey_id=? AND block_index<=? LIMIT 1',
            [pubkeyId, blockIndex]);
        return rows.length > 0;
    }

    // Record a slash event row. Caller has already deducted from contract_stakes/contract_unstakes
    // (via slashContractStake) and credited the destination address.
    async createSlashEvent(data){
        data                  = this.normalizeDataValues(data);
        let execution_index   = data['EXECUTION_INDEX'];
        let target_contract_index = Number(data['TARGET_CONTRACT_INDEX']);
        let signing_pubkey_id = data['SIGNING_PUBKEY_ID'];
        let tick_id           = data['TICK_ID'];
        let amount            = data['AMOUNT'];
        let destination_id    = data['DESTINATION_ID'];
        let block_index       = data['BLOCK_INDEX'];
        let query = `INSERT INTO slash_events
                        (execution_index, target_contract_index, signing_pubkey_id, tick_id,
                         amount, destination_id, block_index)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`;
        await this.doQuery(query, [execution_index, target_contract_index, signing_pubkey_id, tick_id,
                                   amount, destination_id, block_index]);
    }

    // Process cooldown completions at the end of a block.
    // Sweeps BOTH capability `unstakes` AND `contract_unstakes` tables: any row where
    // cooldown_end_block <= currentBlock and status='pending' (or 'valid') gets its
    // remaining amount credited back to the source, and the row is marked 'completed'.
    // Returns array of credit tuples [tick, amount, address] for processTransactionLedgerChanges,
    // plus the rowids that were finalized so they can be updated to 'completed' status.
    async sweepCompletedCooldowns(currentBlock){
        let credits = [];
        let pendingId = await this.getStatusId('pending');
        let validId = await this.getStatusId('valid');
        let completedId = await this.createStatus('completed');
        // Status filter - most existing unstakes carry 'valid' since createStatus normalizes that way.
        let statusIds = [];
        if(pendingId !== null) statusIds.push(pendingId);
        if(validId !== null) statusIds.push(validId);
        if(statusIds.length === 0) return { credits, capabilityRows: [], contractRows: [] };
        let placeholders = statusIds.map(() => '?').join(',');
        let gas = this.config['GAS'];
        // Capability unstakes (XCHAIN only)
        let capQ = `SELECT u.action_index, u.amount, a.address AS source_address
                    FROM unstakes u
                        LEFT JOIN index_addresses a ON (a.id = u.source_id)
                    WHERE u.cooldown_end_block <= ?
                      AND u.status_id IN (${placeholders})
                      AND CAST(u.amount AS DECIMAL(30,8)) > 0
                    ORDER BY u.action_index ASC`;
        let capRows = await this.doQuery(capQ, [currentBlock, ...statusIds]);
        let capabilityRows = [];
        for(let row of capRows){
            credits.push([gas, String(row.amount), row.source_address]);
            capabilityRows.push(row.action_index);
        }
        // Contract unstakes (any tick)
        // Positivity filter is cast at DECIMAL(60,18) (not 30,8) so a contract refund finer than
        // 8 dp on an >8-dp token isn't truncated to 0 and stranded as a never-swept 'pending' row.
        // XCHAIN(8) and every <=8-dp refund evaluate identically under either scale (item 5303).
        let conQ = `SELECT cu.action_index, cu.amount, a.address AS source_address, t.tick AS tick
                    FROM contract_unstakes cu
                        LEFT JOIN index_addresses a ON (a.id = cu.source_id)
                        LEFT JOIN index_tickers   t ON (t.id = cu.tick_id)
                    WHERE cu.cooldown_end_block <= ?
                      AND cu.status_id IN (${placeholders})
                      AND CAST(cu.amount AS DECIMAL(60,18)) > 0
                    ORDER BY cu.action_index ASC`;
        let conRows = await this.doQuery(conQ, [currentBlock, ...statusIds]);
        let contractRows = [];
        for(let row of conRows){
            credits.push([row.tick, String(row.amount), row.source_address]);
            contractRows.push(row.action_index);
        }
        return { credits, capabilityRows, contractRows, completedId };
    }

    // Mark unstake / contract_unstake rows as completed after their funds have been credited.
    async markCooldownsCompleted(capabilityRowIds, contractRowIds, completedStatusId){
        if(capabilityRowIds && capabilityRowIds.length > 0){
            let placeholders = capabilityRowIds.map(() => '?').join(',');
            await this.doQuery(
                `UPDATE unstakes SET status_id=? WHERE action_index IN (${placeholders})`,
                [completedStatusId, ...capabilityRowIds]
            );
        }
        if(contractRowIds && contractRowIds.length > 0){
            let placeholders = contractRowIds.map(() => '?').join(',');
            await this.doQuery(
                `UPDATE contract_unstakes SET status_id=? WHERE action_index IN (${placeholders})`,
                [completedStatusId, ...contractRowIds]
            );
        }
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

    // Append an address controller bind/unbind event (self-signed; no bound_by_id - the account IS
    // the signer). `evt` carries action_index, address_id, action_class, contract_index, is_unbind,
    // cooldown_blocks, cooldown_end_block, block_index.
    async recordAddressControllerEvent(evt){
        let query = `INSERT INTO address_controllers
                        (action_index, address_id, action_class, contract_index,
                         is_unbind, cooldown_blocks, cooldown_end_block, block_index)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
        await this.doQuery(query, [evt.action_index, evt.address_id, evt.action_class, evt.contract_index,
            evt.is_unbind ? 1 : 0, evt.cooldown_blocks, evt.cooldown_end_block, evt.block_index]);
    }

    // Latest controller event for (keyValue, action_class), bounded for a deterministic forward read
    // (events at/before atBlock, and - for same-block ordering - strictly before atActionIndex).
    // Returns the raw row (bind or unbind) or null. Apply controllerEventIfGating() to resolve the
    // read-time cooldown into an effective controller.
    async readLatestControllerEvent(table, keyColumn, keyValue, action_class, atBlock, atActionIndex){
        let sql  = '';
        let args = [keyValue, action_class];
        if(!this.util.isNull(atActionIndex) && this.util.isNumeric(atActionIndex)){
            sql += ' AND action_index < ?'; args.push(atActionIndex);
        }
        if(!this.util.isNull(atBlock) && this.util.isNumeric(atBlock)){
            sql += ' AND block_index <= ?'; args.push(atBlock);
        }
        let query = `SELECT action_index, contract_index, is_unbind, cooldown_blocks, cooldown_end_block
                     FROM ${table}
                     WHERE ${keyColumn}=? AND action_class=?` + sql + `
                     ORDER BY action_index DESC LIMIT 1`;
        let results = await this.doQuery(query, args);
        return (results.length > 0) ? results[0] : null;
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
    async readEffectiveControllerMap(table, keyColumn, keyValue, atBlock, atActionIndex){
        let map  = new Map();
        let sql  = '';
        let args = [keyValue];
        if(!this.util.isNull(atActionIndex) && this.util.isNumeric(atActionIndex)){
            sql += ' AND action_index < ?'; args.push(atActionIndex);
        }
        if(!this.util.isNull(atBlock) && this.util.isNumeric(atBlock)){
            sql += ' AND block_index <= ?'; args.push(atBlock);
        }
        let query = `SELECT action_class, action_index, contract_index, is_unbind, cooldown_end_block
                     FROM ${table}
                     WHERE ${keyColumn}=?` + sql + `
                     ORDER BY action_index ASC`;
        let results = await this.doQuery(query, args);
        let latest = new Map();
        for(let row of results)
            latest.set(row.action_class, row); // highest action_index wins
        for(let [cls, row] of latest){
            let gating = this.controllerEventIfGating(row, atBlock);
            if(gating) map.set(cls, Number(gating.contract_index));
        }
        return map;
    }

    /*
     * External attestation framework - see specs/2026-05-24_external-attestation-framework.md
     */

    // Create/Update an ATTEST v0 (request) row in the consolidated `attests` table
    async createAttestationRequest(data){
        data                 = this.normalizeDataValues(data);
        let status_id        = await this.createStatus(data['STATUS']);
        let fee_payer_id     = await this.getAddressId(data['FEE_PAYER']);
        let action_index     = data['ACTION_INDEX'];
        let request_id       = String(data['REQUEST_ID'] || '').toLowerCase();
        let contract_index   = data['CONTRACT_INDEX'];
        let provider_id      = data['PROVIDER_ID'];
        let payload          = data['REQUEST_PAYLOAD'] || null;
        let callback_method  = data['CALLBACK_METHOD'];
        let callback_params  = data['CALLBACK_PARAMS'] || null;
        let redundancy       = Number(data['REDUNDANCY']) || 0;
        let deadline_block   = data['DEADLINE_BLOCK'] || 0;
        let gas_escrow       = data['GAS_ESCROW'] || '0';
        let request_status   = data['REQUEST_STATUS'] || 'pending';
        let block_index      = data['BLOCK_INDEX'];
        // Optional request fee (E1): tick resolved to an id (NULL = feeless)
        let fee_tick_id      = !this.util.isNull(data['FEE_TICK']) ? await this.createTicker(data['FEE_TICK']) : null;
        let fee_amount       = !this.util.isNull(data['FEE_AMOUNT']) ? String(data['FEE_AMOUNT']) : null;
        // ATT-RECOMP-1: the ordered responsible-set pubkeys pinned as-of block_index at request
        // time (JSON array string), so the reorg missed_count recompute reads the historical set
        // verbatim instead of re-deriving it against the CURRENT mutable stakes.amount. NULL for
        // rejected/feeless-legacy rows (the recompute falls back to the live re-derive).
        let responsible_set  = !this.util.isNull(data['RESPONSIBLE_SET_JSON']) ? String(data['RESPONSIBLE_SET_JSON']) : null;
        // Cross-chain relay: NULL on every native single-chain request, so a
        // pre-activation replay writes exactly the columns it wrote before. Set to the
        // origin chain on a relay-eligible LTC/DOGE v0 (what the hub's relay poll keys
        // on) and on the BTC v3 row that materializes it (where it also suppresses the
        // local callback, since the contract is not on BTC).
        let origin_chain     = !this.util.isNull(data['ORIGIN_CHAIN']) ? String(data['ORIGIN_CHAIN']) : null;
        let origin_action    = !this.util.isNull(data['ORIGIN_ACTION_INDEX']) ? Number(data['ORIGIN_ACTION_INDEX']) : null;

        let query  = "SELECT action_index FROM attests WHERE action_index=? LIMIT 1";
        let exists = false;
        let results = await this.doQuery(query, [action_index]);
        if(results.length > 0) exists = true;
        if(exists){
            query = `UPDATE attests SET
                        version=0, request_id=?, contract_index=?, fee_payer_id=?, provider_id=?, payload=?,
                        callback_method=?, callback_params_json=?, redundancy=?, deadline_block=?,
                        gas_escrow=?, fee_tick_id=?, fee_amount=?, responsible_set_json=?,
                        origin_chain=?, origin_action_index=?, request_status=?, status_id=?, block_index=?
                    WHERE action_index=?`;
            await this.doQuery(query, [
                request_id, contract_index, fee_payer_id, provider_id, payload,
                callback_method, callback_params, redundancy, deadline_block,
                gas_escrow, fee_tick_id, fee_amount, responsible_set,
                origin_chain, origin_action, request_status, status_id, block_index, action_index
            ]);
        } else {
            // v0 single-request integrity. The (request_id, version) index was relaxed to
            // non-unique so multiple v1 response rounds can coexist (#4373); that also drops
            // the DB-level guard against a second v0 for one request_id. The request_id preimage
            // is collision-free, so this should never fire, but guard deterministically against
            // an un-threaded emission path: keep the first v0 row canonical and skip the
            // duplicate rather than splitting one request across two rows.
            let priorV0 = await this.doQuery("SELECT action_index FROM attests WHERE request_id=? AND version=0 LIMIT 1", [request_id]);
            if(priorV0.length > 0){
                console.warn('createAttestationRequest: duplicate v0 for request_id=' + request_id +
                             ' (keeping action_index=' + priorV0[0].action_index + ', skipping ' + action_index + ')');
                return;
            }
            query = `INSERT INTO attests
                        (action_index, version, request_id, contract_index, fee_payer_id, provider_id, payload,
                         callback_method, callback_params_json, redundancy, deadline_block,
                         gas_escrow, fee_tick_id, fee_amount, responsible_set_json,
                         origin_chain, origin_action_index, request_status, status_id, block_index)
                    VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            await this.doQuery(query, [
                action_index, request_id, contract_index, fee_payer_id, provider_id, payload,
                callback_method, callback_params, redundancy, deadline_block,
                gas_escrow, fee_tick_id, fee_amount, responsible_set,
                origin_chain, origin_action, request_status, status_id, block_index
            ]);
        }
    }

    // Create/Update an ATTEST v1 (response) row in the consolidated `attests` table.
    // The verified federation signatures ride in the validator_signatures JSON
    // column (data['VALIDATOR_SIGNATURES'] - a JSON array string, or null) rather
    // than in a separate child table. Keyed on action_index: the retry-then-ok
    // lifecycle (#4373) produces MULTIPLE v1 rows per request_id (one per PBFT round,
    // a retryable round then the terminal ok), each its own immutable action-indexed
    // row, so (request_id, version) is intentionally NOT unique.
    async createAttestationResponse(data){
        data                 = this.normalizeDataValues(data);
        let status_id        = await this.createStatus(data['STATUS']);
        let action_index     = data['ACTION_INDEX'];
        let request_id       = String(data['REQUEST_ID'] || '').toLowerCase();
        let provider_id      = data['PROVIDER_ID'];
        let response_hash    = String(data['RESPONSE_HASH'] || '').toLowerCase();
        let response_payload = data['RESPONSE_PAYLOAD'] || null;
        let response_status  = data['RESPONSE_STATUS'];
        let meta             = data['META'] || null;
        let signatures       = data['VALIDATOR_SIGNATURES'] || null;
        let block_index      = data['BLOCK_INDEX'];

        let query  = "SELECT action_index FROM attests WHERE action_index=? LIMIT 1";
        let exists = false;
        let results = await this.doQuery(query, [action_index]);
        if(results.length > 0) exists = true;
        if(exists){
            query = `UPDATE attests SET
                        version=1, request_id=?, provider_id=?, response_hash=?, response_payload=?,
                        response_status=?, meta=?, validator_signatures=?, status_id=?, block_index=?
                    WHERE action_index=?`;
            await this.doQuery(query, [
                request_id, provider_id, response_hash, response_payload,
                response_status, meta, signatures, status_id, block_index, action_index
            ]);
        } else {
            query = `INSERT INTO attests
                        (action_index, version, request_id, provider_id, response_hash, response_payload,
                         response_status, meta, validator_signatures, status_id, block_index)
                    VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            await this.doQuery(query, [
                action_index, request_id, provider_id, response_hash, response_payload,
                response_status, meta, signatures, status_id, block_index
            ]);
        }
    }

    // Increment a counter column on attest_validator_stats. Upserts the
    // (validator_pubkey, provider_id) row on first sight. `field` is whitelisted
    // to the counter columns so callers can't inject arbitrary SQL.
    //
    // Reorg note: the table is append-monotone (counters only), so the standard
    // `DELETE WHERE block_index >= ?` pattern can't roll it back - a row's
    // earlier, surviving increments live alongside the orphaned ones. Rollback
    // therefore recomputes affected pairs from the surviving ledger rather than
    // deleting by index: Rollback._recomputeAttestationValidatorStats() drops the
    // rows last touched in the orphaned range and rebuilds them from surviving
    // signatures (fulfilled) + expired requests (missed), matching a from-genesis
    // replay. This keeps the counters consensus-safe across reorgs so Phase 4
    // slashing can consume them. See src/rollback.js.
    //
    // Spec: external attestation framework §10 (validator stat accounting).
    async incrementAttestationValidatorStat(validatorPubkey, providerId, field, blockIndex){
        const allowed = { fulfilled_count: 1, missed_count: 1, slashed_count: 1 };
        if(!allowed[field]) throw new Error('incrementAttestationValidatorStat: unsupported field ' + field);
        let pk  = String(validatorPubkey || '').toLowerCase();
        let pid = String(providerId || '');
        if(!pk || !pid) return;
        let query = `INSERT INTO attest_validator_stats
                        (validator_pubkey, provider_id, ${field}, last_updated_block)
                     VALUES (?, ?, 1, ?)
                     ON DUPLICATE KEY UPDATE
                        ${field} = ${field} + 1,
                        last_updated_block = VALUES(last_updated_block)`;
        await this.doQuery(query, [pk, pid, blockIndex || 0]);
    }

    // Look up an ATTEST v0 (request) row by its request_id (64-hex hash)
    async getAttestationRequestById(requestId){
        let query = `SELECT ar.*, ia.address AS fee_payer
                     FROM attests ar
                     LEFT JOIN index_addresses ia ON ia.id = ar.fee_payer_id
                     WHERE ar.request_id = ? AND ar.version = 0
                     ORDER BY ar.action_index ASC
                     LIMIT 1`;
        let rows = await this.doQuery(query, [String(requestId || '').toLowerCase()]);
        return rows.length > 0 ? rows[0] : null;
    }

    // Per-block ATTEST v0 admission counts, for the spec §11.1 caps
    // (attest_request_cap_activation.js). Returns { total, byContract }: admitted v0
    // requests EARLIER IN THIS BLOCK, and how many of those came from `contractIndex`.
    //
    // Deterministic by construction, which is the whole requirement for a consensus
    // gate. Every node processes a block's actions in action_index order inside one
    // transaction, so `action_index < ?` selects exactly the earlier admissions of this
    // block and nothing else; action_index is unique, so the order is total and every
    // node sees the same prefix at the same action. A from-genesis replay reproduces it.
    //
    // 'rejected' rows are excluded for the same reason the relay lookup below excludes
    // them: a refused request never escrowed a fee and was never served, so it consumed
    // no slot. Counting them would let one malformed request burn capacity, which turns
    // an anti-abuse cap into an abuse vector.
    //
    // doQueryStrict, not doQuery: a swallowed DB fault here would silently return zero
    // counts and admit past the cap. A throw rolls the block back and retries it, which
    // is the correct answer to a DB fault on a consensus path.
    async getAttestationAdmissionCounts(blockIndex, actionIndex, contractIndex){
        let query = `SELECT COUNT(*) AS total,
                            COALESCE(SUM(CASE WHEN contract_index = ? THEN 1 ELSE 0 END), 0) AS by_contract
                     FROM attests
                     WHERE version = 0
                       AND block_index = ?
                       AND action_index < ?
                       AND request_status <> 'rejected'`;
        let rows = await this.doQueryStrict(query, [contractIndex, Number(blockIndex), Number(actionIndex)]);
        let row  = (rows && rows.length > 0) ? rows[0] : {};
        return {
            total:      Number(row.total || 0),
            byContract: Number(row.by_contract || 0)
        };
    }

    // Cross-chain relay: look up the ATTEST v0 row that already materialized a given relay
    // identity (origin_chain, origin_action_index) on this chain. This is the exactly-once
    // key the v3 admission guard needs and request_id cannot supply: request_id derives
    // from the ORIGIN tx_hash, so a reorg that re-emits the same origin action from a
    // different transaction yields a new request_id for the same identity.
    //
    // 'rejected' rows are excluded deliberately. A rejected row never enters the pending
    // pool, is never fulfilled and spends no fee, so it consumed no exactly-once slot;
    // counting it would let anyone permanently block a legitimate materialization by
    // broadcasting one malformed v3 naming the same origin action. ORDER BY action_index
    // keeps the FIRST materialization canonical on every node.
    //
    // doQueryStrict, not doQuery, and the difference is a fork. This read is a CONSENSUS
    // INPUT: null here is what admits the v3 and writes a 'valid'/'pending' row, so a
    // swallowed query error collapsing to [] is indistinguishable from "no prior
    // materialization" and makes one faulting node materialize a duplicate BTC request
    // every other node rejected - the M-17 shape doQueryStrict was added for. Block
    // processing already holds a transaction, under which doQuery re-throws anyway, so
    // this is not a behavior flip on the live path; it is the guarantee stated
    // unconditionally, for the replay/genesis/synthetic entry points that reach the same
    // handler outside one. A throw rolls the block back and retries it, which is the
    // correct answer to a DB fault and is NOT the DB-constraint throw the schema comment
    // rules out: that one fires on legitimate DATA and would halt every node in turn.
    async getRelayRequestByOrigin(originChain, originActionIndex){
        let query = `SELECT action_index, request_id, request_status
                     FROM attests
                     WHERE origin_chain = ? AND origin_action_index = ?
                       AND version = 0 AND request_status <> 'rejected'
                     ORDER BY action_index ASC
                     LIMIT 1`;
        let rows = await this.doQueryStrict(query, [String(originChain || ''), Number(originActionIndex)]);
        return rows.length > 0 ? rows[0] : null;
    }

    // Update the request_status field on an ATTEST v0 (request) row
    // resolvedBlock anchors a TERMINAL flip ('fulfilled'/'errored'/'expired') to the
    // block that caused it, so the rollback pass can reset the surviving request row
    // when that block reorgs (covers the v1-response AND v2-expiry paths - the old
    // v1-only self-join reset left a reorged expiry stuck terminal, and replay then
    // skipped re-synthesizing the v2 row: reorged-node vs fresh-sync divergence).
    async updateAttestationRequestStatus(requestId, newStatus, resolvedBlock){
        let query = `UPDATE attests
                     SET request_status = ?, resolved_block = ?
                     WHERE request_id = ? AND version = 0`;
        await this.doQuery(query, [newStatus, (resolvedBlock != null ? resolvedBlock : null),
                                   String(requestId || '').toLowerCase()]);
    }

    // List ATTEST v0 (request) rows currently in 'pending' status, ordered by
    // creation. xchain-hub's AttestationRound polls this to discover work.
    // Optional providerId filter lets a validator only see requests for
    // providers it serves.
    async getPendingAttestationRequests(providerId, limit, cursor){
        let where = "request_status = 'pending'";
        let args  = [];
        if(providerId){
            where += ' AND provider_id = ?';
            args.push(String(providerId));
        }
        where += ' AND version = 0';
        // Keyset/cursor pagination. When the caller passes the last
        // (block_index, action_index) it has already consumed, return only rows
        // strictly after it. This lets a poller page through more than `limit`
        // pending requests across successive calls instead of being permanently
        // pinned to the oldest `limit` rows - without a cursor, a backlog larger
        // than `limit` starves every newer request until the oldest ones drain.
        let afterBlock  = cursor ? Number(cursor.after_block_index)  : NaN;
        let afterAction = cursor ? Number(cursor.after_action_index) : NaN;
        if(Number.isFinite(afterBlock) && Number.isFinite(afterAction)){
            where += ' AND (block_index > ? OR (block_index = ? AND action_index > ?))';
            args.push(afterBlock, afterBlock, afterAction);
        }
        // Floor + hard-cap here at the interpolation site so the row count is
        // always a bounded integer regardless of caller: a fractional limit
        // (e.g. 100.5) would produce `LIMIT 100.5`, a MariaDB syntax error that
        // throws and fails the whole attestation-work poll, and an unclamped large
        // integer would be an unbounded scan. The RPC layer also range-clamps, but
        // this method owns the SQL so it enforces the invariant for every caller.
        let max = Number(limit);
        max = (Number.isFinite(max) && max > 0) ? Math.min(Math.floor(max), 500) : 100;
        let query = `SELECT action_index, request_id, contract_index, fee_payer_id, provider_id,
                            payload, callback_method, callback_params_json,
                            redundancy, deadline_block, gas_escrow, fee_tick_id, fee_amount,
                            origin_chain, origin_action_index,
                            request_status, status_id, block_index
                     FROM attests
                     WHERE ` + where + `
                     ORDER BY block_index ASC, action_index ASC
                     LIMIT ?`;
        args.push(max);
        let rows = await this.doQuery(query, args);
        // Convert BigInt columns to Number so the express JSON serializer
        // doesn't throw `TypeError: Do not know how to serialize a BigInt`.
        // Bounded chain values (block heights, action indexes) stay well
        // within Number.MAX_SAFE_INTEGER on a regtest or production network.
        return rows.map(r => ({
            ...r,
            action_index:   typeof r.action_index   === 'bigint' ? Number(r.action_index)   : r.action_index,
            contract_index: typeof r.contract_index === 'bigint' ? Number(r.contract_index) : r.contract_index,
            fee_payer_id:   typeof r.fee_payer_id   === 'bigint' ? Number(r.fee_payer_id)   : r.fee_payer_id,
            fee_tick_id:    typeof r.fee_tick_id    === 'bigint' ? Number(r.fee_tick_id)    : r.fee_tick_id,
            deadline_block: typeof r.deadline_block === 'bigint' ? Number(r.deadline_block) : r.deadline_block,
            status_id:      typeof r.status_id      === 'bigint' ? Number(r.status_id)      : r.status_id,
            // NULL on every native request. Non-null marks the row as one leg of a
            // cross-chain relay, which is what the hub's relay driver filters on.
            origin_action_index: typeof r.origin_action_index === 'bigint' ? Number(r.origin_action_index) : r.origin_action_index,
            block_index:    typeof r.block_index    === 'bigint' ? Number(r.block_index)    : r.block_index
        }));
    }

    // Cross-chain relay: every ATTEST v0 request this chain holds only as a MATERIALIZED
    // relay leg, i.e. whose row carries an origin_chain that is some OTHER chain, with
    // its terminal response attached when one exists. On BTC that is exactly the set of
    // v3-materialized requests, at any lifecycle status. The predicate is
    // self-restricting rather than coin-gated: on an ORIGIN chain a relay-eligible
    // row's origin_chain equals that coin, so it never matches and this returns empty.
    //
    // ONE READ, TWO QUESTIONS, and the first is why it is driven by the request rather
    // than the response. xchain-hub's relay driver must not materialize a request that
    // is already on BTC, and its only home-side view was the PENDING queue: a request
    // that had been fulfilled or had expired was no longer pending, so it read as
    // never materialized and the driver would broadcast a second v3, which v3 admission
    // rejects as a duplicate REQUEST_ID after the fee is already spent. Returning the
    // request row whatever its status answers that; the LEFT JOIN answers the second
    // question, which response is owed back to the origin chain as an ATTEST v4.
    //
    // The response join is deliberately narrow. Only the two TERMINAL statuses can
    // relay: the retryable ones (no_quorum / timeout / provider_error) leave the
    // request pending for another round, and relaying one would close an origin
    // request the home chain still intends to fulfill. That, plus the valid-status
    // match, is what makes the join produce AT MOST one response row per request: the
    // retry-then-ok lifecycle writes several v1 rows, but only one can be both valid
    // and terminal, every later one being rejected as 'REQUEST already fulfilled'.
    // The status id is resolved once and compared as an integer so the filter can sit
    // in the ON clause, where a LEFT JOIN needs it, without a third join.
    //
    // response_hash is returned alongside response_payload deliberately: the stored
    // payload is the UTF-8 DECODE of the bytes that were hashed, so a non-UTF-8
    // attested body cannot be re-encoded to the same bytes. The caller compares the
    // two and refuses to relay a body it cannot reproduce (see AttestationRelay).
    async getRelayedAttestationRequests(coin, requestId, limit, cursor){
        let validStatusId = await this.getStatusId('valid');
        let where = `req.version = 0
                       AND req.origin_chain IS NOT NULL
                       AND req.origin_chain <> ?`;
        let args = [validStatusId, String(coin || '')];
        if(requestId){
            where += ' AND req.request_id = ?';
            args.push(String(requestId).toLowerCase());
        }
        // Same keyset cursor contract as getPendingAttestationRequests: the caller pages
        // forward by the last (block_index, action_index) it consumed, so a backlog
        // larger than `limit` does not starve newer rows forever. The cursor is on the
        // REQUEST's pair, which is the ordering, so a caller can page this read with
        // exactly the code it uses for the pending one.
        let afterBlock  = cursor ? Number(cursor.after_block_index)  : NaN;
        let afterAction = cursor ? Number(cursor.after_action_index) : NaN;
        if(Number.isFinite(afterBlock) && Number.isFinite(afterAction)){
            where += ' AND (req.block_index > ? OR (req.block_index = ? AND req.action_index > ?))';
            args.push(afterBlock, afterBlock, afterAction);
        }
        // Floored and hard-capped here, at the interpolation site, for the same reason
        // getPendingAttestationRequests does it: a fractional limit is a MariaDB syntax
        // error and an unclamped one is an unbounded scan, and this method owns the SQL.
        let max = Number(limit);
        max = (Number.isFinite(max) && max > 0) ? Math.min(Math.floor(max), 500) : 100;
        let query = `SELECT req.action_index, req.block_index, req.request_id, req.provider_id,
                            req.origin_chain, req.origin_action_index, req.request_status,
                            resp.action_index  AS response_action_index,
                            resp.block_index   AS response_block_index,
                            resp.response_hash, resp.response_payload,
                            resp.response_status, resp.meta
                     FROM attests req
                     LEFT JOIN attests resp
                            ON (resp.request_id = req.request_id
                                AND resp.version = 1
                                AND resp.status_id = ?
                                AND resp.response_status IN ('ok','expired'))
                     WHERE ` + where + `
                     ORDER BY req.block_index ASC, req.action_index ASC
                     LIMIT ?`;
        args.push(max);
        let rows = await this.doQuery(query, args);
        // BigInt -> Number for the express JSON serializer, as in
        // getPendingAttestationRequests; every column here is a bounded chain value.
        return rows.map(r => ({
            ...r,
            action_index:          typeof r.action_index          === 'bigint' ? Number(r.action_index)          : r.action_index,
            block_index:           typeof r.block_index           === 'bigint' ? Number(r.block_index)           : r.block_index,
            response_action_index: typeof r.response_action_index === 'bigint' ? Number(r.response_action_index) : r.response_action_index,
            response_block_index:  typeof r.response_block_index  === 'bigint' ? Number(r.response_block_index)  : r.response_block_index,
            origin_action_index:   typeof r.origin_action_index   === 'bigint' ? Number(r.origin_action_index)   : r.origin_action_index
        }));
    }

    // Find ATTEST v0 (request) rows whose deadline_block has passed without a response.
    // Returns full rows so the expiry handler doesn't have to refetch.
    //
    // CAPPED per block at ATTEST_MAX_EXPIRIES_PER_BLOCK. Unbounded, one
    // block could inherit an arbitrary backlog of expiries, each of which synthesizes
    // an ATTEST v2 and fires a contract callback, so block processing time became a
    // function of how many deadlines happened to coincide: an attacker picks that
    // number by batching requests on a common deadline.
    //
    // The overflow is NOT dropped, it carries to the next block. That is safe only
    // because the ORDER BY is a TOTAL order: deadline_block is not unique, but
    // action_index is, so (deadline_block ASC, action_index ASC) has exactly one
    // valid ordering and every node takes the same prefix. A cap over a partial or
    // planner-dependent order would let two nodes select different subsets and fork,
    // which is why the ordering is spelled out here rather than left implicit.
    async getExpiredAttestationRequests(blockIndex, limit = ATTEST_MAX_EXPIRIES_PER_BLOCK){
        let query = `SELECT ar.*, ia.address AS fee_payer
                     FROM attests ar
                     LEFT JOIN index_addresses ia ON ia.id = ar.fee_payer_id
                     WHERE ar.version = 0
                       AND ar.request_status = 'pending'
                       AND ar.deadline_block < ?
                     ORDER BY ar.deadline_block ASC, ar.action_index ASC
                     LIMIT ?`;
        return await this.doQuery(query, [blockIndex, limit]);
    }

    // Set callback_execute_action_index on an ATTEST v1 (response) row (after the system EXECUTE is injected)
    async setAttestationResponseCallbackIndex(responseActionIndex, callbackExecuteActionIndex){
        let query = `UPDATE attests
                     SET callback_execute_action_index = ?
                     WHERE action_index = ? AND version = 1`;
        await this.doQuery(query, [callbackExecuteActionIndex, responseActionIndex]);
    }

    // Resolve an equivocating DELEGATED signing key to the stake source that backs it.
    //
    // A delegated key signs on behalf of a staker but owns no stake itself: the
    // `stakes` rows carry the OWNER's source_id and (for delegation-only stakers) a
    // different signing_pubkey_id entirely. slashCapabilityStake burns by
    // signing_pubkey_id, so a proof against a delegated key matched zero rows and
    // burned NOTHING while still recording a valid slash event. Equivocation via a
    // delegated key was therefore free, which is the whole point of the bond.
    //
    // The mapping is read AT THE EQUIVOCATION HEIGHT, not at processing time. That is
    // the pinned resolution (spec P7): the delegation that was in force when the
    // offence happened is the one that identifies the responsible stake, so an
    // offender cannot revoke the delegation afterwards to orphan the proof, and the
    // answer is a pure function of the proof rather than of when it was submitted.
    // Returns the owning source_id, or null when the key was not a delegated key at
    // that height (in which case it stakes in its own name and the caller's existing
    // signing_pubkey_id burn is already correct).
    async getStakeSourceForDelegatedPubkey(pubkeyId, equivocationBlock){
        if(pubkeyId === null || pubkeyId === undefined) return null;
        let valid_id = await this.getStatusId('valid');
        if(valid_id === null) return null;
        let blk = parseInt(equivocationBlock);
        if(!Number.isFinite(blk)) return null;
        // Active AT the equivocation height: activated at or before it, and not yet
        // deactivated as of it. Deliberately the same window predicate the capability
        // set uses, so a key that was eligible to sign is a key that resolves here.
        let query = `SELECT source_id FROM delegations
                     WHERE signing_pubkey_id=? AND status_id=?
                       AND activation_block <= ?
                       AND (deactivation_block IS NULL OR deactivation_block > ?)
                     ORDER BY action_index DESC LIMIT 1`;
        let rows = await this.doQuery(query, [pubkeyId, valid_id, blk, blk]);
        return rows.length > 0 ? rows[0].source_id : null;
    }

    // Get the delegation holding a pubkey, regardless of source - used for the
    // DELEGATE v0 pubkey-collision rule ("must not already be in use by any
    // active stake or delegation"). Pending-activation delegations already
    // reserve the pubkey (mirrors the stake-collision semantics), so only the
    // deactivation gate is applied: a revoked delegation frees the pubkey.
    async getDelegationByPubkey(pubkey, blockIndex){
        let pubkey_id = await this.getPubkeyId(String(pubkey).toLowerCase());
        if(pubkey_id === null)
            return null;
        let valid_id = await this.getStatusId('valid');
        let query = `SELECT * FROM delegations
                     WHERE signing_pubkey_id=? AND status_id=?
                       AND (deactivation_block IS NULL OR deactivation_block > ?)
                     ORDER BY action_index DESC LIMIT 1`;
        let results = await this.doQuery(query, [pubkey_id, valid_id, blockIndex]);
        if(results.length > 0)
            return results[0];
        return null;
    }

    // Get active delegation for a source + pubkey (gated by activation/deactivation delay)
    async getActiveDelegation(source, pubkey, blockIndex){
        let source_id = await this.getAddressId(source);
        let pubkey_id = await this.getPubkeyId(String(pubkey).toLowerCase());
        if(source_id === null || pubkey_id === null)
            return null;
        let valid_id = await this.getStatusId('valid');
        let query = `SELECT * FROM delegations WHERE source_id=? AND signing_pubkey_id=? AND status_id=?`;
        let args = [source_id, pubkey_id, valid_id];
        if(blockIndex !== undefined && blockIndex !== null){
            query += ' AND activation_block <= ? AND (deactivation_block IS NULL OR deactivation_block > ?)';
            args.push(blockIndex);
            args.push(blockIndex);
        }
        query += ' ORDER BY action_index DESC LIMIT 1';
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            return results[0];
        return null;
    }

    /*
     * VM action methods
     */

    // Create/Update record in `contracts` table
    async createContract(data){
        data             = this.normalizeDataValues(data);
        let status_id    = await this.createStatus(data['STATUS']);
        let source_id    = await this.getAddressId(data['SOURCE']);
        let action_index = data['ACTION_INDEX'];
        let code         = data['CODE'];
        let code_hash    = data['CODE_HASH'];
        let api_version  = data['API_VERSION'] || 1;
        let block_index  = data['BLOCK_INDEX'];
        // DEPLOY v1+ staking config (NULL when contract is not opted into contract-staking)
        let cooldown_blocks = (this.util.isNull(data['COOLDOWN_BLOCKS'])) ? null : Number(data['COOLDOWN_BLOCKS']);
        let slash_destination_id = null;
        if(!this.util.isNull(data['SLASH_DESTINATION'])){
            slash_destination_id = await this.createAddress(data['SLASH_DESTINATION']);
        }
        let query  = "SELECT action_index FROM contracts WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE contracts SET
                        source_id=?, code=?, code_hash=?, api_version=?, status_id=?, block_index=?,
                        cooldown_blocks=?, slash_destination_id=?
                    WHERE action_index=?`;
            args = [source_id, code, code_hash, api_version, status_id, block_index,
                    cooldown_blocks, slash_destination_id, action_index];
        } else {
            query = `INSERT INTO contracts
                        (source_id, code, code_hash, api_version, status_id, block_index,
                         cooldown_blocks, slash_destination_id, action_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            args = [source_id, code, code_hash, api_version, status_id, block_index,
                    cooldown_blocks, slash_destination_id, action_index];
        }
        await this.doQuery(query, args);
    }

    // Get contract by action_index
    async getContract(action_index){
        let query = `SELECT * FROM contracts WHERE action_index=? LIMIT 1`;
        let results = await this.doQuery(query, [action_index]);
        if(results.length > 0)
            return results[0];
        return null;
    }

    // Record one DEPLOY v4 carrier (a base64 slice of a chunked contract's source). Upsert keyed
    // on the action_index (the rollback key) - mirrors createContract. Every chunk is stored
    // with its status (valid/invalid) so the explorer can surface it; the DEPLOY assembler
    // (getDeployChunksForAssembly) reads only the VALID rows.
    async recordDeployChunk(data){
        data             = this.normalizeDataValues(data);
        let status_id    = await this.createStatus(data['STATUS']);
        let source_id    = await this.getAddressId(data['SOURCE']);
        let action_index = data['ACTION_INDEX'];
        let code_hash    = data['CODE_HASH'];
        let chunk_index  = Number(data['CHUNK_INDEX']);
        let total_chunks = Number(data['TOTAL_CHUNKS']);
        let code_part    = data['CODE_PART'];
        let block_index  = data['BLOCK_INDEX'];
        let query   = "SELECT action_index FROM deploy_chunks WHERE action_index=? LIMIT 1";
        let results = await this.doQuery(query, [action_index]);
        if(results.length > 0){
            query = `UPDATE deploy_chunks SET
                        source_id=?, code_hash=?, chunk_index=?, total_chunks=?, code_part=?, block_index=?, status_id=?
                     WHERE action_index=?`;
        } else {
            query = `INSERT INTO deploy_chunks
                        (source_id, code_hash, chunk_index, total_chunks, code_part, block_index, status_id, action_index)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
        }
        await this.doQuery(query, [source_id, code_hash, chunk_index, total_chunks, code_part, block_index, status_id, action_index]);
    }

    // Gather the VALID chunk parts a chunked DEPLOY (v2/v3) may assemble: same deployer
    // (source), same code_hash group, recorded at a LOWER action_index than the assembling
    // DEPLOY (so a DEPLOY only ever consumes chunks that precede it - any reorg removing a
    // chunk also removes the dependent DEPLOY, keeping rollback trivial). Ordered by
    // chunk_index then action_index so a duplicated position deterministically resolves to
    // its first submission on every node. Returns raw rows; deploy.js does the contiguity +
    // sha256 assembly check.
    async getDeployChunksForAssembly(source, codeHash, beforeActionIndex){
        let source_id = await this.getAddressId(source);
        if(source_id === null) return [];
        let query = `SELECT dc.chunk_index, dc.total_chunks, dc.code_part, dc.action_index
                     FROM deploy_chunks dc
                     INNER JOIN index_statuses s ON (s.id=dc.status_id)
                     WHERE dc.source_id=? AND dc.code_hash=? AND dc.action_index < ? AND s.status='valid'
                     ORDER BY dc.chunk_index ASC, dc.action_index ASC`;
        return await this.doQuery(query, [source_id, codeHash, beforeActionIndex]);
    }

    // Persist a contract's declared permissions manifest (Phase E). Upsert keyed on
    // the DEPLOY action_index (the rollback key) - mirrors createContract. PERMISSIONS
    // is the validated array of permitted emission action types (stored as JSON) or
    // null when the contract declared none (unrestricted); MAX_TAKE_BPS is the tighter
    // per-contract royalty cap or null (global cap applies). deploy.js validates both
    // before calling this; deleteContract clears the row on a failed deploy.
    async createContractPermission(data){
        // Capture the permissions ARRAY before normalizeDataValues runs: that routine
        // safeToString()s every object-typed field, which coerces an array to a
        // comma-joined string ('SEND,ISSUE') - JSON.stringify would then persist
        // '"SEND,ISSUE"' instead of '["SEND","ISSUE"]', and getContractPermissions'
        // Array.isArray check would read it back as a non-array and SILENTLY disable
        // the emission allowlist. Stringify the raw array here so the JSON is intact.
        let permsRaw       = data['PERMISSIONS'];
        data               = this.normalizeDataValues(data);
        let action_index   = data['ACTION_INDEX'];
        let contract_index = data['CONTRACT_INDEX'];
        let permissions    = this.util.isNull(permsRaw)            ? null : JSON.stringify(permsRaw);
        let max_take_bps   = this.util.isNull(data['MAX_TAKE_BPS']) ? null : Number(data['MAX_TAKE_BPS']);
        let block_index    = data['BLOCK_INDEX'];
        let query  = "SELECT action_index FROM contract_permissions WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE contract_permissions SET
                        contract_index=?, permissions=?, max_take_bps=?, block_index=?
                    WHERE action_index=?`;
            args = [contract_index, permissions, max_take_bps, block_index, action_index];
        } else {
            query = `INSERT INTO contract_permissions
                        (contract_index, permissions, max_take_bps, block_index, action_index)
                    VALUES (?, ?, ?, ?, ?)`;
            args = [contract_index, permissions, max_take_bps, block_index, action_index];
        }
        await this.doQuery(query, args);
    }

    // Read a contract's persisted permissions manifest (Phase E). Returns
    //   { permissions: string[]|null, maxTakeBps: number|null }
    // or null when the contract declared no manifest (no row) - the unrestricted,
    // backward-compatible default the callers (processEmission / runControllerGuard)
    // treat as "no per-contract restriction". permissions is JSON-parsed back to an
    // array; a NULL column stays null (unrestricted).
    async getContractPermissions(contractIndex){
        let query = `SELECT permissions, max_take_bps FROM contract_permissions WHERE contract_index=? LIMIT 1`;
        let results = await this.doQuery(query, [contractIndex]);
        if(results.length === 0)
            return null;
        let row = results[0];
        let permissions = null;
        if(!this.util.isNull(row.permissions)){
            try { permissions = JSON.parse(row.permissions); } catch(e){ permissions = null; }
        }
        let maxTakeBps = this.util.isNull(row.max_take_bps) ? null : Number(row.max_take_bps);
        return { permissions, maxTakeBps };
    }

    // Get status string by status_id
    async getStatusString(status_id){
        if(this.util.isNull(status_id))
            return null;
        let query = `SELECT status FROM index_statuses WHERE id=? LIMIT 1`;
        let results = await this.doQuery(query, [status_id]);
        if(results.length > 0)
            return results[0].status;
        return null;
    }

    // Create record in `contract_executions` table
    async createContractExecution(data){
        data             = this.normalizeDataValues(data);
        let status_id    = await this.createStatus(data['STATUS']);
        let caller_id    = await this.getAddressId(data['CALLER']);
        let action_index = data['ACTION_INDEX'];
        let contract_index = data['CONTRACT_INDEX'];
        let method_name  = data['METHOD_NAME'];
        let input_params = data['INPUT_PARAMS'];
        let gas_used     = data['GAS_USED'];
        let gas_limit    = data['GAS_LIMIT'];
        let error_message = data['ERROR_MESSAGE'];
        let emitted_count = data['EMITTED_COUNT'] || 0;
        let block_index  = data['BLOCK_INDEX'];
        let query  = "SELECT action_index FROM contract_executions WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE contract_executions SET
                        contract_index=?, caller_id=?, method_name=?, input_params=?,
                        gas_used=?, gas_limit=?, status_id=?, error_message=?,
                        emitted_count=?, block_index=?
                    WHERE action_index=?`;
            args = [contract_index, caller_id, method_name, input_params,
                    gas_used, gas_limit, status_id, error_message,
                    emitted_count, block_index, action_index];
        } else {
            query = `INSERT INTO contract_executions
                        (contract_index, caller_id, method_name, input_params,
                         gas_used, gas_limit, status_id, error_message,
                         emitted_count, block_index, action_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            args = [contract_index, caller_id, method_name, input_params,
                    gas_used, gas_limit, status_id, error_message,
                    emitted_count, block_index, action_index];
        }
        await this.doQuery(query, args);
    }

    // Create record in `deposits` table
    async createDeposit(data){
        data             = this.normalizeDataValues(data);
        let status_id    = await this.createStatus(data['STATUS']);
        let source_id    = await this.getAddressId(data['SOURCE']);
        let tick_id      = await this.createTicker(data['TICK']);
        let action_index = data['ACTION_INDEX'];
        let contract_index = data['CONTRACT_ACTION_INDEX'];
        let amount       = data['AMOUNT'];
        let block_index  = data['BLOCK_INDEX'];
        let query  = "SELECT action_index FROM deposits WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE deposits SET
                        contract_index=?, source_id=?, tick_id=?, amount=?, status_id=?, block_index=?
                    WHERE action_index=?`;
            args = [contract_index, source_id, tick_id, amount, status_id, block_index, action_index];
        } else {
            query = `INSERT INTO deposits
                        (contract_index, source_id, tick_id, amount, status_id, block_index, action_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`;
            args = [contract_index, source_id, tick_id, amount, status_id, block_index, action_index];
        }
        await this.doQuery(query, args);
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

    /*****************************************************************
     * VM Integration - Contract State
     ****************************************************************/

    // Get the current state of a contract as a { key: value } object.
    // `blockIndex` is the block being processed and drives the state_key
    // collation flag-day (state_key_collation_activation.js): contract_state is
    // utf8_general_ci, so the legacy GROUP BY folds distinct keys like
    // "Key"/"key" into ONE group and the reload drops one of them - the key
    // vanishes on the next EXECUTE despite the null-prototype round-trip
    // contract below. At/after the activation height the reload groups by
    // state_key_bin (the utf8_bin generated shadow of state_key, byte-identical
    // rows to GROUP BY state_key COLLATE utf8_bin but index-backed via
    // idx_latest_bin) so every distinct key survives reload; below it (or when
    // no blockIndex is supplied) the legacy folding form is kept so historical
    // re-execution stays byte-identical.
    async getContractState(contractIndex, blockIndex){
        // Get the latest row per key using MAX(id)
        // The idx_latest index (contract_index, state_key, id DESC) makes this efficient
        let stateKeyBin = (blockIndex !== undefined) && stateKeyCollation.isStateKeyBinCollationActive(
            blockIndex, this.config['NETWORK'], this.config['COIN']);
        let query = `SELECT cs.state_key, cs.state_value
                     FROM contract_state cs
                     INNER JOIN (
                         SELECT MAX(id) as max_id
                         FROM contract_state
                         WHERE contract_index = ?
                         GROUP BY ` + (stateKeyBin ? 'state_key_bin' : 'state_key') + `
                     ) latest ON cs.id = latest.max_id
                     WHERE cs.state_value IS NOT NULL`;
        let results = await this.doQuery(query, [contractIndex]);
        // Null-prototype object so adversarial keys round-trip faithfully. A
        // plain {} would route state['__proto__'] = value through the __proto__
        // setter - a no-op for non-object values (silently dropping the key) or
        // a prototype reassignment for object values. The VM's StateManager
        // already uses Object.create(null) and lets contracts state.set('__proto__'),
        // so the reload path must preserve it too, else that key vanishes on the
        // next EXECUTE.
        let state = Object.create(null);
        for(let row of results){
            try {
                state[row.state_key] = JSON.parse(row.state_value);
            } catch(e){
                state[row.state_key] = row.state_value;
            }
        }
        return state;
    }

    // Append a new state row (append-only - rollback via DELETE WHERE block_index >= ?)
    async createContractState(data){
        let query = `INSERT INTO contract_state
                        (contract_index, state_key, state_value, block_index, action_index)
                     VALUES (?, ?, ?, ?, ?)`;
        let args = [
            data['CONTRACT_INDEX'],
            data['STATE_KEY'],
            data['STATE_VALUE'],
            data['BLOCK_INDEX'],
            data['ACTION_INDEX']
        ];
        await this.doQuery(query, args);
    }

    // Create a record in contract_emissions
    async createContractEmission(data){
        let query = `INSERT INTO contract_emissions
                        (execution_index, emitted_action, action_index, position)
                     VALUES (?, ?, ?, ?)`;
        let args = [
            data['EXECUTION_INDEX'],
            data['EMITTED_ACTION'],
            data['ACTION_INDEX'],
            data['POSITION']
        ];
        await this.doQuery(query, args);
    }

    // Delete a contract record (for constructor failure rollback)
    async deleteContract(actionIndex){
        let query = `DELETE FROM contracts WHERE action_index=?`;
        await this.doQuery(query, [actionIndex]);
        // A contract's permissions manifest (Phase E) is persisted under the same
        // DEPLOY action_index, so a failed/cleaned-up deploy must drop it too.
        await this.doQuery(`DELETE FROM contract_permissions WHERE action_index=?`, [actionIndex]);
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

    /*****************************************************************
     * VM Integration - Oracle / Cross-Chain Stubs
     ****************************************************************/

    // Oracle data accessor - reads from price_snapshots table
    // Returns an accessor object that the VM gateway uses for xchain.oracle.*
    //
    // blockTime is the unix-second timestamp of the block being processed; together with
    // maxAgeSeconds it gates getPrice against stale snapshots. Staleness is measured
    // deterministically as (blockTime − snapshot.block_timestamp), both chain-derived
    // unix seconds, so every node replaying the block computes the same result and
    // historical backfill is never falsely flagged stale. maxAgeSeconds <= 0 disables the guard.
    async getOracleDataForVM(blockIndex, blockTime, maxAgeSeconds){
        this._assertPriceBarrierNotSkipped('getOracleDataForVM');
        let self = this;
        let refTime = parseInt(blockTime);
        let maxAge  = parseInt(maxAgeSeconds);

        // Cap every snapshot read at the block being processed so a replay never
        // observes a FUTURE snapshot. Defined once here (was previously declared
        // only for the getPrice/getPriceAtRound queries below) so the age query
        // can share the same cap. blockIndex falsy -> 999999999 (no effective cap),
        // matching the sibling queries' idiom.
        let blockCap = blockIndex || 999999999;

        // Pre-load the latest finalized snapshot age (blocks since last snapshot).
        // Snapshot-age causality gate (oracle_snapshot_age_causality_activation.js):
        // the legacy age query has NO block cap, unlike every sibling below, so a
        // node replaying block N whose DB already holds a future finalized snapshot
        // at N+k reads it and computes snapshotAge 0, while the node that first
        // processed N computed a positive age. getSnapshotAge() is VM-visible, so
        // that divergence forks the contract hash. At/after the activation height
        // the age query is causally capped at blockCap; below it the uncapped legacy
        // query runs so historical blocks replay byte-identically. Execution-path
        // gate (VM read), indexer-only: xchain-sync never re-runs the VM.
        let ageCausal = snapshotAgeCausality.isOracleSnapshotAgeCausalityActive(
            blockIndex, this.config['NETWORK'], this.config['COIN']);
        let ageQuery = "SELECT MAX(reference_block) AS latest_block FROM price_snapshots WHERE status = 'finalized'"
                     + (ageCausal ? " AND reference_block <= ?" : "");
        let ageRows = await this.doQuery(ageQuery, ageCausal ? [blockCap] : undefined);
        let latestBlock = (ageRows.length > 0 && ageRows[0].latest_block !== null) ? ageRows[0].latest_block : 0;
        let snapshotAge = (blockIndex && latestBlock > 0) ? Math.max(0, blockIndex - latestBlock) : Number.MAX_SAFE_INTEGER;

        // True when a snapshot is older than the configured max age relative to the
        // block being processed (stale ⇒ treated as no price).
        let isStale = (snapshotTimestamp) => {
            if(!(maxAge > 0) || !Number.isFinite(refTime)) return false;
            if(!(snapshotTimestamp > 0)) return false;
            return (refTime - snapshotTimestamp) > maxAge;
        };

        // ── Build a SERIALIZABLE oracle snapshot (plain data) ───────────────
        // The VM runs in a forked worker; read-only data must cross the IPC
        // boundary, so we PRE-LOAD here and let xchain-vm/src/readonly-accessors.js
        // rebuild the synchronous getPrice/getPriceAtRound/getSnapshotAge accessors
        // inside the worker. (These were previously async DB closures - incompatible
        // with the VM's synchronous applySync bridge, so oracle reads silently
        // resolved a Promise. This conversion also fixes that latent bug.)
        // blockCap is defined once above (shared with the snapshot-age query).

        // getPrice(): latest finalized price per coin_pair at/<= block, one row
        // per pair (GROUP BY guarantees correctness), staleness-applied.
        let prices = {};
        let latestQuery = `SELECT t.coin_pair AS coin_pair, t.price AS price,
                                  t.round_number AS round_number, t.block_timestamp AS block_timestamp
                           FROM price_snapshots t
                           INNER JOIN (
                               SELECT coin_pair, MAX(round_number) AS mr
                               FROM price_snapshots
                               WHERE status = 'finalized' AND price IS NOT NULL AND reference_block <= ?
                               GROUP BY coin_pair
                           ) m ON t.coin_pair = m.coin_pair AND t.round_number = m.mr
                           WHERE t.status = 'finalized' AND t.price IS NOT NULL`;
        let latestRows = await this.doQuery(latestQuery, [blockCap]);
        // Stale-round visibility gate (oracle_stale_round_visibility_activation.js).
        // Below the height a stale tip is dropped from `prices` entirely, so
        // getPrice() returns null while getPriceAtRound() still carries the very
        // same round - the two views disagree about whether the round EXISTS, and
        // a liveness guard that reads getPrice() (the price-bet family's
        // "has the oracle produced a qualifying round yet?") voids a bet that
        // consensus history already decided. At/after the height the row is kept
        // with its PRICE WITHHELD instead: identity and consensus timestamp stay
        // readable, the stale value does not. VM-observable, hence height-gated.
        let staleVisible = staleRoundVisibility.isOracleStaleRoundVisibilityActive(
            blockIndex, this.config['NETWORK'], this.config['COIN']);
        for(let r of latestRows){
            let stale = isStale(Number(r.block_timestamp));
            // Legacy path: stale prices surface as no-price (null); contracts can
            // still read getSnapshotAge() for the staleness signal.
            if(stale && !staleVisible) continue;
            prices[String(r.coin_pair)] = {
                price:       stale ? null : r.price,
                roundNumber: Number(r.round_number),
                timestamp:   Number(r.block_timestamp)
            };
            // Marker only on withheld rows, so a fresh row stays byte-identical
            // to the pre-gate shape across the whole activation boundary.
            if(stale) prices[String(r.coin_pair)].stale = true;
        }

        // getPriceAtRound(): historical finalized rounds at/<= block. NOTE: this
        // now respects block causality (reference_block <= block) - an improvement
        // over the old unfiltered query (which was non-functional anyway). Capped
        // for safety; a hit is LOGGED, never silently truncated.
        //
        // Deliberately NOT row-filtered by isStale(). Staleness is measured
        // against the block being processed, so it is true of ALL history older
        // than maxAge: filtering rows here would empty getPriceAtRound() of
        // everything but the last few minutes, break the immutable-history
        // contract the accessor exists to provide, move a timestamp-settled bet
        // onto a LATER round than consensus history designates, and make every
        // round-number bet reclaimable by its loser (that template's void guard
        // is "getPriceAtRound(settleRound) === null"). The prices/rounds
        // asymmetry is closed on the `prices` side above (stale tips are kept
        // with the price withheld) rather than by hiding history here.
        let rounds = {};
        const MAX_ORACLE_ROUNDS = 50000;
        let roundQuery = `SELECT coin_pair, price, round_number, block_timestamp
                          FROM price_snapshots
                          WHERE status = 'finalized' AND price IS NOT NULL AND reference_block <= ?
                          ORDER BY round_number DESC
                          LIMIT ${MAX_ORACLE_ROUNDS}`;
        let roundRows = await this.doQuery(roundQuery, [blockCap]);
        if(roundRows.length >= MAX_ORACLE_ROUNDS)
            console.error('[oracle snapshot] round set capped at ' + MAX_ORACLE_ROUNDS +
                ' rows for block ' + blockIndex + ' - getPriceAtRound may miss older rounds');
        for(let r of roundRows){
            let cp = String(r.coin_pair);
            if(!rounds[cp]) rounds[cp] = {};
            rounds[cp][String(r.round_number)] = {
                price:       r.price,
                roundNumber: Number(r.round_number),
                timestamp:   Number(r.block_timestamp)
            };
        }

        return { snapshotAge, prices, rounds };
    }

    // Get the latest finalized price for a coin pair at or before a given block height
    // blockHeight gates the query so two nodes processing the same block always see the same price
    //
    // opts (optional) enables a staleness guard: { blockTime, maxAgeSeconds }. When both
    // are supplied and maxAgeSeconds > 0, a snapshot whose block_timestamp is older than
    // maxAgeSeconds relative to blockTime is treated as no price (returns null) rather than
    // a silently outdated value. Age is measured as (blockTime − snapshot.block_timestamp),
    // both chain-derived unix seconds, so the check is deterministic across nodes and does
    // not false-trigger during historical backfill.
    async getLatestPrice(coinPair, blockHeight, opts){
        this._assertPriceBarrierNotSkipped('getLatestPrice');
        let query, args;
        if(opts && opts.selectByTime && Number.isFinite(Number(opts.blockTime))){
            // H-3 (NATIVE_FEE_PRICE_TIME_GATE): on non-reference chains the
            // reference_block gate below is vacuous (LTC/DOGE heights sit far
            // above any BTC anchor), so selection must pin on the round's own
            // consensus timestamp vs this block's time - the same two
            // quantities the staleness guard compares. Deterministic across
            // nodes (given the time-keyed price barrier) and on replay
            // (historical block times exclude rounds finalized later).
            query = `SELECT price, round_number, block_timestamp
                     FROM price_snapshots
                     WHERE coin_pair = ? AND status = 'finalized' AND price IS NOT NULL
                       AND block_timestamp <= ?
                     ORDER BY round_number DESC LIMIT 1`;
            args = [coinPair, Number(opts.blockTime)];
        } else if(blockHeight !== undefined && blockHeight !== null){
            query = `SELECT price, round_number, block_timestamp
                     FROM price_snapshots
                     WHERE coin_pair = ? AND status = 'finalized' AND price IS NOT NULL
                       AND reference_block <= ?
                     ORDER BY round_number DESC LIMIT 1`;
            args = [coinPair, blockHeight];
        } else {
            query = `SELECT price, round_number, block_timestamp
                     FROM price_snapshots
                     WHERE coin_pair = ? AND status = 'finalized' AND price IS NOT NULL
                     ORDER BY round_number DESC LIMIT 1`;
            args = [coinPair];
        }
        // Strict read (M-17): this is a consensus input. doQuery would swallow a
        // non-transactional query error into [] - indistinguishable from "no
        // price", so one node with a transient hub-DB fault fails the fee closed
        // while healthy peers accept, forking the ledger. Throwing instead lets
        // block processing roll back and retry the block.
        let rows = await this.doQueryStrict(query, args);
        if(rows.length === 0) return null;

        // Staleness guard (opt-in via opts) - see method comment.
        if(opts){
            let refTime = parseInt(opts.blockTime);
            let maxAge  = parseInt(opts.maxAgeSeconds);
            let snapTs  = Number(rows[0].block_timestamp);
            if(maxAge > 0 && Number.isFinite(refTime) && snapTs > 0 && (refTime - snapTs) > maxAge){
                return null;
            }
        }

        return {
            price:       rows[0].price,
            roundNumber: Number(rows[0].round_number),
            timestamp:   Number(rows[0].block_timestamp)
        };
    }

    // Get the latest effective oracle price for a (sourceAddress, coin, tick, fiat) combination
    // gated by blockTime so two nodes processing the same block see the same price.
    // The 24-hour lock window is enforced by `effective_at` - only prices whose effective_at <= blockTime are returned.
    async getOraclePrice(sourceAddress, coin, tick, fiat, blockTime){
        this._assertPriceBarrierNotSkipped('getOraclePrice');
        let query = `SELECT id, source_address, source_chain, coin, tick, fiat, value, fee, memo,
                            block_time, effective_at, action_index
                     FROM oracle_prices
                     WHERE source_address = ? AND coin = ? AND tick = ? AND fiat = ?`;
        let args = [sourceAddress, coin, tick, fiat];
        if(blockTime !== undefined && blockTime !== null){
            query += ' AND effective_at <= ?';
            args.push(blockTime);
        }
        // Tiebreak on action_index (consensus-stable: (source_chain, action_index) is the
        // unique key) not id (local AUTO_INCREMENT, differs per mirror by arrival order),
        // so an effective_at tie resolves to the same row on every node.
        query += ' ORDER BY effective_at DESC, action_index DESC LIMIT 1';
        let rows = await this.doQuery(query, args);
        if(rows.length === 0) return null;
        return {
            sourceAddress: rows[0].source_address,
            sourceChain:   rows[0].source_chain,
            coin:          rows[0].coin,
            tick:          rows[0].tick,
            fiat:          rows[0].fiat,
            value:         rows[0].value,
            fee:           rows[0].fee,
            memo:          rows[0].memo,
            blockTime:     Number(rows[0].block_time),
            effectiveAt:   Number(rows[0].effective_at),
            actionIndex:   Number(rows[0].action_index)
        };
    }

    // Get oracle prices for a (sourceAddress, coin, tick, fiat) within a time range (newest-first)
    // Used by reverseOraclePriceMatch for FIAT dispenser settlement.
    async getOraclePricesInTimeRange(sourceAddress, coin, tick, fiat, startTime, endTime){
        this._assertPriceBarrierNotSkipped('getOraclePricesInTimeRange');
        let query = `SELECT value, block_time, effective_at, action_index
                     FROM oracle_prices
                     WHERE source_address = ? AND coin = ? AND tick = ? AND fiat = ?
                       AND effective_at BETWEEN ? AND ?
                     ORDER BY effective_at DESC, action_index DESC`;
        let rows = await this.doQuery(query, [sourceAddress, coin, tick, fiat, startTime, endTime]);
        return rows.map(row => ({
            price:        row.value,
            blockTime:    Number(row.block_time),
            effectiveAt:  Number(row.effective_at),
            actionIndex:  Number(row.action_index)
        }));
    }

    // Get finalized prices for a coin pair within a time range (newest-first)
    async getPricesInTimeRange(coinPair, startTime, endTime){
        this._assertPriceBarrierNotSkipped('getPricesInTimeRange');
        let query = `SELECT price, round_number, block_timestamp
                     FROM price_snapshots
                     WHERE coin_pair = ? AND status = 'finalized' AND price IS NOT NULL
                       AND block_timestamp BETWEEN ? AND ?
                     ORDER BY block_timestamp DESC, round_number DESC`;
        let rows = await this.doQuery(query, [coinPair, startTime, endTime]);
        return rows.map(row => ({
            price:       row.price,
            roundNumber: Number(row.round_number),
            timestamp:   Number(row.block_timestamp)
        }));
    }

    // Cross-chain data stub - returns no-data accessors until Phase 4
    async getCrossChainDataForVM(block_index){
        // Serializable snapshot (plain data) - the VM worker rebuilds the
        // getAttestation/isSettled accessors (keys are "CHAIN:action_index").
        //
        // CONSENSUS RULE: `settled` is built from the LOCAL cross_chain_settlements
        // table - legs THIS chain applied - never from the mirrored cross_chain_matches.
        // Mirror rows are deleted by reorg retraction without reorging this chain, so a
        // mirror-derived read would diverge between live nodes and a fresh resync. The
        // local table is action_index-anchored (drops with this chain's own reorgs) and
        // is rebuilt identically on replay. Settlements involving only other chains are
        // therefore NOT visible here (isSettled → false) - documented limitation.
        //
        // Only settlements from blocks strictly BEFORE the current one are exposed, so
        // every execution in a block sees the same snapshot regardless of whether it
        // runs before or after this block's settlement pass.
        let settled = {};
        let rows = await this.doQuery(
            `SELECT a_chain, a_action_index, b_chain, b_action_index
             FROM cross_chain_settlements
             WHERE block_index < ? AND a_chain IS NOT NULL`,
            [Number(block_index) || 0]);
        for(let r of rows){
            settled[String(r.a_chain) + ':' + String(r.a_action_index)] = true;
            settled[String(r.b_chain) + ':' + String(r.b_action_index)] = true;
        }
        // Cross-chain call results this chain originated, keyed by call_id -
        // backs xchain.crossChain.getCallResult(callId). Same consensus rule:
        // LOCAL table (xcalls), terminal rows only, visible from the block AFTER
        // the one that resolved them (resolved_block < current).
        let calls = {};
        let callRows = await this.doQuery(
            `SELECT call_id, result_status, result_payload FROM xcalls
             WHERE version = 0 AND request_status IN ('completed', 'expired')
               AND resolved_block IS NOT NULL AND resolved_block < ?`,
            [Number(block_index) || 0]);
        for(let r of callRows){
            calls[String(r.call_id)] = {
                status:  String(r.result_status || ''),
                payload: String(r.result_payload == null ? '' : r.result_payload)
            };
        }
        // getAttestation stays unwired (null) until the federation mirrors per-action
        // attestations; reserved by the documented API surface.
        return { attestations: {}, settled: settled, calls: calls };
    }

    // Get total unclaimed rewards for a source address.
    // blockIndex (optional): scope both sides to rows earned/claimed at or before
    // that block. COLLECT validation MUST pass its BLOCK_INDEX so a replay
    // (reindex / ANCHOR recovery) sees exactly the rewards that were visible when
    // the COLLECT confirmed - bulk-restored rewards must not become visible to
    // EARLIER COLLECTs than they were live (CONSENSUS). Live operation is
    // unaffected: pushed/derived rows always carry block_index <= tip.
    async getUnclaimedRewardTotal(source, blockIndex){
        let source_id = await this.getAddressId(source);
        if(source_id === null)
            return '0';
        let scoped = (blockIndex !== undefined && blockIndex !== null);
        // Sum all rewards minus all claimed amounts
        let query = `SELECT
                        COALESCE(SUM(CAST(vr.amount AS DECIMAL(65,18))), 0) as total_rewards
                    FROM validator_rewards vr
                    WHERE vr.source_id=?`;
        let args = [source_id];
        if(scoped){
            query += ' AND vr.block_index <= ?';
            args.push(blockIndex);
        }
        let results = await this.doQuery(query, args);
        let totalRewards = (results.length > 0) ? String(results[0].total_rewards) : '0';

        query = `SELECT
                    COALESCE(SUM(CAST(rc.amount AS DECIMAL(65,18))), 0) as total_claimed
                FROM reward_claims rc
                    INNER JOIN index_statuses s ON (s.id=rc.status_id)
                WHERE rc.source_id=? AND s.status='valid'`;
        args = [source_id];
        if(scoped){
            query += ' AND rc.block_index <= ?';
            args.push(blockIndex);
        }
        results = await this.doQuery(query, args);
        let totalClaimed = (results.length > 0) ? String(results[0].total_claimed) : '0';

        let unclaimed = this.util.bcsub(totalRewards, totalClaimed, 18);
        return unclaimed;
    }
}
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

module.exports = Database