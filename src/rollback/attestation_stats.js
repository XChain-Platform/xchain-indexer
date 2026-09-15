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
 * XChain Indexer - Rollback: attestation validator stats recompute
 *
 * Re-derive attest_validator_stats for the pairs the orphaned range touched, from the
 * surviving signatures and expired requests, with the same responsible set the live
 * expiry path computed. Installed onto Rollback.prototype by ./index.js; the
 * statements are in src/db/rollback/attestation_stats.js.
 *
 ********************************************************************/

'use strict';

const crypto    = require('crypto');
const swq       = require('../stake_weighted_quorum.js');
const srb       = require('../snapshot_reorg_buffer.js');
const pmsh      = require('../attestation/providerMinStakeHistory.js');
// The rules-aware capability filter the live attest.js path applies. The reorg
// recompute must subtract the SAME keys or it charges missed_count to validators
// the live expiry never held responsible.
const rgf       = require('../actions/attest/rollcall_gates_filter.js');
const statsSql  = require('../db/rollback/attestation_stats.js');

module.exports = {

    // Re-derive attest_validator_stats rows touched at or after block_index.
    //
    // The counters are written incrementally by the ATTEST handler
    // (db.incrementAttestationValidatorStat):
    //   - fulfilled_count: +1 per verified signature on a STATUS='ok' response.
    //   - missed_count:    +1 per responsible-set validator when a request expires.
    //   - slashed_count:   Phase 4 (no producer yet → always 0).
    // Because the table is keyed by (validator_pubkey, provider_id) and carries
    // only counters, it can't be rolled back by deleting a row range. Earlier
    // surviving increments live in the same row as the orphaned ones. So we drop
    // every row whose last touch is in the orphaned range and rebuild those exact
    // pairs from the surviving ledger. Runs inside the rollback transaction (after
    // the data/block deletes), so every query below sees only post-rollback rows.
    async recomputeAttestationValidatorStats(block_index){
        // Pairs whose counters may include orphaned increments: any row last
        // touched at/after block_index. Increments stamp last_updated_block with
        // the touch block and blocks advance monotonically, so a pair touched in
        // the orphaned range always has last_updated_block >= block_index here.
        let pairRows = await statsSql.readTouchedStatPairs(this.indexerDb, block_index);
        if(pairRows.length === 0)
            return;

        let affected = new Set();
        for(let r of pairRows)
            affected.add(String(r.validator_pubkey).toLowerCase() + '|' + String(r.provider_id));

        // Scope the two source scans below to the affected pairs' providers. Only
        // affected (pubkey, provider) pairs are re-inserted, and every source row
        // contributes counters solely under its own provider_id, so rows for other
        // providers are pure discarded work. Without this bound each reorg (including
        // routine depth-1 reorgs) pays a full-history scan + JSON parse of the whole
        // attests table inside the rollback transaction.
        let affectedProviders  = [...new Set(pairRows.map(r => String(r.provider_id)))];
        let providerPlaceholders = affectedProviders.map(() => '?').join(', ');

        // Drop the stale rows. Any pair whose entire history was orphaned simply
        // stays gone: a from-genesis replay would never have created its row.
        await statsSql.deleteTouchedStats(this.indexerDb, block_index);

        // Accumulate recomputed counters: key -> { pubkey, provider, fulfilled, missed, lastBlock }
        let stats  = new Map();
        let ensure = (pubkey, provider) => {
            let key = pubkey + '|' + provider;
            if(!stats.has(key))
                stats.set(key, { pubkey, provider, fulfilled: 0, missed: 0, lastBlock: 0 });
            return stats.get(key);
        };

        await this.countFulfilledSignatures(affectedProviders, providerPlaceholders, ensure);

        // Named `expired` here, and deliberately not the name the query below binds: the
        // repair-script drift guard finds that name's FIRST occurrence in this file and reads
        // the backtick SQL after it, so the first occurrence must be the query itself.
        let expired = await this.readExpiredRequests(block_index, affectedProviders, providerPlaceholders);

        await this.countExpiredMisses(expired, ensure);

        await this.writeRecomputedStats(stats, affected);
    },

    // fulfilled_count: one per verified signature contributed to a STATUS='ok'
    // response. Signatures now ride in the validator_signatures JSON column on
    // the surviving v1 response rows (already rolled back via the action_index
    // delete), so we aggregate them in JS rather than joining a child table.
    async countFulfilledSignatures(affectedProviders, providerPlaceholders, ensure){
        let okResponses = await statsSql.readOkResponses(this.indexerDb, affectedProviders, providerPlaceholders);
        for(let row of okResponses){
            let sigs = [];
            try { sigs = JSON.parse(row.validator_signatures) || []; }
            catch(_) { sigs = []; }
            let provider = String(row.provider_id);
            let block    = Number(row.block_index) || 0;
            for(let sig of sigs){
                if(!sig || !sig.pubkey) continue;
                let s = ensure(String(sig.pubkey).toLowerCase(), provider);
                s.fulfilled += 1;
                s.lastBlock = Math.max(s.lastBlock, block);
            }
        }
    },

    // missed_count: one per responsible-set validator each time a request
    // expired. There is no per-validator expiry row to count, as the live path
    // recomputes the responsible set deterministically and bumps each member.
    // We reproduce that over the surviving requests that WOULD have expired in
    // a replay to block_index-1: a request expires at deadline_block+1 (the
    // first sweep past its deadline), so it counts iff deadline_block+1 <=
    // block_index-1 (i.e. deadline_block < block_index-1) AND no *valid*
    // response survives for it. Only a *terminal* valid v1 response
    // (response_status IN ('ok','expired')) excludes a request; a retryable
    // round (timeout/no_quorum/provider_error) leaves it 'pending' so it
    // still expires and charges missed_count via the v2 sweep. We derive eligibility from
    // surviving rows, NOT request_status. The resolved_block reset above only
    // covers flips inside the orphaned range, and deriving from rows keeps this
    // recomputation independent of status bookkeeping either way.
    async readExpiredRequests(block_index, affectedProviders, providerPlaceholders){
        return await statsSql.readExpiredRequests(this.indexerDb, block_index, affectedProviders, providerPlaceholders);
    },

    // Cache the capability set per request block; this must consult the SAME
    // snapshot and stake-weighted branch the live expiry path used, or missed_count
    // re-derives wrong after a reorg. At/after STAKE_WEIGHTED_QUORUM activation the
    // live path dedups multi-key sources to one slot, so the unweighted validator
    // list would credit an excluded key and drop a real one.
    async countExpiredMisses(expiredReqs, ensure){
        let validatorsByBlock = new Map();
        for(let req of expiredReqs){
            // ATT-RECOMP-1: prefer the responsible set pinned as-of the request block at v0
            // creation (attests.responsible_set_json). It captures the historical stake amounts
            // BEFORE any later surviving slash, so the recompute reproduces the true responsible
            // set instead of re-deriving it against the CURRENT mutable stakes.amount (which a
            // surviving slash has already reduced → a divergent set → wrong missed_count). Legacy
            // rows created before the column existed carry NULL and fall back to the live
            // re-derive below (the pre-fix behaviour, with the known as-of-amount caveat).
            let responsible = null;
            if(req.responsible_set_json){
                try {
                    let parsed = JSON.parse(req.responsible_set_json);
                    if(Array.isArray(parsed))
                        responsible = parsed.map(p => String(p).toLowerCase());
                } catch(_) { responsible = null; }
            }
            if(responsible === null){
                let reqBlock = Number(req.block_index);
                let cached   = validatorsByBlock.get(reqBlock);
                if(cached === undefined){
                    cached = await this.capabilitySnapshotForBlock(reqBlock);
                    validatorsByBlock.set(reqBlock, cached);
                }
                // The provider floor is a PER-REQUEST bar, so it cannot ride the
                // per-block validator cache above: two requests at the same block against
                // different providers filter that one snapshot differently. Resolve it here
                // and let responsibleSet apply it, keeping the cache provider-agnostic.
                responsible = this.responsibleSet(String(req.request_id), cached.validators, Number(req.redundancy), cached.weighted,
                                                   this.providerRegistry.getMinStake(String(req.provider_id), Number(req.block_index), this.config['NETWORK']));
            }
            let provider    = String(req.provider_id);
            let expiryBlock  = Number(req.deadline_block) + 1;
            for(let pubkey of responsible){
                let s = ensure(pubkey, provider);
                s.missed   += 1;
                s.lastBlock = Math.max(s.lastBlock, expiryBlock);
            }
        }
    },

    // Mirroring actions/attest.js computeResponsibleSet (#3233): the SWQ
    // gate is BTC-anchored, and `reqBlock` is the request's LOCAL height, so
    // off BTC it is already past the 961000 anchor and would resolve
    // `weighted` TRUE out of band. This function's header requires
    // byte-for-byte agreement with attest.js "or reorg-recomputed
    // missed_count diverges from the live expiry path", so the two must
    // short-circuit on the SAME condition, not just reach the same empty
    // answer by different routes. Capability staking is BTC-only, so a
    // non-BTC indexer has no responsible set to recompute.
    //
    // Two DIFFERENT heights come off `reqBlock`, exactly as in attest.js
    // computeResponsibleSet: the SWQ flag-day is evaluated on the DECLARED
    // height verbatim (moving a cutover block by the reorg buffer is its own
    // fork), while the capability SET is resolved at the declared height
    // BURIED by CANONICAL_REORG_BUFFER, which is where the hub's
    // CapabilitySnapshot resolved it. Resolving here at the raw height picks a
    // different responsible set than the live expiry path whenever a
    // validator's capability stake activates or deactivates inside
    // (declared - 6, declared], which is precisely the byte-for-byte
    // agreement this function's header demands; the recompute then charges
    // missed_count to a validator the live path never held responsible.
    // Below the burial flag-day buriedSnapshotBlock returns the declared
    // height unchanged, so mainnet replay is byte-identical.
    async capabilitySnapshotForBlock(reqBlock){
        let cached;
        let cached_weighted = false;
        let vs = [];
        if(this.config['COIN'] === 'BTC'){
            cached_weighted = swq.isStakeWeightedQuorumActive(reqBlock, this.config['NETWORK']);
            let resolveBlock = srb.buriedSnapshotBlock(reqBlock, this.config['NETWORK']);
            vs = cached_weighted
                ? await this.indexerDb.getStakeWeightsByCapability('attestation', resolveBlock)
                : await this.indexerDb.getValidatorsByCapability('attestation', resolveBlock);
            // RULES-AWARE FILTER (spec §7.4, D59), applied at the same point
            // the live path applies it: on the raw capability snapshot,
            // before responsibleSet ranks or floors anything. It is a pure
            // function of (reqBlock, network), never of the provider, so it
            // rides this per-block cache exactly as the snapshot read does,
            // and responsibleSet stays the byte-for-byte ranking twin of
            // attest.js.computeResponsibleSet with no filter of its own.
            vs = await rgf.filterByRolledGates({
                db: this.indexerDb, validators: vs || [], requestBlock: reqBlock,
                network: this.config['NETWORK']
            });
        }
        cached = { weighted: cached_weighted, validators: vs || [] };
        return cached;
    },

    // Re-insert recomputed rows for the pairs we dropped (others are already
    // correct). slashed_count/quality_score re-derive to 0 (Phase 4 unshipped).
    async writeRecomputedStats(stats, affected){
        for(let s of stats.values()){
            if(!affected.has(s.pubkey + '|' + s.provider))
                continue;
            if(s.fulfilled === 0 && s.missed === 0)
                continue;
            await statsSql.writeRecomputedStat(this.indexerDb, s);
        }
    },

    // Deterministic responsible validator set. MUST mirror attest.js
    // computeResponsibleSet byte-for-byte (sort by SHA256(request_id || pubkey),
    // when stake-weighted dedup to one slot per source keeping the lowest hash,
    // then take the top REDUNDANCY) or reorg-recomputed missed_count diverges from
    // the live expiry path. `validators` are the raw capability rows ({pubkey, source},
    // plus `weight` when weighted); `weighted` is swq.isStakeWeightedQuorumActive for
    // the request block. `minStake` is the request provider's block-anchored
    // min_stake_xchain floor at the request block, applied on the weighted path
    // only and BEFORE the ranking, exactly as attest.js.providerFloorFilter does; null
    // fails the recompute closed to an empty set the same way the live path does, so a
    // reorg cannot charge missed_count to validators the live expiry never held
    // responsible.
    responsibleSet(requestId, validators, redundancy, weighted, minStake){
        if(!validators || validators.length === 0)
            return [];
        if(weighted){
            if(minStake === null || minStake === undefined)
                return [];
            validators = validators.filter(v => pmsh.meetsProviderFloor(v && v.weight, minStake));
            if(validators.length === 0)
                return [];
        }
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
        return withHash.slice(0, Math.max(1, Number(redundancy) || 1)).map(v => v.pubkey);
    },

};
