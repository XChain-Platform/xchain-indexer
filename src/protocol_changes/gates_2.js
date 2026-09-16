/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * Indexer-only registry rows, part 2 of 3: gated_handoff_ref_activation to protocol/constants
 *
 * One part of the indexer-only registry rows: every data export of a module
 * that no other repo twins, as `addGate(key, unit, table)` calls at column
 * zero, each literal carried over from the module with its comments. The
 * module keeps its predicates and reads the row back through get() or copy().
 *
 * Rows are grouped by module stem in alphabetical order; a stem's rows keep
 * the order the module declared them. Keys never change (I4).
 *
 ********************************************************************/

'use strict';

const { addGate, UNARMED, UNPINNED } = require('./shared_rows.js');

// gated_handoff_ref_activation
// Per-network activation, interpreted against the block's consensus timestamp
// (data['BLOCK_TIME']).
addGate('gated_handoff_ref_activation.GATED_HANDOFF_REF_ACTIVATION', 'time', {
    mainnet: 0,             // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 SEND, measured 2026-09-09)
    testnet: 0,
    regtest: 0,
});

// ledger_amount_precision_activation
// Scale the ledger stores amounts at once the rule is live. 18 is
// MAX_TOKEN_DECIMALS: the finest precision any tick can be issued with, and the
// scale getAddressBalances / stateCommitment.getNetBalance already net in.
addGate('ledger_amount_precision_activation.LEDGER_AMOUNT_PRECISION', 'constant', 18);

// Per-chain activation heights, interpreted against the chain's own block_index.
// `null` = NOT YET PINNED = inert (legacy per-row quantization, byte-identical
// replay). Only regtest is armed, so fresh regtest stacks exercise the exact-fee
// path end to end; mainnet/testnet heights are pinned at flag-day assembly with
// the replay evidence this item requires.
addGate('ledger_amount_precision_activation.LEDGER_AMOUNT_PRECISION_ACTIVATION', 'height', {
    // Pinned on the standing 21-day rule, to the same boundary the oracle
    // stale-round gate uses, so both consensus changes arm in one fleet deploy
    // and one rehearsal rather than two. Each height sits above the tip
    // recorded beside it, because a height a carrying fleet has not yet passed
    // opens a retroactive window: a node that reindexes across it derives
    // different state than one that did not.
    'BTC:mainnet':  966500,     // tip 963,334 (2026-08-20) + 21d @144/day
    'LTC:mainnet':  3175500,    // tip 3,163,414 + 21d @576/day
    'DOGE:mainnet': 6370000,    // tip 6,340,174 + 21d @1440/day
    // TESTNET ARMED AT GENESIS, operator-ratified 2026-08-18. The pre-launch ruling is
    // that every platform feature must be ACTIVE on testnet, and block 0 is safe here
    // because that chain's indexer state is rebuilt from the chain itself before launch: a
    // rebuild recomputes every row under this rule, so no row written under the legacy one
    // survives to disagree with it. Without the rebuild a genesis height is NOT safe here,
    // which is why a network with history carries a measured height instead.
    'BTC:testnet':  0,
    'LTC:testnet':  0,
    'DOGE:testnet': 0,
    regtest: 0,
});

// list_owner_activation
// LIST_OWNER_ACTIVATION: the height (per network) on the chain being parsed at/above
// which a LIST format 1 whose SOURCE is not the source of the list's root create is
// 'invalid: LIST_ACTION_INDEX (not owner)'. Keyed on the chain's OWN block_index: the
// action being judged is the edit mined here.
//
// Mainnet and testnet park at the house sentinel 9999999999 and the operator sizes the
// dated instant at the v0.18.0 cut, because arming a re-verdicting rule at a height the
// fleet has already passed would have a replaying node apply it where a long-running
// node never did, and the two diverge at the first hash comparison. Regtest is 0 so the
// e2e rail exercises the armed rule from genesis.
//
// A network map rather than the per-chain 'COIN:network' shape
// list_edit_resolution_activation.js uses: that gate had to be pinned against three live
// mainnet tips because it was arming into indexed history, while this one arms nowhere
// off regtest until the operator names an instant, and a per-chain map would be three
// sentinels to keep equal instead of one.
addGate('list_owner_activation.LIST_OWNER_ACTIVATION', 'height', {
    mainnet: 9999999999,
    testnet: 9999999999,
    regtest: 0,
});

// oracle_preload_causality_activation
// Per-chain activation, interpreted as the processing chain's OWN block_index
// (the value db.getOracleDataForVM already caps on). Every network is
// genesis-active; BTC is carved out below at any height.
addGate('oracle_preload_causality_activation.ORACLE_PRELOAD_CAUSALITY_ACTIVATION', 'height', {
    mainnet: 0,             // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 contracts, measured 2026-09-09)
    testnet: 0,
    regtest: 0,
});

// The chain whose heights price_snapshots.reference_block records. Its height
// cap is exact, so it never takes the time bound.
addGate('oracle_preload_causality_activation.ORACLE_PRELOAD_CAUSALITY_REFERENCE_COIN', 'constant', 'BTC');

// oracle_snapshot_age_causality_activation
// Per-chain activation height, interpreted as the processing chain's OWN
// block_index. At/after the height the causally-capped age query runs; below it
// the legacy uncapped query runs. ARMED 2026-07-22 at the ratified deploy-train
// heights; testnet + regtest genesis-active (pre-launch), matching
// PKG3_SANDBOX_ACTIVATION.
addGate('oracle_snapshot_age_causality_activation.ORACLE_SNAPSHOT_AGE_CAUSALITY_ACTIVATION', 'height', {
    'BTC:mainnet':  961000,
    'LTC:mainnet':  3154250,
    'DOGE:mainnet': 6319000,
    testnet: 0,
    regtest: 0,
});

// oracle_stale_round_visibility_activation
// Per-chain activation height, interpreted as the processing chain's OWN
// block_index. At/after the height a stale tip round is emitted with its price
// withheld; below it the row is dropped entirely (legacy behaviour).
addGate('oracle_stale_round_visibility_activation.ORACLE_STALE_ROUND_VISIBILITY_ACTIVATION', 'height', {
    'BTC:mainnet':  966500,     // tip 963,240 (2026-08-20) + 21d @144/day = 966,264
    'LTC:mainnet':  3175500,    // tip 3,163,004 + 21d @576/day = 3,175,100
    'DOGE:mainnet': 6370000,    // tip 6,339,253 + 21d @1440/day = 6,369,493
    testnet: 0,
    regtest: 0,
});

// price_fee_batch_landed_activation
// Per-network activation, interpreted as the PROCESSING chain's own
// block_index (the value getLatestPrice is already given). null means unarmed
// at every height; an unknown network resolves to undefined and is inert for
// the same reason.
addGate('price_fee_batch_landed_activation.PRICE_FEE_BATCH_LANDED_ACTIVATION', 'height', {
    mainnet: null,
    testnet: null,
    regtest: null,
});

// price_zero_validity_activation
// Per-network activation TIME, keyed on the action's own block time.
addGate('price_zero_validity_activation.PRICE_ZERO_VALIDITY_ACTIVATION', 'time', {
    mainnet: null,          // INERT: operator-owned instant, unratified. The legacy path runs byte for byte.
    testnet: 1790812800,    // SIZED 2026-09-11: 2026-10-01 00:00:00 UTC, about three weeks of deploy headroom on a live public ledger; keyed on the action's block time
    regtest: 0,             // ARMED at genesis so the e2e oracle venue exercises the armed rule
});

// protocol/constants
// Maximum *compiled* on-chain ACTION push, in bytes.
//
// This is measured against the reassembled script push as it appears on
// chain (i.e. the OP_PUSHDATA-prefixed buffer, BEFORE bitcoin.script.decompile
// strips the push prefix. The indexing decoder is the protocol arbiter: it
// drops any transaction whose compiled ACTION push exceeds this value, so the
// encoder must enforce the identical compiled-size ceiling. A transaction the
// encoder produces above this size would be silently dropped by every node.
addGate('protocol/constants.MAX_ACTION_DATA_LENGTH', 'constant', 8192);

// Bytes added by the OP_PUSHDATA2 push prefix (1-byte opcode + 2-byte
// little-endian length) when a 256..65535-byte payload is compiled into the
// on-chain script. For a single such push the compiled length is therefore
// (decoded payload bytes + OP_RETURN_PUSH_OVERHEAD); smaller payloads use a
// 1- or 2-byte prefix, and multi-segment encodings add one prefix per segment.
// This is why the authoritative cap is enforced on the *compiled* length, not
// on the decoded character count.
addGate('protocol/constants.OP_RETURN_PUSH_OVERHEAD', 'constant', 3);

// Maximum smart-contract source code size, in bytes (64 KiB). Enforced by the
// SDK (pre-flight validation), the indexer (DEPLOY processing) and the VM
// (isolate limit). These were each declared independently and are kept in
// lockstep by the same regression suite.
addGate('protocol/constants.MAX_CODE_SIZE', 'constant', 65536);

// Maximum number of chunks one DEPLOY may assemble. base64(MAX_CODE_SIZE) is
// ~87.4 KB; at the conservative per-chunk part budget below that is ~12 chunks,
// so 16 leaves headroom while bounding assembler work + chunk-table DoS.
addGate('protocol/constants.MAX_DEPLOY_CHUNKS', 'constant', 16);

// Maximum bytes of base64 code carried by a single DEPLOY v4 carrier's CODE_PART.
// Sized so the compiled v4 carrier action (action prefix + 64-char CODE_HASH +
// indices + the part) stays comfortably under MAX_ACTION_DATA_LENGTH including
// the OP_PUSHDATA2 prefix. The SDK splits at this size; the indexer rejects a
// larger part (belt-and-suspenders; the decoder already drops oversize pushes).
addGate('protocol/constants.MAX_DEPLOYCHUNK_PART_BYTES', 'constant', 7800);

// Cross-contract calls (emit.execute). Maximum call depth: a user-submitted
// EXECUTE runs at depth 0; each emit.execute hop adds 1. Enforced by the VM at
// emit time and re-validated by the indexer when it processes the emission.
addGate('protocol/constants.VM_MAX_CALL_DEPTH', 'constant', 4);

// Minimum caller-funded gas reservation per emit.execute call. Bounds call-tree
// fan-out: every call costs at least (VM_EMISSION + VM_MIN_CALL_GAS) out of the
// caller's own gas budget. Enforced by the VM and the indexer in lockstep.
addGate('protocol/constants.VM_MIN_CALL_GAS', 'constant', 5000);

// Target-side gas ceiling bounds. The injected execution is fee-less on the
// target chain (the caller pre-paid on the source chain), so the per-call cap
// is much tighter than the same-chain 1M execution ceiling. The minimum equals
// VM_MIN_CALL_GAS.
addGate('protocol/constants.XCALL_MIN_GAS', 'constant', 5000);

addGate('protocol/constants.XCALL_MAX_GAS', 'constant', 200000);

// Cross-chain hop budget: a user-originated call is hop 1; a call emitted from
// a cross-chain-injected execution (or from a result callback) is hop 2; more
// requires a fresh user transaction. Bounds X→Y→X ping-pong, which is
// otherwise free after the first hop (injected executions have no fee payer).
addGate('protocol/constants.XCALL_MAX_HOPS', 'constant', 2);

// Source-chain deadline window (blocks). Must comfortably exceed both chains'
// relay confirmation depths plus federation rounds; expiry past deadline_block
// is synthesized deterministically by every source-chain indexer.
addGate('protocol/constants.XCALL_MIN_DEADLINE_BLOCKS', 'constant', 10);

addGate('protocol/constants.XCALL_MAX_DEADLINE_BLOCKS', 'constant', 4000);

// Return payload cap, bytes (pre-base64). The payload is mirrored to every
// indexer and ANCHOR-archived on DOGE; an oversize return becomes status
// 'payload_too_large' with an EMPTY payload (deterministic. Never truncated).
addGate('protocol/constants.XCALL_MAX_RETURN_BYTES', 'constant', 1024);

// Deterministic per-block injection cap on each target chain. Overflow carries
// forward to the next block in (snapshot_block, call_id) order. Never dropped.
addGate('protocol/constants.XCALL_MAX_CALLS_PER_BLOCK', 'constant', 25);

// Age-out window (seconds of consensus block time, measured from a mirrored
// result row's quorum-signed effective_time) past which the SOURCE chain retires
// a result row it can never deliver.
//
// A result row whose call_id matches no local XCALL v0 request is rejected on
// every block and pruned by nothing (pruning is keyed on a recorded callback),
// so a handful of such rows permanently occupy the head of the
// XCALL_MAX_CALLS_PER_BLOCK delivery slice and starve every real result behind
// them. The mirrored row carries no deadline_block of its own, so the age-out
// clock is effective_time: the federation only signs a result after the request
// is buried at its source chain's relay confirmation depth, and one hour covers
// the deepest of those windows (BTC 6 blocks x 600s, LTC 12 x 150s, DOGE 60 x
// 60s). A request still absent an hour past effectiveness is absent because its
// branch is gone, not because this node is behind, and no honest reorg brings it
// back. Where a local request DOES exist (routing mismatch, or a definitively
// unquorate result), its own deadline_block is the exact age-out clock and this
// window is not used.
//
// Retirement is CONSENSUS-VISIBLE: it mints an action row and frees a slot in a
// capped per-block pass, which decides which block a real callback lands in. It
// is therefore flag-day gated (XCALL_RESULT_ORPHAN_RETIREMENT in the indexer's
// protocol_changes.js) and anchored to a rollback-able action_index, so a
// source-chain reorg that restores the missing request also erases the
// retirement and the result delivers normally.
addGate('protocol/constants.XCALL_RESULT_ORPHAN_GRACE_SECONDS', 'constant', 3600);

// ── ATTEST expiry sweep ─────────────────────────────────────────────────────
// Deterministic per-block cap on the ATTEST v0 deadline-expiry sweep.
// Each expired request synthesizes an ATTEST v2 action that flips the request to
// 'expired' and fires its callback, so an unbounded sweep lets a single block
// inherit an arbitrary backlog: one block's processing time (and its actions
// rows) becomes a function of how many requests happened to expire at once,
// which an attacker controls by batching requests with a common deadline.
//
// Overflow carries forward to the next block rather than being dropped: the
// selection is ordered (deadline_block ASC, action_index ASC), a TOTAL order
// because action_index is unique, so the same requests expire in the same order
// on every node, just spread across more blocks. Mirrors the XCALL sibling cap
// above in both value and carry-forward semantics.
//
// CONSENSUS-VISIBLE: the cap decides which block an expiry lands in, which moves
// actions rows, the contract hash and the checkpoint preimage. It ships ungated
// because a fleet-wide replay batch recomputes all of it.
addGate('protocol/constants.ATTEST_MAX_EXPIRIES_PER_BLOCK', 'constant', 25);

// ── Cross-chain settlement pass ─────────────────────────────────────────────
// Deterministic per-block cap on the CROSS_SETTLE pass. It was the
// one cross-chain pass without one: processCrossChainSettlements looped every
// finalized, effective, unsettled match the hub mirror carried, so a hub backlog
// (or a hub the indexer had been disconnected from for a while) injected an
// unbounded number of escrow-releasing actions into a single block transaction,
// which is the BLOCK_PROCESS_TIMEOUT shape the XCALL and ATTEST caps above exist
// to prevent.
//
// Overflow carries forward rather than being dropped: getEffectiveUnsettledMatches
// already orders by (snapshot_block ASC, match_id ASC), quorum-agreed row content
// and a total order, so the capped prefix is the same set on every operator no
// matter which hub DB it mirrors, and the remainder settles next block in order.
//
// CONSENSUS-VISIBLE, like both siblings: the cap decides which block a settlement
// lands in, so it moves actions rows, the contract hash and the checkpoint
// preimage. Unlike both siblings it is therefore NOT applied unconditionally.
//
// OPERATOR RULING, 2026-08-11: the cap lands behind an
// operator-ratified FLAG-DAY gate in protocol_changes.js
// (CROSS_SETTLE_PER_BLOCK_CAP), and NOT ungated under the fleet-wide
// wipe-and-replay route. What the ruling settled: CROSS_CHAIN_DEX is
// genesis-active on every network (protocol_changes.js, all-zero thresholds) and
// the fresh-genesis restart of 816d1e1 moved the three TESTNET chains only, that
// commit saying in as many words that mainnet and regtest are untouched, so
// mainnet carries history this cap reinterprets; ungated would be replay-safe
// there only if no mainnet block ever held more than the cap of effective
// unsettled matches, a chain-state question no file in this repo can answer. The
// ATTEST_MAX_EXPIRIES_PER_BLOCK precedent above does not carry it: that one
// shipped ungated only because a fleet-wide replay recomputed the
// history it reinterpreted, a vehicle this cap does not have.
//
// The number below is the cap's VALUE; the gate decides WHEN it applies.
// testnet/regtest activate at genesis, and mainnet now does too
// (CROSS_SETTLE_CAP_MAINNET_TIME in protocol_changes.js is 0): ARMED at genesis
// by the 2026-09-09 ruling, identity on the indexed mainnet history (this cap
// reinterprets 0 already-indexed cross-settle blocks, measured 2026-09-09).
addGate('protocol/constants.CROSS_SETTLE_MAX_PER_BLOCK', 'constant', 25);

// ── Cross-chain bridge (xchain-bridge spec section 8, D5) ───────────────────
// How many finalized bridge_transfers rows the XBRIDGE settle pass may apply per
// DESTINATION CHAIN per block. Overflow carries forward in (snapshot_block,
// transfer_id) order and is never dropped, the XCALL and CROSS_SETTLE discipline.
//
// UNGATED, unlike CROSS_SETTLE_MAX_PER_BLOCK above, and the difference is not a
// preference: that cap re-sliced history a chain had already indexed, so it needed
// its own flag day. This one ships INSIDE XCHAIN_BRIDGE_ACTIVATION. No chain has
// ever applied an XBRIDGE settle leg below that height, so there is no history for
// the cap to reinterpret and a second activation read would only add a way for the
// two heights to disagree.
addGate('protocol/constants.XBRIDGE_MAX_PER_BLOCK', 'constant', 25);

// ── Token-policy inheritance (xchain-token-bridge-policy spec, D22, R2) ─────
// How many finalized policy_snapshots rows the pass may apply per block per chain,
// at the head of the XBRIDGE pass and before any in-leg at that block. Lower than
// the transfer cap because one snapshot is up to six injected actions (two list
// creates or edits per list, an ISSUE 5 and a SLEEP), each rewriting a full
// membership, where one transfer is a single credit. Overflow carries forward in
// (snapshot_block, snapshot_id) order across ticks and policy_seq order within a
// tick, never dropped.
addGate('protocol/constants.XPOLICY_MAX_PER_BLOCK', 'constant', 5);

// Ceiling on the membership of a list a bridged token may carry (R2, RULED a
// 2026-09-11). No cap existed anywhere before this: LIST items are variadic and the
// only bound was MAX_ACTION_DATA_LENGTH on ONE action, while every edit persists a
// complete membership snapshot, so a list grows without limit across edits. Every
// policy snapshot carries the FULL membership as transport and every destination
// rewrites it into list_items on apply, so the origin's list length is write
// amplification on every chain holding a copy.
//
// Enforced in two places, neither of them a hash input: ISSUE format 7 with a
// non-empty BRIDGE_CHAINS is refused when either list is larger, and the hub
// declines to sign a snapshot over a larger membership (the previous snapshot stays
// in force and the watch raises WARN). Nothing depends on the number in a hash, so a
// later flag day can raise it.
addGate('protocol/constants.XPOLICY_MAX_MEMBERS', 'constant', 10000);

// ── Token-gated content (PC-29) ─────────────────────────────────────────────
// Fixed fractional scale for comparing FILE.GATE_MIN_AMOUNT thresholds against a
// holder's balance. The wallet scales both sides to this many fractional digits
// as BigInt (packages/core THRESHOLD_SCALE); the indexer compares with mathjs
// bignumber. A threshold carrying MORE decimal places than this is
// unrepresentable on the wallet side, so the two implementations would disagree
// on the last digit for values neither considers malformed. The indexer therefore
// bounds a threshold's decimal places at min(gate tick divisibility,
// THRESHOLD_SCALE) rather than at divisibility alone.
//
// Cross-repo twin: xchain-wallet packages/core THRESHOLD_SCALE. These two must
// move together or the disagreement returns.
addGate('protocol/constants.THRESHOLD_SCALE', 'constant', 18);

// ── Stake-weighted quorum (STAKE_WEIGHTED_QUORUM / WI-1) ────────────────────
// Consensus-critical activation: at/above this BTC-anchored snapshot_block the
// federation quorum becomes stake-WEIGHTED (signers' summed source stake must
// exceed 2/3 of total active snapshot stake) instead of count-based (2f+1 of the
// pubkey COUNT).
//
// Keyed on the BTC `snapshot_block` carried by every settlement/checkpoint
// canonical (NOT each chain's local processing height) so the hub and the BTC,
// LTC and DOGE indexers all flip on the SAME anchor. A per-chain local-height
// gate would fork: one snapshot_block lands at different local heights per chain.
// The `network` is also taken from the row, so the gate is env-independent.
//
// Enforced IDENTICALLY by the hub (every PBFT tally engine), the indexer
// (every settlement-signature gate + recovery), and the sdk/explorer/sync
// verifiers. All five keep a local copy of this map; the cross-service
// regression suite asserts they equal these values, so the activation height
// can never silently diverge (a divergence forks the chain).
//
// mainnet is ARMED (2026-07-07) to a concrete near-term height: 961000, the
// BTC-anchored flag-day at which mainnet flips from the count-based quorum
// rule to stake-weighted. BTC anchor ~2026-08-04; hub + ALL indexers (+
// sdk/explorer/sync copies) MUST deploy before this height. testnet/regtest
// activate at genesis so the e2e / regtest stack exercises stake-weighting
// from block 0.
addGate('protocol/constants.STAKE_WEIGHTED_QUORUM_ACTIVATION', 'height', {
    mainnet: 961000,      // ARMED 2026-07-07: BTC anchor ~2026-08-04; deploy hub + ALL indexers (+ sdk/explorer/sync copies) before this height
    testnet: 0,
    regtest: 0,
});
