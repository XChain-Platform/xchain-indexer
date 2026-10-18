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
 * XChain Indexer - GET /status parts
 *
 * The decoder tip read, the hub mirror snapshot, the clock-derived stall
 * verdict and the response body of the plain REST status endpoint. The route
 * itself stays in src/api.js: it owns the committed-only indexer height read,
 * the in-flight block and the 503 decision, and calls these in the order the
 * route always evaluated them.
 *
 * XChainIndexer is passed in rather than required: src/api.js loads it by its
 * own request path, and these parts use exactly the class it loaded.
 *
 ********************************************************************/

'use strict';

const { hubConsensusHashFields } = require('./health/hub_fields');
// Pure verdict modules, required directly rather than through the XChainIndexer class
// the route is handed, so a stub class in a test still gets the real rule.
const { barrierHoldMs, barrierCeilingExceeded, publishedStallClass } = require('../XChainIndexer/stall_health.js');
const { attributedStallReason, trainActivationReport } = require('./health/stall_fields');
const { readinessVerdict } = require('../XChainIndexer/readiness/verdict.js');

// The coin node tip for chainLag, or the empty shape when the indexer cannot read one
// (no tracker configured, or a stub without the method). Never throws.
async function readChainTip(indexer){
    try {
        if(indexer && typeof indexer.readChainTip === 'function')
            return await indexer.readChainTip();
    } catch (err) {
        // Reporting only: an unreadable tip is an unknown tip.
    }
    return { height: null, source: null, at: null };
}

// Tip, barrier-hold and readiness fields, inserted after stallClass so every key
// monitors already read keeps its place. lag above stays decoder-relative (consumers
// gate on it); chainLag is the same figure against the coin node tip, which keeps
// moving while a halted decoder's tip is frozen. ready / notReadyReasons are the
// readiness verdict (../XChainIndexer/readiness/verdict.js): reported here and answered
// as the status code of GET /ready, never folded into this route's 503.
function readinessFields(indexer, { indexerBlock, decoderBlock, verdict, indexerDbUnreachable, chainTip }){
    let now = verdict.now;
    let tip = chainTip || { height: null, source: null, at: null };
    let decoderLag = (decoderBlock != null && indexerBlock != null) ? decoderBlock - indexerBlock : null;
    let chainLag   = (Number.isFinite(tip.height) && indexerBlock != null) ? tip.height - indexerBlock : null;
    let pollSilent = (typeof indexer.isPollSilent === 'function') ? indexer.isPollSilent() : false;
    let holdMs     = barrierHoldMs(indexer.barrierHold, now);
    let exceeded   = barrierCeilingExceeded(indexer.barrierHold, indexer.barrierHoldCeilingMs, now);
    let readiness  = readinessVerdict({
        now:                    now,
        indexerDbUnreachable:   !!indexerDbUnreachable,
        wedged:                 !!verdict.wedged,
        pollSilent:             pollSilent,
        decoderReorgHalted:     !!indexer.decoderReorgHalted,
        barrierCeilingExceeded: exceeded,
        decoderLag:             decoderLag,
        chainLag:               chainLag,
        waitingOnFutureBlock:   !!verdict.futureWait,
        lastBlockCommittedAt:   indexer.lastBlockCommittedAt,
        startedAt:              indexer.startedAt,
        noCommitMs:             indexer.readyNoCommitMs
    });
    return {
        chainTip:               tip.height,
        chainTipSource:         tip.source,
        chainTipAt:             tip.at,
        chainLag:               chainLag,
        decoderReorgHalted:     !!indexer.decoderReorgHalted,
        barrierHoldMs:          holdMs,
        barrierHoldCeilingMs:   indexer.barrierHoldCeilingMs || null,
        barrierCeilingExceeded: exceeded,
        ready:                  readiness.ready,
        notReadyReasons:        readiness.reasons
    };
}

// The decoder's current tip, read fresh from the decoder DB; the indexer's
// in-memory snapshot when that DB is unreachable.
async function readDecoderBlock(indexer){
    let decoderBlock = null;
    try {
        if(indexer.decoderDb)
            decoderBlock = await indexer.decoderDb.getBlockIndex('decoder', 'last');
        if(decoderBlock != null) decoderBlock = Number(decoderBlock);
    } catch (err) {
        // Database unreachable; use in-memory snapshot as fallback
        decoderBlock = (indexer.lastDecoderBlock != null) ? Number(indexer.lastDecoderBlock) : null;
    }
    return decoderBlock;
}

// Hub mirror connectivity (row 48, attest-response-mirror spec). Absent
// entirely on a single-host deployment (HUB_DB_SYNC_ENABLED unset), so an
// honest verdict starts from whether the instance exists at all; a snapshot
// failure must not fail the whole probe, so it degrades to the same shape.
function hubMirrorStatus(indexer){
    let hubMirror;
    try {
        hubMirror = indexer.hubDbSync
            ? indexer.hubDbSync.mirrorStatus()
            : { configured: false, connected: false, bootstrapped: false, streamWatermark: null, tables: {} };
    } catch (err) {
        hubMirror = { configured: false, connected: false, bootstrapped: false, streamWatermark: null, tables: {} };
    }
    return hubMirror;
}

// The clock-derived half of /status: the hub config age, then the stall
// verdict (stalled, wedged, future-block wait, class) off one clock read.
function statusVerdict(XChainIndexer, indexer){
    // Age of the last successful hub-config fetch (null until the first success). A
    // climbing age here while the indexer otherwise looks synced is the signal that
    // the hub is unreachable and the live-polled governance params are stale.
    let lastHubConfigFetchAt = indexer.lastHubConfigFetchAt || null;
    // Age + explicit staleness via the one shared helper (same threshold as buildHealthResponse).
    let hubConfig            = XChainIndexer.hubConfigStaleness(lastHubConfigFetchAt, Date.now());
    let hubConfigAgeSeconds  = hubConfig.ageSeconds;
    let hubConfigStale       = hubConfig.stale;
    let now       = Date.now();
    let stalled   = !!indexer.stallReason;
    let wedged    = XChainIndexer.stallWedged(indexer.stallReason, indexer.lastBlockCommittedAt,
                                              indexer.healthStallGraceMs, now,
                                              indexer.stallClearsAt, indexer.priceLandingGraceMs,
                                              indexer.barrierHold && indexer.barrierHold.since);
    // Discriminate the healthy future-stamped-block wait from real degradation. One
    // clock read for all three so the fields can never disagree with each other.
    let futureWait  = XChainIndexer.waitingOnFutureBlock(indexer.stallReason, indexer.stallClearsAt, now);
    let stallClass  = XChainIndexer.stallClassOf(indexer.stallReason, indexer.lastBlockCommittedAt,
                                                 indexer.healthStallGraceMs, now, indexer.stallClearsAt,
                                                 indexer.priceLandingGraceMs,
                                                 indexer.barrierHold && indexer.barrierHold.since);
    return { now, stalled, wedged, futureWait, stallClass,
             lastHubConfigFetchAt, hubConfigAgeSeconds, hubConfigStale };
}

// Block-poll loop liveness, reported for the fleet watcher to page on and never
// folded into the 503 verdict (see health/advance_fields.js).
function pollHeartbeatFields(indexer){
    return {
        pollSilent: (typeof indexer.isPollSilent === 'function') ? indexer.isPollSilent() : false,
        lastPollAt: indexer.lastPollAt || null
    };
}

// The sync and stall half of the /status body, in the key order monitors have always read.
function statusSyncFields(XChainIndexer, indexer, { indexerBlock, inFlightBlock, decoderBlock, verdict,
                                                   indexerDbUnreachable, chainTip }){
    let { now, stalled, wedged, futureWait, stallClass } = verdict;
    // A halted decoder's tip is frozen, so an indexer level with it is not synced: it
    // is level with a chain that stopped. isSynced keeps its decoder-parity meaning
    // otherwise, and atProcessableTip follows it.
    let halted = !!indexer.decoderReorgHalted;
    let synced = indexer.isSynced() && !halted;
    return {
        indexerBlock: indexerBlock,
        inFlightBlock: inFlightBlock,
        decoderBlock: decoderBlock,
        lag:          (decoderBlock != null && indexerBlock != null)
                        ? decoderBlock - indexerBlock
                        : null,
        isSynced:     synced,
        // true when every block consensus currently PERMITS this indexer to commit is
        // committed: level with the decoder tip, or the only thing in the way is a
        // future-stamped block it must legally wait out. Read this, not isSynced, before
        // concluding a non-zero lag means the indexer is behind: a testnet4 miner stamping
        // each block ~20 min ahead pins lag at ~6 blocks forever with isSynced stuck false,
        // while the indexer commits every block the instant it becomes processable.
        atProcessableTip: XChainIndexer.atProcessableTip(synced, indexer.stallReason,
                                                         indexer.stallClearsAt, now),
        // Why the block counter is not advancing, or null when advancing normally:
        // a hub-sync barrier timeout (price/oracle/match/call/snapshot) or a VM
        // executor host fault. Lets a monitoring probe tell these stalls apart from
        // a healthy catch-up, all of which otherwise present only as a growing lag.
        // With no stall of its own behind a REORG-halted decoder it names that halt
        // (decoder_reorg_halt: ...), exactly as the health method does.
        stallReason:  attributedStallReason(indexer),
        // Epoch-ms at which the current time-keyed barrier can first be
        // satisfied, or null. Non-null means this indexer is waiting on WALL CLOCK
        // because the block it is on is stamped in the future, which is expected and
        // self-clearing; it is not counted as a wedge, and it tells a probe when the
        // chain should move again rather than leaving a valid stall looking like death.
        stallClearsAt: indexer.stallClearsAt || null,
        // true when a sync barrier is deferring blocks but the counter is still
        // advancing (healthy-degraded, stays 200); distinct from a wedge, which is
        // stalled AND making no progress inside the grace window (503).
        // NOTE it stays true during the future-stamped-block wait too, deliberately:
        // consumers keyed on `degraded === false` treat that as the wedge case, so
        // flipping it would UPGRADE a healthy wait to a critical alert. Read
        // waitingOnFutureBlock / stallClass to tell the two apart.
        degraded:     stalled && !wedged,
        // true when the stall is only a wait for wall clock to reach a future-stamped
        // block (stallClearsAt still ahead). Healthy and self-clearing: the indexer has
        // committed everything consensus lets it commit and will take the rest the
        // moment their stamps arrive. A monitor should not alert on this.
        waitingOnFutureBlock: futureWait,
        // Single machine-readable verdict on the counter, so a probe does not have to
        // join stallReason/degraded/stallClearsAt: 'none' | 'future_block_wait' |
        // 'bridge_proof_wait' | 'train_activation_halt' | 'price_landing_wait' |
        // 'barrier_defer' | 'wedged', plus the two a restart cannot clear
        // (publishedStallClass): 'upstream_halted' and 'rollcall_proof_wait', escalating
        // to 'rollcall_proof_stuck' past the hold ceiling.
        stallClass:   publishedStallClass(stallClass, indexer.stallReason, { decoderReorgHalted: halted,
            ceilingExceeded: barrierCeilingExceeded(indexer.barrierHold, indexer.barrierHoldCeilingMs, now) }),
        ...readinessFields(indexer, { indexerBlock, decoderBlock, verdict, indexerDbUnreachable, chainTip })
    };
}

// The /status JSON body, in the key order monitors have always read.
function statusBody(XChainIndexer, indexer, { indexerBlock, inFlightBlock, decoderBlock, verdict, hubMirror,
                                             indexerDbUnreachable, chainTip }){
    let { lastHubConfigFetchAt, hubConfigAgeSeconds, hubConfigStale } = verdict;
    return {
        ...statusSyncFields(XChainIndexer, indexer, { indexerBlock, inFlightBlock, decoderBlock, verdict,
                                                      indexerDbUnreachable, chainTip }),
        // epoch-ms of the most recent successful block commit (null until the first),
        // so a probe can read advance-recency directly rather than infer it from lag.
        lastBlockCommittedAt: indexer.lastBlockCommittedAt || null,
        lastHubConfigFetchAt: lastHubConfigFetchAt,
        hubConfigAgeSeconds:  hubConfigAgeSeconds,
        hubConfigStale:       hubConfigStale,
        schemaReady:          indexer.schemaReady === true,
        // /status and the health payload publish the same train activation verdict object.
        train_activation:     trainActivationReport(indexer),
        hubMirror:            hubMirror,
        ...pollHeartbeatFields(indexer),
        ...hubConsensusHashFields(indexer)
    };
}

module.exports = { readDecoderBlock, readChainTip, hubMirrorStatus, statusVerdict, statusBody };
