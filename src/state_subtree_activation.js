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
 * claude/specs/spv-state-subtree-extension.md).
 *
 * merkle.STATE_SUBTREES freezes FIVE named slots:
 *
 *     [ balances_root, stakes_root, ownership_root, tokens_root, contract_state_root ]
 *
 * state_root_version 1 commits the first two for real and the last three as
 * EMPTY_SMT_ROOT. This module is the gate that decides, per slot and per chain,
 * when a reserved slot may stop being EMPTY. It is INERT: every map is empty, so
 * every lookup answers "off" and every committed state_root stays byte-identical
 * to the two-sub-root v1 assembly.
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
 * Gate semantics MIRROR state_commitment_activation.js: keyed on the processing
 * chain's OWN local block_index, '<COIN>:<network>' lookup first, then the bare
 * network key; unknown -> inert/off. There is no environment override, on
 * purpose: an env-tunable consensus height is a fork switch sitting on an
 * operator's shell. Arming is a code change that deploys fleet-wide first.
 *
 * BYTE-IDENTICAL TWIN: xchain-indexer/src/state_subtree_activation.js (SOURCE)
 * and xchain-sync/src/state_subtree_activation.js (FOLLOWER). The follower
 * recomputes every root and HALTs on divergence, so a drifted copy turns the
 * divergence detector into a false-halt generator. Locked equal by the cross-repo
 * twin loop in xchain-sync/test/unit/rollback-coverage.test.js. BOTH repos must
 * deploy fleet-wide before any armed height is reached.
 *
 ********************************************************************/

'use strict';

// The reserved slots, in merkle.STATE_SUBTREES order. Order matters: it IS the
// leaf order of the top-level fixed Merkle tree. The conformance test asserts
// this equals STATE_SUBTREES minus the two v1 slots, so the two lists cannot drift.
const RESERVED_SUBTREES = ['ownership_root', 'tokens_root', 'contract_state_root'];

// Per-slot, per-chain activation height, interpreted as the processing chain's
// OWN block_index. At/after the height the slot MAY carry a real sub-root; below
// it (and for any chain absent from the map) the slot commits EMPTY_SMT_ROOT.
//
// *** INERT: every map is empty, nothing is armed anywhere, including regtest. ***
//
// Regtest is off too, unlike state_key_collation_activation.js which arms regtest
// from genesis. That map gated a change to an EXISTING query; these slots gate a
// derivation that does not exist yet, so an armed regtest slot would commit a
// WRONG root rather than a missing one. A slot arms on regtest in the same change
// that lands its derivation and its golden vectors.
//
// Arming order is fixed by the design doc: contract_state_root first (Stage A,
// and never below that chain's state_key_collation_activation height, or the SMT
// is built over a collation-FOLDED key set and forks), ownership/tokens later.
const STATE_SUBTREE_ACTIVATION = {
    ownership_root:      {},
    tokens_root:         {},
    contract_state_root: {},
};

// Locked-balance leaf inside balances_root (SPV spec §4.2 D2, Phase 2). INERT.
// Blocked on a derivation, not on tree plumbing: SUM(escrows) per (address, tick)
// does NOT net to zero per key (a lock keys to the order SOURCE, the match release
// keys to the recipient GET_ADDRESS), so the locker's key is stale-positive and the
// recipient's is negative. The real source is GIVE_REMAINING per SOURCE over open
// orders/dispensers, which is a new frozen consensus query. Arming this moves
// balances_root, the one sub-root every deployed light client already depends on.
const ESCROW_LOCKED_LEAF_ACTIVATION = {};

// Resolve a per-chain threshold out of one map: '<COIN>:<network>' key first, then
// the bare network key. Unknown -> undefined -> caller treats as off.
function _threshold(map, network, coin){
    if(!map) return undefined;
    if(coin != null && map[coin + ':' + network] !== undefined) return map[coin + ':' + network];
    return map[network];
}

// Shared height comparison: absent threshold or a height that is not a plain
// non-negative integer -> off. Deliberately NOT parseInt: parseInt reads
// "501abc" as 501 and "1e3" as 1, and a consensus gate that guesses at a
// malformed height is a fork switch. Number-typed inputs pass through
// untouched (the block loops hand us numbers); strings must be pure digits.
function _atOrAfter(map, blockIndex, network, coin){
    const b = (typeof blockIndex === 'number') ? blockIndex
            : (typeof blockIndex === 'string' && /^\d+$/.test(blockIndex)) ? Number(blockIndex)
            : NaN;
    if(!Number.isInteger(b) || b < 0) return false;
    const threshold = _threshold(map, network, coin);
    if(threshold === undefined) return false;
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

// Whether the balances_root locked-escrow leaf is committed at `blockIndex`.
function isEscrowLockedLeafActive(blockIndex, network, coin){
    return _atOrAfter(ESCROW_LOCKED_LEAF_ACTIVATION, blockIndex, network, coin);
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
    ESCROW_LOCKED_LEAF_ACTIVATION,
    isSubtreeActive,
    isEscrowLockedLeafActive,
    gateSubRoots,
    stateRootVersion
};
