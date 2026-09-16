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
 * Three versions, two of them live on the wire:
 *   v0: the RETIRED per-round validator snapshot. Its former wire,
 *       PRICE|0|ROUND|TIMESTAMP|BTC_BLOCK_HEIGHT|PAIR_COUNT|PAIR_ID|PAIR_PRICE|...|SIG_COUNT|PUBKEY|SIG|...,
 *       is no longer parsed: VERSION 0 now names the batch form below, whose round bodies
 *       keep the v0 shape. ed25519.buildPriceV0Payload survives as the per-round canonical
 *       the hub-to-hub push path still signs and verifies.
 *   v1: User TOKEN/FIAT oracle price (no staking required)
 *       Format: PRICE|1|COIN|TICK|FIAT|VALUE|FEE|MEMO
 *   v2: Validator BATCH snapshot - one signed action carrying an hourly window of
 *       full v0-shaped round bodies, in either of two wire forms
 *       Format: PRICE|0|FIRST_ROUND|LAST_ROUND|BTC_BLOCK_HEIGHT|ROUND_COUNT|
 *                 ROUND|TIMESTAMP|ANCHOR_HEIGHT|PAIR_COUNT|pair|price|...[|ADMIT_BLOCKS] (x ROUND_COUNT)
 *                 |SIG_COUNT|PUBKEY|SIG|...
 *               PRICE|0|Z|<base64 of deflateRaw(everything after "PRICE|0|" above)>
 *       ADMIT_BLOCKS is the round's admission map (CODE:digits in ASCII order, comma-joined),
 *       a declared slot present exactly when the round's OWN anchor is in the mirror
 *       admission era and absent below it; a batch never straddles that activation.
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

const v0         = require('./v0.js');
const batchSigs  = require('./batch_signatures.js');
const v1         = require('./v1.js');

const { getLogger } = require('../../observability/index.js');
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
        this.formats[0] = 'VERSION|FIRST_ROUND|LAST_ROUND|BTC_BLOCK_HEIGHT|ROUND_COUNT|...|SIG_COUNT|...';
        this.formats[1] = 'VERSION|COIN|TICK|FIAT|VALUE|FEE|MEMO';
        // v2 has variable-length params and two wire forms; the format string is informational
    }

    async parse(params, data, error){
        let format = data['FORMAT'];
        // Verify VERSION is a format this action recognizes
        if(!error && (format === null || format === undefined || this.formats[format] === undefined))
            error = 'invalid: VERSION (unknown)';

        if(format === 0)
            return this.parseV0(params, data, error);
        if(format === 1)
            return this.parseV1(params, data, error);

        // Unknown format: still record it (as invalid) rather than dropping it silently
        data['VERSION']           = format;
        data['VALIDATION_STATUS'] = 'invalid';
        data['STATUS']            = error || 'invalid: VERSION (unknown)';
        await this.indexerDb.createPrice(data);
        await this.mapper.createMappings(data);
    }

    // Parse PRICE v0: validator BATCH snapshot, one signed action carrying an hourly
    // window of full round bodies.
    //
    // THE ORDER OF THE STEPS BELOW IS ITSELF CONSENSUS: decompression, structure,
    // straddle, signatures, storage, push. Each step's inputs are produced by the one
    // before it, so reordering two of them changes which wires a node accepts.
    //
    // There is no activation gate: a batch is valid on its own merits. Nothing pre-launch
    // needs protecting (mainnet has no chain and the testnet chains carry no protocol
    // transactions), so a gate here would only be machinery someone must remember to arm.
    //
    // This derives no rewards. The retired per-round wire carried an inline oracle_round
    // derivation that only ever fired for PRICE landing on BTC, which production never
    // does, so it paid nothing in practice and is not reproduced here. Paying the elected
    // publisher alone would misprice every other validator's participation; a real
    // participation rail is tracked separately. A zero-validator_rewards test pins this.
    async parseV0(params, data, error){
        data['VERSION'] = 0;

        let inflated = v0.inflateBatchFields(params, error);
        // Parse the batch's window bounds and round list from the wire fields
        let batch    = v0.parseBatchBody(this.config, data, inflated.fields, inflated.error);
        error        = batch.error;

        if(!error){
            let straddle = v0.checkBatchStraddle(this.config, batch.rounds);
            if(straddle) error = straddle;
        }

        let roundsWire = v0.buildRoundsWire(batch.rounds, batch.bodyParsed);

        // Verify the batch's signatures now that its structure and window are known good
        if(!error){
            let quorum = await batchSigs.verifyBatchSignatures(this.indexerDb, this.config, batch);
            if(quorum) error = quorum;
        }

        // 5. STORAGE. round_number carries FIRST_ROUND (because the column is indexed and every
        // existing read treats it as "the round this action is about"), sigs_json carries the
        // batch signature set, and pair_count/pairs_json/sig_count are left unset so they
        // store NULL: on a v2 row those three would describe only one round out of the window.
        data['ROUND']             = batch.firstRound;
        data['BTC_BLOCK_HEIGHT']  = batch.btcBlockHeight;
        data['BATCH_FIRST_ROUND'] = batch.firstRound;
        data['BATCH_LAST_ROUND']  = batch.lastRound;
        data['ROUND_COUNT']       = batch.roundCount;
        data['ROUNDS_JSON']       = roundsWire.length > 0 ? JSON.stringify(roundsWire) : null;
        data['SIGS_JSON']         = (batch.bodyParsed && batch.sigs.length > 0) ? JSON.stringify(batch.sigs) : null;
        let validation = error ? 'invalid' : 'valid';
        data['VALIDATION_STATUS'] = validation;
        data['STATUS'] = error || 'valid';

        getLogger().info("\t PRICE v0 : rounds=" + batch.firstRound + '-' + batch.lastRound + ' count=' + batch.roundCount + ' sigs=' + batch.sigCount + ' : ' + data['STATUS']);

        await this.indexerDb.createPrice(data);

        await this.pushBatch(data, batch, roundsWire, error);

        await this.mapper.createMappings(data);
    }

    // 6. HUB PUSH through the same durable transactional outbox v0 and v1 use. The
    // pending_hub_pushes row is written through the OPEN block transaction so it commits
    // atomically with the prices row and rolls back with it. `price_batch` is DURABLE
    // rather than disposable: a batch is the SOLE carrier of every round in its
    // window for a chain-only node, so retiring one after the attempt cap would destroy
    // an hour of price history rather than a single re-derivable round.
    async pushBatch(data, batch, roundsWire, error){
        if(!error && this.hubClient && this.hubClient.enabled){
            // Source-chain reorg fence: see parseV0.
            let pushGeneration = await this.indexerDb.getPushGeneration(data['COIN']);
            // KEY NAMES ARE CONSENSUS-ADJACENT AND UNVALIDATED BY THE TRANSPORT. The hub's
            // pushpricebatch handler destructures exactly these names; a typo here fails
            // silently at runtime (an undefined field, a refused batch) rather than loudly at
            // build time, so a test pins this key set.
            //
            // block_time is the addition v0's payload has no counterpart for: the hub keys its
            // pair-name flag day per round, and batching widens the hub/chain skew from ~10
            // minutes to ~70, so without the landing action's own block time the hub would
            // refuse a whole hour that the chain accepted.
            let payload = {
                source_chain:     data['COIN'],
                first_round:      batch.firstRound,
                last_round:       batch.lastRound,
                btc_block_height: batch.btcBlockHeight,
                rounds:           roundsWire,
                block_time:       data['BLOCK_TIME'],
                sigs:             batch.sigs,
                action_index:     data['ACTION_INDEX'],
                block_index:      data['BLOCK_INDEX'],
                push_generation:  pushGeneration
            };
            let pushId = await this.indexerDb.enqueueHubPushTx('price_batch', payload);
            this.indexerDb.stageHubPush({ id: pushId, pushType: 'price_batch', payload });
        }
    }

    // Parse PRICE v1: user TOKEN/FIAT oracle price.
    // Records the action and pushes to hub for cross-chain aggregation.
    // The 24-hour lock window is not yet enforced.
    async parseV1(params, data, error){
        data['VERSION'] = 1;

        error = v1.validatePriceV1(this.config, this.util, params, data, error);

        // Determine validation status
        let validation = error ? 'invalid' : 'valid';
        data['VALIDATION_STATUS'] = validation;
        data['STATUS'] = error || 'valid';

        // Print status message
        getLogger().info("\t PRICE v1 : " + data['V1_COIN'] + '/' + data['V1_TICK'] + '/' + data['V1_FIAT'] + ' = ' + data['V1_VALUE'] + ' : ' + data['STATUS']);

        // Create record in prices table
        await this.indexerDb.createPrice(data);

        // Push to hub for cross-chain aggregation (Phase 4 implements full lock window logic)
        // via the same durable transactional outbox as v0. A v1 oracle_price is a user-submitted
        // action keyed by (source_address, source_chain, action_index) and is never re-emitted by
        // a later block, so the old crash-window loss was permanent and non-re-derivable; the
        // outbox closes it. The hub dedupes by (source_address, source_chain, action_index), so a
        // later replay it already has is a safe no-op.
        if(!error && this.hubClient && this.hubClient.enabled){
            // Source-chain reorg fence: see parseV0 above.
            let pushGeneration = await this.indexerDb.getPushGeneration(data['COIN']);
            let payload = v1.buildV1PushPayload(data, pushGeneration);
            // Durable outbox inside the block transaction (see parseV0). enqueueHubPushTx
            // commits the pending_hub_pushes row atomically with the prices row; the staged
            // entry is delivered live post-commit by XChainIndexer and dropped on success, else
            // HubPushQueue drains the survivor. This is the priority case: unlike a price_round,
            // a lost oracle_price is never re-derivable.
            let pushId = await this.indexerDb.enqueueHubPushTx('oracle_price', payload);
            this.indexerDb.stageHubPush({ id: pushId, pushType: 'oracle_price', payload });
        }

            // Create action mappings
            await this.mapper.createMappings(data);
        }
    }

    module.exports = Price;
