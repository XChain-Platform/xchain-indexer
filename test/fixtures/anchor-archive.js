'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Publisher-faithful ANCHOR archive builder, shared between the AnchorRecovery
// unit round-trip (test/unit/recovery/recovery.test.js) and the recovery-determinism
// integration e2e (test/integration/recovery_determinism_e2e.test.js). Builds an
// archive batch exactly as the hub's StateAnchorPublisher serializes it (fixed key
// order, gzip+base64url, CRC32, chunking, REAL Ed25519 signatures + EQUIV canonical),
// so a single source pins the serialization both tests verify against.

const crypto = require('crypto');
const zlib   = require('zlib');
const eq     = require('../../src/consensus/equivocation_header.js');
const ed25519 = require('../../src/consensus/ed25519.js');
const gateRegistry = require('../../src/consensus/gate_registry');
const bridgeSettle = require('../../src/consensus/bridge_settle.js');
const CROSS_CHAIN_ROYALTY_KEY = 'cross_chain_royalty_activation.CROSS_CHAIN_ROYALTY_ACTIVATION';
const CHECKPOINT_COMMITMENT_KEY = 'checkpoint_commitment_activation.CHECKPOINT_COMMITMENT_ACTIVATION';

// ── Real Ed25519 helpers ────────────────────────────────────────────────────
function makeKeypair() {
    let { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pubkey: publicKey.export({ format: 'der', type: 'spki' }).slice(12).toString('hex'), privateKey };
}
function signHex(kp, payload) {
    return crypto.sign(null, Buffer.from(payload, 'utf8'), kp.privateKey).toString('hex');
}

// ── Publisher-faithful serialization (MATCH_KEYS order) ─────────────────────
const MATCH_KEYS = ['match_id', 'snapshot_block', 'network',
    'a_chain', 'a_action_index', 'a_kind', 'a_tick', 'a_amount', 'a_filled_before', 'a_ownership', 'a_payout_addr', 'a_payout_legs',
    'b_chain', 'b_action_index', 'b_kind', 'b_tick', 'b_amount', 'b_filled_before', 'b_ownership', 'b_payout_addr', 'b_payout_legs',
    'effective_time', 'finalizing_view', 'validator_signatures', 'status'];
function serializeMatch(m) {
    let out = {};
    for (let k of MATCH_KEYS) {
        let v = m[k];
        if (k === 'a_action_index' || k === 'b_action_index' || k === 'snapshot_block' || k === 'effective_time') out[k] = Number(v);
        else if (k === 'finalizing_view') out[k] = Number(v) || 0;
        else if (k === 'a_ownership' || k === 'b_ownership') out[k] = Number(v) ? 1 : 0;
        else if (k === 'a_tick' || k === 'b_tick') out[k] = (v == null) ? null : String(v);
        else if (k === 'a_payout_legs' || k === 'b_payout_legs') { if (v != null) out[k] = String(v); }  // omit-when-null (hub parity)
        else out[k] = String(v == null ? '' : v);
    }
    return out;
}
function matchCanonical(m) {
    let raw = ['XMATCH', m.match_id, String(m.snapshot_block),
        m.a_chain, String(m.a_action_index), m.a_tick || '', String(m.a_amount), String(m.a_ownership), m.a_payout_addr,
        m.b_chain, String(m.b_action_index), m.b_tick || '', String(m.b_amount), String(m.b_ownership), m.b_payout_addr,
        String(m.effective_time), m.network || '',
        m.a_kind || 'swap', String(m.a_filled_before != null ? m.a_filled_before : '0'),
        m.b_kind || 'swap', String(m.b_filled_before != null ? m.b_filled_before : '0')].join('|');
    // Royalty legs ride the signed match at/above CROSS_CHAIN_ROYALTY (regtest genesis).
    if (gateRegistry.activeAt(CROSS_CHAIN_ROYALTY_KEY, m.network, null, m.snapshot_block, null))
        raw += '|' + String(m.a_payout_legs || '') + '|' + String(m.b_payout_legs || '');
    // EQUIV active in regtest: TAG=XDEX, ROUND_ID=match_id, VIEW=finalizing_view (default 0).
    if (eq.isEquivHeaderActive(m.snapshot_block, m.network))
        return eq.buildEquivCanonical(eq.ENGINE_TAGS.DEX, m.match_id, (m.finalizing_view != null ? m.finalizing_view : 0), raw);
    return raw;
}
// ── Publisher-faithful XCALL serialization (CALL_KEYS order) ────────────────
const CALL_KEYS = ['id', 'call_id', 'phase', 'snapshot_block', 'network',
    'source_chain', 'source_action_index', 'source_contract_index',
    'target_chain', 'target_contract_index', 'method', 'params_json',
    'gas_limit', 'cross_hops', 'effective_time', 'finalizing_view', 'result_status',
    'return_payload_b64', 'validator_signatures', 'status'];
function serializeCall(c) {
    let out = {};
    for (let k of CALL_KEYS) {
        let v = c[k];
        if (k === 'id' || k === 'snapshot_block' || k === 'source_action_index' || k === 'source_contract_index' ||
            k === 'target_contract_index' || k === 'gas_limit' || k === 'cross_hops' || k === 'effective_time')
            out[k] = Number(v);
        else if (k === 'finalizing_view')
            out[k] = Number(v) || 0;
        else if (k === 'result_status' || k === 'return_payload_b64')
            out[k] = (v == null) ? null : String(v);
        else
            out[k] = String(v == null ? '' : v);
    }
    return out;
}

const BRIDGE_KEYS = ['id', 'transfer_id', 'snapshot_block', 'network',
    'src_chain', 'src_action_index', 'src_address', 'dest_chain', 'dest_address',
    'tick', 'decimals', 'amount', 'effective_time',
    'admit_block_btc', 'admit_block_ltc', 'admit_block_doge',
    'finalizing_view', 'validator_signatures', 'status'];
const POLICY_KEYS = ['id', 'snapshot_id', 'snapshot_block', 'network',
    'origin_chain', 'tick', 'policy_seq', 'origin_block', 'policy_hash',
    'allow_list', 'block_list', 'sleeping', 'effective_time',
    'admit_block_btc', 'admit_block_ltc', 'admit_block_doge',
    'finalizing_view', 'validator_signatures', 'status'];
const CHECKPOINT_KEYS = ['id', 'chain', 'network', 'block_index', 'block_hash',
    'ledger_hash', 'actions_hash', 'contract_hash', 'checkpoint_seq', 'snapshot_block',
    'state_root', 'state_root_version', 'block_merkle_root', 'block_merkle_version',
    'validator_signatures'];
const PRICE_KEYS = ['id', 'round_number', 'coin_pair', 'price', 'reference_block',
    'reference_chain', 'block_timestamp', 'validator_count', 'consensus_round',
    'consensus_proof', 'status', 'source_chain', 'source_action_index', 'batch_block_time',
    'admit_block_btc', 'admit_block_ltc', 'admit_block_doge'];
const ARCHIVE_INTEGER_KEYS = new Set(['id', 'snapshot_block', 'src_action_index', 'decimals',
    'effective_time', 'policy_seq', 'origin_block', 'block_index', 'checkpoint_seq',
    'round_number', 'reference_block', 'block_timestamp', 'validator_count', 'consensus_round',
    'batch_block_time']);
const ARCHIVE_NULLABLE_INTS = new Set(['admit_block_btc', 'admit_block_ltc', 'admit_block_doge',
    'state_root_version', 'block_merkle_version', 'source_action_index']);
const ARCHIVE_NULLABLE_TEXT = new Set(['allow_list', 'block_list', 'state_root',
    'block_merkle_root', 'price']);

function serializeQuorumRow(keys, row) {
    let out = {};
    for (let key of keys) {
        let value = row[key];
        if (ARCHIVE_INTEGER_KEYS.has(key)) out[key] = Number(value);
        else if (ARCHIVE_NULLABLE_INTS.has(key)) out[key] = value == null ? null : Number(value);
        else if (key === 'finalizing_view') out[key] = Number(value) || 0;
        else if (key === 'sleeping') out[key] = Number(value) ? 1 : 0;
        else if (key === 'validator_signatures' || key === 'consensus_proof') out[key] = value;
        else if (ARCHIVE_NULLABLE_TEXT.has(key)) out[key] = value == null ? null : String(value);
        else out[key] = String(value == null ? '' : value);
    }
    return out;
}

function checkpointCanonical(cp) {
    let raw = ['XCHECKPOINT', cp.chain, cp.network, String(cp.block_index), cp.block_hash,
        cp.ledger_hash, cp.actions_hash, cp.contract_hash,
        String(cp.checkpoint_seq), String(cp.snapshot_block)].join('|');
    if (gateRegistry.activeAt(CHECKPOINT_COMMITMENT_KEY, cp.network, null, cp.snapshot_block, null) &&
        cp.state_root != null && cp.block_merkle_root != null &&
        cp.state_root_version != null && cp.block_merkle_version != null)
        raw += '|' + [String(cp.state_root).toLowerCase(), String(cp.state_root_version),
            String(cp.block_merkle_root).toLowerCase(), String(cp.block_merkle_version)].join('|');
    if (eq.isEquivHeaderActive(cp.snapshot_block, cp.network))
        return eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT,
            cp.chain + '|' + cp.network + '|' + cp.block_index + '|' + cp.checkpoint_seq, 0, raw);
    return raw;
}

function priceAdmitBlocks(row) {
    if (row.admit_block_btc == null && row.admit_block_ltc == null && row.admit_block_doge == null) return null;
    return { BTC: row.admit_block_btc, LTC: row.admit_block_ltc, DOGE: row.admit_block_doge };
}

function signPriceRows(rows, keys, signers) {
    let byRound = new Map();
    for (let raw of rows) {
        let row = Object.assign({}, raw);
        let key = String(row.round_number);
        if (!byRound.has(key)) byRound.set(key, []);
        byRound.get(key).push(row);
    }
    let out = [];
    for (let group of byRound.values()) {
        if (group.every(row => row.consensus_proof === undefined && row.status === 'finalized')) {
            let first = group[0];
            let pairs = group.map(row => ({ coinPair: row.coin_pair, price: row.price }));
            let canonical = ed25519.buildPriceV0Payload(first.round_number, first.block_timestamp,
                pairs, first.network || 'regtest', first.reference_block, priceAdmitBlocks(first));
            let proof = JSON.stringify(keys.slice(0, signers || 3)
                .map(kp => ({ pubkey: kp.pubkey, sig: signHex(kp, canonical) })));
            for (let row of group) row.consensus_proof = proof;
        }
        for (let row of group) out.push(serializeQuorumRow(PRICE_KEYS, row));
    }
    return out;
}

function signQuorumRows(rows, keys, canonical, crossKeys, signers) {
    return rows.map(raw => {
        let row = Object.assign({}, raw);
        row.validator_signatures = JSON.stringify(crossKeys.slice(0, signers || 3)
            .map(kp => ({ pubkey: kp.pubkey, sig: signHex(kp, canonical(row)) })));
        return serializeQuorumRow(keys, row);
    });
}
// Byte-identical to recovery.callCanonical / hub StateAnchorPublisher.callCanonical.
function callCanonical(c) {
    let sha = (s) => crypto.createHash('sha256').update(String(s == null ? '' : s), 'utf8').digest('hex');
    let phase = (c.phase === 'result') ? 'result' : 'dispatch';
    let raw;
    if (c.phase === 'result') {
        raw = ['XCALL', 'RESULT', c.call_id, String(c.snapshot_block), c.network || '',
            c.target_chain, String(c.result_status || ''),
            sha(c.return_payload_b64), String(c.effective_time)].join('|');
    } else {
        raw = ['XCALL', 'DISPATCH', c.call_id, String(c.snapshot_block), c.network || '',
            c.source_chain, String(c.source_action_index), String(c.source_contract_index),
            c.target_chain, String(c.target_contract_index),
            c.method, sha(c.params_json),
            String(c.gas_limit), String(c.cross_hops), String(c.effective_time)].join('|');
    }
    // EQUIV active in regtest: TAG=XCALL, ROUND_ID=sha256('XCALLROUND|'+phase+'|'+call_id), VIEW=finalizing_view.
    if (eq.isEquivHeaderActive(c.snapshot_block, c.network))
        return eq.buildEquivCanonical(eq.ENGINE_TAGS.XCALL, sha('XCALLROUND|' + phase + '|' + c.call_id), (c.finalizing_view != null ? c.finalizing_view : 0), raw);
    return raw;
}

function crc32Hex(str) {
    let buf = Buffer.from(str, 'utf8');
    let n;
    if (zlib.crc32) n = zlib.crc32(buf);
    else {
        let c, crc = 0xFFFFFFFF;
        for (let i = 0; i < buf.length; i++) {
            c = (crc ^ buf[i]) & 0xFF;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            crc = (crc >>> 8) ^ c;
        }
        n = (crc ^ 0xFFFFFFFF) >>> 0;
    }
    return (n >>> 0).toString(16).padStart(8, '0');
}

const SNAPSHOT_BLOCK = 100;
const CP = { chain: 'BTC', network: 'regtest', block_index: 494, block_hash: 'c0'.repeat(32),
             ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
             checkpoint_seq: 7 };

// Build a full signed batch: match rows signed by crossKeys, archive JSON with
// both capability sets (+ optional rewards/calls), wrapper v1 (+ optional v2 chunks)
// signed by oracleKeys. Returns { v1, v2s } shaped as anchor_actions rows.
function buildBatch(batchSeq, rawMatches, oracleKeys, crossKeys, opts) {
    opts = opts || {};
    let matches = rawMatches.map(rm => {
        let m = Object.assign({}, rm);
        let canon = matchCanonical(m);
        m.validator_signatures = JSON.stringify(crossKeys.slice(0, opts.matchSigners || 3)
            .map(kp => ({ pubkey: kp.pubkey, sig: signHex(kp, canon) })));
        return serializeMatch(m);
    });
    let snaps = [];
    // Distinct source per signing key (no DELEGATE) at equal weight → the
    // weighted threshold mirrors the legacy 2f+1 count. opts.snapAmount raises that
    // shared weight, which is how a test models an archive a hub built at a
    // GOVERNANCE MIN_STAKE above this node's local floor.
    let snapAmount = String(opts.snapAmount != null ? opts.snapAmount : '5');
    // opts.snapSourceFor(pubkey) overrides the SOURCE an archived row claims for a key.
    // Default is the per-key formula above; a test models a KEY-BINDING forge by pointing
    // an attacker key at an honest validator's source, leaving the amount untouched.
    let sourceFor = opts.snapSourceFor || (pk => 'src_' + pk.slice(0, 16));
    for (let kp of crossKeys)  snaps.push({ snapshot_block: SNAPSHOT_BLOCK, capability: 'cross_chain',    signing_pubkey: kp.pubkey, source: sourceFor(kp.pubkey), amount: snapAmount });
    for (let kp of oracleKeys) snaps.push({ snapshot_block: SNAPSHOT_BLOCK, capability: 'oracle_publish', signing_pubkey: kp.pubkey, source: sourceFor(kp.pubkey), amount: snapAmount });
    let callKeys = opts.callKeys || crossKeys;   // calls must be signed by the cross_chain set
    let calls = (opts.calls || []).map(rc => {
        let c = Object.assign({}, rc);
        let canon = callCanonical(c);
        c.validator_signatures = JSON.stringify(callKeys.slice(0, opts.callSigners || 3)
            .map(kp => ({ pubkey: kp.pubkey, sig: signHex(kp, canon) })));
        return serializeCall(c);
    });
    let bridges = signQuorumRows(opts.bridges || [], BRIDGE_KEYS,
        row => bridgeSettle.transferCanonical(row), opts.bridgeKeys || crossKeys, opts.bridgeSigners);
    let policies = signQuorumRows(opts.policies || [], POLICY_KEYS,
        row => bridgeSettle.policyCanonical(row), opts.policyKeys || crossKeys, opts.policySigners);
    let checkpoints = signQuorumRows(opts.checkpoints || [], CHECKPOINT_KEYS,
        checkpointCanonical, opts.checkpointKeys || oracleKeys, opts.checkpointSigners);
    let priceKeys = opts.priceKeys || oracleKeys;
    let prices = signPriceRows(opts.prices || [], opts.priceSignKeys || priceKeys, opts.priceSigners);
    let checkpointBlocks = new Set(checkpoints.map(cp => Number(cp.snapshot_block)));
    checkpointBlocks.delete(SNAPSHOT_BLOCK);
    for (let block of checkpointBlocks) {
        for (let kp of oracleKeys) snaps.push({ snapshot_block: block, capability: 'oracle_publish',
            signing_pubkey: kp.pubkey, source: sourceFor(kp.pubkey), amount: snapAmount });
    }
    let signaturePriceBlocks = new Set(prices.filter(row => {
        try {
            let proof = JSON.parse(row.consensus_proof);
            return Array.isArray(proof) && proof.length > 0;
        } catch (e) { return false; }
    }).map(row => Number(row.reference_block)));
    for (let block of signaturePriceBlocks)
        for (let kp of priceKeys) snaps.push({ snapshot_block: block, capability: 'price',
            signing_pubkey: kp.pubkey, source: sourceFor(kp.pubkey), amount: snapAmount });
    let obj = { v: 1, network: 'regtest', batch_seq: batchSeq, matches: matches };
    if (opts.rewards) obj.rewards = opts.rewards;
    if (opts.calls) obj.calls = calls;
    if (bridges.length > 0) obj.bridge_transfers = bridges;
    if (policies.length > 0) obj.policy_snapshots = policies;
    if (checkpoints.length > 0) obj.state_checkpoints = checkpoints;
    if (prices.length > 0) obj.price_snapshots = prices;
    if ((opts.tombstones || []).length > 0) obj.price_tombstones = opts.tombstones.map(row => ({
        round_number: Number(row.round_number), coin_pair: String(row.coin_pair)
    }));
    obj.capability_snapshots = snaps;
    let json = JSON.stringify(obj);
    let crc  = crc32Hex(json);
    let b64  = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 }).toString('base64url');

    let chunkSize   = opts.chunkSize || b64.length;
    let chunks      = [];
    for (let i = 0; i < b64.length; i += chunkSize) chunks.push(b64.slice(i, i + chunkSize));
    let totalChunks = chunks.length;

    let rawWrapper = ['XCHECKPOINT', CP.chain, CP.network, String(CP.block_index), CP.block_hash,
        CP.ledger_hash, CP.actions_hash, CP.contract_hash, String(CP.checkpoint_seq), String(SNAPSHOT_BLOCK),
        String(batchSeq), String(matches.length), crc, String(totalChunks)].join('|');
    // EQUIV active in regtest (WI-2 bump 2): the v1 archive ROUND_ID appends batch_seq to
    // the v0 round id (R-4 distinct-key fix), VIEW=0. Byte-matches recovery.wrapperCanonical.
    let wrapperCanonical = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT,
        CP.chain + '|' + CP.network + '|' + CP.block_index + '|' + CP.checkpoint_seq + '|' + batchSeq, 0, rawWrapper);
    let wrapperSigs = oracleKeys.slice(0, opts.wrapperSigners || 3)
        .map(kp => ({ pubkey: kp.pubkey, sig: signHex(kp, wrapperCanonical) }));

    let v1 = Object.assign({}, CP, {
        version: 1, snapshot_block: SNAPSHOT_BLOCK, match_batch_seq: batchSeq,
        match_count: matches.length, batch_crc32: (opts.corruptCrc ? 'deadbeef' : crc),
        total_chunks: totalChunks, archive_b64: chunks[0],
        validator_signatures: JSON.stringify(wrapperSigs)
    });
    let v2s = chunks.slice(1).map((c, i) => ({ version: 2, match_batch_seq: batchSeq, chunk_index: i + 1, total_chunks: totalChunks, archive_b64: c }));
    return { v1, v2s };
}

function rawMatch(id, status) {
    return { match_id: id, snapshot_block: SNAPSHOT_BLOCK, network: 'regtest',
        a_chain: 'LTC', a_action_index: 5, a_kind: 'swap', a_tick: 'TOKA', a_amount: '1000',
        a_filled_before: '0', a_ownership: 0, a_payout_addr: 'Lpay',
        b_chain: 'DOGE', b_action_index: 8, b_kind: 'swap', b_tick: null, b_amount: '2000',
        b_filled_before: '0', b_ownership: 0, b_payout_addr: 'Dpay',
        effective_time: 1700000000, finalizing_view: 0, status: status || 'finalized' };
}

// A DISPATCH or RESULT XCALL relay row, signed against the archived cross_chain
// set (the same SNAPSHOT_BLOCK the wrapper+matches use).
function rawCall(call_id, phase, overrides) {
    let base = (phase === 'result')
        ? { id: 0, call_id, phase: 'result', snapshot_block: SNAPSHOT_BLOCK, network: 'regtest',
            source_chain: 'BTC', source_action_index: 10, source_contract_index: 2,
            target_chain: 'LTC', target_contract_index: 3, method: 'transfer',
            params_json: '{"to":"addr","amt":5}', gas_limit: 1000000, cross_hops: 0,
            effective_time: 1700000000, finalizing_view: 0, result_status: 'ok', return_payload_b64: 'cmVzdWx0',
            status: 'finalized' }
        : { id: 0, call_id, phase: 'dispatch', snapshot_block: SNAPSHOT_BLOCK, network: 'regtest',
            source_chain: 'BTC', source_action_index: 10, source_contract_index: 2,
            target_chain: 'LTC', target_contract_index: 3, method: 'transfer',
            params_json: '{"to":"addr","amt":5}', gas_limit: 1000000, cross_hops: 0,
            effective_time: 1700000000, finalizing_view: 0, result_status: null, return_payload_b64: null,
            status: 'finalized' };
    return Object.assign(base, overrides || {});
}

function rawBridge(transfer_id, status, overrides) {
    return Object.assign({
        id: 10, transfer_id, snapshot_block: SNAPSHOT_BLOCK, network: 'regtest',
        src_chain: 'BTC', src_action_index: 20, src_address: 'src-address',
        dest_chain: 'DOGE', dest_address: 'dest-address', tick: 'XCP', decimals: 8,
        amount: '150000000', effective_time: 1700000010,
        admit_block_btc: null, admit_block_ltc: null, admit_block_doge: null,
        finalizing_view: 0, status: status || 'finalized'
    }, overrides || {});
}

function rawPolicy(snapshot_id, overrides) {
    let row = Object.assign({
        id: 20, snapshot_id, snapshot_block: SNAPSHOT_BLOCK, network: 'regtest',
        origin_chain: 'BTC', tick: 'XCP', policy_seq: 3, origin_block: 95,
        allow_list: JSON.stringify(['addr1', 'addr2']), block_list: JSON.stringify(['addr9']),
        sleeping: 0, effective_time: 1700000020,
        admit_block_btc: null, admit_block_ltc: null, admit_block_doge: null,
        finalizing_view: 0, status: 'finalized'
    }, overrides || {});
    if (!Object.prototype.hasOwnProperty.call(overrides || {}, 'policy_hash')) {
        let allow = bridgeSettle.parseMembership(row.allow_list);
        let block = bridgeSettle.parseMembership(row.block_list);
        row.policy_hash = bridgeSettle.policyHash(allow, block, !!row.sleeping);
    }
    return row;
}

function rawCheckpoint(checkpoint_seq, overrides) {
    return Object.assign({
        id: checkpoint_seq, chain: 'BTC', network: 'regtest', block_index: 500 + checkpoint_seq,
        block_hash: '11'.repeat(32), ledger_hash: '22'.repeat(32), actions_hash: '33'.repeat(32),
        contract_hash: '44'.repeat(32), checkpoint_seq, snapshot_block: SNAPSHOT_BLOCK,
        state_root: '55'.repeat(32), state_root_version: 1,
        block_merkle_root: '66'.repeat(32), block_merkle_version: 1
    }, overrides || {});
}

function rawPrice(round_number, coin_pair, overrides) {
    return Object.assign({
        id: round_number, round_number, coin_pair, price: '100.25', reference_block: SNAPSHOT_BLOCK,
        reference_chain: 'BTC', block_timestamp: 1700000100, validator_count: 3,
        consensus_round: 1, status: 'finalized', source_chain: 'BTC', source_action_index: 30,
        batch_block_time: 0, admit_block_btc: null, admit_block_ltc: null, admit_block_doge: null
    }, overrides || {});
}

module.exports = {
    makeKeypair, signHex,
    MATCH_KEYS, serializeMatch, matchCanonical,
    CALL_KEYS, serializeCall, callCanonical,
    BRIDGE_KEYS, POLICY_KEYS, CHECKPOINT_KEYS, PRICE_KEYS,
    crc32Hex, SNAPSHOT_BLOCK, CP,
    buildBatch, rawMatch, rawCall, rawBridge, rawPolicy, rawCheckpoint, rawPrice,
};
