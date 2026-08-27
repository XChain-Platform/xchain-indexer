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
 * Three versions:
 *   v0: Validator COIN/FIAT snapshot (PBFT-signed by price-capable validators)
 *       Format: PRICE|0|ROUND|TIMESTAMP|BTC_BLOCK_HEIGHT|PAIR_COUNT|PAIR_ID|PAIR_PRICE|...|SIG_COUNT|PUBKEY|SIG|...
 *   v1: User TOKEN/FIAT oracle price (no staking required)
 *       Format: PRICE|1|COIN|TICK|FIAT|VALUE|FEE|MEMO
 *   v2: Validator BATCH snapshot - one signed action carrying an hourly window of
 *       full v0-shaped round bodies, in either of two wire forms
 *       Format: PRICE|2|FIRST_ROUND|LAST_ROUND|BTC_BLOCK_HEIGHT|ROUND_COUNT|
 *                 ROUND|TIMESTAMP|ANCHOR_HEIGHT|PAIR_COUNT|pair|price|... (x ROUND_COUNT)
 *                 |SIG_COUNT|PUBKEY|SIG|...
 *               PRICE|2|Z|<base64 of deflateRaw(everything after "PRICE|2|" above)>
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

const ed25519   = require('../ed25519.js');
const swq       = require('../stake_weighted_quorum.js');
const pricePair = require('../price_pair_activation.js');
const priceSigTally = require('../price_sig_tally_activation.js');
const priceV2       = require('../price_v2_compression.js');

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

        this.formats = {};
        // v0 has variable-length params; the format string is informational
        this.formats[0] = 'VERSION|ROUND|TIMESTAMP|PAIR_COUNT|...|SIG_COUNT|...';
        this.formats[1] = 'VERSION|COIN|TICK|FIAT|VALUE|FEE|MEMO';
        // v2 has variable-length params and two wire forms; the format string is informational
        this.formats[2] = 'VERSION|FIRST_ROUND|LAST_ROUND|BTC_BLOCK_HEIGHT|ROUND_COUNT|...|SIG_COUNT|...';
    }

    async parse(params, data, error){
        let format = data['FORMAT'];
        if(!error && (format === null || format === undefined || this.formats[format] === undefined))
            error = 'invalid: VERSION (unknown)';

        if(format === 0)
            return this._parseV0(params, data, error);
        if(format === 1)
            return this._parseV1(params, data, error);
        if(format === 2)
            return this._parseV2(params, data, error);

        // Unknown format: still record it (as invalid) rather than dropping it silently
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

            // Pair-name bound, resolved ONCE per action (see price_pair_activation.js). Below
            // the flag-day the ticker side is capped at 5 characters, which cannot express the
            // 6-character gas ticker XCHAIN and so makes the XCHAIN/USD pair the native-fee path
            // needs unrepresentable; at/above it, 6 is accepted. Keyed on this action's own block
            // time because a PRICE round can land on any of BTC/LTC/DOGE and their heights diverge.
            //
            // A malformed pair still throws out of the WHOLE action rather than skipping the entry,
            // deliberately: the pair set is inside the payload the validators signed
            // (buildPriceV0Payload below reconstructs it from `pairs`), so dropping one entry would
            // change the payload and fail every signature. A signed round is atomic.
            let pairPattern = pricePair.pricePairPattern(data['BLOCK_TIME'], this.config['NETWORK']);

            let idx = 5;
            for(let i = 0; i < pairCount; i++){
                let pair  = params[idx++];
                let price = params[idx++];
                if(!pair || !price) throw new Error('missing pair data at index ' + i);
                if(!pairPattern.test(pair)) throw new Error('invalid pair format: ' + pair);
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

        // Verify Ed25519 signatures against the canonical payload.
        // Each pubkey must have an active price capability stake at the round's BTC anchor.
        let qualifiedSigners = [];
        if(!error){
            let payload    = ed25519.buildPriceV0Payload(round, timestamp, pairs, this.config['NETWORK'], btcBlockHeight);
            let validSigs  = 0;
            let seenPubkey = new Set();

            // PRICE_SIG_TALLY: WHERE the pubkey enters the dedupe set. At/above the gate it enters
            // only after a successful verify, so a garbage signature carrying a qualified oracle's
            // pubkey cannot be ordered ahead of that oracle's real one to consume its slot and
            // under-count the round. Below the gate the legacy mark-on-first-encounter ordering is
            // preserved verbatim, so replay of every pre-flag-day round stays bit-identical. Keyed
            // on the round's signed BTC anchor (NOT the landing chain's local height) so the hub
            // and every chain's indexer flip together; see price_sig_tally_activation.js. Either
            // way a pubkey counts AT MOST ONCE.
            let verifyFirst = priceSigTally.isPriceSigTallyVerifyFirstActive(
                data['BTC_BLOCK_HEIGHT'], this.config['NETWORK']);

            // Capability is a pure function of (pubkey, block), so resolve the whole price-capable
            // set ONCE per round rather than a DB round-trip per signer (hasCapability is ~5
            // sequential queries). Same effective set: both paths resolve _effectiveCapabilitySetSql
            // semantics at the same default MIN_STAKE. getValidatorsByCapability caps at
            // VALIDATOR_QUERY_LIMIT and hasCapability does not, so a TRUNCATED read falls back to
            // the per-signer path: silently dropping a qualified signer would under-count the
            // round's quorum.
            //
            // Keyed on the round's signed BTC anchor, NOT this action's own BLOCK_INDEX. Capability
            // staking is BTC-only, so off BTC the set comes from the hub-mirrored
            // capability_snapshots whose snapshot_block IS a BTC height; querying it at a DOGE/LTC
            // height matches nothing (empty set, zero stake, every round invalid) and on regtest,
            // where the chains' heights overlap, it can match the WRONG snapshot.
            let capableRows = await this.indexerDb.getValidatorsByCapability('price', data['BTC_BLOCK_HEIGHT']);
            let capableSet  = (capableRows && capableRows.truncated === true)
                            ? null
                            : new Set((capableRows || []).map(v => String(v.pubkey).toLowerCase()));
            let capabilityCache = new Map();

            for(let s of sigs){
                if(seenPubkey.has(s.pubkey)){
                    // Duplicate pubkey signature: count only once
                    continue;
                }
                if(!verifyFirst) seenPubkey.add(s.pubkey);

                let capable;
                if(capableSet){
                    capable = capableSet.has(s.pubkey);
                } else {
                    capable = capabilityCache.get(s.pubkey);
                    if(capable === undefined){
                        capable = await this.indexerDb.hasCapability(s.pubkey, 'price', data['BTC_BLOCK_HEIGHT']);
                        capabilityCache.set(s.pubkey, capable);
                    }
                }
                if(!capable){
                    continue;
                }

                if(!ed25519.verify(payload, s.sig, s.pubkey))
                    continue;

                if(verifyFirst) seenPubkey.add(s.pubkey);
                validSigs++;
                qualifiedSigners.push(s.pubkey);
            }

            // STAKE_WEIGHTED_QUORUM: at/above activation, finalize on the summed STAKE of the
            // qualified signers (>2/3 of S, source-deduped) rather than their COUNT. Gated on the
            // round's signed BTC anchor (data['BTC_BLOCK_HEIGHT']), NOT this PRICE's local
            // BLOCK_INDEX: PRICE v0 can land on any chain, so keying on the landing chain's own
            // height would make the LTC/DOGE comparison vacuously true (their heights already
            // dwarf the BTC activation height) and flip stake-weighting there months early while
            // BTC still used count quorum, the same signed round resolving under two rules. Below
            // activation this is byte-for-byte the legacy count rule. `qualifiedSigners` is the
            // verified, capability-qualified signer set (both modes tally it).
            let weighted = swq.isStakeWeightedQuorumActive(data['BTC_BLOCK_HEIGHT'], this.config['NETWORK']);
            if(weighted){
                // Same BTC anchor as the capable-set read above: the weights and the membership
                // test must name one validator set, or the tally and the denominator come from
                // two different sets and this node reaches a verdict no other node reaches.
                let validators = await this.indexerDb.getStakeWeightsByCapability('price', data['BTC_BLOCK_HEIGHT']);
                if(!swq.meetsStakeThreshold(validators, qualifiedSigners))
                    error = 'invalid: insufficient signer stake';
            } else {
                // Compute PBFT quorum over validators with `price` capability,
                // floored at a simple majority: max(2 * floor((N - 1) / 3) + 1, ceil((N + 1) / 2))
                let priceValidatorCount = await this.indexerDb.getActiveCapabilityCount('price', data['BTC_BLOCK_HEIGHT']);
                let quorum = (priceValidatorCount <= 1) ? 1 : Math.max(2 * Math.floor((priceValidatorCount - 1) / 3) + 1, Math.ceil((priceValidatorCount + 1) / 2));

                if(validSigs < quorum)
                    error = 'invalid: insufficient PBFT quorum (' + validSigs + '/' + quorum + ')';
            }
        }

        let validation = error ? 'invalid' : 'valid';
        data['VALIDATION_STATUS'] = validation;
        data['STATUS'] = error || 'valid';

        console.log("\t PRICE v0 : round=" + round + ' pairs=' + pairCount + ' sigs=' + sigCount + ' : ' + data['STATUS']);

        await this.indexerDb.createPrice(data);

        // Derive oracle_round rewards from the on-chain signer set (CONSENSUS). The verified,
        // capability-qualified signature list above IS the round's signed participation record,
        // so the reward split is a deterministic function of this action, replayable on any
        // reindex or ANCHOR full-parse recovery, unlike the retired hub push (which credited the
        // in-memory PBFT prepare set and could never be re-derived offline). Consequences:
        // rewards follow the published signer set, and a round that finalizes but never lands a
        // PRICE action earns nothing. A duplicate PRICE for an already-rewarded round upserts the
        // same rows (same round_reference → same split), so failover double-publishes stay idempotent.
        if(!error && data['COIN'] === 'BTC' && qualifiedSigners.length > 0){
            let staking     = this.config['STAKING'] || {};
            let rewardTotal = staking['ORACLE_REWARD_PER_ROUND'] || '10.00000000';
            let fnShare     = String((this.config['FULLNODE'] || {})['REWARD_SHARE'] || '0');

            // Two-tranche split (NODEPROOF / verified full-node tier). When FULLNODE.REWARD_SHARE
            // > 0 the round budget is split into a BASE tranche (every qualified signer) and a
            // FULL-NODE tranche (only signers that are VERIFIED full nodes this block, deduped per
            // staking source; one operator = one share). When the share is 0, or no verified full
            // node signed this round, the whole budget pays the base set; with share == 0 that base
            // set keeps the legacy 'oracle_round' reward_type so existing-chain replay stays
            // byte-identical. CONSENSUS: REWARD_SHARE is a fleet-wide consensus parameter (like
            // ORACLE_REWARD_PER_ROUND) and MUST match across every indexer and be deployed
            // atomically. (See NODEPROOF.md.)
            let activeRegime = this.util.bcgt(fnShare, '0');

            // Resolve the full-node REWARD sources among THIS round's signers. Earning the tranche
            // is participation-rate based (a carrot, not a stick; there is NO slashing for
            // non-participation): a staking source qualifies only if, over the trailing
            // REWARD_PASS_WINDOW_BLOCKS, it answered at least MIN_PASS_RATE_BPS of the challenge
            // epochs that actually produced a verdict (db.getFullNodeParticipation). Forgiving of a
            // missed check or two. The bonus is credited once per source, to the lexicographically
            // smallest of its passing pubkeys that ALSO signed this round and still holds the
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
                        // Byte comparator, not a bare .sort(): this pick lands in a ledger
                        // write (createValidatorReward), and the default sort is a total order
                        // here only because every element happens to be lowercase 64-hex. Pin it
                        // the way the other consensus-feeding sorts do (sweep.js, attest.js) so
                        // the tiebreak stops depending on that implicit input shape.
                        for(let pk of Array.from(src.pubkeys)
                                .sort((a, b) => Buffer.compare(Buffer.from(String(a), 'utf8'),
                                                               Buffer.from(String(b), 'utf8')))){
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

        // Push validated round to hub for cross-chain aggregation via a durable transactional
        // outbox (mirrors rollback.js HUB-RETRACT-2). The pending_hub_pushes row is written
        // through the OPEN block transaction so it commits atomically with the prices row (and
        // rolls back with it); block processing never blocks on hub HTTP latency because live
        // delivery is attempted post-commit. The hub dedupes by round_number, so a later replay
        // it already has is a safe no-op.
        if(!error && this.hubClient && this.hubClient.enabled){
            // Source-chain reorg fence: stamp the current push generation so the hub row carries
            // it. A later deferred retraction (which carries the rollback's pre-bump generation)
            // then deletes only stale rows, not this one if it is re-published post-reorg.
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
            // Durable outbox: enqueue INSIDE the block transaction (enqueueHubPushTx routes
            // through the open transaction connection) so a crash between commitTransaction and
            // the old fire-and-forget .catch handler can no longer silently drop the round, and a
            // later same-block rollbackTransaction unwinds the row instead of leaving a phantom
            // push. Stage it for an immediate post-commit live delivery by XChainIndexer; on
            // success the row is dropped, on failure/crash HubPushQueue drains the survivor.
            let pushId = await this.indexerDb.enqueueHubPushTx('price_round', payload);
            this.indexerDb.stageHubPush({ id: pushId, pushType: 'price_round', payload });
        }

        await this.mapper.createMappings(data);
    }

    // Parse PRICE v2: validator BATCH snapshot, one signed action carrying an hourly
    // window of full v0-shaped round bodies.
    //
    // THE ORDER OF THE STEPS BELOW IS ITSELF CONSENSUS: decompression, structure,
    // straddle, signatures, storage, push. Each step's inputs are produced by the one
    // before it, so reordering two of them changes which wires a node accepts.
    //
    // v2 is ALWAYS ON: a batch is valid on its own merits, with no activation gate. There
    // is no pre-launch history for a gate to protect (mainnet has no chain and the testnet
    // chains carry no protocol transactions), so a gate here would only be machinery
    // someone must remember to arm.
    //
    // Unlike v0 this never derives rewards (D30): the oracle_round derivation lives inline
    // in _parseV0 and is not shared code, so a v2 batch pays nothing. Hoisting that
    // derivation into a shared helper would silently start paying six rounds per batch, so
    // a zero-validator_rewards test pins the absence.
    async _parseV2(params, data, error){
        data['VERSION'] = 2;

        // 1. DECOMPRESSION, before anything else.
        //
        // `Z` occupies the FIRST_ROUND slot on the compressed form and FIRST_ROUND is
        // always a decimal integer, so the two forms are told apart with no lookahead.
        // Everything after this point reads `fields`, never `params`, which is what makes
        // the rest of the parser form-agnostic: the two wire forms cannot diverge in
        // validity because only one of them ever reaches the structural rules.
        //
        // There is deliberately NO fallback that retries an undecodable field as an
        // uncompressed body. That fallback is precisely how one node reads a batch the
        // next node rejects, and the bounds it would bypass (ratio, size, canonical
        // base64) are consensus here, not presentational.
        let fields = params;
        if(!error && params[1] === priceV2.PRICE_V2_COMPRESSION_MARKER){
            let inflated = priceV2.inflatePriceV2Body(params[2]);
            if(!inflated.ok)
                error = inflated.status;
            else
                fields = [params[0]].concat(inflated.body.split('|'));
        }

        // 2. STRUCTURAL CHECKS.
        //
        // Any breach invalidates the WHOLE action rather than dropping the offending
        // round: the single signature set covers every round in the window (see
        // buildPriceV2Payload), so removing one round changes the signed bytes and fails
        // every signature. A signed batch is atomic exactly as a signed round is.
        let firstRound, lastRound, btcBlockHeight, roundCount;
        let rounds = [], sigCount, sigs = [];
        // Whether the body was read to the end. A structural throw leaves `rounds` holding
        // however many blocks were consumed before it, which is a batch nobody signed;
        // storing that truncated list as `rounds_json` would publish a fiction that reads
        // like evidence (an equivocation or slash review inspects exactly this column).
        let bodyParsed = false;
        if(!error){
            try {
                firstRound     = parseInt(fields[1]);
                lastRound      = parseInt(fields[2]);
                btcBlockHeight = parseInt(fields[3]);
                roundCount     = parseInt(fields[4]);

                // Number.isInteger on the window bounds, where v0 uses Number.isFinite on its
                // single ROUND. These two values reach buildPriceV2Payload untouched and land in
                // the canonical JSON, and the equivocation reader that resolves an XORACLEB slash
                // requires Number.isInteger on both. A non-integer that slipped through here would
                // not surface as an invalid action; it would surface later as a slashing decision
                // that cannot be resolved.
                if(!Number.isInteger(firstRound) || firstRound < 0)
                    throw new Error('invalid FIRST_ROUND');
                if(!Number.isInteger(lastRound) || lastRound < 0)
                    throw new Error('invalid LAST_ROUND');
                if(firstRound > lastRound)
                    throw new Error('invalid ROUND window (FIRST_ROUND > LAST_ROUND)');
                if(!Number.isFinite(btcBlockHeight) || btcBlockHeight < 0)
                    throw new Error('invalid BTC_BLOCK_HEIGHT');
                if(!Number.isFinite(roundCount) || roundCount < 1)
                    throw new Error('invalid ROUND_COUNT');

                // ROUND_COUNT bound, resolved BEFORE the loop that consumes it (D15). The count
                // is attacker-supplied and drives the loop, so an unbounded value is a parse-loop
                // denial of service on EVERY indexing node in the federation, reached by a single
                // cheap transaction. Checking it after the loop would mean the work had already
                // been done. The wire ceiling already makes a batch of more than 256 rounds
                // physically inexpressible, so this rejects nothing an honest publisher can emit.
                if(roundCount > priceV2.PRICE_V2_MAX_ROUND_COUNT)
                    throw new Error('invalid ROUND_COUNT (' + roundCount + ' > ' + priceV2.PRICE_V2_MAX_ROUND_COUNT + ')');

                // Pair-name bound, resolved ONCE per action exactly as _parseV0 resolves it, and
                // keyed on this action's own block time for the same reason: a batch can land on
                // any of BTC/LTC/DOGE and their heights diverge.
                let pairPattern = pricePair.pricePairPattern(data['BLOCK_TIME'], this.config['NETWORK']);

                // ROUND_COUNT equalling the number of round blocks actually present is enforced by
                // CONSUMPTION, not by a trailing tally: a short count leaves the next round block's
                // ROUND field to be read as SIG_COUNT and its TIMESTAMP as a pubkey (not 64-hex, so
                // it throws), and a long count runs off the end of `fields` into undefined (NaN, so
                // it throws). Either way the action is invalid before any of it is stored.
                let idx = 5;
                let prevRound = null;
                for(let i = 0; i < roundCount; i++){
                    let round     = parseInt(fields[idx++]);
                    let timestamp = parseInt(fields[idx++]);
                    let anchor    = parseInt(fields[idx++]);
                    let pairCount = parseInt(fields[idx++]);
                    if(!Number.isInteger(round) || round < 0)
                        throw new Error('invalid ROUND at index ' + i);
                    if(!Number.isFinite(timestamp) || timestamp < 0)
                        throw new Error('invalid TIMESTAMP at index ' + i);
                    if(!Number.isFinite(anchor) || anchor < 0)
                        throw new Error('invalid ANCHOR_HEIGHT at index ' + i);
                    if(!Number.isFinite(pairCount) || pairCount < 1)
                        throw new Error('invalid PAIR_COUNT at index ' + i);
                    // Strictly ascending gives uniqueness for free, and containment in the declared
                    // window is what stops a batch from smuggling a round the header does not claim
                    // (the header window is what the EQUIV round id is built from, so an
                    // out-of-window round would ride under an equiv key that does not cover it).
                    if(prevRound !== null && round <= prevRound)
                        throw new Error('rounds not strictly ascending at index ' + i);
                    if(round < firstRound || round > lastRound)
                        throw new Error('round outside the declared window at index ' + i);
                    prevRound = round;

                    let pairs = [];
                    for(let j = 0; j < pairCount; j++){
                        let pair  = fields[idx++];
                        let price = fields[idx++];
                        if(!pair || !price) throw new Error('missing pair data at round ' + i + ' pair ' + j);
                        if(!pairPattern.test(pair)) throw new Error('invalid pair format: ' + pair);
                        if(!/^[0-9]+(\.[0-9]+)?$/.test(price)) throw new Error('invalid price format: ' + price);
                        pairs.push({ pair: pair, price: price });
                    }
                    // btcBlockHeight (camel) is the shape buildPriceV2Payload reads; the snake
                    // spelling is produced once, below, for storage and the hub push.
                    rounds.push({ round: round, timestamp: timestamp, btcBlockHeight: anchor, pairs: pairs });
                }

                // THE HEADER ANCHOR IS CONSTRAINED TO THE LAST ROUND'S OWN ANCHOR (section 4).
                // Both quorum gates below (sig-tally and stake-weighted) resolve on this one
                // value, and the straddle rule inspects only the per-round anchors, so an
                // unconstrained header would let a colluding signing quorum pick which consensus
                // rule judges its own batch while every per-round anchor stayed honest: choosing
                // your own judge is exactly what a quorum rule exists to prevent. The rounds are
                // strictly ascending by the loop above, so the last one carries the window's
                // highest anchor. Checked HERE, before the gates read it; a check placed after
                // them would protect nothing.
                if(btcBlockHeight !== rounds[rounds.length - 1].btcBlockHeight)
                    throw new Error('batch anchor does not match the last round');

                sigCount = parseInt(fields[idx++]);
                if(!Number.isFinite(sigCount) || sigCount < 1)
                    throw new Error('invalid SIG_COUNT');

                for(let i = 0; i < sigCount; i++){
                    let pubkey = fields[idx++];
                    let sig    = fields[idx++];
                    if(!pubkey || !sig) throw new Error('missing sig data at index ' + i);
                    if(!/^[0-9a-fA-F]{64}$/.test(pubkey)) throw new Error('invalid pubkey format: ' + pubkey);
                    if(!/^[0-9a-fA-F]{128}$/.test(sig))   throw new Error('invalid sig format');
                    sigs.push({ pubkey: pubkey.toLowerCase(), sig: sig.toLowerCase() });
                }
                bodyParsed = true;
            } catch(e) {
                if(!error) error = 'invalid: ' + e.message;
            }
        }

        // 3. STRADDLE RULE (D7), a deliberate departure from v0.
        //
        // v0 resolves the sig-tally and stake-weighted-quorum flag days on each round's OWN
        // anchor. A batch resolves them ONCE, on the batch anchor, so a window straddling
        // either activation height would judge its earlier rounds under the later rule: the
        // same round would validate differently depending on which action carried it.
        // Rather than invent per-round gate resolution inside one signed action, a
        // straddling batch is invalid and the publisher splits at every armed boundary.
        //
        // Written against the gate PREDICATES rather than against their heights so it can
        // never disagree with the gates it protects, and so an unarmed or disarmed gate
        // (both sides false) straddles nothing. Byte-parallel to the hub twin's own check
        // in PriceAggregator.receiveValidatedBatch.
        if(!error){
            let network     = this.config['NETWORK'];
            let firstAnchor = rounds[0].btcBlockHeight;
            let lastAnchor  = rounds[rounds.length - 1].btcBlockHeight;
            if(priceSigTally.isPriceSigTallyVerifyFirstActive(firstAnchor, network) !==
               priceSigTally.isPriceSigTallyVerifyFirstActive(lastAnchor, network) ||
               swq.isStakeWeightedQuorumActive(firstAnchor, network) !==
               swq.isStakeWeightedQuorumActive(lastAnchor, network))
                error = 'invalid: batch straddles an oracle flag day';
        }

        // The per-round bodies as `prices.rounds_json` and the hub push carry them
        // (snake-cased, matching the column comment in sql/prices.sql and the hub's
        // receiveValidatedBatch destructure). Built once so the stored row and the pushed
        // payload can never describe two different batches. Empty unless the body was read
        // to the end, so a half-consumed round list never reaches the row or the hub.
        let roundsWire = !bodyParsed ? [] : rounds.map(r => ({
            round:            r.round,
            timestamp:        r.timestamp,
            btc_block_height: r.btcBlockHeight,
            pairs:            r.pairs
        }));

        // 4. SIGNATURE VERIFICATION over the v2 canonical.
        //
        // buildPriceV2Payload is the ONLY canonical builder; the hub's two twins are
        // byte-identical to it. Never inline the JSON here, or the three copies drift and
        // every honest batch fails.
        let qualifiedSigners = [];
        if(!error){
            let payload    = ed25519.buildPriceV2Payload(firstRound, lastRound, btcBlockHeight, rounds);
            let validSigs  = 0;
            let seenPubkey = new Set();

            // PRICE_SIG_TALLY, keyed on the BATCH anchor because a batch resolves the gate once
            // (the straddle rule above is what makes that one resolution sound for every round in
            // the window). At/above the gate a pubkey enters the dedupe set only after a
            // successful verify, so a garbage signature carrying a qualified oracle's pubkey
            // cannot be ordered ahead of that oracle's real one to consume its slot.
            let verifyFirst = priceSigTally.isPriceSigTallyVerifyFirstActive(
                btcBlockHeight, this.config['NETWORK']);

            // Capability set resolved exactly as _parseV0 resolves it, at the BATCH's signed BTC
            // anchor and not this action's own BLOCK_INDEX (capability_snapshots.snapshot_block is
            // a BTC height, so off BTC a landing-chain height matches nothing). Includes the same
            // truncation fallback to the per-signer path: getValidatorsByCapability caps at
            // VALIDATOR_QUERY_LIMIT and hasCapability does not, so treating a TRUNCATED read as
            // the whole set would silently drop a qualified signer and under-count the quorum.
            let capableRows = await this.indexerDb.getValidatorsByCapability('price', btcBlockHeight);
            let capableSet  = (capableRows && capableRows.truncated === true)
                            ? null
                            : new Set((capableRows || []).map(v => String(v.pubkey).toLowerCase()));
            let capabilityCache = new Map();

            for(let s of sigs){
                if(seenPubkey.has(s.pubkey)){
                    // Duplicate pubkey signature: count only once
                    continue;
                }
                if(!verifyFirst) seenPubkey.add(s.pubkey);

                let capable;
                if(capableSet){
                    capable = capableSet.has(s.pubkey);
                } else {
                    capable = capabilityCache.get(s.pubkey);
                    if(capable === undefined){
                        capable = await this.indexerDb.hasCapability(s.pubkey, 'price', btcBlockHeight);
                        capabilityCache.set(s.pubkey, capable);
                    }
                }
                if(!capable){
                    continue;
                }

                if(!ed25519.verify(payload, s.sig, s.pubkey))
                    continue;

                if(verifyFirst) seenPubkey.add(s.pubkey);
                validSigs++;
                qualifiedSigners.push(s.pubkey);
            }

            // Count-or-stake quorum. The GATE, the WEIGHTS and the capability count all key on the
            // batch's signed BTC anchor, exactly as _parseV0 keys them: the gate must flip on one
            // height for every chain and the hub, and the validator set is BTC-anchored because
            // capability staking is BTC-only.
            let weighted = swq.isStakeWeightedQuorumActive(btcBlockHeight, this.config['NETWORK']);
            if(weighted){
                let validators = await this.indexerDb.getStakeWeightsByCapability('price', btcBlockHeight);
                if(!swq.meetsStakeThreshold(validators, qualifiedSigners))
                    error = 'invalid: insufficient signer stake';
            } else {
                let priceValidatorCount = await this.indexerDb.getActiveCapabilityCount('price', btcBlockHeight);
                let quorum = (priceValidatorCount <= 1) ? 1 : Math.max(2 * Math.floor((priceValidatorCount - 1) / 3) + 1, Math.ceil((priceValidatorCount + 1) / 2));

                if(validSigs < quorum)
                    error = 'invalid: insufficient PBFT quorum (' + validSigs + '/' + quorum + ')';
            }
        }

        // 5. STORAGE. round_number carries FIRST_ROUND (D21: the column is indexed and every
        // existing read treats it as "the round this action is about"), sigs_json carries the
        // batch signature set, and pair_count/pairs_json/sig_count are left unset so they
        // store NULL: on a v2 row those three would describe only one round out of the window.
        data['ROUND']             = firstRound;
        data['BTC_BLOCK_HEIGHT']  = btcBlockHeight;
        data['BATCH_FIRST_ROUND'] = firstRound;
        data['BATCH_LAST_ROUND']  = lastRound;
        data['ROUND_COUNT']       = roundCount;
        data['ROUNDS_JSON']       = roundsWire.length > 0 ? JSON.stringify(roundsWire) : null;
        data['SIGS_JSON']         = (bodyParsed && sigs.length > 0) ? JSON.stringify(sigs) : null;

        let validation = error ? 'invalid' : 'valid';
        data['VALIDATION_STATUS'] = validation;
        data['STATUS'] = error || 'valid';

        console.log("\t PRICE v2 : rounds=" + firstRound + '-' + lastRound + ' count=' + roundCount + ' sigs=' + sigCount + ' : ' + data['STATUS']);

        await this.indexerDb.createPrice(data);

        // 6. HUB PUSH through the same durable transactional outbox v0 and v1 use. The
        // pending_hub_pushes row is written through the OPEN block transaction so it commits
        // atomically with the prices row and rolls back with it. `price_batch` is DURABLE
        // rather than disposable (D12): a batch is the SOLE carrier of every round in its
        // window for a chain-only node, so retiring one after the attempt cap would destroy
        // an hour of price history rather than a single re-derivable round.
        if(!error && this.hubClient && this.hubClient.enabled){
            // Source-chain reorg fence: see _parseV0.
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
                first_round:      firstRound,
                last_round:       lastRound,
                btc_block_height: btcBlockHeight,
                rounds:           roundsWire,
                block_time:       data['BLOCK_TIME'],
                sigs:             sigs,
                action_index:     data['ACTION_INDEX'],
                block_index:      data['BLOCK_INDEX'],
                push_generation:  pushGeneration
            };
            let pushId = await this.indexerDb.enqueueHubPushTx('price_batch', payload);
            this.indexerDb.stageHubPush({ id: pushId, pushType: 'price_batch', payload });
        }

        await this.mapper.createMappings(data);
    }

    // Parse PRICE v1: user TOKEN/FIAT oracle price.
    // Records the action and pushes to hub for cross-chain aggregation.
    // The 24-hour lock window is not yet enforced.
    async _parseV1(params, data, error){
        data['VERSION'] = 1;

        data['V1_COIN']  = params[1];
        data['V1_TICK']  = params[2];
        data['V1_FIAT']  = params[3];
        data['V1_VALUE'] = params[4];
        data['V1_FEE']   = params[5];
        data['MEMO']     = params[6];

        if(!error && (!data['V1_COIN'] || !this.config['COINS'].includes(data['V1_COIN'])))
            error = 'invalid: COIN (unsupported)';

        if(!error && (!data['V1_TICK'] || data['V1_TICK'].length === 0 || data['V1_TICK'].length > this.config['MAX_TICK_LENGTH']))
            error = 'invalid: TICK (format)';

        if(!error && (!data['V1_FIAT'] || this.util.isNull(this.config['FIATS'][data['V1_FIAT']])))
            error = 'invalid: FIAT (unsupported)';

        // Validate VALUE (positive 8-decimal string)
        if(!error && (!data['V1_VALUE'] || !/^[0-9]+(\.[0-9]{1,8})?$/.test(data['V1_VALUE']) || this.util.bclte(data['V1_VALUE'], '0')))
            error = 'invalid: VALUE (format)';

        // Validate FEE (decimal between 0 and 1, optional). The regex caps precision at 18
        // decimals (bcmath width) and the range gate uses exact bcmath comparators, not
        // parseFloat: an unbounded-precision value like '1.0000000000000000001' rounds to
        // exactly 1.0 under IEEE-754 and would slip past a parseFloat `> 1` check while
        // downstream bcmath (bcmul @18) treats it as > 1, a validator/consensus-math
        // divergence on a money path.
        if(!error && data['V1_FEE'] && (!/^[0-9]+(\.[0-9]{1,18})?$/.test(data['V1_FEE']) || this.util.bclt(data['V1_FEE'], '0') || this.util.bcgt(data['V1_FEE'], '1')))
            error = 'invalid: FEE (format)';

        let validation = error ? 'invalid' : 'valid';
        data['VALIDATION_STATUS'] = validation;
        data['STATUS'] = error || 'valid';

        console.log("\t PRICE v1 : " + data['V1_COIN'] + '/' + data['V1_TICK'] + '/' + data['V1_FIAT'] + ' = ' + data['V1_VALUE'] + ' : ' + data['STATUS']);

        await this.indexerDb.createPrice(data);

        // Push to hub for cross-chain aggregation (Phase 4 implements full lock window logic)
        // via the same durable transactional outbox as v0. A v1 oracle_price is a user-submitted
        // action keyed by (source_address, source_chain, action_index) and is never re-emitted by
        // a later block, so the old crash-window loss was permanent and non-re-derivable; the
        // outbox closes it. The hub dedupes by (source_address, source_chain, action_index), so a
        // later replay it already has is a safe no-op.
        if(!error && this.hubClient && this.hubClient.enabled){
            // Source-chain reorg fence: see _parseV0 above.
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
            // Durable outbox inside the block transaction (see _parseV0). enqueueHubPushTx
            // commits the pending_hub_pushes row atomically with the prices row; the staged
            // entry is delivered live post-commit by XChainIndexer and dropped on success, else
            // HubPushQueue drains the survivor. This is the priority case: unlike a price_round,
            // a lost oracle_price is never re-derivable.
            let pushId = await this.indexerDb.enqueueHubPushTx('oracle_price', payload);
            this.indexerDb.stageHubPush({ id: pushId, pushType: 'oracle_price', payload });
        }

        await this.mapper.createMappings(data);
    }
}

module.exports = Price;
