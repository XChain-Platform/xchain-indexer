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
 * XChain Indexer - Ed25519 Helper
 *
 * Verification of Ed25519 signatures using Node.js built-in crypto.
 * Mirrors the format used by xchain-hub/src/ValidatorIdentity.js so
 * signatures produced by validators can be verified by indexers.
 *
 ********************************************************************/

const crypto = require('crypto');

// ASN.1 DER prefix for Ed25519 SPKI (SubjectPublicKeyInfo) — 12 bytes
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
function buildPriceV0Payload(round, timestamp, pairs) {
    let sortedPairs = [...pairs].sort((a, b) => {
        if (a.pair < b.pair) return -1;
        if (a.pair > b.pair) return 1;
        return 0;
    });
    return JSON.stringify({
        round:     parseInt(round),
        timestamp: parseInt(timestamp),
        pairs:     sortedPairs
    });
}

module.exports = {
    pubkeyFromHex,
    verify,
    buildPriceV0Payload
};
