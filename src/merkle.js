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
 * Light-client / SPV Merkle primitives (spec: claude/reports/SPV-LIGHT-CLIENT-SPEC.md §3-§5)
 *
 * Pure, deterministic, DB-free cryptographic primitives for the additive state
 * commitment (balance/state SMT), the per-block content Merkle root, and the
 * fixed top-level state root. Everything here is CONSENSUS-CRITICAL once the
 * §6 flag-day activates: the indexer (producer, src/stateCommitment.js) and the
 * xchain-sync follower (twin, src/BlockHasher.js) MUST compute byte-identical
 * roots from it, exactly as db.js getBlockHashes and BlockHasher are a pair.
 *
 * BYTE-ALIGNED TWIN: this file is copied verbatim into xchain-sync/src/merkle.js
 * (and a subset into xchain-sdk for client-side verification). Keep them
 * identical; the merkle-vectors golden + the xchain-e2e recompute-conformance
 * scenario guard the pair. Do not introduce wall-clock, locale, or float
 * dependence: SHA-256 over explicit byte layouts only.
 *
 * Hardening (vs the legacy unsigned xchain-sync/src/MerkleTree.js, which is NOT
 * second-preimage safe and is audit-only): RFC 6962-style domain separation on
 * leaves (0x00) and internal nodes (0x01), a distinct empty-leaf constant (0x02),
 * fixed-shape trees (no Bitcoin duplicate-last for odd layers). See spec §2.6, §3.1.
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
// and the fix is the VM-side NUL rejection ( -> ), which must be
// ARMED before any Stage A height arms. The encoding route that would have made
// this total was considered and closed by operator decision.
function contractStateKey(chain, network, contractIndex, stateKey){
    return smtKey('XCHAIN_CST', [chain, network, String(contractIndex), stateKey]);
}
// SMT value leaf for an amount-valued key (balance / escrow): leafHash(amountString).
function amountLeaf(amount){
    return leafHash(canonicalAmount(amount));
}

// ---- stakes_root value leaves (validator-set proof, spec §7) -----------------
// The weighted quorum (stake_weighted_quorum.meetsStakeThreshold) is SOURCE-deduped:
// 3·Σ(distinct signer-source weight) > 2·S, with S = Σ over distinct sources. So the
// stakes_root must let a light client (a) recover each signer's SOURCE (to dedupe)
// and (b) read the committed total S. Two leaf kinds, both keyed by stakeKey():
//   member: stakeKey(pubkey, capability)      -> stakeMemberLeaf(source, weight)
//   total:  stakeKey(STAKE_TOTAL_PUBKEY, cap) -> stakeTotalLeaf(S)
// STAKE_TOTAL_PUBKEY cannot collide with a real signer (pubkeys are 64-hex).
const STAKE_TOTAL_PUBKEY = '__total__';
function stakeMemberLeaf(source, weight){
    return leafHash(joinFields(['STK', source, canonicalAmount(weight)]));
}
function stakeTotalLeaf(total){
    return leafHash(joinFields(['STKTOTAL', canonicalAmount(total)]));
}
// Exact sum of canonical 18-dp amounts via integer (BigInt) scaling, so the
// source-deduped total S is byte-identical across the indexer + xchain-sync twins
// regardless of each repo's bignumber config. Returns a canonicalAmount string.
function sumCanonicalAmounts(amounts){
    let acc = 0n;
    for(const a of (amounts || [])){
        const [i, f] = canonicalAmount(String(a)).split('.');
        acc += BigInt(i) * 1000000000000000000n + BigInt(f);
    }
    const s    = acc.toString();
    const frac = s.length > 18 ? s.slice(-18) : s.padStart(18, '0');
    let   intp = s.length > 18 ? s.slice(0, -18) : '0';
    intp = intp.replace(/^0+(?=\d)/, '');
    return intp + '.' + frac;
}

// ---- Bit access on a key path (MSB-first) -----------------------------------
function bitAt(keyBuf, i){
    return (keyBuf[i >> 3] >> (7 - (i & 7))) & 1;
}

// ---- Sparse Merkle Tree (reference, in-memory; §4.1) ------------------------
// Depth-256, empty-subtree-cached. This is the reference shape the indexer's
// persistent, incremental state_tree_nodes implementation MUST match root-for-
// root. Absence == zero (no leaf): "A holds 0 of T" is a non-inclusion proof.

function _smtNode(entries, depth){
    if(entries.length === 0) return EMPTY[SMT_DEPTH - depth];
    if(depth === SMT_DEPTH)  return entries[0].leaf;     // unique 256-bit path
    const left = [], right = [];
    for(const e of entries) (bitAt(e.key, depth) === 0 ? left : right).push(e);
    return nodeHash(_smtNode(left, depth + 1), _smtNode(right, depth + 1));
}

class SparseMerkleTree {
    constructor(){ this._leaves = new Map(); }   // keyHex -> value-leaf hex (32B)

    // Set a key's value leaf. Pass null/undefined to DELETE (return-to-zero;
    // delete-on-zero is normative, §4.2). Storing a zero-valued leaf is wrong;
    // callers must delete instead.
    set(keyBuf, leafBufOrNull){
        const k = toHex(keyBuf);
        if(leafBufOrNull == null) this._leaves.delete(k);
        else this._leaves.set(k, toHex(leafBufOrNull));
    }
    delete(keyBuf){ this._leaves.delete(toHex(keyBuf)); }
    has(keyBuf){ return this._leaves.has(toHex(keyBuf)); }
    get size(){ return this._leaves.size; }

    _entries(){
        const out = [];
        for(const [k, v] of this._leaves) out.push({ key: Buffer.from(k, 'hex'), leaf: Buffer.from(v, 'hex') });
        return out;
    }

    root(){ return _smtNode(this._entries(), 0); }
    rootHex(){ return toHex(this.root()); }

    // Membership or non-membership proof for a key. Always 256 siblings (top-down,
    // siblings[d] is the sibling at depth d). leaf_value is the present value leaf
    // (membership) or null (non-membership, verifier substitutes EMPTY[0]).
    prove(keyBuf){
        const key = toBuf(keyBuf);
        const siblings = [];
        let level = this._entries();
        for(let depth = 0; depth < SMT_DEPTH; depth++){
            const left = [], right = [];
            for(const e of level) (bitAt(e.key, depth) === 0 ? left : right).push(e);
            const goRight   = bitAt(key, depth) === 1;
            const sibEntries = goRight ? left : right;
            siblings.push(toHex(_smtNode(sibEntries, depth + 1)));
            level = goRight ? right : left;
        }
        const k = toHex(key);
        const leafValue = this._leaves.has(k) ? this._leaves.get(k) : null;
        return { key: k, leaf_value: leafValue, siblings, compressed: compressSmtProof(siblings) };
    }
}

// Verify an SMT proof against an explicit expected root. leafValueOrNull: hex
// value leaf for membership, null for non-membership. Rejects on mismatch.
function verifySmtProof(rootHex, keyBuf, leafValueOrNull, siblings){
    if(!Array.isArray(siblings) || siblings.length !== SMT_DEPTH) return false;
    const key = toBuf(keyBuf);
    let node = leafValueOrNull == null ? EMPTY[0] : toBuf(leafValueOrNull);
    for(let depth = SMT_DEPTH - 1; depth >= 0; depth--){
        const sib = toBuf(siblings[depth]);
        node = bitAt(key, depth) === 0 ? nodeHash(node, sib) : nodeHash(sib, node);
    }
    return toHex(node) === toHex(rootHex);
}

// ---- Compressed SMT proof (§3.1, normative wire form) -----------------------
// 256-bit bitmap (MSB = depth 0, nearest root); set bit => a real sibling is
// present, clear bit => the sibling is the constant EMPTY[height] for that depth.
// The sibling at depth d roots a subtree of height (255 - d), so its empty
// constant is EMPTY[255 - d].
function compressSmtProof(siblings){
    const bitmap = Buffer.alloc(32);
    const real = [];
    for(let d = 0; d < SMT_DEPTH; d++){
        const sib = toBuf(siblings[d]);
        if(!sib.equals(EMPTY[SMT_DEPTH - 1 - d])){
            bitmap[d >> 3] |= (1 << (7 - (d & 7)));
            real.push(toHex(sib));
        }
    }
    return { bitmap: bitmap.toString('hex'), siblings: real };
}
function decompressSmtProof(compressed){
    const bitmap = toBuf(compressed.bitmap);
    const real = compressed.siblings;
    const out = new Array(SMT_DEPTH);
    let ri = 0;
    for(let d = 0; d < SMT_DEPTH; d++){
        const set = (bitmap[d >> 3] >> (7 - (d & 7))) & 1;
        out[d] = set ? real[ri++] : toHex(EMPTY[SMT_DEPTH - 1 - d]);
    }
    if(ri !== real.length) throw new Error('merkle: surplus siblings in compressed proof');
    return out;
}
function verifyCompressedSmtProof(rootHex, keyBuf, leafValueOrNull, compressed){
    return verifySmtProof(rootHex, keyBuf, leafValueOrNull, decompressSmtProof(compressed));
}

// ---- Fixed binary Merkle (top state root + block-content root) --------------
// Bottom-up over a vector of 32-byte node values, padded to a power of two with
// EMPTY[0]. Combined with nodeHash. Leaves are already-hashed values (sub-roots
// for the state tree, leafHash(rowEncoding) for the block tree).
function _nextPow2(n){ let p = 1; while(p < n) p <<= 1; return p; }

function fixedMerkleRoot(leaves){
    if(leaves.length === 0) return EMPTY[0];
    let layer = leaves.map(toBuf);
    const width = _nextPow2(layer.length);
    while(layer.length < width) layer.push(EMPTY[0]);
    while(layer.length > 1){
        const next = [];
        for(let i = 0; i < layer.length; i += 2) next.push(nodeHash(layer[i], layer[i + 1]));
        layer = next;
    }
    return layer[0];
}

// Inclusion proof in a fixed binary Merkle: bottom-up siblings + the leaf index.
function fixedMerkleProof(leaves, index){
    if(index < 0 || index >= leaves.length) throw new Error('merkle: index out of range');
    let layer = leaves.map(toBuf);
    const width = _nextPow2(layer.length);
    while(layer.length < width) layer.push(EMPTY[0]);
    const siblings = [];
    let idx = index;
    while(layer.length > 1){
        const sibIdx = idx ^ 1;
        siblings.push(toHex(layer[sibIdx]));
        const next = [];
        for(let i = 0; i < layer.length; i += 2) next.push(nodeHash(layer[i], layer[i + 1]));
        layer = next;
        idx >>= 1;
    }
    return { index, siblings };
}
function verifyFixedMerkleProof(rootHex, leafBuf, index, siblings){
    let node = toBuf(leafBuf);
    let idx = index;
    for(const sib of siblings){
        node = (idx & 1) === 0 ? nodeHash(node, toBuf(sib)) : nodeHash(toBuf(sib), node);
        idx >>= 1;
    }
    return toHex(node) === toHex(rootHex);
}

// ---- Top-level state root (§4.1) --------------------------------------------
// Fixed, ordered list of named sub-tree roots. A named-but-absent/disabled
// sub-tree uses the empty-SMT root EMPTY[SMT_DEPTH]; structural padding to the
// next power of two uses EMPTY[0] (handled by fixedMerkleRoot). v1 commits
// balances + stakes; the rest are EMPTY until a later state_root_version (§10 D1).
const STATE_SUBTREES = ['balances_root', 'stakes_root', 'ownership_root', 'tokens_root', 'contract_state_root'];

function stateRoot(subRoots){
    const leaves = STATE_SUBTREES.map(name => (subRoots && subRoots[name]) ? toBuf(subRoots[name]) : EMPTY_SMT_ROOT);
    return fixedMerkleRoot(leaves);
}
// Proof that one named sub-root is committed in state_root (the §4.4 sub_root_path).
function stateRootProof(subRoots, name){
    const idx = STATE_SUBTREES.indexOf(name);
    if(idx < 0) throw new Error('merkle: unknown state sub-tree ' + name);
    const leaves = STATE_SUBTREES.map(n => (subRoots && subRoots[n]) ? toBuf(subRoots[n]) : EMPTY_SMT_ROOT);
    return fixedMerkleProof(leaves, idx);
}

// ---- Per-block content leaves (§5.1) ----------------------------------------
// Frozen cross-kind total order (§5.1): all ledger leaves, then actions, then
// contracts; within each kind the existing getBlockHashes deterministic order.
// tx_index NULL is encoded as the empty string (block-hash covers tx-NULL rows).
// Amount is hashed as the RAW stored string (not canonicalAmount): block_merkle_root
// is a content commitment over the exact rows, in parity with the consensus
// ledger_hash, which also hashes the stored amount string. This is required for
// correctness, not just style: escrow rows are legitimately NEGATIVE (the release
// idiom: a +amount lock is offset by a -amount release row, so SUM(escrows)=locked),
// and the non-negative canonicalAmount throws on them. The stored string is already
// deterministic (createLedgerChangeRecord rounds to tick decimals + mathjs String()),
// matching contractLeaf, which likewise hashes its amount fields raw.
function ledgerLeaf(row){
    return leafHash(joinFields(['L', row.kind, row.action_index, row.address, row.tick, row.amount]));
}
function actionsLeaf(row){
    const txi = (row.tx_index == null) ? '' : row.tx_index;
    return leafHash(joinFields(['A', row.action_index, txi, row.action]));
}
function contractLeaf(subTable, fields){
    return leafHash(joinFields(['C', subTable, ...fields]));
}
// Combined block-content root over an already-ordered leaf vector (§5).
function blockMerkleRoot(orderedLeaves){
    return fixedMerkleRoot(orderedLeaves);
}
// Build the ordered block-content leaf vector from the canonical per-block rows
// (the db.getBlockLeafRows shape: { ledger:{credits,debits,escrows}, actions,
// contracts:{contracts,state,executions,emissions,deposits,withdrawals} }) in the
// frozen cross-kind total order (§5.1): all ledger leaves (credit, debit, escrow),
// then actions, then the six contract sub-tables, each in the deterministic order
// getBlockHashes gathered them. Null fields coerce to '' (matching actionsLeaf's
// tx_index). This is the SINGLE source of the cross-kind ordering: the indexer
// commits block_merkle_root with it and the explorer proof server locates a row's
// leaf index with it, both reading this twin-guarded module so the order can never
// drift between commit and proof. The leaf index an inclusion proof returns is
// position-defined here, so the order is consensus-critical and golden-vectored.
function blockMerkleLeaves(rows){
    const _c = (x) => (x == null) ? '' : x;
    const leaves = [];
    const L = (rows && rows.ledger) || {};
    for(const kind of ['credit', 'debit', 'escrow']){
        const arr = L[kind + 's'] || [];   // credits / debits / escrows
        for(const r of arr)
            leaves.push(ledgerLeaf({ kind, action_index: r.action_index,
                address: _c(r.address), tick: _c(r.tick), amount: r.amount }));
    }
    for(const r of ((rows && rows.actions) || []))
        leaves.push(actionsLeaf({ action_index: r.action_index, tx_index: r.tx_index, action: _c(r.action) }));
    const C = (rows && rows.contracts) || {};
    for(const r of (C.contracts || []))
        leaves.push(contractLeaf('contracts', [r.action_index, _c(r.source_address), _c(r.code_hash), _c(r.status)]));
    for(const r of (C.state || []))
        leaves.push(contractLeaf('state', [r.contract_index, _c(r.state_key), _c(r.state_value)]));
    for(const r of (C.executions || []))
        leaves.push(contractLeaf('executions', [r.action_index, r.contract_index, _c(r.caller_address), _c(r.gas_used), _c(r.status), _c(r.emitted_count)]));
    for(const r of (C.emissions || []))
        leaves.push(contractLeaf('emissions', [r.execution_index, _c(r.emitted_action), r.action_index, r.position]));
    for(const r of (C.deposits || []))
        leaves.push(contractLeaf('deposits', [r.action_index, r.contract_index, _c(r.source_address), _c(r.tick), r.amount, _c(r.status)]));
    for(const r of (C.withdrawals || []))
        leaves.push(contractLeaf('withdrawals', [r.action_index, r.contract_index, _c(r.source_address), _c(r.tick), r.amount, _c(r.status)]));
    return leaves;
}

module.exports = {
    // versions / constants
    MERKLE_VERSION, STATE_ROOT_VERSION, BLOCK_MERKLE_VERSION, SMT_DEPTH,
    EMPTY, EMPTY_SMT_ROOT, STATE_SUBTREES,
    // hashing primitives
    sha256, leafHash, nodeHash, toBuf, toHex,
    // encodings
    canonicalAmount, joinFields, smtKey, balanceKey, escrowKey, stakeKey, contractStateKey, amountLeaf, bitAt,
    STAKE_TOTAL_PUBKEY, stakeMemberLeaf, stakeTotalLeaf, sumCanonicalAmounts,
    // SMT
    SparseMerkleTree, verifySmtProof,
    compressSmtProof, decompressSmtProof, verifyCompressedSmtProof,
    // fixed Merkle + state root
    fixedMerkleRoot, fixedMerkleProof, verifyFixedMerkleProof,
    stateRoot, stateRootProof,
    // block content
    ledgerLeaf, actionsLeaf, contractLeaf, blockMerkleRoot, blockMerkleLeaves
};
