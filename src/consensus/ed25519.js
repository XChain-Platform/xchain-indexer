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
 * XChain Indexer - Ed25519 Helper
 *
 * Verification of Ed25519 signatures using Node.js built-in crypto.
 * Mirrors the format used by xchain-hub/src/validators/identity.js so
 * signatures produced by validators can be verified by indexers.
 *
 ********************************************************************/

const crypto = require('crypto');
const eq     = require('../equivocation_header.js');
const adm    = require('../mirror_admission_activation.js');

// ASN.1 DER prefix for Ed25519 SPKI (SubjectPublicKeyInfo), 12 bytes
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

// Reconstruct a crypto.KeyObject from a 64-hex-char raw Ed25519 pubkey
function pubkeyFromHex(hex) {
    if (!hex || hex.length !== 64) throw new Error('Invalid pubkey hex length');
    let raw = Buffer.from(hex, 'hex');
    let spkiDer = Buffer.concat([SPKI_ED25519_PREFIX, raw]);
    return crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
}

// Verify an Ed25519 signature: returns true/false (never throws)
function verify(payload, sigHex, pubkeyHex) {
    if (!payload || !sigHex || !pubkeyHex) return false;
    if (!/^[0-9a-fA-F]{64}$/.test(pubkeyHex)) return false;
    if (!/^[0-9a-fA-F]{128}$/.test(sigHex)) return false;
    try {
        let pubkeyObj = pubkeyFromHex(pubkeyHex);
        let sig = Buffer.from(sigHex, 'hex');
        return crypto.verify(null, Buffer.from(payload, 'utf8'), pubkeyObj, sig);
    } catch (e) {
        return false;
    }
}

// Build the canonical signable payload for a PRICE v0 round.
// This must match exactly what validators sign on the hub side.
// Format: deterministic JSON with sorted pairs by pair_id.
//
// btcBlockHeight is the BTC chain-tip height the round was anchored to (the same
// value the hub captured in OracleConsensus.finalizeRound). It is part of the
// signed content AND the on-chain wire (PRICE|0|ROUND|TIMESTAMP|BTC_BLOCK_HEIGHT|...)
// so the indexer reconstructs the exact bytes the validators signed and gates the
// EQUIV header on the IDENTICAL BTC height every other engine uses. The
// EQUIV ROUND_ID is the BTC height (the real activation anchor), not the wall-clock
// round counter; the round counter stays in the signed JSON for round identity.
//
// `admitBlocks` is the round's admission map, the per-chain heights at which the round
// becomes readable: chain codes in ASCII order, each CODE:digits under the canonical
// integer spelling rule, joined by a comma and appended after a pipe. It must be the map
// the producer signed (parsed off the round being verified), never one rebuilt from this
// indexer's own view, or the bytes rebuilt here are not the bytes a validator signed.
// Omitted is the LEGACY round, which is every round below the activation.
function buildPriceV0Payload(round, timestamp, pairs, network, btcBlockHeight, admitBlocks) {
    let sortedPairs = pairs
        .map(p => ({ pair: p.coinPair || p.pair, price: String(p.price) }))
        .sort((a, b) => {
            if (a.pair < b.pair) return -1;
            if (a.pair > b.pair) return 1;
            return 0;
        });
    let raw = JSON.stringify({
        round:            parseInt(round),
        timestamp:        parseInt(timestamp),
        btc_block_height: parseInt(btcBlockHeight),
        pairs:            sortedPairs
    });
    // The admission map, height-gated on the round's OWN BTC anchor and never on this
    // indexer's height, so the era for a round is fixed when it is signed and the two eras
    // can never share a signature. Refuses in BOTH directions. Appended to the body BEFORE
    // the EQUIV wrapper, the same position every other rail puts it in, so the wrapper
    // stays a pure function of the bytes it wraps.
    raw += adm.admissionCanonicalField('buildPriceV0Payload', network, btcBlockHeight, admitBlocks);
    // EQUIV header: gated on the round's BTC block HEIGHT + network, identical to
    // every other engine and to the hub, so all services flip on the same anchor.
    // XORACLE has no view change -> VIEW=0. Below the flag-day, the bare JSON
    // (regression-safe; the height still rides in the signed content).
    if (eq.isEquivHeaderActive(btcBlockHeight, network))
        return eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE, parseInt(btcBlockHeight), 0, raw);
    return raw;
}

// Build the canonical signable payload for a PRICE batch: ONE signature set over
// several rounds. This must match exactly what the hub producer signs
// (OracleConsensus.buildPriceBatchPayload) and what the hub re-checks on ingest
// (PriceAggregator.buildPriceBatchPayload).
//
// `rounds` is [{ round, timestamp, btcBlockHeight, pairs }] and each `pairs` entry is
// { pair | coinPair, price }. The builder sorts the rounds ascending and normalizes each
// round's pairs itself rather than requiring sorted input: three twin call sites in two
// repos would otherwise each have to re-derive the ordering contract, and one of them
// getting it subtly wrong is exactly the divergence that stalls the federation.
//
// The EQUIV header is UNCONDITIONAL here, unlike buildPriceV0Payload's height gate. v0
// gates because it has pre-flag-day history whose bytes may not move; v2 has none (it is
// ungated and every network it runs on already has EQUIV active). The unwrapped bare-JSON form is also the exact shape that
// breaks SLASH's "an ORACLE-tagged canonical always carries `round`" invariant, which is
// why v2 carries its own engine tag. Do NOT "fix" this into a v0-style gate.
//
// Each round carries ITS OWN admission map (`admitBlocks`), era-keyed on that round's own
// anchor and never on the batch anchor: the map means "the heights at which THIS round's
// producer observed each chain", and the rounds in an hourly window were opened at
// different tips, so one map for the batch would sign a claim no producer made. In the
// admission era the entry gains a LAST key, `admit_blocks`, holding the same canonical
// spelling the v0 field uses (CODE:digits in ASCII order, comma-joined); below it the
// entry is byte-identical to the pre-admission form and a map is refused. `network` is
// half the activation key and absent reads INERT, so a caller that omits it rebuilds the
// legacy bytes and an admission-era batch then fails to verify rather than verifying
// as legacy.
function buildPriceBatchPayload(firstRound, lastRound, btcBlockHeight, rounds, network) {
    let sortedRounds = [...rounds]
        .sort((a, b) => parseInt(a.round) - parseInt(b.round))
        .map(r => {
            let pairs = r.pairs.map(p => ({ pair: p.coinPair || p.pair, price: String(p.price) }));
            let sortedPairs = [...pairs].sort((a, b) => {
                if (a.pair < b.pair) return -1;
                if (a.pair > b.pair) return 1;
                return 0;
            });
            let entry = {
                round:            parseInt(r.round),
                timestamp:        parseInt(r.timestamp),
                btc_block_height: parseInt(r.btcBlockHeight),
                pairs:            sortedPairs
            };
            let admit = adm.admissionCanonicalValue('buildPriceBatchPayload', network, parseInt(r.btcBlockHeight),
                                                    r.admitBlocks === undefined ? null : r.admitBlocks);
            if (admit !== null) entry.admit_blocks = admit;
            return entry;
        });
    let raw = JSON.stringify({
        first_round:      parseInt(firstRound),
        last_round:       parseInt(lastRound),
        btc_block_height: parseInt(btcBlockHeight),
        rounds:           sortedRounds
    });
    // ROUND_ID carries the batch anchor AND the round window: two honest batches that
    // split one window differently at the same anchor must not land on one equiv key,
    // which would read as equivocation. XORACLEB has no view change -> VIEW=0.
    let roundId = String(parseInt(btcBlockHeight)) + '|' +
                  String(parseInt(firstRound))     + '|' +
                  String(parseInt(lastRound));
    return eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, roundId, 0, raw);
}

module.exports = {
    pubkeyFromHex,
    verify,
    buildPriceV0Payload,
    buildPriceBatchPayload
};
