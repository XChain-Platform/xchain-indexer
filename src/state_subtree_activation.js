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
 * when a reserved slot may stop being EMPTY. What is armed today:
 *   BTC:regtest  contract_state_root from 10000, escrow locked leaf from 11200
 *   BTC:testnet  contract_state_root from 146500 (Stage A only; the escrow leaf
 *                is a SEPARATE flag day and has NOT followed it onto testnet)
 * Every other chain, network and slot answers "off", and MAINNET IS UNARMED for
 * every slot, so their committed state_root stays byte-identical to the
 * two-sub-root v1 assembly.
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

// The reserved slots, in merkle.STATE_SUBTREES order. Order matters: it IS the
// leaf order of the top-level fixed Merkle tree. The conformance test asserts
// this equals STATE_SUBTREES minus the two v1 slots, so the two lists cannot drift.
const RESERVED_SUBTREES = ['ownership_root', 'tokens_root', 'contract_state_root'];

// Per-slot, per-chain activation height, interpreted as the processing chain's
// OWN block_index. At/after the height the slot MAY carry a real sub-root; below
// it (and for any chain absent from the map) the slot commits EMPTY_SMT_ROOT.
//
// *** ARMED: contract_state_root on BTC:regtest at 10000 (2026-07-28) and on
// *** BTC:testnet at 146500 (2026-07-30).
// Everything else is still inert, on every chain and network. MAINNET IS UNARMED
// for every slot, and stays that way until  arms on 2026-08-17.
//
// Regtest armed FIRST and alone, and only once the derivation existed. The
// earlier rule here ("a slot stays off even on regtest, because an armed slot
// with no derivation commits a WRONG root rather than a missing one") was about
// the carrier era; Stage A's derivation, its golden vectors, its serving surface
// and its real-venue conformance all landed before that height was set. Regtest
// is where being wrong costs a chain reset and nothing more, so it is the venue
// that earns the right to arm testnet, and testnet earns mainnet.
//
// BTC:testnet 146500 joins it (2026-07-30). Both hard preconditions hold, and
// they hold for DIFFERENT reasons than on regtest (spec §3 Stage A):
//   1. collation: state_key_collation_activation arms BTC:testnet at 146000, and
//      146500 is above it, so the SMT is built over the binary-collation key set
//      rather than a collation-FOLDED one. Regtest satisfies the same rule
//      trivially, being armed from genesis (0).
//   2. NUL keys: isStateKeyNulRejectActive returns true unconditionally for
//      testnet AND regtest (xchain-vm), so on neither network can a contract
//      plant a key that throws in joinFields and halts the arming block's
//      buildFull. Mainnet is a DATE (2026-08-17, ) and is why no mainnet
//      height may be set here yet.
//
// Why BTC:testnet and not the other two testnet chains, which is a measurement
// rather than a preference:
//   - LTC:testnet is BELOW its own collation height (tip ~4,825,000 against
//     4,890,000) and at its measured ~4.7 blocks/hour will not reach it for
//     roughly 575 days, so precondition 1 forbids it outright today.
//   - DOGE:testnet is eligible (tip ~67.79M over a 67.5M collation height) but
//     has NO follower: it is SYNC_EXCLUDE'd on the origin-host sync client, so
//     arming it exercises the source alone. BTC:testnet is the only testnet
//     chain with a live source-plus-follower pair, which makes it the only one
//     whose arming boundary gets a cross-twin check.
//
// Honest limit on what this height proves: BTC:testnet holds ZERO contract_state
// rows, so the armed slot commits EMPTY_SMT_ROOT and state_root does not move at
// all (a named-but-empty slot is byte-identical to a padded one, see the header).
// What the boundary really exercises is the version path: state_root_version
// flips 1 -> 2 and flows through getblockhashes into the signed checkpoint
// canonical. Exercising the DERIVATION on testnet needs contract state on the
// chain first.
//
// Arming order is fixed by the design doc: contract_state_root first (Stage A,
// and never below that chain's state_key_collation_activation height, or the SMT
// is built over a collation-FOLDED key set and forks), ownership/tokens later.
const STATE_SUBTREE_ACTIVATION = {
    ownership_root:      {},
    tokens_root:         {},
    contract_state_root: { 'BTC:regtest': 10000, 'BTC:testnet': 146500 },
};

// SHADOW-COMPUTE WINDOW (spec §7 step 1). INERT: every map empty.
//
// Where STATE_SUBTREE_ACTIVATION decides what a chain COMMITS, this decides what
// it merely COMPUTES AND RECORDS. Arming a chain here makes both twins derive the
// slot's would-be sub-root for every block and persist it in that slot's SHADOW
// column, while state_root stays byte-identical to the v1 assembly. Zero
// cross-twin divergence over the window is an arming PRECONDITION, not a
// nice-to-have: it is how a derivation bug is found before a flag day rather than
// as a fleet halt after one.
//
// Two properties make this safe to leave on:
//   - it never reaches assembleStateRoot (gateSubRoots is driven by the
//     ACTIVATION map alone), so no committed root can move; and
//   - it writes a column nothing else reads. The explorer reassembles proofs
//     from the COMMITTED column only, which is precisely why the shadow may not
//     share it: a below-arming value there would reassemble to a state_root
//     nobody signed and take every proof at that height down (spec §7, amended
//     2026-07-28 when Stage A work item 4 dropped the explorer's read gate).
//
// A chain may be shadowing and armed at once; ARMED WINS, so the boundary is
// clean: at and above the armed height the value is committed and written to the
// real column, below it the value is shadow-only. Nothing computes twice.
const STATE_SUBTREE_SHADOW = {
    ownership_root:      {},
    tokens_root:         {},
    contract_state_root: {},
};

// Locked-balance leaf inside balances_root (SPV sub-tree spec §3 Stage B,
// ). ARMED ON BTC:regtest AT BLOCK 11200 (2026-07-30), and nowhere else.
// The derivation exists: an append-only, source-authored and
// replicated escrow_leaf_journal whose totals are the escrows LEDGER rows
// re-keyed to their locker (xchain-indexer/src/escrowJournalWriter.js), read
// by the byte-identical escrowLeafSubtree.js twin. Arming this moves
// balances_root, the one sub-root every deployed light client already depends
// on, which is why Stage B arms after Stage A and on its own flag day.
//
// LIVENESS RUNS THROUGH THIS MAP AT BOTH ENDS, unlike a reserved slot. A
// slot's stored column carries the armed decision for its own height, but no
// stored signal distinguishes a balances_root that covers the XCHAIN_ESC
// domain from one that does not (an armed-but-idle domain and an inert one
// commit byte-identical roots). So the explorer refuses locked-balance proofs
// below the armed height using ITS carrier of this file, and the SDK verifier
// independently refuses using its own, so neither a lagging nor a hostile
// server can turn "not committed" into a verified absence (spec §4).
const ESCROW_LOCKED_LEAF_ACTIVATION = { 'BTC:regtest': 11200 };

// SHADOW-COMPUTE WINDOW for the escrow leaf (spec §7 step 1, Stage B). INERT.
//
// Same contract as STATE_SUBTREE_SHADOW: arming a chain here makes BOTH twins
// derive the WOULD-BE balances_root (the spendable leaves threaded exactly as
// committed, plus the journal's locked leaves) and persist it in
// state_tree_roots.balances_root_escrow_shadow, while the committed
// balances_root stays byte-identical to v1. It also starts the SOURCE's
// journal writer below the armed height, which is consensus-free (the journal
// is not a commitment; its rows replicate to the follower exactly as when
// armed), so the window exercises writer, replication and leaf application
// end to end, and zero cross-twin divergence over it is the §7 arming
// precondition.
//
// ARMED WINS: the predicate below answers false once the leaf is really live,
// and the arming block still runs its own full ledger replay, so a drifted
// shadow journal is CORRECTED rather than inherited (the replay is
// change-logged; a wrong shadow value gets a correction row, vectored).
const ESCROW_LOCKED_LEAF_SHADOW = {};

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
