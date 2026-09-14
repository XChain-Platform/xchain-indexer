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
 * XChain Indexer - Instance state
 *
 * The indexer's runtime fields, grouped by concern. The constructor sets its
 * connection settings itself and calls each initializer here, in this order, to
 * set everything else to its starting value.
 *
 ********************************************************************/

const { CONFIG_ENV } = require('../config.js');
// The hold ceiling comes from the same named constant HubDbSync throttles its forced
// resync on (see initBarrierTiming).
const { resolveBarrierHoldCeilingMs } = require('../hub/hub_db_sync.js');

// Chain identity, stall and loop-liveness fields: what /health reads to tell an
// advancing, deferring, wedged or silent block loop apart.
function initChainState(indexer){
    // This chain's instance identity: the hash of BLOCK 1, read once from the decoder
    // database. BITCOIN ONLY - the cross-chain tables are BTC-anchored, so this is the
    // id the hub stamps on them and every mirror fences on. Block 0 cannot serve: the
    // regtest genesis hash is a chainparams constant, identical across every re-genesis,
    // while block 1 commits to the instant the chain was created. Null until block 1 is
    // parsed, which on a freshly re-genesised chain is not true at startup, so the read
    // is retried once per parsed block until it resolves (see resolveBtcChainId).
    indexer.btcChainId = null;

    // Short machine-readable reason the block counter is currently not advancing,
    // or null when advancing normally. Set at each point where the catch-up loop
    // defers a block (the hub-sync barriers below time out, or the VM executor is
    // unavailable) and cleared the moment a block commits. Surfaced by health() so
    // an operator can tell WHY lag is growing (a sync-barrier stall, a circuit
    // breaker, and a host fault otherwise all look identical: a rising lag).
    indexer.stallReason = null;
    // Wall-clock (epoch ms) at which the CURRENT stall's barrier can first be
    // satisfied, or null when the stall has no such instant. Only the time-keyed barriers
    // set it, because only they wait on wall clock: a future-stamped block defers until
    // its own timestamp (plus the watermark grace) actually arrives. Read by stallWedged()
    // so that expected, self-clearing wait is not reported as a wedge. Cleared alongside
    // stallReason on every successful commit.
    indexer.stallClearsAt = null;
    // Wall-clock (epoch ms) of the most recent SUCCESSFUL block commit, or null until the
    // first block commits. Stamped at the commit point alongside the stallReason clear, and
    // read by the /status healthcheck to tell an advancing-but-barrier-deferring indexer
    // (healthy) from a genuinely wedged one (see stallWedged).
    indexer.lastBlockCommittedAt = null;
    // Wall-clock (epoch ms) of the most recent block-poll ITERATION, 0 until the loop has
    // run once. Distinct from lastBlockCommittedAt above, which only moves on a COMMIT and
    // is therefore old in the healthy case too on a caught-up or quiet chain: it cannot tell
    // "no new blocks" from "the loop is gone". Every freshness field the health payload reads
    // is written inside the loop, so a poll that hangs in an await freezes all of them at
    // their last good values and health keeps answering healthy forever. Stamped by BOTH the
    // outer poll loop and the inner catch-up loop, since an initial sync legitimately stays
    // inside the inner one for hours. Read by isPollSilent().
    indexer.lastPollAt = 0;
}

// The platform-train verdict and the decoder REORG_HALT bookkeeping, each empty until
// the loop first evaluates it.
function initHaltState(indexer){
    // Set true when the decoder has written a durable REORG_HALT marker (a reorg it
    // could not safely rewind). Surfaced on /health so a halted decoder is not mistaken for
    // ordinary idle/lag. Updated by checkDecoderReorgHalt(); the log-tick counter keeps the
    // periodic reminder from firing every tight poll.
    indexer.decoderReorgHalted   = false;
    indexer._reorgHaltLogTick    = 0;
    // The platform-train consensus activation verdict for the block the loop is about
    // to apply (src/train_activation.js), or null before
    // the first evaluation. `pending` means the signed release manifest names a rule set
    // this build does not implement and the boundary is still ahead, which health reports
    // and the monitor alerts on so the halt is ANNOUNCED before it fires; `halt` means
    // the boundary is reached and this node will not apply the block. Kept on the
    // instance rather than recomputed by health so both surfaces report one verdict.
    indexer.trainActivation      = null;
    indexer._trainActivationHaltLogTick = 0;
    // The trainActivation block of the signed release manifest this node was installed
    // from, resolved once and cached (undefined until the first resolution, null when the
    // manifest carries none, which is every MINOR and PATCH train). A resolution FAULT is
    // not cached, so a manifest that becomes readable later is picked up.
    indexer._trainActivationRequired = undefined;
    indexer.blockchainInfoLastBlock = -1
}

// Hub-config freshness and change cursor, advanced by the startup overlay and each poll.
function initHubConfigState(indexer){
    // Wall-clock (epoch ms) of the most recent SUCCESSFUL hub-config fetch. Set by the
    // startup overlay and every poll tick that gets a response, regardless of whether the
    // committed config actually changed. Stays null until the first success. Surfaced as
    // an age in the health/status endpoints so an operator can tell that a hub outage has
    // left the live-applied overlay params (the tunable/display-only ones) stale while the
    // indexer keeps reporting healthy. This age measures hub reachability, nothing more.
    // Consensus params (ACTIVATION_DELAY_BLOCKS, EXPIRATION_FEE_PER_DAY, STAKING) are NOT
    // live-polled at any time: they are read once at boot from the per-chain local config
    // and change only by a coordinated node upgrade, so a hub outage cannot freeze them
    // (mergeHubParams excludes them deliberately; health.js states the same).
    indexer.lastHubConfigFetchAt = null;

    // Last hub-config change signals seen. seq = PBFT-committed change counter (0 on a
    // standalone/config-oracle hub with no consensus); watermark = MAX(updated_at) over
    // the hub's configs, which advances on ANY config write. A re-apply fires when
    // EITHER advances, so a non-consensus hub's edits are not silently ignored.
    indexer.lastHubConfigSeq = 0;
    indexer.lastHubConfigWatermark = 0;
}

// Barrier timing and hold state: the per-attempt timeout, the hold ceiling and record,
// the price-barrier skip flags, and the two health windows sized off the timeout.
function initBarrierTiming(indexer){
    // Price-sync barrier timeout (ms). Before processing a block, the indexer waits for
    // its local price mirror to catch up to that block height so native-coin fee
    // validation is deterministic across operators. On timeout the block is deferred and
    // retried rather than validated against a stale price copy.
    indexer.priceSyncTimeoutMs = parseInt(CONFIG_ENV.HUB_PRICE_SYNC_TIMEOUT_MS || '60000');

    // Mirror-barrier hold ceiling. priceSyncTimeoutMs above bounds ONE barrier attempt;
    // this bounds the whole hold across retries, a quantity nothing else here bounds at
    // all. Read from the same named constant HubDbSync throttles its forced resync on,
    // so the crossing and the remedy cannot disagree. Purely operational: it opens no
    // barrier and commits no block (see nextBarrierHold).
    indexer.barrierHoldCeilingMs = resolveBarrierHoldCeilingMs();
    // { block, reason, since, notified } for the block currently held behind a mirror
    // barrier, or null when nothing is held. Folded by nextBarrierHold() once per
    // poll-loop pass and cleared on every successful commit.
    indexer.barrierHold = null;
    // Count of ceiling crossings since boot, surfaced on /health so a fleet sweep can
    // see that a mirror needed re-driving without reading container logs.
    indexer.barrierCeilingHits = 0;

    // Action-scoped barrier state, all node-local and never hashed.
    // priceBarrierBlock      - the block the two flags below describe.
    // priceBarrierSkipped    - the price/oracle barriers were skipped for it because
    //                          priceReadPredicate proved no transaction-borne price
    //                          reader; read by db.assertPriceBarrierNotSkipped().
    // priceBarrierForceBlock - a block that must take the barriers unconditionally on
    //                          its next attempt, set when that assertion fired. Cleared
    //                          once that block commits, so it is a one-shot escalation
    //                          rather than a latch that would re-arm the every-block wait.
    indexer.priceBarrierBlock      = null;
    indexer.priceBarrierSkipped    = false;
    indexer.priceBarrierForceBlock = null;

    // Grace window (ms) for the /status healthcheck's stall discriminator. A set stallReason
    // reports the container unhealthy (503) only after NO block has committed for this long, so
    // a BTC-mainnet indexer perpetually deferring the newest block behind a price mirror that is
    // itself advancing (its steady state) commits every few seconds and stays healthy, while a
    // genuinely wedged indexer (mirror down, host fault) trips 503 once it exceeds the window.
    // Defaults to comfortably more than one barrier-timeout cycle so a single legitimate defer
    // never flaps the healthcheck. Purely operational, NOT a consensus parameter.
    indexer.healthStallGraceMs = parseInt(CONFIG_ENV.INDEXER_HEALTH_STALL_GRACE_MS
                                       || String(Math.max(2 * indexer.priceSyncTimeoutMs, 120000)), 10);

    // Window (ms) the block-poll loop may go without completing an ITERATION before
    // isPollSilent() calls it dead. Sized off healthStallGraceMs, which is already at
    // least two barrier-timeout cycles, and doubled again on top: one block can hold a
    // single iteration across several sequential barrier waits, and this signal must
    // never fire on a block that is merely slow. It measures loop LIVENESS, never chain
    // progress, so unlike stallWedged it has nothing to do with commits. Purely
    // operational, NOT a consensus parameter.
    indexer.pollSilentMs = parseInt(CONFIG_ENV.INDEXER_POLL_SILENT_MS
                                 || String(2 * indexer.healthStallGraceMs), 10);
}

// The direct-hub-DB call-presence timeout and the two graces start() resolves.
function initDirectCallState(indexer){
    // Direct-hub-DB call-presence barrier timeout (ms). In single-host / direct-hub-DB
    // mode there is no HubDbSync mirror, so the cross-chain-call sync barrier is skipped.
    // But reading the hub's MariaDB directly does NOT mean a relay row was already WRITTEN
    // when this block was processed. Before the cross-chain-call pass, the indexer waits
    // (bounded) for any in-flight hub write to land, so a live node and a replaying node
    // inject at the same block. The hub-side relay margin is the primary guarantee; this
    // is defense-in-depth. See waitForDirectCallPresence.
    indexer.callPresenceTimeoutMs = parseInt(CONFIG_ENV.XCALL_DIRECT_PRESENCE_TIMEOUT_MS || '10000');

    // Grace (seconds) for the direct-hub-DB barrier's hub-clock escape hatch. Resolved in
    // start() from the SAME frozen constant the HubDbSync call barrier uses
    // (HUB_SYNC_WATERMARK_GRACE_S.call / HUB_SYNC_CALL_GRACE_S), because the two barriers
    // decide the same question and a per-node value forks settlement. Resolution happens at
    // startup, never inside the block loop, so an invalid regtest override throws at boot
    // (resolveWatermarkGrace's contract) instead of wedging the tip mid-run.
    indexer.directCallGraceS = null;

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
    indexer.anchorAttestArrivalMarginS = null;
}

module.exports = { initChainState, initHaltState, initHubConfigState, initBarrierTiming, initDirectCallState };
