/*********************************************************************
 * 
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 * 
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided “AS IS”, without warranties or conditions of any kind.
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
const HubClient   = require('./hub_client.js');
const HubDbSync   = require('./hub_db_sync.js');
const UtxoTracker = require('./UtxoTracker.js');

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
        this.synced    = false;
        this.stopFlag  = false
        this.blockchainInfoLastBlock = -1

        // Price-sync barrier timeout (ms). Before processing a block, the indexer waits for
        // its local price mirror to catch up to that block height so native-coin fee
        // validation is deterministic across operators. On timeout the block is deferred and
        // retried rather than validated against a stale price copy.
        this.priceSyncTimeoutMs = parseInt(process.env.HUB_PRICE_SYNC_TIMEOUT_MS || '60000');
    }

    // Handle indicating if indexer is synced
    isSynced(){
        return this.synced;
    }

    // Handle setting flag to stop indexer
    stop(){
        this.stopFlag = true;
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
                this.hubDbSync = new HubDbSync(this.hubDb, {});
                // Start it in the background — failures don't block indexer startup
                this.hubDbSync.start().catch(err => {
                    console.warn('HubDbSync: start failed:', err.message);
                });
            }
        }

        // Create instance of the protocol changes class
        this.protocolChanges = new changes(this);

        // Create instance of the mapper class
        this.mapper = new mapper(this);

        // Create xchain-utxo-tracker client (used by DISPENSER fresh-address check)
        this.utxoTracker = new UtxoTracker(this.utxoTrackerUrl, this.utxoTrackerPort);
        if(!this.utxoTracker.enabled)
            console.log('WARNING: UTXO_TRACKER_URL / UTXO_TRACKER_API_PORT not set — DISPENSER fresh-address check will reject all non-owner dispensers');

        // Create instance of the actions class and pass database connection instances to it
        this.actions = new actions(this);
        
        // Create instance of the rollback class and pass database connection instances to it
        this.rollback = new rollback(this);

        // Verify the Decoder database exists
        let decoderDbStatus   = await this.decoderDb.createDatabase();
        let decoderDbVerified = await this.decoderDb.verifyDatabase();
        if(!decoderDbVerified)
            this.util.throwError("Database " + this.decoderDbName + " doesn't exist!");

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
        }

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
            // its height — do not re-introduce a block-height comparison here.
            let decoderReorg         = await this.decoderDb.getLatestReorg();
            let lastProcessedReorgId = await this.indexerDb.getLastProcessedReorgId();

            // Get last processed block from Indexer and Decoder databases
            lastDecoderBlock  = await this.decoderDb.getBlockIndex('decoder', 'last');
            lastIndexerBlock  = await this.indexerDb.getBlockIndex('indexer', 'last');

            // Handle block reorgs — process when the decoder's latest reorg event is one the
            // indexer has not yet recorded (identity check). Always record the reorg, but only
            // roll back if the indexer has already indexed past the reorg block.
            if(!this.util.isNull(decoderReorg) && decoderReorg.id !== lastProcessedReorgId){
                console.log("Detected block reorganization at block #",decoderReorg.block_index);
                await this.indexerDb.createReorg(decoderReorg.block_index, decoderReorg.id);
                if(!this.util.isNull(lastIndexerBlock) && lastIndexerBlock >= decoderReorg.block_index)
                    await this.rollback.rollback(decoderReorg.block_index);
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

                // Determine the next block to parse. Do NOT advance lastIndexerBlock yet —
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
                        await this.hubDbSync.waitForPriceSyncHeight(blockToParse, this.priceSyncTimeoutMs);
                    } catch(err){
                        // Defer the block: lastIndexerBlock is not advanced, so the outer loop
                        // retries this same block after the sleep interval rather than processing
                        // it against a stale price copy. No transaction is open yet.
                        console.warn('Deferring block ' + blockToParse + ' (price sync): ' + err.message);
                        break;
                    }
                }

                // Begin a transaction — all indexer DB writes for this block are atomic
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

                    // Block committed successfully — only now advance the counter. Doing this
                    // after the commit (rather than before the try) ensures a failed block leaves
                    // lastIndexerBlock un-advanced so it is retried instead of skipped.
                    lastIndexerBlock = blockToParse;

                    // Log the total parse time for this block
                    let parseTime = this.util.getTimer(debugTimer);
                    console.log('Block Parsed' + "\t: " + lastIndexerBlock + ' [ledger:' + ledger + ' actions:' + actions + ' contracts:' + contracts + '] (' + parseTime + ')');

                    // Push chain tip to hub (fire-and-forget — never blocks indexing).
                    // Network is included so multi-network hubs scope tips correctly
                    // (older hubs ignore it; pre-network-aware behavior = 'mainnet').
                    this.hubClient.pushChainTip(this.config['COIN'], this.config['NETWORK'], lastIndexerBlock, blockTime);

                } catch(error){
                    // Roll back all writes for this block so the DB stays at the end of the previous block
                    await this.indexerDb.rollbackTransaction();

                    // Log the error
                    this.util.logError(`Error while parsing block data at block ${lastIndexerBlock}:`, error);

                    // Exit the inner catch-up loop on failure. lastIndexerBlock was not advanced
                    // (the assignment above only runs after a successful commit), so the outer loop
                    // re-fetches it from the DB and retries this same block after the sleep interval
                    // — instead of falling through and silently skipping the failed block.
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

        const SCALAR_PARAMS = ['GAS_PRICE', 'FEE_PAYMENT_MODE', 'ACTIVATION_DELAY_BLOCKS', 'EXPIRATION_FEE_PER_DAY'];
        const BLOB_PARAMS   = ['GAS_SCHEDULE', 'STAKING'];

        try {
            let allConfigs = await this.hubClient._call('getallconfigs', {});
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
                        console.warn('XChainIndexer: failed to JSON-parse hub param ' + key + ':', e.message);
                    }
                } else if(typeof val === 'object'){
                    this.config[key] = val;
                }
            }
        } catch(err) {
            console.warn('XChainIndexer: hub config overlay failed, using local defaults:', err.message);
        }
    }

}

module.exports = XChainIndexer;
