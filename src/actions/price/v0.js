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
 * PRICE v0: the validator BATCH snapshot, phase by phase.
 *
 * THE ORDER OF THE PHASES IS ITSELF CONSENSUS (decompression, structure,
 * straddle, signatures), so they are separate functions rather than one body:
 * each one's inputs are produced by the one before it, and the handler calls
 * them in that order and no other. Storage and the hub push stay with the
 * handler, which is what owns the row and the outbox. The signature phase is
 * batch_signatures.js.
 *
 ********************************************************************/

const swq           = require('../../stake_weighted_quorum.js');
const pricePair     = require('../../price_pair_activation.js');
const priceScale    = require('../../price_scale_activation.js');
const priceSigTally = require('../../price_sig_tally_activation.js');
const priceV2       = require('./price_batch_compression.js');
const priceRange    = require('../../price_zero_validity_activation.js');
const adm           = require('../../mirror_admission_activation.js');

// 1. DECOMPRESSION, before anything else.
function inflateBatchFields(params, error){
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
    // Decompress the batch body first, when it arrived in the compressed wire form
    if(!error && params[1] === priceV2.PRICE_BATCH_COMPRESSION_MARKER){
        let inflated = priceV2.inflatePriceBatchBody(params[2]);
        if(!inflated.ok)
            error = inflated.status;
        else
            fields = [params[0]].concat(inflated.body.split('|'));
    }
    return { fields: fields, error: error };
}

// The batch window header, read as integers and nothing more. Reading is kept apart
// from the checks so the caller holds these values even when a check throws: an
// invalid row still stores and logs the window it claimed.
function readWindowHeader(fields){
    return { firstRound: parseInt(fields[1]), lastRound: parseInt(fields[2]),
        btcBlockHeight: parseInt(fields[3]), roundCount: parseInt(fields[4]) };
}

// The batch window bounds. Throws on any breach, which the body parser turns
// into the action's error.
function checkWindowHeader(header){
    let firstRound     = header.firstRound;
    let lastRound      = header.lastRound;
    let btcBlockHeight = header.btcBlockHeight;
    let roundCount     = header.roundCount;

    // Number.isInteger on the window bounds, where v0 uses Number.isFinite on its
    // single ROUND. These two values reach buildPriceBatchPayload untouched and land in
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

    // ROUND_COUNT bound, resolved BEFORE the loop that consumes it. The count
    // is attacker-supplied and drives the loop, so an unbounded value is a parse-loop
    // denial of service on EVERY indexing node in the federation, reached by a single
    // cheap transaction. Checking it after the loop would mean the work had already
    // been done. The wire ceiling already makes a batch of more than 256 rounds
    // physically inexpressible, so this rejects nothing an honest publisher can emit.
    if(roundCount > priceV2.PRICE_BATCH_MAX_ROUND_COUNT)
        throw new Error('invalid ROUND_COUNT (' + roundCount + ' > ' + priceV2.PRICE_BATCH_MAX_ROUND_COUNT + ')');
}

// The three per-action bounds every round in the window is judged against.
function resolveRoundBounds(config, data){
    // Pair-name bound, resolved ONCE per action exactly as parseV0 resolves it, and
    // keyed on this action's own block time for the same reason: a batch can land on
    // any of BTC/LTC/DOGE and their heights diverge.
    let pairPattern = pricePair.pricePairPattern(data['BLOCK_TIME'], config['NETWORK']);

    // Price-value bound, resolved on the same key for the same reason. At/above its
    // gate a price is canonical (no leading zeros, at most 8 decimals), which is the
    // scale every producer already emits and bounds the string to 19 characters.
    let pricePattern = priceScale.priceValuePattern(data['BLOCK_TIME'], config['NETWORK']);

    // Price-RANGE bound, resolved on the same key as the two above so all three are
    // one rule per action and no batch window can straddle any of them. At/above its
    // gate a price must sit strictly inside (0, PRICE_MAX) under the SAME expression
    // the hub's ingest points evaluate: without it a quorum-signed '0' or
    // at-ceiling price is chain-valid and hub-invalid, and the hub silently discards
    // the whole batch window the round rides in. Resolved once, applied per pair.
    let rangeBound = priceRange.isPriceZeroValidityActive(data['BLOCK_TIME'], config['NETWORK']);
    return { pairPattern: pairPattern, pricePattern: pricePattern, rangeBound: rangeBound };
}

// One round's pair list, and the cursor position after it: the caller walks a
// single flat field list.
function parsePairList(fields, idx, pairCount, i, bounds){
    let pairs = [];
    for(let j = 0; j < pairCount; j++){
        let pair  = fields[idx++];
        let price = fields[idx++];
        if(!pair || !price) throw new Error('missing pair data at round ' + i + ' pair ' + j);
        if(!bounds.pairPattern.test(pair)) throw new Error('invalid pair format: ' + pair);
        if(!bounds.pricePattern.test(price)) throw new Error('invalid price format: ' + price);
        // Range AFTER format: the format rule is what bounds the string's length,
        // so a garbage-length value is refused as a format breach exactly as it is
        // today rather than being handed to parseFloat first.
        if(bounds.rangeBound && !priceRange.isPriceInHubRange(price))
            throw new Error('invalid price range: ' + price);
        pairs.push({ pair: pair, price: price });
    }
    return { pairs: pairs, idx: idx };
}

// The round blocks themselves, consumed in order from the cursor.
function parseRoundList(config, data, fields, idx, header){
    let rounds = [];
    let bounds = resolveRoundBounds(config, data);
    let prevRound = null;
    for(let i = 0; i < header.roundCount; i++){
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
        if(round < header.firstRound || round > header.lastRound)
            throw new Error('round outside the declared window at index ' + i);
        prevRound = round;


        let pair = parsePairList(fields, idx, pairCount, i, bounds);
        let pairs = pair.pairs;
        idx = pair.idx;
        // btcBlockHeight (camel) is the shape buildPriceBatchPayload reads; the snake
        // spelling is produced once, below, for storage and the hub push.
        let entry = { round: round, timestamp: timestamp, btcBlockHeight: anchor, pairs: pairs };
        // The ADMIT_BLOCKS slot: declared, and read only when THIS round's own anchor
        // is in the admission era. Below the activation there is no slot and a
        // trailing field invalidates the action exactly as it always has, so no map
        // can be smuggled onto this wire ahead of the flag day. Decoded strictly: the
        // decoder accepts only the one canonical spelling, so a map that would not
        // rebuild the signed bytes is refused here rather than failing every signature.
        if(adm.isAdmissionEra(config['NETWORK'], anchor)){
            let map = adm.decodeAdmitBlocks(fields[idx++]);
            if(map === null) throw new Error('invalid ADMIT_BLOCKS at index ' + i);
            entry.admitBlocks = map;
        }
        rounds.push(entry);
    }
    return { rounds: rounds, idx: idx };
}

// The batch signature list.
function parseSigList(fields, idx, sigCount){
    let sigs = [];
    for(let i = 0; i < sigCount; i++){
        let pubkey = fields[idx++];
        let sig    = fields[idx++];
        if(!pubkey || !sig) throw new Error('missing sig data at index ' + i);
        if(!/^[0-9a-fA-F]{64}$/.test(pubkey)) throw new Error('invalid pubkey format: ' + pubkey);
        if(!/^[0-9a-fA-F]{128}$/.test(sig))   throw new Error('invalid sig format');
        sigs.push({ pubkey: pubkey.toLowerCase(), sig: sig.toLowerCase() });
    }
    return { sigs: sigs, idx: idx };
}

// 2. STRUCTURAL CHECKS.
function parseBatchBody(config, data, fields, error){
    //
    // Any breach invalidates the WHOLE action rather than dropping the offending
    // round: the single signature set covers every round in the window (see
    // buildPriceBatchPayload), so removing one round changes the signed bytes and fails
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
            let header = readWindowHeader(fields);
            firstRound     = header.firstRound;
            lastRound      = header.lastRound;
            btcBlockHeight = header.btcBlockHeight;
            roundCount     = header.roundCount;
            checkWindowHeader(header);
            // ROUND_COUNT equalling the number of round blocks actually present is enforced by
            // CONSUMPTION, not by a trailing tally: a short count leaves the next round block's
            // ROUND field to be read as SIG_COUNT and its TIMESTAMP as a pubkey (not 64-hex, so
            // it throws), and a long count runs off the end of `fields` into undefined (NaN, so
            // it throws). Either way the action is invalid before any of it is stored.
            let idx = 5;
            let list = parseRoundList(config, data, fields, idx, header);
            rounds = list.rounds;
            idx    = list.idx;
            // THE HEADER ANCHOR IS CONSTRAINED TO THE LAST ROUND'S OWN ANCHOR.
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
            sigs = parseSigList(fields, idx, sigCount).sigs;
            bodyParsed = true;
        } catch(e) {
            if(!error) error = 'invalid: ' + e.message;
        }
    }
    return { firstRound: firstRound, lastRound: lastRound, btcBlockHeight: btcBlockHeight,
        roundCount: roundCount, rounds: rounds, sigCount: sigCount, sigs: sigs,
        bodyParsed: bodyParsed, error: error };
}

// 3. STRADDLE RULE, a deliberate departure from v0. Returns the error, or null
// when the window sits on one side of every gate.
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
function checkBatchStraddle(config, rounds){
    let network     = config['NETWORK'];
    let firstAnchor = rounds[0].btcBlockHeight;
    let lastAnchor  = rounds[rounds.length - 1].btcBlockHeight;
    //
    // The mirror admission activation is a third such gate: each round carries its
    // own map era-keyed on its own anchor, and every round in one batch sits in one
    // era, so a straddling window is invalid here exactly as at the other two.
    if(priceSigTally.isPriceSigTallyVerifyFirstActive(firstAnchor, network) !==
       priceSigTally.isPriceSigTallyVerifyFirstActive(lastAnchor, network) ||
       swq.isStakeWeightedQuorumActive(firstAnchor, network) !==
       swq.isStakeWeightedQuorumActive(lastAnchor, network) ||
       adm.isAdmissionEra(network, firstAnchor) !== adm.isAdmissionEra(network, lastAnchor))
        return 'invalid: batch straddles an oracle flag day';
    return null;
}

// The per-round bodies as `prices.rounds_json` and the hub push carry them
// (snake-cased, matching the column comment in sql/prices.sql and the hub's
// receiveValidatedBatch destructure). Built once so the stored row and the pushed
// payload can never describe two different batches. Empty unless the body was read
// to the end, so a half-consumed round list never reaches the row or the hub.
function buildRoundsWire(rounds, bodyParsed){
    return !bodyParsed ? [] : rounds.map(r => {
        let w = { round: r.round, timestamp: r.timestamp, btc_block_height: r.btcBlockHeight, pairs: r.pairs };
        // Forwarded as parsed, never rebuilt from this node's own view: the producer signed
        // THIS map and the hub re-verifies the same bytes this node verified.
        if(r.admitBlocks !== undefined) w.admit_blocks = r.admitBlocks;
        return w;
    });
}

module.exports = { inflateBatchFields, parseBatchBody, checkBatchStraddle, buildRoundsWire,
    readWindowHeader, checkWindowHeader, parseRoundList, parseSigList, resolveRoundBounds };
