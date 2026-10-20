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
 * XChain Indexer - Readiness verdict
 *
 * Whether this indexer is SERVING current chain state, as distinct from whether
 * its process is alive. GET /status keeps the liveness contract the container
 * healthcheck and its autoheal loop read (503 only on a DB fault or a wedge a
 * restart can clear). GET /ready, and the `ready` / `notReadyReasons` fields on
 * /status, report this verdict instead.
 *
 * The split exists because the faults below survive a restart. A decoder REORG_HALT
 * marker is released only by an operator clear, a block held behind a proof or mirror
 * barrier re-arms on the same block after a reboot, and a restart resets
 * lastBlockCommittedAt to null, which stallWedged() reads as "slow initial catch-up"
 * forever after. Gating liveness on any of them would restart-loop the container
 * without fixing anything, so they lived only in log lines and the JSON-RPC health
 * payload while /status and docker health both read healthy. The roll-call and
 * capability proof waits are the one bounded exception: past proofWaitGraceMs they
 * wedge once, for a restart that can clear in-memory proof state, and after it the
 * null lastBlockCommittedAt leaves them to this verdict alone.
 *
 * Pure: hashes nothing, gates no wait, changes no consensus value.
 *
 ********************************************************************/

'use strict';

// How long the indexer may sit behind a known tip without committing a block before
// it is not ready. Readiness, not liveness, so it is generous: well past the stall grace
// and the price-landing grace, so a slow block or an ordinary barrier defer never reads
// as not ready, while a block that has not moved for ten minutes with work waiting does.
const READY_NO_COMMIT_DEFAULT_MS = 600000;

// Blocks between this indexer and the furthest tip it knows about, or null when no tip
// is known. decoderLag is decoder tip minus indexer height; chainLag is the coin node tip
// (via the utxo tracker) minus indexer height. The chain tip is the one that still moves
// while the decoder is halted, which is why both are read.
function blocksBehind(decoderLag, chainLag){
    let known = [decoderLag, chainLag].filter((v) => Number.isFinite(v));
    if(known.length === 0) return null;
    return Math.max(0, ...known);
}

// The readiness verdict. Every input is a plain value so the rule is testable without
// a block loop. Returns { ready, reasons, behind, noCommitForMs } where reasons is the
// ordered list of every condition that holds (empty when ready):
//   indexer_db_unreachable - the committed height cannot be read.
//   wedged                 - the liveness wedge (stallClass 'wedged').
//   poll_silent            - the block-poll loop has stopped iterating.
//   decoder_reorg_halt     - the paired decoder carries a live REORG_HALT marker, so
//                            nothing past the halted height will ever arrive.
//   barrier_ceiling_exceeded - one block has been held behind a barrier for longer
//                            than its named ceiling.
//   behind_tip_no_commit   - behind a known tip and no block committed for noCommitMs,
//                            counted from boot when nothing has committed since.
// A future-stamped block wait is never behind_tip_no_commit: consensus forbids
// committing that block yet, so the indexer holds everything it may hold.
function readinessVerdict(input){
    let {
        now, indexerDbUnreachable, wedged, pollSilent, decoderReorgHalted,
        barrierCeilingExceeded, decoderLag, chainLag, waitingOnFutureBlock,
        lastBlockCommittedAt, startedAt, noCommitMs
    } = input || {};
    let reasons = [];
    if(indexerDbUnreachable) reasons.push('indexer_db_unreachable');
    if(wedged) reasons.push('wedged');
    if(pollSilent) reasons.push('poll_silent');
    if(decoderReorgHalted) reasons.push('decoder_reorg_halt');
    if(barrierCeilingExceeded) reasons.push('barrier_ceiling_exceeded');

    let behind = blocksBehind(decoderLag, chainLag);
    // Since boot when nothing has committed: a restart must not reset the clock to
    // "never judged", which is the hole stallWedged() has by design.
    let progressAt = Number.isFinite(lastBlockCommittedAt) && lastBlockCommittedAt > 0
        ? lastBlockCommittedAt
        : (Number.isFinite(startedAt) && startedAt > 0 ? startedAt : null);
    let noCommitForMs = (progressAt != null && Number.isFinite(now)) ? Math.max(0, now - progressAt) : null;
    if(behind != null && behind > 0 && !waitingOnFutureBlock
       && Number.isFinite(noCommitMs) && noCommitMs > 0
       && noCommitForMs != null && noCommitForMs > noCommitMs)
        reasons.push('behind_tip_no_commit');

    return { ready: reasons.length === 0, reasons: reasons, behind: behind, noCommitForMs: noCommitForMs };
}

// The no-commit window from INDEXER_READY_NO_COMMIT_MS, or the default. A value that
// is not a positive integer falls back to the default rather than disabling the check.
function resolveReadyNoCommitMs(raw){
    let parsed = Number(raw);
    if(raw === undefined || raw === null || raw === '' || !Number.isSafeInteger(parsed) || parsed <= 0)
        return READY_NO_COMMIT_DEFAULT_MS;
    return parsed;
}

module.exports = { READY_NO_COMMIT_DEFAULT_MS, blocksBehind, readinessVerdict, resolveReadyNoCommitMs };
