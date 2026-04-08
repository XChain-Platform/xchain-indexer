/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
 *
 **********************************************************************
 *
 * XChain Platform Action - PRICE
 *
 * Two versions:
 *   v0: Validator COIN/FIAT snapshot (PBFT-signed by Tier 1 validators)
 *       Format: PRICE|0|ROUND|TIMESTAMP|PAIR_COUNT|PAIR_ID|PAIR_PRICE|...|SIG_COUNT|PUBKEY|SIG|...
 *   v1: User TOKEN/FIAT oracle price (no staking required)
 *       Format: PRICE|1|COIN|TICK|FIAT|VALUE|FEE|MEMO
 *
 * v0 validation:
 *   1. Each PUBKEY must have an active Tier 1 stake
 *   2. Each Ed25519 signature must verify against the canonical payload
 *   3. SIG_COUNT must meet PBFT quorum: >= 2 * floor((tier1_count - 1) / 3) + 1
 *
 * After validation, the indexer pushes the round to xchain-hub which
 * deduplicates by round_number into the unified price_snapshots table.
 *
 ********************************************************************/

const ed25519 = require('../ed25519.js');

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

        // Unknown format — record as invalid
        data['VERSION']           = format;
        data['VALIDATION_STATUS'] = 'invalid';
        data['STATUS']            = error || 'invalid: VERSION (unknown)';
        await this.indexerDb.createPrice(data);
        await this.mapper.createMappings(data);
    }

    // Parse PRICE v0 — validator COIN/FIAT snapshot
    async _parseV0(params, data, error){
        data['VERSION'] = 0;

        // Manually parse variable-length format:
        //   params[0] = '0' (version)
        //   params[1] = ROUND
        //   params[2] = TIMESTAMP
        //   params[3] = PAIR_COUNT (N)
        //   params[4..4+2N-1] = N pairs of (PAIR_ID, PAIR_PRICE)
        //   params[4+2N] = SIG_COUNT (M)
        //   params[4+2N+1..4+2N+2M] = M pairs of (PUBKEY, SIG)
        let round, timestamp, pairCount, pairs = [], sigCount, sigs = [];
        try {
            round     = parseInt(params[1]);
            timestamp = parseInt(params[2]);
            pairCount = parseInt(params[3]);
            if(!Number.isFinite(round) || round < 0)
                throw new Error('invalid ROUND');
            if(!Number.isFinite(timestamp) || timestamp < 0)
                throw new Error('invalid TIMESTAMP');
            if(!Number.isFinite(pairCount) || pairCount < 1)
                throw new Error('invalid PAIR_COUNT');

            let idx = 4;
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

        data['ROUND']      = round;
        data['TIMESTAMP']  = timestamp;
        data['PAIR_COUNT'] = pairCount;
        data['PAIRS_JSON'] = pairs.length > 0 ? JSON.stringify(pairs) : null;
        data['SIG_COUNT']  = sigCount;
        data['SIGS_JSON']  = sigs.length  > 0 ? JSON.stringify(sigs)  : null;

        // Verify Ed25519 signatures against the canonical payload
        // Each pubkey must have an active Tier 1 stake at the BLOCK_INDEX of this PRICE tx
        if(!error){
            let payload    = ed25519.buildPriceV0Payload(round, timestamp, pairs);
            let validSigs  = 0;
            let seenPubkey = new Set();
            for(let s of sigs){
                if(seenPubkey.has(s.pubkey)){
                    // Duplicate pubkey signature — count only once
                    continue;
                }
                seenPubkey.add(s.pubkey);

                // Verify the validator has an active Tier 1 stake at this block
                let stake = await this.indexerDb.getActiveStakeByPubkey(s.pubkey, data['BLOCK_INDEX']);
                if(!stake || stake.tier !== 1){
                    continue;
                }

                // Verify the signature
                if(!ed25519.verify(payload, s.sig, s.pubkey))
                    continue;

                validSigs++;
            }

            // Compute PBFT quorum: 2 * floor((N - 1) / 3) + 1
            let tier1Count = await this.indexerDb.getActiveStakeCount(1, data['BLOCK_INDEX']);
            let quorum = (tier1Count <= 1) ? 1 : 2 * Math.floor((tier1Count - 1) / 3) + 1;

            if(validSigs < quorum)
                error = 'invalid: insufficient PBFT quorum (' + validSigs + '/' + quorum + ')';
        }

        // Determine validation status
        let validation = error ? 'invalid' : 'valid';
        data['VALIDATION_STATUS'] = validation;
        data['STATUS'] = error || 'valid';

        // Print status message
        console.log("\t PRICE v0 : round=" + round + ' pairs=' + pairCount + ' sigs=' + sigCount + ' : ' + data['STATUS']);

        // Create record in prices table
        await this.indexerDb.createPrice(data);

        // Push validated round to hub for cross-chain aggregation
        if(!error && this.hubClient){
            this.hubClient.pushPriceRound({
                source_chain: data['COIN'],
                round:        round,
                timestamp:    timestamp,
                pairs:        pairs,
                sigs:         sigs,
                action_index: data['ACTION_INDEX'],
                block_index:  data['BLOCK_INDEX']
            }).catch(err => console.warn('PRICE v0: hub push failed:', err.message));
        }

        // Create action mappings
        await this.mapper.createMappings(data);
    }

    // Parse PRICE v1 — user TOKEN/FIAT oracle price
    // Phase 4 implements the 24-hour lock window logic; for Phase 3 this is a stub that records the action.
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

        // Push to hub for cross-chain aggregation (Phase 4 implements full lock window logic)
        if(!error && this.hubClient){
            this.hubClient.pushOraclePrice({
                source_chain:   data['COIN'],
                source_address: data['SOURCE'],
                coin:           data['V1_COIN'],
                tick:           data['V1_TICK'],
                fiat:           data['V1_FIAT'],
                value:          data['V1_VALUE'],
                fee:            data['V1_FEE'],
                memo:           data['MEMO'],
                block_time:     data['BLOCK_TIME'],
                action_index:   data['ACTION_INDEX']
            }).catch(err => console.warn('PRICE v1: hub push failed:', err.message));
        }

        // Create action mappings
        await this.mapper.createMappings(data);
    }
}

module.exports = Price;
