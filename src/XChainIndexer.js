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
 * XChain Indexer - Indexer Class
 *
 * This file handles starting the indexer and parsing blocks and actions
 *
 ********************************************************************/

// Load required libraries
const fs        = require('fs');
const config    = require('./config.js');
const changes   = require('./protocol_changes.js');
const database  = require('./db.js');
const actions   = require('./actions.js');
const util      = require('./utility.js');
const rollback  = require('./rollback.js');
const mapper    = require('./mapper.js');
const stateCommitment   = require('./stateCommitment.js');
const stateCommitAct    = require('./state_commitment_activation.js');
const HubClient    = require('./hub_client.js');
const HubDbSync    = require('./hub_db_sync.js');
const HubPushQueue = require('./hub_push_queue.js');
const UtxoTracker  = require('./UtxoTracker.js');
const Genesis      = require('./genesis.js');
const { collapseOutputFanout } = require('./output_fanout.js');

class XChainIndexer {

    constructor(decoderDbHost, decoderDbPort, decoderDbName, decoderDbUser, decoderDbPass, indexerDbHost, indexerDbPort, indexerDbName, indexerDbUser, indexerDbPass, hubDbHost, hubDbPort, hubDbName, hubDbUser, hubDbPass, utxoTrackerUrl, utxoTrackerPort){
        // XChain Indexer Version
        this.version = process.env.npm_package_version;
        this.name    = process.env.npm_package_name;

        // Decoder database config
        this.decoderDbHost = decoderDbHost;
        this.decoderDbPort = decoderDbPort;
        this.decoderDbName = decoderDbName;
        this.decoderDbUser = decoderDbUser;
        this.decoderDbPass = decoderDbPass;

        // Indexer database config
        this.indexerDbHost = indexerDbHost;
        this.indexerDbPort = indexerDbPort;
        this.indexerDbName = indexerDbName;
        this.indexerDbUser = indexerDbUser;
        this.indexerDbPass = indexerDbPass;

        // Hub database config (local read-only copy of cross-chain infrastructure data,
        // synced from xchain-hub via xchain-sync)
        this.hubDbHost = hubDbHost;
        this.hubDbPort = hubDbPort;
        this.hubDbName = hubDbName;
        this.hubDbUser = hubDbUser;
        this.hubDbPass = hubDbPass;

        // xchain-utxo-tracker config (used by DISPENSER fresh-address check)
        this.utxoTrackerUrl  = utxoTrackerUrl;
        this.utxoTrackerPort = utxoTrackerPort;

        // Placeholders for database connections
        this.decoderDb    = null;
        this.indexerDb    = null;
        this.hubDb        = null;
        this.utxoTracker  = null;

        // Misc placeholders
        this.synced           = false;
        this.lastDecoderBlock = null;
        this.stopFlag         = false

        // Short machine-readable reason the block counter is currently not advancing,
        // or null when advancing normally. Set at each point where the catch-up loop
        // defers a block (the hub-sync barriers below time out, or the VM executor is
        // unavailable) and cleared the moment a block commits. Surfaced by health() so
        // an operator can tell WHY lag is growing (a sync-barrier stall, a circuit
        // breaker, and a host fault otherwise all look identical: a rising lag).
        this.stallReason = null;
        this.blockchainInfoLastBlock = -1

        // Wall-clock (epoch ms) of the most recent SUCCESSFUL hub-config fetch. Set by the
        // startup overlay and every poll tick that gets a response, regardless of whether the
        // committed config actually changed. Stays null until the first success. Surfaced as
        // an age in the health/status endpoints so an operator can tell that a hub outage has
        // left the live-polled governance params (ACTIVATION_DELAY_BLOCKS, EXPIRATION_FEE_PER_DAY,
        // STAKING) silently frozen while the indexer keeps reporting healthy.
        this.lastHubConfigFetchAt = null;

        // Last hub-config change signals seen. seq = PBFT-committed change counter (0 on a
        // standalone/config-oracle hub with no consensus); watermark = MAX(updated_at) over
        // the hub's configs, which advances on ANY config write. A re-apply fires when
        // EITHER advances, so a non-consensus hub's edits are not silently ignored.
        this.lastHubConfigSeq = 0;
        this.lastHubConfigWatermark = 0;

        // Price-sync barrier timeout (ms). Before processing a block, the indexer waits for
        // its local price mirror to catch up to that block height so native-coin fee
        // validation is deterministic across operators. On timeout the block is deferred and
        // retried rather than validated against a stale price copy.
        this.priceSyncTimeoutMs = parseInt(process.env.HUB_PRICE_SYNC_TIMEOUT_MS || '60000');

        // Direct-hub-DB call-presence barrier timeout (ms). In single-host / direct-hub-DB
        // mode there is no HubDbSync mirror, so the cross-chain-call sync barrier is skipped.
        // But reading the hub's MariaDB directly does NOT mean a relay row was already WRITTEN
        // when this block was processed. Before the cross-chain-call pass, the indexer waits
        // (bounded) for any in-flight hub write to land, so a live node and a replaying node
        // inject at the same block. The hub-side relay margin is the primary guarantee; this
        // is defense-in-depth. See _waitForDirectCallPresence.
        this.callPresenceTimeoutMs = parseInt(process.env.XCALL_DIRECT_PRESENCE_TIMEOUT_MS || '10000');
    }

    // Handle indicating if indexer is synced
    isSynced(){
        return this.synced;
    }

    // Handle setting flag to stop indexer
    stop(){
        this.stopFlag = true;
        if(this.hubPushQueue) this.hubPushQueue.stop();
    }

    // Direct-hub-DB call-presence barrier (see the call site in the block loop and the note on
    // callPresenceTimeoutMs). Resolves only when it is safe to read cross_chain_calls for a block
    // at block_time, so the injection/callback pass sees EXACTLY the finalized rows with
    // effective_time <= block_time that canonical hub state holds, never a smaller (partial) set:
    //   * Coverage condition (proceed): the local hub mirror covers this block once
    //     MAX(effective_time) over finalized rows >= block_time. Nothing later than block_time can
    //     change the effective-at/before set, so reading now matches a node that saw every row on
    //     time. This is the SOLE proceed condition; the prior wall-clock gate is removed.
    //   * Empty-table fast path (proceed): no finalized rows means there is nothing to wait on.
    //   * Mirror-lags (defer): if the highest finalized effective_time is still BELOW block_time
    //     the mirror is genuinely behind, so this block's call set would be incomplete. We do NOT
    //     proceed with that partial set. Instead we poll the mirror with a bounded sleep loop
    //     (mirroring the indexer's other sync barriers) and, if it has not caught up within
    //     callPresenceTimeoutMs, THROW so the caller defers the block and retries it from the top
    //     of the loop (lastIndexerBlock is not advanced). This is wait-then-retry, not
    //     throw-and-halt: a behind mirror blocks block PROCESSING (the consensus-correct outcome)
    //     until it catches up, rather than committing a divergent, partial-set block.
    //
    // CRITICAL fast path: the common cases (regtest single shared hub DB already current, or no
    // pending lag) hit the coverage / empty-table condition on the very first query and return
    // with zero added latency. Only a genuinely-lagging distributed mirror enters the poll loop.
    // A wall-clock proceed (Date.now) is deliberately NOT used: it let a lagging node proceed with
    // fewer cross-chain calls than canonical and diverge the actions hash (the bug this fixes).
    // Deliver the hub pushes staged (and durably written via enqueueHubPushTx) during the block
    // transaction that just committed. Each push_type maps to the same HubClient method the
    // HubPushQueue drain uses; on success the durable pending_hub_pushes row is dropped, on any
    // failure it is left for HubPushQueue to retry with backoff. Never throws into the block loop.
    async _deliverStagedHubPushes(){
        let staged = this.indexerDb.takeStagedHubPushes();
        if(!staged || staged.length === 0 || !this.hubClient) return;
        for(let entry of staged){
            try {
                if(entry.pushType === 'price_round'){
                    await this.hubClient.pushPriceRound(entry.payload);
                } else if(entry.pushType === 'oracle_price'){
                    await this.hubClient.pushOraclePrice(entry.payload);
                } else {
                    // Unknown type: leave the durable row for HubPushQueue rather than guess.
                    continue;
                }
                if(entry.id != null) await this.indexerDb.markHubPushDelivered(entry.id);
            } catch(err){
                // Live delivery failed; the durable row stays for HubPushQueue's backoff retry.
                console.warn('Staged hub push ' + entry.pushType + ' row ' + entry.id +
                    ' live delivery failed; HubPushQueue will retry:', err && err.message);
            }
        }
    }

    async _waitForDirectCallPresence(blockTime){
        blockTime = Number(blockTime);
        if(!this.hubDb || !Number.isFinite(blockTime)) return;
        let timeoutMs = Number(this.callPresenceTimeoutMs);
        if(!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = 10000;
        let deadline = Date.now() + timeoutMs;
        let pollMs = 250;
        let lastTs = null;          // last observed mirror watermark, for the timeout diagnostic
        while(true){
            // Coverage check: proceed the instant the local hub mirror covers block_time, i.e.
            // the highest finalized effective_time is at/after it, or there is nothing to wait on.
            // A query error means the table is not ready yet, which reads as NOT covered so the
            // barrier waits (it never proceeds against an unread table).
            let covered = false;
            try {
                let rows = await this.hubDb.doQuery(
                    "SELECT MAX(effective_time) AS ts FROM cross_chain_calls WHERE status = 'finalized'");
                if(rows.length === 0 || rows[0].ts === null){
                    covered = true;                         // no finalized rows: nothing to wait on
                } else {
                    lastTs = Number(rows[0].ts);
                    if(lastTs >= blockTime) covered = true; // mirror covers this block
                }
            } catch(e){
                // Table not ready / transient error: treat as not covered and keep waiting.
                // Surface it once per distinct message so a persistent fault (schema change,
                // permission regression, dead pool) is distinguishable from genuine mirror lag
                // instead of looking identical to it for the whole timeout window.
                if(this._callPresenceLastErr !== e.message){
                    this._callPresenceLastErr = e.message;
                    console.error('direct call-presence query error (treating as not covered): ' + e.message);
                }
            }
            if(covered) return;
            // Mirror is behind. Defer the block rather than proceed with a partial set: once the
            // bound is exhausted, throw so the caller retries this block from the top of the loop.
            if(Date.now() >= deadline)
                this.util.throwError('direct call-presence barrier timed out after ' + timeoutMs +
                    'ms waiting for block_time ' + blockTime + ' (call mirror at ' + lastTs + ')' +
                    (this._callPresenceLastErr ? ' [last query error: ' + this._callPresenceLastErr + ']' : ''));
            console.log('Waiting on hub call mirror: block_time ' + blockTime +
                ' not yet covered (mirror at ' + lastTs + '); retrying...');
            await this.util.sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
        }
    }

    // Handle starting up the XChain indexer
    async start(){
        console.log('Starting up ' + this.name + ' v' + this.version + '...');

        // Get indexer configuration
        this.config = config.getConfig();

        // Create instance of the utility class, sharing the indexer's single
        // config object (NOT a fresh getConfig()) so a later hub overlay can't
        // make this.config and this.util.config diverge.
        this.util = new util(this.config);

        // Guard the shared-config invariant: every block-processing module reads
        // this.config, and the hub overlay mutates it in place, so util MUST hold
        // the same object. Construction above guarantees it; this catches a future
        // refactor that reintroduces the divergence without bricking startup.
        if(this.util.config !== this.config)
            console.error('CONFIG WIRING BUG: indexer.config and util.config are not the same object; a hub overlay could desync consensus reads.');

        // Verify the bundled canonical coin files against CONSENSUS_CONFIG_PIN before
        // processing any block. A null pin (mainnet, pre-arm) skips; a mismatch on an
        // armed network halts, exactly like genesis.js' ledger-hash check. This catches
        // a vendored coin file that drifted from the pinned consensus config.
        require('./coins').verifyConsensusPin(this.config.NETWORK);

        // Create hub client (for pushing chain tip and other cross-chain data to xchain-hub)
        this.hubClient = new HubClient();

        // Overlay hub-served operational params on top of local config defaults (best-effort)
        await this._applyHubConfigOverlay();

        // Keep the overlay live: poll the hub so a PBFT-committed config change takes
        // effect without requiring a process restart (see _startHubConfigPolling).
        this._startHubConfigPolling();

        // Establish database connections
        this.decoderDb = new database(this.decoderDbHost, this.decoderDbPort, this.decoderDbName, this.decoderDbUser, this.decoderDbPass, this);
        this.indexerDb = new database(this.indexerDbHost, this.indexerDbPort, this.indexerDbName, this.indexerDbUser, this.indexerDbPass, this);

        // Optional hub database connection (read-only local copy of cross-chain infrastructure)
        // Created only when hub DB credentials are provided. Indexer queries price_snapshots,
        // oracle_prices, stakes, delegations, and validator_rewards from this connection.
        if(this.hubDbHost && this.hubDbName){
            this.hubDb = new database(this.hubDbHost, this.hubDbPort, this.hubDbName, this.hubDbUser, this.hubDbPass, this);

            // Optional: subscribe to the hub's WebSocket channel to keep the local hub DB in sync
            // with new price_snapshots and oracle_prices rows. Used in distributed deployments where
            // the indexer is on a different host from the hub. For single-host deployments, the
            // local hub DB is the hub's MariaDB itself, so sync is not needed.
            // Enable by setting HUB_DB_SYNC_ENABLED=true (default off).
            if(process.env.HUB_DB_SYNC_ENABLED === 'true'){
                this.hubDbSync = new HubDbSync(this.hubDb, {
                    coin: this.config['COIN'],
                    //  signed retractions: keys the RETRACTION_SIGNING flag-day
                    // and SWQ activation for quorum-class retraction verification.
                    network: this.config['NETWORK'],
                    // Receive-side retraction authority for our own chain :
                    // the mirror refuses hub-broadcast reorg retractions of THIS
                    // chain's rows unless their generation fence is below our own
                    // push_generations value, i.e. a rollback we actually performed.
                    getOwnRollbackGeneration: () => this.indexerDb.getPushGeneration(this.config['COIN'])
                });
                // NOTE: do NOT start() here. The hub-mirror tables (price_snapshots,
                // oracle_prices, cross_chain_*, capability_snapshots, state_checkpoints)
                // are not created until verifyTables() runs further below. Starting the
                // bootstrap before those tables exist races their creation: the bootstrap's
                // SHOW COLUMNS probe comes back empty (doQuery swallows the missing-table
                // 1146 for non-transactional reads and returns []), the mirror silently
                // no-ops every row, and the BTC-only price-sync barrier defers every block
                // until a process restart (prod rollout attempt 2026-06-17). Started below,
                // after verifyTables()/runMigrations() guarantee the tables exist.
            }
        } else {
            // No hub DB credentials supplied. Hub-owned tables (price_snapshots, oracle_prices,
            // stakes, delegations, validator_rewards) will be read from the indexer's own DB.
            // Correct for single-host deployments (the local DB holds the synced hub copy), but
            // indistinguishable from a distributed/validator node where HUB_DB_HOST / HUB_DB_NAME
            // were simply forgotten. In that misconfig the node values native-coin fees against
            // stale/empty local price data, which on mainnet is a consensus-divergence hazard.
            //
            // Fail closed on mainnet: require an explicit acknowledgment that a local price source
            // is intended (single-host) before booting. This mirrors the INDEXER_ALLOW_UNAUTHENTICATED
            // escape hatch in api.js. testnet/regtest keep the non-fatal warning, since single-host
            // is the norm there and there is no canonical fleet to diverge from.
            let allowLocal = process.env.INDEXER_ALLOW_LOCAL_PRICE_SOURCE === 'true';
            if(this.config['NETWORK'] === 'mainnet' && !allowLocal){
                this.util.throwError('HUB_DB_HOST / HUB_DB_NAME are not set on a mainnet node. Native-coin ' +
                    'fee validation and price reads would fall back to the local indexer DB, which on a ' +
                    'distributed node means stale/empty price data and consensus divergence. Set ' +
                    'HUB_DB_HOST / HUB_DB_NAME for a distributed deployment, or set ' +
                    'INDEXER_ALLOW_LOCAL_PRICE_SOURCE=true to confirm an intentional single-host node ' +
                    '(local DB holds the synced hub copy).');
            }
            if(allowLocal){
                console.log('Hub DB not set; local price source acknowledged via INDEXER_ALLOW_LOCAL_PRICE_SOURCE. ' +
                    'Hub-owned price/oracle tables will be read from the local indexer DB (single-host mode).');
            } else {
                console.warn('WARNING: HUB_DB_HOST / HUB_DB_NAME not set. Hub-owned price/oracle tables ' +
                    'will be read from the local indexer DB. Expected for single-host setups; on a distributed ' +
                    'node this indicates a hub DB misconfiguration and fee/price data may be stale or absent. ' +
                    'Set INDEXER_ALLOW_LOCAL_PRICE_SOURCE=true to acknowledge an intentional single-host node.');
            }
        }

        // Create instance of the protocol changes class
        this.protocolChanges = new changes(this);

        // Create instance of the mapper class
        this.mapper = new mapper(this);

        // Create xchain-utxo-tracker client (used by DISPENSER fresh-address check)
        this.utxoTracker = new UtxoTracker(this.utxoTrackerUrl, this.utxoTrackerPort);
        if(!this.utxoTracker.enabled)
            console.log('WARNING: UTXO_TRACKER_URL / UTXO_TRACKER_API_PORT not set. DISPENSER fresh-address check will reject all non-owner dispensers');

        // Create instance of the actions class and pass database connection instances to it
        this.actions = new actions(this);

        // Genesis ledger bootstrap (Counterparty/Dogeparty name-ownership injection at the
        // configured genesis block; no-op when GENESIS_BLOCK is unset). See genesis.js.
        this.genesis = new Genesis(this.actions, this.indexerDb, this.config, this.util);

        // Create instance of the rollback class and pass database connection instances to it
        this.rollback = new rollback(this);

        // Verify the Decoder database exists
        let decoderDbStatus   = await this.decoderDb.createDatabase();
        let decoderDbVerified = await this.decoderDb.verifyDatabase();
        if(!decoderDbVerified)
            this.util.throwError("Database " + this.decoderDbName + " doesn't exist!");

        // Check that the decoder's schema_migrations ledger exists and has at least one
        // applied migration. A missing ledger means the decoder has never fully started
        // (tables are absent), and a missing transactions table means it hasn't finished
        // its first boot. Either condition produces opaque per-block JOIN errors without
        // this check. Log a clear diagnostic so a partially-upgraded or race-start deploy
        // is distinguishable from a real fault.
        try {
            let migRows = await this.decoderDb.doQuery(
                "SELECT COUNT(*) AS cnt FROM information_schema.tables " +
                "WHERE table_schema = ? AND table_name = 'schema_migrations'",
                [this.decoderDbName]
            );
            if(!migRows || migRows[0].cnt === 0){
                console.warn('Decoder DB ' + this.decoderDbName + ': schema_migrations table not found. ' +
                    'Decoder has not completed first boot. Block processing will retry until decoder is ready.');
            } else {
                let txRows = await this.decoderDb.doQuery(
                    "SELECT COUNT(*) AS cnt FROM information_schema.tables " +
                    "WHERE table_schema = ? AND table_name = 'transactions'",
                    [this.decoderDbName]
                );
                if(!txRows || txRows[0].cnt === 0){
                    console.warn('Decoder DB ' + this.decoderDbName + ': transactions table not found. ' +
                        'Decoder schema may be partially applied. Block processing will retry until decoder is ready.');
                }
            }
        } catch(e){
            console.warn('Decoder DB ' + this.decoderDbName + ': schema check failed (non-fatal):', e.message);
        }

        // Verify the Indexer database exists
        let indexerDbStatus   = await this.indexerDb.createDatabase();
        let indexerDbVerified = await this.indexerDb.verifyDatabase();
        if(!indexerDbVerified){
            this.util.throwError("Database " + this.indexerDbName + " doesn't exist!");
        } else {
            // Verify the Indexer tables exists
            let indexerTablesVerified = await this.indexerDb.verifyTables();
            if(!indexerTablesVerified)
                this.util.throwError("Database " + this.indexerDbName + " tables don't exist!");

            // Apply any pending `auto` schema migrations (additive/idempotent changes the
            // drift reconciler can't make on its own). Manual/destructive migrations stay
            // gated for an explicit operator run (`node src/migrate.js`). Recorded in the
            // schema_migrations ledger, so this is a no-op once applied.
            await this.indexerDb.runMigrations();

            // Invariant probe (#5052/#4844/#5026 arming precondition): the deterministic
            // address/ticker id counter (getNextAddressId = MAX(id)+1) and every wire ^<id>
            // resolution assume every index row carries a non-NULL, rollback-stable block_index.
            // Out-of-band rows (legacy AUTO_INCREMENT, NULL block_index) are invisible to ^id
            // resolution (the resolvers gate on block_index IS NOT NULL) but still inflate the
            // counter and indicate the DB has not been cleanly reindexed. Warn loudly with the
            // count rather than throw, so a mid-migration node is not bricked; pre-launch the
            // clean genesis reindex drives this to zero.
            await this.indexerDb.warnOnOrphanIndexIds();
            // Warn if the reorg cursor is all-legacy (would replay the full decoder reorg history on
            // the next reorg detection - REORG-4). Surfaced, not auto-fixed; operator does a reindex.
            await this.indexerDb.warnOnLegacyReorgCursor();

            // Now that the indexer tables exist (including every hub-mirror table the
            // sync client writes into), start the hub DB sync in the background.
            // Deferred from construction above so the bootstrap never inserts into a
            // not-yet-created mirror table. Failures don't block indexer startup.
            if(this.hubDbSync){
                this.hubDbSync.start().catch(err => {
                    console.warn('HubDbSync: start failed:', err.message);
                });
            }
        }

        // Start the durable hub-push retry queue. Both PRICE hub pushes (v0 round
        // and v1 oracle price) enqueue into pending_hub_pushes on failure so a
        // transient hub outage can't permanently drop the row; this poller drains
        // the queue with exponential backoff. No-op when no hub is configured
        // (nothing ever enqueues in that case).
        this.hubPushQueue = new HubPushQueue(this);
        this.hubPushQueue.start();

        // Start the read-only state_tree_nodes orphan-count metric (observability only; no
        // deletion). Surfaces unbounded COW-node growth so we can measure it before building a
        // safe reclaiming sweep (see stateCommitment.reportOrphanStats for why deletion is deferred).
        this._startStateTreeMetric();

        // Define placeholders for block parsing status
        let firstDecoderBlock     = null;
        let lastIndexerBlock      = null;
        let lastDecoderBlock      = null;

        // Pool-direct view for the reorg-driver's indexerDb reads + the createReorg marker WRITE
        // (REORG-1). These run outside any transaction the driver holds, and getConnection() adopts
        // whatever transactionConnection is open - so during a concurrent public feequote dry-run (an
        // indexerDb transaction held up to 10s that always rolls back) an un-viewed read would see the
        // dry-run's dirty uncommitted state and the createReorg INSERT would be silently discarded when
        // that dry-run rolls back, stranding the reorg. The view draws an independent pooled connection
        // that never adopts a transaction and sees only committed state. apiView may be absent on a
        // minimal test double, so fall back to the raw db.
        let indexerReorgView = (typeof this.indexerDb.apiView === 'function') ? this.indexerDb.apiView() : this.indexerDb;

        // How often the inner catch-up loop re-checks for a mid-catch-up decoder reorg (REORG-6).
        let REORG_RECHECK_BLOCKS = Number(this.config['REORG_RECHECK_BLOCKS']) || 50;

        while (true){

            // Bail out if stop is requested
            if(this.stopFlag)
                break;

            // Fetch EVERY decoder reorg event the indexer has not yet processed (oldest first),
            // not just the latest. getLastProcessedReorgId() is the decoder event id of the most
            // recent reorg the indexer recorded; getReorgsSince() returns all decoder reorgs newer
            // than it. Reorgs are matched by event IDENTITY (the decoder's events.id), NOT by
            // block-height magnitude: heights increase across repeated reorgs, so a height compare
            // silently drops every reorg after the first. Do not re-introduce a height comparison.
            let lastProcessedReorgId = await indexerReorgView.getLastProcessedReorgId();
            let unprocessedReorgs    = await this.decoderDb.getReorgsSince(lastProcessedReorgId);

            // Get last processed block from Indexer and Decoder databases
            lastDecoderBlock       = await this.decoderDb.getBlockIndex('decoder', 'last');
            this.lastDecoderBlock  = lastDecoderBlock;
            lastIndexerBlock       = await indexerReorgView.getBlockIndex('indexer', 'last');

            // Handle block reorgs. When two or more reorgs land between indexer iterations and a
            // newer event is SHALLOWER than an older one, processing only the latest leaves
            // orphaned rows below the older, deeper reorg point (a consensus-divergence and
            // double-count source). So roll back once to the DEEPEST (minimum) block index across
            // every unprocessed reorg, and record each event in id order so the processed-id cursor
            // advances to the newest decoder event. Always record; only roll back if the indexer
            // has already indexed past the deepest reorg block.
            if(unprocessedReorgs.length > 0){
                let minReorgBlock = null;
                for(let reorg of unprocessedReorgs){
                    if(minReorgBlock === null || reorg.block_index < minReorgBlock)
                        minReorgBlock = reorg.block_index;
                }
                console.log("Detected " + unprocessedReorgs.length + " block reorganization(s); deepest at block #", minReorgBlock);
                if(!this.util.isNull(lastIndexerBlock) && lastIndexerBlock >= minReorgBlock){
                    await this.rollback.rollback(minReorgBlock);
                    // Re-read the resume cursor: rollback() deleted every block >=
                    // the reorg point, and lastIndexerBlock was read BEFORE the
                    // rollback. Resuming from the stale pre-rollback tip skips the
                    // new chain's version of the rolled-back range permanently,
                    // observed live as single missing blocks rows after depth-1
                    // reorgs (DOGE mainnet 6241887 et al.), each of which also
                    // silently restarts the ledger/actions/contract hash chains
                    // (getBlockHashes hashes the next block with previous_hash
                    // undefined, which JSON.stringify drops).
                    lastIndexerBlock = await indexerReorgView.getBlockIndex('indexer', 'last');
                }
                // Record the processed-reorg markers ONLY after any rollback has committed.
                // The marker rows advance the processed-id cursor (getLastProcessedReorgId), so
                // writing them before rollback() meant a crash or thrown error inside the rollback
                // window left the cursor advanced and the rollback was never retried, stranding
                // orphaned old-chain rows below minReorgBlock (silent consensus divergence). Writing
                // strictly after the commit keeps the cursor un-advanced on failure, so the same
                // reorg is re-detected and retried on the next pass; the retry is idempotent because
                // the rollback is skipped once lastIndexerBlock has dropped below minReorgBlock.
                // Oldest-first so a partial-write crash only advances the cursor as far as is durable.
                for(let reorg of unprocessedReorgs)
                    await indexerReorgView.createReorg(reorg.block_index, reorg.id);

                // Refresh the local cursor to the durable value just advanced by createReorg.
                // lastProcessedReorgId was read once at the top of the outer loop and is never
                // otherwise updated, so the mid-catch-up REORG-6 recheck below would call
                // getReorgsSince() with the stale pre-processing id, re-select the reorg(s) we
                // just recorded (their event ids are all > the stale id), and break to the outer
                // loop once per processed reorg. Re-reading the newest recorded marker id (rather
                // than assuming getReorgsSince ordering) keeps the recheck comparing against the
                // true cursor. This never masks an unprocessed reorg: any reorg with id greater
                // than the refreshed cursor still selects on the next probe.
                lastProcessedReorgId = await indexerReorgView.getLastProcessedReorgId();
            }

            // If indexer has no parsed blocks, set last indexer block to first decoder block-1
            if(this.util.isNull(lastIndexerBlock)){
                firstDecoderBlock = await this.decoderDb.getBlockIndex('decoder', 'first');
                if(!this.util.isNull(firstDecoderBlock))
                    lastIndexerBlock = this.util.bcsub(firstDecoderBlock,1);
            }

            // Print out status message about where parsing is resuming
            if(this.synced === false && !this.util.isNull(lastIndexerBlock)){
                let startBlock = this.util.bcadd(lastIndexerBlock,1)
                if(this.util.bclt(startBlock, lastDecoderBlock))
                    console.log('Resuming block parsing at block ' + startBlock + '...');
            }

            // Loop through blocks until indexer has parsed lastDecoderBlock. The stopFlag check
            // lets stop() take effect at the next block boundary: on a moving decoder tip this
            // inner loop can otherwise run indefinitely (lastDecoderBlock is refreshed per block),
            // so a shutdown request would be deferred until full catch-up. The check sits before
            // beginTransaction, preserving the invariant that an open block transaction is never
            // interrupted mid-flight.
            while( !this.stopFlag && !this.util.isNull(lastIndexerBlock) && !this.util.isNull(lastDecoderBlock) && this.util.bclt(lastIndexerBlock, lastDecoderBlock) ){

                // Set flag to indicate not fully synced
                this.synced = false;

                // Bounded reorg-detection latency during long catch-up (REORG-6). Reorg events are
                // otherwise fetched only at the top of the OUTER loop, and the per-block decoder-tip
                // refresh keeps this inner loop running as long as the tip moves - so a decoder reorg
                // that lands mid-catch-up is not detected until the node is fully caught up, and until
                // then the loop commits hash-chained blocks built on old-chain state (served via
                // getblockhashes / pushed to the hub). Cheaply re-check every REORG_RECHECK_BLOCKS
                // blocks and break to the outer loop, which performs the deepest-rollback + replay.
                // Bounds the mixed-chain window to REORG_RECHECK_BLOCKS instead of the whole backlog;
                // convergence is unchanged (the eventual rollback unwinds every block >= the reorg).
                if((Number(lastIndexerBlock) % REORG_RECHECK_BLOCKS) === 0){
                    let midReorgs = await this.decoderDb.getReorgsSince(lastProcessedReorgId);
                    if(midReorgs.length > 0){
                        console.log('Detected a decoder reorg mid-catch-up; breaking to handle it before block ' + (Number(lastIndexerBlock) + 1));
                        break;
                    }
                }

                // Start tracking time to parse block
                var debugTimer = this.util.startTimer();

                // Determine the next block to parse. Do NOT advance lastIndexerBlock yet:
                // it is only updated after this block commits successfully (below). A failure
                // therefore leaves the counter un-advanced so the same block is retried rather
                // than silently skipped.
                let blockToParse = Number(lastIndexerBlock) + 1;

                // Get a list of any transactions in this block from the decoder database
                let blockTransactions = await this.decoderDb.getDecoderBlockData(blockToParse);

                // Collapse the reader-side per-output fan-out (see src/output_fanout.js).
                // getDecoderBlockData emits one row per stored native-coin output, each carrying
                // the same tx data; without this, a data-bearing action whose transaction also
                // pays a dispenser and/or a fee-destination output would be executed once per
                // output row (duplicate credits/debits). COINPAY payment settlement and empty-data
                // DISPENSE triggers keep their per-output fan-out. Consensus-gated on
                // FIX_OUTPUT_FANOUT; below activation a multi-output data-bearing tx aborts the
                // block loudly (via the watchdog/rollback path) instead of double-executing.
                let fanoutFixActive = await this.protocolChanges.isEnabled('FIX_OUTPUT_FANOUT', blockToParse);
                blockTransactions = collapseOutputFanout(blockTransactions, fanoutFixActive, (m) => this.util.logError(m));

                // Lookup the block time for a given block (read from decoder DB before opening transaction)
                let blockTime = await this.decoderDb.getBlockTime(blockToParse);

                // Price-sync barrier: don't process this block until the local price mirror has
                // caught up to it. Native-coin fee validation reads the latest finalized price
                // round at or before the block height; if two operators hold different sync
                // states they can read different rounds, compute different fee thresholds, and
                // diverge the ledger. Waiting until the mirror covers this block closes that race.
                //
                // Price rounds are anchored to BTC block heights, so this height comparison is
                // only meaningful for a BTC indexer; other chains' block heights are not
                // comparable to the anchor. At/after the NATIVE_FEE_PRICE_TIME_GATE flag-day
                // (H-3), non-BTC chains gate on the time-keyed barrier instead: fee validation
                // there selects rounds by consensus timestamp (db.getLatestPrice selectByTime),
                // so the mirror must hold every round with block_timestamp <= this block's
                // time. Both sides use the same shared predicate so query and barrier can
                // never gate differently. No barrier when hub-db sync is disabled
                // (single-host: the local hub DB is the hub itself, always current).
                if(this.hubDbSync && this.config['COIN'] === 'BTC'){
                    try {
                        await this.hubDbSync.waitForPriceSyncHeight(blockToParse, this.priceSyncTimeoutMs, blockTime);
                    } catch(err){
                        // Defer the block: lastIndexerBlock is not advanced, so the outer loop
                        // retries this same block after the sleep interval rather than processing
                        // it against a stale price copy. No transaction is open yet.
                        console.warn('Deferring block ' + blockToParse + ' (price sync): ', err);
                        this.stallReason = 'price_sync_barrier';
                        break;
                    }
                } else if(this.hubDbSync &&
                          changes.isNativeFeePriceTimeGateActive(this.config['NETWORK'], blockTime)){
                    try {
                        await this.hubDbSync.waitForPriceSyncTime(blockTime, this.priceSyncTimeoutMs);
                    } catch(err){
                        // Same defer semantics as the height barrier above.
                        console.warn('Deferring block ' + blockToParse + ' (price time-sync): ', err);
                        this.stallReason = 'price_sync_barrier';
                        break;
                    }
                }

                // Oracle-price sync barrier (ALL chains): FIAT dispenser settlement
                // (reverseOraclePriceMatch) reads oracle_prices gated by effective_at <= blockTime.
                // If two distributed indexers enter this block with different oracle_prices mirror
                // states they can settle the same FIAT dispenser at different amounts and silently
                // fork the ledger. Wait until the local oracle mirror holds every price effective
                // at or before this block's time. Oracle prices are keyed by wall-clock effective_at
                // (not BTC height), so unlike the price barrier this applies on every chain. The
                // barrier is a no-op when sync is disabled or the mirror holds no oracle prices at
                // all (deployments without FIAT oracles), so non-oracle chains never stall on it.
                if(this.hubDbSync){
                    try {
                        await this.hubDbSync.waitForOracleSyncTimestamp(blockTime, this.priceSyncTimeoutMs);
                    } catch(err){
                        // Defer the block (same retry semantics as the price barrier above): the
                        // counter is not advanced, so this block is retried rather than settled
                        // against a stale oracle copy. No transaction is open yet.
                        console.warn('Deferring block ' + blockToParse + ' (oracle sync): ', err);
                        this.stallReason = 'oracle_sync_barrier';
                        break;
                    }
                }

                // Cross-chain match sync barrier: wait until the local cross_chain_matches
                // mirror has caught up to this block's time, so every operator of this chain
                // settles the same cross-chain matches at the same block. No-op when sync is
                // disabled or the mirror holds no cross-chain matches.
                if(this.hubDbSync){
                    try {
                        await this.hubDbSync.waitForMatchSync(blockTime, this.priceSyncTimeoutMs);
                    } catch(err){
                        console.warn('Deferring block ' + blockToParse + ' (cross-chain match sync): ', err);
                        this.stallReason = 'match_sync_barrier';
                        break;
                    }
                }

                // Cross-chain call sync barrier: wait until the local cross_chain_calls
                // mirror has caught up to this block's time, so every operator of this chain
                // injects/delivers the same cross-chain calls at the same block. No-op when
                // sync is disabled or the mirror holds no relay rows.
                if(this.hubDbSync){
                    try {
                        await this.hubDbSync.waitForCallSync(blockTime, this.priceSyncTimeoutMs);
                    } catch(err){
                        console.warn('Deferring block ' + blockToParse + ' (cross-chain call sync): ', err);
                        this.stallReason = 'call_sync_barrier';
                        break;
                    }
                }

                // Direct-hub-DB call-presence barrier: the sync barriers above only run with a
                // HubDbSync mirror. In single-host / direct-hub-DB mode (hubDb set, no sync) the
                // indexer reads the hub's MariaDB directly, but "the hub DB is current" does NOT
                // mean a relay row was PRESENT when this block was processed. The hub finalizes a
                // cross_chain_calls row at wall-clock ~= its effective_time minus the relay margin;
                // a node whose tip already sits at that block can pass it before the write lands,
                // injecting the execution/callback a block late, landing the synthetic action in a
                // different block than a node that saw the row on time (a real content divergence /
                // ledger fork). The request_id/call_id preimages no longer bind action_index (see
                // attest.js/xcall.js EMITTER_PATH), but the block an injection lands in still must
                // agree. Block until the local hub mirror covers block_time (its highest finalized
                // effective_time >= block_time) before processCrossChainCalls reads the table; a
                // lagging mirror defers-and-retries (the barrier throws on timeout) so this node
                // never injects a partial call set, while the already-current single-shared-DB
                // (regtest) case clears on the first query with no added latency.
                if(!this.hubDbSync && this.hubDb){
                    try {
                        await this._waitForDirectCallPresence(blockTime);
                    } catch(err){
                        console.warn('Deferring block ' + blockToParse + ' (direct call-presence barrier): ', err);
                        this.stallReason = 'call_presence_barrier';
                        break;
                    }
                }

                // Cross-chain capability-snapshot barrier: wait until the capability snapshot
                // for every effective cross-chain match AND call relay row has mirrored in, so
                // neither is ever skipped (and applied later at a per-operator-variable height)
                // for a missing snapshot. Defers the block on timeout, same as the barriers above.
                if(this.hubDbSync){
                    try {
                        await this.hubDbSync.waitForSnapshotSync(blockTime, this.priceSyncTimeoutMs);
                    } catch(err){
                        console.warn('Deferring block ' + blockToParse + ' (cross-chain snapshot sync): ', err);
                        this.stallReason = 'snapshot_sync_barrier';
                        break;
                    }
                }

                // Begin a transaction: all indexer DB writes for this block are atomic.
                await this.indexerDb.beginTransaction();
                // Record the block being processed so createAddress/createTicker stamp
                // index_addresses/index_tickers.block_index with the block at which each
                // id is first assigned (used by rollback to delete + deterministically
                // reassign ids on reorg, keeping wire ^<id> references fork-safe).
                this.indexerDb.blockIndex = blockToParse;
                // Mark that deterministic, block-stamped id assignment has begun. The
                // out-of-band createAddress/createTicker branch (NULL block_index, legacy
                // AUTO_INCREMENT) warns if it ever runs after this point, since an out-of-band
                // insert would bump MAX(id) and silently offset the dense counter (#5052).
                this.indexerDb.deterministicIndexingStarted = true;
                // Light-client state commitment (SPV spec §4): when active, install a
                // fresh per-block touched-key set so the ledger choke point
                // (db.createLedgerChangeRecord) records every (address, tick) mutated
                // this block; cleared/null when inactive so the hook is inert.
                let stateCommitActive = stateCommitAct.isStateCommitmentActive(blockToParse, this.config['NETWORK'], this.config['COIN']);
                this.indexerDb._smtTouched = stateCommitActive ? new Set() : null;
                // Install a fresh per-block staged-hub-push buffer. PRICE actions write their hub
                // push durably inside this transaction (enqueueHubPushTx) and stage the row here for
                // an immediate post-commit live delivery. Replaced each block, so a rolled-back
                // block's staged (and rolled-back) rows are simply discarded, never delivered.
                this.indexerDb._stagedHubPushes = [];
                try {

                    // Fence the block's writes to THIS transaction's epoch (M-16). Read the
                    // epoch that beginTransaction just assigned, then run all block processing
                    // under it (runInTxEpoch) so every DB write it issues carries this epoch.
                    // If the watchdog below fires, the outer catch rolls back and bumps the
                    // epoch; the abandoned promise (which may still resume and try to write on
                    // the shared connection now owned by a later block) then carries a stale
                    // epoch and is rejected inside the db layer before touching the driver.
                    let txEpoch = this.indexerDb.currentTxEpoch();

                    // Process the block with a watchdog timeout to detect deadlocks or infinite loops
                    let blockProcessing = this.indexerDb.runInTxEpoch(txEpoch, async () => {

                        // Initialize VM compilation cache for this block
                        if(this.actions.vm)
                            this.actions.vm.beginBlock();

                        // Genesis ledger bootstrap: at the configured genesis block, inject the
                        // Counterparty/Dogeparty name-ownership ISSUE/TRANSFER actions BEFORE any
                        // real transaction, so they take the lowest action indexes in the block.
                        // No-op on every other block. See genesis.js.
                        await this.genesis.inject(blockToParse, blockTime);

                        // Loop through any block transactions and process them
                        for(const tx of blockTransactions)
                            await this.actions.processTransaction(tx);

                        // Check for any expired items (orders, swaps, dispensers)
                        await this.util.processExpirations(this.actions, this.indexerDb, blockToParse, blockTime);

                        // Settle this chain's leg of any effective cross-chain DEX matches
                        // (validator-signed, mirror-delivered; verified inside CROSS_SETTLE)
                        await this.util.processCrossChainSettlements(this.actions, this.indexerDb, blockToParse, blockTime);

                        // Cross-chain contract calls: inject executions for dispatches
                        // targeting this chain, deliver result callbacks for requests it
                        // originated, and expire requests past their deadline (all
                        // validator-signed / block-height-deterministic; see
                        // utility.processCrossChainCalls)
                        await this.util.processCrossChainCalls(this.actions, this.indexerDb, blockToParse, blockTime);

                        // Check for any cancelled items (dispensers)
                        await this.util.processCancellations(this.actions, this.indexerDb, blockToParse, blockTime);

                        // Check for any attestation requests past their DEADLINE_BLOCK
                        await this.util.processAttestationExpirations(this.actions, this.indexerDb, blockToParse, blockTime);

                        // Finalize VOTE polls whose window closed (or that early-decide this block)
                        await this.util.processVoteFinalizations(this.actions, this.indexerDb, blockToParse, blockTime);

                        // Release tokens for unstakes (capability + contract) past their cooldown
                        await this.util.processCooldownCompletions(this.actions, this.indexerDb, blockToParse);

                        // Clear VM compilation cache for this block
                        if(this.actions.vm)
                            this.actions.vm.endBlock();

                        // Create record in `blocks` table with hashes of the credits/debits/escrows (ledger) and /actions tables
                        let [ledger, actions, contracts] = await this.indexerDb.createBlock(blockToParse, blockTime);

                        // Create / Update DEX market information
                        await this.util.processMarketUpdates(this.indexerDb, blockToParse, blockTime);

                        // Do a sanity check to verify that token supplies match data in credits/debits/escrows/balances tables
                        await this.indexerDb.sanityCheck(blockToParse);

                        // Light-client state commitment (SPV spec §4/§5): compute + persist
                        // the additive state_root + block_merkle_root atomically with the
                        // block, after sanityCheck and before commit. Gated by the flag-day;
                        // a throw here rolls the whole block back like any other failure.
                        if(stateCommitActive){
                            let isActivation = stateCommitAct.isStateCommitmentActivationBlock(blockToParse, this.config['NETWORK'], this.config['COIN']);
                            await stateCommitment.computeAndStoreRoots(this.indexerDb, this.config['COIN'], this.config['NETWORK'], blockToParse, isActivation);
                        }

                        return [ledger, actions, contracts];
                    });

                    // Watchdog-timeout safety (M-16). If the watchdog rejects below, we stop
                    // awaiting blockProcessing but the promise stays pending and may settle
                    // later (typically the epoch fence rejecting a zombie write, or the block
                    // finally finishing). Attach a swallow handler so that late settlement can
                    // never surface as an unhandledRejection that crashes the process. The
                    // epoch fence, not this handler, is what prevents the zombie's writes from
                    // landing; this only keeps the abandoned promise's rejection quiet.
                    blockProcessing.catch((e) => {
                        console.warn('Abandoned block-processing promise for block ' + blockToParse +
                            ' settled after watchdog: ' + (e && e.message ? e.message : e));
                    });

                    // The genesis block does far more than a normal block, so it gets its own
                    // watchdog. The budget follows the PATH it will take (see genesis.inject):
                    // importing the precomputed dump finishes in seconds, so it uses the tight
                    // GENESIS_DUMP_TIMEOUT_MS; only the CSV re-derivation fallback (~1-2h) needs
                    // the generous GENESIS_BLOCK_TIMEOUT_MS. This keeps a tight liveness signal on
                    // the normal (dump) path without false-tripping a no-dump node.
                    let isGenesisBlock = Number(blockToParse) === Number(this.config['GENESIS_BLOCK']) && this.config['GENESIS_BLOCK'];
                    let blockTimeout   = this.config['BLOCK_PROCESS_TIMEOUT'];
                    if(isGenesisBlock){
                        let dumpPath = this.config['GENESIS_DUMP_PATH'];
                        blockTimeout = (dumpPath && fs.existsSync(dumpPath))
                            ? this.config['GENESIS_DUMP_TIMEOUT_MS']
                            : this.config['GENESIS_BLOCK_TIMEOUT_MS'];
                    }
                    let [ledger, actions, contracts] = await this.util.withTimeout(blockProcessing, blockTimeout, 'block ' + blockToParse);

                    // Commit the block data to the database
                    await this.indexerDb.commitTransaction();

                    // Block committed successfully. Only now advance the counter. Doing this
                    // after the commit (rather than before the try) ensures a failed block leaves
                    // lastIndexerBlock un-advanced so it is retried instead of skipped.
                    lastIndexerBlock = blockToParse;

                    // A block advanced, so we are no longer stalled. Clear any deferral
                    // reason set by a barrier timeout or host fault on a prior iteration.
                    this.stallReason = null;

                    // Log the total parse time for this block
                    let parseTime = this.util.getTimer(debugTimer);
                    console.log('Block Parsed' + "\t: " + lastIndexerBlock + ' [ledger:' + ledger + ' actions:' + actions + ' contracts:' + contracts + '] (' + parseTime + ')');

                    // Push chain tip to hub (fire-and-forget; never blocks indexing).
                    // Network is included so multi-network hubs scope tips correctly
                    // (older hubs ignore it; pre-network-aware behavior = 'mainnet').
                    // Skip while catching up: during a bulk re-index, pushing a tip for every
                    // historical block floods the hub's proxy / rate-limiter (HTTP 429) for no
                    // value. The hub only wants the live tip. Only push within
                    // CHAIN_TIP_PUSH_MAX_LAG blocks of the decoder tip (lastDecoderBlock here is
                    // the prior iteration's value, i.e. at most one block stale, which is fine).
                    if(!this.util.bcgt(this.util.bcsub(lastDecoderBlock, lastIndexerBlock), this.config['CHAIN_TIP_PUSH_MAX_LAG'])){
                        this.hubClient.pushChainTip(this.config['COIN'], this.config['NETWORK'], lastIndexerBlock, blockTime);
                    }

                    // Deliver the PRICE hub pushes durably staged inside the just-committed block
                    // transaction (mirrors rollback.js's post-commit retraction delivery). Each row
                    // already survives a crash here (HubPushQueue drains the survivors on restart);
                    // this is only an immediate live-delivery fast path that drops the durable row on
                    // success and leaves it for the queue on any failure. Best-effort and never throws
                    // into the block loop.
                    await this._deliverStagedHubPushes();

                    // Refresh the decoder tip after each committed block. Without this the
                    // decoder tip is snapshotted once per outer-loop iteration and stays frozen
                    // for the whole catch-up, so reported lag (decoderBlock - indexerBlock) shrinks
                    // to zero as the indexer advances even while the decoder is still moving ahead.
                    // Re-reading keeps the value live, so the /status, getlatestblock(), and health()
                    // surfaces, plus the synced check below, which compares against this same
                    // variable, reflect the true decoder tip throughout catch-up rather than a
                    // false all-clear. An indexed last-block lookup is cheap enough to do per block.
                    lastDecoderBlock      = await this.decoderDb.getBlockIndex('decoder', 'last');
                    this.lastDecoderBlock = lastDecoderBlock;

                } catch(error){
                    // Roll back all writes for this block so the DB stays at the end of the previous block
                    await this.indexerDb.rollbackTransaction();

                    // Host fault (out-of-process VM executor cannot run a contract on THIS
                    // machine: fork EAGAIN, isolated-vm load failure). This is NOT a contract
                    // outcome. Committing a fabricated out_of_resource for work the fleet runs
                    // normally would diverge this node's contract_hash and fork it off the chain.
                    // So we HALT (do not advance) rather than fabricate: the block is left
                    // uncommitted and retried below. A transient fault self-heals on the next
                    // retry (the executor probes a fresh worker); a persistent one keeps the
                    // indexer halted + alerting until the operator fixes the host. The block
                    // watchdog surfaces the stall (no silent freeze).
                    if(error && error.code === 'EXECUTOR_UNAVAILABLE'){
                        console.error(`HOST FAULT at block ${lastIndexerBlock}: VM executor unavailable. ` +
                            `HALTING block processing (not committing; a fabricated result would fork). ` +
                            `Retrying after ${this.config['BLOCK_CHECK_INTERVAL']}ms; will resume when the host recovers.`);
                        this.stallReason = 'vm_executor_unavailable';
                    } else {
                        // Log the error
                        this.util.logError(`Error while parsing block data at block ${lastIndexerBlock}:`, error);
                    }

                    // Exit the inner catch-up loop on failure. lastIndexerBlock was not advanced
                    // (the assignment above only runs after a successful commit), so the outer loop
                    // re-fetches it from the DB and retries this same block after the sleep interval,
                    // instead of falling through and silently skipping the failed block.
                    break;
                }

            }

            // Set flag to indicate fully synced and listening for block
            if(!this.synced && !this.util.bclt(lastIndexerBlock, lastDecoderBlock)){
                this.synced = true;
                console.log('Listening for blocks...');
            }

            // Sleep for BLOCK_CHECK_INTERVAL before checking for new transaction data
            await this.util.sleep(this.config['BLOCK_CHECK_INTERVAL']);
        }
    }

    // Fetch operational params from the hub and shallow-merge them over the local coin config.
    // Called once at startup. Best-effort: logs a warning and returns without modifying config
    // if the hub is unreachable or returns an unexpected response.
    async _applyHubConfigOverlay(){
        if(!this.hubClient || !this.hubClient.enabled) return;
        try {
            let { ok, configs, seq, watermark, coinConsensusHashes } = this._unwrapHubConfigResponse(await this.hubClient._call('getallconfigs', {}));
            if(!ok){
                console.warn('XChainIndexer: hub config overlay skipped, hub returned no usable config (using local defaults)');
                return;
            }
            this._checkHubConsensusHash(coinConsensusHashes);
            this._mergeHubParams(configs);
            this.lastHubConfigSeq = seq;
            this.lastHubConfigWatermark = watermark;
            this.lastHubConfigFetchAt = Date.now();
        } catch(err) {
            console.warn('XChainIndexer: hub config overlay failed, using local defaults:', err);
        }
    }

    // Transport-integrity check: compare the hub's served consensus-config hash for
    // this coin/network against our OWN bundled hash. A mismatch means the hub would
    // serve divergent consensus values; we never apply consensus params from the hub
    // (the pinned-verify-only class below), so this only logs, but it surfaces a hub
    // that is out of sync with this node's pinned bundle so an operator can upgrade.
    _checkHubConsensusHash(coinConsensusHashes){
        if(!coinConsensusHashes) return; // older hub: field absent, nothing to compare
        let coin = this.config.COIN, network = this.config.NETWORK;
        let hubHash = coinConsensusHashes[network] && coinConsensusHashes[network][coin];
        if(!hubHash) return;
        let localHash = require('./coins').consensusHash(coin, network);
        if(hubHash !== localHash)
            console.error('CONSENSUS HASH MISMATCH: hub serves ' + hubHash + ' for ' + coin + '/' + network +
                ' but this node bundles ' + localHash + '. The hub config diverges from this node; not applying hub consensus values (they are pinned-verify-only). Upgrade the lagging side.');
    }

    // Normalize the getallconfigs response across hub versions. Newer hubs wrap the
    // config map as { configs, seq, watermark } so consumers can detect a config change
    // committed between polls; older hubs return the bare nested map. Returns
    // { configs, seq, watermark } each defaulting to 0 (treated as "no committed change
    // seen" by the poll loop). seq only advances on PBFT-committed changes, so a
    // standalone/config-oracle hub (no consensus) never bumps it; watermark
    // (MAX(updated_at) over configs) advances on ANY config write, so both signals must
    // be honored or a non-consensus hub's committed changes are never re-applied live.
    _unwrapHubConfigResponse(response){
        if(response && typeof response === 'object' && response.configs && typeof response.configs === 'object' && ('seq' in response)){
            return { ok: true, configs: response.configs, seq: Number(response.seq) || 0, watermark: Number(response.watermark) || 0, coinConsensusHashes: response.coin_consensus_hashes || null };
        }
        // Failed fetch: the hub returned nothing, a non-object, or an HTTP-200 { error: ... }
        // envelope. getallconfigs signals a config-DB read failure as a JSON-RPC *result*
        // (not a JSON-RPC error), so _call resolves rather than throwing. Report ok:false so
        // callers do NOT refresh lastHubConfigFetchAt on it, keeping the staleness health
        // signal honest instead of masking a frozen-config hub.
        if(!response || typeof response !== 'object' || response.error){
            return { ok: false, configs: {}, seq: 0, watermark: 0, coinConsensusHashes: null };
        }
        // Older hub: bare nested config map without the { configs, seq, watermark } wrapper.
        return { ok: true, configs: response, seq: 0, watermark: 0, coinConsensusHashes: null };
    }

    // Shallow-merge the hub's operational params for this coin/network over the live
    // config object. Mutating this.config in place is what lets a re-applied overlay
    // take effect without a process restart.
    _mergeHubParams(allConfigs){
        // THREE-WAY CONFIG CLASSIFIER (see the platform consolidation plan):
        //   1. pinned-verify-only - consensus-critical coin params (gas schedule, staking,
        //      fee math, addresses, genesis, byte-prefixes). NEVER applied from the hub;
        //      the hub serves them only for the transport-integrity hash check
        //      (_checkHubConsensusHash). They live solely in the bundled canonical coin
        //      files (src/coins) and are pin-verified at boot (verifyConsensusPin).
        //   2. live-apply - display/connection params, safe to merge live. Listed below.
        //   3. governance-activated - operationally-mutable consensus params, selected by a
        //      protocol-agreed activation height (NOT a live poll); none wired yet.
        //
        // CONSENSUS RULE: any param whose value feeds block-hashed state must NOT appear in
        // these lists. The overlay applies a committed hub change the moment a node observes
        // it, which happens at different wall-clock times (hence different block heights)
        // across the federation. Live-polling a consensus param would let two nodes process
        // the same on-chain transaction with different values and produce divergent
        // block-hashed rows (a soft fork). Such values come solely from the per-chain local
        // defaults (configs/BTC.js, LTC.js, DOGE.js) and may change only via a coordinated
        // node upgrade; any future governance path must gate the switch on a protocol-agreed
        // activation block height, not a live poll.
        //
        // Deliberately EXCLUDED for this reason:
        //   - GAS_SCHEDULE / GAS_PRICE: feed contract_executions fee math and block hashes.
        //   - ACTIVATION_DELAY_BLOCKS: stake/delegation activation_block (actions/stake.js,
        //                              delegate.js, unstake.js) is BLOCK_INDEX + this value.
        //   - EXPIRATION_FEE_PER_DAY: ORDER/SWAP/DISPENSER expiration fee debited from
        //                             balance rows (utility.js getExpirationFee).
        //   - STAKING: carries ACTIVATION_DELAY_BLOCKS, COOLDOWN_BLOCKS, and
        //              per-capability MIN_STAKE, all of which gate consensus
        //              acceptance and the activation/deactivation_block math.
        //
        // The lists below are intentionally empty: every hub param currently classified for this
        // coin/network feeds consensus, so none may be live-polled. Add a key here ONLY after
        // confirming it is tunable/display-only and never reaches block-hashed state.
        const SCALAR_PARAMS = [];
        const BLOB_PARAMS   = [];

        let coin    = this.config.COIN;
        let network = this.config.NETWORK;
        let hubParams = (allConfigs && allConfigs[coin] && allConfigs[coin][network] && allConfigs[coin][network]['xchain-indexer']) || {};

        for(let key of SCALAR_PARAMS){
            let val = hubParams[key];
            if(val === undefined || val === null) continue;
            this.config[key] = val;
        }

        for(let key of BLOB_PARAMS){
            let val = hubParams[key];
            if(val === undefined || val === null) continue;
            if(typeof val === 'string' && (val.charAt(0) === '{' || val.charAt(0) === '[')){
                try {
                    this.config[key] = JSON.parse(val);
                } catch(e) {
                    console.warn('XChainIndexer: failed to JSON-parse hub param ' + key + ':', e);
                }
            } else if(typeof val === 'object'){
                this.config[key] = val;
            }
        }
    }

    // Poll the hub for PBFT-committed config changes. The startup overlay runs only
    // once; without this loop a governance-committed change to a tunable/display param
    // (i.e. one safe to live-poll; see the consensus exclusion list in _mergeHubParams)
    // would not take effect until the indexer process is restarted. We
    // re-apply the overlay only when the hub's committed sequence advances past the
    // last one we applied, so a steady-state poll is a cheap no-op. Against an older
    // hub that returns the bare map, seq stays 0 and the overlay is never re-applied
    // (matching pre-existing startup-only behavior). The timer is unref'd so it never
    // keeps the process alive. Interval is HUB_CONFIG_POLL_INTERVAL_MS (default 60s).
    _startHubConfigPolling(){
        if(!this.hubClient || !this.hubClient.enabled) return;
        if(this._hubConfigPollTimer) return;
        const intervalMs = parseInt(process.env.HUB_CONFIG_POLL_INTERVAL_MS, 10) || 60000;
        // Guarded against self-overlap like _startStateTreeMetric below (#2247): a
        // getallconfigs call outrunning the interval (restarting/partitioned hub)
        // must not stack overlapping in-flight polls.
        this._hubConfigPollRunning = false;
        this._hubConfigPollTimer = setInterval(async () => {
            if(this._hubConfigPollRunning) return;   // a prior slow poll is still in flight
            this._hubConfigPollRunning = true;
            try {
                let { ok, configs, seq, watermark, coinConsensusHashes } = this._unwrapHubConfigResponse(await this.hubClient._call('getallconfigs', {}));
                // A usable envelope (not a { error: ... } failure result) means the hub
                // actually answered with config. A failed fetch must NOT refresh the freshness
                // signal, or a persistently config-DB-failing hub reports healthy while the
                // live-polled params are frozen.
                if(!ok){
                    console.warn('XChainIndexer: hub config poll returned no usable config; not refreshing freshness signal');
                    return;
                }
                // Re-check hub/node consensus-config drift on every poll (not only at startup),
                // so a mid-run hub upgrade/downgrade to a divergent bundle is surfaced live.
                // The check is log-only / pinned-verify-only and cannot affect consensus.
                this._checkHubConsensusHash(coinConsensusHashes);
                // Record the fetch time even when seq is unchanged, since the freshness of the
                // live-polled params is what the health/status age signal reports, not whether
                // they happened to change.
                this.lastHubConfigFetchAt = Date.now();
                // Re-apply on EITHER signal advancing: seq (PBFT-committed) OR watermark
                // (any config write, incl. a standalone/config-oracle hub with no consensus).
                // Older hubs omit watermark -> it defaults to 0 and never advances, so this
                // stays back-compatible with a seq-only hub.
                //
                // Same-second redelivery: the hub reads its config watermark BEFORE the rows
                // (xchain-hub api.js/db.js getConfigWatermark), so a write committed after the
                // watermark read but stamped in the SAME epoch-second is carried in the full
                // config tree while the watermark it reports stays equal. A strict `>` gate
                // would skip that row forever on a hub whose PBFT seq never advances (a
                // standalone/config-oracle hub, seq stuck at 0), acting on stale config with
                // no staleness signal. So an equal NON-ZERO watermark is treated as re-apply-
                // eligible: _mergeHubParams is idempotent, so re-merging the (full) tree is
                // safe. A missing watermark (0) keeps the strict path so a seq-only hub does
                // NOT re-merge every poll. This relies on the full-tree fetch and stays that
                // way: the hub's since_updated_at delta boundary is now inclusive `>=` (hub
                // item #2265), so a new-enough hub no longer drops the same-second row, but
                // an older hub's strict `>` still would - the full-tree fetch is the
                // deployment-skew-proof choice, so do not thread the delta cursor here.
                let seqAdvanced       = seq > (this.lastHubConfigSeq || 0);
                let watermarkAdvanced = watermark > (this.lastHubConfigWatermark || 0);
                let watermarkRedeliver = watermark > 0 && watermark === (this.lastHubConfigWatermark || 0);
                if(seqAdvanced || watermarkAdvanced || watermarkRedeliver){
                    this._mergeHubParams(configs);
                    this.lastHubConfigSeq = Math.max(seq, this.lastHubConfigSeq || 0);
                    this.lastHubConfigWatermark = Math.max(watermark, this.lastHubConfigWatermark || 0);
                    // Only announce an actual advance; an equal-watermark redelivery re-merge
                    // is a steady-state no-op on a watermark-bearing hub and must not log-spam.
                    if(seqAdvanced || watermarkAdvanced)
                        console.log('XChainIndexer: applied hub config update (committed seq ' + seq + ', watermark ' + watermark + ')');
                }
            } catch(err) {
                console.warn('XChainIndexer: hub config poll failed, keeping current config:', err.message || err);
            } finally {
                this._hubConfigPollRunning = false;
            }
        }, intervalMs);
        if(this._hubConfigPollTimer.unref) this._hubConfigPollTimer.unref();
    }

    // Periodically emit a read-only orphan-count metric for the COW state_tree_nodes store so
    // its unbounded growth is observable (SPV spec §4.3). Runs on an unref'd interval (never holds
    // the process open), guarded against self-overlap, and reads on a POOLED connection so it never
    // touches the block-processing transaction. No deletion: see stateCommitment.reportOrphanStats.
    // Interval STATE_TREE_METRIC_INTERVAL_MS (default 4h; 0 disables).
    _startStateTreeMetric(){
        if(this._stateTreeMetricTimer) return;
        const raw = parseInt(process.env.STATE_TREE_METRIC_INTERVAL_MS, 10);
        const intervalMs = Number.isFinite(raw) ? raw : (4 * 60 * 60 * 1000);
        if(intervalMs === 0) return;   // explicitly disabled
        this._stateTreeMetricRunning = false;
        this._stateTreeMetricTimer = setInterval(async () => {
            if(this._stateTreeMetricRunning) return;   // a prior slow scan is still running
            this._stateTreeMetricRunning = true;
            try {
                const stats = await stateCommitment.reportOrphanStats(
                    (sql, args) => this.indexerDb._poolQuery(sql, args),
                    this.config['COIN'], this.config['NETWORK']);
                if(stats.totalNodes === 0) return;   // pre-activation / empty store: nothing to report
                console.log('[METRIC] ' + JSON.stringify({
                    metric: 'state_tree_orphan_nodes', component: 'indexer',
                    chain: this.config['COIN'], network: this.config['NETWORK'],
                    total_nodes: stats.totalNodes, reachable_nodes: stats.reachableNodes,
                    orphan_count: stats.orphanCount, reachability_skipped: stats.reachabilitySkipped,
                    ts: Date.now()
                }));
            } catch(err) {
                console.warn('XChainIndexer: state_tree orphan-metric failed for ' +
                    this.config['COIN'] + '/' + this.config['NETWORK'] + ':', err.message || err);
            } finally {
                this._stateTreeMetricRunning = false;
            }
        }, intervalMs);
        if(this._stateTreeMetricTimer.unref) this._stateTreeMetricTimer.unref();
        console.log('XChainIndexer: state_tree orphan-metric started (interval ' + intervalMs + 'ms)');
    }

}

module.exports = XChainIndexer;
