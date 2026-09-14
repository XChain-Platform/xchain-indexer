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
 * XChain Indexer - Startup phases
 *
 * The phases start() runs between resolving its config and entering the block
 * loop: the hub-facing clients, the database connections (with the hub mirror or
 * the local-price-source check), the block-processing modules, the decoder and
 * indexer schema checks, and the background services. Installed onto
 * XChainIndexer.prototype by ../XChainIndexer.js; start() calls them in this order.
 *
 ********************************************************************/

const changes   = require('../protocol_changes.js');
const database  = require('../db');
const actions   = require('../actions/index.js');
const rollback  = require('../rollback.js');
const mapper    = require('../chain/mapper.js');
const HubClient    = require('../hub/hub_client.js');
const HubDbSync    = require('../hub/hub_db_sync.js');
const AnchorProofClient  = require('../consensus/doge_peer_clients/anchor_proof_client.js');
const { RollcallProofClient } = require('../consensus/doge_peer_clients/rollcall_proof_client.js');
const HubPushQueue = require('../hub/hub_push_queue.js');
const UtxoTracker  = require('../chain/utxo_tracker.js');
const Genesis      = require('../chain/genesis.js');
const { getLogger } = require('../observability/index.js');
const { CONFIG_ENV } = require('../config.js');

module.exports = {

    // The hub, DOGE-anchor and DOGE roll-call clients. Created before the hub config
    // overlay, which fetches through the hub client.
    createHubClients(){
        // Create hub client (for pushing chain tip and other cross-chain data to xchain-hub)
        this.hubClient = new HubClient();

        // DOGE anchor visibility for the BTC-side anchor/archive reward derivation. ANCHOR
        // lives on DOGE while the reward is minted here, so before paying, the derive pass
        // re-proves the mirrored row's doge_anchor_txid against the DOGE indexer itself
        // rather than trusting the hub that would be paid. Constructed on every chain (it is
        // inert off BTC and costs nothing unconfigured); an unset DOGE_INDEXER_URL means no
        // matured reward can be proven, which DEFERS the block rather than paying blind.
        this.anchorProof = new AnchorProofClient(this.config);

        // DOGE roll-call visibility for the BTC-side epoch close. Same shape and the
        // same reason as anchorProof: the presence proofs land on DOGE while the
        // membership verdict is taken here, so the close asks the DOGE indexer for
        // the raw signed rows and judges them itself. Inert off BTC; unconfigured
        // means every close DEFERS rather than reading silence as absence.
        this.rollcallProof = new RollcallProofClient(this.config);
    },

    // Open the decoder and indexer databases, then either the hub database (with its
    // optional mirror) or, when none is configured, the local-price-source check.
    connectDatabases(){
        // Establish database connections
        this.decoderDb = new database(this.decoderDbHost, this.decoderDbPort, this.decoderDbName, this.decoderDbUser, this.decoderDbPass, this);
        this.indexerDb = new database(this.indexerDbHost, this.indexerDbPort, this.indexerDbName, this.indexerDbUser, this.indexerDbPass, this);

        // Optional hub database connection (read-only local copy of cross-chain infrastructure)
        // Created only when hub DB credentials are provided. Indexer queries price_snapshots,
        // oracle_prices, stakes, delegations, and validator_rewards from this connection.
        if(this.hubDbHost && this.hubDbName){
            this.connectHubDatabase();
        } else {
            this.checkLocalPriceSource();
        }
    },

    // The hub database connection, plus the WebSocket mirror when HUB_DB_SYNC_ENABLED.
    connectHubDatabase(){
        this.hubDb = new database(this.hubDbHost, this.hubDbPort, this.hubDbName, this.hubDbUser, this.hubDbPass, this);

        // Optional: subscribe to the hub's WebSocket channel to keep the local hub DB in sync
        // with new price_snapshots and oracle_prices rows. Used in distributed deployments where
        // the indexer is on a different host from the hub. For single-host deployments, the
        // local hub DB is the hub's MariaDB itself, so sync is not needed.
        // Enable by setting HUB_DB_SYNC_ENABLED=true (default off).
        if(CONFIG_ENV.HUB_DB_SYNC_ENABLED === 'true'){
            this.hubDbSync = new HubDbSync(this.hubDb, {
                coin: this.config['COIN'],
                // Signed retractions: keys the RETRACTION_SIGNING flag-day
                // and SWQ activation for quorum-class retraction verification.
                network: this.config['NETWORK'],
                // Receive-side retraction authority for our own chain:
                // the mirror refuses hub-broadcast reorg retractions of THIS
                // chain's rows unless their generation fence is below our own
                // push_generations value, i.e. a rollback we actually performed.
                getOwnRollbackGeneration: () => this.indexerDb.getPushGeneration(this.config['COIN']),
                // Bound the price_snapshots bootstrap: the mirror needs the
                // rounds the blocks THIS node will parse can read, not the oracle's whole
                // history. Re-evaluated on every (re-)bootstrap, and null-safe - an
                // unresolvable horizon mirrors the table in full, as before.
                getPriceMirrorHorizon: () => this.priceMirrorHorizon(),
                // Fail-loud stage of the mirror's watermark-stall detector. The mirror
                // never ends a process on its own (a consumer running several mirrors
                // in one process must not lose all of them to one stalled chain); this
                // service has exactly one, and every barrier it owns is frozen while
                // that watermark is, so the supervisor restart IS the recovery.
                onFatalStall: (reason) => this.fatalExit(reason)
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
    },

    // No hub database configured: fail closed on mainnet unless a local price source is
    // acknowledged, and warn everywhere else.
    checkLocalPriceSource(){
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
        let allowLocal = CONFIG_ENV.INDEXER_ALLOW_LOCAL_PRICE_SOURCE === 'true';
        if(this.config['NETWORK'] === 'mainnet' && !allowLocal){
            this.util.throwError('HUB_DB_HOST / HUB_DB_NAME are not set on a mainnet node. Native-coin ' +
                'fee validation and price reads would fall back to the local indexer DB, which on a ' +
                'distributed node means stale/empty price data and consensus divergence. Set ' +
                'HUB_DB_HOST / HUB_DB_NAME for a distributed deployment, or set ' +
                'INDEXER_ALLOW_LOCAL_PRICE_SOURCE=true to confirm an intentional single-host node ' +
                '(local DB holds the synced hub copy).');
        }
        if(allowLocal){
            getLogger().info('Hub DB not set; local price source acknowledged via INDEXER_ALLOW_LOCAL_PRICE_SOURCE. ' +
                'Hub-owned price/oracle tables will be read from the local indexer DB (single-host mode).');
        } else {
            getLogger().warn('WARNING: HUB_DB_HOST / HUB_DB_NAME not set. Hub-owned price/oracle tables ' +
                'will be read from the local indexer DB. Expected for single-host setups; on a distributed ' +
                'node this indicates a hub DB misconfiguration and fee/price data may be stale or absent. ' +
                'Set INDEXER_ALLOW_LOCAL_PRICE_SOURCE=true to acknowledge an intentional single-host node.');
        }
    },

    // The block-processing modules, once the consensus-version pin is proven.
    buildBlockModules(){
        // Prove the consensus-version pin is a no-op on this host BEFORE any
        // activation is evaluated. Throws (aborting boot, and with it the rollout on
        // this host) if the compiled pin disagrees with the version the pre-pin code
        // would have resolved here. See protocol_changes.assertConsensusVersionPin.
        changes.assertConsensusVersionPin();

        // Create instance of the protocol changes class
        this.protocolChanges = new changes(this);

        // Create instance of the mapper class
        this.mapper = new mapper(this);

        // Create xchain-utxo-tracker client (used by DISPENSER fresh-address check)
        this.utxoTracker = new UtxoTracker(this.utxoTrackerUrl, this.utxoTrackerPort);
        if(!this.utxoTracker.enabled)
            getLogger().info('WARNING: UTXO_TRACKER_URL / UTXO_TRACKER_API_PORT not set. DISPENSER fresh-address check will reject all non-owner dispensers');

        // Create instance of the actions class and pass database connection instances to it
        this.actions = new actions(this);

        // Genesis ledger bootstrap (Counterparty/Dogeparty name-ownership injection at the
        // configured genesis block; no-op when GENESIS_BLOCK is unset). See genesis.js.
        this.genesis = new Genesis(this.actions, this.indexerDb, this.config, this.util);

        // Create instance of the rollback class and pass database connection instances to it
        this.rollback = new rollback(this);
    },

    // Create and verify the decoder database, then check its schema has finished its
    // first boot.
    async verifyDecoderDatabase(){
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
            let migRows = await this.decoderDb.countDecoderSchemaMigrationsTable(this.decoderDbName);
            if(!migRows || migRows[0].cnt === 0){
                getLogger().warn('Decoder DB ' + this.decoderDbName + ': schema_migrations table not found. ' +
                    'Decoder has not completed first boot. Block processing will retry until decoder is ready.');
            } else {
                let txRows = await this.decoderDb.countDecoderTransactionsTable(this.decoderDbName);
                if(!txRows || txRows[0].cnt === 0){
                    getLogger().warn('Decoder DB ' + this.decoderDbName + ': transactions table not found. ' +
                        'Decoder schema may be partially applied. Block processing will retry until decoder is ready.');
                }
            }
        } catch(e){
            getLogger().warn('Decoder DB ' + this.decoderDbName + ': schema check failed (non-fatal):', e.message);
        }
    },

    // Create, verify and migrate the indexer database, run the startup probes, and start
    // the hub mirror once every table it writes exists.
    async verifyIndexerDatabase(){
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
            // gated for an explicit operator run (`node src/migration/migrate.js`). Recorded in the
            // schema_migrations ledger, so this is a no-op once applied.
            await this.indexerDb.runMigrations();

            // Invariant probe (a precondition for arming the dense-id rules): the deterministic
            // address/ticker id counter (getNextAddressId = MAX(id)+1) and every wire ^<id>
            // resolution assume every index row carries a non-NULL, rollback-stable block_index.
            // Out-of-band rows (legacy AUTO_INCREMENT, NULL block_index) are invisible to ^id
            // resolution (the resolvers gate on block_index IS NOT NULL) but still inflate the
            // counter and indicate the DB has not been cleanly reindexed. Warn loudly with the
            // count rather than throw, so a mid-migration node is not bricked; pre-launch the
            // clean genesis reindex drives this to zero.
            await this.indexerDb.warnOnOrphanIndexIds();
            // Warn if the reorg cursor is all-legacy (would replay the full decoder reorg history on
            // the next reorg detection). Surfaced, not auto-fixed; operator does a reindex.
            await this.indexerDb.warnOnLegacyReorgCursor();
            // Surface a pre-existing decoder REORG_HALT at startup (loud) so a node booting
            // behind a halted decoder is not silently mistaken for a slow catch-up.
            await this.checkDecoderReorgHalt();

            // Now that the indexer tables exist (including every hub-mirror table the
            // sync client writes into), start the hub DB sync in the background.
            // Deferred from construction above so the bootstrap never inserts into a
            // not-yet-created mirror table. Failures don't block indexer startup.
            // Arm the cross-chain chain-identity fence BEFORE the first bootstrap drains, so
            // a hub database that outlived a venue re-genesis has its relic matches and
            // capability snapshots refused on arrival rather than mirrored and then purged.
            // No-op off BTC and while block 1 is not decoded yet; the block loop retries.
            await this.resolveBtcChainId();

            if(this.hubDbSync){
                this.hubDbSync.start().catch(err => {
                    getLogger().warn('HubDbSync: start failed:', err.message);
                });
            }
        }
    },

    // The durable hub-push retry queue and the two state-tree maintenance timers.
    startBackgroundServices(){
        // Start the durable hub-push retry queue. Both PRICE hub pushes (v0 round and v1
        // oracle price) are write-ahead: price.js enqueues the pending_hub_pushes row
        // UNCONDITIONALLY inside the open block transaction, so it commits atomically with
        // the prices row. Live delivery runs post-commit (deliverStagedHubPushes) and drops
        // the row only on success, so neither a crash in that window nor a transient hub
        // outage can permanently drop it; this poller drains whatever survives, with
        // exponential backoff. No-op when no hub is configured (nothing ever enqueues in
        // that case).
        this.hubPushQueue = new HubPushQueue(this);
        this.hubPushQueue.start();

        // Start the read-only state_tree_nodes orphan-count metric (observability only; no
        // deletion). Surfaces unbounded COW-node growth so we can measure it before building a
        // safe reclaiming sweep (see stateCommitment.reportOrphanStats for why deletion is deferred).
        this.startStateTreeMetric();

        // Start the state-retention pruner. DEFAULT OFF: inert unless
        // STATE_ROOT_RETENTION_BLOCKS is set (see src/chain/retention.js + the
        // data-retention page under components/indexer/ in xchain-documentation).
        // Phase-2 node reclaim, when opted in, runs
        // under the db transaction mutex so it cannot interleave with block-root inserts.
        this.startStateRetention();
    }
};
