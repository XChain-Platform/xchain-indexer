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
const config    = require('./config.js');
const changes   = require('./protocol_changes.js');
const database  = require('./db.js');
const actions   = require('./actions.js');
const util      = require('./utility.js');
const rollback  = require('./rollback.js');
const mapper    = require('./mapper.js');
const HubClient    = require('./hub_client.js');
const HubDbSync    = require('./hub_db_sync.js');
const HubPushQueue = require('./hub_push_queue.js');
const UtxoTracker  = require('./UtxoTracker.js');

class XChainIndexer {

    // Handle constructing a class instance
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
    // callPresenceTimeoutMs). Resolves the instant it is safe to read cross_chain_calls for a
    // block at block_time, so the injection/callback pass sees the same rows a replaying node
    // would:
    //   * Wall-clock gate (no query, the steady-state path): once real time has reached this
    //     block's time, every relay row effective at/before it was finalized at least the relay
    //     margin earlier (effective_time = finalize_time + margin) and is therefore already
    //     written to the shared hub DB. At the live tip block_time ~= now, so this clears within
    //     seconds; on replay block_time is in the past, so it clears immediately.
    //   * Coverage fast-path: for a block whose timestamp is still ahead of wall-clock, proceed
    //     early if the hub DB already holds a finalized row effective at/after it (nothing later
    //     can be missing), or if the table is empty (nothing to wait on).
    //   * Bound: never blocks past callPresenceTimeoutMs, and never throws. A hub that produces
    //     no calls (or is briefly behind) can therefore never stall block processing, matching
    //     the NULL-is-valid / no-freeze semantics of the HubDbSync call barrier. The hub-side
    //     relay margin is the primary fork guard; proceeding here on timeout is the safe fallback.
    async _waitForDirectCallPresence(blockTime){
        blockTime = Number(blockTime);
        if(!this.hubDb || !Number.isFinite(blockTime)) return;
        let timeoutMs = Number(this.callPresenceTimeoutMs);
        if(!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = 10000;
        let deadline = Date.now() + timeoutMs;
        let pollMs = 250;
        while(true){
            // Wall-clock gate: costs no query and is the common (tip + replay) path.
            if(Date.now() >= blockTime * 1000) return;
            // Future-dated block: proceed early if the hub DB already covers it.
            try {
                let rows = await this.hubDb.doQuery(
                    "SELECT MAX(effective_time) AS ts FROM cross_chain_calls WHERE status = 'finalized'");
                if(rows.length === 0 || rows[0].ts === null || Number(rows[0].ts) >= blockTime) return;
            } catch(e){
                // Table not ready / transient error: don't freeze the chain; fall to the timeout.
            }
            if(Date.now() >= deadline) return;
            await this.util.sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
        }
    }

    // Handle starting up the XChain indexer
    async start(){
        console.log('Starting up ' + this.name + ' v' + this.version + '...');

        // Get indexer configuration
        this.config = config.getConfig();

        // Create instance of the utility class
        this.util = new util();

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
                this.hubDbSync = new HubDbSync(this.hubDb, { coin: this.config['COIN'] });
                // Start it in the background; failures don't block indexer startup.
                this.hubDbSync.start().catch(err => {
                    console.warn('HubDbSync: start failed:', err.message);
                });
            }
        } else {
            // No hub DB credentials supplied. Hub-owned tables (price_snapshots, oracle_prices,
            // stakes, delegations, validator_rewards) will be read from the indexer's own DB.
            // Correct for single-host deployments; on a distributed node it means HUB_DB_HOST /
            // HUB_DB_NAME are unset and price/oracle reads will use local (possibly stale) data.
            console.warn('WARNING: HUB_DB_HOST / HUB_DB_NAME not set. Hub-owned price/oracle tables ' +
                'will be read from the local indexer DB. Expected for single-host setups; on a distributed ' +
                'node this indicates a hub DB misconfiguration and fee/price data may be stale or absent.');
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
        }

        // Start the durable hub-push retry queue. Both PRICE hub pushes (v0 round
        // and v1 oracle price) enqueue into pending_hub_pushes on failure so a
        // transient hub outage can't permanently drop the row; this poller drains
        // the queue with exponential backoff. No-op when no hub is configured
        // (nothing ever enqueues in that case).
        this.hubPushQueue = new HubPushQueue(this);
        this.hubPushQueue.start();

        // Define placeholders for block parsing status
        let firstDecoderBlock     = null;
        let lastIndexerBlock      = null;
        let lastDecoderBlock      = null;

        while (true){

            // Bail out if stop is requested
            if(this.stopFlag)
                break;

            // Get the decoder's latest reorg event ({id, block_index}) and the decoder event id
            // the indexer last recorded. Reorgs are matched by event IDENTITY (the decoder's
            // events.id), NOT by block-height magnitude: block heights increase across repeated
            // reorgs, so comparing heights (e.g. `decoder < indexer`) silently drops every reorg
            // after the first. Comparing the decoder event id the indexer already processed
            // against the decoder's current latest reorg id catches each new reorg regardless of
            // its height. Do not re-introduce a block-height comparison here.
            let decoderReorg         = await this.decoderDb.getLatestReorg();
            let lastProcessedReorgId = await this.indexerDb.getLastProcessedReorgId();

            // Get last processed block from Indexer and Decoder databases
            lastDecoderBlock       = await this.decoderDb.getBlockIndex('decoder', 'last');
            this.lastDecoderBlock  = lastDecoderBlock;
            lastIndexerBlock       = await this.indexerDb.getBlockIndex('indexer', 'last');

            // Handle block reorgs: process when the decoder's latest reorg event is one the
            // indexer has not yet recorded (identity check). Always record the reorg, but only
            // roll back if the indexer has already indexed past the reorg block.
            if(!this.util.isNull(decoderReorg) && decoderReorg.id !== lastProcessedReorgId){
                console.log("Detected block reorganization at block #",decoderReorg.block_index);
                await this.indexerDb.createReorg(decoderReorg.block_index, decoderReorg.id);
                if(!this.util.isNull(lastIndexerBlock) && lastIndexerBlock >= decoderReorg.block_index){
                    await this.rollback.rollback(decoderReorg.block_index);
                    // Re-read the resume cursor: rollback() deleted every block >=
                    // the reorg point, and lastIndexerBlock was read BEFORE the
                    // rollback. Resuming from the stale pre-rollback tip skips the
                    // new chain's version of the rolled-back range permanently,
                    // observed live as single missing blocks rows after depth-1
                    // reorgs (DOGE mainnet 6241887 et al.), each of which also
                    // silently restarts the ledger/actions/contract hash chains
                    // (getBlockHashes hashes the next block with previous_hash
                    // undefined, which JSON.stringify drops).
                    lastIndexerBlock = await this.indexerDb.getBlockIndex('indexer', 'last');
                }
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

            // Loop through blocks until indexer has parsed lastDecoderBlock
            while( !this.util.isNull(lastIndexerBlock) && !this.util.isNull(lastDecoderBlock) && this.util.bclt(lastIndexerBlock, lastDecoderBlock) ){

                // Set flag to indicate not fully synced
                this.synced = false;

                // Start tracking time to parse block
                var debugTimer = this.util.startTimer();

                // Determine the next block to parse. Do NOT advance lastIndexerBlock yet:
                // it is only updated after this block commits successfully (below). A failure
                // therefore leaves the counter un-advanced so the same block is retried rather
                // than silently skipped.
                let blockToParse = Number(lastIndexerBlock) + 1;

                // Get a list of any transactions in this block from the decoder database
                let blockTransactions = await this.decoderDb.getDecoderBlockData(blockToParse);

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
                // comparable to the anchor and would never satisfy the barrier (their price
                // freshness is addressed separately). No barrier when hub-db sync is disabled
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
                // agree. Give in-flight hub writes a window to land before processCrossChainCalls
                // reads the table; defer-and-retry on timeout so the quiet/absent-hub case never
                // produces a spuriously empty call set.
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
                try {

                    // Process the block with a watchdog timeout to detect deadlocks or infinite loops
                    let blockProcessing = (async () => {

                        // Initialize VM compilation cache for this block
                        if(this.actions.vm)
                            this.actions.vm.beginBlock();

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

                        // Release tokens for unstakes (capability + contract) past their cooldown
                        await this.util.processCooldownCompletions(this.indexerDb, blockToParse);

                        // Clear VM compilation cache for this block
                        if(this.actions.vm)
                            this.actions.vm.endBlock();

                        // Create record in `blocks` table with hashes of the credits/debits/escrows (ledger) and /actions tables
                        let [ledger, actions, contracts] = await this.indexerDb.createBlock(blockToParse, blockTime);

                        // Create / Update DEX market information
                        await this.util.processMarketUpdates(this.indexerDb, blockToParse, blockTime);

                        // Do a sanity check to verify that token supplies match data in credits/debits/escrows/balances tables
                        await this.indexerDb.sanityCheck(blockToParse);

                        return [ledger, actions, contracts];
                    })();

                    let [ledger, actions, contracts] = await this.util.withTimeout(blockProcessing, this.config['BLOCK_PROCESS_TIMEOUT'], 'block ' + blockToParse);

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
            let { configs, seq } = this._unwrapHubConfigResponse(await this.hubClient._call('getallconfigs', {}));
            this._mergeHubParams(configs);
            this.lastHubConfigSeq = seq;
            this.lastHubConfigFetchAt = Date.now();
        } catch(err) {
            console.warn('XChainIndexer: hub config overlay failed, using local defaults:', err);
        }
    }

    // Normalize the getallconfigs response across hub versions. Newer hubs wrap the
    // config map as { configs, seq } so consumers can detect a config change committed
    // between polls; older hubs return the bare nested map. Returns { configs, seq }
    // with seq defaulting to 0 (treated as "no committed change seen" by the poll loop).
    _unwrapHubConfigResponse(response){
        if(response && typeof response === 'object' && response.configs && typeof response.configs === 'object' && ('seq' in response)){
            return { configs: response.configs, seq: Number(response.seq) || 0 };
        }
        return { configs: response || {}, seq: 0 };
    }

    // Shallow-merge the hub's operational params for this coin/network over the live
    // config object. Mutating this.config in place is what lets a re-applied overlay
    // take effect without a process restart.
    _mergeHubParams(allConfigs){
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
        this._hubConfigPollTimer = setInterval(async () => {
            try {
                let { configs, seq } = this._unwrapHubConfigResponse(await this.hubClient._call('getallconfigs', {}));
                // A response (no throw) means the hub answered. Record the fetch time even when
                // seq is unchanged, since the freshness of the live-polled params is what the
                // health/status age signal reports, not whether they happened to change.
                this.lastHubConfigFetchAt = Date.now();
                if(seq > (this.lastHubConfigSeq || 0)){
                    this._mergeHubParams(configs);
                    this.lastHubConfigSeq = seq;
                    console.log('XChainIndexer: applied hub config update (committed seq ' + seq + ')');
                }
            } catch(err) {
                console.warn('XChainIndexer: hub config poll failed, keeping current config:', err.message || err);
            }
        }, intervalMs);
        if(this._hubConfigPollTimer.unref) this._hubConfigPollTimer.unref();
    }

}

module.exports = XChainIndexer;
