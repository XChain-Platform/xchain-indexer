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
 * db/index.js, so call sites stay this.db.<method>(). The poll tally lives in a part under
 * votes/, and this file is the entry that merges it into the one method set it exports.
 *
 ********************************************************************/

const pollTally = require('./votes/poll_tally.js');

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

    ...pollTally,

};
