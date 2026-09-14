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
const { CONFIG_ENV } = require('./config.js');
// The anchor-attest maturity-horizon bound (the parent barrier spec's D-B) and the
// mirror-admission family's consumer gate. Both are read HERE rather than inside
// hub_db_sync.js for the horizon half: the caller computes a plain number and passes it, so
// the mirror client stays dependency-free and re-vendorable into the explorer unchanged.
// The two members that close over these gates (mirrorAdmissionActiveAt,
// anchorAttestHorizonBound) stay in this file rather than in a part: the admission suites
// re-arm a gate by purging this module and the activation module from the require cache,
// and a part loaded once would keep calling the unarmed functions.
const { ANCHOR_ATTEST_ARRIVAL_MARGIN_S, ANCHOR_REWARD_MIRROR_MATURITY,
        isAnchorAttestBarrierHorizonActive } = require('./anchor_reward_activation.js');
const { isMirrorAdmissionConsumerActive } = require('./mirror_admission_activation.js');
const { getLogger } = require('./observability/index.js');

// The method groups beside this entry (./XChainIndexer/). Each part holds one concern and
// is installed onto the prototype below the class, so every call site stays this.<method>().
const { stallWedged, waitingOnFutureBlock, stallClassOf, atProcessableTip, nextBarrierHold,
        barrierHoldMs, barrierCeilingExceeded, isMirrorBarrierReason } = require('./XChainIndexer/stall_health.js');
const { initChainState, initHaltState, initHubConfigState, initBarrierTiming,
        initDirectCallState } = require('./XChainIndexer/instance_state.js');
const { hubConfigCoinKey, hubConfigMethods } = require('./XChainIndexer/hub_config.js');
const barrierClockMethods       = require('./XChainIndexer/barrier_clock.js');
const directCallPresenceMethods = require('./XChainIndexer/direct_call_presence.js');
const startupMethods            = require('./XChainIndexer/startup.js');
const trainGateMethods          = require('./XChainIndexer/train_gate.js');
const decoderProbeMethods       = require('./XChainIndexer/decoder_probes.js');
const backgroundJobMethods      = require('./XChainIndexer/background_jobs.js');
const { DEFAULT_HUB_CONFIG_POLL_INTERVAL_MS, effectiveHubConfigPollIntervalMs, hubConfigStalenessLimitMs,
        hubConfigStaleness, hubConfigPollMethods } = require('./XChainIndexer/hub_config_poll.js');
const runtimeConfigMethods      = require('./XChainIndexer/runtime_config.js');
const blockPollMethods          = require('./XChainIndexer/block_poll.js');
const blockParseMethods         = require('./XChainIndexer/block_parse.js');
const priceBarrierMethods       = require('./XChainIndexer/price_barriers.js');
const mirrorBarrierMethods      = require('./XChainIndexer/mirror_barriers.js');
const blockPassMethods          = require('./XChainIndexer/block_passes.js');
const blockCommitMethods        = require('./XChainIndexer/block_commit.js');
const blockFaultMethods         = require('./XChainIndexer/block_faults.js');

class XChainIndexer {

    constructor(decoderDbHost, decoderDbPort, decoderDbName, decoderDbUser, decoderDbPass, indexerDbHost, indexerDbPort, indexerDbName, indexerDbUser, indexerDbPass, hubDbHost, hubDbPort, hubDbName, hubDbUser, hubDbPass, utxoTrackerUrl, utxoTrackerPort){
        // XChain Indexer Version. npm_package_* exists only under `npm run`; the
        // container now launches node directly (Dockerfile CMD, exec form, so
        // node is PID 1 and gets SIGTERM), which left the boot banner reading
        // "undefined vundefined". Fall back to the package.json this process
        // actually loaded, the same source src/api.js:220 already reports from.
        // Env stays first so the test launchers that pin it keep deciding.
        //
        // The require stays HERE and is not hoisted to module scope: package.json sits
        // outside src/, and the armed-map v2 falsification harness loads this module from
        // a temp tree that copies src/ alone. A load-time require turns that copy into a
        // MODULE_NOT_FOUND, which is how the hoist was caught.
        this.version = CONFIG_ENV.npm_package_version || require('../package.json').version;
        this.name    = CONFIG_ENV.npm_package_name    || require('../package.json').name;

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

        // Every other field, grouped by concern (./XChainIndexer/instance_state.js).
        initChainState(this);
        initHaltState(this);
        initHubConfigState(this);
        initBarrierTiming(this);
        initDirectCallState(this);
    }

    // Handle indicating if indexer is synced
    isSynced(){
        return this.synced;
    }

    // True when the block-poll loop has stopped ITERATING. Nothing else in the health
    // payload can see this: stallReason is only set when a barrier was actually hit, lag and
    // decoderBlock are written inside the loop and freeze at their last good values, and
    // lastBlockCommittedAt is old on a quiet chain in the healthy case too. So a loop that
    // hangs inside an await (black-holed DB socket, pool exhaustion with no query timeout)
    // never rejects, never flips indexerRunning, and leaves buildHealthResponse reporting
    // healthy / stallClass 'none' / lag 0 indefinitely.
    //
    // Fail-quiet before the first iteration: lastPollAt 0 means the loop has not run yet
    // (boot, or a long initial DB connect) and is never reported silent.
    isPollSilent(){
        if(!this.lastPollAt) return false;
        return (Date.now() - this.lastPollAt) > this.pollSilentMs;
    }

    // Handle setting flag to stop indexer
    stop(){
        this.stopFlag = true;
        if(this.hubPushQueue) this.hubPushQueue.stop();
    }

    // Whether this chain binds mirrored rows by admission height at block B. Inert on every
    // network in this train, in which case every sync barrier behaves exactly as it does now.
    mirrorAdmissionActiveAt(blockHeight){
        if(blockHeight === null || blockHeight === undefined) return false;
        return isMirrorAdmissionConsumerActive(this.config['COIN'], this.config['NETWORK'], blockHeight);
    }

    // The anchor-attest barrier's MATURITY HORIZON bound for block B, or null when it does not
    // apply. Read through decoderDb.getBlockTime, the one seam every protocol-time read in this
    // loop already flows through, so the horizon resolves as median-time-past wherever the
    // block's own time does and the two can never key on different clocks.
    //
    // Ordering matters and is not incidental: this runs BEFORE the block's own getBlockTime
    // read, because that read is a single-entry memo keyed by height. Called after it, this
    // would evict the memo, and protocol_changes.js re-reads getBlockTime(B) later in the same
    // block, so every block would pay an extra query (twelve on the networks resolving MTP).
    //
    // Returns null, never a coerced number, for: a block below the maturity span (no row can
    // have snapshot_block <= B - 144 < 0, so both forms are safe there), an inert activation,
    // and a horizon the decoder cannot serve. That last one is the sharp case: getBlockTime
    // returns literal `false` for an absent blocks row, and `Number(false)` is 0, so a coercing
    // guard here would hand the predicate a bound of `0 + margin` and open the barrier at
    // `watermark >= margin + grace` on any decoder gap above height 144.
    async anchorAttestHorizonBound(blockToParse){
        if(!this.hubDbSync) return null;
        let b = Number(blockToParse);
        if(!Number.isFinite(b) || (b - ANCHOR_REWARD_MIRROR_MATURITY) < 0) return null;
        if(!isAnchorAttestBarrierHorizonActive(this.config['NETWORK'], b)) return null;
        let margin = Number(this.anchorAttestArrivalMarginS);
        if(!Number.isFinite(margin)) margin = ANCHOR_ATTEST_ARRIVAL_MARGIN_S;
        let horizonTime = await this.decoderDb.getBlockTime(b - ANCHOR_REWARD_MIRROR_MATURITY);
        // The `false` sentinel is rejected BY IDENTITY before any coercion, because that is
        // the whole trap: Number(false) is 0 and sails through an isFinite guard. A BIGINT the
        // driver hands back as a digit string is still a real stamp and is accepted.
        if(typeof horizonTime === 'boolean' || horizonTime === null || horizonTime === undefined) return null;
        let ht = Number(horizonTime);
        if(!Number.isFinite(ht)) return null;
        return ht + margin;
    }

    // Handle starting up the XChain indexer
    async start(){
        getLogger().info('Starting up ' + this.name + ' v' + this.version + '...');

        // Config, the startup-resolved graces and the shared utility (resolveRuntimeConfig).
        this.resolveRuntimeConfig();

        // Hub, DOGE-anchor and DOGE roll-call clients (./XChainIndexer/startup.js).
        this.createHubClients();

        // Overlay hub-served operational params on top of local config defaults (best-effort)
        await this.applyHubConfigOverlay();

        // Keep the overlay live: poll the hub so a PBFT-committed config change takes
        // effect without requiring a process restart (see startHubConfigPolling).
        this.startHubConfigPolling();

        // Databases, the block-processing modules, the schema checks and the background
        // services, one phase each (./XChainIndexer/startup.js).
        this.connectDatabases();
        this.buildBlockModules();
        await this.verifyDecoderDatabase();
        await this.verifyIndexerDatabase();
        this.startBackgroundServices();

        // Parse blocks until stop() is requested.
        await this.runBlockLoop();
    }

    // The block loop: one pass per BLOCK_CHECK_INTERVAL, each catching up to the decoder
    // tip (pollDecoderOnce). Returns once stop() has been requested.
    async runBlockLoop(){
        // Pool-direct view for the reorg-driver's indexerDb reads + the createReorg marker WRITE
        // These run outside any transaction the driver holds, and getConnection() adopts
        // whatever transactionConnection is open - so during a concurrent public feequote dry-run (an
        // indexerDb transaction held up to 10s that always rolls back) an un-viewed read would see the
        // dry-run's dirty uncommitted state and the createReorg INSERT would be silently discarded when
        // that dry-run rolls back, stranding the reorg. The view draws an independent pooled connection
        // that never adopts a transaction and sees only committed state. apiView may be absent on a
        // minimal test double, so fall back to the raw db.
        //
        // That fallback is a TEST AFFORDANCE and NOT a production path. The real Database
        // always defines apiView(), so against a live indexer the raw-db branch is unreachable; a
        // production handle without it is a wiring bug to fix, not a case to serve. Do not spread this
        // shape to the federation READ sites in api.js and stake_source.js: there a silent raw-db
        // fallback would re-open exactly the dirty read this view and federation READ isolation exist
        // to prevent. When a
        // test double trips over a missing apiView, the fix belongs to the DOUBLE (give it
        // `apiView(){ return this }`), never to the call site. Same reading applies to the two other
        // guarded sites, rollback.js and health.js, which point back here.
        let indexerReorgView = (typeof this.indexerDb.apiView === 'function') ? this.indexerDb.apiView() : this.indexerDb;

        // How often the inner catch-up loop re-checks for a mid-catch-up decoder reorg.
        let REORG_RECHECK_BLOCKS = Number(this.config['REORG_RECHECK_BLOCKS']) || 50;

        while (true){

            // Iteration heartbeat, stamped FIRST so it records the pass whatever the body
            // does next, including breaking out on stopFlag. isPollSilent() reads it; see
            // the field comment for why no other health field can stand in for it.
            this.lastPollAt = Date.now();

            // Bail out if stop is requested
            if(this.stopFlag)
                break;

            await this.pollDecoderOnce(indexerReorgView, REORG_RECHECK_BLOCKS);

            // Sleep for BLOCK_CHECK_INTERVAL before checking for new transaction data
            await this.util.sleep(this.config['BLOCK_CHECK_INTERVAL']);
        }
    }

    // Loop through blocks until indexer has parsed lastDecoderBlock. The stopFlag check
    // lets stop() take effect at the next block boundary: on a moving decoder tip this
    // inner loop can otherwise run indefinitely (lastDecoderBlock is refreshed per block),
    // so a shutdown request would be deferred until full catch-up. The check sits before
    // beginTransaction, preserving the invariant that an open block transaction is never
    // interrupted mid-flight.
    // Returns the indexer and decoder tips it stopped at.
    async catchUpToDecoder(indexerReorgView, REORG_RECHECK_BLOCKS, lastProcessedReorgId, lastIndexerBlock, lastDecoderBlock){
        while( !this.stopFlag && !this.util.isNull(lastIndexerBlock) && !this.util.isNull(lastDecoderBlock) && this.util.bclt(lastIndexerBlock, lastDecoderBlock) ){

            // The heartbeat belongs here too, not only at the outer loop top. This loop
            // runs the whole backlog and only breaks out every REORG_RECHECK_BLOCKS, so a
            // healthy initial sync legitimately stays inside it for hours; an outer-loop-only
            // stamp would report a catching-up indexer dead and, worse, would call it dead
            // for exactly as long as it is doing the most work.
            this.lastPollAt = Date.now();

            // Set flag to indicate not fully synced
            this.synced = false;

            // Break to the outer loop when a decoder reorg landed mid-catch-up, so it is
            // rolled back before any more blocks commit (reorgLandedMidCatchUp).
            if(await this.reorgLandedMidCatchUp(indexerReorgView, lastProcessedReorgId, lastIndexerBlock, REORG_RECHECK_BLOCKS))
                break;

            // Start tracking time to parse block
            var debugTimer = this.util.startTimer();

            // Determine the next block to parse. Do NOT advance lastIndexerBlock yet:
            // it is only updated after this block commits successfully (below). A failure
            // therefore leaves the counter un-advanced so the same block is retried rather
            // than silently skipped.
            let blockToParse = Number(lastIndexerBlock) + 1;

            let step = await this.parseBlock(blockToParse, lastIndexerBlock, lastDecoderBlock, debugTimer);
            // Block committed successfully. Only now advance the counter. Doing this
            // after the commit (rather than before the try) ensures a failed block leaves
            // lastIndexerBlock un-advanced so it is retried instead of skipped.
            if(step.committed) lastIndexerBlock = blockToParse;
            lastDecoderBlock = step.lastDecoderBlock;
            if(step.stop) break;
        }
        return { lastIndexerBlock: lastIndexerBlock, lastDecoderBlock: lastDecoderBlock };
    }

}

Object.assign(XChainIndexer.prototype, barrierClockMethods, directCallPresenceMethods, startupMethods,
              hubConfigMethods, trainGateMethods, decoderProbeMethods, backgroundJobMethods,
              hubConfigPollMethods, runtimeConfigMethods, blockPollMethods, blockParseMethods,
              priceBarrierMethods, mirrorBarrierMethods, blockPassMethods, blockCommitMethods,
              blockFaultMethods);

module.exports = Object.assign(XChainIndexer, {
    DEFAULT_HUB_CONFIG_POLL_INTERVAL_MS,
    // Exported as functions, not constants: the cadence the timer uses and the boundary derived from
    // it are both env-dependent at call time, and a snapshot taken at require() would be wrong for
    // any consumer loaded before dotenv.config().
    effectiveHubConfigPollIntervalMs,
    hubConfigStalenessLimitMs,
    hubConfigStaleness,
    stallWedged,
    waitingOnFutureBlock,
    stallClassOf,
    atProcessableTip,
    nextBarrierHold,
    barrierHoldMs,
    barrierCeilingExceeded,
    isMirrorBarrierReason,
    hubConfigCoinKey
});
