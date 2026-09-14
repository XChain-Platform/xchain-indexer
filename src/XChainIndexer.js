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
const path      = require('path');
const config    = require('./config.js');
const changes   = require('./protocol_changes.js');
const protocolTime = require('./consensus/protocol_time.js');
const database  = require('./db');
const actions   = require('./actions/index.js');
const util      = require('./utility.js');
const rollback  = require('./rollback.js');
const mapper    = require('./chain/mapper.js');
const stateCommitment   = require('./stateCommitment.js');
const retention         = require('./chain/retention.js');
const stateCommitAct    = require('./state_commitment_activation.js');
const HubClient    = require('./hub/hub_client.js');
const HubDbSync    = require('./hub/hub_db_sync.js');
// The frozen call-barrier grace and its resolver, shared with the direct-hub-DB
// (no-mirror) call-presence barrier so both paths open on the SAME constant.
const { HUB_SYNC_WATERMARK_GRACE_S, resolveWatermarkGrace,
        HUB_SYNC_BARRIER_HOLD_CEILING_S, resolveBarrierHoldCeilingMs } = require('./hub/hub_db_sync.js');
const anchorRewardDerive = require('./consensus/anchor_reward_derive.js');
// The anchor-attest maturity-horizon bound (the parent barrier spec's D-B) and the
// mirror-admission family's consumer gate. Both are read HERE rather than inside
// hub_db_sync.js for the horizon half: the caller computes a plain number and passes it, so
// the mirror client stays dependency-free and re-vendorable into the explorer unchanged.
const { ANCHOR_ATTEST_ARRIVAL_MARGIN_S, ANCHOR_REWARD_MIRROR_MATURITY,
        isAnchorAttestBarrierHorizonActive } = require('./anchor_reward_activation.js');
const { isMirrorAdmissionConsumerActive } = require('./mirror_admission_activation.js');
const AnchorProofClient  = require('./consensus/anchor_proof_client.js');
const bridgeSettle       = require('./consensus/bridge_settle.js');
const rollcallClose      = require('./consensus/rollcall_close.js');
const { RollcallProofClient } = require('./consensus/rollcall_proof_client.js');
const HubPushQueue = require('./hub/hub_push_queue.js');
const UtxoTracker  = require('./chain/utxo_tracker.js');
const Genesis      = require('./chain/genesis.js');
const { collapseOutputFanout } = require('./chain/output_fanout.js');
const { blockMayReadPrice }    = require('./chain/price_read_predicate.js');
const trainActivation          = require('./train_activation.js');

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

// Discriminate a genuinely WEDGED indexer from one that is merely deferring the
// newest block behind a sync barrier that is itself advancing. A set stallReason
// alone is not a wedge: a BTC-mainnet indexer's price mirror sits perpetually ~1
// block behind the decoder tip, so the height-keyed price-sync barrier defers the
// newest block on almost every poll (stallReason='price_sync_barrier') even though
// the counter advances every few seconds as the mirror publishes each round.
// Used by api.js's /status HTTP-code contract so the xchain-node
// container healthcheck only reports unhealthy on a real stall. `lastBlockCommittedAt`
// and `now` are epoch-ms; graceMs is the no-progress window a stall must exceed.
// A stall with no committed block yet (lastBlockCommittedAt == null) is NOT wedged:
// a slow initial catch-up must never trip the container restart loop.
//
// `stallClearsAtMs` is the wall-clock instant a time-keyed barrier can FIRST
// be satisfied, or null when the stall has no such instant. A block stamped in the
// future (Bitcoin permits ~2h ahead of median-time-past, and miner clocks routinely run
// minutes fast) cannot have its eligible price-round set finalized until that time
// arrives, so the barrier waits and NO block commits for the whole skew. Against a 120s
// grace that reads as wedged within two minutes, and the indexer reports 503/unhealthy
// over a perfectly valid block, fleet-wide and simultaneously, with a restart achieving
// nothing because the barrier re-arms on the same block. While the instant is still in
// the future the wait is expected and self-clearing, so it is not a wedge. Once wall
// clock passes it and the stall persists, the mirror really is stuck and the normal
// grace-window verdict applies again. This is a HEALTH verdict only: it changes no
// hashed value and no barrier waits any differently for it.
// Top-level key of the hub's configs tree for a coin. The hub keys that tree by FULL
// lowercase coin name ('bitcoin'), never by the ticker config['COIN'] carries ('BTC'):
// its rows are written from xchain-node's full-name config tree (config/index.js Coin) and
// every hub-side reader of the same tree maps the ticker through COIN_FULL_NAME first
// (XChainHub getFeeQuote, _resolveIndexerUrl, db normalizeCoin). Indexing it with the raw
// ticker resolves undefined on every poll, so the overlay delivers nothing and says
// nothing. Falls back to the raw value for a coin absent from the registry.
//
// Not every hub-served map is this shape: _checkHubConsensusHash reads
// coin_consensus_hashes, which is genuinely ticker-keyed and must NOT be mapped.
//
// Module-level rather than a method so the prototype-borrowed
// `_mergeHubParams.call(stub, tree)` the consensus soft-fork guard uses keeps working
// against a bare `{ config }` stub.
function hubConfigCoinKey(coinTicker){
    return require('./coins').COIN_FULL_NAME[coinTicker] || coinTicker;
}

function stallWedged(stallReason, lastBlockCommittedAt, graceMs, now, stallClearsAtMs = null){
    if(!stallReason) return false;
    if(lastBlockCommittedAt == null) return false;
    if(Number.isFinite(stallClearsAtMs) && now < stallClearsAtMs) return false;
    return (now - lastBlockCommittedAt) > graceMs;
}

// True when the current stall is nothing but a wait for WALL CLOCK to reach a
// future-stamped block. stallClearsAt is set only by the time-keyed barriers, and only
// to (block_time + watermark grace); a value still ahead of `now` therefore means the
// block at the head of the queue is stamped in the future and no amount of local health
// can make it processable sooner. Consensus forbids committing it, so this is the
// indexer working exactly as designed, not degradation.
//
// It is a steady state, not a blip: a BTC-testnet4 miner stamping every block ~20 min
// ahead rides the 2-hour future-time cap forever, so lag PINS at ~6 blocks and each block
// commits (in milliseconds) the instant its stamp arrives. Reported distinctly so a
// monitor and the next ops session read "waiting out miner clock skew" instead of the
// fault that `degraded:true` + `isSynced:false` + a named stallReason otherwise spell.
// HEALTH REPORTING ONLY: hashes nothing, and no barrier waits any differently for it.
function waitingOnFutureBlock(stallReason, stallClearsAtMs, now){
    if(!stallReason) return false;
    if(!Number.isFinite(stallClearsAtMs)) return false;
    return now < stallClearsAtMs;
}

// One machine-readable verdict on the block counter, so a probe reads a single field
// rather than joining stallReason/degraded/stallClearsAt itself (and drawing the wrong
// conclusion when the answer is the healthy future-stamp wait). Values:
//   'none'              - advancing normally, no stall.
//   'future_block_wait' - waiting out a future-stamped block; healthy and self-clearing,
//                         with stallClearsAt naming the instant it can first move.
//   'barrier_defer'     - a real barrier defer (mirror behind, host fault), still
//                         advancing inside the grace window.
//   'wedged'            - stalled with no commit for longer than the grace window.
// 'future_block_wait' and 'wedged' cannot collide: stallWedged() already declines to
// wedge a stall whose clear instant is still ahead.
function stallClassOf(stallReason, lastBlockCommittedAt, graceMs, now, stallClearsAtMs = null){
    if(!stallReason) return 'none';
    if(waitingOnFutureBlock(stallReason, stallClearsAtMs, now)) return 'future_block_wait';
    if(stallWedged(stallReason, lastBlockCommittedAt, graceMs, now, stallClearsAtMs)) return 'wedged';
    return 'barrier_defer';
}

// True when the indexer has committed every block consensus currently PERMITS it to
// commit: either it is level with the decoder tip (isSynced), or the only thing between
// it and the tip is a future-stamped block it must legally wait out. `isSynced` keeps its
// literal decoder-tip-parity meaning for existing consumers; this is the "functionally
// caught up" signal an operator actually wants, and it is the field to read before
// concluding a non-zero lag means the indexer is behind.
function atProcessableTip(isSynced, stallReason, stallClearsAtMs, now){
    return !!isSynced || waitingOnFutureBlock(stallReason, stallClearsAtMs, now);
}

// ── Mirror-barrier hold: how long ONE block has been stuck behind the hub-mirror
// barriers, and whether that has passed the named ceiling.
//
// Every hub-mirror barrier bounds a single ATTEMPT (HUB_PRICE_SYNC_TIMEOUT_MS) and then
// defers, and the block loop retries the same block with an identical fresh wait. Those
// per-attempt bounds compose into no bound at all: a mirror whose stream watermark has
// stopped advancing holds a block forever while each individual log line reads like an
// ordinary, self-clearing defer. What that looks like from outside is a metronome, a few
// blocks released whenever the watermark happens to jump, and a throughput ceiling below
// chain pace. So the hold is measured across retries, keyed on the BLOCK rather than the
// reason (a block that cycles between two barriers is still one stuck block), and it has
// a named ceiling.
//
// nextBarrierHold folds one poll-loop observation into the hold record and is pure, so
// the whole rule is testable without a block loop. It returns the new record, or null
// when there is no hold to carry.
//
// Three things reset it, and each is a case where the wait is NOT open-ended:
//   - no stall reason at all (the loop is advancing),
//   - a different block at the head of the queue (the previous one committed),
//   - a future-stamped block (waitingOnFutureBlock). That wait already has its own named
//     bound, the block's own timestamp, it is consensus working as designed, and no
//     mirror action can shorten it by one second. Accumulating it here would fire the
//     ceiling on the healthiest case there is.
function nextBarrierHold(prev, block, stallReason, stallClearsAtMs, now){
    if(!stallReason || block == null) return null;
    if(waitingOnFutureBlock(stallReason, stallClearsAtMs, now)) return null;
    if(prev && prev.block === block)
        return { block: block, reason: stallReason, since: prev.since, notified: prev.notified };
    return { block: block, reason: stallReason, since: now, notified: false };
}

// True for the stall reasons a hub-mirror resubscribe could actually clear. Every mirror
// barrier's reason ends in '_barrier' (price/oracle/match/call/call_presence/anchor_attest/
// snapshot); the host faults deliberately do not (vm_executor_unavailable,
// anchor_reward_proof_unavailable, rollcall_proof_unavailable). A suffix rule rather than
// a list, so a barrier added later is covered by naming it the way every existing one is
// named.
function isMirrorBarrierReason(stallReason){
    return typeof stallReason === 'string' && /_barrier$/.test(stallReason);
}

// Milliseconds the current hold has lasted, or 0 when nothing is held.
function barrierHoldMs(hold, now){
    if(!hold || !Number.isFinite(hold.since)) return 0;
    return Math.max(0, now - hold.since);
}

// True once a hold has reached the named ceiling. A ceiling of 0 (or an unusable value)
// disables the check, which is the documented off switch: the barrier still defers
// exactly as before, it simply is not reported or re-driven under this name.
function barrierCeilingExceeded(hold, ceilingMs, now){
    if(!Number.isFinite(ceilingMs) || ceilingMs <= 0) return false;
    return barrierHoldMs(hold, now) >= ceilingMs;
}

class XChainIndexer {

    constructor(decoderDbHost, decoderDbPort, decoderDbName, decoderDbUser, decoderDbPass, indexerDbHost, indexerDbPort, indexerDbName, indexerDbUser, indexerDbPass, hubDbHost, hubDbPort, hubDbName, hubDbUser, hubDbPass, utxoTrackerUrl, utxoTrackerPort){
        // XChain Indexer Version. npm_package_* exists only under `npm run`; the
        // container now launches node directly (Dockerfile CMD, exec form, so
        // node is PID 1 and gets SIGTERM), which left the boot banner reading
        // "undefined vundefined". Fall back to the package.json this process
        // actually loaded, the same source src/api.js:220 already reports from.
        // Env stays first so the test launchers that pin it keep deciding.
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

        // This chain's instance identity: the hash of BLOCK 1, read once from the decoder
        // database. BITCOIN ONLY - the cross-chain tables are BTC-anchored, so this is the
        // id the hub stamps on them and every mirror fences on. Block 0 cannot serve: the
        // regtest genesis hash is a chainparams constant, identical across every re-genesis,
        // while block 1 commits to the instant the chain was created. Null until block 1 is
        // parsed, which on a freshly re-genesised chain is not true at startup, so the read
        // is retried once per parsed block until it resolves (see resolveBtcChainId).
        this.btcChainId = null;

        // Short machine-readable reason the block counter is currently not advancing,
        // or null when advancing normally. Set at each point where the catch-up loop
        // defers a block (the hub-sync barriers below time out, or the VM executor is
        // unavailable) and cleared the moment a block commits. Surfaced by health() so
        // an operator can tell WHY lag is growing (a sync-barrier stall, a circuit
        // breaker, and a host fault otherwise all look identical: a rising lag).
        this.stallReason = null;
        // Wall-clock (epoch ms) at which the CURRENT stall's barrier can first be
        // satisfied, or null when the stall has no such instant. Only the time-keyed barriers
        // set it, because only they wait on wall clock: a future-stamped block defers until
        // its own timestamp (plus the watermark grace) actually arrives. Read by stallWedged()
        // so that expected, self-clearing wait is not reported as a wedge. Cleared alongside
        // stallReason on every successful commit.
        this.stallClearsAt = null;
        // Wall-clock (epoch ms) of the most recent SUCCESSFUL block commit, or null until the
        // first block commits. Stamped at the commit point alongside the stallReason clear, and
        // read by the /status healthcheck to tell an advancing-but-barrier-deferring indexer
        // (healthy) from a genuinely wedged one (see stallWedged).
        this.lastBlockCommittedAt = null;
        // Wall-clock (epoch ms) of the most recent block-poll ITERATION, 0 until the loop has
        // run once. Distinct from lastBlockCommittedAt above, which only moves on a COMMIT and
        // is therefore old in the healthy case too on a caught-up or quiet chain: it cannot tell
        // "no new blocks" from "the loop is gone". Every freshness field the health payload reads
        // is written inside the loop, so a poll that hangs in an await freezes all of them at
        // their last good values and health keeps answering healthy forever. Stamped by BOTH the
        // outer poll loop and the inner catch-up loop, since an initial sync legitimately stays
        // inside the inner one for hours. Read by isPollSilent().
        this.lastPollAt = 0;
        // Set true when the decoder has written a durable REORG_HALT marker (a reorg it
        // could not safely rewind). Surfaced on /health so a halted decoder is not mistaken for
        // ordinary idle/lag. Updated by _checkDecoderReorgHalt(); the log-tick counter keeps the
        // periodic reminder from firing every tight poll.
        this.decoderReorgHalted   = false;
        this._reorgHaltLogTick    = 0;
        // The platform-train consensus activation verdict for the block the loop is about
        // to apply (src/train_activation.js), or null before
        // the first evaluation. `pending` means the signed release manifest names a rule set
        // this build does not implement and the boundary is still ahead, which health reports
        // and the monitor alerts on so the halt is ANNOUNCED before it fires; `halt` means
        // the boundary is reached and this node will not apply the block. Kept on the
        // instance rather than recomputed by health so both surfaces report one verdict.
        this.trainActivation      = null;
        this._trainActivationHaltLogTick = 0;
        // The trainActivation block of the signed release manifest this node was installed
        // from, resolved once and cached (undefined until the first resolution, null when the
        // manifest carries none, which is every MINOR and PATCH train). A resolution FAULT is
        // not cached, so a manifest that becomes readable later is picked up.
        this._trainActivationRequired = undefined;
        this.blockchainInfoLastBlock = -1

        // Wall-clock (epoch ms) of the most recent SUCCESSFUL hub-config fetch. Set by the
        // startup overlay and every poll tick that gets a response, regardless of whether the
        // committed config actually changed. Stays null until the first success. Surfaced as
        // an age in the health/status endpoints so an operator can tell that a hub outage has
        // left the live-applied overlay params (the tunable/display-only ones) stale while the
        // indexer keeps reporting healthy. This age measures hub reachability, nothing more.
        // Consensus params (ACTIVATION_DELAY_BLOCKS, EXPIRATION_FEE_PER_DAY, STAKING) are NOT
        // live-polled at any time: they are read once at boot from the per-chain local config
        // and change only by a coordinated node upgrade, so a hub outage cannot freeze them
        // (_mergeHubParams excludes them deliberately; health.js states the same).
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
        this.priceSyncTimeoutMs = parseInt(CONFIG_ENV.HUB_PRICE_SYNC_TIMEOUT_MS || '60000');

        // Mirror-barrier hold ceiling. priceSyncTimeoutMs above bounds ONE barrier attempt;
        // this bounds the whole hold across retries, a quantity nothing else here bounds at
        // all. Read from the same named constant HubDbSync throttles its forced resync on,
        // so the crossing and the remedy cannot disagree. Purely operational: it opens no
        // barrier and commits no block (see nextBarrierHold).
        this.barrierHoldCeilingMs = resolveBarrierHoldCeilingMs();
        // { block, reason, since, notified } for the block currently held behind a mirror
        // barrier, or null when nothing is held. Folded by nextBarrierHold() once per
        // poll-loop pass and cleared on every successful commit.
        this.barrierHold = null;
        // Count of ceiling crossings since boot, surfaced on /health so a fleet sweep can
        // see that a mirror needed re-driving without reading container logs.
        this.barrierCeilingHits = 0;

        // Action-scoped barrier state, all node-local and never hashed.
        // priceBarrierBlock      - the block the two flags below describe.
        // priceBarrierSkipped    - the price/oracle barriers were skipped for it because
        //                          priceReadPredicate proved no transaction-borne price
        //                          reader; read by db._assertPriceBarrierNotSkipped().
        // priceBarrierForceBlock - a block that must take the barriers unconditionally on
        //                          its next attempt, set when that assertion fired. Cleared
        //                          once that block commits, so it is a one-shot escalation
        //                          rather than a latch that would re-arm the every-block wait.
        this.priceBarrierBlock      = null;
        this.priceBarrierSkipped    = false;
        this.priceBarrierForceBlock = null;

        // Grace window (ms) for the /status healthcheck's stall discriminator. A set stallReason
        // reports the container unhealthy (503) only after NO block has committed for this long, so
        // a BTC-mainnet indexer perpetually deferring the newest block behind a price mirror that is
        // itself advancing (its steady state) commits every few seconds and stays healthy, while a
        // genuinely wedged indexer (mirror down, host fault) trips 503 once it exceeds the window.
        // Defaults to comfortably more than one barrier-timeout cycle so a single legitimate defer
        // never flaps the healthcheck. Purely operational, NOT a consensus parameter.
        this.healthStallGraceMs = parseInt(CONFIG_ENV.INDEXER_HEALTH_STALL_GRACE_MS
                                           || String(Math.max(2 * this.priceSyncTimeoutMs, 120000)), 10);

        // Window (ms) the block-poll loop may go without completing an ITERATION before
        // isPollSilent() calls it dead. Sized off healthStallGraceMs, which is already at
        // least two barrier-timeout cycles, and doubled again on top: one block can hold a
        // single iteration across several sequential barrier waits, and this signal must
        // never fire on a block that is merely slow. It measures loop LIVENESS, never chain
        // progress, so unlike stallWedged it has nothing to do with commits. Purely
        // operational, NOT a consensus parameter.
        this.pollSilentMs = parseInt(CONFIG_ENV.INDEXER_POLL_SILENT_MS
                                     || String(2 * this.healthStallGraceMs), 10);

        // Direct-hub-DB call-presence barrier timeout (ms). In single-host / direct-hub-DB
        // mode there is no HubDbSync mirror, so the cross-chain-call sync barrier is skipped.
        // But reading the hub's MariaDB directly does NOT mean a relay row was already WRITTEN
        // when this block was processed. Before the cross-chain-call pass, the indexer waits
        // (bounded) for any in-flight hub write to land, so a live node and a replaying node
        // inject at the same block. The hub-side relay margin is the primary guarantee; this
        // is defense-in-depth. See _waitForDirectCallPresence.
        this.callPresenceTimeoutMs = parseInt(CONFIG_ENV.XCALL_DIRECT_PRESENCE_TIMEOUT_MS || '10000');

        // Grace (seconds) for the direct-hub-DB barrier's hub-clock escape hatch. Resolved in
        // start() from the SAME frozen constant the HubDbSync call barrier uses
        // (HUB_SYNC_WATERMARK_GRACE_S.call / HUB_SYNC_CALL_GRACE_S), because the two barriers
        // decide the same question and a per-node value forks settlement. Resolution happens at
        // startup, never inside the block loop, so an invalid regtest override throws at boot
        // (resolveWatermarkGrace's contract) instead of wedging the tip mid-run.
        this.directCallGraceS = null;

        // Arrival margin (seconds) for the anchor-attest barrier's MATURITY HORIZON bound.
        // Resolved in start() beside directCallGraceS and for the identical reason: it is a
        // consensus input (it moves which nodes may advance past a maturity boundary), so it
        // is resolved ONCE at startup through resolveWatermarkGrace's regtest-only contract
        // rather than re-read inside the block loop, and an invalid regtest override throws at
        // boot instead of stamping NaN into the bound and wedging the tip.
        //
        // Deliberately NOT a member of HUB_SYNC_WATERMARK_GRACE_S: the armed-mirror venue
        // enumerates that table's keys and pins every one to 0, which would silently zero this
        // margin on every venue run and make the horizon bound an unconditional relaxation.
        this.anchorAttestArrivalMarginS = null;
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

    // Direct-hub-DB call-presence barrier (see the call site in the block loop and the note on
    // callPresenceTimeoutMs). Resolves only when it is safe to read cross_chain_calls for a block
    // at block_time, so the injection/callback pass sees EXACTLY the finalized rows with
    // effective_time <= block_time that canonical hub state holds, never a smaller (partial) set:
    //   * Coverage condition (proceed): the local hub mirror covers this block once
    //     MAX(effective_time) over finalized rows >= block_time. Nothing later than block_time can
    //     change the effective-at/before set, so reading now matches a node that saw every row on
    //     time.
    //   * Empty-table fast path (proceed): no finalized rows means there is nothing to wait on.
    //   * Hub-clock escape hatch (proceed): the hub's OWN clock, read as UNIX_TIMESTAMP() on the
    //     same connection in the same query, has passed block_time + directCallGraceS. See the
    //     long note at the escape in the loop body; this is the ruled fix for the forever-defer
    //     wedge, and is the direct-mode twin of _callSyncSatisfied's streamWatermark
    //     escape in hub_db_sync.js.
    //   * Mirror-lags (defer): if the highest finalized effective_time is still BELOW block_time
    //     and the hub clock has not yet cleared the grace, the mirror may genuinely be behind, so
    //     this block's call set could be incomplete. We do NOT proceed with that partial set.
    //     Instead we poll the mirror with a bounded sleep loop (mirroring the indexer's other sync
    //     barriers) and, if neither condition is met within callPresenceTimeoutMs, THROW so the
    //     caller defers the block and retries it from the top of the loop (lastIndexerBlock is not
    //     advanced). This is wait-then-retry, not throw-and-halt: a behind mirror blocks block
    //     PROCESSING (the consensus-correct outcome) until it catches up or the grace clears,
    //     rather than committing a divergent, partial-set block.
    //
    // CRITICAL fast path: the common cases (regtest single shared hub DB already current, or no
    // pending lag) hit the coverage / empty-table condition on the very first query and return
    // with zero added latency. Only a genuinely-lagging distributed mirror enters the poll loop.
    // An UNGRACED wall-clock proceed (Date.now >= block_time) is still deliberately NOT used: it
    // let a lagging node proceed with fewer cross-chain calls than canonical and diverge the
    // actions hash. The escape hatch is not that gate: it is keyed on the HUB's clock, not the
    // node's, and only opens a full call grace past block_time.
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

    // Decide whether this block takes the price/oracle mirror barriers, and record
    // that decision for db._assertPriceBarrierNotSkipped(). Returns true to wait.
    //
    // Three ways to end up waiting, and the last two are the safety rails:
    //   - blockMayReadPrice says the block carries transactions, so a reader is possible.
    //   - this block already tripped the fail-closed assertion on a previous attempt, so
    //     priceBarrierForceBlock pins it; skipping again would loop forever.
    //   - malformed input, which priceReadPredicate resolves to "wait" by contract.
    //
    // priceBarrierSkipped is deliberately AND-ed with hubDbSync. On a single-host stack
    // there is no mirror and the barriers never ran in the first place, so flagging a skip
    // there would arm the choke-point assertion against reads that were always legitimate
    // and wedge the node on its first priced block.
    // The wall-clock instant at which a time-keyed hub-sync barrier can FIRST be
    // satisfied for a block, or null when that cannot be determined. Every such barrier has
    // the same escape hatch (`streamWatermark >= blockTime + grace`), and the watermark only
    // advances as real time does, so a block stamped in the FUTURE cannot clear before
    // blockTime + grace no matter how healthy the mirror is. Their other satisfaction case
    // (the mirror already holds a row at/past blockTime) cannot fire early either, because
    // rows effective at a future instant do not exist yet. Returns null when sync is off or
    // the inputs are not finite, which leaves the caller's verdict exactly as it was before.
    //
    // Used ONLY for the /status health verdict. It gates no wait, no read and no write.
    barrierClearsAt(blockTime, graceField){
        blockTime = Number(blockTime);
        if(!this.hubDbSync || !Number.isFinite(blockTime)) return null;
        let graceS = Number(this.hubDbSync[graceField]);
        if(!Number.isFinite(graceS)) graceS = 0;
        return (blockTime + graceS) * 1000;
    }

    // The same verdict for a barrier that may have been RE-KEYED onto a height.
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
    // added to un-stall. The grace field is passed by NAME so _barrierClearsAt stays the only
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

    // Fold one poll-loop pass into the mirror-barrier hold, and act when it crosses the
    // named ceiling. Called once per pass, right after the catch-up loop exits,
    // where `this.stallReason` and `this.stallClearsAt` already carry whatever the defer
    // sites set. Reading them here rather than instrumenting each of the nine defer sites
    // keeps one rule in one place, and a barrier added later is covered for free.
    //
    // What crossing the ceiling does, and what it deliberately does NOT do. It logs under
    // a distinct name, counts the crossing for /health, and asks the mirror to reconnect
    // and re-bootstrap. It does not open the barrier, shorten a grace, skip a block or
    // change a single hashed value: the block keeps deferring, fail-closed, until its
    // barrier is genuinely satisfied. So the ceiling can never fork settlement, and a node
    // whose mirror really is missing rows is no more permissive after it fires than before.
    //
    // Returns the hold in ms (0 when nothing is held), for the caller and for tests.
    // End the process under a named reason, for a fault that no amount of further running
    // can clear. Matches what api.js does with a fatal indexer error, and is a method
    // rather than an inline process.exit so a test can observe the decision without
    // taking the runner down with it.
    fatalExit(reason){
        getLogger().error('Fatal indexer error: ' + reason);
        process.exit(1);
    }

    noteBarrierHold(blockToParse, now = Date.now()){
        let prev = this.barrierHold;
        this.barrierHold = nextBarrierHold(prev, blockToParse, this.stallReason, this.stallClearsAt, now);
        let hold = this.barrierHold;
        if(!hold) return 0;
        if(!barrierCeilingExceeded(hold, this.barrierHoldCeilingMs, now)) return barrierHoldMs(hold, now);

        // The remedy fits the MIRROR barriers only. A host fault (vm_executor_unavailable,
        // anchor_reward_proof_unavailable) is held by something a hub resubscribe cannot
        // touch, and re-driving the mirror for it would be a misleading log line attached to
        // a pointless reconnect. The hold and its ceiling still apply to those: naming how
        // long a block has been stuck is worth having whatever is holding it.
        let mirrorBarrier = isMirrorBarrierReason(hold.reason);

        // Announce the crossing ONCE per held block, then keep re-driving the mirror on the
        // ceiling cadence: requestResync() throttles itself on the same value, so calling it
        // every pass costs nothing and a mirror that recovers and re-stalls is re-driven again.
        if(!hold.notified){
            hold.notified = true;
            this.barrierCeilingHits++;
            getLogger().error('Mirror-barrier hold ceiling reached: block ' + blockToParse + ' has been held at ' +
                hold.reason + ' for ' + Math.round(barrierHoldMs(hold, now) / 1000) + 's, past the ' +
                Math.round(this.barrierHoldCeilingMs / 1000) + 's ceiling (HUB_SYNC_BARRIER_HOLD_CEILING_S, default ' +
                HUB_SYNC_BARRIER_HOLD_CEILING_S + 's). The block is still deferring, which is correct. ' +
                (mirrorBarrier
                    ? 'Forcing a hub-mirror resync: a stream watermark that stops advancing holds every ' +
                      'one of these barriers open-endedly, and only a fresh subscribe-then-bootstrap re-arms it.'
                    : 'Not a hub-mirror barrier, so no resync is forced; this is a host fault to investigate.'));
        }
        if(mirrorBarrier && this.hubDbSync && typeof this.hubDbSync.requestResync === 'function')
            this.hubDbSync.requestResync('block ' + blockToParse + ' held at ' + hold.reason +
                                         ' past the ' + Math.round(this.barrierHoldCeilingMs / 1000) + 's ceiling');
        return barrierHoldMs(hold, now);
    }

    evaluatePriceBarrier(blockToParse, blockTransactions){
        let mayReadPrice = blockMayReadPrice(blockTransactions)
                           || this.priceBarrierForceBlock === blockToParse;
        this.priceBarrierBlock   = blockToParse;
        this.priceBarrierSkipped = !!this.hubDbSync && !mayReadPrice;
        return mayReadPrice;
    }

    // Wall-clock instant (epoch ms) the DIRECT call-presence barrier's hub-clock escape can
    // FIRST open for a block, or null when that cannot be determined. The mirrored twin of
    // _barrierClearsAt, which cannot serve this path because it returns null without a
    // HubDbSync. Health verdict only: it gates no wait, no read and no write.
    //
    // Null above the mirror-admission activation at `blockHeight`: the barrier is then
    // height-keyed and no clock instant opens it, so a hold accumulates and the 900 s ceiling
    // can fire exactly as it does for the mirrored twins. A caller that passes no height gets
    // today's clock verdict, which keeps the existing one-argument shape meaningful.
    directCallBarrierClearsAt(blockTime, blockHeight){
        // Guarded on the RAW height before _mirrorAdmissionActiveAt is reached, so the
        // pre-train one-argument shape (and a hand-built harness with no config) reads inert
        // without touching this.config. Number(null) is 0, and 0 is above an activation armed
        // at height 0, which is why the guard is on the raw value and never a coerced one.
        if(blockHeight !== null && blockHeight !== undefined && this.mirrorAdmissionActiveAt(blockHeight)) return null;
        blockTime = Number(blockTime);
        if(!this.hubDb || !Number.isFinite(blockTime)) return null;
        let graceS = Number(this.directCallGraceS);
        if(!Number.isFinite(graceS)) graceS = HUB_SYNC_WATERMARK_GRACE_S.call;
        return (blockTime + graceS) * 1000;
    }

    // Two forms, chosen by the mirror-admission consumer activation at `blockHeight`:
    //
    //   BELOW it, today's clock form byte for byte: the local hub mirror covers block_time
    //   (its highest finalized effective_time over calls touching THIS coin is at/after it),
    //   or the hub's own clock has passed block_time + the call grace.
    //
    //   ABOVE it, the family's height form: the hub's persisted cross_chain_calls height
    //   watermark for this chain is at or above B - ADMIT_MARGIN_BLOCKS[cross_chain_calls],
    //   and the hub-clock escape is RETIRED. Nothing in that predicate reads t(B), which is
    //   the point: a block stamped 7200 s ahead is height B like any other, and the only
    //   thing that can hold the barrier is a watermark trailing B - margin, which is genuine
    //   mirror lag.
    //
    // The coverage read is scoped to calls that touch THIS coin (target or source) at every
    // height, matching the mirrored twin (_refreshCallSyncTimestamp): a global watermark
    // could be bumped past block_time by an unrelated other-chain call and let this node
    // proceed before every call effective for its coin was present, which is the same fork
    // the mirrored path already closed. It is a wait and hashes nothing, so it is not gated
    // on the activation. A caller with no configured coin falls back to the unscoped
    // superset, which only ever waits longer.
    //
    // The height form's carrier is the floor the hub persists into the shared hub DB:
    // `configs` with coin 'xchain', this network, module 'admission_watermark', param_name
    // 'cross_chain_calls.<CHAIN>' and canonical digits for a value. It is written
    // monotonically and only where it moved, so it sits at or below the hub's live claim and
    // reading it AS the claim is conservative. An absent row, a non-digit value or a query
    // error all read as NOT covered (fail closed), and the value is never coerced from a
    // missing reading: Number(null) is 0, and 0 would certify a genesis-era mirror for every
    // block.
    async waitForDirectCallPresence(blockTime, blockHeight){
        blockTime = Number(blockTime);
        if(!this.hubDb || !Number.isFinite(blockTime)) return;
        let timeoutMs = Number(this.callPresenceTimeoutMs);
        if(!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = 10000;
        // The raw-height guard is what keeps the one-argument shape inert without reading
        // this.config (see _directCallBarrierClearsAt).
        let admission = blockHeight !== null && blockHeight !== undefined && this.mirrorAdmissionActiveAt(blockHeight);
        let chain = (this.config && this.config['COIN']) ? String(this.config['COIN']).trim().toUpperCase() : '';
        // Resolved here rather than at the top of the file so this row touches nothing
        // outside its two methods; the module is already loaded by the require above.
        let target = admission
            ? (Number(blockHeight) - require('./mirror_admission_activation.js').admitMarginBlocks('cross_chain_calls'))
            : null;
        // The height tail every log line below carries ABOVE the activation, in the shape
        // hub_db_sync._heightTail gives the mirrored twins; each line's prefix is untouched
        // because a unit test and an operator's grep match on it.
        let heightTail = (floor) => ' (admission height cross_chain_calls.' + (chain === '' ? 'unknown' : chain) +
                                    ' at ' + (floor === null ? 'none' : floor) + ', needs ' + target + ')';
        // Grace for the hub-clock escape below. Resolved at startup (start()); the frozen
        // constant is the fallback so a hand-built caller (unit tests) and any future path
        // that skips start() still gets the protocol value rather than NaN, which would make
        // every `hubNow >= blockTime + grace` comparison false and restore the wedge.
        let graceS = Number(this.directCallGraceS);
        if(!Number.isFinite(graceS)) graceS = HUB_SYNC_WATERMARK_GRACE_S.call;
        let deadline = Date.now() + timeoutMs;
        let pollMs = 250;
        let lastTs  = null;         // last observed mirror watermark, for the timeout diagnostic
        let lastNow = null;         // last observed HUB clock, same
        let lastFloor = null;       // last observed admission floor (height form), same
        while(true){
            // Coverage check: proceed the instant the local hub mirror covers block_time, i.e.
            // the highest finalized effective_time is at/after it, or there is nothing to wait on.
            // A query error means the table is not ready yet, which reads as NOT covered so the
            // barrier waits (it never proceeds against an unread table). The probe uses
            // doQueryStrict, which is what makes the catch below reachable: doQuery collapses a
            // non-transactional query fault into [], and the hub connection never holds a
            // transaction, so an empty result would fall straight into `covered = true` and a
            // transient hub fault would CLEAR the barrier it exists to hold.
            let covered = false;
            try {
                if(admission){
                    // THE HEIGHT FORM. Covered when the persisted floor for (cross_chain_calls,
                    // this chain) has reached B - margin. No clock, no escape: the only thing
                    // that holds this is a watermark that has not advanced, which is mirror lag.
                    let rows = await this.hubDb.getHubConfigParam(
                        'xchain', String(this.config['NETWORK'] || ''), 'admission_watermark',
                        'cross_chain_calls.' + chain);
                    lastFloor = null;
                    if(chain !== '' && rows && rows.length > 0 && rows[0].param_value !== null && rows[0].param_value !== undefined){
                        let raw = String(rows[0].param_value).trim();
                        if(/^(?:0|[1-9][0-9]*)$/.test(raw) && Number.isSafeInteger(Number(raw))) lastFloor = Number(raw);
                    }
                    if(lastFloor !== null && lastFloor >= target) covered = true;
                } else {
                // UNIX_TIMESTAMP() rides along on the SAME query and the SAME connection as the
                // watermark, so the escape below compares two readings taken at one instant from
                // one clock. Reading the hub's clock separately (or substituting this node's)
                // would let skew between them decide a consensus barrier.
                let rows = await this.hubDb.getHubCrossChainCallCoverage(chain);
                if(rows.length === 0 || rows[0].ts === null){
                    covered = true;                         // no finalized rows: nothing to wait on
                } else {
                    lastTs = Number(rows[0].ts);
                    if(lastTs >= blockTime){
                        covered = true;                     // mirror covers this block
                    } else {
                        // Hub-clock escape hatch. Without it this barrier keys liveness
                        // on CALL TRAFFIC: the only proceed condition was a finalized row at/after
                        // block_time, so the moment XCALL traffic goes idle, chain time walks past
                        // the newest finalized effective_time and NOTHING can ever satisfy the
                        // barrier again. Every block defers, forever, on a chain that is perfectly
                        // healthy. The hub_db_sync path never had this failure mode because
                        // _callSyncSatisfied also opens on `streamWatermark >= blockTime + grace`.
                        //
                        // This is that same escape, keyed on the same frozen grace, with the hub's
                        // clock standing in for the stream watermark. The two are the same reading:
                        // streamWatermark is literally the hub's Math.floor(Date.now()/1000),
                        // broadcast on a heartbeat (HubDbBroadcaster.broadcastWatermark); in direct
                        // mode there is no stream to carry it, so we ask the hub's database for it.
                        //
                        // Why it is safe to proceed: the hub stamps a call row's effective_time
                        // FORWARD of the instant it writes it (CrossChainCallEngine adds the relay
                        // margin), so a row effective at or before block_time was already committed
                        // before block_time on the hub's clock. Once that same clock reads a full
                        // call grace past block_time, any such row is present in the table we just
                        // read, and the set we are about to inject is the canonical one. This is
                        // NOT the removed ungraced `Date.now() >= block_time` gate: that one used
                        // the NODE's clock, allowed zero margin, and did let a lagging reader
                        // proceed with a partial set.
                        // NULL/absent must not coerce to 0 (Number(null) === 0 is finite, and a
                        // 0 that compared true would open the escape on a hub that answered
                        // nothing). Normalize the missing reading to null, which is not finite.
                        let hubNow = rows[0].hub_now;
                        lastNow = (hubNow === null || hubNow === undefined) ? null : Number(hubNow);
                        if(Number.isFinite(lastNow) && lastNow >= blockTime + graceS){
                            covered = true;
                            getLogger().info('Direct call-presence barrier: hub clock ' + lastNow +
                                ' is past block_time ' + blockTime + ' + ' + graceS + 's grace ' +
                                '(call mirror at ' + lastTs + '); proceeding.');
                        }
                    }
                }
                }
            } catch(e){
                // Table not ready / transient error: treat as not covered and keep waiting.
                // Surface it once per distinct message so a persistent fault (schema change,
                // permission regression, dead pool) is distinguishable from genuine mirror lag
                // instead of looking identical to it for the whole timeout window.
                if(this._callPresenceLastErr !== e.message){
                    this._callPresenceLastErr = e.message;
                    getLogger().error('direct call-presence query error (treating as not covered): ' + e.message);
                }
            }
            if(covered) return;
            // Mirror is behind. Defer the block rather than proceed with a partial set: once the
            // bound is exhausted, throw so the caller retries this block from the top of the loop.
            // The message keeps its byte-identical prefix and gains the height form only above
            // the activation, where the clock readings it names are simply never taken.
            if(Date.now() >= deadline)
                this.util.throwError('direct call-presence barrier timed out after ' + timeoutMs +
                    'ms waiting for block_time ' + blockTime + ' (call mirror at ' + lastTs +
                    ', hub clock at ' + lastNow + ', escape at ' + (blockTime + graceS) + ')' +
                    (admission ? heightTail(lastFloor) : '') +
                    (this._callPresenceLastErr ? ' [last query error: ' + this._callPresenceLastErr + ']' : ''));
            getLogger().info('Waiting on hub call mirror: block_time ' + blockTime +
                ' not yet covered (mirror at ' + lastTs + ', hub clock at ' + lastNow +
                ', escape at ' + (blockTime + graceS) + ')' +
                (admission ? heightTail(lastFloor) : '') + '; retrying...');
            await this.util.sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
        }
    }

    // Handle starting up the XChain indexer
    async start(){
        getLogger().info('Starting up ' + this.name + ' v' + this.version + '...');

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
        require('./coins').verifyConsensusPin(this.config.NETWORK);

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

        // Overlay hub-served operational params on top of local config defaults (best-effort)
        await this.applyHubConfigOverlay();

        // Keep the overlay live: poll the hub so a PBFT-committed config change takes
        // effect without requiring a process restart (see _startHubConfigPolling).
        this.startHubConfigPolling();

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
        }

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

        // Start the durable hub-push retry queue. Both PRICE hub pushes (v0 round and v1
        // oracle price) are write-ahead: price.js enqueues the pending_hub_pushes row
        // UNCONDITIONALLY inside the open block transaction, so it commits atomically with
        // the prices row. Live delivery runs post-commit (_deliverStagedHubPushes) and drops
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

        // Define placeholders for block parsing status
        let firstDecoderBlock     = null;
        let lastIndexerBlock      = null;
        let lastDecoderBlock      = null;

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
                    getLogger().info('Resuming block parsing at block ' + startBlock + '...');
            }

            // Loop through blocks until indexer has parsed lastDecoderBlock. The stopFlag check
            // lets stop() take effect at the next block boundary: on a moving decoder tip this
            // inner loop can otherwise run indefinitely (lastDecoderBlock is refreshed per block),
            // so a shutdown request would be deferred until full catch-up. The check sits before
            // beginTransaction, preserving the invariant that an open block transaction is never
            // interrupted mid-flight.
            while( !this.stopFlag && !this.util.isNull(lastIndexerBlock) && !this.util.isNull(lastDecoderBlock) && this.util.bclt(lastIndexerBlock, lastDecoderBlock) ){

                // The heartbeat belongs here too, not only at the outer loop top. This loop
                // runs the whole backlog and only breaks out every REORG_RECHECK_BLOCKS, so a
                // healthy initial sync legitimately stays inside it for hours; an outer-loop-only
                // stamp would report a catching-up indexer dead and, worse, would call it dead
                // for exactly as long as it is doing the most work.
                this.lastPollAt = Date.now();

                // Set flag to indicate not fully synced
                this.synced = false;

                // Bounded reorg-detection latency during long catch-up. Reorg events are
                // otherwise fetched only at the top of the OUTER loop, and the per-block decoder-tip
                // refresh keeps this inner loop running as long as the tip moves - so a decoder reorg
                // that lands mid-catch-up is not detected until the node is fully caught up, and until
                // then the loop commits hash-chained blocks built on old-chain state (served via
                // getblockhashes / pushed to the hub). Cheaply re-check every REORG_RECHECK_BLOCKS
                // blocks and break to the outer loop, which performs the deepest-rollback + replay.
                // Bounds the mixed-chain window to REORG_RECHECK_BLOCKS instead of the whole backlog;
                // convergence is unchanged (the eventual rollback unwinds every block >= the reorg).
                if((Number(lastIndexerBlock) % REORG_RECHECK_BLOCKS) === 0){
                    // Witness the cursor here too (same under-cursor protection).
                    let midCursorWitness = (lastProcessedReorgId != null)
                                            ? await indexerReorgView.getLastProcessedReorgWitness() : null;
                    let midReorgs = await this.decoderDb.getReorgsSince(lastProcessedReorgId, midCursorWitness);
                    if(midReorgs.length > 0){
                        getLogger().info('Detected a decoder reorg mid-catch-up; breaking to handle it before block ' + (Number(lastIndexerBlock) + 1));
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
                    break;
                }

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
                // Only blocks that can actually READ the mirror take these waits.
                // The hub finalizes one price round per 600s, the same cadence as a BTC
                // block, so a tip block is essentially never covered by a round anchored at
                // or after it and burns the full timeout every time. A block that reads no
                // price is byte-identical against a current mirror and a stale one, so that
                // wait buys nothing. blockMayReadPrice is a deliberate over-approximation
                // (see price_read_predicate.js): any transaction at all means wait, and the
                // end-of-block passes, which can run the VM on a transaction-free block, are
                // caught fail-closed at the read itself by db._assertPriceBarrierNotSkipped().
                // Safe without a flag day because a skipped barrier changes no hashed value,
                // only whether this node paused first.
                let mayReadPrice = this.evaluatePriceBarrier(blockToParse, blockTransactions);
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
                        break;
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
                // Same barrier gate as the price barriers above: oracle_prices has the same
                // reader set (FIAT settlement via reverseOraclePriceMatch, the DISPENSER
                // create's oracle-fee quote), so a block that reaches neither reads nothing
                // here either, and the choke-point assertion covers the rest.
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
                        break;
                    }
                }

                // Cross-chain match sync barrier: wait until the local cross_chain_matches
                // mirror has caught up to this block's time, so every operator of this chain
                // settles the same cross-chain matches at the same block. No-op when sync is
                // disabled or the mirror holds no cross-chain matches.
                if(this.hubDbSync){
                    try {
                        await this.hubDbSync.waitForMatchSync(blockTime, this.priceSyncTimeoutMs, blockToParse);
                    } catch(err){
                        getLogger().warn('Deferring block ' + blockToParse + ' (cross-chain match sync): ', err);
                        this.stallReason = 'match_sync_barrier';
                        this.stallClearsAt = this.barrierClearsAtHeightAware(blockTime, 'matchWatermarkGraceS', blockToParse);
                        break;
                    }
                }

                // Cross-chain call sync barrier: wait until the local cross_chain_calls
                // mirror has caught up to this block's time, so every operator of this chain
                // injects/delivers the same cross-chain calls at the same block. No-op when
                // sync is disabled or the mirror holds no relay rows.
                if(this.hubDbSync){
                    try {
                        await this.hubDbSync.waitForCallSync(blockTime, this.priceSyncTimeoutMs, blockToParse);
                    } catch(err){
                        getLogger().warn('Deferring block ' + blockToParse + ' (cross-chain call sync): ', err);
                        this.stallReason = 'call_sync_barrier';
                        // callWatermarkGraceS, NOT the match grace: _callSyncSatisfied waits on
                        // the call grace, and the two producers stamp effective_time differently
                        // (hub_db_sync.js HUB_SYNC_WATERMARK_GRACE_S.call). Keying the health
                        // verdict on the match value would mis-time the wedge discriminator the
                        // moment the two constants diverge or a regtest override moves one.
                        this.stallClearsAt = this.barrierClearsAtHeightAware(blockTime, 'callWatermarkGraceS', blockToParse);
                        break;
                    }
                }

                // Bridge transfer sync barrier: wait until the local bridge_transfers mirror
                // has caught up to this block's time, so every operator of this chain mints
                // the same bridged credits at the same block. A transfer's apply assigns an
                // action index, so a node that applied a smaller set at this height would
                // commit different actions_hash and ledger_hash for a block its peers agree
                // on. No-op when sync is disabled or the mirror holds no transfers.
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
                        break;
                    }
                }

                // Policy snapshot sync barrier: its own barrier and not a reuse of the bridge
                // one, because policy_snapshots is keyed on origin_chain alone (a snapshot
                // names no destination, so there is no (src, dest) pair to scope by) and
                // carries its own watermark grace. The snapshots materialize membership that
                // GATES the credits the bridge pass then applies, so a stale policy mirror
                // would let one node admit a transfer another node's membership refuses.
                if(this.hubDbSync){
                    try {
                        await this.hubDbSync.waitForPolicySync(blockTime, this.priceSyncTimeoutMs, blockToParse);
                    } catch(err){
                        getLogger().warn('Deferring block ' + blockToParse + ' (policy snapshot sync): ', err);
                        this.stallReason = 'policy_sync_barrier';
                        this.stallClearsAt = this.barrierClearsAtHeightAware(blockTime, 'policyWatermarkGraceS', blockToParse);
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
                // (regtest) case clears on the first query with no added latency. Above the
                // mirror-admission activation the same wait is keyed on the hub's persisted
                // height watermark for this chain instead, so blockToParse rides along.
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
                        // wait, no read and no write (health verdict only, see _barrierClearsAt).
                        // Null above the admission activation, where no clock instant opens it.
                        this.stallClearsAt = this.directCallBarrierClearsAt(blockTime, blockToParse);
                        break;
                    }
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
                if(this.hubDbSync && this.config['COIN'] === 'BTC'){
                    try {
                        await this.hubDbSync.waitForAnchorAttestationSync(blockTime, this.priceSyncTimeoutMs, anchorHorizonBound, blockToParse);
                    } catch(err){
                        getLogger().warn('Deferring block ' + blockToParse + ' (anchor-reward attestation mirror): ', err);
                        this.stallReason = 'anchor_attest_barrier';
                        this.stallClearsAt = this.anchorBarrierClearsAt(
                            blockTime, anchorHorizonBound, blockToParse, 'anchorAttestWatermarkGraceS');
                        break;
                    }
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
                if(this.hubDbSync && this.config['COIN'] === 'BTC'){
                    try {
                        await this.hubDbSync.waitForAttestationResponseSync(blockTime, this.priceSyncTimeoutMs, blockToParse);
                    } catch(err){
                        getLogger().warn('Deferring block ' + blockToParse + ' (attestation response mirror): ', err);
                        this.stallReason = 'attest_response_sync_barrier';
                        this.stallClearsAt = this.barrierClearsAtHeightAware(blockTime, 'attestResponseWatermarkGraceS', blockToParse);
                        break;
                    }
                }

                // Cross-chain capability-snapshot barrier: wait until the capability snapshot
                // for every effective cross-chain match AND call relay row has mirrored in, so
                // neither is ever skipped (and applied later at a per-operator-variable height)
                // for a missing snapshot. Defers the block on timeout, same as the barriers above.
                if(this.hubDbSync){
                    try {
                        await this.hubDbSync.waitForSnapshotSync(blockTime, this.priceSyncTimeoutMs, blockToParse);
                    } catch(err){
                        getLogger().warn('Deferring block ' + blockToParse + ' (cross-chain snapshot sync): ', err);
                        this.stallReason = 'snapshot_sync_barrier';
                        this.stallClearsAt = null;          // snapshot presence, not wall clock
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
                    let blockProcessing = this.indexerDb.runInTxEpoch(txEpoch, async () => {

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
                        await this.indexerDb._applyPendingRewardsDueAtBlock(blockToParse);

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
                    });

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

                    // Log the total parse time for this block
                    let parseTime = this.util.getTimer(debugTimer);
                    getLogger().info('Block Parsed' + "\t: " + lastIndexerBlock + ' [ledger:' + ledger + ' actions:' + actions + ' contracts:' + contracts + '] (' + parseTime + ')');

                    // Push chain tip to hub (fire-and-forget; never blocks indexing).
                    // Network is included so multi-network hubs scope tips correctly
                    // (older hubs ignore it; pre-network-aware behavior = 'mainnet').
                    // Skip while catching up: during a bulk re-index, pushing a tip for every
                    // historical block floods the hub's proxy / rate-limiter (HTTP 429) for no
                    // value. The hub only wants the live tip. Only push within
                    // CHAIN_TIP_PUSH_MAX_LAG blocks of the decoder tip (lastDecoderBlock here is
                    // the prior iteration's value, i.e. at most one block stale, which is fine).
                    if(!this.util.bcgt(this.util.bcsub(lastDecoderBlock, lastIndexerBlock), this.config['CHAIN_TIP_PUSH_MAX_LAG'])){
                        // The chain identity rides the tip push that already exists rather than
                        // a new RPC. Resolved here (not only at startup) because a chain that
                        // was re-genesised has no block 1 to read when this process boots; the
                        // memoized read costs one point query per block until it lands, and
                        // nothing is sent until then, which leaves an older hub's wire intact.
                        let chainId = await this.resolveBtcChainId();
                        // rawBlockTime: the hub publishes this as the chain's tip timestamp to
                        // other services, which compare it against wall clock for freshness.
                        this.hubClient.pushChainTip(this.config['COIN'], this.config['NETWORK'], lastIndexerBlock, rawBlockTime, chainId);
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

                } catch(error){
                    // Roll back all writes for this block so the DB stays at the end of the previous block
                    await this.indexerDb.rollbackTransaction();

                    // The block is no longer in flight, so no read can be attributed
                    // to it. priceBarrierForceBlock is deliberately NOT cleared here: when
                    // this rollback IS the price-barrier escalation, that flag is what makes
                    // the retry take the barrier instead of skipping again and looping.
                    this.priceBarrierSkipped = false;

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
                    } else if(error && error.name === 'AnchorProofUnavailableError'){
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
                    } else if(error && error.name === 'BridgeProofUnavailableError'){
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
                    } else if(error && error.name === 'RollcallProofUnavailableError'){
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

            // Sleep for BLOCK_CHECK_INTERVAL before checking for new transaction data
            await this.util.sleep(this.config['BLOCK_CHECK_INTERVAL']);
        }
    }

    // Fetch operational params from the hub and shallow-merge them over the local coin config.
    // Called once at startup. Best-effort: logs a warning and returns without modifying config
    // if the hub is unreachable or returns an unexpected response.
    async applyHubConfigOverlay(){
        if(!this.hubClient || !this.hubClient.configEnabled) return;
        try {
            let { ok, configs, seq, watermark, coinConsensusHashes } = this.unwrapHubConfigResponse(await this.hubClient.getAllConfigs());
            if(!ok){
                getLogger().warn('XChainIndexer: hub config overlay skipped, hub returned no usable config (using local defaults)');
                return;
            }
            this.checkHubConsensusHash(coinConsensusHashes);
            this.mergeHubParams(configs);
            this.lastHubConfigSeq = seq;
            this.lastHubConfigWatermark = watermark;
            this.lastHubConfigFetchAt = Date.now();
        } catch(err) {
            getLogger().warn('XChainIndexer: hub config overlay failed, using local defaults:', err);
        }
    }

    // Transport-integrity check: compare the hub's served consensus-config hash for
    // this coin/network against our OWN bundled hash. A mismatch means the hub would
    // serve divergent consensus values; we never apply consensus params from the hub
    // (the pinned-verify-only class below), so this only logs, but it surfaces a hub
    // that is out of sync with this node's pinned bundle so an operator can upgrade.
    checkHubConsensusHash(coinConsensusHashes){
        if(!coinConsensusHashes) return; // older hub: field absent, nothing to compare
        let coin = this.config.COIN, network = this.config.NETWORK;
        let hubHash = coinConsensusHashes[network] && coinConsensusHashes[network][coin];
        if(!hubHash) return;
        let localHash = require('./coins').consensusHash(coin, network);
        if(hubHash !== localHash)
            getLogger().error('CONSENSUS HASH MISMATCH: hub serves ' + hubHash + ' for ' + coin + '/' + network +
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
    unwrapHubConfigResponse(response){
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
    mergeHubParams(allConfigs){
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

        let coin    = hubConfigCoinKey(this.config.COIN);
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
                    getLogger().warn('XChainIndexer: failed to JSON-parse hub param ' + key + ':', e);
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
    // Probe the decoder for a durable REORG_HALT marker and keep this.decoderReorgHalted
    // in sync. A halted decoder cannot advance, so the indexer would otherwise just look idle or
    // lagging. Log LOUD on the transition into halted (naming the required operator action, a full
    // decoder resync), then only periodically while it stays halted so a tight poll does not spam
    // the log. Returns the current halted boolean. Never throws to the caller: a decoderDb read
    // fault is logged and leaves the last known state unchanged (the reorg poll's own strict reads
    // still fail loud on a real fault).
    // The trainActivation block of the signed release manifest this node was installed
    // from. The carrier ships the manifest and the components ship the vendored
    // TRAIN_ACTIVATION map, which is exactly why the comparison is worth making: a
    // partial upgrade (new carrier, stale component image) is the shape a post-launch
    // MAJOR train forks in, and it is invisible to every per-feature flag day.
    //
    // Resolved from config['RELEASE_MANIFEST_PATH'] when the deployment sets one,
    // otherwise from the carrier's copy beside this checkout. NO manifest is NOT a
    // fault and is not a halt: nothing then names a rule set, which is the honest
    // reading of an install that has no manifest to require one. A manifest that
    // exists and cannot be PARSED is a different matter and is reported as malformed,
    // which evaluateTrainActivation halts on fail-closed.
    resolveTrainActivationRequirement(){
        if(this._trainActivationRequired !== undefined) return this._trainActivationRequired;
        let candidates = [];
        if(this.config && this.config['RELEASE_MANIFEST_PATH'])
            candidates.push(String(this.config['RELEASE_MANIFEST_PATH']));
        candidates.push(path.resolve(__dirname, '../../xchain-node/src/release-manifest.json'));
        for(const file of candidates){
            let raw;
            try {
                if(!fs.existsSync(file)) continue;
                raw = fs.readFileSync(file, 'utf8');
            } catch(e){
                // Present but unreadable. Do NOT cache: a permissions fix or a
                // completed atomic rename should be picked up on the next block.
                return { malformed: 'release manifest at ' + file + ' could not be read (' + (e && e.message) + ')' };
            }
            let parsed;
            try { parsed = JSON.parse(raw); }
            catch(e){ return { malformed: 'release manifest at ' + file + ' is not valid JSON' }; }
            this._trainActivationRequired = trainActivation.readManifestTrainActivation(parsed);
            return this._trainActivationRequired;
        }
        this._trainActivationRequired = null;
        return null;
    }

    // Evaluate the train gate for the block about to be applied and return TRUE when the
    // loop must not apply it. Also keeps this.trainActivation current for health, which is
    // how the halt is announced BEFORE it fires: the `pending` verdict is published from
    // the moment the manifest names an unimplemented rule set, not at the boundary.
    //
    // The clock is the BTC height. A BTC indexer's own block_index IS that height; off BTC
    // there is none in this path, so null is passed and the gate treats an unimplemented
    // requirement as fail-closed (see the header of src/train_activation.js). Never throws
    // into the block loop: an unexpected fault in the gate itself is reported and halts,
    // because a gate that cannot decide must not wave the block through.
    async checkTrainActivation(blockToParse){
        let verdict;
        try {
            verdict = trainActivation.evaluateTrainActivation({
                height:   (this.config['COIN'] === 'BTC') ? blockToParse : null,
                network:  this.config['NETWORK'],
                required: this.resolveTrainActivationRequirement()
            });
        } catch(e){
            verdict = {
                status: 'halt', activeRuleSet: null, requiredRuleSet: null, requiredAtHeight: null,
                network: this.config['NETWORK'], height: blockToParse, classification: null,
                reason: 'train_activation: the activation gate itself failed to evaluate (' +
                        (e && e.message) + '); refusing to advance'
            };
        }
        this.trainActivation = verdict;

        if(verdict.status === 'clear'){
            if(this.stallReason && /^train_activation_halt:/.test(this.stallReason)){
                this.stallReason   = null;
                this.stallClearsAt = null;
            }
            return false;
        }

        if(verdict.status === 'pending'){
            // Loud on the transition, then periodic, so the announcement cannot be missed
            // and cannot drown the log during a long rolling-upgrade window.
            if((this._trainActivationHaltLogTick++ % 60) === 0)
                getLogger().error('XChainIndexer: TRAIN ACTIVATION PENDING - ' + verdict.reason);
            return false;
        }

        // HALT. Durable, because the next block is the forked one: a node that forgot its
        // halt across a restart would apply it. The marker is written once (the read below
        // is what keeps a deferring loop from inserting one row per poll).
        if((this._trainActivationHaltLogTick++ % 60) === 0)
            getLogger().error('XChainIndexer: TRAIN ACTIVATION HALT at block ' + blockToParse + ' - ' + verdict.reason +
                ' REQUIRED OPERATOR ACTION: update this node to the platform version that carries the ' +
                'required rule set. Clearing the marker by hand is not a supported path.');
        this.stallReason   = 'train_activation_halt: ' + verdict.reason;
        this.stallClearsAt = null;
        await this.recordTrainActivationHalt(blockToParse, verdict);
        return true;
    }

    // Write the durable halt marker, once. `events.data` is a VARCHAR(250), so the payload
    // carries the machine-readable fields (the required rule set, its height, the block the
    // halt fired at) and not the prose reason, which the log and health already carry in
    // full. A marker write that fails is logged and the halt still holds: the halt is a
    // refusal to advance, and it must not depend on a successful INSERT.
    async recordTrainActivationHalt(blockToParse, verdict){
        if(!this.indexerDb || typeof this.indexerDb.doQuery !== 'function') return;
        try {
            let existing = await this.indexerDb.getLatestTrainActivationHaltEvent();
            if(Array.isArray(existing) && existing.length > 0) return;
            let payload = JSON.stringify({
                requiredRuleSet:  verdict.requiredRuleSet || null,
                requiredAtHeight: verdict.requiredAtHeight === undefined ? null : verdict.requiredAtHeight,
                network:          verdict.network || null,
                haltedAtBlock:    blockToParse
            }).slice(0, 250);
            await this.indexerDb.recordTrainActivationHaltEvent(payload);
        } catch(e){
            getLogger().warn('XChainIndexer: could not record the TRAIN_ACTIVATION_HALT marker (' +
                (e && e.message) + '); the halt still holds.');
        }
    }

    async checkDecoderReorgHalt(){
        if(!this.decoderDb) return this.decoderReorgHalted;
        let halted;
        try {
            let probe = await this.decoderDb.isReorgHalted();
            halted = !!(probe && probe.halted);
            var payload = probe ? probe.payload : null;
        } catch(e){
            getLogger().warn('XChainIndexer: REORG_HALT probe failed (non-fatal), keeping last known state (' +
                this.decoderReorgHalted + '): ' + (e && e.message));
            return this.decoderReorgHalted;
        }
        if(halted && !this.decoderReorgHalted){
            getLogger().error('XChainIndexer: DECODER REORG HALT detected - the decoder wrote a durable ' +
                'REORG_HALT marker (a reorg it could not safely rewind) and will not advance. The ' +
                'indexer is now blocked behind it and will present as idle/lagging until resolved. ' +
                'OPERATOR ACTION: a full decoder resync (clean reindex of decoder+indexer) always ' +
                'resolves it; where the halt has been reviewed and a resync is not required, ' +
                '`xchain-node clear-reorg-halt` clears it in place.' +
                (payload ? ' Marker detail: ' + payload : ''));
            this._reorgHaltLogTick = 0;
        } else if(halted){
            // Periodic reminder while it stays halted (every ~60 polls), not every tick.
            if((this._reorgHaltLogTick++ % 60) === 0)
                getLogger().error('XChainIndexer: decoder still REORG-HALTED; resync the decoder or clear ' +
                    'the reviewed halt with `xchain-node clear-reorg-halt`.');
        } else if(!halted && this.decoderReorgHalted){
            getLogger().warn('XChainIndexer: decoder halt is no longer live; a newer REORG_HALT_CLEARED ' +
                'marker supersedes it, or the halt marker is absent.');
        }
        this.decoderReorgHalted = halted;
        return halted;
    }

    // Horizon for the hub price-mirror bound: the unix second below which no block
    // this indexer will process can read a price round. HubDbSync bootstraps price_snapshots
    // from here up, plus its own margin of pre-horizon rounds, instead of replaying the
    // oracle's entire history (411,609 rows / ~13 min on a testnet BTC reparse, growing by
    // ~5,184 rows a day forever) before the price barrier can arm.
    //
    // Derivation, and why each term is here:
    //   - the oldest block this node will process from here. Resuming, that is the tip it
    //     stopped at; with nothing indexed it is the decoder's FIRST block, which on a clean
    //     reindex sits at genesis and correctly yields a horizon so old that nothing is bound
    //     out at all. So a full replay still mirrors the full history, by construction.
    //   - two FIAT_DISPENSER_PRICE_WINDOWs, because reverseOraclePriceMatch's batched read
    //     reaches (blockTime - window) - window behind the block it settles.
    //   - one day of slop for block-time non-monotonicity (MTP, the 2h future-time allowance)
    //     and for a reorg rolling this node back below the resume point without a restart.
    // HubDbSync adds the round-count margin its own consensus reads need on top of this, and
    // polices the result: a block that turns up below the floor abandons the bound and
    // re-mirrors in full rather than settling short.
    //
    // Returns null - meaning "mirror everything", the unbounded behavior - whenever the
    // horizon cannot be established: no blocks anywhere yet, an unresolvable block time, or
    // any read fault. Never throws.
    // Resolve (and memoize) this chain's instance identity: the hash of BITCOIN block 1.
    //
    // Bitcoin only. The cross-chain tables are BTC-anchored, so the hub stamps its rows with
    // the id its Bitcoin indexer reports and every mirror fences on it; a DOGE or LTC indexer
    // has no such chain of its own to read and learns the id from the hub's snapshot
    // envelopes instead (HubDbSync.setExpectedBtcChainId with source 'hub').
    //
    // Returns null while block 1 is not in the decoder database yet, which is the normal
    // state of a freshly re-genesised regtest chain at startup: nothing is pushed and no
    // fence is armed until it resolves, and the caller retries once per parsed block. The
    // read is memoized because block 1's hash cannot change without a reorg that deep, which
    // is a new chain rather than an event this process survives.
    //
    // Never throws: the identity is transport (it enters no canonical and no block-hash
    // preimage), so a decoder read fault must never reach the block loop.
    async resolveBtcChainId(){
        if(this.btcChainId) return this.btcChainId;
        if(this.config['COIN'] !== 'BTC') return null;
        let hash = null;
        try {
            hash = await this.decoderDb.getDecoderBlockHash(1);
        } catch(e){
            return null;
        }
        if(typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return null;
        this.btcChainId = hash;
        getLogger().info('Chain identity  : BTC block 1 is ' + hash + ' (stamped on this hub\'s cross-chain rows)');
        // Authoritative for this node: a hub advertising another chain never overrides it.
        if(this.hubDbSync && typeof this.hubDbSync.setExpectedBtcChainId === 'function'){
            try { await this.hubDbSync.setExpectedBtcChainId(hash, 'local'); }
            catch(e){ getLogger().warn('HubDbSync: could not set the local chain identity:', e.message); }
        }
        return this.btcChainId;
    }

    async priceMirrorHorizon(){
        const SLOP_SECONDS = 86400;
        // Local null test rather than this.util.isNull: util is wired in start(), and a
        // horizon that silently answered "mirror everything" because a helper was missing
        // would be indistinguishable from a horizon that could not be established.
        const absent = (v) => (v === null || v === undefined);
        try {
            let lastIndexed = await this.indexerDb.getBlockIndex('indexer', 'last');
            // Anchor on a block that EXISTS. Resuming, that is the last block parsed rather
            // than the next one: the next block is often not decoded yet (a caught-up node
            // restarting), and one block earlier is the conservative direction anyway. Its
            // time is read from this node's own blocks table, which is guaranteed to hold it.
            let anchorDb    = absent(lastIndexed) ? this.decoderDb : this.indexerDb;
            let anchorBlock = absent(lastIndexed)
                                 ? await this.decoderDb.getBlockIndex('decoder', 'first')
                                 : Number(lastIndexed);
            if(absent(anchorBlock)) return null;
            // Raw stamp, not protocol time: this is a retention boundary compared against
            // hub round timestamps, not a consensus gate, and getRawBlockTime is the reader
            // that does not depend on the previous-block window existing yet.
            let blockTime = await anchorDb.getRawBlockTime(anchorBlock);
            if(blockTime === false || !Number.isFinite(Number(blockTime)) || Number(blockTime) <= 0)
                return null;
            let fiatWindow = parseInt((this.config || {})['FIAT_DISPENSER_PRICE_WINDOW']) || 86400;
            return Number(blockTime) - (2 * fiatWindow) - SLOP_SECONDS;
        } catch(e){
            getLogger().warn('XChainIndexer: price mirror horizon unavailable (' + (e && e.message) +
                '); the hub price mirror will bootstrap in full');
            return null;
        }
    }

    startHubConfigPolling(){
        if(!this.hubClient || !this.hubClient.configEnabled) return;
        if(this._hubConfigPollTimer) return;
        // Same reader the staleness boundary is derived from, so the reported boundary is
        // always three of THESE intervals.
        const intervalMs = effectiveHubConfigPollIntervalMs();
        // Guarded against self-overlap like _startStateTreeMetric below: a
        // getallconfigs call outrunning the interval (restarting/partitioned hub)
        // must not stack overlapping in-flight polls.
        this._hubConfigPollRunning = false;
        this._hubConfigPollTimer = setInterval(async () => {
            if(this._hubConfigPollRunning) return;   // a prior slow poll is still in flight
            this._hubConfigPollRunning = true;
            try {
                let { ok, configs, seq, watermark, coinConsensusHashes } = this.unwrapHubConfigResponse(await this.hubClient.getAllConfigs());
                // A usable envelope (not a { error: ... } failure result) means the hub
                // actually answered with config. A failed fetch must NOT refresh the freshness
                // signal, or a persistently config-DB-failing hub reports healthy while the
                // live-polled params are frozen.
                if(!ok){
                    getLogger().warn('XChainIndexer: hub config poll returned no usable config; not refreshing freshness signal');
                    return;
                }
                // Re-check hub/node consensus-config drift on every poll (not only at startup),
                // so a mid-run hub upgrade/downgrade to a divergent bundle is surfaced live.
                // The check is log-only / pinned-verify-only and cannot affect consensus.
                this.checkHubConsensusHash(coinConsensusHashes);
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
                // way: the hub's since_updated_at delta boundary is now inclusive `>=`,
                // so a new-enough hub no longer drops the same-second row, but
                // an older hub's strict `>` still would - the full-tree fetch is the
                // deployment-skew-proof choice, so do not thread the delta cursor here.
                // Hub restart / restore-from-older-snapshot: a REGRESSED seq or watermark
                // hits none of the three gates below, and the Math.max clamp keeps the stale
                // high value forever, so config re-apply stops until the hub climbs back past
                // it. Treat a regression as a cursor reset: re-merge and adopt the
                // served values verbatim, the way the startup overlay already does
                // (_applyHubConfigOverlay assigns seq/watermark unclamped). _mergeHubParams is
                // idempotent. Alarm loudly rather than self-heal in silence: a hub that lost
                // config state is an operator event, not a steady-state poll.
                let hubReset = (seq < (this.lastHubConfigSeq || 0)) ||
                               (watermark > 0 && watermark < (this.lastHubConfigWatermark || 0));
                if(hubReset){
                    getLogger().error('XChainIndexer: HUB CONFIG REGRESSION: hub served seq ' + seq +
                                  '/watermark ' + watermark + ', below last-seen ' + this.lastHubConfigSeq +
                                  '/' + this.lastHubConfigWatermark +
                                  ' (hub restart or restore from an older snapshot); re-applying hub config and resetting the cursor.');
                    this.mergeHubParams(configs);
                    this.lastHubConfigSeq       = seq;
                    this.lastHubConfigWatermark = watermark;
                    return;
                }
                let seqAdvanced       = seq > (this.lastHubConfigSeq || 0);
                let watermarkAdvanced = watermark > (this.lastHubConfigWatermark || 0);
                let watermarkRedeliver = watermark > 0 && watermark === (this.lastHubConfigWatermark || 0);
                if(seqAdvanced || watermarkAdvanced || watermarkRedeliver){
                    this.mergeHubParams(configs);
                    this.lastHubConfigSeq = Math.max(seq, this.lastHubConfigSeq || 0);
                    this.lastHubConfigWatermark = Math.max(watermark, this.lastHubConfigWatermark || 0);
                    // Only announce an actual advance; an equal-watermark redelivery re-merge
                    // is a steady-state no-op on a watermark-bearing hub and must not log-spam.
                    if(seqAdvanced || watermarkAdvanced)
                        getLogger().info('XChainIndexer: applied hub config update (committed seq ' + seq + ', watermark ' + watermark + ')');
                }
            } catch(err) {
                getLogger().warn('XChainIndexer: hub config poll failed, keeping current config:', err.message || err);
            } finally {
                this._hubConfigPollRunning = false;
            }
        }, intervalMs);
        if(this._hubConfigPollTimer.unref) this._hubConfigPollTimer.unref();
    }

    // Periodically emit a read-only orphan-count metric for the COW state_tree_nodes store so
    // its unbounded growth is observable. Runs on an unref'd interval (never holds
    // the process open), guarded against self-overlap, and reads on a POOLED connection so it never
    // touches the block-processing transaction. No deletion: see stateCommitment.reportOrphanStats.
    // Interval STATE_TREE_METRIC_INTERVAL_MS (default 4h; 0 disables).
    startStateTreeMetric(){
        if(this._stateTreeMetricTimer) return;
        const raw = parseInt(CONFIG_ENV.STATE_TREE_METRIC_INTERVAL_MS, 10);
        const intervalMs = Number.isFinite(raw) ? raw : (4 * 60 * 60 * 1000);
        if(intervalMs === 0) return;   // explicitly disabled
        this._stateTreeMetricRunning = false;
        this._stateTreeMetricTimer = setInterval(async () => {
            if(this._stateTreeMetricRunning) return;   // a prior slow scan is still running
            this._stateTreeMetricRunning = true;
            try {
                const stats = await stateCommitment.reportOrphanStats(
                    (sql, args) => this.indexerDb.poolQuery(sql, args),
                    this.config['COIN'], this.config['NETWORK']);
                if(stats.totalNodes === 0) return;   // pre-activation / empty store: nothing to report
                getLogger().info('[METRIC] ' + JSON.stringify({
                    metric: 'state_tree_orphan_nodes', component: 'indexer',
                    chain: this.config['COIN'], network: this.config['NETWORK'],
                    total_nodes: stats.totalNodes, reachable_nodes: stats.reachableNodes,
                    orphan_count: stats.orphanCount, reachability_skipped: stats.reachabilitySkipped,
                    // Publish the truncation flag or the line reads as a full-store figure:
                    // when the mark stops at the cap, orphan_count is an UPPER bound.
                    reachability_estimated: stats.reachabilityEstimated === true,
                    ts: Date.now()
                }));
            } catch(err) {
                getLogger().warn('XChainIndexer: state_tree orphan-metric failed for ' +
                    this.config['COIN'] + '/' + this.config['NETWORK'] + ':', err.message || err);
            } finally {
                this._stateTreeMetricRunning = false;
            }
        }, intervalMs);
        if(this._stateTreeMetricTimer.unref) this._stateTreeMetricTimer.unref();
        getLogger().info('XChainIndexer: state_tree orphan-metric started (interval ' + intervalMs + 'ms)');
    }

    // Periodic state-retention sweep. DEFAULT OFF: parseRetentionConfig returns
    // enabled=false unless STATE_ROOT_RETENTION_BLOCKS is a positive integer, and
    // this method returns before arming any timer in that case (current
    // keep-everything behavior unchanged). When enabled it runs runSweep: phase-1
    // root prune on a pooled connection, then, only if STATE_NODE_RECLAIM is opted
    // in, phase-2 orphan-node reclaim serialized against the block loop via the db
    // transaction mutex (runExclusive) so a concurrent forward insert can never
    // re-reference a node between the mark and the delete.
    startStateRetention(){
        if(this._stateRetentionTimer) return;
        const cfg = retention.parseRetentionConfig(process.env);
        if(!cfg.enabled) return;   // policy off: no timer, nothing prunes
        const runExclusive = async (fn) => {
            // Hold the same mutex block processing acquires in beginTransaction so
            // the mark+delete never interleaves with a forward block-root insert.
            await this.indexerDb.acquireTxLock();
            try { return await fn(); }
            finally { this.indexerDb.releaseTxLock(); }
        };
        this._stateRetentionRunning = false;
        this._stateRetentionTimer = setInterval(async () => {
            if(this._stateRetentionRunning) return;   // a prior slow sweep is still running
            this._stateRetentionRunning = true;
            try {
                const result = await retention.runSweep(
                    this.indexerDb, this.config['COIN'], this.config['NETWORK'], cfg,
                    { runExclusive });
                const rootsDeleted = result.roots && result.roots.deleted ? result.roots.deleted : 0;
                const nodesDeleted = result.nodes && result.nodes.deleted ? result.nodes.deleted : 0;
                if(rootsDeleted > 0 || nodesDeleted > 0){
                    getLogger().info('State retention: pruned ' + rootsDeleted + ' root(s) and reclaimed ' +
                        nodesDeleted + ' orphan node(s) for ' + this.config['COIN'] + '/' + this.config['NETWORK']);
                }
            } catch(err) {
                getLogger().warn('XChainIndexer: state-retention sweep failed for ' +
                    this.config['COIN'] + '/' + this.config['NETWORK'] + ':', err.message || err);
            } finally {
                this._stateRetentionRunning = false;
            }
        }, cfg.intervalMs);
        if(this._stateRetentionTimer.unref) this._stateRetentionTimer.unref();
        getLogger().info('XChainIndexer: state-retention started (keep ' + cfg.rootKeepBlocks +
            ' root-blocks, node-reclaim ' + (cfg.nodeReclaimEnabled ? 'ON' : 'off') +
            ', interval ' + cfg.intervalMs + 'ms)');
    }

}

module.exports = XChainIndexer;
module.exports.DEFAULT_HUB_CONFIG_POLL_INTERVAL_MS   = DEFAULT_HUB_CONFIG_POLL_INTERVAL_MS;
// Exported as functions, not constants: the cadence the timer uses and the boundary derived from
// it are both env-dependent at call time, and a snapshot taken at require() would be wrong for
// any consumer loaded before dotenv.config().
module.exports.effectiveHubConfigPollIntervalMs      = effectiveHubConfigPollIntervalMs;
module.exports.hubConfigStalenessLimitMs             = hubConfigStalenessLimitMs;
module.exports.hubConfigStaleness                    = hubConfigStaleness;
module.exports.stallWedged                           = stallWedged;
module.exports.waitingOnFutureBlock                  = waitingOnFutureBlock;
module.exports.stallClassOf                          = stallClassOf;
module.exports.atProcessableTip                      = atProcessableTip;
module.exports.nextBarrierHold                       = nextBarrierHold;
module.exports.barrierHoldMs                         = barrierHoldMs;
module.exports.barrierCeilingExceeded                = barrierCeilingExceeded;
module.exports.isMirrorBarrierReason                 = isMirrorBarrierReason;
module.exports.hubConfigCoinKey                      = hubConfigCoinKey;
