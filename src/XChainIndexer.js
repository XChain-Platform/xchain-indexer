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
const coins     = require('./coins');
const protocolTime = require('./consensus/protocol_time.js');
const util      = require('./utility.js');
const stateCommitment   = require('./stateCommitment.js');
const stateCommitAct    = require('./state_commitment_activation.js');
// The frozen call-barrier grace and its resolver, shared with the direct-hub-DB
// (no-mirror) call-presence barrier so both paths open on the SAME constant.
const { HUB_SYNC_WATERMARK_GRACE_S, resolveWatermarkGrace } = require('./hub/hub_db_sync.js');
const anchorRewardDerive = require('./consensus/anchor_reward_derive.js');
// The anchor-attest maturity-horizon bound (the parent barrier spec's D-B) and the
// mirror-admission family's consumer gate. Both are read HERE rather than inside
// hub_db_sync.js for the horizon half: the caller computes a plain number and passes it, so
// the mirror client stays dependency-free and re-vendorable into the explorer unchanged.
const { ANCHOR_ATTEST_ARRIVAL_MARGIN_S, ANCHOR_REWARD_MIRROR_MATURITY,
        isAnchorAttestBarrierHorizonActive } = require('./anchor_reward_activation.js');
const { isMirrorAdmissionConsumerActive } = require('./mirror_admission_activation.js');
const bridgeSettle       = require('./consensus/bridge_settle.js');
const rollcallClose      = require('./consensus/rollcall_close.js');
const { collapseOutputFanout } = require('./chain/output_fanout.js');

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

const { getLogger } = require('./observability/index.js');
const { CONFIG_ENV } = require('./config.js');
// Hub->indexer config poll cadence (ms). This is the sole staleness / propagation bound for the
// live-polled governance overlay: nothing else refreshes it, so an overlay older than a small
// multiple of this interval means the hub is unreachable. Overridable via
// HUB_CONFIG_POLL_INTERVAL_MS. Purely operational/observability, NOT a consensus parameter.
const DEFAULT_HUB_CONFIG_POLL_INTERVAL_MS = 60000;
// Return the cadence actually in force. One reader feeds both the poll timer and the staleness
// boundary below, so the two interval contracts cannot disagree: deriving the boundary from the
// DEFAULT while the timer honoured the override made a 10s poll report fresh until 180s instead
// of 30s, and a 10-minute poll report stale after three minutes. The read stays at
// CALL time and is deliberately not hoisted to module load, nor folded into config.js's
// load-time CONFIG_ENV snapshot: any consumer that requires this module before running its own
// dotenv.config() would then miss HUB_CONFIG_POLL_INTERVAL_MS from the documented `.env` and
// silently revert the knob to the 60s default.
function effectiveHubConfigPollIntervalMs(){
    return parseInt(process.env.HUB_CONFIG_POLL_INTERVAL_MS, 10) || DEFAULT_HUB_CONFIG_POLL_INTERVAL_MS;
}
// An overlay older than this is reported `stale`. Three poll intervals tolerates a couple of
// missed/slow polls before flagging: a purely operational outage-observability margin.
// This is independent of the WS_WATERMARK_GRACE constants (600s price/oracle, 120s match),
// which gate consensus-critical block-processing barriers; the two serve different concerns
// and their values need not (and do not) match.
function hubConfigStalenessLimitMs(){
    return effectiveHubConfigPollIntervalMs() * 3;
}

// Shared age/staleness computation for the hub-config overlay, used by both health.js and api.js
// so the age math and the staleness threshold live in exactly one place. `now` and
// `lastHubConfigFetchAt` are epoch-ms. Returns { ageSeconds:(number|null), stale:boolean }.
function hubConfigStaleness(lastHubConfigFetchAt, now){
    if(lastHubConfigFetchAt == null) return { ageSeconds: null, stale: false };
    let ageMs = now - lastHubConfigFetchAt;
    return { ageSeconds: Math.floor(ageMs / 1000), stale: ageMs > hubConfigStalenessLimitMs() };
}

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

    // Deliver the hub pushes staged (and durably written via enqueueHubPushTx) during the block
    // transaction that just committed. Each push_type maps to the same HubClient method the
    // HubPushQueue drain uses; on success the durable pending_hub_pushes row is dropped, on any
    // failure it is left for HubPushQueue to retry with backoff. Never throws into the block loop.
    async deliverStagedHubPushes(){
        let staged = this.indexerDb.takeStagedHubPushes();
        if(!staged || staged.length === 0 || !this.hubClient) return;
        for(let entry of staged){
            try {
                if(entry.pushType === 'price_round'){
                    await this.hubClient.pushPriceRound(entry.payload);
                } else if(entry.pushType === 'oracle_price'){
                    await this.hubClient.pushOraclePrice(entry.payload);
                } else if(entry.pushType === 'price_batch'){
                    // PRICE v0: a signed window of rounds, delivered to pushpricebatch.
                    await this.hubClient.pushPriceBatch(entry.payload);
                } else if(entry.pushType === 'attest_batch'){
                    // ATTEST v5: a signed window of finalized attestation responses parsed
                    // off the DOGE rail, delivered to the hub's `pushattestbatch`, which
                    // re-verifies the batch quorum, inserts the carried rows into
                    // attestation_responses and broadcasts them. That road is how a
                    // chain-only node's mirror gets rebuilt from chain parse alone, which
                    // is why the row stays durable rather than best-effort.
                    //
                    // Payload shape (the hub destructures exactly these names):
                    //   source_chain, network, window_start, window_end, row_count,
                    //   btc_block_height, rows[], sigs[], action_index, block_index,
                    //   block_time, push_generation
                    await this.hubClient.pushAttestBatch(entry.payload);
                } else {
                    // Unknown type: leave the durable row for HubPushQueue rather than guess.
                    continue;
                }
                if(entry.id != null) await this.indexerDb.markHubPushDelivered(entry.id);
            } catch(err){
                // Live delivery failed; the durable row stays for HubPushQueue's backoff retry.
                getLogger().warn('Staged hub push ' + entry.pushType + ' row ' + entry.id +
                    ' live delivery failed; HubPushQueue will retry:', err && err.message);
                // A 429 says the hub is refusing this IP for the rest of its window, so the
                // remaining staged entries would each buy one more rejection and one more
                // log line. Stop here: every one of them is already durable in
                // pending_hub_pushes, and HubPushQueue holds off until the window clears.
                // This is the shape a chain-only node replaying a
                // batch-bearing chain against a REMOTE hub takes, where the block loop
                // outruns any per-IP cap by orders of magnitude.
                if(err && err.rateLimited) break;
            }
        }
    }

    // The barrierClearsAt verdict (XChainIndexer/barrier_clock.js) for a barrier that may have
    // been RE-KEYED onto a height.
    //
    // Above the mirror-admission activation the answer is null, and that null is load-bearing
    // rather than cosmetic. stallClearsAt exists to name the first instant a CLOCK-keyed
    // barrier can open; a height-keyed one has no such instant, because nothing in its
    // predicate moves with wall clock. Reporting `blockTime + grace` anyway would be a lie
    // with consequences: waitingOnFutureBlock() would answer 'future_block_wait' until that
    // instant, nextBarrierHold() would refuse to accumulate a hold, and the 900 s ceiling
    // could never fire on the one barrier whose stall is now genuine mirror lag and IS
    // remediable by a resync. Null is what turns this stall from "healthy, self-clearing" into
    // "measurable, attributable and self-remedying", which is the whole point of the re-keying.
    //
    // Keyed on B, the block being processed, exactly as the predicate is.
    barrierClearsAtHeightAware(blockTime, graceField, blockHeight){
        if(this.mirrorAdmissionActiveAt(blockHeight)) return null;
        return this.barrierClearsAt(blockTime, graceField);
    }

    // The anchor-attest barrier's clear instant, bound-aware.
    //
    // It MUST move with the predicate, and the reason is not cosmetic. The predicate now opens
    // at min(blockTime, horizonBound) + grace; leaving this on blockTime + grace would leave
    // waitingOnFutureBlock() answering 'future_block_wait' for up to two hours after the
    // barrier itself could open, nextBarrierHold() would stay null across that whole window,
    // and the 900 s hold ceiling could never fire on the one barrier the horizon bound was
    // added to un-stall. The grace field is passed by NAME so barrierClearsAt stays the only
    // reader of a grace and the barrier-to-grace wiring scan still sees which one this is.
    anchorBarrierClearsAt(blockTime, horizonBound, blockHeight, graceField){
        // Height-keyed above the activation: no clock instant exists, so null.
        if(this.mirrorAdmissionActiveAt(blockHeight)) return null;
        blockTime = Number(blockTime);
        if(!Number.isFinite(blockTime)) return null;
        let usable = (typeof horizonBound === 'number') && Number.isFinite(horizonBound);
        return this.barrierClearsAt(usable ? Math.min(blockTime, horizonBound) : blockTime, graceField);
    }

    // Whether this chain binds mirrored rows by admission height at block B. Inert on every
    // network in this train, in which case every barrier above behaves exactly as it does now.
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

    // Resolve this process's indexer config and the two graces that must be fixed at
    // startup (never inside the block loop), create the utility over that same config
    // object, and verify the bundled coin files against the consensus pin.
    resolveRuntimeConfig(){
        // Get indexer configuration
        this.config = config.getConfig();

        // Resolve the direct-hub-DB call barrier's grace now that NETWORK is known. Same
        // constant, same env override, same regtest-only rules as the mirrored path.
        this.directCallGraceS = resolveWatermarkGrace(
            HUB_SYNC_WATERMARK_GRACE_S.call, 'HUB_SYNC_CALL_GRACE_S', this.config['NETWORK']);

        // Same shape, same contract, for the anchor-attest maturity-horizon margin: honoured
        // on regtest, throws on a non-integer there, IGNORED with a warning off regtest.
        this.anchorAttestArrivalMarginS = resolveWatermarkGrace(
            ANCHOR_ATTEST_ARRIVAL_MARGIN_S, 'HUB_SYNC_ANCHOR_ATTEST_ARRIVAL_MARGIN_S', this.config['NETWORK']);

        // Create instance of the utility class, sharing the indexer's single
        // config object (NOT a fresh getConfig()) so a later hub overlay can't
        // make this.config and this.util.config diverge.
        this.util = new util(this.config);

        // Guard the shared-config invariant: every block-processing module reads
        // this.config, and the hub overlay mutates it in place, so util MUST hold
        // the same object. Construction above guarantees it; this catches a future
        // refactor that reintroduces the divergence without bricking startup.
        if(this.util.config !== this.config)
            getLogger().error('CONFIG WIRING BUG: indexer.config and util.config are not the same object; a hub overlay could desync consensus reads.');

        // Verify the bundled canonical coin files against CONSENSUS_CONFIG_PIN before
        // processing any block. A null pin (mainnet, pre-arm) skips; a mismatch on an
        // armed network halts, exactly like genesis.js' ledger-hash check. This catches
        // a vendored coin file that drifted from the pinned consensus config.
        coins.verifyConsensusPin(this.config.NETWORK);
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

    // The reorg cursor and the decoder and indexer tips a pass starts from.
    async readPollCursors(indexerReorgView){
        // Fetch EVERY decoder reorg event the indexer has not yet processed (oldest first),
        // not just the latest. getLastProcessedReorgId() is the decoder event id of the most
        // recent reorg the indexer recorded; getReorgsSince() returns all decoder reorgs newer
        // than it. Reorgs are matched by event IDENTITY (the decoder's events.id), NOT by
        // block-height magnitude: heights increase across repeated reorgs, so a height compare
        // silently drops every reorg after the first. Do not re-introduce a height comparison.
        let lastProcessedReorgId = await indexerReorgView.getLastProcessedReorgId();
        // Pass the cursor marker's stored witness so getReorgsSince can catch an
        // out-of-band decoder rebuild that reused this cursor id for a different event
        // (under-cursor silent skip). Null for legacy markers -> old over-cursor guard only.
        let cursorWitness        = (lastProcessedReorgId != null)
                                    ? await indexerReorgView.getLastProcessedReorgWitness() : null;
        let unprocessedReorgs    = await this.decoderDb.getReorgsSince(lastProcessedReorgId, cursorWitness);
        // Keep the decoder-halt flag current on every poll (loud on transition, then
        // periodic). Advisory: it does not gate block processing, only makes the halt visible.
        await this.checkDecoderReorgHalt();

        // Get last processed block from Indexer and Decoder databases
        let lastDecoderBlock   = await this.decoderDb.getBlockIndex('decoder', 'last');
        this.lastDecoderBlock  = lastDecoderBlock;
        let lastIndexerBlock   = await indexerReorgView.getBlockIndex('indexer', 'last');
        return { lastProcessedReorgId: lastProcessedReorgId, unprocessedReorgs: unprocessedReorgs,
                 lastDecoderBlock: lastDecoderBlock, lastIndexerBlock: lastIndexerBlock };
    }

    // One pass of the block loop: read the cursors, roll back to any unprocessed decoder
    // reorg, catch up to the decoder tip, then fold the pass into the mirror-barrier hold
    // and the synced flag.
    async pollDecoderOnce(indexerReorgView, REORG_RECHECK_BLOCKS){
        let { lastProcessedReorgId, unprocessedReorgs, lastDecoderBlock, lastIndexerBlock } =
            await this.readPollCursors(indexerReorgView);
        // Define placeholders for block parsing status
        let firstDecoderBlock     = null;

        // Deepest-rollback reorg handling (applyPendingReorgs).
        if(unprocessedReorgs.length > 0){
            let rolled = await this.applyPendingReorgs(indexerReorgView, unprocessedReorgs, lastIndexerBlock);
            lastIndexerBlock     = rolled.lastIndexerBlock;
            lastProcessedReorgId = rolled.lastProcessedReorgId;
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
                getLogger().info('Resuming block parsing at block ' + startBlock + '...');
        }

        let caughtUp = await this.catchUpToDecoder(indexerReorgView, REORG_RECHECK_BLOCKS,
                                                   lastProcessedReorgId, lastIndexerBlock, lastDecoderBlock);
        lastIndexerBlock = caughtUp.lastIndexerBlock;
        lastDecoderBlock = caughtUp.lastDecoderBlock;

        // The catch-up loop has stopped, either caught up or because a barrier deferred
        // the block at the head of the queue. Fold that into the mirror-barrier hold so a
        // block that keeps being deferred across passes is measured against the named
        // ceiling instead of retrying forever behind identically-healthy-looking log
        // lines. A no-op when nothing is stalled; see noteBarrierHold.
        this.noteBarrierHold(this.util.isNull(lastIndexerBlock) ? null : Number(lastIndexerBlock) + 1);

        // Set flag to indicate fully synced and listening for block
        if(!this.synced && !this.util.bclt(lastIndexerBlock, lastDecoderBlock)){
            this.synced = true;
            getLogger().info('Listening for blocks...');
        }
    }

    // Handle block reorgs. When two or more reorgs land between indexer iterations and a
    // newer event is SHALLOWER than an older one, processing only the latest leaves
    // orphaned rows below the older, deeper reorg point (a consensus-divergence and
    // double-count source). So roll back once to the DEEPEST (minimum) block index across
    // every unprocessed reorg, and record each event in id order so the processed-id cursor
    // advances to the newest decoder event. Always record; only roll back if the indexer
    // has already indexed past the deepest reorg block.
    // Returns the re-read resume cursor and the refreshed processed-reorg cursor.
    async applyPendingReorgs(indexerReorgView, unprocessedReorgs, lastIndexerBlock){
        let minReorgBlock = null;
        for(let reorg of unprocessedReorgs){
            if(minReorgBlock === null || reorg.block_index < minReorgBlock)
                minReorgBlock = reorg.block_index;
        }
        getLogger().info("Detected " + unprocessedReorgs.length + " block reorganization(s); deepest at block #", minReorgBlock);
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
        for(let reorg of unprocessedReorgs){
            // Capture the decoder event's time + payload hash as the marker
            // witness, so a later out-of-band decoder rebuild that reuses this id for a
            // different event is caught (the fail-loud reorg-cursor-incoherent error) instead of silently skipped.
            let witness = await this.decoderDb.getReorgEventWitness(reorg.id);
            await indexerReorgView.createReorg(reorg.block_index, reorg.id,
                witness ? witness.time : null, witness ? witness.hash : null);
        }

        // Refresh the local cursor to the durable value just advanced by createReorg.
        // lastProcessedReorgId was read once at the top of the outer loop and is never
        // otherwise updated, so the mid-catch-up reorg recheck below would call
        // getReorgsSince() with the stale pre-processing id, re-select the reorg(s) we
        // just recorded (their event ids are all > the stale id), and break to the outer
        // loop once per processed reorg. Re-reading the newest recorded marker id (rather
        // than assuming getReorgsSince ordering) keeps the recheck comparing against the
        // true cursor. This never masks an unprocessed reorg: any reorg with id greater
        // than the refreshed cursor still selects on the next probe.
        let lastProcessedReorgId = await indexerReorgView.getLastProcessedReorgId();
        return { lastIndexerBlock: lastIndexerBlock, lastProcessedReorgId: lastProcessedReorgId };
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

    // Bounded reorg-detection latency during long catch-up. Reorg events are
    // otherwise fetched only at the top of the OUTER loop, and the per-block decoder-tip
    // refresh keeps this inner loop running as long as the tip moves - so a decoder reorg
    // that lands mid-catch-up is not detected until the node is fully caught up, and until
    // then the loop commits hash-chained blocks built on old-chain state (served via
    // getblockhashes / pushed to the hub). Cheaply re-check every REORG_RECHECK_BLOCKS
    // blocks and break to the outer loop, which performs the deepest-rollback + replay.
    // Bounds the mixed-chain window to REORG_RECHECK_BLOCKS instead of the whole backlog;
    // convergence is unchanged (the eventual rollback unwinds every block >= the reorg).
    async reorgLandedMidCatchUp(indexerReorgView, lastProcessedReorgId, lastIndexerBlock, REORG_RECHECK_BLOCKS){
        if((Number(lastIndexerBlock) % REORG_RECHECK_BLOCKS) !== 0) return false;
        // Witness the cursor here too (same under-cursor protection).
        let midCursorWitness = (lastProcessedReorgId != null)
                                ? await indexerReorgView.getLastProcessedReorgWitness() : null;
        let midReorgs = await this.decoderDb.getReorgsSince(lastProcessedReorgId, midCursorWitness);
        if(midReorgs.length === 0) return false;
        getLogger().info('Detected a decoder reorg mid-catch-up; breaking to handle it before block ' + (Number(lastIndexerBlock) + 1));
        return true;
    }

    // Parse one block: the train gate, its inputs, the mirror barriers, then the block
    // transaction. Returns { committed, stop, lastDecoderBlock } to the catch-up loop; a
    // gate or barrier defer commits nothing and stops the pass, and the block is retried.
    async parseBlock(blockToParse, lastIndexerBlock, lastDecoderBlock, debugTimer){
        let deferred = { committed: false, stop: true, lastDecoderBlock: lastDecoderBlock };

        // PLATFORM-TRAIN ACTIVATION GATE. Runs
        // BEFORE anything about this block is read, because the decision is "may this
        // node apply block N at all", not "what does block N contain". A node whose
        // code carries no entry for the rule set its signed release manifest requires
        // STOPS here rather than applying the block under the old rules: continue-old
        // writes forked state and answers queries from it, and the sync followers would
        // halt on the divergence one block later anyway, after the damage.
        if(await this.checkTrainActivation(blockToParse)){
            // Defer with the same semantics as the barriers below: lastIndexerBlock is
            // not advanced, no transaction is open, and the outer loop retries. Unlike a
            // barrier this does NOT self-clear; only a build that implements the required
            // rule set clears it, which is what `xchain-node update` installs.
            return deferred;
        }

        let { blockTransactions, anchorHorizonBound, blockTime, rawBlockTime } = await this.readBlockInputs(blockToParse);
        if(await this.deferOnSyncBarriers(blockToParse, blockTime, blockTransactions, anchorHorizonBound))
            return deferred;
        return await this.processBlock({ blockToParse, blockTime, rawBlockTime, blockTransactions },
                                       lastIndexerBlock, lastDecoderBlock, debugTimer);
    }

    // The block's transactions and its two clocks, read before any barrier or transaction.
    async readBlockInputs(blockToParse){
        // Get a list of any transactions in this block from the decoder database
        let blockTransactions = await this.decoderDb.getDecoderBlockData(blockToParse);

        // Collapse the reader-side per-output fan-out (see src/chain/output_fanout.js).
        // getDecoderBlockData emits one row per stored native-coin output, each carrying
        // the same tx data; without this, a data-bearing action whose transaction also
        // pays a dispenser and/or a fee-destination output would be executed once per
        // output row (duplicate credits/debits). COINPAY payment settlement and empty-data
        // DISPENSE triggers keep their per-output fan-out. Consensus-gated on
        // FIX_OUTPUT_FANOUT; below activation a multi-output data-bearing tx aborts the
        // block loudly (via the watchdog/rollback path) instead of double-executing.
        let fanoutFixActive = await this.protocolChanges.isEnabled('FIX_OUTPUT_FANOUT', blockToParse);
        blockTransactions = collapseOutputFanout(blockTransactions, fanoutFixActive, (m) => this.util.logError(m));

        // Lookup the block time for a given block (read from decoder DB before opening transaction).
        //
        // TWO values, deliberately. blockTime is PROTOCOL time (median-time-past on
        // the networks switched to it) and drives every barrier and time-keyed read
        // below, so that a miner-chosen stamp dated into the future cannot make this
        // node wait for wall clock or read a still-growing mirror window. rawBlockTime
        // is the block's own stamp, and is what gets PERSISTED and published, so the
        // timestamp a user sees on a block stays the real one.
        // The anchor-attest barrier's maturity-horizon bound, resolved BEFORE the
        // block's own protocol-time read below: getBlockTime memoizes exactly one
        // height, and taking the horizon afterwards would evict the memo that
        // protocol_changes.js re-reads later in this same block.
        let anchorHorizonBound = await this.anchorAttestHorizonBound(blockToParse);

        let blockTime    = await this.decoderDb.getBlockTime(blockToParse);
        let rawBlockTime = await this.decoderDb.getRawBlockTime(blockToParse);

        // Re-stamp the transaction rows with protocol time before anything reads
        // them. getDecoderBlockData carries block_time straight from the decoder's
        // blocks table, and actions.js processTransaction lifts tx.block_time into
        // data['BLOCK_TIME'], which every handler hands to the time-ranged price and
        // oracle reads. Leaving the raw stamp there while the barriers below run on
        // protocol time is the forking combination: the block would be released up
        // to ~2h before wall clock reached its stamp, and the price window scanned
        // for it would still be gaining rounds, so two nodes reading at different
        // instants credit different amounts. Barriers and reads move together or
        // not at all.
        protocolTime.stampProtocolTime(blockTransactions, blockTime);
        return { blockTransactions: blockTransactions, anchorHorizonBound: anchorHorizonBound,
                 blockTime: blockTime, rawBlockTime: rawBlockTime };
    }

    // The mirror sync barriers in block-loop order. Each returns true when it DEFERRED the
    // block (stallReason set, no transaction open); the first defer ends the chain and the
    // loop retries the block on its next pass.
    async deferOnSyncBarriers(blockToParse, blockTime, blockTransactions, anchorHorizonBound){
        // Only blocks that can actually READ the mirror take these waits.
        // The hub finalizes one price round per 600s, the same cadence as a BTC
        // block, so a tip block is essentially never covered by a round anchored at
        // or after it and burns the full timeout every time. A block that reads no
        // price is byte-identical against a current mirror and a stale one, so that
        // wait buys nothing. blockMayReadPrice is a deliberate over-approximation
        // (see price_read_predicate.js): any transaction at all means wait, and the
        // end-of-block passes, which can run the VM on a transaction-free block, are
        // caught fail-closed at the read itself by db.assertPriceBarrierNotSkipped().
        // Safe without a flag day because a skipped barrier changes no hashed value,
        // only whether this node paused first.
        let mayReadPrice = this.evaluatePriceBarrier(blockToParse, blockTransactions);
        return await this.deferOnPriceSync(blockToParse, blockTime, mayReadPrice)
            || await this.deferOnOracleSync(blockToParse, blockTime, mayReadPrice)
            || await this.deferOnMatchSync(blockToParse, blockTime)
            || await this.deferOnCallSync(blockToParse, blockTime)
            || await this.deferOnBridgeSync(blockToParse, blockTime)
            || await this.deferOnPolicySync(blockToParse, blockTime)
            || await this.deferOnDirectCallPresence(blockToParse, blockTime)
            || await this.deferOnAnchorAttestSync(blockToParse, blockTime, anchorHorizonBound)
            || await this.deferOnAttestResponseSync(blockToParse, blockTime)
            || await this.deferOnSnapshotSync(blockToParse, blockTime);
    }

    // Price-sync barrier: don't process this block until the local price mirror has
    // caught up to it. Native-coin fee validation reads the latest finalized price
    // round at or before the block height; if two operators hold different sync
    // states they can read different rounds, compute different fee thresholds, and
    // diverge the ledger. Waiting until the mirror covers this block closes that race.
    //
    // Price rounds are anchored to BTC block heights, so this height comparison is
    // only meaningful for a BTC indexer; other chains' block heights are not
    // comparable to the anchor. Non-BTC chains gate on the time-keyed barrier
    // instead, so the mirror must hold every round with block_timestamp <= this
    // block's time. No barrier when hub-db sync is disabled (single-host: the local
    // hub DB is the hub itself, always current).
    //
    // The time-keyed barrier is NOT conditioned on the
    // NATIVE_FEE_PRICE_TIME_GATE flag-day. It was first introduced as the
    // twin of that gate's fee-validation change (the time-keyed db.getLatestPrice
    // selectByTime), but native fees are not the only time-keyed reader of
    // price_snapshots. FIAT dispenser settlement reads the table bounded on
    // `block_timestamp <= this block's time` on EVERY chain from day one, in both
    // modes: reversePriceMatch directly, and reverseOraclePriceMatch for the
    // validator coin price behind a user oracle quote. Gating the barrier on the
    // fee flag-day therefore left LTC/DOGE mainnet settling FIAT dispenses against
    // an unbarriered mirror below 1786060800, where two operators with different
    // mirror states credit different token amounts for the same payment and fork
    // the chain. The barrier now runs whenever sync is enabled.
    //
    // Widening a barrier is safe in both directions that matter. It cannot fork:
    // it is a node-local WAIT decision, never persisted or hashed, so a reindex
    // (mirror far ahead of the tip) opens it immediately and replays byte-identically
    // (see the HUB_SYNC_WATERMARK_GRACE_S note in hub_db_sync.js on why barriers
    // need no activation gate). It cannot freeze a quiet chain either:
    // _priceTimeSyncSatisfied's second case opens on the hub's stream watermark, so
    // a chain with no rounds yet, or sitting in a round gap, proceeds once the hub
    // confirms it has sent everything through this instant. Only a genuinely-behind
    // mirror (hub unreachable, watermark frozen) defers, which is the intent.
    // Strictly-stricter than the fee query below the flag-day, which is the safe
    // direction: an extra wait can delay a block but can never change its verdict.
    // The two barriers are ADDITIVE on BTC, not alternatives. The height
    // barrier alone does NOT imply time coverage, and FIAT settlement reads by
    // time, so BTC needed the time barrier as much as LTC/DOGE did.
    //
    // Why the height check is not sufficient. `_priceSyncSatisfied`'s first case is
    // a pure `priceSyncHeight >= blockHeight` test, where priceSyncHeight is the max
    // `reference_block` in the local mirror. A round's `reference_block` is the BTC
    // height it anchors to; its `block_timestamp` is the wall-clock instant the
    // validators STAMPED it (xchain-hub PriceAggregator: both arrive together in the
    // round push, and the two are independent quantities). Bitcoin lets a miner
    // timestamp a block up to 2 hours ahead of network-adjusted time, so a
    // forward-dated block H is processed with a `blockTime` that real wall-clock has
    // not reached yet. One local round anchored at >= H satisfies the height barrier
    // immediately, while for the next two hours the hub keeps finalizing rounds whose
    // `block_timestamp` is still <= blockTime and therefore still INSIDE the
    // `[blockTime - FIAT_DISPENSER_PRICE_WINDOW, blockTime]` range that
    // getPricesInTimeRange scans, each one newer than the last under its
    // `block_timestamp DESC, round_number DESC` ordering. Two operators whose mirrors
    // stopped at different rounds in that window read a different newest price,
    // reversePriceMatch floors a different unit count, and the dispense credits a
    // different amount: a fork. A fresh resync is the worst case, because its mirror
    // holds every one of those rounds while the live node that first processed H
    // held none of them. That is exactly the live-node-vs-resync divergence the
    // mirror barriers exist to close, and the height-keyed one does not close it.
    //
    // The height barrier is RETAINED rather than replaced: below the
    // NATIVE_FEE_PRICE_TIME_GATE flag-day, native-fee validation still selects the
    // latest round by HEIGHT (db.getLatestPrice), so dropping it would un-barrier the
    // fee path and diverge a from-genesis replay. The two gate different readers of
    // the same table and both are needed.
    //
    async deferOnPriceSync(blockToParse, blockTime, mayReadPrice){
        if(this.hubDbSync && mayReadPrice && this.config['COIN'] === 'BTC'){
            try {
                await this.hubDbSync.waitForPriceSyncHeight(blockToParse, this.priceSyncTimeoutMs, blockTime);
            } catch(err){
                // Defer the block: lastIndexerBlock is not advanced, so the outer loop
                // retries this same block after the sleep interval rather than processing
                // it against a stale price copy. No transaction is open yet.
                getLogger().warn('Deferring block ' + blockToParse + ' (price sync): ', err);
                this.stallReason = 'price_sync_barrier';
                this.stallClearsAt = null;          // the height case can clear early
                return true;
            }
        }
        if(this.hubDbSync && mayReadPrice){
            try {
                await this.hubDbSync.waitForPriceSyncTime(blockTime, this.priceSyncTimeoutMs, blockToParse);
            } catch(err){
                // Same defer semantics as the height barrier above.
                getLogger().warn('Deferring block ' + blockToParse + ' (price time-sync): ', err);
                this.stallReason = 'price_sync_barrier';
                // This barrier waits on WALL CLOCK. It is satisfied once a
                // round at/past blockTime is mirrored, or the hub's stream watermark
                // passes blockTime + grace; both advance only as real time does. Record
                // that instant so a future-stamped block is not reported as a wedge
                // while the wait is expected and self-clearing.
                this.stallClearsAt = this.barrierClearsAtHeightAware(blockTime, 'priceWatermarkGraceS', blockToParse);
                return true;
            }
        }
        return false;
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
    // Same barrier gate as the price barriers above: oracle_prices has the same
    // reader set (FIAT settlement via reverseOraclePriceMatch, the DISPENSER
    // create's oracle-fee quote), so a block that reaches neither reads nothing
    // here either, and the choke-point assertion covers the rest.
    async deferOnOracleSync(blockToParse, blockTime, mayReadPrice){
        if(this.hubDbSync && mayReadPrice){
            try {
                await this.hubDbSync.waitForOracleSyncTimestamp(blockTime, this.priceSyncTimeoutMs, blockToParse);
            } catch(err){
                // Defer the block (same retry semantics as the price barrier above): the
                // counter is not advanced, so this block is retried rather than settled
                // against a stale oracle copy. No transaction is open yet.
                getLogger().warn('Deferring block ' + blockToParse + ' (oracle sync): ', err);
                this.stallReason = 'oracle_sync_barrier';
                this.stallClearsAt = this.barrierClearsAtHeightAware(blockTime, 'oracleWatermarkGraceS', blockToParse);
                return true;
            }
        }
        return false;
    }

    // Cross-chain match sync barrier: wait until the local cross_chain_matches
    // mirror has caught up to this block's time, so every operator of this chain
    // settles the same cross-chain matches at the same block. No-op when sync is
    // disabled or the mirror holds no cross-chain matches.
    async deferOnMatchSync(blockToParse, blockTime){
        if(this.hubDbSync){
            try {
                await this.hubDbSync.waitForMatchSync(blockTime, this.priceSyncTimeoutMs, blockToParse);
            } catch(err){
                getLogger().warn('Deferring block ' + blockToParse + ' (cross-chain match sync): ', err);
                this.stallReason = 'match_sync_barrier';
                this.stallClearsAt = this.barrierClearsAtHeightAware(blockTime, 'matchWatermarkGraceS', blockToParse);
                return true;
            }
        }
        return false;
    }

    // Cross-chain call sync barrier: wait until the local cross_chain_calls
    // mirror has caught up to this block's time, so every operator of this chain
    // injects/delivers the same cross-chain calls at the same block. No-op when
    // sync is disabled or the mirror holds no relay rows.
    async deferOnCallSync(blockToParse, blockTime){
        if(this.hubDbSync){
            try {
                await this.hubDbSync.waitForCallSync(blockTime, this.priceSyncTimeoutMs, blockToParse);
            } catch(err){
                getLogger().warn('Deferring block ' + blockToParse + ' (cross-chain call sync): ', err);
                this.stallReason = 'call_sync_barrier';
                // callWatermarkGraceS, NOT the match grace: callSyncSatisfied waits on
                // the call grace, and the two producers stamp effective_time differently
                // (hub_db_sync.js HUB_SYNC_WATERMARK_GRACE_S.call). Keying the health
                // verdict on the match value would mis-time the wedge discriminator the
                // moment the two constants diverge or a regtest override moves one.
                this.stallClearsAt = this.barrierClearsAtHeightAware(blockTime, 'callWatermarkGraceS', blockToParse);
                return true;
            }
        }
        return false;
    }

    // Bridge transfer sync barrier: wait until the local bridge_transfers mirror
    // has caught up to this block's time, so every operator of this chain mints
    // the same bridged credits at the same block. A transfer's apply assigns an
    // action index, so a node that applied a smaller set at this height would
    // commit different actions_hash and ledger_hash for a block its peers agree
    // on. No-op when sync is disabled or the mirror holds no transfers.
    async deferOnBridgeSync(blockToParse, blockTime){
        if(this.hubDbSync){
            try {
                await this.hubDbSync.waitForBridgeSync(blockTime, this.priceSyncTimeoutMs, blockToParse);
            } catch(err){
                getLogger().warn('Deferring block ' + blockToParse + ' (bridge transfer sync): ', err);
                this.stallReason = 'bridge_sync_barrier';
                // bridgeWatermarkGraceS, never the match or call grace: the bridge
                // engine is a third producer with its own effective_time stamping rule,
                // and sharing another table's grace couples two producers' timing, the
                // documented mistake the call barrier was split out to end.
                this.stallClearsAt = this.barrierClearsAtHeightAware(blockTime, 'bridgeWatermarkGraceS', blockToParse);
                return true;
            }
        }
        return false;
    }

    // Policy snapshot sync barrier: its own barrier and not a reuse of the bridge
    // one, because policy_snapshots is keyed on origin_chain alone (a snapshot
    // names no destination, so there is no (src, dest) pair to scope by) and
    // carries its own watermark grace. The snapshots materialize membership that
    // GATES the credits the bridge pass then applies, so a stale policy mirror
    // would let one node admit a transfer another node's membership refuses.
    async deferOnPolicySync(blockToParse, blockTime){
        if(this.hubDbSync){
            try {
                await this.hubDbSync.waitForPolicySync(blockTime, this.priceSyncTimeoutMs, blockToParse);
            } catch(err){
                getLogger().warn('Deferring block ' + blockToParse + ' (policy snapshot sync): ', err);
                this.stallReason = 'policy_sync_barrier';
                this.stallClearsAt = this.barrierClearsAtHeightAware(blockTime, 'policyWatermarkGraceS', blockToParse);
                return true;
            }
        }
        return false;
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
    // (regtest) case clears on the first query with no added latency. Above the
    // mirror-admission activation the same wait is keyed on the hub's persisted
    // height watermark for this chain instead, so blockToParse rides along.
    async deferOnDirectCallPresence(blockToParse, blockTime){
        if(!this.hubDbSync && this.hubDb){
            try {
                await this.waitForDirectCallPresence(blockTime, blockToParse);
            } catch(err){
                getLogger().warn('Deferring block ' + blockToParse + ' (direct call-presence barrier): ', err);
                this.stallReason = 'call_presence_barrier';
                // The barrier now HAS a time-keyed escape (hub clock >= block_time +
                // call grace), so this stall does have a first-clearable instant and
                // /status can say so instead of reporting an open-ended stall on a
                // future-stamped block. Keyed on this node's wall clock while the
                // barrier itself reads the hub's: the two are the same host in the
                // single-host topology this barrier serves, and this value gates no
                // wait, no read and no write (health verdict only, see barrierClearsAt).
                // Null above the admission activation, where no clock instant opens it.
                this.stallClearsAt = this.directCallBarrierClearsAt(blockTime, blockToParse);
                return true;
            }
        }
        return false;
    }

    // Anchor-reward attestation mirror-completeness barrier. The BTC-side derive
    // pass below mints COLLECT-spendable rewards at a height fixed fleet-wide
    // (snapshot_block + ANCHOR_REWARD_MIRROR_MATURITY), so a node that has not
    // received a matured attestation by that height must NOT commit the block with a
    // smaller reward set: it would fork the ledger hash for a block its peers agree
    // on. Defer instead, exactly like the barriers above. BTC-only (nothing derives
    // elsewhere) and inert until the operator arms the derive flag-day, but the wait
    // itself is cheap and unconditional on BTC so a node cannot advance into an armed
    // boundary with a stale mirror.
    async deferOnAnchorAttestSync(blockToParse, blockTime, anchorHorizonBound){
        if(this.hubDbSync && this.config['COIN'] === 'BTC'){
            try {
                await this.hubDbSync.waitForAnchorAttestationSync(blockTime, this.priceSyncTimeoutMs, anchorHorizonBound, blockToParse);
            } catch(err){
                getLogger().warn('Deferring block ' + blockToParse + ' (anchor-reward attestation mirror): ', err);
                this.stallReason = 'anchor_attest_barrier';
                this.stallClearsAt = this.anchorBarrierClearsAt(
                    blockTime, anchorHorizonBound, blockToParse, 'anchorAttestWatermarkGraceS');
                return true;
            }
        }
        return false;
    }

    // Finalized ATTEST response mirror barrier. A mirrored attestation_responses
    // row binds at the first block whose protocol time reaches its signed
    // effective_time, and that block fires the contract callback, mints the
    // synthetic v1 action and settles the request fee. A node that has not
    // received the row by then does not lag, it forks: it commits that block with
    // the callback un-fired while its peers commit it fired, and nothing later
    // re-binds. So it defers, with no chain-only escape (see hub_db_sync.js).
    // Armed on EVERY BTC block with no transaction predicate: the binding
    // condition is a time, so a row can bind at a block carrying no ATTEST
    // transaction at all, and there is nothing to scope the wait to. BTC-only,
    // because all attestation stake and every request lives on BTC.
    async deferOnAttestResponseSync(blockToParse, blockTime){
        if(this.hubDbSync && this.config['COIN'] === 'BTC'){
            try {
                await this.hubDbSync.waitForAttestationResponseSync(blockTime, this.priceSyncTimeoutMs, blockToParse);
            } catch(err){
                getLogger().warn('Deferring block ' + blockToParse + ' (attestation response mirror): ', err);
                this.stallReason = 'attest_response_sync_barrier';
                this.stallClearsAt = this.barrierClearsAtHeightAware(blockTime, 'attestResponseWatermarkGraceS', blockToParse);
                return true;
            }
        }
        return false;
    }

    // Cross-chain capability-snapshot barrier: wait until the capability snapshot
    // for every effective cross-chain match AND call relay row has mirrored in, so
    // neither is ever skipped (and applied later at a per-operator-variable height)
    // for a missing snapshot. Defers the block on timeout, same as the barriers above.
    async deferOnSnapshotSync(blockToParse, blockTime){
        if(this.hubDbSync){
            try {
                await this.hubDbSync.waitForSnapshotSync(blockTime, this.priceSyncTimeoutMs, blockToParse);
            } catch(err){
                getLogger().warn('Deferring block ' + blockToParse + ' (cross-chain snapshot sync): ', err);
                this.stallReason = 'snapshot_sync_barrier';
                this.stallClearsAt = null;          // snapshot presence, not wall clock
                return true;
            }
        }
        return false;
    }

    // Open the block's transaction and install its per-block write state. Returns whether
    // the light-client state commitment is active for this block.
    async openBlockTransaction(blockToParse){
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
        // insert would bump MAX(id) and silently offset the dense counter.
        this.indexerDb.deterministicIndexingStarted = true;
        // Light-client state commitment: when active, install a
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
        return stateCommitActive;
    }

    // Apply one block in its own indexer transaction: open it, run every pass under the
    // block watchdog, commit, then the post-commit steps. Returns { committed, stop,
    // lastDecoderBlock } to the catch-up loop. Any failure rolls the block back and stops
    // the pass (abandonBlock); `committed` stays true when only a post-commit step threw.
    async processBlock(blk, lastIndexerBlock, lastDecoderBlock, debugTimer){
        let blockToParse = blk.blockToParse;
        let stateCommitActive = await this.openBlockTransaction(blockToParse);
        let committed = false;
        try {

            // Fence the block's writes to THIS transaction's epoch. Read the
            // epoch that beginTransaction just assigned, then run all block processing
            // under it (runInTxEpoch) so every DB write it issues carries this epoch.
            // If the watchdog below fires, the outer catch rolls back and bumps the
            // epoch; the abandoned promise (which may still resume and try to write on
            // the shared connection now owned by a later block) then carries a stale
            // epoch and is rejected inside the db layer before touching the driver.
            let txEpoch = this.indexerDb.currentTxEpoch();

            // Process the block with a watchdog timeout to detect deadlocks or infinite loops
            let blockProcessing = this.indexerDb.runInTxEpoch(txEpoch, () => this.runBlockPasses(blk, stateCommitActive));

            // Watchdog-timeout safety. If the watchdog rejects below, we stop
            // awaiting blockProcessing but the promise stays pending and may settle
            // later (typically the epoch fence rejecting a zombie write, or the block
            // finally finishing). Attach a swallow handler so that late settlement can
            // never surface as an unhandledRejection that crashes the process. The
            // epoch fence, not this handler, is what prevents the zombie's writes from
            // landing; this only keeps the abandoned promise's rejection quiet.
            blockProcessing.catch((e) => {
                getLogger().warn('Abandoned block-processing promise for block ' + blockToParse +
                    ' settled after watchdog: ' + (e && e.message ? e.message : e));
            });

            let blockTimeout = this.blockWatchdogTimeout(blockToParse);
            let [ledger, actions, contracts] = await this.util.withTimeout(blockProcessing, blockTimeout, 'block ' + blockToParse);

            // Commit the block data to the database
            await this.indexerDb.commitTransaction();
            committed = true;

            lastDecoderBlock = await this.afterBlockCommit(blk, [ledger, actions, contracts], lastDecoderBlock, debugTimer);
            return { committed: committed, stop: false, lastDecoderBlock: lastDecoderBlock };
        } catch(error){
            await this.abandonBlock(error, committed ? blockToParse : lastIndexerBlock);

            // Exit the inner catch-up loop on failure. lastIndexerBlock was not advanced
            // (the assignment above only runs after a successful commit), so the outer loop
            // re-fetches it from the DB and retries this same block after the sleep interval,
            // instead of falling through and silently skipping the failed block.
            return { committed: committed, stop: true, lastDecoderBlock: lastDecoderBlock };
        }
    }

    // The genesis block does far more than a normal block, so it gets its own
    // watchdog. The budget follows the PATH it will take (see genesis.inject):
    // importing the precomputed dump finishes in seconds, so it uses the tight
    // GENESIS_DUMP_TIMEOUT_MS; only the CSV re-derivation fallback (~1-2h) needs
    // the generous GENESIS_BLOCK_TIMEOUT_MS. This keeps a tight liveness signal on
    // the normal (dump) path without false-tripping a no-dump node.
    blockWatchdogTimeout(blockToParse){
        let isGenesisBlock = Number(blockToParse) === Number(this.config['GENESIS_BLOCK']) && this.config['GENESIS_BLOCK'];
        let blockTimeout   = this.config['BLOCK_PROCESS_TIMEOUT'];
        if(isGenesisBlock){
            let dumpPath = this.config['GENESIS_DUMP_PATH'];
            blockTimeout = (dumpPath && fs.existsSync(dumpPath))
                ? this.config['GENESIS_DUMP_TIMEOUT_MS']
                : this.config['GENESIS_BLOCK_TIMEOUT_MS'];
        }
        return blockTimeout;
    }

    // Everything a block applies, in consensus order, inside the block transaction's epoch.
    // Moving a pass moves every later action index in the block. Returns the createBlock
    // hash counts [ledger, actions, contracts].
    async runBlockPasses(blk, stateCommitActive){
        await this.runOpeningPasses(blk);
        await this.runSettlementPasses(blk);
        await this.runCrossChainPasses(blk);
        await this.runRewardPasses(blk);
        await this.runClosingPasses(blk);
        return await this.finalizeBlock(blk, stateCommitActive);
    }

    // The VM cache, the genesis injection, matured signing-key rotations, then the block's
    // own transactions.
    async runOpeningPasses({ blockToParse, blockTime, blockTransactions }){
        // Initialize VM compilation cache for this block
        if(this.actions.vm)
            this.actions.vm.beginBlock();

        // Genesis ledger bootstrap: at the configured genesis block, inject the
        // Counterparty/Dogeparty name-ownership ISSUE/TRANSFER actions BEFORE any
        // real transaction, so they take the lowest action indexes in the block.
        // No-op on every other block. See genesis.js.
        await this.genesis.inject(blockToParse, blockTime);

        // Materialize any DELEGATE v1 signing-key rotation whose activation delay
        // has elapsed onto the contract_stakes rows it governs, BEFORE this
        // block's transactions, so the rotated key owns the stake for every read
        // this block makes (VM stake snapshot, UNSTAKE aggregate, SLASH
        // deduction) starting exactly at its activation block. Flag-day gated
        // (CONTRACT_DELEGATION_MATERIALIZE); a no-op below it and on any block
        // with no matured rotation. See utility.processContractDelegationMaterializations.
        await this.util.processContractDelegationMaterializations(this.actions, this.indexerDb, blockToParse);

        // Loop through any block transactions and process them
        for(const tx of blockTransactions)
            await this.actions.processTransaction(tx);
    }

    // Expirations, BET, the cross-chain DEX settlement and the pinned XBRIDGE settle pass.
    async runSettlementPasses({ blockToParse, blockTime }){
        // Check for any expired items (orders, swaps, dispensers)
        await this.util.processExpirations(this.actions, this.indexerDb, blockToParse, blockTime);

        // BET end-of-block pass: latch feeds closed at DEADLINE, then
        // expire feeds past expire_at (system BET_EXPIRE refunds). Both
        // steps are bounded per block (deliberately NOT part of the
        // unbounded processExpirations scan above); see
        // Utility.processBetPasses for the ordering/deferral rules
        await this.util.processBetPasses(this.actions, this.indexerDb, blockToParse, blockTime);

        // Settle this chain's leg of any effective cross-chain DEX matches
        // (validator-signed, mirror-delivered; verified inside CROSS_SETTLE)
        await this.util.processCrossChainSettlements(this.actions, this.indexerDb, blockToParse, blockTime);

        // XBRIDGE settle pass: materialize any hub-mirrored token policy
        // snapshot and then apply this chain's leg of every effective,
        // unapplied bridge transfer (the injected XBRIDGE v2 / v5 legs).
        //
        // THE POSITION IS PINNED AND IS NOT A STYLE CHOICE. It assigns action
        // indexes, so it is consensus-visible, and sitting here - after the
        // cross-chain DEX settlement and before the cross-chain call pass -
        // is what makes a bridged credit bound at block B spendable at B+1 on
        // every node and never at B. Moving it moves every later action index
        // in the block. Runs behind the bridge and policy sync barriers above
        // (themselves behind the snapshot barrier), so the mirror rows and the
        // capability rows the quorum is verified against are already present.
        //
        // Throws BridgeProofUnavailableError when the bridge escrow cross-check
        // cannot be supplied a proof yet; the catch below defers the block
        // rather than letting an absence read as a refusal.
        await bridgeSettle.processBridgeSettlePass({
            actions:    this.actions,
            indexerDb:  this.indexerDb,
            util:       this.util,
            mapper:     this.mapper,
            config:     this.config,
            coin:       this.config['COIN'],
            network:    this.config['NETWORK'],
            blockIndex: blockToParse,
            blockTime:  blockTime
        });
    }

    // Cross-chain contract calls, then the pinned ATTEST response pass.
    async runCrossChainPasses({ blockToParse, blockTime }){
        // Cross-chain contract calls: inject executions for dispatches
        // targeting this chain, deliver result callbacks for requests it
        // originated, and expire requests past their deadline (all
        // validator-signed / block-height-deterministic; see
        // utility.processCrossChainCalls)
        await this.util.processCrossChainCalls(this.actions, this.indexerDb, blockToParse, blockTime);

        // Apply any hub-mirrored ATTEST response whose SIGNED effective_time
        // this block's protocol time has reached: verify it through the shared
        // response verifier, synthesize the v1 action, fire the contract
        // callback and settle the request fee (see
        // utility.processAttestationResponses).
        //
        // THE POSITION IS PINNED AND IS NOT A STYLE CHOICE. The VM's
        // attestation snapshot is INCLUSIVE of the current block
        // (db.getAttestationDataForVM), so a response applied before this
        // block's transaction loop would be visible to an EXECUTE inside the
        // same block on a node that had the mirror row and invisible on one
        // that got it a second later. Here, after the transaction loop and
        // before the deadline-expiry sweep, no EXECUTE in B sees a response
        // bound at B and every EXECUTE in B+1 does, on every node. Running it
        // before the sweep is what makes a response satisfied exactly AT the
        // deadline block apply rather than lose to the expiry.
        //
        // BTC-only, matching the barrier above and for the same reason: all
        // attestation capability stake, and therefore every responsible set,
        // lives on BTC. Inert below the activation height.
        if(this.config['COIN'] === 'BTC')
            await this.util.processAttestationResponses(this.actions, this.indexerDb, blockToParse, blockTime);
    }

    // Anchor/archive reward derivation, the ROLLCALL epoch close and recovery-restored rewards.
    async runRewardPasses({ blockToParse }){
        // Derive matured anchor/archive publisher rewards from the
        // hub-mirrored anchor_reward_attestations rows (re-verifying the XANCPUB
        // quorum against this node's own oracle_publish set, AND re-proving the DOGE
        // anchor mined via this.anchorProof). BTC-only + gated by the
        // derive-relocation flag-day; below the gate (or off-BTC) this is a no-op, so
        // legacy behavior stays byte-identical. Maturity is the fleet-agreed watermark
        // (snapshot_block + ANCHOR_REWARD_MIRROR_MATURITY), not the current block. The
        // reward lands at block_index = snapshot_block; a null return / empty set is
        // the common case. Throws AnchorProofUnavailableError when a matured reward
        // cannot be proven either way here, which defers the block rather than
        // deriving a set this node's peers would not.
        await anchorRewardDerive.deriveAnchorRewards(this.indexerDb, this.config, blockToParse, this.anchorProof);

        // ROLLCALL epoch close (validator liveness eviction). BTC-only and
        // gated on ROLLCALL_ACTIVATION, so below the gate (or off-BTC) this is a
        // no-op and legacy behavior stays byte-identical. Sits HERE, before the
        // cooldown sweep below, because an eviction mints real `unstakes` rows at
        // this block and the sweep must see them in the same pass. Throws
        // RollcallProofUnavailableError when the epoch cannot be decided from
        // here, which defers the block rather than reading a silent DOGE peer as
        // a federation-wide absence.
        await rollcallClose.closeRollcallEpochs(this.indexerDb, this.config, blockToParse, this.rollcallProof, this.util);

        // Land any RECOVERY-restored anchor/archive reward whose original derive
        // height this block has reached. A node rebuilt from an ANCHOR archive
        // cannot re-derive these (its attestation mirror is exactly what was
        // lost), so recovery stages them and they materialize here, at the same
        // point in the block and at the same height the derivation above would
        // have minted them: earn-block + the fleet-agreed mirror maturity. Same
        // cheap gate as the createAddress hook, so a node with nothing staged
        // (every node not mid-recovery, and every chain but BTC) pays one COUNT(*)
        // for the process lifetime.
        await this.indexerDb.applyPendingRewardsDueAtBlock(blockToParse);
    }

    // Cancellations, attestation expirations, VOTE finalizations and unstake cooldowns.
    async runClosingPasses({ blockToParse, blockTime }){
        // Check for any cancelled items (dispensers)
        await this.util.processCancellations(this.actions, this.indexerDb, blockToParse, blockTime);

        // Check for any attestation requests past their DEADLINE_BLOCK
        await this.util.processAttestationExpirations(this.actions, this.indexerDb, blockToParse, blockTime);

        // Finalize VOTE polls whose window closed (or that early-decide this block)
        await this.util.processVoteFinalizations(this.actions, this.indexerDb, blockToParse, blockTime);

        // Release tokens for unstakes (capability + contract) past their cooldown
        await this.util.processCooldownCompletions(this.actions, this.indexerDb, blockToParse);
    }

    // Close the VM cache, write the blocks row, update the markets, sanity-check supplies
    // and store the state roots. Returns [ledger, actions, contracts].
    async finalizeBlock({ blockToParse, blockTime, rawBlockTime }, stateCommitActive){
        // Clear VM compilation cache for this block
        if(this.actions.vm)
            this.actions.vm.endBlock();

        // Create record in `blocks` table with hashes of the credits/debits/escrows (ledger) and /actions tables
        // rawBlockTime, not blockTime: this row is what the explorer and the
        // SDK show as the block's timestamp, so it carries the chain's own
        // stamp. It is also the window every other node medians to derive
        // protocol time, so persisting a derived value here would compound.
        let [ledger, actions, contracts] = await this.indexerDb.createBlock(blockToParse, rawBlockTime);

        // Create / Update DEX market information
        await this.util.processMarketUpdates(this.indexerDb, blockToParse, blockTime);

        // Do a sanity check to verify that token supplies match data in credits/debits/escrows/balances tables
        await this.indexerDb.sanityCheck(blockToParse);

        // Light-client state commitment: compute + persist
        // the additive state_root + block_merkle_root atomically with the
        // block, after sanityCheck and before commit. Gated by the flag-day;
        // a throw here rolls the whole block back like any other failure.
        if(stateCommitActive){
            let isActivation = stateCommitAct.isStateCommitmentActivationBlock(blockToParse, this.config['NETWORK'], this.config['COIN']);
            await stateCommitment.computeAndStoreRoots(this.indexerDb, this.config['COIN'], this.config['NETWORK'], blockToParse, isActivation);
        }

        return [ledger, actions, contracts];
    }

    // Post-commit steps for the block that just committed: end its stall and hold, log it,
    // push the chain tip, deliver its staged hub pushes and refresh the decoder tip, which
    // it returns.
    async afterBlockCommit({ blockToParse, rawBlockTime }, [ledger, actions, contracts], lastDecoderBlock, debugTimer){
        this.markBlockCommitted(blockToParse);

        // Log the total parse time for this block
        let parseTime = this.util.getTimer(debugTimer);
        getLogger().info('Block Parsed' + "\t: " + blockToParse + ' [ledger:' + ledger + ' actions:' + actions + ' contracts:' + contracts + '] (' + parseTime + ')');

        // Push chain tip to hub (fire-and-forget; never blocks indexing).
        // Network is included so multi-network hubs scope tips correctly
        // (older hubs ignore it; pre-network-aware behavior = 'mainnet').
        // Skip while catching up: during a bulk re-index, pushing a tip for every
        // historical block floods the hub's proxy / rate-limiter (HTTP 429) for no
        // value. The hub only wants the live tip. Only push within
        // CHAIN_TIP_PUSH_MAX_LAG blocks of the decoder tip (lastDecoderBlock here is
        // the prior iteration's value, i.e. at most one block stale, which is fine).
        if(!this.util.bcgt(this.util.bcsub(lastDecoderBlock, blockToParse), this.config['CHAIN_TIP_PUSH_MAX_LAG'])){
            // The chain identity rides the tip push that already exists rather than
            // a new RPC. Resolved here (not only at startup) because a chain that
            // was re-genesised has no block 1 to read when this process boots; the
            // memoized read costs one point query per block until it lands, and
            // nothing is sent until then, which leaves an older hub's wire intact.
            let chainId = await this.resolveBtcChainId();
            // rawBlockTime: the hub publishes this as the chain's tip timestamp to
            // other services, which compare it against wall clock for freshness.
            this.hubClient.pushChainTip(this.config['COIN'], this.config['NETWORK'], blockToParse, rawBlockTime, chainId);
        }

        // Deliver the PRICE hub pushes durably staged inside the just-committed block
        // transaction (mirrors rollback.js's post-commit retraction delivery). Each row
        // already survives a crash here (HubPushQueue drains the survivors on restart);
        // this is only an immediate live-delivery fast path that drops the durable row on
        // success and leaves it for the queue on any failure. Best-effort and never throws
        // into the block loop.
        await this.deliverStagedHubPushes();

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
        return lastDecoderBlock;
    }

    // The block committed, so nothing is stalled or held behind a barrier any more and no
    // price read may be attributed to it.
    markBlockCommitted(blockToParse){
        // A block advanced, so we are no longer stalled. Clear any deferral
        // reason set by a barrier timeout or host fault on a prior iteration, and
        // stamp the commit time so the /status healthcheck can tell an
        // advancing-but-barrier-deferring indexer from a wedged one.
        this.stallReason = null;
        this.stallClearsAt = null;              // the stall is over, so is its deadline
        this.lastBlockCommittedAt = Date.now();
        // Whatever this block was held behind, it is not held any more. Cleared here
        // as well as by nextBarrierHold's block-changed reset so a commit ends the
        // hold immediately, rather than at the next pass through the poll loop.
        this.barrierHold = null;

        // The block is committed, so nothing else may attribute a price
        // read to it. Clearing priceBarrierSkipped keeps the choke-point
        // assertion inert outside block processing, and clearing the force flag
        // (only when THIS block was the escalated one) keeps the escalation a
        // one-shot retry rather than a permanent return to waiting every block.
        this.priceBarrierSkipped = false;
        if(this.priceBarrierForceBlock === blockToParse)
            this.priceBarrierForceBlock = null;
    }

    // Roll back a block that failed after its transaction opened, then record why.
    // `lastIndexerBlock` is the loop's cursor at the fault: the previous block, or this
    // one when it had committed and a post-commit step threw.
    async abandonBlock(error, lastIndexerBlock){
        // Roll back all writes for this block so the DB stays at the end of the previous block
        await this.indexerDb.rollbackTransaction();

        // The block is no longer in flight, so no read can be attributed
        // to it. priceBarrierForceBlock is deliberately NOT cleared here: when
        // this rollback IS the price-barrier escalation, that flag is what makes
        // the retry take the barrier instead of skipping again and looping.
        this.priceBarrierSkipped = false;

        this.noteBlockFault(error, lastIndexerBlock);
    }

    // Name the fault that ended a block: a host or proof fault sets its stall reason and
    // is logged loudly; anything else is logged as a block error.
    noteBlockFault(error, lastIndexerBlock){
        if(this.noteExecutorOrAnchorFault(error, lastIndexerBlock)) return;
        if(this.noteBridgeOrRollcallFault(error, lastIndexerBlock)) return;
        // Log the error
        this.util.logError(`Error while parsing block data at block ${lastIndexerBlock}:`, error);
    }

    // The VM executor or a DOGE anchor proof is unavailable from HERE. Returns true when
    // the fault was one of these two.
    noteExecutorOrAnchorFault(error, lastIndexerBlock){
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
            getLogger().error(`HOST FAULT at block ${lastIndexerBlock}: VM executor unavailable. ` +
                `HALTING block processing (not committing; a fabricated result would fork). ` +
                `Retrying after ${this.config['BLOCK_CHECK_INTERVAL']}ms; will resume when the host recovers.`);
            this.stallReason = 'vm_executor_unavailable';
            this.stallClearsAt = null;          // a host fault has no deadline
            return true;
        }
        if(error && error.name === 'AnchorProofUnavailableError'){
            // A matured anchor reward could not be proven mined on DOGE from HERE.
            // Not a contract or host outcome: deriving it unproven would pay for an
            // anchor that may never have landed, and skipping it would make this
            // node's reward set differ from its peers' at a height they all agree
            // on. Both fork the COLLECT rail, so the block is left uncommitted and
            // retried, loudly, until DOGE visibility returns.
            getLogger().error('ANCHOR REWARD PROOF UNAVAILABLE at block ' + lastIndexerBlock + ': ' +
                (error && error.message) + ' HALTING block processing (not committing; an ' +
                'unproven or partial reward set would fork). Retrying after ' +
                this.config['BLOCK_CHECK_INTERVAL'] + 'ms.');
            this.stallReason = 'anchor_reward_proof_unavailable';
            this.stallClearsAt = null;          // clears when DOGE visibility returns, not on a clock
            return true;
        }
        return false;
    }

    // A bridge escrow proof or a ROLLCALL epoch cannot be decided from HERE. Returns true
    // when the fault was one of these two.
    noteBridgeOrRollcallFault(error, lastIndexerBlock){
        if(error && error.name === 'BridgeProofUnavailableError'){
            // The bridge escrow cross-check could not be handed a proof from HERE: no
            // quorum-established checkpoint at or after the transfer's
            // snapshot_block is held locally, or the origin chain's indexer served
            // none. That is a property of THIS node's mirror and network, not of
            // the row, so it must never read as ok:false - a node that is merely
            // behind would then decide, permanently, that a legitimate transfer is
            // forged, and mint nothing where its peers mint. Defer and retry, the
            // way the sync barriers above defer, with the barrier-shaped stall
            // reason so /status classifies it as mirror lag rather than a wedge.
            getLogger().warn('BRIDGE ESCROW PROOF UNAVAILABLE at block ' + lastIndexerBlock + ': ' +
                (error && error.message) + ' Deferring the block (not committing; an ' +
                'unproven mint is exactly what D2 exists to stop). Retrying after ' +
                this.config['BLOCK_CHECK_INTERVAL'] + 'ms.');
            this.stallReason = 'bridge_proof_barrier';
            this.stallClearsAt = null;          // clears when the checkpoint arrives, not on a clock
            return true;
        }
        if(error && error.name === 'RollcallProofUnavailableError'){
            // A ROLLCALL epoch could not be decided from HERE. Closing it anyway
            // would take the worst possible reading of silence: an unreachable or
            // stale DOGE peer answers "no signatures", which is indistinguishable
            // from the entire federation being absent, and acting on it would evict
            // every validator at once. Deferring is the only outcome that keeps this
            // node's verdict identical to its peers'.
            getLogger().error('ROLLCALL PROOF UNAVAILABLE at block ' + lastIndexerBlock + ': ' +
                (error && error.message) + ' HALTING block processing (not committing; ' +
                'silence is not absence). Retrying after ' +
                this.config['BLOCK_CHECK_INTERVAL'] + 'ms.');
            this.stallReason = 'rollcall_proof_unavailable';
            this.stallClearsAt = null;          // clears when DOGE visibility returns, not on a clock
            return true;
        }
        return false;
    }

    // Poll the hub for PBFT-committed config changes. The startup overlay runs only
    // once; without this loop a governance-committed change to a tunable/display param
    // (i.e. one safe to live-poll; see the consensus exclusion list in mergeHubParams)
    // would not take effect until the indexer process is restarted. We
    // re-apply the overlay only when the hub's committed sequence advances past the
    // last one we applied, so a steady-state poll is a cheap no-op. Against an older
    // hub that returns the bare map, seq stays 0 and the overlay is never re-applied
    // (matching pre-existing startup-only behavior). The timer is unref'd so it never
    // keeps the process alive. Interval is HUB_CONFIG_POLL_INTERVAL_MS (default 60s).
    startHubConfigPolling(){
        if(!this.hubClient || !this.hubClient.configEnabled) return;
        if(this._hubConfigPollTimer) return;
        // Same reader the staleness boundary is derived from, so the reported boundary is
        // always three of THESE intervals.
        const intervalMs = effectiveHubConfigPollIntervalMs();
        // Guarded against self-overlap like startStateTreeMetric below: a
        // getallconfigs call outrunning the interval (restarting/partitioned hub)
        // must not stack overlapping in-flight polls.
        this._hubConfigPollRunning = false;
        this._hubConfigPollTimer = setInterval(async () => {
            if(this._hubConfigPollRunning) return;   // a prior slow poll is still in flight
            this._hubConfigPollRunning = true;
            try {
                await this.pollHubConfigOnce();
            } catch(err) {
                getLogger().warn('XChainIndexer: hub config poll failed, keeping current config:', err.message || err);
            } finally {
                this._hubConfigPollRunning = false;
            }
        }, intervalMs);
        if(this._hubConfigPollTimer.unref) this._hubConfigPollTimer.unref();
    }

}

Object.assign(XChainIndexer.prototype, barrierClockMethods, directCallPresenceMethods, startupMethods,
              hubConfigMethods, trainGateMethods, decoderProbeMethods, backgroundJobMethods);

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
