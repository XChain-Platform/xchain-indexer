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
 * XChain Indexer - Database mixin part: stakes / active_stake
 *
 * The active-stake reads: one source's or one pubkey's active stake, and the validator
 * sets and PBFT quorum count resolved over the effective signer set.
 * Merged into the stakes mixin by db/stakes.js, which db/index.js installs
 * onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

// Module-level state and pure helpers that the split keeps in one place, so the class
// and every mixin read the same instance of each.
const { usesCapabilitySnapshot } = require('../shared.js');

const { getLogger } = require('../../observability/index.js');

// The row filter one getActiveStakeByPubkey mode adds, as the SQL suffix and the binds it
// appends in order. No blockIndex means no filter: every valid row of the pubkey counts.
function stakeModeFilter(config, blockIndex, opts){
    if(blockIndex === undefined || blockIndex === null) return { clause: '', args: [] };
    if(opts && opts.reuseBlockingOnly){
        // STAKE v1 KEY-REUSE path (stake_key_reuse_activation.js), and the ONLY mode
        // here that applies no activation filter at all. It answers "is this key
        // FREE", not "is this key active", so it must count EVERY valid stakes row
        // the pubkey has ever held and exclude only the rows that have genuinely
        // released it: deactivated (deactivation_block IS NOT NULL) AND past
        // cooldown. A row that is active, pending activation, or deactivated but
        // still inside cooldown survives the filter and so blocks the reuse.
        //
        // Neither existing mode can answer it. The default mode and
        // undeactivatedOnly both carry `activation_block <= blockIndex`, which HIDES
        // a row staked moments ago inside its ACTIVATION_DELAY_BLOCKS window, so two
        // STAKE v1 actions on one key inside the delay would both be admitted and the
        // key would carry two independent bonds.
        //
        // Cooldown is anchored on the stakes row (deactivation_block +
        // COOLDOWN_BLOCKS) rather than joined to unstakes.cooldown_end_block: one row
        // set, no join, no dependence on an unstakes row existing, and the resulting
        // ACTIVATION_DELAY_BLOCKS of slack falls on the REFUSING side, which is the
        // legacy behaviour. The rationale lives in stake_key_reuse_activation.js.
        //
        // EXISTENCE ONLY. The GROUP BY aggregate is meaningless in this mode: the SUM
        // spans pending and cooled-down rows alike, so callers must read the return
        // as a boolean and never as an amount or an owner.
        let staking = config['STAKING'];
        let cooldownBlocks = (staking && staking['COOLDOWN_BLOCKS']) ? staking['COOLDOWN_BLOCKS'] : 1000;
        return { clause: ' AND (s.deactivation_block IS NULL OR s.deactivation_block + ? > ?)',
                 args: [cooldownBlocks, blockIndex] };
    }
    if(opts && opts.undeactivatedOnly){
        // UNSTAKE path: only stakes not already being unstaked (deactivation_block
        // IS NULL). A stake already deactivating from a prior UNSTAKE in the same
        // activation-delay window stays "active" (deactivation_block is a future
        // block) and would otherwise be re-unstaked here, double-crediting the
        // staker at cooldown end (item 4617).
        return { clause: ' AND s.activation_block <= ? AND s.deactivation_block IS NULL', args: [blockIndex] };
    }
    return { clause: ' AND s.activation_block <= ? AND (s.deactivation_block IS NULL OR s.deactivation_block > ?)',
             args: [blockIndex, blockIndex] };
}

module.exports = {

    /*
     * Staking query methods
     */

    // Get active stake for a source address (existence/source check; returns any one of the source's active stake rows).
    // blockIndex enforces the 6-block activation/deactivation delay for BTC reorg safety.
    async getActiveStakeBySource(source, blockIndex){
        let source_id = await this.getAddressId(source);
        if(source_id === null)
            return null;
        let valid_id = await this.getStatusId('valid');
        let query = `SELECT
                        s.*, ip.pubkey as signing_pubkey
                    FROM stakes s
                        LEFT JOIN index_pubkeys ip ON (ip.id=s.signing_pubkey_id)
                    WHERE s.source_id=? AND s.status_id=?`;
        let args = [source_id, valid_id];
        if(blockIndex !== undefined && blockIndex !== null){
            query += ' AND s.activation_block <= ? AND (s.deactivation_block IS NULL OR s.deactivation_block > ?)';
            args.push(blockIndex);
            args.push(blockIndex);
        }
        query += ' ORDER BY s.action_index DESC LIMIT 1';
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            return results[0];
        return null;
    },

    // Count distinct active validators (by pubkey) qualified for the given capability.
    // Used for PBFT quorum calculation: quorum = max(2 * floor((N - 1) / 3) + 1, ceil((N + 1) / 2)).
    async getActiveCapabilityCount(capability, blockIndex, minStakeOverride){
        // Same redirect, same predicate, as the set and weight resolvers: this count is the
        // quorum DENOMINATOR, so if it came from the local (empty off BTC) path while the
        // capable set came from the mirror, the two would disagree about who is capable and
        // this node would reach a quorum verdict no other node reaches.
        if(usesCapabilitySnapshot(this.config, capability))
            return await this.getCapabilitySnapshotCount(capability, blockIndex);
        let caps = (this.config['STAKING'] && this.config['STAKING']['CAPABILITIES']) ? this.config['STAKING']['CAPABILITIES'] : {};
        let capConfig = caps[capability];
        if(!capConfig) return 0;
        // A caller-supplied threshold (the hub's authoritative MIN_STAKE) is
        // honoured VERBATIM (see getValidatorsByCapability). The local floor is
        // only the default when NO override is supplied; it never clamps
        // an explicit caller value, so the quorum N counted here matches the
        // qualifying set membership of every other hub/indexer for the same block.
        let localFloor = capConfig['MIN_STAKE'] || '0';
        let minStake = (minStakeOverride !== undefined && minStakeOverride !== null)
            ? String(minStakeOverride)
            : localFloor;
        let valid_id = await this.getStatusId('valid');
        if(valid_id === null) return 0;
        // Count over the SAME effective signer set as getValidatorsByCapability
        // (stake keys minus revocations, plus delegated keys) - quorum thresholds
        // computed from this count must agree with set membership exactly.
        // All callers pass blockIndex; a missing one means "current tip".
        if(blockIndex === undefined || blockIndex === null)
            blockIndex = await this.getLatestBlockIndex();
        let eff = this._effectiveCapabilitySetSql(valid_id, blockIndex, minStake);
        let query = `SELECT COUNT(DISTINCT pubkey) AS cnt FROM (${eff.sql}) eff`;
        let results = await this.doQuery(query, eff.args);
        return results.length > 0 ? Number(results[0].cnt) : 0;
    },

    // Get aggregate DIRECT active stake for a pubkey (SUM of amount across the pubkey's own
    // active stake rows). Returns { source_id, signing_pubkey_id, signing_pubkey, amount,
    // activation_block, ... } or null. blockIndex enforces the 6-block activation/deactivation
    // delay for BTC reorg safety.
    //
    // CONSENSUS-PATH, stake-ownership view. This is the load-bearing primitive for STAKE/UNSTAKE/
    // DELEGATE block processing (unstake.js, stake.js, delegate.js): it answers "does THIS pubkey
    // own a direct stake, and how much" for collision, ownership and unstake-AMOUNT decisions. It
    // deliberately does NOT apply the DELEGATE v2 revocation exclusion or resolve delegated keys to
    // their backing source. Those are capability-membership semantics that belong to the federation
    // effective-set view (getEffectiveStakeByPubkey / _effectiveCapabilitySetSql), not to stake
    // ownership: an UNSTAKE on a delegated-only key has no stake rows to deactivate, so crediting
    // the source's aggregate here would inflate balances (the cooldown sweep credits unstakes.AMOUNT
    // regardless of what was deactivated). Keep this query direct-stake-only.
    //
    // THREE MODES, selected by `opts` and differing only in which rows they count:
    //   default            - active at blockIndex (activation reached, not yet deactivated)
    //   undeactivatedOnly  - active AND not already being unstaked (UNSTAKE)
    //   reuseBlockingOnly  - EVERY row regardless of activation state, minus the rows that
    //                        are deactivated and past cooldown (STAKE v1 key reuse). Read as
    //                        a boolean only; see the branch comment for why the aggregate is
    //                        meaningless there.
    async getActiveStakeByPubkey(pubkey, blockIndex, opts){
        let pubkey_id = await this.getPubkeyId(String(pubkey).toLowerCase());
        if(pubkey_id === null)
            return null;
        let valid_id = await this.getStatusId('valid');
        let query = `SELECT
                        MIN(s.source_id)                       AS source_id,
                        s.signing_pubkey_id                    AS signing_pubkey_id,
                        SUM(CAST(s.amount AS DECIMAL(30,8)))   AS amount,
                        MIN(s.activation_block)                AS activation_block,
                        MIN(s.block_index)                     AS block_index,
                        MIN(s.status_id)                       AS status_id,
                        ip.pubkey                              AS signing_pubkey
                     FROM stakes s
                         LEFT JOIN index_pubkeys ip ON (ip.id = s.signing_pubkey_id)
                     WHERE s.signing_pubkey_id=? AND s.status_id=?`;
        let args = [pubkey_id, valid_id];
        let mode = stakeModeFilter(this.config, blockIndex, opts);
        query += mode.clause;
        args.push(...mode.args);
        query += ' GROUP BY s.signing_pubkey_id, ip.pubkey LIMIT 1';
        let results = await this.doQuery(query, args);
        if(results.length === 0) return null;
        let row = results[0];
        return {
            source_id:         row.source_id,
            signing_pubkey_id: row.signing_pubkey_id,
            signing_pubkey:    row.signing_pubkey,
            amount:            (row.amount === null || row.amount === undefined) ? '0' : String(row.amount),
            activation_block:  row.activation_block,
            block_index:       row.block_index,
            status_id:         row.status_id
        };
    },

    // Return all pubkeys with ANY active stake at `blockIndex`, regardless
    // of capability. Used by xchain-hub's Consensus (config-change PBFT) to
    // snapshot the whole-federation validator set at a block boundary -
    // governance/config quorum is over every staker, not just a capability
    // subset (OracleConsensus uses getValidatorsByCapability('price', ...)
    // when the quorum is capability-scoped).
    async getActiveValidators(blockIndex){
        let valid_id = await this.getStatusId('valid');
        if(valid_id === null) return [];
        // Safety cap on the result set. This query runs on every cache miss
        // (and in-process, uncached, inside block processing), so an unbounded
        // result on an unexpectedly large validator set is a latency/liveness
        // risk. The cap is generous relative to any realistic federation size;
        // hitting it is logged so operators get early warning that the set is
        // outgrowing the assumption. VALIDATOR_QUERY_LIMIT is a frozen consensus
        // constant; raising it requires a coordinated fleet upgrade, not a per-node override.
        let limit = this.config['VALIDATOR_QUERY_LIMIT'];
        // Same effective-signer resolution as the capability set (DELEGATE
        // additive-until-revoked semantics) with no MIN_STAKE floor: the
        // governance quorum is over every staker's effective keys.
        let eff = this._effectiveCapabilitySetSql(valid_id, blockIndex, '0');
        let query = `SELECT pubkey, MAX(total) AS total FROM (${eff.sql}) eff
                     GROUP BY pubkey
                     ORDER BY pubkey
                     LIMIT ?`;
        let rows = await this.doQuery(query, [...eff.args, limit]);
        let truncated = rows.length >= limit;
        if(truncated)
            getLogger().warn('getActiveValidators hit the result cap of ' + limit + ' rows at block ' + blockIndex + ' - validator set may be truncated. Raise the frozen VALIDATOR_QUERY_LIMIT consensus constant (coordinated fleet upgrade) if the federation has grown.');
        let result = rows.map(r => ({
            pubkey: String(r.pubkey),
            amount: (r.total === null || r.total === undefined) ? '0' : String(r.total)
        }));
        // Surface truncation to callers (the RPC layer alarms on it) the same way
        // the capability variants do - the console.warn alone is invisible to a hub.
        result.truncated = truncated;
        return result;
    },

    // Whether `capability` resolves from the hub-mirrored capability_snapshots on this
    // chain instead of the local `stakes` rows.
    //
    // Capability staking is BTC-only at the protocol level (coins/DOGE.js and coins/LTC.js
    // both declare CAPABILITIES: {}), so off BTC the local path returns an empty set for
    // every capability and the mirror is the only way a non-BTC indexer reaches the
    // BTC-anchored validator set at all.
    //
    // ONE predicate for ALL FOUR capability reads: getValidatorsByCapability (who is
    // capable), getStakeWeightsByCapability (how much stake each capable signer carries),
    // getActiveCapabilityCount (the PBFT denominator) and hasCapability (the per-signer
    // truncation fallback). If any one of them consulted a different source, a node would
    // tally signatures against one validator set and divide by a quorum denominator computed
    // from another, reaching a verdict no other node reaches.
    //
    // `snapshot_block` in capability_snapshots is a BTC HEIGHT, so every caller on this path
    // must key the read on the action's BTC anchor, never the landing chain's own height:
    // off BTC a landing-chain height matches nothing, and on regtest, where the chains'
    // heights overlap, it can match the wrong snapshot.

    // Return all pubkeys whose SUM(active stake) at `blockIndex` meets the
    // capability's MIN_STAKE. Used by xchain-hub's CapabilitySnapshot to lock
    // the validator set at a block boundary for PBFT quorum calculations -
    // every hub independently calling this against the same blockIndex must
    // arrive at the same set, so consensus on quorum N is deterministic.
    // Spec: capability-staking model §6 (deterministic quorum selection).
    async getValidatorsByCapability(capability, blockIndex, minStakeOverride){
        // Off-BTC chains have no local capability stakes, so the qualifying set comes from
        // the hub-mirrored capability_snapshots. `blockIndex` MUST be a BTC height on this
        // path (snapshot_block is BTC-anchored); see usesCapabilitySnapshot.
        if(usesCapabilitySnapshot(this.config, capability))
            return await this.getCapabilitySnapshotValidators(capability, blockIndex);
        let caps = (this.config['STAKING'] && this.config['STAKING']['CAPABILITIES']) ? this.config['STAKING']['CAPABILITIES'] : {};
        let capConfig = caps[capability];
        if(!capConfig) return [];
        // A caller-supplied threshold (the hub passes its own authoritative,
        // signed/governance-anchored MIN_STAKE) is honoured VERBATIM on both the
        // count path and the weight path. The local config can drift between
        // independently-operated indexers, so honouring the caller's value (never
        // clamping it to this indexer's own floor) keeps every hub/indexer
        // computing the SAME qualifying set for the same block - that cross-hub /
        // cross-indexer determinism is the consensus invariant. The local floor is
        // ONLY the default when NO override is supplied (non-hub callers); it is
        // never a clamp on an explicit caller value. Anti-inflation is enforced at
        // the hub layer (signed/governance-anchored MIN_STAKE) and by on-chain
        // validation (which uses the local floor), NOT by this read-path clamp.
        // getStakeWeightsByCapability resolves minStake identically, so the
        // count/set-membership path and the weight path stay symmetric.
        let localFloor = capConfig['MIN_STAKE'] || '0';
        let minStake = (minStakeOverride !== undefined && minStakeOverride !== null)
            ? String(minStakeOverride)
            : localFloor;
        let valid_id = await this.getStatusId('valid');
        if(valid_id === null) return [];
        // Safety cap - see getActiveValidators. Bounds the result set so a
        // cache miss (or the uncached in-process call during block processing)
        // can't return an unbounded set on a large federation. VALIDATOR_QUERY_LIMIT
        // is a frozen consensus constant; raising it requires a coordinated fleet
        // upgrade, not a per-node override.
        let limit = this.config['VALIDATOR_QUERY_LIMIT'];
        let eff = this._effectiveCapabilitySetSql(valid_id, blockIndex, minStake);
        let query = `SELECT pubkey, MAX(total) AS total FROM (${eff.sql}) eff
                     GROUP BY pubkey
                     ORDER BY pubkey
                     LIMIT ?`;
        let rows = await this.doQuery(query, [...eff.args, limit]);
        let truncated = rows.length >= limit;
        if(truncated)
            getLogger().warn('getValidatorsByCapability(' + capability + ') hit the result cap of ' + limit + ' rows at block ' + blockIndex + ' - validator set may be truncated. Raise the frozen VALIDATOR_QUERY_LIMIT consensus constant (coordinated fleet upgrade) if the federation has grown.');
        let result = rows.map(r => ({
            pubkey: String(r.pubkey),
            amount: (r.total === null || r.total === undefined) ? '0' : String(r.total)
        }));
        result.truncated = truncated;
        return result;
    },

};
