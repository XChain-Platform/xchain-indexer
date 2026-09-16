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
 * The SHARED block, part 3 of 5: rollcall_activation to stateHash
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
// rollcall_activation (continued)
// BTC blocks after the window closes before the epoch closes, giving the DOGE
// side time to bury. MUST be >= 1 on every network: a block's `block_time` is
// written by createBlock AFTER that block's own processing, so the window
// endpoint has to be a strictly earlier block than the close, or the close
// reads a timestamp that does not exist yet.
addGate('rollcall_activation.ROLLCALL_PROOF_DELAY_BLOCKS', 'constant', { mainnet: 36, testnet: 36, regtest: 2 });

// DOGE blocks past the window cut before a DOGE indexer's answer is admissible;
// the anchor rail's own burial depth. This is what bounds the one residual the
// design accepts: a DOGE reorg deeper than this, removing a counted signature
// after the BTC close has recorded its epoch, cannot be undone from BTC,
// because nothing there observes it and no un-evict rail exists.
addGate('rollcall_activation.ROLLCALL_DOGE_MATURITY', 'constant', { mainnet: 60, testnet: 60, regtest: 2 });

// K: consecutive ROLLED epochs a source must be absent for before eviction.
addGate('rollcall_activation.ROLLCALL_EVICT_MISSES', 'constant', 2);

// 2K: how many rolled epochs back the K-streak may reach. Bounds how far an old
// absence can travel, so a source that leaves for months and returns starts
// clean rather than resuming a stale streak.
addGate('rollcall_activation.ROLLCALL_STREAK_LOOKBACK', 'constant', 4);

// The frozen rollcall-publish reward, minted BTC-side to the ELECTED LEADER
// only -- never to whoever published first, which would be a fee-bidding race
// no hub can bump, since there is no fee-bump or RBF path anywhere in the hub.
// Parity with ANCHOR_REWARD_AMOUNT per the 2026-08-30 ruling. Never from the wire.
addGate('rollcall_activation.ROLLCALL_REWARD_AMOUNT', 'constant', '10.00000000');

// rollcall_gates_activation
// Per-network EPOCH height at/above which ROLLCALL is published as v1 with the
// GATES field and the epoch close records each signer's list.
addGate('rollcall_gates_activation.ROLLCALL_GATES_ACTIVATION', 'epoch', {
    mainnet: null,        // INERT placeholder: the operator owns this height
    testnet: 152208,      // SIZED 2026-09-08: the first epoch boundary (151200 + 1008) after the v0.16.0 roll, which lands between the 151200 and 152208 closes
    regtest: UNPINNED,   // ARMS AT 0 when the venue sets XC_ROLLCALL_GATES_REGTEST_ACTIVATION
});

// The documented regtest arming height: genesis, a multiple of the 30-block
// regtest interval, so epoch 0 is a real v1 epoch.
addGate('rollcall_gates_activation.ROLLCALL_GATES_REGTEST_ARMED_HEIGHT', 'constant', 0);

// The one environment variable this module reads, and only ever for regtest.
addGate('rollcall_gates_activation.ROLLCALL_GATES_REGTEST_ENV', 'constant', 'XC_ROLLCALL_GATES_REGTEST_ACTIVATION');

// snapshot_reorg_buffer
// The reorg-depth buffer every party in a federation must resolve capability
// snapshots at. 6 = the BTC confirmation depth the platform already treats as
// buried (XCHAIN_CONFIRMATIONS_BTC). CONSENSUS-CRITICAL: the hub subtracts this
// before every snapshot lookup and refuses to boot on mainnet/testnet when a local
// override diverges (CapabilitySnapshot._resolveReorgBuffer), so a verifier that
// buries by a different depth resolves a different set than the signer.
addGate('snapshot_reorg_buffer.CANONICAL_REORG_BUFFER', 'constant', 6);

// Per-network activation height (LOCAL COPY of the canonical map in
// xchain-documentation/protocol/constants.js, kept equal by the cross-service
// regression suite). Keyed on the BTC-anchored declared snapshot_block.
//
// Arming this changes acceptance itself, so a one-sided or partially-rolled-out arm would
// fork the fleet rather than fix it, and it re-reads every checkpoint already signed and
// anchored under the current reading. There is no such checkpoint on any network: mainnet
// was ruled at genesis on 2026-09-09 after measuring 0 validators, 0 stakes and 0
// quorum-signed artifacts on every mainnet chain, so burying reinterprets nothing there and
// the from-genesis OLD-vs-ON replay is the witness. Regtest is active from genesis (no
// history to preserve; the regtest suites exercise the buried resolution from block 0).
addGate('snapshot_reorg_buffer.SNAPSHOT_BURIAL_ACTIVATION', 'height', {
    mainnet: 0,           // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 validators, 0 stakes, measured 2026-09-09)
    // ARMED AT GENESIS, operator-ratified 2026-08-18 as part of the pre-launch "every
    // feature active on testnet" ruling. Safe because testnet's indexer state is being
    // REBUILT from the chain before launch, and because testnet carries no artifacts
    // signed under the current reading for this to reinterpret: the live explorer reports
    // 0 validators, 0 capability stakes and 0 checkpoints on BTC testnet, so nothing has
    // ever been quorum-signed there. Mainnet was measured the same way on 2026-09-09.
    testnet: 0,
    regtest: 0,
});

// stake_weight_collation_activation
// The collation the consensus ordering is pinned to once the rule is live.
// FROZEN: this string is the emitted SQL of a consensus query, so changing it
// after any chain arms re-orders the cap survivors on a replay, which is a
// fork. utf8_bin is the collation the sibling consensus reads already pin, and
// it is charset-compatible with the utf8/utf8mb3 columns involved.
addGate('stake_weight_collation_activation.STAKE_WEIGHT_COLLATION', 'constant', 'utf8_bin');

// Per-chain activation heights, interpreted against the chain's own block_index.
// `null` = NOT YET PINNED = inert (legacy unpinned ordering, byte-identical
// replay). Mainnet is armed at genesis by the 2026-09-09 ruling: the ordering
// this gate pins only decides which stake sources and keys survive the snapshot
// cap, and mainnet holds 0 stakes (measured 2026-09-09), so the binary order and
// the folding order select the same empty set and a height of 0 reinterprets
// nothing. The usual retroactivity hazard (a height a carrying fleet has already
// passed) is what a from-genesis OLD-vs-ON replay witness per chain proves away
// here. Testnet stays unpinned: it carries live stakes, so its height is pinned
// at flag-day assembly above the tip recorded then, in ONE coordinated deploy of
// BOTH fleets (a height armed while one fleet is behind halts the follower).
addGate('stake_weight_collation_activation.STAKE_WEIGHT_COLLATION_ACTIVATION', 'height', {
    'BTC:mainnet':  0,      // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 stakes, measured 2026-09-09)
    'LTC:mainnet':  0,
    'DOGE:mainnet': 0,
    'BTC:testnet':  null,
    'LTC:testnet':  null,
    'DOGE:testnet': null,
    regtest: 0,
});

// Columns whose charset/collation the consensus ordering depends on, and the
// charset/collation src/sql declares for each.
addGate('stake_weight_collation_activation.STAKE_WEIGHT_ORDERING_COLUMNS', 'constant', [
    { table: 'index_addresses', column: 'address', charset: 'utf8', collation: 'utf8_general_ci' },
    { table: 'index_pubkeys',   column: 'pubkey',  charset: 'utf8', collation: 'utf8_general_ci' },
]);

// stake_weighted_quorum
// Per-network activation height (LOCAL COPY of the canonical map in
// xchain-documentation/protocol/constants.js, kept equal by the cross-service
// regression suite). Keyed on the BTC-anchored snapshot_block, NOT each chain's
// local height, so every chain + the hub flip on the same anchor.
addGate('stake_weighted_quorum.STAKE_WEIGHTED_QUORUM_ACTIVATION', 'height', {
    mainnet: 961000,      // ARMED 2026-07-07: BTC anchor ~2026-08-04; deploy hub + ALL indexers (+ sdk/explorer/sync copies) before this height
    testnet: 0,
    regtest: 0,
});

// stateHash
// Launch genesis version = 1. Folded into the hash so two preimage schemes can
// never compare equal. A dev iteration briefly numbered a changed preimage 2;
// pre-launch that was collapsed back to 1 (mirroring the BLOCK_HASH_VERSION 2->1
// collapse) because there is no launch-committed state to migrate, only a clean
// fleet-wide reindex. Bump ONLY on a deliberate preimage change AFTER launch.
// Independent of BLOCK_HASH_VERSION (the three-hash baseline is untouched by this
// additive, non-consensus integrity hash).
addGate('stateHash.STATE_HASH_VERSION', 'constant', 1);

addGate('stateHash.DEACTIVATION_TABLES', 'constant', ['stakes', 'delegations', 'contract_stakes', 'contract_delegations']);

addGate('stateHash.SLASH_SPECS', 'constant', [
    { table: 'stakes',            debits: 'capability_slash_debits', target: 'stakes'            },
    { table: 'unstakes',          debits: 'capability_slash_debits', target: 'unstakes'          },
    { table: 'contract_stakes',   debits: 'contract_slash_debits',   target: 'contract_stakes'   },
    { table: 'contract_unstakes', debits: 'contract_slash_debits',   target: 'contract_unstakes' }
]);

addGate('stateHash.REQUEST_STATUS_TABLES', 'constant', ['attests', 'xcalls']);

addGate('stateHash.COOLDOWN_TABLES', 'constant', ['unstakes', 'contract_unstakes']);

// ── Index-map state-hash flag-day (id-determinism P4) ────────────────────────
// Promotes the index_addresses / index_tickers id->string MAP from the advisory
// /status checksum (BlockHasher.computeIndexMapChecksum) to an ENFORCED per-block
// class of this replication-integrity hash: the follower recomputes state_hash and
// HALTS on mismatch, so an id-map divergence (a wire ^id resolving to a different
// entity, or a recovered node that built a different map) is caught at the block
// that introduced it instead of silently forking.
//
// This is the ONE place state_hash deliberately hashes the surrogate id (not just
// the resolved string): the id IS the value under protection. It is sound only
// because the compaction + F1a work made every id-assignment path deterministic
// (in-block dense counter + rollback; recovery stages by string and the apply hook
// assigns the deterministic id) - so a from-genesis node and a recovered node now
// produce byte-identical (id, address) pairs over the same chain.
//
// Per-block DELTA (block_index = B), mirroring the rest of this preimage's per-block
// shape: the rows whose deterministic id was first assigned at B. A cumulative
// checksum would chain every block on all history (the credits-chaining trap the
// header warns about); the delta catches a divergence at its origin block.
//
// Gated on the chain's OWN local block_index (like state_commitment_activation, not
// the BTC-anchored snapshot_block): each chain arms at its own flag-day height.
// Landed DEFAULT INERT (placeholder 999999999) so shipping the class was a strict
// no-op on the live fleet - the class is omitted from the preimage below the
// threshold, leaving state_hash byte-identical to the pre-feature shape. Armed
// fleet-atomically (real per-chain heights) exactly as WI-2 / state_commitment
// did; regtest was the last inert key (armed 2026-07-16). No
// STATE_HASH_VERSION bump: a block is unambiguously pre- or post-activation on a
// given network, so the two preimage shapes cannot collide.
addGate('stateHash.INDEX_MAP_STATE_HASH_ACTIVATION', 'height', {
    // Heights are the chain's OWN local block_index at/after which the index-map
    // folds into state_hash. One-way door: once a chain crosses its height, any
    // process still on a different height computes a divergent state_hash and a
    // follower HALTS, so every indexer + sync process must run this exact map
    // BEFORE the chain reaches the height. Keep this map byte-identical to the
    // xchain-{indexer,sync}/src/stateHash.js twin.
    mainnet: 0,           // ARMED at the genesis launch reindex (folds from genesis, no mid-chain flag-day)
    testnet: 0,           // ARMED at the genesis launch reindex (clean reseed accompanies it)
    regtest: 0,           // ARMED from genesis 2026-07-16: fresh stacks exercise the class end to end; pre-existing regtest venues need a clean reseed
});

// ── VOTE poll-finalization state-hash flag-day ────────────────────────────────
// Promotes the polls finalization flip (VOTE v2 mutates a SURVIVING polls row
// terminal IN PLACE) from an unhashed updated_rows mutation to an ENFORCED
// per-block class of this replication-integrity hash, closing the one mutation
// class where a follower silently dropping the flip upsert diverged with no halt
// (the attests/xcalls v0 flips have had this coverage from the start).
//
// Same gating model as INDEX_MAP_STATE_HASH_ACTIVATION above (keyed on the
// chain's OWN local block_index), but ARMED MID-CHAIN, which forces per-chain
// keys: unlike the genesis-armed index-map class, one shared 'mainnet' height
// cannot fit BTC (~957k) and DOGE (~6.28M) simultaneously. Lookup is
// '<COIN>:<network>' first, then the bare network key (regtest keeps one key;
// unknown -> inert). ARMED 2026-07-07 at tip + margin per chain: the whole
// fleet (every indexer + sync process) MUST run this map before the EARLIEST
// chain crosses its height (see the deploy-by note per line), or followers
// still on the old map false-halt at the boundary. A missed deadline is
// recoverable by bumping the not-yet-crossed heights before deploy. No
// STATE_HASH_VERSION bump: a block is unambiguously pre- or post-activation.
// Keep byte-identical to the xchain-sync twin.
addGate('stateHash.POLL_FINALIZE_STATE_HASH_ACTIVATION', 'height', {
    'BTC:mainnet':  958500,     // armed 2026-07-07 at tip 957062; ~10 days of margin
    'LTC:mainnet':  3143000,    // armed 2026-07-07 at tip 3138154; ~8 days
    'DOGE:mainnet': 6291000,    // armed 2026-07-07 at tip 6280094; ~7.5 days
    'BTC:testnet':  145000,     // armed 2026-07-07 at tip 143299
    'LTC:testnet':  4805000,    // armed 2026-07-07 at tip 4797675
    'DOGE:testnet': 67000000,   // armed 2026-07-07 at tip 66498605 (fast chain, wide margin)
    regtest: 0,                 // armed from genesis: fresh regtest stacks exercise the class end to end
});

// ── tokens.supply state-hash flag-day (F-1 closure) ──────────────────────────
// The hash twin of the updated_rows tokens-supply replication class: supply is
// mutated IN PLACE on a surviving token row (its action_index stays at the
// DEPLOY action), so no consensus block hash and no other state_hash class
// covers it; a follower silently dropping the supply upsert served a stale
// supply with no halt. Supply changes exactly when a credit/debit/escrow row is
// written for the tick, so the per-block class hashes (tick, supply) for every
// tick touched by a ledger row at block B. Same per-chain arming map and
// deploy-by constraint as POLL_FINALIZE above; the two classes flip together.
addGate('stateHash.TOKEN_SUPPLY_STATE_HASH_ACTIVATION', 'height', {
    'BTC:mainnet':  958500,     // armed 2026-07-07, same heights as POLL_FINALIZE
    'LTC:mainnet':  3143000,
    'DOGE:mainnet': 6291000,
    'BTC:testnet':  145000,
    'LTC:testnet':  4805000,
    'DOGE:testnet': 67000000,
    regtest: 0,
});

// ── BET status-flip state-hash flag-day ───────────────────────────────────────
// The hash twin of the updated_rows BET replication classes. BET carries THREE
// in-place mutations on surviving rows, all stamped with the block that made
// them: the closed latch (bet_feeds.closed_block), the feed terminal flip
// (bet_feeds.terminal_block: resolved/resolved_void/cancelled/expired) and the
// per-bet settlement flip (bets.settled_block: won/lost/refunded). None of them
// is visible to the action-scoped ledger hashes once the row's creating action
// is below the block, so a follower silently dropping one diverged with no halt
// (the exact class this file's header documents). Although the BET action is
// genesis-active, the hash class CANNOT be: mainnet/testnet fleets already
// compare state hashes every block, so an ungated preimage-shape change would
// halt a mixed-version fleet instantly. Same per-chain arming model as
// POLL_FINALIZE/TOKEN_SUPPLY above.
addGate('stateHash.BET_STATUS_STATE_HASH_ACTIVATION', 'height', {
    // Heights pinned via roundUp1000(tip + 21 days x nominal blocks/day), never
    // lowered once set: a height that falls in the past is not a flag day at all,
    // since a node replaying from genesis applies the rule from it while a
    // long-running node never did, and the two diverge at the first hash
    // comparison (caught once on LTC:testnet, whose first pinned height the chain
    // had already passed). Re-verify these against live tips before each deploy.
    'BTC:mainnet':  963000,   // tip 959,853 (2026-07-27) + 21d @144/day = 962,877
    'LTC:mainnet':  3162000,   // tip 3,149,481 + 21d @576/day = 3,161,577
    'DOGE:mainnet': 6338000,   // tip 6,307,307 + 21d @1440/day = 6,337,547
    // Testnet is genesis-active as of the 2026-08-10 fresh testnet genesis: the
    // chain restarts at firstBlock (BTC 147500 / LTC 4855000 / DOGE 67815000) with
    // no pre-rule history, so there is nothing for a mid-chain boundary to protect.
    // Kept value-equal to CARET_REF_STRICT_ACTIVATION and
    // LIST_EDIT_RESOLUTION_ACTIVATION, which CI asserts.
    'BTC:testnet':  0,
    'LTC:testnet':  0,
    'DOGE:testnet': 0,
    regtest: 0,                 // armed from genesis: fresh regtest stacks exercise the class end to end
});

// ── Archive-head anchor versions ──────────────────────────────────────────────
// The anchor_actions versions that carry an archive HEAD (a signed batch header
// whose v2 continuation chunks reassemble against it): v1, the publisher-bearing
// archive anchor, and nothing else. It is a one-member set because the wire
// families are version-disjoint by construction (bundle {0}, archive head {1},
// chunk {2}); it stays a SET rather than a scalar so a later archive version joins
// it without touching the ten splice sites that read the SQL fragment.
// Every predicate that selects "the archive parent of a v2 chunk" MUST
// use this set: the invalid_archive stamp, its reorg reset, the forward
// updated_rows class and the state-hash class below all target the same rows.
// SINGLE SOURCE OF TRUTH for xchain-indexer rollback.js + this file's class 6,
// and (via the byte-identical xchain-sync twin) ClientRollback.js +
// updatedRows.js. db.js/recovery.js carry matching predicates.
addGate('stateHash.ARCHIVE_HEAD_VERSIONS', 'constant', [1]);

// SQL fragment form, spliced as `p.version ` + ARCHIVE_HEAD_VERSIONS_SQL.
// The IN list of ARCHIVE_HEAD_VERSIONS above; the two move together.
addGate('stateHash.ARCHIVE_HEAD_VERSIONS_SQL', 'constant', 'IN (1)');

// ── invalid_archive archive-head-coverage state-hash flag-day ─────────────────
// Widens the anchor_invalid state-hash class (class 6 below) from a hard-coded
// v1 parent to whatever ARCHIVE_HEAD_VERSIONS holds, closing the integrity-hash
// blind spot where an invalid_archive stamp on a non-v1 archive head was invisible
// to the follower's recompute (a follower silently dropping that upsert diverged
// with no halt). With the version set restarted the two predicates coincide (the
// archive head IS v1 again), so the gate is inert in effect and kept only so the
// widening stays landed for the next archive version. Changes the class's row
// selection, hence the hashed preimage, so it
// is gated exactly like POLL_FINALIZE above (per-chain keys on the chain's OWN
// local block_index). No STATE_HASH_VERSION bump: a block is unambiguously pre-
// or post-activation on a given network. Keep byte-identical to the xchain-sync
// twin; every indexer AND sync process on a network must run this code, since a
// straggler on the v1-only predicate recomputes a different preimage and halts.
// TESTNET IS ARMED AT 0 (operator ruling 2026-08-11, applied 2026-08-14): the
// re-genesised testnet carries no pre-flag blocks, so there is no legacy preimage
// to stay byte-identical with, and arming at genesis made testnet the network that
// exercises the widened class first. MAINNET IS ARMED AT 0 by the 2026-09-09
// ruling: mainnet holds 0 archive chunks (measured 2026-09-09), so the widened
// predicate and the legacy v1-only one select the same empty class and the
// genesis-armed preimage is identical to the deployed one; the 56 DOGE ANCHOR
// actions on record are checked by the from-genesis replay witness.
addGate('stateHash.ARCHIVE_INVALID_STATE_HASH_ACTIVATION', 'height', {
    'BTC:mainnet':  0,          // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 archive chunks, measured 2026-09-09)
    'LTC:mainnet':  0,
    'DOGE:mainnet': 0,
    'BTC:testnet':  0,          // armed from genesis 2026-08-11 ruling
    'LTC:testnet':  0,          // armed from genesis 2026-08-11 ruling
    'DOGE:testnet': 0,          // armed from genesis 2026-08-11 ruling
    regtest: 0,                 // armed from genesis: fresh regtest stacks exercise the widened class end to end
});
// SHARED-GATES END
