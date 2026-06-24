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
 * XChain Platform Action - PRICE
 *
 * Two versions:
 *   v0: Validator COIN/FIAT snapshot (PBFT-signed by price-capable validators)
 *       Format: PRICE|0|ROUND|TIMESTAMP|BTC_BLOCK_HEIGHT|PAIR_COUNT|PAIR_ID|PAIR_PRICE|...|SIG_COUNT|PUBKEY|SIG|...
 *   v1: User TOKEN/FIAT oracle price (no staking required)
 *       Format: PRICE|1|COIN|TICK|FIAT|VALUE|FEE|MEMO
 *
 * v0 validation:
 *   1. Each PUBKEY must have an active price capability stake
 *   2. Each Ed25519 signature must verify against the canonical payload
 *   3. SIG_COUNT must meet PBFT quorum: >= max(2 * floor((price_count - 1) / 3) + 1, ceil((price_count + 1) / 2))
 *
 * After validation, the indexer pushes the round to xchain-hub which
 * deduplicates by round_number into the unified price_snapshots table.
 *
 ********************************************************************/

const ed25519 = require('../ed25519.js');
const swq     = require('../stake_weighted_quorum.js');

class Price {

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        // Hub client for pushing validated PRICE data to xchain-hub
        this.hubClient = action.hubClient || null;

        // Define list of known FORMATS
        this.formats = {};
        // v0 has variable-length params; the format string is informational
        this.formats[0] = 'VERSION|ROUND|TIMESTAMP|PAIR_COUNT|...|SIG_COUNT|...';
        this.formats[1] = 'VERSION|COIN|TICK|FIAT|VALUE|FEE|MEMO';
    }

    async parse(params, data, error){
        let format = data['FORMAT'];
        if(!error && (format === null || format === undefined || this.formats[format] === undefined))
            error = 'invalid: VERSION (unknown)';

        if(format === 0)
            return this._parseV0(params, data, error);
        if(format === 1)
            return this._parseV1(params, data, error);

        // Unknown format: record as invalid
        data['VERSION']           = format;
        data['VALIDATION_STATUS'] = 'invalid';
        data['STATUS']            = error || 'invalid: VERSION (unknown)';
        await this.indexerDb.createPrice(data);
        await this.mapper.createMappings(data);
    }

    // Parse PRICE v0: validator COIN/FIAT snapshot
    async _parseV0(params, data, error){
        data['VERSION'] = 0;

        // Manually parse variable-length format:
        //   params[0] = '0' (version)
        //   params[1] = ROUND
        //   params[2] = TIMESTAMP
        //   params[3] = BTC_BLOCK_HEIGHT (the round's BTC anchor; in the signed payload)
        //   params[4] = PAIR_COUNT (N)
        //   params[5..5+2N-1] = N pairs of (PAIR_ID, PAIR_PRICE)
        //   params[5+2N] = SIG_COUNT (M)
        //   params[5+2N+1..5+2N+2M] = M pairs of (PUBKEY, SIG)
        let round, timestamp, btcBlockHeight, pairCount, pairs = [], sigCount, sigs = [];
        try {
            round          = parseInt(params[1]);
            timestamp      = parseInt(params[2]);
            btcBlockHeight = parseInt(params[3]);
            pairCount      = parseInt(params[4]);
            if(!Number.isFinite(round) || round < 0)
                throw new Error('invalid ROUND');
            if(!Number.isFinite(timestamp) || timestamp < 0)
                throw new Error('invalid TIMESTAMP');
            if(!Number.isFinite(btcBlockHeight) || btcBlockHeight < 0)
                throw new Error('invalid BTC_BLOCK_HEIGHT');
            if(!Number.isFinite(pairCount) || pairCount < 1)
                throw new Error('invalid PAIR_COUNT');

            let idx = 5;
            for(let i = 0; i < pairCount; i++){
                let pair  = params[idx++];
                let price = params[idx++];
                if(!pair || !price) throw new Error('missing pair data at index ' + i);
                if(!/^[A-Z]{3,5}\/[A-Z]{3,5}$/.test(pair)) throw new Error('invalid pair format: ' + pair);
                if(!/^[0-9]+(\.[0-9]+)?$/.test(price)) throw new Error('invalid price format: ' + price);
                pairs.push({ pair: pair, price: price });
            }

            sigCount = parseInt(params[idx++]);
            if(!Number.isFinite(sigCount) || sigCount < 1)
                throw new Error('invalid SIG_COUNT');

            for(let i = 0; i < sigCount; i++){
                let pubkey = params[idx++];
                let sig    = params[idx++];
                if(!pubkey || !sig) throw new Error('missing sig data at index ' + i);
                if(!/^[0-9a-fA-F]{64}$/.test(pubkey)) throw new Error('invalid pubkey format: ' + pubkey);
                if(!/^[0-9a-fA-F]{128}$/.test(sig))   throw new Error('invalid sig format');
                sigs.push({ pubkey: pubkey.toLowerCase(), sig: sig.toLowerCase() });
            }
        } catch(e) {
            if(!error) error = 'invalid: ' + e.message;
        }

        data['ROUND']            = round;
        data['TIMESTAMP']        = timestamp;
        data['BTC_BLOCK_HEIGHT'] = btcBlockHeight;
        data['PAIR_COUNT']       = pairCount;
        data['PAIRS_JSON'] = pairs.length > 0 ? JSON.stringify(pairs) : null;
        data['SIG_COUNT']  = sigCount;
        data['SIGS_JSON']  = sigs.length  > 0 ? JSON.stringify(sigs)  : null;

        // Verify Ed25519 signatures against the canonical payload
        // Each pubkey must have an active price capability stake at the BLOCK_INDEX of this PRICE tx
        let qualifiedSigners = [];
        if(!error){
            let payload    = ed25519.buildPriceV0Payload(round, timestamp, pairs, this.config['NETWORK'], btcBlockHeight);
            let validSigs  = 0;
            let seenPubkey = new Set();
            for(let s of sigs){
                if(seenPubkey.has(s.pubkey)){
                    // Duplicate pubkey signature: count only once
                    continue;
                }
                seenPubkey.add(s.pubkey);

                // Verify the validator's stake qualifies for the `price` capability at this block
                if(!await this.indexerDb.hasCapability(s.pubkey, 'price', data['BLOCK_INDEX'])){
                    continue;
                }

                // Verify the signature
                if(!ed25519.verify(payload, s.sig, s.pubkey))
                    continue;

                validSigs++;
                qualifiedSigners.push(s.pubkey);
            }

            // STAKE_WEIGHTED_QUORUM: at/above the activation snapshot_block, finalize
            // on the summed STAKE of the qualified signers (>2/3 of S, source-deduped)
            // rather than their COUNT. Gated on this PRICE's BLOCK_INDEX (a BTC height,
            // price is BTC-anchored) + the indexer's network, so the hub and every
            // indexer flip on the same anchor. Below activation: byte-for-byte the
            // legacy count rule. `qualifiedSigners` is the verified, capability-qualified
            // signer set (the same input both modes tally).
            let weighted = swq.isStakeWeightedQuorumActive(data['BLOCK_INDEX'], this.config['NETWORK']);
            if(weighted){
                let validators = await this.indexerDb.getStakeWeightsByCapability('price', data['BLOCK_INDEX']);
                if(!swq.meetsStakeThreshold(validators, qualifiedSigners))
                    error = 'invalid: insufficient signer stake';
            } else {
                // Compute PBFT quorum over validators with `price` capability,
                // floored at a simple majority: max(2 * floor((N - 1) / 3) + 1, ceil((N + 1) / 2))
                let priceValidatorCount = await this.indexerDb.getActiveCapabilityCount('price', data['BLOCK_INDEX']);
                let quorum = (priceValidatorCount <= 1) ? 1 : Math.max(2 * Math.floor((priceValidatorCount - 1) / 3) + 1, Math.ceil((priceValidatorCount + 1) / 2));

                if(validSigs < quorum)
                    error = 'invalid: insufficient PBFT quorum (' + validSigs + '/' + quorum + ')';
            }
        }

        // Determine validation status
        let validation = error ? 'invalid' : 'valid';
        data['VALIDATION_STATUS'] = validation;
        data['STATUS'] = error || 'valid';

        // Print status message
        console.log("\t PRICE v0 : round=" + round + ' pairs=' + pairCount + ' sigs=' + sigCount + ' : ' + data['STATUS']);

        // Create record in prices table
        await this.indexerDb.createPrice(data);

        // Derive oracle_round rewards from the on-chain signer set (CONSENSUS).
        // The verified, capability-qualified signature list above IS the round's
        // signed participation record, so the reward split is a deterministic
        // function of this action, replayable on any reindex or ANCHOR
        // full-parse recovery, unlike the retired hub push (which credited the
        // in-memory PBFT prepare set and could never be re-derived offline).
        // Consequences: rewards follow the published signer set, and a round
        // that finalizes but never lands a PRICE action earns nothing. A
        // duplicate PRICE for an already-rewarded round upserts the same rows
        // (same round_reference → same split), so failover double-publishes
        // stay idempotent.
        if(!error && data['COIN'] === 'BTC' && qualifiedSigners.length > 0){
            let staking     = this.config['STAKING'] || {};
            let rewardTotal = staking['ORACLE_REWARD_PER_ROUND'] || '10.00000000';
            let fnShare     = String((this.config['FULLNODE'] || {})['REWARD_SHARE'] || '0');

            // Two-tranche split (NODEPROOF / verified full-node tier). When
            // FULLNODE.REWARD_SHARE > 0 the round budget is split into a BASE
            // tranche (every qualified signer) and a FULL-NODE tranche (only
            // signers that are VERIFIED full nodes this block, deduped per staking
            // source; one operator = one share). When the share is 0, or no
            // verified full node signed this round, the whole budget pays the
            // base set; with share == 0 that base set keeps the legacy
            // 'oracle_round' reward_type so existing-chain replay stays
            // byte-identical. CONSENSUS: REWARD_SHARE is a fleet-wide consensus
            // parameter (like ORACLE_REWARD_PER_ROUND) and MUST match across every
            // indexer and be deployed atomically. (See NODEPROOF.md.)
            let activeRegime = this.util.bcgt(fnShare, '0');

            // Resolve the full-node REWARD sources among THIS round's signers. Earning
            // the tranche is participation-rate based (a carrot, not a stick; there is
            // NO slashing for non-participation): a staking source qualifies only if,
            // over the trailing REWARD_PASS_WINDOW_BLOCKS, it answered at least
            // MIN_PASS_RATE_BPS of the challenge epochs that actually produced a verdict
            // (db.getFullNodeParticipation). Forgiving of a missed check or two. The
            // bonus is credited once per source, to the lexicographically smallest of
            // its passing pubkeys that ALSO signed this round and still holds the
            // full_node capability. Integer gate: passed*10000 >= bps*total, no floats.
            let fnSources = [];   // [{ source_id, pubkey }]
            if(activeRegime){
                let minRateBps = parseInt((this.config['FULLNODE'] || {})['MIN_PASS_RATE_BPS']);
                if(!Number.isFinite(minRateBps) || minRateBps < 0) minRateBps = 0;
                let part = await this.indexerDb.getFullNodeParticipation(data['BLOCK_INDEX']);
                if(part.totalEpochs > 0){
                    let signed = new Set(qualifiedSigners.map(pk => String(pk).toLowerCase()));
                    for(let src of part.sources){
                        // Pass-rate gate: passed_epochs / totalEpochs >= minRateBps/10000.
                        if(src.passed_epochs * 10000 < minRateBps * part.totalEpochs) continue;
                        // Representative = lex-smallest passing pubkey that signed this
                        // round and still holds the full_node capability at this block.
                        let rep = null;
                        for(let pk of Array.from(src.pubkeys).sort()){
                            if(!signed.has(pk)) continue;
                            if(!await this.indexerDb.hasCapability(pk, 'full_node', data['BLOCK_INDEX'])) continue;
                            rep = pk;
                            break;
                        }
                        if(rep) fnSources.push({ source_id: String(src.source_id), pubkey: rep });
                    }
                }
            }

            // Carve the full-node tranche (floored to GAS decimals). Rolls into the
            // base tranche when no verified full node signed this round.
            let fullNodeTotal = (activeRegime && fnSources.length > 0)
                ? this.util.bcmulfloor(this.util.bcmul(rewardTotal, fnShare, 18), '1', 8)
                : '0';
            let baseTotal = this.util.bcsub(rewardTotal, fullNodeTotal, 8);

            // Base tranche: equal split across ALL qualified signers.
            let baseType = activeRegime ? 'oracle_base' : 'oracle_round';
            let perBase  = this.util.bcmulfloor(
                this.util.bcdiv(baseTotal, String(qualifiedSigners.length), 18), '1', 8
            );
            if(this.util.bcgt(perBase, '0')){
                for(let pk of qualifiedSigners){
                    await this.indexerDb.createValidatorReward(
                        pk, round, baseType, perBase, data['BLOCK_INDEX'], true
                    );
                }
            }

            // Full-node tranche: equal split across the distinct verified sources.
            if(this.util.bcgt(fullNodeTotal, '0') && fnSources.length > 0){
                let perFull = this.util.bcmulfloor(
                    this.util.bcdiv(fullNodeTotal, String(fnSources.length), 18), '1', 8
                );
                if(this.util.bcgt(perFull, '0')){
                    for(let s of fnSources){
                        await this.indexerDb.createValidatorReward(
                            s.pubkey, round, 'oracle_full_node', perFull, data['BLOCK_INDEX'], true
                        );
                    }
                }
            }
        }

        // Push validated round to hub for cross-chain aggregation. The push is
        // fire-and-forget so block processing never blocks on hub latency, but a
        // failure no longer drops the round: it is parked in pending_hub_pushes
        // for the HubPushQueue poller to retry with backoff. The hub dedupes by
        // round_number, so a later replay it already has is a safe no-op.
        if(!error && this.hubClient){
            // Source-chain reorg fence (item 5308): stamp the current push generation so the hub
            // row carries it. A later deferred retraction (which carries the rollback's pre-bump
            // generation) then deletes only stale rows, not this one if it is re-published post-reorg.
            let pushGeneration = await this.indexerDb.getPushGeneration(data['COIN']);
            let payload = {
                source_chain:     data['COIN'],
                round:            round,
                timestamp:        timestamp,
                btc_block_height: btcBlockHeight,
                pairs:            pairs,
                sigs:             sigs,
                action_index:     data['ACTION_INDEX'],
                block_index:      data['BLOCK_INDEX'],
                push_generation:  pushGeneration
            };
            this.hubClient.pushPriceRound(payload).catch(err => {
                console.warn('PRICE v0: hub push failed, queued for retry:', err.message);
                this.indexerDb.enqueueHubPush('price_round', payload)
                    .catch(e => console.error('PRICE v0: failed to enqueue hub push for retry:', e.message));
            });
        }

        // Create action mappings
        await this.mapper.createMappings(data);
    }

    // Parse PRICE v1: user TOKEN/FIAT oracle price.
    // Records the action and pushes to hub for cross-chain aggregation.
    // The 24-hour lock window is not yet enforced.
    async _parseV1(params, data, error){
        data['VERSION'] = 1;

        // Extract fields
        data['V1_COIN']  = params[1];
        data['V1_TICK']  = params[2];
        data['V1_FIAT']  = params[3];
        data['V1_VALUE'] = params[4];
        data['V1_FEE']   = params[5];
        data['MEMO']     = params[6];

        // Validate COIN
        if(!error && (!data['V1_COIN'] || !this.config['COINS'].includes(data['V1_COIN'])))
            error = 'invalid: COIN (unsupported)';

        // Validate TICK
        if(!error && (!data['V1_TICK'] || data['V1_TICK'].length === 0 || data['V1_TICK'].length > this.config['MAX_TICK_LENGTH']))
            error = 'invalid: TICK (format)';

        // Validate FIAT
        if(!error && (!data['V1_FIAT'] || this.util.isNull(this.config['FIATS'][data['V1_FIAT']])))
            error = 'invalid: FIAT (unsupported)';

        // Validate VALUE (positive 8-decimal string)
        if(!error && (!data['V1_VALUE'] || !/^[0-9]+(\.[0-9]{1,8})?$/.test(data['V1_VALUE']) || parseFloat(data['V1_VALUE']) <= 0))
            error = 'invalid: VALUE (format)';

        // Validate FEE (decimal between 0 and 1, optional)
        if(!error && data['V1_FEE'] && (!/^[0-9]+(\.[0-9]+)?$/.test(data['V1_FEE']) || parseFloat(data['V1_FEE']) < 0 || parseFloat(data['V1_FEE']) > 1))
            error = 'invalid: FEE (format)';

        // Determine validation status
        let validation = error ? 'invalid' : 'valid';
        data['VALIDATION_STATUS'] = validation;
        data['STATUS'] = error || 'valid';

        // Print status message
        console.log("\t PRICE v1 : " + data['V1_COIN'] + '/' + data['V1_TICK'] + '/' + data['V1_FIAT'] + ' = ' + data['V1_VALUE'] + ' : ' + data['STATUS']);

        // Create record in prices table
        await this.indexerDb.createPrice(data);

        // Push to hub for cross-chain aggregation (Phase 4 implements full lock
        // window logic). Fire-and-forget so block processing never blocks on hub
        // latency, but a failure no longer drops the price: it is parked in
        // pending_hub_pushes for the HubPushQueue poller to retry with backoff.
        // The hub dedupes by (source_address, source_chain, action_index), so a
        // later replay it already has is a safe no-op.
        if(!error && this.hubClient){
            // Source-chain reorg fence (item 5308): see _parseV0 above.
            let pushGeneration = await this.indexerDb.getPushGeneration(data['COIN']);
            let payload = {
                source_chain:   data['COIN'],
                source_address: data['SOURCE'],
                coin:           data['V1_COIN'],
                tick:           data['V1_TICK'],
                fiat:           data['V1_FIAT'],
                value:          data['V1_VALUE'],
                fee:            data['V1_FEE'],
                memo:           data['MEMO'],
                block_time:     data['BLOCK_TIME'],
                action_index:   data['ACTION_INDEX'],
                push_generation: pushGeneration
            };
            this.hubClient.pushOraclePrice(payload).catch(err => {
                console.warn('PRICE v1: hub push failed, queued for retry:', err.message);
                this.indexerDb.enqueueHubPush('oracle_price', payload)
                    .catch(e => console.error('PRICE v1: failed to enqueue hub push for retry:', e.message));
            });
        }

        // Create action mappings
        await this.mapper.createMappings(data);
    }
}

module.exports = Price;
