// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// The fixed-seed Ed25519 identities and the CAPTURED LITERALS the ATTEST v1
// response-verification vectors assert against
// (test/unit/actions/attest/attest_response_verify_vectors.test.js and its parts),
// moved here verbatim so every suite reads the one copy.

'use strict';

const crypto = require('crypto');

const srb     = require('../../../../../../src/consensus/snapshot_reorg_buffer.js');

// ---------------------------------------------------------------------------
// Deterministic Ed25519 identities from fixed 32-byte seeds.
// ---------------------------------------------------------------------------
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function keyFromSeed(seedByte) {
    const seed = Buffer.alloc(32, seedByte);
    const priv = crypto.createPrivateKey({
        key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8',
    });
    const spki = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' });
    // SPKI = 12-byte Ed25519 header + the 32 raw pubkey bytes.
    return { priv, pubkey: spki.subarray(12).toString('hex') };
}

const K1 = keyFromSeed(0x11);
const K2 = keyFromSeed(0x22);
const K3 = keyFromSeed(0x33);

// A format-valid signature that no key ever produced.
const JUNK_SIG = 'f'.repeat(128);

// Mixed-case on the wire on purpose: the ATTEST_CANONICAL_LOWERCASE_ID gate picks
// between these two spellings INSIDE the signed bytes, so a single-case id would
// make that vector prove nothing.
const REQ_ID_WIRE  = 'D'.repeat(32) + 'd'.repeat(32);
const REQ_ID_LOWER = REQ_ID_WIRE.toLowerCase();

const DECLARED_BLOCK = 90;                                        // the request's own block
const BURIED_BLOCK   = srb.buriedSnapshotBlock(DECLARED_BLOCK, 'regtest');   // 84
const DEADLINE_BLOCK = 200;

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// Rank the candidate keys the way computeResponsibleSet does, so a vector can say
// "sign with the validator that is NOT responsible" without hard-coding which of
// the three fixed keys that happens to be.
function rankByResponsibleHash(pubkeys, requestId) {
    return pubkeys
        .map(pk => ({
            pubkey: pk,
            hash: crypto.createHash('sha256').update(String(requestId), 'utf8').update(pk, 'utf8').digest('hex'),
        }))
        .sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))
        .map(v => v.pubkey);
}

const RANK3 = rankByResponsibleHash([K1.pubkey, K2.pubkey, K3.pubkey], REQ_ID_LOWER);
const KEY_BY_PUBKEY = {};
for (const k of [K1, K2, K3]) KEY_BY_PUBKEY[k.pubkey] = k;

// -----------------------------------------------------------------------
// CAPTURED LITERALS. Every string below was printed by this file's own
// capture run against the PRE-refactor handler. Do not "fix" one to make a
// test pass: a mismatch means the extracted verifier moved a consensus byte.
// -----------------------------------------------------------------------

// sha256 of the decoded body bytes ('hello'), the field the canonical signs.
const HASH_HELLO = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
// The EQUIV-wrapped canonical for the default vector (lower-case id gate ON,
// provider http_get, status ok, meta 'm'). The empty field between VIEW and the
// wrapped body is the header's own, captured verbatim rather than reasoned about.
const CANON_EQUIV_LOWER =
    'EQUIV|XATTEST|' + REQ_ID_LOWER + '|0||' + REQ_ID_LOWER + 'http_get' + HASH_HELLO + 'okm';
// The same round with the lower-case id gate OFF: the RAW wire spelling rides
// both the EQUIV ROUND_ID and the body.
const CANON_EQUIV_RAW =
    'EQUIV|XATTEST|' + REQ_ID_WIRE + '|0||' + REQ_ID_WIRE + 'http_get' + HASH_HELLO + 'okm';
// Below the EQUIV flag-day: the bare five-field concatenation, no header.
const CANON_BARE_LOWER = REQ_ID_LOWER + 'http_get' + HASH_HELLO + 'okm';

module.exports = {
    K1, K2, K3, JUNK_SIG, REQ_ID_WIRE, REQ_ID_LOWER,
    DECLARED_BLOCK, BURIED_BLOCK, DEADLINE_BLOCK, b64, RANK3, KEY_BY_PUBKEY,
    HASH_HELLO, CANON_EQUIV_LOWER, CANON_EQUIV_RAW, CANON_BARE_LOWER,
};
