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
 * XChain Indexer - Database mixin part: votes (poll tally)
 *
 * The weighted tally of a poll's current ballots at its measure block.
 * A part of the votes mixin: src/db/votes.js merges it into the one method set that
 * db/index.js installs onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

// The voter's CURRENT ballot rows, text unchanged from the read getPollTally ran inline.
const CURRENT_BALLOTS_SQL = `SELECT a.address AS address, v.choice AS choice, v.share AS share
               FROM votes v INNER JOIN index_addresses a ON (a.id=v.voter_address_id)
              WHERE v.poll_index=?
                AND v.action_index = (SELECT MAX(v2.action_index) FROM votes v2
                                       WHERE v2.poll_index=v.poll_index
                                         AND v2.voter_address_id=v.voter_address_id)`;

// The passes of getPollTally below are module functions over the same Database instance,
// kept off the exported object so Database.prototype gains no method.

// Current ballots for the poll, grouped by voter. votes is append-only
// (every re-vote is a new action_index set), so the voter's CURRENT ballot
// is their rows at MAX(action_index); earlier sets stay in the table purely
// for reorg safety (rolling back the latest set re-exposes the prior one).
async function readCurrentBallots(db, pollIndex){
    let rows = await db.doQuery(CURRENT_BALLOTS_SQL, [pollIndex]);
    let byVoter = {};
    for(let r of rows){
        if(db.util.isNull(byVoter[r.address])) byVoter[r.address] = [];
        byVoter[r.address].push({ choice: Number(r.choice), share: db.util.isNull(r.share) ? '1' : String(r.share) });
    }
    return byVoter;
}

// Map a close-eligible voter's close balance to a weight number under the
// active mode. balance = close holdings; flat = one-address-one-vote;
// quadratic = sqrt(close) to flatten whales; time_weighted = average
// holdings over the window. Weight eligibility is hold-to-count only (a
// positive close balance); MIN_VOTE_BALANCE is NOT a floor on weight - it
// gates only the qualifyingVoters headcount below. So quadratic weight has
// no dust floor: splitting stake across many sub-floor addresses still
// yields sqrt-amplified weight (Sybil-resistant, not Sybil-proof), bounded
// only by per-address transaction fees.
function weightFunction(db, weight_mode, twBalances){
    return (addr, closeBal) => {
        if(weight_mode === 'flat')          return '1';
        if(weight_mode === 'quadratic')     return db.util.bcsqrt(closeBal, 18);
        if(weight_mode === 'time_weighted') return (twBalances && !db.util.isNull(twBalances[addr])) ? twBalances[addr] : '0';
        return closeBal;
    };
}

// One-hop delegation (Section 13): a holder who did NOT vote directly and
// still holds at close lends their weight to their delegate's ballot, if
// the delegate cast one. Standing per-token delegation resolved at the
// close block. inbound[delegate] = summed delegated weight; folded into the
// delegate's own weight in the loop below.
async function delegatedInbound(db, poll, measureBlock, byVoter, holders, weightFor){
    let inbound = {};
    if(!db.util.isNull(poll.tick_id)){
        let delegations = await db.getActiveDelegations(poll.tick_id, measureBlock);
        for(let delegator in delegations){
            let delegate = delegations[delegator];
            if(db.util.isNull(delegate)) continue;                  // cleared delegation
            if(!db.util.isNull(byVoter[delegator])) continue;       // voted directly -> overrides
            if(db.util.isNull(byVoter[delegate])) continue;         // idle delegate -> weight unused
            let dBal = holders[delegator];
            if(db.util.isNull(dBal) || !db.util.bcgt(dBal, 0)) continue; // hold-to-count on delegator
            let dWeight = weightFor(delegator, dBal);
            inbound[delegate] = db.util.bcadd(db.util.isNull(inbound[delegate]) ? '0' : inbound[delegate], dWeight, 18);
        }
    }
    return inbound;
}

// Per-option weight and voter counts over every current ballot, plus the counted weight
// and the qualifying headcount the validity gates read. `t` carries byVoter, holders,
// weightFor, inbound, minVoteBal, tally_mode and optionCount from getPollTally.
function countBallots(db, t){
    let totals = [];
    let optionVoters = [];
    for(let i=0;i<t.optionCount;i++){ totals.push('0'); optionVoters.push(0); }
    let totalCountedWeight = '0';
    let qualifyingVoters   = 0;
    for(let addr in t.byVoter){
        let closeBal = t.holders[addr];
        // Hold-to-count: the ballot counts only if the voter still holds the token
        // at close (applies to every weight mode; the dust floor below also reads
        // closeBal, so eligibility is always the close snapshot, never the transform).
        if(db.util.isNull(closeBal) || !db.util.bcgt(closeBal, 0)) continue;
        // The voter's own weight plus any weight delegated to them (one-hop).
        let weight = db.util.bcadd(t.weightFor(addr, closeBal), db.util.isNull(t.inbound[addr]) ? '0' : t.inbound[addr], 18);
        // Participation gate counts a direct voter only above the dust floor
        // (delegators add weight but not headcount; see spec).
        if(db.util.bcgte(closeBal, t.minVoteBal)) qualifyingVoters++;
        let picks = t.byVoter[addr];
        if(t.tally_mode==='split'){
            let sumShares = '0';
            for(let p of picks) sumShares = db.util.bcadd(sumShares, p.share, 18);
            if(!db.util.bcgt(sumShares, 0)) continue;
            for(let p of picks){
                if(p.choice < 0 || p.choice >= t.optionCount) continue;
                let portion = db.util.bcmul(weight, db.util.bcdiv(p.share, sumShares, 18), 18);
                totals[p.choice] = db.util.bcadd(totals[p.choice], portion, 18);
                optionVoters[p.choice]++;
            }
        } else {
            for(let p of picks){
                if(p.choice < 0 || p.choice >= t.optionCount) continue;
                totals[p.choice] = db.util.bcadd(totals[p.choice], weight, 18);
                optionVoters[p.choice]++;
            }
        }
        // Counted once per voter for the weight-quorum turnout fraction
        totalCountedWeight = db.util.bcadd(totalCountedWeight, weight, 18);
    }
    return { totals, optionVoters, totalCountedWeight, qualifyingVoters };
}

// The winning option and the two validity gates over the counted ballots.
function decideOutcome(db, poll, counted, optionCount, supply){
    // Winner: highest weight, lowest option index on a tie
    let winning_option = null, best = '0';
    for(let i=0;i<optionCount;i++)
        if(db.util.bcgt(counted.totals[i], best)){ best = counted.totals[i]; winning_option = i; }
    // Validity gates (both fractions of supply / counts; either may be unset)
    let quorum_met = true, min_voters_met = true;
    if(!db.util.isNull(poll.quorum) && db.util.bcgt(poll.quorum, 0)){
        let turnout = db.util.bcgt(supply, 0) ? db.util.bcdiv(counted.totalCountedWeight, supply, 18) : '0';
        quorum_met  = db.util.bcgte(turnout, poll.quorum);
    }
    if(!db.util.isNull(poll.min_voters) && Number(poll.min_voters) > 0)
        min_voters_met = (counted.qualifyingVoters >= Number(poll.min_voters));
    return { winning_option, quorum_met, min_voters_met };
}

module.exports = {

    // Tally a poll at measureBlock (clamped to its end_block): per-option weight and
    // voters, the winner, both validity gates and the resulting status.
    async getPollTally(pollIndex, measureBlock=null){
        let poll = await this.getPoll(pollIndex);
        if(this.util.isNull(poll)) return null;
        let end_block   = Number(poll.end_block);
        if(this.util.isNull(measureBlock)) measureBlock = end_block;
        measureBlock    = Math.min(Number(measureBlock), end_block);
        let tick        = await this.getTicker(poll.tick_id);
        let options     = JSON.parse(poll.options || '[]');
        let optionCount = options.length;
        let tally_mode  = poll.tally_mode  || 'approval';
        let weight_mode = poll.weight_mode || 'balance';
        let minVoteBal  = this.util.isNull(poll.min_vote_balance) ? '0' : String(poll.min_vote_balance);
        // Close-block holders (deterministic, address-tiebroken); supply = sum
        let holders = await this.getHolders(tick, measureBlock, null);
        // time_weighted maps each voter's close eligibility to their average
        // balance over [creation_block, close]; preloaded once (windowed ledger
        // aggregation, Section 12.2). Other modes derive weight from closeBal.
        let twBalances = (weight_mode === 'time_weighted')
            ? await this.getTimeWeightedBalances(tick, Number(poll.block_index), measureBlock)
            : null;
        let supply  = '0';
        for(let addr in holders) supply = this.util.bcadd(supply, holders[addr], 18);
        let byVoter   = await readCurrentBallots(this, pollIndex);
        let weightFor = weightFunction(this, weight_mode, twBalances);
        let inbound   = await delegatedInbound(this, poll, measureBlock, byVoter, holders, weightFor);
        let counted   = countBallots(this, { byVoter, holders, weightFor, inbound, minVoteBal, tally_mode, optionCount });
        let outcome   = decideOutcome(this, poll, counted, optionCount, supply);
        let { totals, optionVoters, totalCountedWeight, qualifyingVoters } = counted;
        let { winning_option, quorum_met, min_voters_met } = outcome;
        let passed = quorum_met && min_voters_met;
        let latest = await this.getLatestBlockIndex();
        let closed = (latest >= end_block);
        let status = !passed ? 'failed_quorum' : (closed ? 'finalized' : 'open');
        let optionResults = [];
        // bcstr, not String(): a dust weight below 1e-7 (18-decimal governance
        // token) would render exponentially and persist that way in poll_results.
        for(let i=0;i<optionCount;i++)
            optionResults.push({ index: i, label: options[i], weight: this.util.bcstr(totals[i]), voters: optionVoters[i] });
        return {
            poll_index: Number(pollIndex), tick, measure_block: measureBlock, end_block,
            tally_mode, weight_mode, options: optionResults,
            supply: this.util.bcstr(supply), total_counted_weight: this.util.bcstr(totalCountedWeight),
            total_voters: qualifyingVoters, quorum_met, min_voters_met, winning_option, status
        };
    },

};
