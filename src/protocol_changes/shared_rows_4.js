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
 * The SHARED block, part 4 of 5: stateHash to token_bridge_activation
 *
 * One SHARED block part. The region between the two marker lines is
 * BYTE-TWINNED into the registry of xchain-sync, xchain-hub, xchain-explorer
 * and xchain-sdk: each consumer keeps the same bytes and replaces only the
 * require line below with its own queue module. What may live between the
 * markers: `addGate(key, unit, table)` calls with LITERAL values (a table, a
 * number, a string or literals joined by +, a RegExp, an array), one call per
 * row, at column zero, and comments. No require, no computed value, nothing
 * from outside the block but addGate, UNARMED and UNPINNED. A regtest entry a
 * venue arms from its environment is written UNPINNED here and armed by the
 * wrapper at registration (shared_rows.js), so the block stays data.
 *
 * Rows are grouped by module stem in alphabetical order; a stem's rows keep
 * the order the module declared them. Keys never change (I4).
 *
 ********************************************************************/

'use strict';

const { addGate, UNARMED, UNPINNED } = require('./shared_rows.js');

// SHARED-GATES BEGIN
// stateHash (continued)
// ── invalid_archive chunk-height key repair state-hash flag-day ───────────────
// Class 6 scopes the invalid_archive stamp to the block the COMPLETING v2 chunk
// landed in. It has always keyed that scope on `c.block_index`, and that column
// is NEVER populated on a v2 row: `block_index` carries BLOCK_INDEX_CHECKPOINTED
// (the checkpointed height on the OTHER chain, see anchor_actions.sql), which is
// assigned only in anchor.js `_parseCheckpoint`; `_parseContinuation` never sets
// it, and db.js binds the column NULL when the key is absent. `NULL BETWEEN x AND
// y` is never true, so the class has selected ZERO rows on every node since it
// landed, on every network. The completing chunk's real height is
// `block_index_doge` (the DOGE block the ANCHOR action landed in, NOT NULL by
// schema), the same height the class is being scoped to, and the same distinction
// anchor.js `_archiveAuthorScope` already draws.
//
// Repairing the key CHANGES THE PREIMAGE the moment a stamped batch exists: a
// node on the repaired predicate hashes the parent row, a node on the broken one
// hashes nothing, and the fleet halts at that block. So the repair is a flag day
// like every other class-shape change here, gated per chain on the chain's OWN
// local block_index, DEFAULT INERT: below the threshold the query keeps the
// broken `c.block_index` key and the preimage stays byte-identical to what every
// deployed node computes today.
//
// MAINNET IS ARMED AT 0 by the 2026-09-09 ruling. The repair only moves the
// preimage where a stamped archive batch exists, and mainnet holds 0 archive
// chunks (measured 2026-09-09), so the repaired key and the broken one select
// the same empty class: arming at genesis leaves the preimage every deployed
// mainnet node computes unchanged, and the from-genesis replay witness is the
// proof of that identity (the 56 DOGE ANCHOR actions on record are covered by it).
// TESTNET TAKES REAL FUTURE HEIGHTS, not 0: testnet is a public chain that has
// run since the 2026-08-10 re-genesis, so a height of 0 here would be retroactive
// rather than a flag day. They are sized from the 2026-09-09 tips (TBTC 151701,
// TLTC 4883295, TDOGE 67881714) plus about 22 days, so the v0.17.0 train is live
// on every testnet process before the earliest chain crosses.
// Deploy order is not free: xchain-sync updatedRows.js carries the SAME broken key
// on the replication side (fixed there un-gated, since shipping a row is not a
// preimage) and must be live FIRST, or a follower is asked to hash a stamped
// parent row it was never sent. regtest is armed at 0 so fresh regtest stacks
// exercise the repaired class end to end. No STATE_HASH_VERSION bump: a block is
// unambiguously pre- or post-activation. Keep byte-identical to the
// xchain-sync twin.
addGate('stateHash.ARCHIVE_INVALID_HEIGHT_KEY_ACTIVATION', 'height', {
    'BTC:mainnet':  0,          // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 archive chunks, measured 2026-09-09)
    'LTC:mainnet':  0,
    'DOGE:mainnet': 0,          // DOGE is the anchor chain, and the 56 mainnet ANCHORs there carry no archive chunk
    'BTC:testnet':  155000,     // tip 151701 (2026-09-09) + 3299 blocks @144/day = ~23 days
    'LTC:testnet':  4896000,    // tip 4883295 + 12705 blocks @576/day = ~22 days
    'DOGE:testnet': 67915000,   // tip 67881714 + 33286 blocks @1440/day = ~23 days
    regtest: 0,                 // armed from genesis: fresh regtest stacks exercise the repaired class end to end
});

// The column class 6 scopes the completing v2 chunk by, as a SQL fragment. Broken
// legacy key below the flag day, repaired key at/after it. Exported so the twin
// repos and the drift guards can assert on ONE definition rather than a literal.
addGate('stateHash.ARCHIVE_CHUNK_HEIGHT_COL', 'constant', 'c.block_index_doge');

addGate('stateHash.ARCHIVE_CHUNK_HEIGHT_COL_LEGACY', 'constant', 'c.block_index');

// state_commitment_activation
// Per-chain activation height, interpreted as the processing chain's OWN
// block_index. At/after this height the new roots are committed; below it the
// state_tree_roots row is absent and the getblockhashes RPC returns null roots.
// ARMED MID-CHAIN like the stateHash.js class maps, which forces per-chain keys
// (one shared 'mainnet' height cannot fit BTC ~957k and DOGE ~6.28M at once).
// Lookup is '<COIN>:<network>' first, then the bare network key (regtest keeps
// one key; unknown -> inert/off, which is safe: roots simply stay absent).
// Same heights as the two state-hash gates armed 2026-07-07, so ONE deploy-by
// date governs all Cohort-C flips; each height precedes the Cohort-B BTC
// anchor (961000) as the checkpoint-commitment ordering requires.
addGate('state_commitment_activation.STATE_COMMITMENT_ACTIVATION', 'height', {
    'BTC:mainnet':  958500,     // ARMED 2026-07-07 at tip 957062; ~10 days of margin
    'LTC:mainnet':  3143000,    // ARMED 2026-07-07 at tip 3138154; ~8 days
    'DOGE:mainnet': 6291000,    // ARMED 2026-07-07 at tip 6280094; ~7.5 days
    'BTC:testnet':  145000,     // ARMED 2026-07-07 at tip 143299
    'LTC:testnet':  4805000,    // ARMED 2026-07-07 at tip 4797675
    'DOGE:testnet': 67000000,   // ARMED 2026-07-07 at tip 66498605 (fast chain, wide margin)
    regtest: 0,                 // armed from genesis: fresh regtest stacks exercise the roots end to end
});

// state_key_collation_activation
// Per-chain activation height, interpreted as the processing chain's OWN
// block_index. At/after the height the binary-collation (utf8_bin) queries
// run; below it the legacy folding (utf8_general_ci) queries run.
//
// *** ARMED 2026-07-10 *** Heights are each processing chain's OWN block_index,
// sequenced after the other armed cohorts (state_commitment 958500/3143000/
// 6291000, swq_source_cap 960000, Cohort-B anchor 961000 on BTC) with fleet
// deploy-by margin; testnets flip late July so they prove the binary path
// before mainnet. The xchain-sync twin mirrors this file byte-for-byte in the
// same change. Regtest is armed from genesis so fresh regtest stacks and the
// e2e conformance scenario exercise the binary path end to end.
addGate('state_key_collation_activation.STATE_KEY_COLLATION_ACTIVATION', 'height', {
    'BTC:mainnet':  962500,     // ARMED 2026-07-10 at tip 957491 (~Aug 13; ~10 days past Cohort-B 961000)
    'LTC:mainnet':  3160000,    // ARMED 2026-07-10 at tip 3140024 (~Aug 14)
    'DOGE:mainnet': 6335000,    // ARMED 2026-07-10 at tip 6284614 (~Aug 15)
    // Testnet is genesis-active as of the 2026-08-10 fresh testnet genesis. LTC was
    // the one entry still ahead of the new firstBlock (4890000 > 4855000); BTC and
    // DOGE were already behind it and are zeroed with it so the map reads as one
    // rule rather than three coincidences. The documented ordering still holds:
    // state_commitment is genesis-active too, so this never precedes it.
    'BTC:testnet':  0,
    'LTC:testnet':  0,
    'DOGE:testnet': 0,
    regtest: 0,                 // armed from genesis: fresh regtest stacks exercise the binary path end to end
});

// state_subtree_activation
// The reserved slots, in merkle.STATE_SUBTREES order. Order matters: it IS the
// leaf order of the top-level fixed Merkle tree. The conformance test asserts
// this equals STATE_SUBTREES minus the two v1 slots, so the two lists cannot drift.
addGate('state_subtree_activation.RESERVED_SUBTREES', 'constant', ['ownership_root', 'tokens_root', 'contract_state_root']);

// Per-slot, per-chain activation height, interpreted as the processing chain's
// OWN block_index. At/after the height the slot MAY carry a real sub-root; below
// it (and for any chain absent from the map) the slot commits EMPTY_SMT_ROOT.
//
// *** ARMED: contract_state_root on BTC:regtest at 10000 (2026-07-28) and from
// *** GENESIS on BTC, LTC and DOGE testnet.
// The testnet entries read 0 rather than a measured height because those chains
// are rebuilt from chain before launch, so every block is derived under this rule
// and no row written without it survives to disagree. BTC:testnet held 146500
// until the 2026-08-10 re-genesis moved firstBlock above it, which left the
// height inert but readable as a boundary that no longer exists; LTC and DOGE had
// no entry at all. Genesis on all three states the intent directly and matches
// the escrow leaf below, so one reindex covers both stages.
//
// The ordering rule is satisfied at 0: a slot must never arm below its chain's
// state_key_collation_activation height, or the SMT is built over a
// collation-FOLDED key set and forks. All three testnets are genesis-active
// there too (see state_key_collation_activation.js), so nothing precedes it.
//
// Everything else is still inert, on every chain and network. MAINNET IS UNARMED
// for every slot.
//
// Regtest armed FIRST and alone, and only once the derivation existed. The
// earlier rule here ("a slot stays off even on regtest, because an armed slot
// with no derivation commits a WRONG root rather than a missing one") was about
// the carrier era; Stage A's derivation, its golden vectors, its serving surface
// and its real-venue conformance all landed before that height was set. Regtest
// is where being wrong costs a chain reset and nothing more, so it is the venue
// that earns the right to arm testnet, and testnet earns mainnet.
//
// All three testnet chains join it from genesis. Both hard preconditions hold,
// and they hold for DIFFERENT reasons than on regtest (spec §3 Stage A):
//   1. collation: state_key_collation_activation is genesis-active on BTC, LTC
//      and DOGE testnet, so at height 0 nothing precedes it and the SMT is built
//      over the binary-collation key set rather than a collation-FOLDED one.
//      Regtest satisfies the same rule trivially, being armed from genesis too.
//   2. NUL keys: isStateKeyNulRejectActive returns true unconditionally for
//      testnet AND regtest (xchain-vm), so on neither network can a contract
//      plant a key that throws in joinFields and halts the arming block's
//      buildFull. Mainnet is a DATE and is why no mainnet height may be set
//      here yet.
//
// No per-chain argument separates the three: since the fresh testnet genesis
// their collation heights are all 0, so precondition 1 is satisfied identically
// and none of them is closer to or further from eligibility than another.
//
// DOGE:testnet is SYNC_EXCLUDE'd on the sync client, so its arming exercises the
// source alone. That bounds the EVIDENCE, not the eligibility: BTC:testnet is
// the only testnet chain with a live source-plus-follower pair, so it is the one
// whose arming gets a cross-twin check, and the chain to read when asking
// whether the twins agree.
//
// Honest limit on what genesis arming proves: a testnet chain with no
// contract_state rows commits EMPTY_SMT_ROOT for the slot, so state_root does
// not move at all (a named-but-empty slot is byte-identical to a padded one, see
// the header). What arming really exercises there is the version path:
// state_root_version reads 2 and flows through getblockhashes into the signed
// checkpoint canonical. Exercising the DERIVATION needs contract state on the
// chain first, which BTC:testnet now has and the other two do not.
//
// Arming order is fixed by the design doc: contract_state_root first (Stage A,
// and never below that chain's state_key_collation_activation height, or the SMT
// is built over a collation-FOLDED key set and forks), ownership/tokens later.
addGate('state_subtree_activation.STATE_SUBTREE_ACTIVATION', 'constant', {
    ownership_root:      {},
    tokens_root:         {},
    contract_state_root: {
        'BTC:regtest':  10000,
        'BTC:testnet':  0,
        'LTC:testnet':  0,
        'DOGE:testnet': 0,
    },
});

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
addGate('state_subtree_activation.STATE_SUBTREE_SHADOW', 'constant', {
    ownership_root:      {},
    tokens_root:         {},
    contract_state_root: {},
});

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
// Armed from genesis on every testnet chain, and on regtest at 11200.
//
// Two conditions make a genesis height correct here rather than merely convenient. Stage A
// (contract_state_root) must already be live on the chain, since this leaf moves
// balances_root and Stage B is defined to follow Stage A; on the testnet chains it is.
// And the chain's key collation must be genesis-active, which it is on all three.
//
// A genesis height also removes the arming BOUNDARY entirely: there is no below-arming
// region for a locked-balance proof to fall into, so the seeding order that matters when
// arming mid-chain does not apply. That holds only where indexer state is rebuilt from the
// chain, which is a precondition of this height.
//
// The derivation carries no coin gate (see escrowLeafSubtree.js and escrowJournalWriter.js),
// so the three chains arm together. Mainnet stays unarmed because live light clients depend
// on balances_root there, which is the whole reason this is staged at all.
addGate('state_subtree_activation.ESCROW_LOCKED_LEAF_ACTIVATION', 'height', {
    'BTC:regtest':  11200,
    'BTC:testnet':  0,
    'LTC:testnet':  0,
    'DOGE:testnet': 0,
});

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
//
// *** OPEN ON BTC:testnet FROM BLOCK 148000 (2026-08-11, operator-approved),
// *** and nowhere else. Chosen at tip 147969, so the window starts ~31 blocks
// *** of lead ahead of the deploy, per §4's deploy-before-the-height rule.
//
// WHY THIS CHAIN AND WHY NOW. BTC:testnet is being re-seeded after the
// 2026-08-10 re-genesis, and the escrow seed (xchain-e2e-test
// bin/seed-escrow-state.js) posts its locking ORDERs after this height. That
// ordering is the whole point: with the window already open, those locks are
// journaled by the ORDINARY PER-BLOCK INCREMENTAL PATH - the one that runs on
// every block forever - rather than by the window-start replay. Both produce
// the same rows, and the harness already proves they agree on BTC:regtest
// (97 live keys, incremental against arming replay, measured 2026-08-11), but
// only the incremental path is the one no public chain has ever exercised.
//
// Nothing here is committed. balances_root stays byte-identical to v1 while a
// chain is only shadowing, and its locked-balance proofs stay refused, because
// ESCROW_LOCKED_LEAF_ACTIVATION above is what the explorer and the SDK verifier
// gate on.
//
// EMPTY, and deliberately so. The BTC:testnet entry that sat here at 148000 was
// dead the moment the leaf armed at genesis on all three testnets: ARMED WINS
// over a shadow, so the window could never open, while the surrounding prose
// still read as though the leaf were unarmed there. A shadow height below its
// own chain's arming height is unreachable by construction, so leaving it in
// place taught the next reader something false about what testnet commits.
addGate('state_subtree_activation.ESCROW_LOCKED_LEAF_SHADOW', 'height', {});

// swq_source_cap_activation
// CONSENSUS-CRITICAL caps on the source-keyed stake-weight snapshot. MUST be equal
// in xchain-indexer + xchain-sync (a drift forks the stakes_root at/after the
// activation height).
//   STAKE_WEIGHT_MAX_SOURCES         - cap on DISTINCT staking SOURCES in a weighted
//                                      snapshot (the consensus unit; Σ weight over
//                                      distinct sources = S). Over-fetched by one so a
//                                      genuinely larger federation is flagged truncated
//                                      and the primitive fails closed (a coordinated
//                                      cap raise then re-opens liveness).
//   STAKE_WEIGHT_MAX_KEYS_PER_SOURCE - cap on effective keys returned per source. Bounds
//                                      only the row/leaf count for a key-spamming source;
//                                      dropping a source's excess keys does NOT change its
//                                      weight (weight is per source, counted once) and does
//                                      NOT set truncated. Generous: no legit source
//                                      delegates near this many keys.
addGate('swq_source_cap_activation.STAKE_WEIGHT_MAX_SOURCES', 'constant', 1000);

addGate('swq_source_cap_activation.STAKE_WEIGHT_MAX_KEYS_PER_SOURCE', 'constant', 64);

// Per-chain activation height, interpreted as the processing chain's OWN block_index
// (same semantics as STATE_COMMITMENT_ACTIVATION). At/after the height the windowed
// source-cap is applied; below it the legacy uncapped key-LIMIT path runs.
//
// Option B (separate later height): the BTC:mainnet cap arms AFTER STATE_COMMITMENT
// (958500, ~2026-07-17) and AT/BEFORE STAKE_WEIGHTED_QUORUM arms (961000, ~2026-08-04),
// so the eviction fix is live when weighted quorum goes live without an 8-day
// hashed-root fleet-deploy race. For sub-cap honest federations the capped and
// uncapped stakes_root are byte-identical, so this mid-stream height introduces no
// real root discontinuity - only the >cap case (the attack) diverges, deterministically.
addGate('swq_source_cap_activation.SWQ_SOURCE_CAP_ACTIVATION', 'height', {
    'BTC:mainnet':  960000,     // Option B: after STATE_COMMITMENT (958500), before STAKE_WEIGHTED_QUORUM (961000)
    'LTC:mainnet':  3143000,    // inert (LTC commits the EMPTY stakes_root; capability staking is BTC-only) - pinned == STATE_COMMITMENT for parity
    'DOGE:mainnet': 6291000,    // inert (DOGE stakes_root empty) - pinned == STATE_COMMITMENT for parity
    'BTC:testnet':  0,          // capped from genesis; STATE_COMMITMENT testnet (145000) > 0, so testnet only ever commits capped roots (no discontinuity)
    'LTC:testnet':  0,
    'DOGE:testnet': 0,
    regtest: 0,                 // armed from genesis: fresh regtest stacks exercise the capped path end to end
});

// token_bridge_activation
// TOKEN_BRIDGE_ACTIVATION: the height (per network) on the chain being parsed at/above
// which XBRIDGE v3/v4 and ISSUE format 7 are legal. Below it v3 and v4 return the base
// spec's own string 'invalid: XBRIDGE before activation', v5 is never injected, and an
// ISSUE|7 keeps the parse verdict 'invalid: VERSION (unknown)' so no historical ISSUE on
// any chain changes status on replay.
//
// Keyed on the chain's OWN block_index, as XCHAIN_BRIDGE_ACTIVATION.
//
// Mainnet and testnet sit at the house sentinel 9999999999. Testnet is NOT armed with the
// XCHAIN bridge: no third-party token can be offered on a hub-trusted mint, so this gate
// waits on the base spec's D2 checkpoint cross-check being built and armed on that
// network. Regtest is 0 so the e2e rail exercises the armed rule from genesis.
addGate('token_bridge_activation.TOKEN_BRIDGE_ACTIVATION', 'height', {
    mainnet: 9999999999,
    testnet: 9999999999,
    regtest: 0,
});
// SHARED-GATES END
