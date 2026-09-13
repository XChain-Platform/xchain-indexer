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
 * XChain Indexer - Database mixin: stakes
 * 
 * The queries over the stakes table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

const path    = require('path');
const stakeWeightCollation = require('../stake_weight_collation_activation');
// Module-level state and pure helpers that the split keeps in one place, so the class
// and every mixin read the same instance of each.
const { usesCapabilitySnapshot } = require('./shared.js');

module.exports = {

    /*
     * Staking action methods
     */

    // Create/Update record in `stakes` table.
    // Capability model: each STAKE action (v1 create or v2 top-up) gets its own row.
    // Active stake amount for a pubkey is SUM(amount) across all valid rows.
    async createStake(data){
        data                  = this.normalizeDataValues(data);
        let status_id         = await this.createStatus(data['STATUS']);
        let source_id         = await this.getAddressId(data['SOURCE']);
        let signing_pubkey_id = await this.getOrCreatePubkeyId(data['SIGNING_PUBKEY']);
        let action_index      = data['ACTION_INDEX'];
        let version           = data['VERSION'] || 1;
        let amount            = data['AMOUNT'] || '0';
        let block_index       = data['BLOCK_INDEX'];
        let activation_block  = data['ACTIVATION_BLOCK'] || 0;
        // Check if record already exists
        let query  = "SELECT action_index FROM stakes WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE stakes SET
                        source_id=?, version=?, signing_pubkey_id=?,
                        amount=?, status_id=?, block_index=?, activation_block=?
                    WHERE action_index=?`;
            args = [source_id, version, signing_pubkey_id, amount, status_id, block_index, activation_block, action_index];
        } else {
            query = `INSERT INTO stakes
                        (source_id, version, signing_pubkey_id, amount, status_id, block_index, activation_block, action_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
            args = [source_id, version, signing_pubkey_id, amount, status_id, block_index, activation_block, action_index];
        }
        await this.doQuery(query, args);
    },

    // Set deactivation_block for the ALREADY-ACTIVE stake rows owned by the given pubkey.
    // Used by createUnstake to mark when a pubkey's stake (original + activated top-ups) should be
    // removed from the active set. The `currentBlock` filter (activation_block <= currentBlock) is
    // load-bearing: the unstake AMOUNT is summed from active rows only (getActiveStakeByPubkey), so a
    // pending-activation top-up (activation_block > currentBlock) must NOT be deactivated here - it
    // was never counted in the unstake and the cooldown sweep would never refund it, orphaning the
    // tokens. It correctly stays an active stake until a later UNSTAKE covers it.
    async setStakeDeactivationByPubkey(pubkey, deactivationBlock, currentBlock){
        let pubkey_id = await this.getPubkeyId(String(pubkey).toLowerCase());
        if(pubkey_id === null) return false;
        let valid_id = await this.getStatusId('valid');
        let query = `UPDATE stakes SET deactivation_block=?
                     WHERE signing_pubkey_id=? AND status_id=? AND deactivation_block IS NULL
                       AND activation_block <= ?`;
        await this.doQuery(query, [deactivationBlock, pubkey_id, valid_id, currentBlock]);
        return true;
    },

    // Create/Update record in `unstakes` table
    async createUnstake(data){
        data                  = this.normalizeDataValues(data);
        let status_id         = await this.createStatus(data['STATUS']);
        let source_id         = await this.getAddressId(data['SOURCE']);
        let signing_pubkey_id = await this.getOrCreatePubkeyId(data['SIGNING_PUBKEY']);
        let action_index      = data['ACTION_INDEX'];
        let cooldown_end_block = data['COOLDOWN_END_BLOCK'];
        let amount            = data['AMOUNT'] || '0';
        let block_index       = data['BLOCK_INDEX'];
        // Check if record already exists
        let query  = "SELECT action_index FROM unstakes WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE unstakes SET
                        source_id=?, signing_pubkey_id=?, cooldown_end_block=?,
                        amount=?, status_id=?, block_index=?
                    WHERE action_index=?`;
            args = [source_id, signing_pubkey_id, cooldown_end_block, amount, status_id, block_index, action_index];
        } else {
            query = `INSERT INTO unstakes
                        (source_id, signing_pubkey_id, cooldown_end_block, amount, status_id, block_index, action_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`;
            args = [source_id, signing_pubkey_id, cooldown_end_block, amount, status_id, block_index, action_index];
        }
        await this.doQuery(query, args);
    },

    // Create/Update record in `stake_key_revocations` table (DELEGATE v2 against
    // the source's ORIGINAL stake signing key - the delegation-row revoke path
    // stays in `delegations`). `deactivation_block` is when the key stops being
    // a valid signer; a LATER re-stake of the same key (higher action_index)
    // clears the revocation (see _effectiveCapabilitySetSql).
    async createStakeKeyRevocation(data){
        data                  = this.normalizeDataValues(data);
        let status_id         = await this.createStatus(data['STATUS']);
        let source_id         = await this.getAddressId(data['SOURCE']);
        let signing_pubkey_id = await this.getOrCreatePubkeyId(data['SIGNING_PUBKEY']);
        let action_index      = data['ACTION_INDEX'];
        let block_index       = data['BLOCK_INDEX'];
        let deactivation_block = data['DEACTIVATION_BLOCK'] || 0;
        let query  = "SELECT action_index FROM stake_key_revocations WHERE action_index=? LIMIT 1";
        let results = await this.doQuery(query, [action_index]);
        let args;
        if(results.length > 0){
            query = `UPDATE stake_key_revocations SET
                        source_id=?, signing_pubkey_id=?, status_id=?, block_index=?, deactivation_block=?
                    WHERE action_index=?`;
            args = [source_id, signing_pubkey_id, status_id, block_index, deactivation_block, action_index];
        } else {
            query = `INSERT INTO stake_key_revocations
                        (source_id, signing_pubkey_id, status_id, block_index, deactivation_block, action_index)
                    VALUES (?, ?, ?, ?, ?, ?)`;
            args = [source_id, signing_pubkey_id, status_id, block_index, deactivation_block, action_index];
        }
        await this.doQuery(query, args);
    },

    // Get the latest valid stake-key revocation for (source, pubkey) that applies
    // to stakes at or before `sinceActionIndex` (i.e. would suppress that stake row).
    async getStakeKeyRevocation(source, pubkey, sinceActionIndex){
        let source_id = await this.getAddressId(source);
        let pubkey_id = await this.getPubkeyId(String(pubkey).toLowerCase());
        if(source_id === null || pubkey_id === null) return null;
        let valid_id = await this.getStatusId('valid');
        let query = `SELECT * FROM stake_key_revocations
                     WHERE source_id=? AND signing_pubkey_id=? AND status_id=?
                       AND action_index > ?
                     ORDER BY action_index DESC LIMIT 1`;
        let results = await this.doQuery(query, [source_id, pubkey_id, valid_id, Number(sinceActionIndex) || 0]);
        return results.length > 0 ? results[0] : null;
    },

    // Get the source's active stake row bound to a specific signing pubkey at a block
    async getActiveStakeBySourceAndPubkey(source, pubkey, blockIndex){
        let source_id = await this.getAddressId(source);
        let pubkey_id = await this.getPubkeyId(String(pubkey).toLowerCase());
        if(source_id === null || pubkey_id === null) return null;
        let valid_id = await this.getStatusId('valid');
        let query = `SELECT * FROM stakes
                     WHERE source_id=? AND signing_pubkey_id=? AND status_id=?
                       AND activation_block <= ?
                       AND (deactivation_block IS NULL OR deactivation_block > ?)
                     ORDER BY action_index DESC LIMIT 1`;
        let results = await this.doQuery(query, [source_id, pubkey_id, valid_id, blockIndex, blockIndex]);
        return results.length > 0 ? results[0] : null;
    },

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
        if(blockIndex !== undefined && blockIndex !== null){
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
                let staking = this.config['STAKING'];
                let cooldownBlocks = (staking && staking['COOLDOWN_BLOCKS']) ? staking['COOLDOWN_BLOCKS'] : 1000;
                query += ' AND (s.deactivation_block IS NULL OR s.deactivation_block + ? > ?)';
                args.push(cooldownBlocks);
                args.push(blockIndex);
            } else if(opts && opts.undeactivatedOnly){
                // UNSTAKE path: only stakes not already being unstaked (deactivation_block
                // IS NULL). A stake already deactivating from a prior UNSTAKE in the same
                // activation-delay window stays "active" (deactivation_block is a future
                // block) and would otherwise be re-unstaked here, double-crediting the
                // staker at cooldown end (item 4617).
                query += ' AND s.activation_block <= ? AND s.deactivation_block IS NULL';
                args.push(blockIndex);
            } else {
                query += ' AND s.activation_block <= ? AND (s.deactivation_block IS NULL OR s.deactivation_block > ?)';
                args.push(blockIndex);
                args.push(blockIndex);
            }
        }
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
            console.warn('getActiveValidators hit the result cap of ' + limit + ' rows at block ' + blockIndex + ' - validator set may be truncated. Raise the frozen VALIDATOR_QUERY_LIMIT consensus constant (coordinated fleet upgrade) if the federation has grown.');
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
            console.warn('getValidatorsByCapability(' + capability + ') hit the result cap of ' + limit + ' rows at block ' + blockIndex + ' - validator set may be truncated. Raise the frozen VALIDATOR_QUERY_LIMIT consensus constant (coordinated fleet upgrade) if the federation has grown.');
        let result = rows.map(r => ({
            pubkey: String(r.pubkey),
            amount: (r.total === null || r.total === undefined) ? '0' : String(r.total)
        }));
        result.truncated = truncated;
        return result;
    },

    // Effective signer set for a capability at a block (DELEGATE semantics,
    // additive-until-revoked). A source's effective keys are:
    //   stake keys     - per-pubkey aggregate active stake >= MIN_STAKE, EXCLUDING
    //                    keys revoked via DELEGATE v2 (stake_key_revocations). A
    //                    revocation only applies to stake rows that predate it
    //                    (r.action_index > s.action_index), so re-staking the same
    //                    key later restores it.
    //   delegated keys - active `delegations` rows whose SOURCE's aggregate active
    //                    stake >= MIN_STAKE. Delegated keys are backed by the
    //                    source's whole stake; they add signers, they never change
    //                    staked amounts (spec: DELEGATE.md).
    // Every PBFT-quorum read (capability snapshots, signature verification, quorum
    // counts) MUST resolve through this one query so all consumers agree -
    // CONSENSUS-CRITICAL: any change here forks validation.
    _effectiveCapabilitySetSql(valid_id, blockIndex, minStake){
        // Permanent disqualification (WI-2 bump 2): a signing key proven to have
        // equivocated is PERMANENTLY barred from the effective signer set - not just
        // until its current bond burns to 0, but against any future re-stake/re-delegation
        // of the same key. The exclusion is GLOBAL (any capability the key was slashed in
        // bars it everywhere - an equivocating key has proven byzantine) and block-gated
        // (`cse.block_index <= ?`) so re-deriving a historical block before the slash is
        // byte-identical, and reorg-safe (the slash event rolls back ⇒ eligibility returns).
        // Applied identically in _stakeWeightsSql and hasCapability so every quorum read agrees.
        const slashExcl = (keyCol) =>
            `AND NOT EXISTS (SELECT 1 FROM capability_slash_events cse
                             WHERE cse.signing_pubkey_id = ${keyCol} AND cse.block_index <= ?)`;
        let sql = `SELECT ip.pubkey AS pubkey,
                          SUM(CAST(s.amount AS DECIMAL(30,8))) AS total
                   FROM stakes s
                   JOIN index_pubkeys ip ON ip.id = s.signing_pubkey_id
                   WHERE s.status_id = ?
                     AND s.activation_block <= ?
                     AND (s.deactivation_block IS NULL OR s.deactivation_block > ?)
                     AND NOT EXISTS (
                         SELECT 1 FROM stake_key_revocations r
                         WHERE r.source_id = s.source_id
                           AND r.signing_pubkey_id = s.signing_pubkey_id
                           AND r.status_id = ?
                           AND r.deactivation_block <= ?
                           AND r.action_index > s.action_index)
                     ${slashExcl('s.signing_pubkey_id')}
                   GROUP BY ip.pubkey
                   HAVING total >= CAST(? AS DECIMAL(30,8))
                   UNION ALL
                   SELECT ip2.pubkey AS pubkey, src.total AS total
                   FROM delegations d
                   JOIN index_pubkeys ip2 ON ip2.id = d.signing_pubkey_id
                   JOIN (
                       SELECT s2.source_id AS source_id,
                              SUM(CAST(s2.amount AS DECIMAL(30,8))) AS total
                       FROM stakes s2
                       WHERE s2.status_id = ?
                         AND s2.activation_block <= ?
                         AND (s2.deactivation_block IS NULL OR s2.deactivation_block > ?)
                       GROUP BY s2.source_id
                       HAVING total >= CAST(? AS DECIMAL(30,8))
                   ) src ON src.source_id = d.source_id
                   WHERE d.status_id = ?
                     AND d.activation_block <= ?
                     AND (d.deactivation_block IS NULL OR d.deactivation_block > ?)
                     ${slashExcl('d.signing_pubkey_id')}`;
        let args = [valid_id, blockIndex, blockIndex, valid_id, blockIndex, blockIndex, minStake,
                    valid_id, blockIndex, blockIndex, minStake,
                    valid_id, blockIndex, blockIndex, blockIndex];
        return { sql, args };
    },

    // Source-keyed effective-signer query (DELEGATE.md additive model).
    //   qualifying sources - per-source aggregate active stake >= MIN_STAKE.
    //   effective keys     - the source's own active stake keys (EXCLUDING keys
    //                        revoked via DELEGATE v2 in effect at the block, applied
    //                        only to stake rows predating the revocation) UNION the
    //                        source's active delegated keys.
    // One output row per (effective key): { pubkey, source(address), weight(=source
    // aggregate) }. Every key of a source carries the SAME source + weight, so a
    // source-deduped tally counts that stake once. CONSENSUS-CRITICAL - mirrors the
    // qualification/revocation/delegation semantics of _effectiveCapabilitySetSql.
    _stakeWeightsSql(valid_id, blockIndex, minStake){
        // Precision: DECIMAL(30,8) (22 integer digits, 8 fractional) is sufficient because the
        // staking tick is XCHAIN at 8 decimals and total supply stays far below 10^22; every
        // same-version node truncates identically, so the stake-weight tally is deterministic.
        // If a >8-decimal staking tick is ever introduced, widen these casts to
        // DECIMAL(60, <tick-decimals>) AND pin a consistent sql_mode fleet-wide (an overflow at
        // >22 integer digits is otherwise sql_mode-dependent) before that tick can stake.
        // Permanent disqualification - see _effectiveCapabilitySetSql. Excludes equivocation-
        // slashed keys from the effective-key set (both stake-key and delegated-key branches)
        // so the source-deduped stake-weight tally matches the count-quorum set exactly.
        const slashExcl = (keyCol) =>
            `AND NOT EXISTS (SELECT 1 FROM capability_slash_events cse
                             WHERE cse.signing_pubkey_id = ${keyCol} AND cse.block_index <= ?)`;
        let sql = `SELECT ip.pubkey AS pubkey,
                          sa.address AS source,
                          q.total    AS weight
                   FROM (
                       SELECT s.source_id AS source_id,
                              SUM(CAST(s.amount AS DECIMAL(30,8))) AS total
                       FROM stakes s
                       WHERE s.status_id = ?
                         AND s.activation_block <= ?
                         AND (s.deactivation_block IS NULL OR s.deactivation_block > ?)
                       GROUP BY s.source_id
                       HAVING total >= CAST(? AS DECIMAL(30,8))
                   ) q
                   JOIN index_addresses sa ON sa.id = q.source_id
                   JOIN (
                       SELECT s2.source_id AS source_id, s2.signing_pubkey_id AS pubkey_id
                       FROM stakes s2
                       WHERE s2.status_id = ?
                         AND s2.activation_block <= ?
                         AND (s2.deactivation_block IS NULL OR s2.deactivation_block > ?)
                         AND NOT EXISTS (
                             SELECT 1 FROM stake_key_revocations r
                             WHERE r.source_id = s2.source_id
                               AND r.signing_pubkey_id = s2.signing_pubkey_id
                               AND r.status_id = ?
                               AND r.deactivation_block <= ?
                               AND r.action_index > s2.action_index)
                         ${slashExcl('s2.signing_pubkey_id')}
                       GROUP BY s2.source_id, s2.signing_pubkey_id
                       UNION
                       SELECT d.source_id AS source_id, d.signing_pubkey_id AS pubkey_id
                       FROM delegations d
                       WHERE d.status_id = ?
                         AND d.activation_block <= ?
                         AND (d.deactivation_block IS NULL OR d.deactivation_block > ?)
                         ${slashExcl('d.signing_pubkey_id')}
                   ) ek ON ek.source_id = q.source_id
                   JOIN index_pubkeys ip ON ip.id = ek.pubkey_id`;
        let args = [valid_id, blockIndex, blockIndex, minStake,
                    valid_id, blockIndex, blockIndex, valid_id, blockIndex, blockIndex,
                    valid_id, blockIndex, blockIndex, blockIndex];
        return { sql, args };
    },

    // SWQ source-cap wrapper (SWQ-TRUNC-1 liveness half). Wraps an inner source-keyed
    // stake-weight builder ({sql,args} from _stakeWeightsSql or the sync AsOf variant)
    // and replaces the raw key-row LIMIT with a windowed cap on the consensus UNIT:
    // DISTINCT staking SOURCES (DENSE_RANK over source) plus a per-source key bound
    // (ROW_NUMBER per source). One source can no longer fill the window and evict
    // honest sources. Over-fetches one extra source (_sr <= maxSources + 1) so the
    // caller can flag a genuinely >maxSources federation as truncated (the primitive
    // then fails closed); the per-source key cap only bounds the row/leaf count and
    // never sets truncated (dropping a source's excess keys does not change its
    // weight). Row order is consensus-irrelevant (the stakes_root SMT keys on
    // pubkey+capability); only the returned SET is. CONSENSUS-CRITICAL: feeds the
    // hashed stakes_root at/after SWQ_SOURCE_CAP_ACTIVATION and MUST stay byte-identical
    // to the xchain-sync twin (cross-repo drift guard in rollback_coverage.test.js).
    //
    // `binCollation` (stake_weight_collation_activation.js) pins the ordering to a
    // binary collation. `source` and `pubkey` resolve through index_addresses.address
    // and index_pubkeys.pubkey, both declared utf8_general_ci (folding), and every
    // other consensus read of those columns already pins utf8_bin. Order is a
    // consensus quantity HERE and only here: the two window ranks are what the caps
    // truncate on, so the collation decides which sources and which keys survive into
    // the hashed stakes_root. Below the height the emitted SQL is byte-identical to
    // what shipped before the gate; the suffix is '' and concatenates away.
    _cappedStakeWeightsSql(inner, maxSources, maxKeys, binCollation){
        let c = stakeWeightCollation.stakeWeightCollate(binCollation);
        let sql = `SELECT r.pubkey AS pubkey, r.source AS source, r.weight AS weight, r._sr AS _sr
                   FROM (
                       SELECT b.pubkey AS pubkey, b.source AS source, b.weight AS weight,
                              DENSE_RANK() OVER (ORDER BY b.source${c})                        AS _sr,
                              ROW_NUMBER() OVER (PARTITION BY b.source${c} ORDER BY b.pubkey${c})  AS _kr
                       FROM (${inner.sql}) b
                   ) r
                   WHERE r._sr <= ? AND r._kr <= ?
                   ORDER BY r.source${c}, r.pubkey${c}`;
        let args = [...inner.args, maxSources + 1, maxKeys];
        return { sql, args };
    },

    // Check whether a pubkey's active stake qualifies for a capability.
    // Returns true if SUM(active stake amount for pubkey) >= governance.min_stake[capability].
    async hasCapability(pubkey, capability, blockIndex, minStakeOverride){
        // Off-BTC chains verify the mirrored capabilities against the hub-mirrored capability
        // snapshot (presence = qualified) since capability stakes live only on BTC. Routed
        // through the SAME predicate as the three set/weight/count resolvers, so the
        // truncation fallback in actions/price.js cannot land on a path that answers false
        // for every signer while the capable-set read answered from the mirror.
        if(usesCapabilitySnapshot(this.config, capability))
            return await this.isPubkeyInCapabilitySnapshot(pubkey, capability, blockIndex);
        let caps = (this.config['STAKING'] && this.config['STAKING']['CAPABILITIES']) ? this.config['STAKING']['CAPABILITIES'] : {};
        let capConfig = caps[capability];
        if(!capConfig) return false;
        // A caller-supplied threshold (the hub's authoritative MIN_STAKE) is
        // honoured VERBATIM (see getValidatorsByCapability). The local floor is
        // only the default when NO override is supplied; it never clamps an
        // explicit caller value, so this per-pubkey membership test agrees with
        // the qualifying set that every other hub/indexer resolves for the block.
        let localFloor = capConfig['MIN_STAKE'] || '0';
        let minStake = (minStakeOverride !== undefined && minStakeOverride !== null)
            ? String(minStakeOverride)
            : localFloor;
        let valid_id = await this.getStatusId('valid');
        if(valid_id === null) return false;
        let pubkey_id = await this.getPubkeyId(String(pubkey).toLowerCase());
        if(pubkey_id === null) return false;
        if(blockIndex === undefined || blockIndex === null)
            blockIndex = await this.getLatestBlockIndex();
        // Permanent disqualification (WI-2 bump 2): an equivocation-slashed key is barred
        // from ALL capabilities - must agree with the effective-set queries
        // (_effectiveCapabilitySetSql / _stakeWeightsSql), which exclude it too.
        if(await this._isPubkeySlashedAt(pubkey_id, blockIndex)) return false;
        // Per-pubkey membership test against the SAME effective signer set as
        // getValidatorsByCapability (stake keys minus DELEGATE v2 revocations,
        // plus delegated keys backed by the source's aggregate stake) - the
        // signature-verification paths and the quorum-set paths must agree.
        // Stake-key path: per-pubkey aggregate of active, non-revoked stakes.
        let query = `SELECT SUM(CAST(s.amount AS DECIMAL(30,8))) AS total
                     FROM stakes s
                     WHERE s.signing_pubkey_id = ?
                       AND s.status_id = ?
                       AND s.activation_block <= ?
                       AND (s.deactivation_block IS NULL OR s.deactivation_block > ?)
                       AND NOT EXISTS (
                           SELECT 1 FROM stake_key_revocations r
                           WHERE r.source_id = s.source_id
                             AND r.signing_pubkey_id = s.signing_pubkey_id
                             AND r.status_id = ?
                             AND r.deactivation_block <= ?
                             AND r.action_index > s.action_index)`;
        let rows = await this.doQuery(query, [pubkey_id, valid_id, blockIndex, blockIndex, valid_id, blockIndex]);
        if(rows.length > 0 && rows[0].total !== null && this.util.bcgte(String(rows[0].total), minStake))
            return true;
        // Delegated-key path: an active delegation row for this pubkey qualifies
        // iff the delegating SOURCE's aggregate active stake meets the threshold.
        query = `SELECT SUM(CAST(s2.amount AS DECIMAL(30,8))) AS total
                 FROM stakes s2
                 WHERE s2.status_id = ?
                   AND s2.activation_block <= ?
                   AND (s2.deactivation_block IS NULL OR s2.deactivation_block > ?)
                   AND s2.source_id IN (
                       SELECT d.source_id FROM delegations d
                       WHERE d.signing_pubkey_id = ?
                         AND d.status_id = ?
                         AND d.activation_block <= ?
                         AND (d.deactivation_block IS NULL OR d.deactivation_block > ?))`;
        rows = await this.doQuery(query, [valid_id, blockIndex, blockIndex, pubkey_id, valid_id, blockIndex, blockIndex]);
        if(rows.length > 0 && rows[0].total !== null && this.util.bcgte(String(rows[0].total), minStake))
            return true;
        return false;
    },

    // Every stake row an eviction must sweep for `source`, grouped by signing key.
    //
    // INCLUDES PENDING-ACTIVATION ROWS, which is the difference from the UNSTAKE
    // path and is deliberate: UNSTAKE leaves them alone because the actor chose an
    // amount that did not cover them, but an eviction is not an amount, it is a
    // removal. Leaving them would let a 1-XCHAIN top-up landed just before the
    // epoch walk the source straight back in.
    async getSweepableStakeBySource(source, blockIndex, includePending){
        let source_id = await this.getAddressId(source);
        if(source_id === null) return [];
        let valid_id = await this.getStatusId('valid');
        if(valid_id === null) return [];
        let query = `SELECT s.signing_pubkey_id                     AS signing_pubkey_id,
                            ip.pubkey                               AS signing_pubkey,
                            SUM(CAST(s.amount AS DECIMAL(30,8)))    AS amount
                       FROM stakes s
                            LEFT JOIN index_pubkeys ip ON (ip.id = s.signing_pubkey_id)
                      WHERE s.source_id = ? AND s.status_id = ? AND s.deactivation_block IS NULL`;
        let args = [source_id, valid_id];
        if(!includePending && blockIndex !== undefined && blockIndex !== null){
            query += ' AND s.activation_block <= ?';
            args.push(blockIndex);
        }
        // Pin the row order on the natural key: the sole caller mints one action_index per
        // returned row, so this ORDER is consensus (never signing_pubkey_id, a local surrogate).
        //
        // Collate utf8_bin because index_pubkeys.pubkey is declared utf8_general_ci, a folding
        // collation that can tie two keys the order must separate (charset held at boot).
        query += ' GROUP BY s.signing_pubkey_id, ip.pubkey ORDER BY ip.pubkey COLLATE utf8_bin ASC';
        let rows = await this.doQuery(query, args);
        // Fail closed on a dangling signing_pubkey: LEFT JOIN nulls tie under any order, and
        // the caller would mint an UNSTAKE against an index_pubkeys row createUnstake invents.
        for(const r of rows){
            if(r.signing_pubkey === null || r.signing_pubkey === undefined || String(r.signing_pubkey) === '')
                throw new Error('getSweepableStakeBySource: source ' + String(source) +
                                ' has a stake row whose signing_pubkey_id ' + String(r.signing_pubkey_id) +
                                ' has no index_pubkeys row');
        }
        return rows.map((r) => ({
            signing_pubkey_id: r.signing_pubkey_id,
            signing_pubkey:    r.signing_pubkey,
            amount:            (r.amount === null || r.amount === undefined) ? '0' : String(r.amount)
        }));
    },

    // SOURCE-SCOPED deactivation stamp, and the scoping is a correctness
    // requirement rather than tidiness. setStakeDeactivationByPubkey has no
    // source_id term, so against a key held by two sources it would deactivate the
    // OTHER source's stake as well -- an eviction of one validator silently
    // un-membering a second. `includePending` drops the activation_block ceiling so
    // the sweep covers the pending rows getSweepableStakeBySource counted.
    async setStakeDeactivationBySourceAndPubkey(source, pubkey, deactivationBlock, currentBlock, includePending){
        let source_id = await this.getAddressId(source);
        let pubkey_id = await this.getPubkeyId(String(pubkey).toLowerCase());
        if(source_id === null || pubkey_id === null) return false;
        let valid_id = await this.getStatusId('valid');
        let query = `UPDATE stakes SET deactivation_block=?
                     WHERE source_id=? AND signing_pubkey_id=? AND status_id=? AND deactivation_block IS NULL`;
        let args = [deactivationBlock, source_id, pubkey_id, valid_id];
        if(!includePending){
            query += ' AND activation_block <= ?';
            args.push(currentBlock);
        }
        await this.doQuery(query, args);
        return true;
    },

    // Burn an equivocating validator's ENTIRE capability bond (active `stakes` + cooldown-
    // locked `unstakes`), recording each in-place reduction in capability_slash_debits so a
    // reorg restores the pre-slash amounts verbatim (see rollback.js).
    //
    // Returns { total, releases }, the same shape as slashContractStake and for the same
    // reason: the bond sits in the staker's ESCROW and the caller releases it there before
    // crediting bounty/treasury. `releases` is [{ address, amount }] per owning address in
    // LIFO row order, summing to `total` (the XCHAIN burned, as a string); a delegated key's
    // rows resolve to the OWNING source, so one burn can span several addresses.
    //
    // Unlike slashContractStake (per-contract, per-tick, partial `amount`), capability stake
    // is a single XCHAIN bond per signing pubkey (XCHAIN-only - no contract/tick), and a
    // cryptographic equivocation proof burns the WHOLE bond in one shot. The deactivation-
    // window guard on Pass 1 is the same supply-inflation correctness point as the contract
    // path: after UNSTAKE a `stakes` row keeps its `amount` intact (only deactivation_block is
    // set) AND its tokens are mirrored into a cooldown `unstakes` row, so Pass 1 must skip that
    // phantom copy (Pass 2 burns the cooldown row) - each token burned exactly once. The
    // (pubkey,capability) dedup that makes a first slash idempotent lives in the SLASH handler.
    // ownerSourceId: when the offender is a DELEGATED signing key, the bond
    // lives on the OWNING source's stakes, not on rows keyed by the delegated pubkey.
    // Callers resolve it with getStakeSourceForDelegatedPubkey() AT THE EQUIVOCATION
    // HEIGHT and pass it here; null keeps the original signing_pubkey_id targeting for
    // a key that stakes in its own name.
    //
    // The burn is min(target, remaining) by construction rather than by arithmetic:
    // each row is zeroed for exactly the amount it still holds, and rows already at 0
    // are skipped. So a bond that has since fully unstaked and been withdrawn burns
    // ZERO and the SLASH still records as valid, which is the pinned resolution: the
    // outcome must not depend on stake motion after the offence.
    async slashCapabilityStake(pubkeyId, blockIndex, slashActionIndex, burnPending, ownerSourceId = null){
        let valid_id = await this.getStatusId('valid');
        if(valid_id === null) return { total: '0', releases: [] };
        let totalSlashed = '0';
        // Escrow release breakdown, accumulated as the rows are burned; XCHAIN is 8-dp,
        // matching the arithmetic below. LIFO scan order, so every node writes it alike.
        let releases = new Map();
        let addRelease = (address, take) => {
            // Same halt as slashContractStake: an unattributable bond cannot be released.
            if(address === null || address === undefined)
                throw new Error('slashCapabilityStake: stake row has no source address; its escrow is not releasable');
            let cur = releases.get(address);
            releases.set(address, this.util.bcstr(this.util.bcadd(cur === undefined ? '0' : cur, take, 8)));
        };
        // Pass 1: ACTIVE (never-unstaked) stakes rows (LIFO - highest action_index first). Same
        // correctness point as slashContractStake: after UNSTAKE the `stakes` row keeps its amount
        // but carries a FUTURE deactivation_block and its tokens are mirrored into a cooldown
        // `unstakes` row (Pass 2). Pass 1 must skip any row with a deactivation_block set, else a
        // slash in the [unstake, unstake+delay) window burns BOTH the stakes row here AND the
        // unstakes row in Pass 2 (which has no `remaining` gate), doubling `totalSlashed` and
        // inflating the bounty/treasury base computed from it. `deactivation_block > blockIndex`
        // was the inverted predicate (future block => TRUE in-window).
        // SLASH-1 (gated by SLASH_BURNS_PENDING_STAKE, caller passes burnPending): a byzantine key's
        // ENTIRE locked bond must burn, activated or NOT. A pending-activation top-up
        // (activation_block > blockIndex) was already debited from the staker at STAKE time, so the
        // legacy `activation_block <= ?` filter let it survive the burn and be UNSTAKEd/refunded
        // later (the sibling slashContractStake never had this filter). At/after the flag-day the
        // predicate is dropped; below it the legacy activation-gated burn is preserved for
        // replay/fleet consistency. The `deactivation_block IS NULL` guard is INDEPENDENT and stays
        // in both regimes (it is the Pass-1/Pass-2 double-burn defense, not an activation gate).
        let activationClause = burnPending ? '' : 'AND s.activation_block <= ?';
        // Target the owning source when the offender was a delegated key (#3163),
        // otherwise the offender's own signing key. Exactly one column is matched, so
        // there is no chance of double-counting a row across both spellings.
        let targetCol = (ownerSourceId !== null && ownerSourceId !== undefined) ? 'source_id' : 'signing_pubkey_id';
        let targetVal = (ownerSourceId !== null && ownerSourceId !== undefined) ? ownerSourceId : pubkeyId;
        let stakesQ = `SELECT s.action_index, s.amount, a.address AS source_address
                       FROM stakes s
                           LEFT JOIN index_addresses a ON (a.id = s.source_id)
                       WHERE s.${targetCol}=? AND s.status_id=?
                         ${activationClause}
                         AND CAST(s.amount AS DECIMAL(30,8)) > 0
                         AND s.deactivation_block IS NULL
                       ORDER BY s.action_index DESC`;
        let stakeArgs = burnPending ? [targetVal, valid_id] : [targetVal, valid_id, blockIndex];
        let stakeRows = await this.doQuery(stakesQ, stakeArgs);
        for(let row of stakeRows){
            let rowAmt = String(row.amount);
            if(!this.util.bcgt(rowAmt, '0')) continue;
            await this.doQuery('UPDATE stakes SET amount=? WHERE action_index=?', ['0', row.action_index]);
            // prev_amount = the whole row (we burn it entirely); delta = the same.
            await this.createCapabilitySlashDebit(slashActionIndex, 'stakes', row.action_index, rowAmt, rowAmt, blockIndex);
            addRelease(row.source_address, rowAmt);
            totalSlashed = this.util.bcadd(totalSlashed, rowAmt, 8);
        }
        // Pass 2: cooldown-locked unstakes rows (status valid/pending) - slashable too (closes R-4:
        // capability unstakes are NOT slashable under the legacy contract-only path).
        let pendingId = await this.getStatusId('pending');
        let unstakeStatusIds = [valid_id];
        if(pendingId !== null) unstakeStatusIds.push(pendingId);
        let placeholders = unstakeStatusIds.map(() => '?').join(',');
        // Same owner-vs-own-key targeting as Pass 1 (#3163): cooldown-locked tokens of a
        // delegated key's OWNER are part of the bond and must burn with it.
        let unstakesQ = `SELECT u.action_index, u.amount, a.address AS source_address
                         FROM unstakes u
                             LEFT JOIN index_addresses a ON (a.id = u.source_id)
                         WHERE u.${targetCol}=? AND u.status_id IN (${placeholders})
                           AND CAST(u.amount AS DECIMAL(30,8)) > 0
                         ORDER BY u.action_index DESC`;
        let unstakeRows = await this.doQuery(unstakesQ, [targetVal, ...unstakeStatusIds]);
        for(let row of unstakeRows){
            let rowAmt = String(row.amount);
            if(!this.util.bcgt(rowAmt, '0')) continue;
            await this.doQuery('UPDATE unstakes SET amount=? WHERE action_index=?', ['0', row.action_index]);
            await this.createCapabilitySlashDebit(slashActionIndex, 'unstakes', row.action_index, rowAmt, rowAmt, blockIndex);
            addRelease(row.source_address, rowAmt);
            totalSlashed = this.util.bcadd(totalSlashed, rowAmt, 8);
        }
        return { total: this.util.bcstr(totalSlashed), releases: Array.from(releases, ([address, amount]) => ({ address, amount })) };
    },


    // The source address that a signing pubkey resolves to through a STAKE, as of a block.
    // Backs the getstakesourcebypubkey federation RPC, whose delegation fallback lives in
    // db/delegations.js.
    //
    // The predicates here mirror the effective-capability-set active-row rules exactly: a key
    // COUNTED in the set at this block (and so earning the reward being archived) must always
    // resolve, or the publisher defers a reward it can never settle and suppresses the whole
    // archive. That means status, activation and deactivation window, stake-key revocation and
    // permanent slash, and deliberately NOT the row's own recording block_index: an extra
    // block_index filter here once left a key counted-but-unresolvable and blocked the publish.
    async getStakeSourceAddressBySigningPubkey(pubkeyId, validId, blockIndex){
        return await this.doQuery(
            `SELECT ia.address AS source FROM stakes s
             JOIN index_addresses ia ON ia.id = s.source_id
             WHERE s.signing_pubkey_id = ? AND s.status_id = ?
               AND s.activation_block <= ?
               AND (s.deactivation_block IS NULL OR s.deactivation_block > ?)
               AND NOT EXISTS (
                   SELECT 1 FROM stake_key_revocations r
                   WHERE r.source_id = s.source_id
                     AND r.signing_pubkey_id = s.signing_pubkey_id
                     AND r.status_id = ?
                     AND r.deactivation_block <= ?
                     AND r.action_index > s.action_index)
               AND NOT EXISTS (
                   SELECT 1 FROM capability_slash_events cse
                   WHERE cse.signing_pubkey_id = s.signing_pubkey_id
                     AND cse.block_index <= ?)
             ORDER BY s.action_index DESC LIMIT 1`,
            [pubkeyId, validId, blockIndex, blockIndex, validId, blockIndex, blockIndex]);
    },


    // The credit-bearing fields of a set of matured capability unstakes, in action_index
    // order. The cooldown sweep already knows WHICH unstakes matured; this re-reads the
    // amount and source address it needs to write each release credit under its own
    // action_index trail. The IN-list is sized to the caller's list, the house idiom for a
    // batched read; the list comes from the sweep, never from the wire.
    async getMaturedUnstakeCreditRows(actionIndexes){
        let placeholders = actionIndexes.map(() => '?').join(',');
        return await this.doQuery(
            `SELECT u.action_index, u.amount, a.address AS source_address
                     FROM unstakes u
                         LEFT JOIN index_addresses a ON (a.id = u.source_id)
                     WHERE u.action_index IN (${placeholders})
                     ORDER BY u.action_index ASC`,
            actionIndexes);
    },

    // The contract-stake half of the same sweep. Carries the tick as well, because a
    // contract unstake releases an arbitrary token rather than the gas ticker.
    async getMaturedContractUnstakeCreditRows(actionIndexes){
        let placeholders = actionIndexes.map(() => '?').join(',');
        return await this.doQuery(
            `SELECT cu.action_index, cu.amount, a.address AS source_address, t.tick AS tick
                     FROM contract_unstakes cu
                         LEFT JOIN index_addresses a ON (a.id = cu.source_id)
                         LEFT JOIN index_tickers   t ON (t.id = cu.tick_id)
                     WHERE cu.action_index IN (${placeholders})
                     ORDER BY cu.action_index ASC`,
            actionIndexes);
    },

};
