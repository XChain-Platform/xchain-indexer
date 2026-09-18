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
 * Reserved state_root sub-tree flag-days (SPV spec §4.1, §10 D1; design in
 * ).
 *
 * merkle.STATE_SUBTREES freezes FIVE named slots:
 *
 *     [ balances_root, stakes_root, ownership_root, tokens_root, contract_state_root ]
 *
 * state_root_version 1 commits the first two for real and the last three as
 * EMPTY_SMT_ROOT. This module is the gate that decides, per slot and per chain,
 * when a reserved slot may stop being EMPTY. What is armed today:
 *   BTC:regtest   contract_state_root from 10000, escrow locked leaf from 11200
 *   BTC/LTC/DOGE:testnet  contract_state_root and escrow locked leaf from genesis
 * Every other chain, network and slot answers "off", and MAINNET IS UNARMED for
 * every slot, so their committed state_root stays byte-identical to the
 * two-sub-root v1 assembly. The escrow leaf remains a SEPARATE flag day from
 * Stage A: it arms on its own heights, and its arming on a chain says nothing
 * about that chain's reserved slots.
 *
 * Why a gate and not a plain version flip: the chains flip at different heights
 * (they always have - see state_commitment_activation.js), so one map per slot
 * lets a slot arm on testnet while mainnet is still on version 1. The reported
 * state_root_version is DERIVED from these maps rather than configured beside
 * them, which removes the failure mode where the version column and the actually
 * committed leaf set disagree.
 *
 * There is deliberately NO escrow slot here. Per SPV spec §4.2 D2 (revised
 * 2026-06-18) the locked-balance commitment is a parallel LEAF inside
 * balances_root under merkle.escrowKey()'s XCHAIN_ESC domain, not a sixth
 * sub-root. Adding a sixth name would flip that slot's leaf from the EMPTY[0]
 * structural padding fixedMerkleRoot inserts to a named-slot EMPTY_SMT_ROOT,
 * which are different constants: every historical state_root on every chain
 * would change. The five-name list is frozen. The escrow leaf's own flag-day
 * (ESCROW_LOCKED_LEAF_ACTIVATION below) lives here because it gates the same
 * kind of consensus surface, but it moves balances_root, not the slot list.
 *
 * Gate semantics FOLLOW state_commitment_activation.js in shape (keyed on the
 * processing chain's OWN local block_index; unknown -> inert/off) but
 * deliberately DROP its bare-network fallback: these heights are chain-local
 * block indexes and the chains differ by orders of magnitude, so one bare
 * key arming three chains is near-certainly wrong on two. Lookup is
 * '<COIN>:<network>' ONLY. There is no environment override, on purpose: an
 * env-tunable consensus height is a fork switch sitting on an operator's
 * shell. Arming is a code change that deploys fleet-wide first.
 *
 * BYTE-IDENTICAL ACROSS FOUR CARRIERS:
 *   xchain-indexer/src/state_subtree_activation.js   (SOURCE)
 *   xchain-sync/src/state_subtree_activation.js      (FOLLOWER)
 *   xchain-sdk/src/state_subtree_activation.js       (CLIENT)
 *   xchain-explorer/src/state_subtree_activation.js  (PROOF SERVER)
 *
 * The follower recomputes every root and HALTs on divergence, so a drifted copy
 * turns the divergence detector into a false-halt generator. The SDK copy is
 * there for a different reason and it is the reason this file is exported at
 * all: NO PROOF CAN TELL A CLIENT WHETHER A SLOT IS LIVE. An armed-but-empty
 * slot and an inert slot commit the byte-identical EMPTY_SMT_ROOT, so an
 * absence proof establishes "empty or inert" and never which. These maps are
 * the only liveness source a client has, which is why they ship as consensus
 * constants rather than staying server-side. The explorer copy serves ONE
 * read, the escrow-leaf liveness refusal: reserved slots need no gate there
 * (their stored column carries the armed decision per height), but the escrow
 * leaf lives inside balances_root with no stored signal, so refusing to
 * "prove" absence below its armed height requires the map itself.
 *
 * Locked equal by the cross-repo loop in
 * xchain-sync/test/unit/rollback-coverage.test.js and, so a standalone SDK
 * checkout is covered too, by xchain-sdk/test/unit/stateSubtreeConstants.test.js.
 * ALL FOUR must ship before any armed height is reached: an SDK release that
 * lags the fleet tells clients a live slot is inert, which is the same wrong
 * answer as no export at all.
 *
 ********************************************************************/

'use strict';

const { get, copy, activeAt } = require('../gate_registry');

const RESERVED_SUBTREES = copy('state_subtree_activation.RESERVED_SUBTREES');

const STATE_SUBTREE_ACTIVATION = copy('state_subtree_activation.STATE_SUBTREE_ACTIVATION');

const STATE_SUBTREE_SHADOW = copy('state_subtree_activation.STATE_SUBTREE_SHADOW');

const ESCROW_LOCKED_LEAF_ACTIVATION = copy('state_subtree_activation.ESCROW_LOCKED_LEAF_ACTIVATION');

const ESCROW_LOCKED_LEAF_SHADOW = copy('state_subtree_activation.ESCROW_LOCKED_LEAF_SHADOW');

// Resolve a per-chain threshold out of one map. '<COIN>:<network>' is the ONLY
// key shape (no bare-network fallback, see header). Unknown -> undefined ->
// caller treats as off.
function _threshold(map, network, coin){
    if(!map || coin == null) return undefined;
    return map[coin + ':' + network];
}

// Strict height parse, shared by BOTH sides of the comparison: a plain
// non-negative integer number, or a pure-digit string, else NaN. Deliberately
// NOT parseInt: parseInt reads "501abc" as 501 and "1e3" as 1, and a consensus
// gate that guesses at a malformed height is a fork switch.
function _strictHeight(v){
    const n = (typeof v === 'number') ? v
            : (typeof v === 'string' && /^\d+$/.test(v)) ? Number(v)
            : NaN;
    return (Number.isInteger(n) && n >= 0) ? n : NaN;
}

// Shared height comparison: absent threshold, or a QUERIED height or MAP
// threshold that is not a plain non-negative integer -> off. The map side
// matters as much as the query side: a raw `b >= threshold` would coerce via
// JS relational comparison, so a threshold of "1e3" arms at 1000 and a
// threshold of null (which survives the !== undefined lookup) arms from
// genesis (b >= null is b >= 0). Both are fail-OPEN fork switches; a
// malformed map value must read as off, exactly like a malformed query.
function _atOrAfter(map, blockIndex, network, coin){
    const b = _strictHeight(blockIndex);
    if(Number.isNaN(b)) return false;
    const threshold = _strictHeight(_threshold(map, network, coin));
    if(Number.isNaN(threshold)) return false;
    return b >= threshold;
}

// Whether reserved slot `name` may carry a real sub-root at `blockIndex`.
// Throws on an unknown slot name: that is a caller typo, and a slot silently
// dropped after its height is armed is a fork, so it must not fail quietly.
function isSubtreeActive(name, blockIndex, network, coin){
    if(RESERVED_SUBTREES.indexOf(name) < 0)
        throw new Error('state_subtree_activation: unknown reserved sub-tree ' + name);
    return _atOrAfter(STATE_SUBTREE_ACTIVATION[name], blockIndex, network, coin);
}

// Whether reserved slot `name` should be SHADOW-computed at `blockIndex`: derived
// and recorded, never committed (spec §7 step 1). ARMED WINS, so this answers
// false once the slot is really live and the caller has exactly one job per
// height. Throws on an unknown slot for the same reason isSubtreeActive does.
function isSubtreeShadowActive(name, blockIndex, network, coin){
    if(RESERVED_SUBTREES.indexOf(name) < 0)
        throw new Error('state_subtree_activation: unknown reserved sub-tree ' + name);
    if(isSubtreeActive(name, blockIndex, network, coin)) return false;
    return _atOrAfter(STATE_SUBTREE_SHADOW[name], blockIndex, network, coin);
}

// Whether the balances_root locked-escrow leaf is committed at `blockIndex`.
function isEscrowLockedLeafActive(blockIndex, network, coin){
    return _atOrAfter(ESCROW_LOCKED_LEAF_ACTIVATION, blockIndex, network, coin);
}

// Whether the escrow leaf should be SHADOW-computed at `blockIndex`: derived
// and recorded, never committed (spec §7 step 1). ARMED WINS, exactly as
// isSubtreeShadowActive, so each height uses exactly one column.
function isEscrowLockedLeafShadowActive(blockIndex, network, coin){
    if(isEscrowLockedLeafActive(blockIndex, network, coin)) return false;
    return _atOrAfter(ESCROW_LOCKED_LEAF_SHADOW, blockIndex, network, coin);
}

// THE ONLY WAY a reserved sub-root reaches state_root. Takes whatever the block
// path computed and returns only the slots active at this height, or null when
// none are (which makes the assembly byte-identical to v1). A caller cannot
// bypass this by handing a sub-root straight to assembleStateRoot: the block
// paths pass gateSubRoots' output, never their own candidates.
function gateSubRoots(candidates, blockIndex, network, coin){
    if(!candidates) return null;
    const out = {};
    let any = false;
    for(const name of Object.keys(candidates)){
        if(candidates[name] == null) continue;
        if(!isSubtreeActive(name, blockIndex, network, coin)) continue;   // throws on typo
        out[name] = candidates[name];
        any = true;
    }
    return any ? out : null;
}

// state_root_version DERIVED from the gate: 1 while every extension is inert at
// this height, 2 once ANY of them is active - a reserved slot OR the escrow
// locked-balance leaf. The escrow leaf changes the contents of balances_root
// rather than the slot list, but it still changes the committed leaf set, and a
// leaf-set change invisible in the version signal is exactly the disagreement
// failure mode deriving the version exists to prevent. Derived rather than
// configured so the reported version and the committed leaf set cannot disagree.
function stateRootVersion(blockIndex, network, coin){
    for(const name of RESERVED_SUBTREES)
        if(isSubtreeActive(name, blockIndex, network, coin)) return 2;
    if(isEscrowLockedLeafActive(blockIndex, network, coin)) return 2;
    return 1;
}

module.exports = {
    RESERVED_SUBTREES,
    STATE_SUBTREE_ACTIVATION,
    STATE_SUBTREE_SHADOW,
    ESCROW_LOCKED_LEAF_ACTIVATION,
    ESCROW_LOCKED_LEAF_SHADOW,
    isSubtreeActive,
    isSubtreeShadowActive,
    isEscrowLockedLeafActive,
    isEscrowLockedLeafShadowActive,
    gateSubRoots,
    stateRootVersion
};
