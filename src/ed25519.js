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
 * Mirrors the format used by xchain-hub/src/ValidatorIdentity.js so
 * signatures produced by validators can be verified by indexers.
 *
 ********************************************************************/

const crypto = require('crypto');
const eq     = require('./equivocation_header.js');

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
function buildPriceV0Payload(round, timestamp, pairs, network, btcBlockHeight) {
    let sortedPairs = [...pairs].sort((a, b) => {
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
    // EQUIV header: gated on the round's BTC block HEIGHT + network, identical to
    // every other engine and to the hub, so all services flip on the same anchor.
    // XORACLE has no view change -> VIEW=0. Below the flag-day, the bare JSON
    // (regression-safe; the height still rides in the signed content).
    if (eq.isEquivHeaderActive(btcBlockHeight, network))
        return eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE, parseInt(btcBlockHeight), 0, raw);
    return raw;
}

module.exports = {
    pubkeyFromHex,
    verify,
    buildPriceV0Payload
};
