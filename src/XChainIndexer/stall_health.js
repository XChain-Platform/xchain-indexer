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
 * XChain Indexer - Stall and barrier-hold verdicts
 *
 * Pure health verdicts over the block loop's stall fields: whether a stall is a
 * wedge or a future-stamped wait, the one-field stall class, and the mirror-barrier
 * hold record with its ceiling. They hash nothing and gate no wait. Re-exported by
 * ../XChainIndexer.js, which api/health.js and the tests read them through.
 *
 ********************************************************************/

// Define health-matched reasons once and import them at each block-loop raise site.
// Keep the bridge proof reason at its consensus owner.
const { BRIDGE_PROOF_BARRIER } = require('../consensus/bridge_proof_client/stall.js');
const PRICE_LANDING_BARRIER = 'price_landing_barrier';
const ROLLCALL_PROOF_REASON = 'rollcall_proof_unavailable';
const CAPABILITY_PROOF_REASON = 'capability_proof_unavailable';
const RETROACTIVE_REPLAY_NEEDS_GO = 'retroactive_replay_needs_go';
const RETROACTIVE_REPLAY_DIVERGED = 'retroactive_replay_diverged';
// Raised for the whole of a reorg rollback, which is one transaction inside one poll pass.
const REORG_ROLLBACK_REASON = 'reorg_rollback';
// The rollback window is this many stall graces: a restart discards the whole transaction,
// so a slow rollback must outlast the restart that a hung one is owed.
const ROLLBACK_GRACE_FACTOR = 5;
// Marks a safety halt raised while evaluating or enforcing train activation.
const TRAIN_ACTIVATION_HALT_PREFIX = 'train_activation_halt:';

function isTrainActivationHalt(stallReason){
    return typeof stallReason === 'string' && stallReason.startsWith(TRAIN_ACTIVATION_HALT_PREFIX);
}

function isOperatorActionHold(stallReason){
    if(typeof stallReason !== 'string') return false;
    const word = stallReason.trim().split(/[\s:]/)[0];
    return word === RETROACTIVE_REPLAY_NEEDS_GO || word === RETROACTIVE_REPLAY_DIVERGED;
}

// Use dedicated price-landing, proof-wait and rollback grace windows when valid.
// Every other reason falls back to the generic stall grace.
function graceFor(stallReason, graceMs, priceLandingGraceMs, proofWaitGraceMs, rollbackGraceMs){
    if(stallReason === PRICE_LANDING_BARRIER && Number.isFinite(priceLandingGraceMs) && priceLandingGraceMs > 0)
        return priceLandingGraceMs;
    if(stallReason === REORG_ROLLBACK_REASON && Number.isFinite(rollbackGraceMs) && rollbackGraceMs > 0)
        return rollbackGraceMs;
    if((stallReason === ROLLCALL_PROOF_REASON || stallReason === CAPABILITY_PROOF_REASON)
       && Number.isFinite(proofWaitGraceMs) && proofWaitGraceMs > 0)
        return proofWaitGraceMs;
    return graceMs;
}

// The proof-wait window: twice the barrier hold ceiling, never below the stall grace, so
// the ceiling's *_proof_stuck class always shows before the wedge. A disabled ceiling
// (0 or unusable) leaves the stall grace. Operational only, NOT a consensus parameter.
function resolveProofWaitGraceMs(graceMs, barrierHoldCeilingMs){
    let ceilingMs = (Number.isFinite(barrierHoldCeilingMs) && barrierHoldCeilingMs > 0) ? barrierHoldCeilingMs : 0;
    return Math.max(2 * ceilingMs, graceMs);
}

// The rollback window: a multiple of the stall grace, so it never falls below it. An
// unusable stall grace is returned as it came. Operational only, NOT a consensus parameter.
function resolveRollbackGraceMs(graceMs){
    if(!Number.isFinite(graceMs) || graceMs <= 0) return graceMs;
    return ROLLBACK_GRACE_FACTOR * graceMs;
}

// The instant the current stall's no-progress window opens beyond the last commit: a
// running rollback's own start, otherwise the held block's barrier hold start. The
// rollback stamp counts only while its reason is raised, so a stamp that outlives the
// rollback can never stand in for a later stall's window.
function stallWindowSince(indexer){
    if(indexer.stallReason === REORG_ROLLBACK_REASON && Number.isFinite(indexer.rollbackStartedAt))
        return indexer.rollbackStartedAt;
    return indexer.barrierHold ? indexer.barrierHold.since : null;
}

// A stall wedges only after its reason-specific grace, measured from the latest
// progress boundary: the last commit, hold start, or future-wait clear instant.
// Future-clearable and non-restartable waits do not wedge.
function stallWedged(stallReason, lastBlockCommittedAt, graceMs, now, stallClearsAtMs = null, priceLandingGraceMs = null, barrierHoldSinceMs = null, proofWaitGraceMs = null, rollbackGraceMs = null){
    if(!stallReason) return false;
    if(stallReason === BRIDGE_PROOF_BARRIER) return false;
    if(isTrainActivationHalt(stallReason)) return false;
    if(isOperatorActionHold(stallReason)) return false;
    if(lastBlockCommittedAt == null) return false;
    if(Number.isFinite(stallClearsAtMs) && now < stallClearsAtMs) return false;
    let windowStart = Number.isFinite(barrierHoldSinceMs) ? Math.max(lastBlockCommittedAt, barrierHoldSinceMs) : lastBlockCommittedAt;
    if(Number.isFinite(stallClearsAtMs)) windowStart = Math.max(windowStart, stallClearsAtMs);
    return (now - windowStart) > graceFor(stallReason, graceMs, priceLandingGraceMs, proofWaitGraceMs, rollbackGraceMs);
}

// A stall with a finite clear instant still ahead of now is a healthy
// future-block wait, not degraded health.
function waitingOnFutureBlock(stallReason, stallClearsAtMs, now){
    if(!stallReason) return false;
    if(!Number.isFinite(stallClearsAtMs)) return false;
    return now < stallClearsAtMs;
}

// Collapse health inputs to one mutually exclusive class for status probes.
// Future waits, proof waits, safety holds, active defers, and wedges stay distinct.
function stallClassOf(stallReason, lastBlockCommittedAt, graceMs, now, stallClearsAtMs = null, priceLandingGraceMs = null, barrierHoldSinceMs = null, proofWaitGraceMs = null, rollbackGraceMs = null){
    if(!stallReason) return 'none';
    if(stallReason === BRIDGE_PROOF_BARRIER) return 'bridge_proof_wait';
    if(isTrainActivationHalt(stallReason)) return 'train_activation_halt';
    if(isOperatorActionHold(stallReason)) return 'operator_action_hold';
    if(waitingOnFutureBlock(stallReason, stallClearsAtMs, now)) return 'future_block_wait';
    if(stallWedged(stallReason, lastBlockCommittedAt, graceMs, now, stallClearsAtMs, priceLandingGraceMs, barrierHoldSinceMs,
                   proofWaitGraceMs, rollbackGraceMs)) return 'wedged';
    if(stallReason === PRICE_LANDING_BARRIER) return 'price_landing_wait';
    return 'barrier_defer';
}

// Refine published upstream and proof-wait classes without weakening 'wedged'.
// Proof waits become stuck at the hold ceiling and wedge only after their grace.
function publishedStallClass(baseClass, stallReason, { decoderReorgHalted = false, ceilingExceeded = false } = {}){
    if(baseClass === 'wedged') return baseClass;
    if(!stallReason && decoderReorgHalted) return 'upstream_halted';
    if(stallReason === ROLLCALL_PROOF_REASON)
        return ceilingExceeded ? 'rollcall_proof_stuck' : 'rollcall_proof_wait';
    if(stallReason === CAPABILITY_PROOF_REASON)
        return ceilingExceeded ? 'capability_proof_stuck' : 'capability_proof_wait';
    return baseClass;
}

// The processable tip is reached at decoder-tip parity or while only a
// future-stamped block remains unavailable.
function atProcessableTip(isSynced, stallReason, stallClearsAtMs, now){
    return !!isSynced || waitingOnFutureBlock(stallReason, stallClearsAtMs, now);
}

// Track one block's mirror-barrier hold across retries and reason changes.
// Reset for progress, future waits, proof waits, activation halts, and operator holds.
function nextBarrierHold(prev, block, stallReason, stallClearsAtMs, now){
    if(!stallReason || block == null) return null;
    if(stallReason === BRIDGE_PROOF_BARRIER) return null;
    if(isTrainActivationHalt(stallReason)) return null;
    if(isOperatorActionHold(stallReason)) return null;
    if(waitingOnFutureBlock(stallReason, stallClearsAtMs, now)) return null;
    if(prev && prev.block === block)
        return { block: block, reason: stallReason, since: prev.since, notified: prev.notified };
    return { block: block, reason: stallReason, since: now, notified: false };
}

// Match '_barrier' on the leading word; nextBarrierHold excludes bridge proof waits.
// list_share_snapshot_barrier is raised outside the defer chain and deliberately
// remains resync-able because its snapshot is not mirrored yet.
function isMirrorBarrierReason(stallReason){
    return typeof stallReason === 'string' && /_barrier$/.test(stallReason.trim().split(/[\s:]/)[0]);
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

module.exports = {
    PRICE_LANDING_BARRIER,
    ROLLCALL_PROOF_REASON,
    CAPABILITY_PROOF_REASON,
    RETROACTIVE_REPLAY_NEEDS_GO,
    RETROACTIVE_REPLAY_DIVERGED,
    REORG_ROLLBACK_REASON,
    TRAIN_ACTIVATION_HALT_PREFIX,
    isTrainActivationHalt,
    isOperatorActionHold,
    stallWedged,
    resolveProofWaitGraceMs,
    resolveRollbackGraceMs,
    stallWindowSince,
    waitingOnFutureBlock,
    stallClassOf,
    publishedStallClass,
    atProcessableTip,
    nextBarrierHold,
    isMirrorBarrierReason,
    barrierHoldMs,
    barrierCeilingExceeded
};
