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
 * XChain Indexer - Utility: VOTE finalization pass
 *
 * The per-block VOTE poll finalization sweep: time-due closes, early decides and the
 * timelocked binding callbacks.
 *
 ********************************************************************/

'use strict';

// Step 2 of processVoteFinalizations for ONE armed poll: skip it when its tally inputs have
// not changed since the last block tallied it, otherwise tally it at this block and, when the
// leader crosses the decide threshold and the gates pass, inject the early-decide VOTE v2.
// Split out of the sweep's loop, so each `return` here is the `continue` it was there.
async function evaluateArmedPoll(util, actions, db, poll, block_index, block_time){
    let pollIndex = poll.action_index;
    // Watermark short-circuit: re-tallying every armed poll from full
    // ledger/vote/delegation history on every block is the dominant per-block cost here.
    // For a NON-time_weighted poll the tally is a pure function of its input rows (the
    // tick's ledger, the poll's votes, the tick's delegations) plus the immutable poll
    // definition, so if none of those tables gained a row since the last block we tallied
    // this poll, the tally is byte-identical now. It did not early-decide then (or the poll
    // would be terminal and absent from getArmedPolls), so it cannot now: skip the tally.
    // time_weighted is EXCLUDED because its average-holding weight shifts as the measure
    // window extends each block even with no new ledger row, so its inputs are not captured
    // by a row-presence watermark; those polls always take the full tally, exactly as before.
    let watermark = null;
    if(poll.weight_mode !== 'time_weighted'){
        watermark = await db.getPollTallyInputWatermark(pollIndex, poll.tick_id);
        if(db.pollTallyWatermarkMatches(pollIndex, watermark))
            return;
    }
    let tally = await db.getPollTally(pollIndex, block_index);
    if(!tally){
        // No tally (e.g. poll vanished mid-block); record the watermark so a stable poll is
        // not re-probed to the same dead end every block. Cleared on any input change.
        if(watermark !== null) db.setPollTallyWatermark(pollIndex, watermark);
        return;
    }
    // Leading option weight as a fraction of total TICK supply at this block.
    let leader = '0';
    for(let opt of tally.options)
        if(util.bcgt(opt.weight, leader)) leader = opt.weight;
    let frac = util.bcgt(tally.supply, 0) ? util.bcdiv(leader, tally.supply, 18) : '0';
    let threshold = poll.decide_threshold;
    // Crosses the supply threshold AND clears participation/quorum now (else
    // a whale could force-close a poll that fails its gates). A poll that
    // crosses weight but not a gate stays open and keeps evaluating.
    if(util.bcgte(frac, threshold) && tally.quorum_met && tally.min_voters_met){
        let data = {};
        data['ACTION']                = 'VOTE';
        data['FORMAT']                = 2;
        data['BLOCK_INDEX']           = block_index;
        data['BLOCK_TIME']            = block_time;
        data['POLL_REF']              = pollIndex;
        data['EFFECTIVE_CLOSE_BLOCK'] = block_index;
        data['DECIDED_EARLY']         = 1;
        data['IS_SYNTHETIC']          = true;
        await actions.processAction('VOTE', [2, pollIndex], data, null);
        // Finalized: the poll is now terminal and drops out of getArmedPolls, so drop its
        // watermark too (defensive: keeps a reused action_index from ever matching a stale
        // fingerprint after a reorg re-opens a poll at the same index).
        db.clearPollTallyWatermarkEntry(pollIndex);
    } else if(watermark !== null){
        // Did NOT early-decide at this fingerprint. Cache it so the next block skips the
        // full re-tally unless an input row lands. time_weighted polls (watermark null) are
        // intentionally never cached, so they keep tallying every block as before.
        db.setPollTallyWatermark(pollIndex, watermark);
    }
}

// Installed onto Utility.prototype by ../utility.js, non-enumerable; each method runs with
// `this` bound to the Utility instance, exactly as the class method it was.
module.exports = {

    // Per-block VOTE poll finalization sweep (mirrors processAttestationExpirations).
    // Injects a synthetic VOTE v2 for each poll that reaches its effective close by
    // either trigger. A poll result is a pure deterministic function of on-chain
    // state (votes ledger + getHolders at the close block), so this is a local
    // computation, never a consensus round.
    async processVoteFinalizations(actions, db, block_index, block_time){
        // 1. Time trigger: polls whose voting window has closed. The effective
        //    close is end_block; balances are measured there even if the v2 lands a
        //    block late, so the close state is exact.
        let due = await db.getDuePolls(block_index);
        for(let poll of due){
            let data = {};
            data['ACTION']                = 'VOTE';
            data['FORMAT']                = 2;
            data['BLOCK_INDEX']           = block_index;
            data['BLOCK_TIME']            = block_time;
            data['POLL_REF']              = poll.action_index;
            data['EFFECTIVE_CLOSE_BLOCK'] = Number(poll.end_block);
            data['DECIDED_EARLY']         = 0;
            data['IS_SYNTHETIC']          = true;
            // Mirror the synthetic-action positional layout: VERSION|POLL_REF
            await actions.processAction('VOTE', [2, poll.action_index], data, null);
        }

        // 2. Early-decide trigger: armed open polls (a decide_threshold is set, not
        //    yet time-due) whose provisional tally at THIS block crosses the
        //    threshold AND passes any validity gates. Early-decide is the close
        //    block arriving early: weights are measured at this block, exactly as a
        //    time-close measures them at end_block. The first canonical block to
        //    cross wins; evaluated after the block is fully processed, so it is
        //    deterministic across nodes.
        let armed = await db.getArmedPolls(block_index);
        for(let poll of armed)
            await evaluateArmedPoll(this, actions, db, poll, block_index, block_time);

        // 3. Timelocked binding callbacks: polls finalized in an earlier
        //    block whose CALLBACK_DELAY_BLOCKS window elapses at THIS block fire
        //    their deferred callback EXECUTE now. Runs after the finalization
        //    triggers so a poll finalizing this block can never fire in the same
        //    pass (a delay >= 1 always defers to a later block anyway).
        await actions.actionVote.processDueCallbacks(block_index, block_time);
    }
};
