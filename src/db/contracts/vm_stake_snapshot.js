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
 * XChain Indexer - Database mixin part: contracts / vm_stake_snapshot
 *
 * The serializable per-contract stake snapshot the VM reads through getStake,
 * getTotalStaked and getStakers.
 * Merged into the contracts mixin by db/contracts.js, which db/index.js installs
 * onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // Snapshot the contract's stake state at blockIndex into an in-memory accessor
    // returned to the VM execution context. Methods on the returned object are
    // synchronous since they query the pre-loaded snapshot only.
    //
    // The snapshot is scoped to THIS contract (targetContractIndex) - a contract
    // calling xchain.contract.* cannot see other contracts' stakes through this
    // accessor (implicit slash authorization). The 1000-staker cap on getStakers
    // is applied here at query time (LIMIT clause).
    //
    // SIGNING-KEY ROTATIONS (#4366). This reads contract_stakes.signing_pubkey_id and nothing
    // else - deliberately, and it must stay that way. A DELEGATE v1 rotation reaches the
    // snapshot because materializeContractDelegations rewrites the stake row itself at the
    // delegation's activation block (CONTRACT_DELEGATION_MATERIALIZE), so the pubkey a contract
    // sees in getStakers is by construction the same one slashContractStake can debit. Joining
    // contract_delegations in HERE instead would hand the contract a key the SLASH path cannot
    // find, and the emitted punishment would silently no-op at execute.js's zero-slashed guard.
    async getContractStakeDataForVM(targetContractIndex, blockIndex){
        let valid_id = await this.getStatusId('valid');
        let stakes = [];
        if(valid_id !== null){
            let query = `SELECT cs.signing_pubkey_id, ip.pubkey AS pubkey, cs.tick_id, t.tick AS tick, cs.amount,
                                cs.activation_block, cs.deactivation_block
                         FROM contract_stakes cs
                             LEFT JOIN index_pubkeys ip ON (ip.id = cs.signing_pubkey_id)
                             LEFT JOIN index_tickers t  ON (t.id  = cs.tick_id)
                         WHERE cs.target_contract_index=? AND cs.status_id=?
                           AND cs.activation_block <= ?
                           AND (cs.deactivation_block IS NULL OR cs.deactivation_block > ?)`;
            stakes = await this.doQuery(query, [Number(targetContractIndex), valid_id, blockIndex, blockIndex]);
        }
        // Aggregate (pubkey, tick) → amount; also build per-tick stakers map for getStakers/getTotalStaked.
        let perPubkeyTick = new Map();      // key: pubkey + '|' + tick → string amount
        let perTickStakers = new Map();     // key: tick → Map(pubkey → string amount)
        let util = this.util;
        // Contract stakes accept any tick up to MAX_TOKEN_DECIMALS (18), so aggregate each at its
        // own token precision. A flat 8-dp bcadd truncates the amounts the VM observes through
        // getStake/getTotalStaked/getStakers for >8-dp tokens (and would then drive a wrong slash);
        // XCHAIN(8) is unaffected. Per-tick decimals are precomputed here because the aggregation
        // below is synchronous (item 5303).
        let tickDecimals = new Map();       // tick string → decimals
        for(let row of stakes){
            let tk = String(row.tick || '');
            if(tk && !tickDecimals.has(tk))
                tickDecimals.set(tk, await this.getTokenDecimalPrecision(row.tick_id));
        }
        for(let row of stakes){
            let pubkey = String(row.pubkey || '').toLowerCase();
            let tick   = String(row.tick || '');
            if(!pubkey || !tick) continue;
            let dec = tickDecimals.has(tick) ? tickDecimals.get(tick) : 8;
            let key = pubkey + '|' + tick;
            perPubkeyTick.set(key, util.bcadd((perPubkeyTick.get(key) || '0'), row.amount, dec));
            if(!perTickStakers.has(tick)) perTickStakers.set(tick, new Map());
            let m = perTickStakers.get(tick);
            m.set(pubkey, util.bcadd((m.get(pubkey) || '0'), row.amount, dec));
        }
        // Return a SERIALIZABLE snapshot (plain data), not closures: the VM runs
        // in a forked worker and the read-only data must cross the IPC boundary.
        // xchain-vm/src/readonly_accessors.js rebuilds the sync getStake/
        // getTotalStaked/getStakers accessors from this shape inside the worker.
        return snapshotShape.serialize(util, perPubkeyTick, perTickStakers, tickDecimals);
    },

};

// The serialization step of getContractStakeDataForVM, kept off the exported object so
// Database.prototype gains no method. Turns the aggregated maps into plain objects, each
// tick's stakers sorted and capped at 1000.
const snapshotShape = {

    serialize(util, perPubkeyTick, perTickStakers, tickDecimals){
        let stakeByPubkeyTick = {};
        for(let [key, amt] of perPubkeyTick.entries()) stakeByPubkeyTick[key] = amt;

        let totalByTick   = {};
        let stakersByTick = {};
        for(let [tick, stakers] of perTickStakers.entries()){
            let dec = tickDecimals.has(tick) ? tickDecimals.get(tick) : 8;
            let total = '0';
            let arr = [];
            for(let [pk, amt] of stakers.entries()){
                total = util.bcadd(total, amt, dec);
                arr.push({ pubkey: pk, amount: amt });
            }
            // Sort stakers biggest to smallest. Equal amounts fall back to a lexicographic
            // pubkey tiebreak so the order is deterministic across nodes - the source query
            // carries no ORDER BY, so without this, equal-amount stakers would order in
            // engine-arbitrary row order. That matters twice: it sets the iteration order a
            // contract's getStakers() observes, AND it decides which stakers survive the
            // 1000-cap slice below when ties straddle the boundary - either of which would
            // fork getStakers() membership (and any contract branching on it) across
            // validators. pubkey is unique per tick here (aggregated), so this is a total order.
            arr.sort((a, b) => {
                if(util.bcgt(b.amount, a.amount)) return  1;
                if(util.bcgt(a.amount, b.amount)) return -1;
                return a.pubkey < b.pubkey ? -1 : a.pubkey > b.pubkey ? 1 : 0;
            });
            totalByTick[tick]   = total;
            stakersByTick[tick] = arr.slice(0, 1000);
        }
        return { stakeByPubkeyTick, totalByTick, stakersByTick };
    },

};
