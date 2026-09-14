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
 * XChain Indexer - ATTEST handler part
 *
 * The deterministic responsible-set derivation and the provider stake floor it applies.
 *
 * Installed onto Attest.prototype by actions/attest/index.js, so call sites stay
 * this.<method>().
 *
 ********************************************************************/

'use strict';

const crypto  = require('crypto');
const swq     = require('../../stake_weighted_quorum.js');
const srb     = require('../../snapshot_reorg_buffer.js');
// The rules-aware capability filter: drops a validator whose last rolled ROLLCALL
// gate list does not cover the gates active at the request block. Inert on every
// network whose ROLLCALL_GATES_ACTIVATION is null, where it never queries.
const rgf     = require('./rollcall_gates_filter.js');
const pmsh    = require('../../attestation/providerMinStakeHistory.js');
const { getLogger } = require('../../observability/index.js');

module.exports = {
    // Compute the responsible validator set for a given request (same deterministic rule
    // the hub uses (xchain-hub AttestationRound): sort capability validators by
    // SHA256(request_id || pubkey), take top REDUNDANCY.
    // STAKE_WEIGHTED_QUORUM: at/above activation, dedupe the selection by staking
    // source (one slot per source, keep each source's lowest-hash key) using the
    // source-keyed set; below activation, the legacy per-key selection. The
    // within-subset quorum stays count-based. CONSENSUS-CRITICAL: must match the
    // hub's AttestationRound._computeResponsibleSet byte-for-byte or validation forks.
    //
    // PROVIDER STAKE FLOOR: on the SAME weighted path, and only there, drop
    // staking sources whose aggregate weight is below the request provider's
    // block-anchored min_stake_xchain before selecting. `providerId` is therefore
    // REQUIRED at/above STAKE_WEIGHTED_QUORUM; omitting it fails closed to an empty
    // set. See providerFloorFilter for why the floor rides the SWQ gate rather than
    // a new flag day, and providerMinStakeHistory.js for where the value comes from.
    // `widen` is the liveness ladder's extra slot count (attest_responsible_widening_activation.js),
    // supplied ONLY by the two sites that judge a RESPONSE (the v1 verify filter and the
    // fulfilled fee split) and derived there from the response's own height. Every other
    // caller passes nothing and gets 0, which is this routine byte-for-byte unchanged:
    // v0 admission and the persisted RESPONSIBLE_SET_JSON record the ASSIGNMENT, and the
    // v2 expiry missed_count charge faults the ASSIGNED set, so neither may move. A
    // validator pulled in late by the ladder is permitted to earn, never charged for a
    // request that was already failing before it was eligible.
    //
    // `stats` is an OPTIONAL out-parameter, mutated by the rules-aware gate filter
    // below with { dropped, epochHeight, closeBlock, needed }. It exists so the v0
    // admission caller can tell "the snapshot was always this small" from "the rules
    // filter shrank it", which are two different rejection literals. The return
    // shape is untouched, so every existing caller passes nothing and is unaffected.
    async computeResponsibleSet(requestId, redundancy, blockIndex, providerId, widen, stats){
        // The SWQ gate is BTC-ANCHORED, so only evaluate it where `blockIndex`
        // actually is a BTC height.
        //
        // isStakeWeightedQuorumActive() compares its argument against 961000, a BTC
        // height (~2026-08-04). `blockIndex` here is the ATTEST action's LOCAL height on
        // whatever chain this indexer runs, and ATTEST is registered on all three. LTC
        // and DOGE sit at ~3.16M and ~6.3M local, so `blockIndex >= 961000` is ALREADY
        // true there: a non-BTC indexer resolved `weighted` TRUE out of band, long
        // before the anchor, while the hub resolved it FALSE from a real BTC height
        // (xchain-hub AttestationRound polls the BTC indexer, so its block_index is
        // genuinely BTC). This function's own header requires byte-for-byte agreement
        // with that hub routine "or validation forks", and off BTC the two disagreed.
        //
        // Today the disagreement is LATENT, not exploitable: capability staking is
        // BTC-only and LTC/DOGE declare no STAKING.CAPABILITIES at all, so both the
        // weighted and unweighted lookups fall through to `if(!capConfig) return []`
        // and the responsible set is empty either way. It becomes a live fork the
        // moment `attestation` is configured off BTC, or the off-BTC redirect in
        // getStakeWeightsByCapability / getValidatorsByCapability (today scoped to
        // cross_chain and oracle_publish) is widened to cover it.
        //
        // So the fix is the plane, not the symptom: a non-BTC indexer has no
        // responsible set to compute and returns empty EXPLICITLY, without consulting
        // a gate it cannot evaluate correctly. Behaviour is unchanged at HEAD, which is
        // what makes it safe to ship ungated; the rebase replays it identically.
        if(this.config['COIN'] !== 'BTC')
            return [];
        return await this.resolveResponsibleSet(requestId, redundancy, blockIndex, providerId, widen, stats);
    },

    // The set itself, on the plane the guard above established: the capability read, the
    // rules-aware filter, the provider floor and the deterministic ranking.
    async resolveResponsibleSet(requestId, redundancy, blockIndex, providerId, widen, stats){
        // On BTC, `blockIndex` IS a BTC height, so the gate is on its intended plane
        // and flips at the anchor in lockstep with the hub.
        //
        // `blockIndex` is the DECLARED height (the request's block). Two different things
        // come off it, and the difference matters (see parseResponse):
        //   - the STAKE_WEIGHTED_QUORUM flag-day is evaluated on the declared height,
        //     verbatim, because moving a cutover block by the reorg buffer is its own fork;
        //   - the set is RESOLVED at the declared height BURIED by CANONICAL_REORG_BUFFER,
        //     which is where the hub's CapabilitySnapshot resolved it (AttestationRound
        //     hands it the raw request.block_index and it subtracts the buffer). Resolving
        //     at the raw height selects a different responsible set than the hub whenever a
        //     validator's stake activates or deactivates inside (declared - 6, declared],
        //     which is exactly the byte-for-byte agreement this routine's header demands.
        // Burying HERE rather than at the call sites is deliberate: five paths compute this
        // request's responsible set (v0 admission, the persisted RESPONSIBLE_SET_JSON, the
        // v1 verify filter, the v2 expiry missed_count charge, the fulfilled fee split) and
        // they must resolve ONE set or the stat columns and the fee split desynchronize.
        // Flag-day gated, so below the gate this is the declared height unchanged.
        let weighted = swq.isStakeWeightedQuorumActive(blockIndex, this.config['NETWORK']);
        let resolveBlock = srb.buriedSnapshotBlock(blockIndex, this.config['NETWORK']);
        let validators = weighted
            ? await this.indexerDb.getStakeWeightsByCapability('attestation', resolveBlock)
            : await this.indexerDb.getValidatorsByCapability('attestation', resolveBlock);
        if(!validators || validators.length === 0) return [];
        // RULES-AWARE FILTER. Applied ONCE, here: after the capability
        // read and before both the provider floor and the hash ranking, so a slot the
        // filter frees is filled by the next qualifying validator instead of leaving a
        // hole in the draw. The hub receives an already-filtered set from
        // getcapabilityvalidators and rollback.js filters the same snapshot at the same
        // block, so all three derive one set. Inert (and query-free) wherever
        // ROLLCALL_GATES_ACTIVATION is null, which is mainnet and testnet today.
        validators = await rgf.filterByRolledGates({
            db: this.indexerDb, validators, requestBlock: blockIndex,
            network: this.config['NETWORK'], stats
        });
        if(!validators || validators.length === 0) return [];
        // Provider floor, weighted path only. Applied BEFORE the hash ranking so the
        // slot the filter frees is filled by the next qualifying validator, exactly as
        // the hub does; every key of a source carries the source's aggregate weight, so
        // this removes whole sources and the source-dedupe below is unaffected by it.
        if(weighted){
            validators = this.providerFloorFilter(validators, providerId, blockIndex);
            if(validators.length === 0) return [];
        }

        return this.rankResponsibleSet(validators, requestId, redundancy, weighted, widen);
    },

    // The deterministic draw: rank by SHA256(request_id || pubkey), dedupe by staking
    // source on the weighted path, and take REDUNDANCY slots plus the ladder's extras.
    rankResponsibleSet(validators, requestId, redundancy, weighted, widen){
        let withHash = validators.map(v => {
            let pk = String(v.pubkey).toLowerCase();
            let h  = crypto.createHash('sha256').update(String(requestId), 'utf8').update(pk, 'utf8').digest('hex');
            return { pubkey: pk, source: (v.source != null ? String(v.source) : null), hash: h };
        });
        withHash.sort((a, b) => (a.hash < b.hash) ? -1 : (a.hash > b.hash ? 1 : 0));
        if(weighted){
            let seen = new Set();
            withHash = withHash.filter(v => {
                if(v.source === null) return true;
                if(seen.has(v.source)) return false;
                seen.add(v.source);
                return true;
            });
        }
        let extra = Number(widen);
        if(!Number.isFinite(extra) || extra < 0) extra = 0;
        return withHash.slice(0, Math.max(1, Number(redundancy) || 1) + extra).map(v => v.pubkey);
    },

    // Drop weighted-snapshot rows whose staking source does not clear the provider's
    // block-anchored min_stake_xchain floor at `blockIndex`. Returns [] when the floor
    // cannot be resolved (unknown/absent provider id, or an ATTESTATION.PROVIDERS
    // overlay entry with no floor), which fails the whole request closed.
    //
    // WHY THE SWQ GATE CARRIES THIS. The floor needs per-validator stake, and only the
    // weighted snapshot ({pubkey, source, weight}) carries the SOURCE-AGGREGATE amount
    // the floor is defined against; the unweighted rows are per-key and would price a
    // delegating source's stake once per key. Riding STAKE_WEIGHTED_QUORUM (mainnet
    // 961000, testnet/regtest 0) means the enforcement flips on an already-armed,
    // fleet-coordinated anchor, so no new flag-day height is minted and the hub, this
    // indexer, rollback's recompute and AttestationPublisher all start filtering on the
    // same block. Below the gate the capability threshold remains the only bar, which
    // is the pre-flag behaviour, so replay of historical blocks is bit-identical.
    //
    // The floor resolves at the DECLARED block (the raw `blockIndex`), not the buried
    // one: a governance activation height is a cutover, and burying a cutover is its own
    // fork, the same reasoning the SWQ gate itself is evaluated on the declared height.
    providerFloorFilter(validators, providerId, blockIndex){
        let pid = (providerId === null || providerId === undefined) ? '' : String(providerId);
        let floor = pid ? this.providerRegistry.getMinStake(pid, blockIndex, this.config['NETWORK']) : null;
        if(floor === null){
            // Loud, because on a healthy federation this never happens: v0/v3 admission
            // already rejects an unknown PROVIDER_ID, so reaching here means either a
            // caller forgot the provider id or an operator overlay stripped the floor.
            getLogger().warn('Attestation responsible set: no provider stake floor for "' + pid +
                         '" at block ' + blockIndex + '; failing closed (empty responsible set)');
            return [];
        }
        return validators.filter(v => pmsh.meetsProviderFloor(v && v.weight, floor));
    }
};
