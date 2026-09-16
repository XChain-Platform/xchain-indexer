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
 * XChain Indexer - Health response: advance and liveness fields
 *
 * The block-commit recency, poll-loop liveness and stall discriminator fields
 * of the `health` payload (lastBlockCommittedAt through stallClearsAt).
 * buildHealthResponse (src/api/health.js) spreads the returned object at the
 * position these fields always held, so the payload keeps its key order.
 *
 ********************************************************************/

const { stallWedged, waitingOnFutureBlock, stallClassOf, atProcessableTip } = require('../../XChainIndexer');

// Is the counter advancing, is the poll loop alive, and if a stall is set, is it
// a healthy wait, a barrier defer or a wedge. `now` is the caller's one clock read.
function advanceFields(indexer, now){
    return {
        // Advance-recency for the stall discriminator, mirrored from the /status
        // healthcheck so both endpoints tell one story: the epoch-ms of the last successful
        // block commit, and whether a set stallReason is a healthy-degraded barrier defer (the
        // counter is still advancing) rather than a genuine wedge.
        lastBlockCommittedAt: indexer.lastBlockCommittedAt || null,
        // Block-poll loop LIVENESS, a different axis from every stall field around it and the
        // only one that can see a loop hung inside an await: stallReason needs a barrier to
        // have been hit, lag/decoderBlock are written inside the loop and freeze with it, and
        // lastBlockCommittedAt is legitimately old on a quiet chain in the healthy case too.
        // Reported, and deliberately NOT folded into `status` or the /status 503 gate: a single
        // iteration can hold across several sequential barrier waits, and restarting the
        // container is the wrong answer to a slow block. The monitor crits on it instead.
        pollSilent:       (typeof indexer.isPollSilent === 'function') ? indexer.isPollSilent() : false,
        lastPollAt:       indexer.lastPollAt || null,
        // NOTE degraded stays true during the healthy future-stamped-block wait as well,
        // deliberately: the monitor rules key on `degraded === false` for the wedge case, so
        // flipping it there would turn a healthy wait into a crit. waitingOnFutureBlock and
        // stallClass below are how the two are told apart.
        degraded:         !!indexer.stallReason
                            && !stallWedged(indexer.stallReason, indexer.lastBlockCommittedAt,
                                            indexer.healthStallGraceMs, now, indexer.stallClearsAt),
        // true when the stall is nothing but a wait for wall clock to reach a future-stamped
        // block. Healthy and self-clearing: consensus forbids committing that block yet, so the
        // indexer is already holding everything it is permitted to hold. A testnet4 miner
        // stamping each block ~20 min ahead makes this the PERMANENT steady state, with lag
        // pinned at ~6 blocks and stallReason naming whichever time-keyed barrier is waiting.
        waitingOnFutureBlock: waitingOnFutureBlock(indexer.stallReason, indexer.stallClearsAt, now),
        // Single machine-readable verdict on the block counter, so a monitor reads one field
        // instead of joining three: 'none' | 'future_block_wait' | 'barrier_defer' | 'wedged'.
        stallClass:       stallClassOf(indexer.stallReason, indexer.lastBlockCommittedAt,
                                       indexer.healthStallGraceMs, now, indexer.stallClearsAt),
        // true when every block consensus currently PERMITS this indexer to commit is
        // committed (level with the decoder tip, or the only blocker is a future-stamped
        // block). The "functionally caught up" signal: `synced` keeps its literal
        // decoder-tip-parity meaning and reads false through the whole future-stamp wait.
        atProcessableTip: atProcessableTip(indexer.isSynced(), indexer.stallReason,
                                           indexer.stallClearsAt, now),
        // Epoch-ms at which the current time-keyed barrier can first be satisfied,
        // or null. Non-null means the indexer is waiting on WALL CLOCK (a future-stamped
        // block), which is expected and self-clearing rather than a wedge, and it tells an
        // operator exactly when to expect the chain to move again instead of leaving a
        // multi-hour, entirely valid stall looking like a dead service.
        stallClearsAt:    indexer.stallClearsAt || null
    };
}

module.exports = { advanceFields };
