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
 * Light-client / SPV Merkle primitives: the byte layer (SPV light-client spec §3)
 *
 * Version constants, RFC 6962-style domain separation, the frozen empty-subtree
 * table, and the canonical encodings and SMT key derivations (§3.1, §3.2, §4.2)
 * that every root in merkle.js is built from. Split out of merkle.js so the entry
 * stays within the file-size limit; the tree shapes (SMT, compressed proofs, fixed
 * binary Merkle, state root, block-content leaves) stay in the entry. Everything
 * here is CONSENSUS-CRITICAL: a changed byte changes every committed root.
 *
 * BYTE-ALIGNED TWIN, like its entry: this file is carried verbatim at
 * xchain-indexer/src/consensus/merkle/primitives.js (canonical),
 * xchain-explorer/src/consensus/merkle/primitives.js, xchain-sdk/src/merkle/primitives.js
 * and xchain-sync/src/merkle/primitives.js, always beside its merkle.js so the
 * entry's relative require is the same text in all four. It is declared in the
 * platform's frozen-twin set and refreshed by the same twin reconcile script as merkle.js.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');

// Bump ONLY on a deliberate scheme change (domain tags, encodings, tree shape).
// Folded into the committed *_version fields so two schemes can never compare
// equal. Independent of BLOCK_HASH_VERSION and STATE_HASH_VERSION.
const MERKLE_VERSION       = 1;
const STATE_ROOT_VERSION   = 1;   // top-level state_root layout (§4.1)
const BLOCK_MERKLE_VERSION = 1;   // per-block content root (§5)

const SMT_DEPTH = 256;            // key is a 256-bit SHA-256 digest (§4.1)

// ---- Domain separation (RFC 6962 style, §3.1) -------------------------------
const LEAF_PREFIX  = Buffer.from([0x00]);
const NODE_PREFIX  = Buffer.from([0x01]);
const EMPTY_PREFIX = Buffer.from([0x02]);
const NUL          = Buffer.from([0x00]);   // canonical field separator (§3.2)

function sha256(buf){ return crypto.createHash('sha256').update(buf).digest(); }

function toBuf(x){ return Buffer.isBuffer(x) ? x : Buffer.from(x, 'hex'); }
function toHex(x){ return Buffer.isBuffer(x) ? x.toString('hex') : x; }

// leafHash(bytes)       = SHA256(0x00 || bytes)
// nodeHash(left, right) = SHA256(0x01 || left || right)
function leafHash(bytes){
    const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
    return sha256(Buffer.concat([LEAF_PREFIX, b]));
}
function nodeHash(left, right){
    return sha256(Buffer.concat([NODE_PREFIX, toBuf(left), toBuf(right)]));
}

// ---- Empty-subtree constants (§3.1, frozen) ---------------------------------
// EMPTY[0] = SHA256(0x02 || "XCHAIN_EMPTY_LEAF"); EMPTY[h] = nodeHash(EMPTY[h-1], EMPTY[h-1]).
// EMPTY[h] is the root of an all-empty subtree of height h. EMPTY[SMT_DEPTH] is
// the root of a wholly empty depth-256 SMT (an empty/absent named sub-tree).
const EMPTY = (function buildEmpty(){
    const arr = new Array(SMT_DEPTH + 1);
    arr[0] = sha256(Buffer.concat([EMPTY_PREFIX, Buffer.from('XCHAIN_EMPTY_LEAF', 'utf8')]));
    for(let h = 1; h <= SMT_DEPTH; h++) arr[h] = nodeHash(arr[h - 1], arr[h - 1]);
    return arr;
})();
const EMPTY_SMT_ROOT = EMPTY[SMT_DEPTH];   // root of an empty depth-256 SMT

// ---- Canonical encodings (§3.2, consensus-critical) -------------------------

// Canonical amount: fixed 18 fractional digits, no sign, no exponent, no
// trailing-zero trimming beyond the fixed 18 dp. This is the single source of
// truth: the producer feeds raw balance strings (mathjs bcsub at scale 18)
// through here so indexer and sync agree regardless of upstream formatting.
// Negative is rejected (balances are never negative; §3.2). "0" => "0.000...000".
function canonicalAmount(input){
    if(typeof input !== 'string') throw new Error('merkle: amount must be a string, got ' + typeof input);
    const s = input.trim();
    if(!/^\d+(\.\d{1,18})?$/.test(s)) throw new Error('merkle: non-canonical amount "' + input + '"');
    let [intPart, fracPart = ''] = s.split('.');
    intPart  = intPart.replace(/^0+(?=\d)/, '');          // strip leading zeros, keep one
    fracPart = (fracPart + '0'.repeat(18)).slice(0, 18);  // right-pad to exactly 18
    return intPart + '.' + fracPart;
}

// 0x00-joined canonical field encoding. Injective only because every field is
// guaranteed free of the 0x00 byte (addresses base58/bech32, ticks + chain +
// network constrained alphanumerics; §3.2). Reject any 0x00-bearing field rather
// than silently produce an ambiguous preimage.
function joinFields(parts){
    const bufs = [];
    for(let i = 0; i < parts.length; i++){
        const b = Buffer.from(String(parts[i]), 'utf8');
        if(b.includes(0x00)) throw new Error('merkle: field contains 0x00, breaks injective join: ' + parts[i]);
        if(i) bufs.push(NUL);
        bufs.push(b);
    }
    return Buffer.concat(bufs);
}

// Key derivation: SHA256(domainTag || 0x00 || f1 || 0x00 || f2 || ...). Returns
// a 32-byte Buffer (the SMT path). domainTag is itself 0x00-separated from the
// first field, matching the §4.2 balance-key layout.
function smtKey(domainTag, fields){
    return sha256(joinFields([domainTag, ...fields]));
}
// balances_root key (§4.2): "XCHAIN_BAL" over (chain, network, address, tick).
function balanceKey(chain, network, address, tick){
    return smtKey('XCHAIN_BAL', [chain, network, address, tick]);
}
// Locked-escrow parallel leaf (§4.2, D2): same identity, "XCHAIN_ESC" domain.
function escrowKey(chain, network, address, tick){
    return smtKey('XCHAIN_ESC', [chain, network, address, tick]);
}
// stakes_root key (§4.1, BTC-only): "XCHAIN_STK" over (pubkey, capability).
function stakeKey(pubkey, capability){
    return smtKey('XCHAIN_STK', [pubkey, capability]);
}
// contract_state_root key (sub-tree spec §3 Stage A): "XCHAIN_CST" over
// (chain, network, contract_index, state_key).
//
// contract_index is String()d HERE rather than trusted from the call site: it is
// a BIGINT UNSIGNED, and a MariaDB driver may hand it back as a number, a string
// or a BigInt depending on its bigint options, which the indexer and the sync
// follower are not obliged to configure the same way. All three render to the
// same decimal text, so pinning the conversion in the derivation makes the key a
// function of the VALUE and not of each repo's driver config. Getting this wrong
// is invisible until the twins disagree on a root.
//
// state_key enters RAW. joinFields still throws on a 0x00-bearing key, which is
// deliberate: that is the same surface block_merkle_root has carried all along,
// and the fix is the VM-side NUL rejection, which must be ARMED before any Stage
// A height arms. The encoding route that would have made this total was
// considered and closed by operator decision.
function contractStateKey(chain, network, contractIndex, stateKey){
    return smtKey('XCHAIN_CST', [chain, network, String(contractIndex), stateKey]);
}
// SMT value leaf for an amount-valued key (balance / escrow): leafHash(amountString).
function amountLeaf(amount){
    return leafHash(canonicalAmount(amount));
}

module.exports = {
    // versions / constants
    MERKLE_VERSION, STATE_ROOT_VERSION, BLOCK_MERKLE_VERSION, SMT_DEPTH,
    EMPTY, EMPTY_SMT_ROOT,
    // hashing primitives
    sha256, leafHash, nodeHash, toBuf, toHex,
    // encodings
    canonicalAmount, joinFields, smtKey, balanceKey, escrowKey, stakeKey, contractStateKey, amountLeaf
};
