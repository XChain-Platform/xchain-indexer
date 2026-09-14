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

module.exports = {
    stallWedged,
    waitingOnFutureBlock,
    stallClassOf,
    atProcessableTip,
    nextBarrierHold,
    isMirrorBarrierReason,
    barrierHoldMs,
    barrierCeilingExceeded
};
