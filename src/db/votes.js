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
 * XChain Indexer - Database mixin: votes
 * 
 * The queries over the votes table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // Record a VOTE v3 delegation set/clear as an append-only event row. A null
    // delegate (blank DELEGATE_TO) is a clear; the latest row per (tick, delegator)
    // wins at read time (getActiveDelegations), so there is nothing to mutate and
    // rollback is the generic action_index delete. Named createVoteDelegation to
    // avoid colliding with createDelegation (the validator signing-key DELEGATE).
    async createVoteDelegation(data){
        let action_index = data['ACTION_INDEX'];
        let block_index  = data['BLOCK_INDEX'];
        let tick_id      = await this.createTicker(data['TICK']);
        let delegator_id = await this.createAddress(data['SOURCE']);
        let cleared      = this.util.isNull(data['DELEGATE_TO']) || String(data['DELEGATE_TO']).trim() === '';
        let delegate_id  = cleared ? null : await this.createAddress(String(data['DELEGATE_TO']).trim());
        let status_id    = await this.createStatus(data['STATUS']);
        await this.doQuery(
            `INSERT INTO vote_delegations
                (action_index, block_index, tick_id, delegator_address_id, delegate_address_id, status_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [action_index, block_index, tick_id, delegator_id, delegate_id, status_id]);
    },

    // Active delegations for a token at/before a block: {delegatorAddress:
    // delegateAddress}. Latest row per delegator wins (highest action_index, the
    // monotonic per-block tiebreak); a delegator whose latest row is a CLEAR is
    // omitted. Used by getPollTally to flow weight one hop.
    async getActiveDelegations(tick_id, block_index){
        let rows = await this.doQuery(
            `SELECT da.address AS delegator, dg.address AS delegate
               FROM vote_delegations vd
               INNER JOIN (
                    SELECT delegator_address_id, MAX(action_index) AS max_ai
                      FROM vote_delegations
                     WHERE tick_id = ? AND block_index <= ?
                     GROUP BY delegator_address_id
               ) latest ON latest.delegator_address_id = vd.delegator_address_id
                       AND latest.max_ai = vd.action_index
               INNER JOIN index_addresses da ON da.id = vd.delegator_address_id
               LEFT  JOIN index_addresses dg ON dg.id = vd.delegate_address_id
              WHERE vd.delegate_address_id IS NOT NULL`,
            [tick_id, Number(block_index)]);
        let out = {};
        for(let r of rows) out[r.delegator] = r.delegate;
        return out;
    },

    // Write a voter's ballot (VOTE v1) as an atomic set. Wholesale last-write-wins:
    // delete the voter's prior rows for this poll, then insert one row per selected
    // option. Only called for a VALID ballot (an invalid one is a no-op on the
    // voter's standing ballot). `selections` is [{choice, share}, ...].
    async createBallot(data, selections){
        let action_index     = data['ACTION_INDEX'];
        let block_index      = data['BLOCK_INDEX'];
        let poll_index       = data['POLL_REF'];
        let voter_address_id = await this.createAddress(data['SOURCE']);
        let status_id        = await this.createStatus(data['STATUS']);
        let memo             = data['MEMO'];
        // APPEND-ONLY: never delete the voter's prior ballot rows. A re-vote inserts
        // a new action_index set and the tally reads the voter's MAX(action_index)
        // set (getPollTally). Deleting priors here is unrecoverable on a reorg that
        // orphans the replacement (the prior ballot's block never reprocesses),
        // forking a reorged node's tally from a from-genesis replay.
        for(let sel of selections){
            let query = `INSERT INTO votes
                            (action_index, block_index, poll_index, voter_address_id, choice, share, memo, status_id)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
            let args  = [action_index, block_index, poll_index, voter_address_id, sel.choice, sel.share, memo, status_id];
            await this.doQuery(query, args);
        }
    },

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
        // Current ballots for the poll, grouped by voter. votes is append-only
        // (every re-vote is a new action_index set), so the voter's CURRENT ballot
        // is their rows at MAX(action_index); earlier sets stay in the table purely
        // for reorg safety (rolling back the latest set re-exposes the prior one).
        let rows = await this.doQuery(
            `SELECT a.address AS address, v.choice AS choice, v.share AS share
               FROM votes v INNER JOIN index_addresses a ON (a.id=v.voter_address_id)
              WHERE v.poll_index=?
                AND v.action_index = (SELECT MAX(v2.action_index) FROM votes v2
                                       WHERE v2.poll_index=v.poll_index
                                         AND v2.voter_address_id=v.voter_address_id)`, [pollIndex]);
        let byVoter = {};
        for(let r of rows){
            if(this.util.isNull(byVoter[r.address])) byVoter[r.address] = [];
            byVoter[r.address].push({ choice: Number(r.choice), share: this.util.isNull(r.share) ? '1' : String(r.share) });
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
        const weightFor = (addr, closeBal) => {
            if(weight_mode === 'flat')          return '1';
            if(weight_mode === 'quadratic')     return this.util.bcsqrt(closeBal, 18);
            if(weight_mode === 'time_weighted') return (twBalances && !this.util.isNull(twBalances[addr])) ? twBalances[addr] : '0';
            return closeBal;
        };

        // One-hop delegation (Section 13): a holder who did NOT vote directly and
        // still holds at close lends their weight to their delegate's ballot, if
        // the delegate cast one. Standing per-token delegation resolved at the
        // close block. inbound[delegate] = summed delegated weight; folded into the
        // delegate's own weight in the loop below.
        let inbound = {};
        if(!this.util.isNull(poll.tick_id)){
            let delegations = await this.getActiveDelegations(poll.tick_id, measureBlock);
            for(let delegator in delegations){
                let delegate = delegations[delegator];
                if(this.util.isNull(delegate)) continue;                  // cleared delegation
                if(!this.util.isNull(byVoter[delegator])) continue;       // voted directly -> overrides
                if(this.util.isNull(byVoter[delegate])) continue;         // idle delegate -> weight unused
                let dBal = holders[delegator];
                if(this.util.isNull(dBal) || !this.util.bcgt(dBal, 0)) continue; // hold-to-count on delegator
                let dWeight = weightFor(delegator, dBal);
                inbound[delegate] = this.util.bcadd(this.util.isNull(inbound[delegate]) ? '0' : inbound[delegate], dWeight, 18);
            }
        }

        let totals = [];
        let optionVoters = [];
        for(let i=0;i<optionCount;i++){ totals.push('0'); optionVoters.push(0); }
        let totalCountedWeight = '0';
        let qualifyingVoters   = 0;
        for(let addr in byVoter){
            let closeBal = holders[addr];
            // Hold-to-count: the ballot counts only if the voter still holds the token
            // at close (applies to every weight mode; the dust floor below also reads
            // closeBal, so eligibility is always the close snapshot, never the transform).
            if(this.util.isNull(closeBal) || !this.util.bcgt(closeBal, 0)) continue;
            // The voter's own weight plus any weight delegated to them (one-hop).
            let weight = this.util.bcadd(weightFor(addr, closeBal), this.util.isNull(inbound[addr]) ? '0' : inbound[addr], 18);
            // Participation gate counts a direct voter only above the dust floor
            // (delegators add weight but not headcount; see spec).
            if(this.util.bcgte(closeBal, minVoteBal)) qualifyingVoters++;
            let picks = byVoter[addr];
            if(tally_mode==='split'){
                let sumShares = '0';
                for(let p of picks) sumShares = this.util.bcadd(sumShares, p.share, 18);
                if(!this.util.bcgt(sumShares, 0)) continue;
                for(let p of picks){
                    if(p.choice < 0 || p.choice >= optionCount) continue;
                    let portion = this.util.bcmul(weight, this.util.bcdiv(p.share, sumShares, 18), 18);
                    totals[p.choice] = this.util.bcadd(totals[p.choice], portion, 18);
                    optionVoters[p.choice]++;
                }
            } else {
                for(let p of picks){
                    if(p.choice < 0 || p.choice >= optionCount) continue;
                    totals[p.choice] = this.util.bcadd(totals[p.choice], weight, 18);
                    optionVoters[p.choice]++;
                }
            }
            // Counted once per voter for the weight-quorum turnout fraction
            totalCountedWeight = this.util.bcadd(totalCountedWeight, weight, 18);
        }
        // Winner: highest weight, lowest option index on a tie
        let winning_option = null, best = '0';
        for(let i=0;i<optionCount;i++)
            if(this.util.bcgt(totals[i], best)){ best = totals[i]; winning_option = i; }
        // Validity gates (both fractions of supply / counts; either may be unset)
        let quorum_met = true, min_voters_met = true;
        if(!this.util.isNull(poll.quorum) && this.util.bcgt(poll.quorum, 0)){
            let turnout = this.util.bcgt(supply, 0) ? this.util.bcdiv(totalCountedWeight, supply, 18) : '0';
            quorum_met  = this.util.bcgte(turnout, poll.quorum);
        }
        if(!this.util.isNull(poll.min_voters) && Number(poll.min_voters) > 0)
            min_voters_met = (qualifyingVoters >= Number(poll.min_voters));
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
