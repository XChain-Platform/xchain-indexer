/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * XChain Platform: the rules-aware attestation capability filter
 *
 * The operator ask this serves: route an attestation request only to validators
 * running the CONSENSUS RULES that govern it, keyed on the rules themselves and
 * never on a release version string. A release version says nothing about which
 * gates a build actually honours; the gate keys do.
 *
 * WHAT IT DOES. For a request at block H, drop a pubkey when the most recent
 * ROLLED epoch at or below the buried snapshot block, and at or above
 * ROLLCALL_GATES_ACTIVATION, recorded a gate list for that key which is NOT a
 * superset of activeGatesAt(H, network). A key with no row in that epoch is
 * KEPT: no rolled epoch above the arming height yet, or a key that never rolled,
 * is the liveness-eviction rail's problem, not this one, so the bootstrap epoch
 * right after arming filters nobody.
 *
 * WHY SUBSET AND NOT EQUALITY (spec §7.1, D46-D48). The roll-call is signed at
 * epoch E and this filter runs at a request block H up to a full epoch later.
 * Any gate arming inside (E, H] would break EQUALITY for every honest validator
 * at once. Under subset, a gate armed after E is simply absent from the list,
 * which is a true statement about that validator's build at the time it signed.
 * gatesHash is the commitment to what was signed; it is never the comparand.
 *
 * WHY THE SELECTION IS BY close_block (D92). db.getRollcallGatesForFilter picks
 * the epoch by the block its close LANDED at, never by epoch height alone. The
 * rows exist from the block the filter first reads them at, so a replay of the
 * same block reads exactly what the live run read; picking by epoch height would
 * let a replay see an epoch whose rows the live run had not yet written.
 *
 * WHY THIS IS ONE HELPER AND NOT THREE COPIES (D86). Three paths must derive the
 * same set or the fleet forks: v0 admission in actions/attest.js, the reorg
 * recompute in rollback.js, and the getcapabilityvalidators RPC the hub's
 * CapabilitySnapshot calls. The hub carries no twin of this logic; it receives an
 * already-filtered set, which is also why no height parameter is added to that
 * RPC (a caller-supplied height is the attack attest_response_verify.js:32-41
 * names).
 *
 * PURE AND DETERMINISTIC. No wall clock, no tip read, no local config beyond the
 * network name. Every input is block-anchored, so every node replaying the block
 * computes the same answer.
 *
 * INERT WHERE UNARMED. ROLLCALL_GATES_ACTIVATION is armed on testnet (epoch
 * 152208) and still null on mainnet, so on mainnet this returns its input
 * unchanged WITHOUT touching the database. On an armed network it queries once,
 * and still drops nobody until a rolled epoch at or above the height has closed
 * at or below the buried snapshot block. Regtest arms via
 * XC_ROLLCALL_GATES_REGTEST_ACTIVATION.
 *
 ********************************************************************/

'use strict';

const { ROLLCALL_GATES_ACTIVATION } = require('./rollcall_gates_activation.js');
const { activeGatesAt } = require('./consensus_rules_digest.js');
const srb = require('./snapshot_reorg_buffer.js');

// Drop the capability rows whose last rolled gate list does not cover the gates
// active at the request block. Returns a NEW array in the input's order (order is
// load-bearing only downstream of the hash ranking, but preserving it keeps this a
// pure subtraction that a reader can diff against the input).
//
// @param {Object}   db           an indexer Database (or its apiView) exposing
//                                getRollcallGatesForFilter
// @param {Array}    validators   capability rows, each with a `pubkey`
// @param {number}   requestBlock H, the request's DECLARED block on BTC
// @param {string}   network      mainnet | testnet | regtest
// @param {Object}   [stats]      optional; MUTATED with { dropped, epochHeight,
//                                closeBlock, needed } so a caller can log one line
//                                and thread the drop count to the admission reason
// @returns {Promise<Array>} the surviving rows
async function filterByRolledGates({ db, validators, requestBlock, network, stats }){
    let list = Array.isArray(validators) ? validators : [];
    if(stats){
        stats.dropped     = 0;
        stats.epochHeight = null;
        stats.closeBlock  = null;
        stats.needed      = 0;
    }
    // Inert network: return the SAME array reference and never open a query. An
    // un-armed network must be byte-for-byte the pre-filter indexer, including its
    // query count, which the admission suite asserts on.
    let armedAt = ROLLCALL_GATES_ACTIVATION[network];
    if(!Number.isFinite(armedAt)) return validators;
    if(!db || typeof db.getRollcallGatesForFilter !== 'function') return validators;
    if(list.length === 0) return validators;

    // The SAME burial _computeResponsibleSet resolves the capability snapshot at.
    // The gate rows must come from an epoch whose close is visible at the height the
    // set was read at, or the filter and the set disagree about which blocks exist.
    let buried = srb.buriedSnapshotBlock(requestBlock, network);
    let epoch  = await db.getRollcallGatesForFilter(buried, armedAt);
    // No rolled epoch at or above the arming height has closed at or below the buried
    // block yet: nothing to compare against, so nobody is dropped.
    if(!epoch || !epoch.gates) return validators;

    let needed = activeGatesAt(requestBlock, network);
    if(stats){
        stats.epochHeight = epoch.epoch_height;
        stats.closeBlock  = epoch.close_block;
        stats.needed      = needed.length;
    }
    // No gate is active at H (only possible on a network whose whole canon is
    // un-armed at this height): the subset test is vacuously true for everyone.
    if(needed.length === 0) return validators;

    let out     = [];
    let dropped = 0;
    for(let v of list){
        let pk = String((v && v.pubkey) != null ? v.pubkey : '').toLowerCase();
        let known = epoch.gates.get(pk);
        // No row for this key in the rolled epoch: KEPT. Eviction owns the
        // never-rolled case; this filter only judges a key that did roll.
        if(known === undefined){ out.push(v); continue; }
        let have = new Set(known.map(String));
        let ok   = true;
        for(let key of needed){ if(!have.has(key)){ ok = false; break; } }
        if(ok) out.push(v);
        else dropped++;
    }
    if(stats) stats.dropped = dropped;
    // Nothing moved: hand back the input reference so a caller that carries side
    // properties on the array (getcapabilityvalidators' `truncated`) keeps them.
    if(dropped === 0) return validators;
    return out;
}

// One log line for a filter run that actually dropped somebody, or null when it
// did not. Callers log at most this line: a per-key list would be unbounded on a
// large federation, and the count plus the epoch is what an operator acts on.
function formatGatesFilterStats(stats){
    if(!stats || !stats.dropped) return null;
    return 'rules-aware attestation set: dropped ' + stats.dropped +
           ' validator(s) whose rolled gate list at epoch ' + stats.epochHeight +
           ' (closed at block ' + stats.closeBlock + ') is not a superset of the ' +
           stats.needed + ' gate(s) active at the request block';
}

module.exports = {
    filterByRolledGates,
    formatGatesFilterStats
};
