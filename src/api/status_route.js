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
                                              indexer.stallClearsAt);
    // Discriminate the healthy future-stamped-block wait from real degradation. One
    // clock read for all three so the fields can never disagree with each other.
    let futureWait  = XChainIndexer.waitingOnFutureBlock(indexer.stallReason, indexer.stallClearsAt, now);
    let stallClass  = XChainIndexer.stallClassOf(indexer.stallReason, indexer.lastBlockCommittedAt,
                                                 indexer.healthStallGraceMs, now, indexer.stallClearsAt);
    return { now, stalled, wedged, futureWait, stallClass,
             lastHubConfigFetchAt, hubConfigAgeSeconds, hubConfigStale };
}

// The /status JSON body, in the key order monitors have always read.
function statusBody(XChainIndexer, indexer, { indexerBlock, inFlightBlock, decoderBlock, verdict, hubMirror }){
    let { now, stalled, wedged, futureWait, stallClass,
          lastHubConfigFetchAt, hubConfigAgeSeconds, hubConfigStale } = verdict;
    return {
        indexerBlock: indexerBlock,
        inFlightBlock: inFlightBlock,
        decoderBlock: decoderBlock,
        lag:          (decoderBlock != null && indexerBlock != null)
                        ? decoderBlock - indexerBlock
                        : null,
        isSynced:     indexer.isSynced(),
        // true when every block consensus currently PERMITS this indexer to commit is
        // committed: level with the decoder tip, or the only thing in the way is a
        // future-stamped block it must legally wait out. Read this, not isSynced, before
        // concluding a non-zero lag means the indexer is behind: a testnet4 miner stamping
        // each block ~20 min ahead pins lag at ~6 blocks forever with isSynced stuck false,
        // while the indexer commits every block the instant it becomes processable.
        atProcessableTip: XChainIndexer.atProcessableTip(indexer.isSynced(), indexer.stallReason,
                                                         indexer.stallClearsAt, now),
        // Why the block counter is not advancing, or null when advancing normally:
        // a hub-sync barrier timeout (price/oracle/match/call/snapshot) or a VM
        // executor host fault. Lets a monitoring probe tell these stalls apart from
        // a healthy catch-up, all of which otherwise present only as a growing lag.
        stallReason:  indexer.stallReason || null,
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
        // 'barrier_defer' | 'wedged'.
        stallClass:   stallClass,
        // epoch-ms of the most recent successful block commit (null until the first),
        // so a probe can read advance-recency directly rather than infer it from lag.
        lastBlockCommittedAt: indexer.lastBlockCommittedAt || null,
        lastHubConfigFetchAt: lastHubConfigFetchAt,
        hubConfigAgeSeconds:  hubConfigAgeSeconds,
        hubConfigStale:       hubConfigStale,
        hubMirror:            hubMirror
    };
}

module.exports = { readDecoderBlock, hubMirrorStatus, statusVerdict, statusBody };
