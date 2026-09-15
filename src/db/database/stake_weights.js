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
 * XChain Indexer - Database class part: stake weights
 *
 * Stake-weighted quorum reads and the BTC-side re-derivation of a mirrored capability
 * snapshot row.
 *
 * A part of the Database class body: db/index.js installs it onto Database.prototype,
 * non-enumerable and in the order the class declared it, so call sites stay
 * this.db.<method>().
 *
 ********************************************************************/

// Strict, as the class body these methods came from was.
'use strict';

const swqCap = require('../../swq_source_cap_activation');
const stakeWeightCollation = require('../../stake_weight_collation_activation');
const { getLogger } = require('../../observability/index.js');
// Module-level state and pure helpers that the split keeps in one place, so the class
// and every mixin read the same instance of each.
const { requireStakeWeight, normalizeStakeAmount, usesCapabilitySnapshot } = require('../shared.js');

module.exports = {

    // Source-keyed all-staker weights at `blockIndex` - the STAKE_WEIGHTED_QUORUM
    // counterpart of getActiveValidators (the config-change PBFT's whole-federation
    // set). Every source with ANY active stake (no MIN_STAKE floor) and all its
    // effective keys, each carrying the source address + the source's aggregate
    // weight, so Σ weight over DISTINCT sources = S. Used by xchain-hub's Consensus
    // when weighting governance/config quorum by stake. CONSENSUS-CRITICAL: shares
    // the DELEGATE-additive stakeWeightsSql with getStakeWeightsByCapability, so it
    // resolves identically on every hub (a divergence forks config consensus).
    async getActiveStakeWeights(blockIndex){
        let valid_id = await this.getStatusId('valid');
        if(valid_id === null) return [];
        // Safety cap - see getActiveValidators. No MIN_STAKE floor (minStake '0').
        let { rows, truncated } = await this.stakeWeightsWithCap(valid_id, blockIndex, '0', 'getActiveStakeWeights');
        let result = rows;
        // Surface truncation to callers (the RPC layer alarms on it) the same way
        // the capability variants do - the console.warn alone is invisible to a hub.
        result.truncated = truncated;
        return result;
    },

    // ── Stake-weighted quorum (STAKE_WEIGHTED_QUORUM) ─────────────────────────
    // Source-keyed validator weights for a capability at a BTC-anchored block.
    // Weight belongs to the staking ADDRESS (source), NOT the signing key: DELEGATE
    // v0 is additive - one source may authorize many keys, all backed by the source's
    // aggregate stake (DELEGATE.md "Effective signer set") - so a pubkey-keyed weight
    // would let one stake vote (N+1)x by delegating N keys. Returns one row per
    // effective signer key, each carrying its `source` (address) + the source's
    // aggregate `weight`. Σ weight over DISTINCT sources = S. CONSENSUS-CRITICAL:
    // must resolve identically on the hub and every indexer or validation forks.
    async getStakeWeightsByCapability(capability, blockIndex, minStakeOverride){
        // Off-BTC chains have no local capability stakes - read the source-keyed
        // weights from the hub-mirrored capability_snapshots. Routed through the SAME
        // predicate as getValidatorsByCapability so the count set and the weight set can
        // never come from different sources; see usesCapabilitySnapshot.
        if(usesCapabilitySnapshot(this.config, capability))
            return await this.getCapabilitySnapshotWeights(capability, blockIndex);
        let caps = (this.config['STAKING'] && this.config['STAKING']['CAPABILITIES']) ? this.config['STAKING']['CAPABILITIES'] : {};
        let capConfig = caps[capability];
        if(!capConfig) return [];
        // Caller-supplied threshold (the hub's authoritative, signed/governance-
        // anchored MIN_STAKE) is honoured VERBATIM, identically to
        // getValidatorsByCapability/getActiveCapabilityCount/hasCapability - this
        // keeps the count path and weight path symmetric AND keeps every indexer
        // computing the same set for the same block (cross-hub/cross-indexer
        // determinism). The local floor is ONLY the default when no override is
        // supplied; it never clamps an explicit caller value. Anti-inflation lives
        // at the hub + on-chain-validation layers, not in this read path.
        let localFloor = capConfig['MIN_STAKE'] || '0';
        let minStake = (minStakeOverride !== undefined && minStakeOverride !== null)
            ? String(minStakeOverride)
            : localFloor;
        let valid_id = await this.getStatusId('valid');
        if(valid_id === null) return [];
        let { rows, truncated } = await this.stakeWeightsWithCap(valid_id, blockIndex, minStake, 'getStakeWeightsByCapability(' + capability + ')');
        let result = rows;
        result.truncated = truncated;
        return result;
    },

    // Run the source-keyed stake-weight query under the cap regime in force for this
    // chain at `blockIndex`, returning { rows:[{pubkey,source,weight}], truncated }.
    //   at/after SWQ_SOURCE_CAP_ACTIVATION -> windowed source-cap (cappedStakeWeightsSql):
    //       truncated ONLY when a genuinely >maxSources federation is seen; a
    //       key-spamming source is bounded (maxKeys) without truncating.
    //   below it -> legacy uncapped key-row LIMIT: truncated at >= VALIDATOR_QUERY_LIMIT.
    // The gate (network/coin/blockIndex) + caps + cappedStakeWeightsSql are byte-mirrored
    // in xchain-sync so the stakes_root set is identical on both sides of the height.
    async stakeWeightsWithCap(valid_id, blockIndex, minStake, label){
        let sw = this.stakeWeightsSql(valid_id, blockIndex, minStake);
        // Ordering collation for BOTH regimes (stake_weight_collation_activation.js);
        // the legacy LIMIT branch truncates on the same order the capped branch ranks on.
        let binCollation = stakeWeightCollation.isStakeWeightBinCollationActive(
            blockIndex, this.config['NETWORK'], this.config['COIN']);
        let swc = stakeWeightCollation.stakeWeightCollate(binCollation);
        if(swqCap.isSwqSourceCapActive(blockIndex, this.config['NETWORK'], this.config['COIN'])){
            let maxSources = swqCap.STAKE_WEIGHT_MAX_SOURCES;
            let maxKeys    = swqCap.STAKE_WEIGHT_MAX_KEYS_PER_SOURCE;
            let capped = this.cappedStakeWeightsSql(sw, maxSources, maxKeys, binCollation);
            let raw = await this.doQuery(capped.sql, capped.args);
            let truncated = raw.some(r => Number(r._sr) > maxSources);
            if(truncated)
                getLogger().warn(label + ' saw more than ' + maxSources + ' distinct staking sources at block ' + blockIndex + ' - snapshot truncated; stake-weighted quorum fails closed. Raise STAKE_WEIGHT_MAX_SOURCES (coordinated flag-day upgrade) if the federation has grown.');
            let rows = (truncated ? raw.filter(r => Number(r._sr) <= maxSources) : raw).map(r => ({
                pubkey: String(r.pubkey),
                source: String(r.source),
                weight: requireStakeWeight(r.weight, label)
            }));
            return { rows, truncated };
        }
        let limit = this.config['VALIDATOR_QUERY_LIMIT'];
        let query = `${sw.sql} ORDER BY source${swc}, pubkey${swc} LIMIT ?`;
        let raw = await this.doQuery(query, [...sw.args, limit]);
        let truncated = raw.length >= limit;
        if(truncated)
            getLogger().warn(label + ' hit the result cap of ' + limit + ' rows at block ' + blockIndex + ' - set may be truncated. Raise the frozen VALIDATOR_QUERY_LIMIT consensus constant (coordinated fleet upgrade) if the federation has grown.');
        let rows = raw.map(r => ({
            pubkey: String(r.pubkey),
            source: String(r.source),
            weight: requireStakeWeight(r.weight, label)
        }));
        return { rows, truncated };
    },

    // Re-derive ONE hub-mirrored capability_snapshots row against this node's OWN
    // authoritative stakes at the row's snapshot_block, and say whether the hub's
    // claim contradicts what this chain can prove.
    //
    // capability_snapshots is the only mirrored table with no authentication on the
    // wire: rows arrive over a bare SELECT and land via INSERT IGNORE, and they are the
    // verification authority every off-BTC resolver reads (cross_chain, oracle_publish,
    // price, attestation). The full remedy is an SMT membership proof against the BTC
    // state_checkpoints stakes_root, which needs a new hub endpoint, a trust anchor, an
    // activation height and a grandfathering watermark. This is the FIRST step of that
    // ladder and nothing more: falsifiability, not coverage.
    //
    // Its honest limit, stated so no caller mistakes it for the proof: it protects BTC
    // ONLY, because BTC is the one chain whose capability stakes are local and therefore
    // the one chain that can re-derive a row without trusting anyone. It is also the one
    // chain that does NOT read the mirror to resolve a capability (usesCapabilitySnapshot
    // is false on BTC). What it buys is that a hub serving FORGED validator sets is
    // caught on the BTC indexers rather than being silently mirrored everywhere.
    //
    // Verdict shape is anchor_proof_client.js's, deliberately:
    //   'verified' - the row's (signing_pubkey, source, amount) matches this node's own
    //                effective-signer set and source aggregate at snapshot_block.
    //   'refused'  - this node CAN re-derive that block and the row contradicts it.
    //   'unknown'  - this node cannot judge (block not reached, capability not local,
    //                set truncated, read failed). The caller applies the row as before:
    //                an unjudgeable row must never become a mirror hole.
    //
    // The local set is re-derived with minStake '0' ON PURPOSE. The hub filters its rows
    // by its OWN authoritative MIN_STAKE, which can legitimately differ from this node's
    // local floor, so re-deriving at the local floor would refuse honest rows the moment
    // the two drifted. At '0' the local set is the widest superset (every source with any
    // active stake, every effective key of it), and per-source weight is the source
    // aggregate, which no threshold changes. So this check asks only "could this key, under
    // this source, carry this weight here?" - a contradiction is real, and the rows the hub
    // legitimately withheld simply are not examined. Completeness (a row the hub SHOULD
    // have served and did not) is NOT checkable without knowing the hub's MIN_STAKE and is
    // deliberately out of scope for this step.
    async verifyCapabilitySnapshotRow(row){
        if(!row) return { verdict: 'unknown', reason: 'no row' };
        let capability = row.capability == null ? '' : String(row.capability);
        // A chain that RESOLVES this capability from the mirror has no local stakes to
        // re-derive from; asking it would compare the mirror against itself.
        if(usesCapabilitySnapshot(this.config, capability))
            return { verdict: 'unknown', reason: 'this chain resolves ' + capability + ' from the mirror' };
        if(!this.isCapabilityConfigured(capability))
            return { verdict: 'unknown', reason: 'capability ' + capability + ' is not configured on this node' };
        let block = Number(row.snapshot_block);
        if(!Number.isFinite(block) || block < 0 || Math.floor(block) !== block)
            return { verdict: 'unknown', reason: 'unusable snapshot_block ' + String(row.snapshot_block).slice(0, 32) };
        // Availability fence. Below our own tip the stake history at `block` is whatever
        // we have parsed so far, which for an unreached block is nothing - refusing there
        // would reject every honest row served ahead of our sync.
        let tip = await this.getLatestBlockIndex();
        if(!(Number(tip) >= block))
            return { verdict: 'unknown', reason: 'local tip ' + tip + ' has not reached snapshot_block ' + block };
        let local;
        try {
            local = await this.getStakeWeightsByCapability(capability, block, '0');
        } catch(e) {
            return { verdict: 'unknown', reason: 'local stake re-derivation failed: ' + (e && e.message ? e.message : e) };
        }
        if(!Array.isArray(local))
            return { verdict: 'unknown', reason: 'local stake re-derivation returned no set' };
        // A truncated set is a PARTIAL set: a row missing from it may be missing only
        // because the cap cut it off, so no refusal can be drawn from this block.
        if(local.truncated)
            return { verdict: 'unknown', reason: 'local stake set truncated at block ' + block };
        let pubkey = String(row.signing_pubkey == null ? '' : row.signing_pubkey).toLowerCase();
        let source = String(row.source == null ? '' : row.source).toLowerCase();
        let match = null;
        for(let r of local){
            if(String(r.pubkey).toLowerCase() === pubkey &&
               String(r.source == null ? '' : r.source).toLowerCase() === source){ match = r; break; }
        }
        if(match === null)
            return { verdict: 'refused',
                     reason: 'no local stake makes ' + pubkey.slice(0, 16) + ' an effective signer for source ' +
                             source.slice(0, 24) + ' at block ' + block };
        if(normalizeStakeAmount(match.weight) !== normalizeStakeAmount(row.amount))
            return { verdict: 'refused',
                     reason: 'weight for ' + pubkey.slice(0, 16) + '/' + source.slice(0, 24) + ' at block ' + block +
                             ' is locally ' + String(match.weight).slice(0, 32) + ', hub served ' +
                             String(row.amount).slice(0, 32) };
        return { verdict: 'verified' };
    },

    // Whether `capability` is present in this indexer's STAKING.CAPABILITIES config.
    // Lets the hub-facing getcapabilityvalidators RPC distinguish a genuinely empty
    // validator set from a capability this indexer doesn't know about - the latter
    // signals config drift during a capability rollout and must surface as an error
    // rather than an empty set that looks identical to "no qualified validators".
    isCapabilityConfigured(capability){
        let caps = (this.config['STAKING'] && this.config['STAKING']['CAPABILITIES']) ? this.config['STAKING']['CAPABILITIES'] : {};
        return !!caps[capability];
    },

};
