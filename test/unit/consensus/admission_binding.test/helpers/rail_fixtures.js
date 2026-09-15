/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * The five mirrored rails of the admission-binding suite: one row per rail as the hub
 * signs it, the pre-train bytes spelled out by hand, and the indexer and hub canonical
 * builders each driven the way its verifier drives it.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');

const eq = require('../../../../../src/equivocation_header.js');
const { NETWORK } = require('./arms.js');

// ---------------------------------------------------------------------------
// Fixtures: one row per rail, as the hub signs it and the mirror delivers it.
// ---------------------------------------------------------------------------

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// The stored admission map: BTC and DOGE stamped, LTC left NULL (its map never named
// LTC), which is exactly the shape where a NULL column falls back to the clock rule. Encoded in ASCII order.
const COLS  = { admit_block_btc: 799004, admit_block_ltc: null, admit_block_doge: 5000004 };
const FIELD = 'BTC:799004,DOGE:5000004';
const NO_COLS = { admit_block_btc: null, admit_block_ltc: null, admit_block_doge: null };

function matchRow(block, extra) {
    return Object.assign({
        match_id: 'm'.repeat(64), snapshot_block: block, network: NETWORK,
        a_chain: 'BTC', a_action_index: 10, a_tick: 'XCP', a_amount: '1.5', a_ownership: '1', a_payout_addr: 'addrA',
        b_chain: 'DOGE', b_action_index: 20, b_tick: 'XCP', b_amount: '2.5', b_ownership: '2', b_payout_addr: 'addrB',
        effective_time: 1700000000, a_kind: 'swap', a_filled_before: '0', b_kind: 'swap', b_filled_before: '0',
        a_payout_legs: '', b_payout_legs: '', finalizing_view: 0
    }, extra || {});
}
function dispatchRow(block, extra) {
    return Object.assign({
        call_id: 'c'.repeat(64), phase: 'dispatch', snapshot_block: block, network: NETWORK,
        source_chain: 'BTC', source_action_index: 10, source_contract_index: 2,
        target_chain: 'LTC', target_contract_index: 3, method: 'transfer', params_json: '["x"]',
        gas_limit: 1000000, cross_hops: 0, effective_time: 1700000000, finalizing_view: 0
    }, extra || {});
}
function resultRow(block, extra) {
    return Object.assign({
        call_id: 'c'.repeat(64), phase: 'result', snapshot_block: block, network: NETWORK,
        target_chain: 'LTC', result_status: 'ok', return_payload_b64: 'cmVz',
        effective_time: 1700000000, finalizing_view: 0
    }, extra || {});
}
function transferRow(block, extra) {
    return Object.assign({
        transfer_id: 't'.repeat(64), snapshot_block: block, network: NETWORK,
        tick: 'XCHAIN', decimals: 8, src_chain: 'BTC', src_action_index: 4242, src_address: 'mSrc',
        dest_chain: 'DOGE', dest_address: 'nDest', amount: '10.00000000',
        effective_time: 1700000000, finalizing_view: 0
    }, extra || {});
}
function policyRow(block, extra) {
    return Object.assign({
        snapshot_id: 'p'.repeat(64), snapshot_block: block, network: NETWORK,
        origin_chain: 'BTC', tick: 'XCHAIN', policy_seq: 3, origin_block: 1190, policy_hash: 'h'.repeat(64),
        effective_time: 1700000000, finalizing_view: 0
    }, extra || {});
}

// The pre-train bytes of each rail, spelled out by hand so the legacy identity is checked
// against the FORMAT and not against the module's own output. regtest arms the royalty and
// EQUIV gates at 0, so a regtest row carries the two royalty legs and the wrapper.
function legacyMatchBytes(r) {
    let raw = ['XMATCH', r.match_id, String(r.snapshot_block),
        r.a_chain, String(r.a_action_index), r.a_tick, String(r.a_amount), String(r.a_ownership), r.a_payout_addr,
        r.b_chain, String(r.b_action_index), r.b_tick, String(r.b_amount), String(r.b_ownership), r.b_payout_addr,
        String(r.effective_time), r.network, r.a_kind, String(r.a_filled_before), r.b_kind, String(r.b_filled_before)].join('|');
    if (r.network === NETWORK) raw += '|' + r.a_payout_legs + '|' + r.b_payout_legs;
    return eq.isEquivHeaderActive(r.snapshot_block, r.network)
        ? eq.buildEquivCanonical(eq.ENGINE_TAGS.DEX, r.match_id, 0, raw) : raw;
}
function legacyDispatchBytes(r) {
    const raw = ['XCALL', 'DISPATCH', r.call_id, String(r.snapshot_block), r.network,
        r.source_chain, String(r.source_action_index), String(r.source_contract_index),
        r.target_chain, String(r.target_contract_index), r.method, sha(r.params_json),
        String(r.gas_limit), String(r.cross_hops), String(r.effective_time)].join('|');
    return eq.isEquivHeaderActive(r.snapshot_block, r.network)
        ? eq.buildEquivCanonical(eq.ENGINE_TAGS.XCALL, sha('XCALLROUND|dispatch|' + r.call_id), 0, raw) : raw;
}
function legacyResultBytes(r) {
    const raw = ['XCALL', 'RESULT', r.call_id, String(r.snapshot_block), r.network,
        r.target_chain, r.result_status, sha(r.return_payload_b64), String(r.effective_time)].join('|');
    return eq.isEquivHeaderActive(r.snapshot_block, r.network)
        ? eq.buildEquivCanonical(eq.ENGINE_TAGS.XCALL, sha('XCALLROUND|result|' + r.call_id), 0, raw) : raw;
}
function legacyTransferBytes(r) {
    const raw = ['XBRIDGE', r.transfer_id, String(r.snapshot_block), r.tick, String(r.decimals),
        r.src_chain, String(r.src_action_index), r.src_address, r.dest_chain, r.dest_address,
        String(r.amount), String(r.effective_time), r.network].join('|');
    return eq.isEquivHeaderActive(r.snapshot_block, r.network)
        ? eq.buildEquivCanonical(eq.ENGINE_TAGS.BRIDGE, r.transfer_id, 0, raw) : raw;
}
function legacyPolicyBytes(r) {
    const raw = ['XPOLICY', r.snapshot_id, String(r.snapshot_block), r.origin_chain, r.tick,
        String(r.policy_seq), String(r.origin_block), r.policy_hash, String(r.effective_time), r.network].join('|');
    return eq.isEquivHeaderActive(r.snapshot_block, r.network)
        ? eq.buildEquivCanonical(eq.ENGINE_TAGS.POLICY, r.snapshot_id, 0, raw) : raw;
}

// The indexer twins, each driven the way its verifier drives it.
function indexerTwins(h) {
    const mk = () => ({ config: {}, decoderDb: null, indexerDb: null, util: null, mapper: null });
    const settle = new h.Settle(mk()), xexec = new h.Xexec(mk()), xcall = new h.Xcall(mk());
    return {
        match:    (r) => settle.canonical(r),
        dispatch: (r) => xexec.canonical(r),
        result:   (r) => xcall.resultCanonical(r),
        transfer: (r) => h.BS.transferCanonical(r),
        policy:   (r) => h.BS.policyCanonical(r)
    };
}

// The hub builders, driven on a stub `this` carrying only what each canonical reads.
function hubBuilders(h) {
    const C = h.hub.Call.prototype;
    // _sha256 is the HUB prototype private name this stub has to satisfy: the builder
// under test lives in xchain-hub and calls this._sha256, so the key stays spelled
// the hub way no matter what this repo renames its own methods to.
    const callThis = { _sha256: C._sha256, _roundId: C._roundId };
    return {
        match:    (r) => h.hub.Dex.prototype._canonicalMatch.call({}, r, r.finalizing_view),
        dispatch: (r) => h.hub.Call.prototype._canonicalMatch.call(callThis, r, r.finalizing_view),
        result:   (r) => h.hub.Call.prototype._canonicalMatch.call(callThis, r, r.finalizing_view),
        transfer: (r) => h.hub.Bridge.prototype._canonicalMatch.call({}, r, r.finalizing_view),
        policy:   (r) => h.hub.Bridge.prototype._canonicalMatch.call({}, r, r.finalizing_view)
    };
}

const RAILS = [
    ['match',    matchRow,    legacyMatchBytes],
    ['dispatch', dispatchRow, legacyDispatchBytes],
    ['result',   resultRow,   legacyResultBytes],
    ['transfer', transferRow, legacyTransferBytes],
    ['policy',   policyRow,   legacyPolicyBytes]
];

module.exports = { sha, COLS, FIELD, NO_COLS, RAILS, indexerTwins, hubBuilders };
