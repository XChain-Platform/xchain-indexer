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
 * XChain Indexer - Table Lifecycle Registry part: block-scoped, bespoke and exempt rows
 *
 * The second half of the registry TABLES list: block-scoped consensus tables,
 * the rolled-back index lookups, recomputed and bespoke-rollback tables, the
 * tables intentionally never rolled back, the inert append-only lookups and
 * the sync-owned tables. The entry file (table_lifecycle.js beside this
 * directory) appends it after action_tables.js, so registry order is kept.
 * A twin copy of this part sits at the same relative path in xchain-sync.
 *
 ********************************************************************/

'use strict';

// The shared "deterministic projection" hash declaration, one object for every row.
const { DERIVED } = require('./action_tables.js');

const TABLES = [

    // ── Block-scoped consensus tables ──────────────────────────────────
    { table: 'blocks', owner: 'indexer', replication: 'stream:block', rollback: 'block', replicaRollback: 'mirror',
      hashed: { classes: [], note: 'Carrier of the hash chain itself (ledger/actions/contract/state hash ids per block).' } },
    { table: 'transactions', owner: 'indexer', replication: 'stream:block', rollback: 'block', replicaRollback: 'mirror',
      hashed: { classes: [], note: 'Mirror of decoder-confirmed chain transactions; correctness anchors to the coin chain, and action rows referencing them are hashed.' } },
    { table: 'validator_rewards', owner: 'indexer', replication: 'stream:block', rollback: 'block', replicaRollback: 'mirror',
      hashed: { classes: [],
                note: 'Oracle/attest rewards derive deterministically during block processing; anchor_* rounds arrive via hub push but are quorum-verified before persistence. Reward credits they mint are ledger-hashed.' },
      note: 'TWO block-scoped rollback keys, not one. block_index is the EARN block; derive_block_index is the MATERIALIZATION block, non-NULL only for the BTC-side anchor/archive derivation, which earns at the checkpoint SNAPSHOT_BLOCK but writes the row while processing a later BTC block. rollback() deletes on BOTH, or a reorg into the gap between them leaves a COLLECT-spendable reward a from-genesis replay has not derived yet.' },
    { table: 'rollcalls', owner: 'indexer', replication: 'stream:block', blockKey: 'close_block', rollback: 'special', replicaRollback: 'special',
      hashed: DERIVED,
      note: 'One row per epoch that reached its close block, INCLUDING unrolled ones. An unrolled epoch counts for nobody, but the K-streak must know which epochs to SKIP, and a missing row is indistinguishable from an epoch that has not closed yet. blockKey is close_block on BOTH dimensions: there is no block_index column, so rollback is SPECIAL (the generic DELETE ... WHERE block_index >= ? would throw 1054 and fail the whole rollback transaction) and the forward readers scope by the declared key (they used to assume block_index, raise 1054, and have it swallowed as an older source schema, so the table never replicated on any forward channel while the reorg delete still removed it). Carries the pinned responsible set, without which the K-streak cannot tell "present" from "was not in R".' },
    { table: 'rollcall_gates', owner: 'indexer', replication: 'stream:block', blockKey: 'close_block', rollback: 'special', replicaRollback: 'special',
      hashed: DERIVED,
      note: 'One row per VERIFIED signer of a ROLLED epoch at or above ROLLCALL_GATES_ACTIVATION: the consensus-gate keys that signer re-signed in ROLLCALL v1, written by the epoch close and read by the rules-aware attestation set filter (rollcall_gates_filter.js). BTC-side because ROLLCALL itself is DOGE-only, so this is the only artifact of an epoch the attestation set can read where it is derived. Keyed on close_block and rolled back with the same SPECIAL delete as rollcalls, for the same reason; the filter selects an epoch by close_block so a replay sees exactly the rows the live run saw.' },
    { table: 'rollcall_absences', owner: 'indexer', replication: 'stream:block', blockKey: 'close_block', rollback: 'special', replicaRollback: 'special',
      hashed: DERIVED,
      note: 'One row per responsible SOURCE that did not sign at a rolled epoch, pinned at close and never re-derived (SLASH rewrites stakes.amount in place, so a later re-derivation can differ from the set the verdict was taken over). evicted = 1 is the rollback key the delegations repair clause keys on, because the eviction writes no DELEGATE-revoke row for the generic self-join repair to find. Same close_block blockKey and same SPECIAL rollback as rollcalls, for the same reason.' },
    { table: 'contract_state', owner: 'indexer', replication: 'stream:block', rollback: 'block', replicaRollback: 'mirror',
      hashed: { classes: ['contracts'], note: 'Latest value per state key written in the block.' } },
    { table: 'escrow_leaf_journal', owner: 'indexer', replication: 'stream:block', rollback: 'block', replicaRollback: 'mirror',
      hashed: { classes: ['state_commitment'], note: 'Folds into the committed balances_root through the XCHAIN_ESC leaf domain (escrowLeafSubtree.js applyEscrowLeaves), which is an input of the light-client state-commitment SMT. Flag-day gated per chain (ESCROW_LOCKED_LEAF_ACTIVATION, armed BTC:regtest at 11200): below an armed height the journal feeds only the balances_root_escrow_shadow column, at or above it the committed balances_root.' },
      note: 'Per-(address,tick) locked total, appended when a block changes it. Not hashed until the escrow leaf arms (ESCROW_LOCKED_LEAF_ACTIVATION); at that point it feeds balances_root via the XCHAIN_ESC leaf domain. Replicated rather than recomputed so four families\' open-remaining logic does not have to exist twice. See src/sql/escrow_leaf_journal.sql.' },
    { table: 'slash_events', owner: 'indexer', replication: 'stream:block', rollback: 'block', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'contract_slash_debits', owner: 'indexer', replication: 'stream:block', rollback: 'block', replicaRollback: 'mirror',
      hashed: DERIVED,
      note: 'Per-row slash debit log (pre-slash prev_amount per in-place stake reduction). Rollback reads it to restore slashed amounts BEFORE the generic block delete drops the orphaned rows; replicas must replicate it for the same restore.' },
    { table: 'contract_delegation_rotations', owner: 'indexer', replication: 'stream:block', rollback: 'block', replicaRollback: 'mirror',
      hashed: DERIVED,
      note: 'Per-row log of the signing_pubkey_id rewrites the DELEGATE v1 materialization sweep applies IN PLACE to surviving contract_stakes rows (CONTRACT_DELEGATION_MATERIALIZE). Same reorg-restore requirement as contract_slash_debits: rollback copies prev_signing_pubkey_id back BEFORE the generic block delete drops the log rows, and xchain-sync\'s updated-rows channel reaches the mutated stake row through this journal, so replicas must replicate it.' },
    { table: 'capability_slash_events', owner: 'indexer', replication: 'stream:block', rollback: 'block', replicaRollback: 'mirror',
      hashed: DERIVED, note: 'Capability-stake twin of slash_events.' },
    { table: 'capability_slash_debits', owner: 'indexer', replication: 'stream:block', rollback: 'block', replicaRollback: 'mirror',
      hashed: DERIVED, note: 'Capability-stake twin of contract_slash_debits, with the same reorg-restore requirement.' },
    { table: 'anchor_reward_reconcile_log', owner: 'indexer', replication: 'stream:block', rollback: 'block', replicaRollback: 'mirror',
      hashed: DERIVED,
      note: 'Pre-image log of validator_rewards loser rows an anchor reconcile DELETEd. Same reorg-restore requirement as the slash-debit logs: rollback re-INSERTs the deleted losers whose earn-block survives the reorg BEFORE the generic block delete drops the log rows; replicas must replicate it for the same restore. The pre-image carries reward_derive_block_index as well as reward_block_index, so a loser MATERIALIZED inside the orphaned range is left deleted rather than restored as an orphan the replay never mints.' },
    { table: 'state_tree_roots', owner: 'indexer', replication: 'follower-derived', rollback: 'block', replicaRollback: 'mirror',
      hashed: { classes: ['state_commitment'], note: 'The per-block light-client SMT roots themselves (SPV spec sec.4).' },
      note: 'Not streamed and excluded from snapshots (OPERATOR_LOCAL): each follower recomputes the roots apply-time (VERIFY_STATE_COMMITMENT) and halts on divergence vs source. Block-scoped rollback on both sides drops orphaned-fork roots so forward threading re-seeds from the fork point.' },

    // ── Rolled-back index lookups (wire ^id consensus) ─────────────────
    // Once an address/ticker can be referenced on the wire as ^<id>, its id
    // is consensus-relevant (resolved to a canonical string at block-hash
    // time), so these two lookups rewind on reorg, unlike the inert lookups
    // below. Ids are assigned by an explicit dense counter, so deleting the
    // orphaned-block ids and reapplying reproduces them identically.
    { table: 'index_addresses', owner: 'indexer', replication: 'stream:index', rollback: 'index', replicaRollback: 'mirror',
      hashed: { classes: ['index_map'], note: 'The (id, address) delta class of state_hash, armed per-chain (id-determinism P4).' } },
    { table: 'index_tickers', owner: 'indexer', replication: 'stream:index', rollback: 'index', replicaRollback: 'mirror',
      hashed: { classes: ['index_map'], note: 'The (id, tick) delta class of state_hash, armed per-chain (id-determinism P4).' } },

    // ── Recomputed / bespoke-rollback tables ───────────────────────────
    { table: 'balances', owner: 'indexer', replication: 'snapshot', rollback: 'recomputed', replicaRollback: 'recomputed',
      hashed: { classes: ['state_commitment'], note: 'SMT leaves of the light-client state commitment; also continuously cross-checked by the per-block supply sanityCheck.' },
      note: 'Derived aggregate of credits/debits. No action_index column, so it cannot stream per block; both sides rebuild it (source updateBalances, replica rebuildBalances). Only the SOURCE additionally orphan-sweeps rows whose address/tick id was rolled out of the index (zombie rows would otherwise trip sanityCheck); the replica needs no mirrored sweep because rebuildBalances recomputes wholesale.' },
    { table: 'markets', owner: 'indexer', replication: 'snapshot', rollback: 'recomputed', replicaRollback: 'special',
      hashed: { classes: [], note: 'Derived OHLCV display aggregate keyed by tick pair; no consensus reader.' },
      note: 'Source recomputes affected pairs on rollback; the thin replica cannot recompute OHLCV, so it refreshes values via the snapshot upsert. It mirrors BOTH source deletes: the orphaned-tick sweep (id-reclaim protection) and the pair-scoped delete of a market whose pair kept no surviving orders/order_matches, which the upsert-only snapshot could never remove. That second delete is skipped on a truncated replica, whose partial orders history cannot distinguish a never-traded pair from one traded below its join floor.' },
    { table: 'attest_validator_stats', owner: 'indexer', replication: 'snapshot', rollback: 'recomputed', replicaRollback: 'special',
      hashed: { classes: [], note: 'Display accountability rollup. PHASE-4 GATE: before quality_score drives live responsible-set selection or slashing, this needs hash coverage and a replica strategy better than drop-and-resnapshot.' },
      note: 'Running per-validator counters with no block/action key. Source drops rows last touched in the orphaned range and rebuilds them from surviving signatures + expired requests; the thin replica (no capability machinery) drops and waits for the next full snapshot.' },
    { table: 'contract_emissions', owner: 'indexer', replication: 'stream:action', rollback: 'special', replicaRollback: 'special',
      hashed: { classes: ['contracts'], note: 'Emission rows in deterministic (execution_index, position) order.' },
      note: 'Cascade-deleted via its contract_executions parent (execution_index has no direct action range), on source and replica alike, BEFORE the generic loops.' },
    { table: 'icons', owner: 'indexer', replication: 'local', rollback: 'special', replicaRollback: 'special',
      hashed: { classes: [], note: 'Operator-local icon cache; no consensus reader.' },
      note: 'Keyed by token_id with no enforced FK; both sides orphan-sweep rows whose token was rolled back.' },
    { table: 'pubkeys', owner: 'indexer', replication: 'snapshot', rollback: 'special', replicaRollback: 'special',
      hashed: { classes: [], note: 'Not consensus-hashed: block hashes take source_pubkey from the decoder DB, not this table.' },
      note: 'INSERT IGNORE cache keyed by address_id. Orphan-swept on both sides since the ^id work made index_addresses ids reorg-reproducible: a reclaimed id would otherwise re-point the surviving row at a different address.' },
    { table: 'price_snapshots', owner: 'indexer', replication: 'hub-mirror', rollback: 'special', replicaRollback: 'special',
      hashed: { classes: ['quorum'], note: 'PRICE v0 validator rounds carry federation quorum signatures.' },
      note: 'Hub-mirrored rounds anchored via reference_block (not block_index), so both sides run a bespoke reference_block delete on reorg; a from-genesis replay never regenerates orphaned rounds, so hub re-mirror alone cannot close the window.' },

    // ── Intentionally never rolled back ────────────────────────────────
    { table: 'events', owner: 'indexer', replication: 'snapshot', rollback: 'exempt', replicaRollback: 'exempt',
      hashed: { classes: [], note: 'Operational audit log; no consensus reader.' },
      note: 'Append-only operational audit log; it records the REORG event itself, so rolling it back would erase the evidence of the rollback.' },
    { table: 'recovery_pending_rewards', owner: 'indexer', replication: 'local', rollback: 'exempt', replicaRollback: 'local',
      hashed: { classes: [], note: 'Recovery-local staging scratch, not chain truth and not consensus-hashed.' },
      note: 'Id-determinism staging: archived validator rewards keyed by raw address string, drained into validator_rewards by the createAddress apply hook. rollback() RE-ARMs it (applied=0 reset) so re-materialization happens on the canonical chain, but that is a parity convenience, not an index-keyed delete.' },
    { table: 'cross_chain_call_rejections', owner: 'indexer', replication: 'local', rollback: 'exempt', replicaRollback: 'local',
      hashed: { classes: [], note: 'Node-local XEXEC refusal diagnostics; signature sets are per-hub so nodes mirroring different hubs legitimately differ. Never a consensus reader.' },
      note: 'Observability-only upsert log of refused dispatch injections (XDISP-1 quorum starvation). Never gates retry; the row is deleted when the call eventually executes, and post-reorg retries repopulate it, so rolling it back would only erase the starvation evidence.' },
    { table: 'push_generations', owner: 'indexer', replication: 'snapshot', rollback: 'exempt', replicaRollback: 'local',
      hashed: { classes: [], note: 'Hub-replication metadata stamped onto hub rows only; not chain truth.' },
      note: 'Source-chain reorg fence counter: one monotonic generation per coin, bumped at the START of every rollback so re-published rows outrank orphaned ones. Rolling it back is exactly the bug it fixes.' },
    { table: 'cross_chain_matches', owner: 'indexer', replication: 'hub-mirror', rollback: 'exempt', replicaRollback: 'special',
      hashed: { classes: ['quorum'], note: 'Hub-federation co-signed match rows.' },
      note: 'Hub-mirrored two-sided DEX state, not produced by local block processing. Both sides locally pre-delete the orphaned range (CROSS-CHAIN-MIRROR-REORG-DELETE markers, byte-identical predicates) to close the hub-blip window; hub retraction is the idempotent backstop. Exempt = not a generic-list delete.' },
    { table: 'cross_chain_calls', owner: 'indexer', replication: 'hub-mirror', rollback: 'exempt', replicaRollback: 'special',
      hashed: { classes: ['quorum'], note: 'Hub-federation quorum-signed relay rows; XEXEC injection re-verifies 2f+1 sigs.' },
      note: 'Hub-mirrored XCALL relay rows; the indexer only SELECTs them. Same local pre-delete + hub-retraction-backstop model as cross_chain_matches.' },
    { table: 'bridge_transfers', owner: 'indexer', replication: 'hub-mirror', rollback: 'exempt', replicaRollback: 'special',
      hashed: { classes: ['quorum'], note: 'Hub-federation co-signed XBRIDGE transfer rows; the settle pass re-verifies the signature set against the cross_chain capability snapshot at snapshot_block before it credits anything.' },
      note: 'Hub-mirrored one-sided bridge state (src_chain/src_action_index name the lock or burn leg), not produced by local block processing; the indexer only SELECTs it. Hub retraction is the unwind: _applyRetraction deletes the mirrored row under the mandatory push_generation fence. UNLIKE cross_chain_matches/calls there is as yet NO local pre-delete leg inside the CROSS-CHAIN-MIRROR-REORG-DELETE markers in rollback.js / ClientRollback.js, so the hub-blip window those markers close is still open for this table; adding it is a byte-identical twin edit in both files and is tracked outside this registry. An APPLIED leg is unwound by its bridge_settlements row instead, which is rollback \'action\'. Exempt = not a generic-list delete.' },
    { table: 'oracle_prices', owner: 'indexer', replication: 'hub-mirror', rollback: 'exempt', replicaRollback: 'special',
      hashed: { classes: [], note: 'Hub-mirrored permissionless PRICE v1 rows; consensus effects (fee quotes) re-verify against them deterministically per block.' },
      note: 'action_index here refers to the row\'s SOURCE chain, usually a different chain from the one reorging, so a blanket local-height delete would corrupt the mirror; both sides delete only rows tagged with the local chain, and source-chain reorgs converge mirror-side via the pushpricereorg rail.' },
    { table: 'capability_snapshots', owner: 'indexer', replication: 'hub-mirror', rollback: 'exempt', replicaRollback: 'exempt',
      hashed: { classes: ['quorum'], note: 'Immutable BTC-anchored snapshots the federation quorum-locked.' },
      note: 'Hub-mirrored, immutable block-boundary capability snapshots, synced via an id cursor and never retracted. Block replay does not recreate them, so the chain-reorg path must not delete them.' },
    { table: 'state_checkpoints', owner: 'indexer', replication: 'hub-mirror', rollback: 'exempt', replicaRollback: 'exempt',
      hashed: { classes: ['quorum'], note: 'Quorum-signed checkpoints; verified against pinned validator sets by consumers.' },
      note: 'Hub-mirrored, never retracted: a reorged height is superseded by a re-broadcast row with a higher checkpoint_seq. The on-chain ANCHOR record (anchor_actions) rolls back normally as a dataTable.' },
    { table: 'policy_snapshots', owner: 'indexer', replication: 'hub-mirror', rollback: 'exempt', replicaRollback: 'exempt',
      hashed: { classes: ['quorum'], note: 'Quorum-signed per-token policy snapshots; the applying indexer re-verifies the signature set and recomputes policy_hash from the transport membership arrays before it materializes anything.' },
      note: 'state_checkpoints shape, and for the same reason: append-only latest-wins per (network, origin_chain, tick), never retracted, because a superseding policy arrives as a new row at a higher policy_seq rather than as a deletion of the old one. It therefore carries NO hub_db_sync RETRACTION_COLUMNS entry (that map names a numeric source-chain action index for a range delete and this table has none). Block replay does not recreate the row, so the chain-reorg path must not delete it; the injected LIST/ISSUE/SLEEP actions the apply mints ARE rolled back normally, and the bridge_settlements row keyed kind=\'policy\' goes with them so replay re-applies the snapshot.' },
    { table: 'anchor_reward_attestations', owner: 'indexer', replication: 'hub-mirror', rollback: 'exempt', replicaRollback: 'exempt',
      hashed: { classes: [], note: 'Not hashed: transport for the XANCPUB quorum. The BTC indexer re-verifies the sigs and derives validator_rewards, which itself is not in the state-hash preimage (COLLECT-mediated only).' },
      note: 'Hub-mirrored, append-only, never retracted: written only after the XANCPUB quorum resolves for a FINALIZED checkpoint, so there is no un-finalize to retract. The derived validator_rewards row (block_index = snapshot_block) rolls back normally as a dataTable and re-derives idempotently on replay; a DOGE reorg cannot un-quorum an already-attested publish.' },
    { table: 'attestation_responses', owner: 'indexer', replication: 'hub-mirror', rollback: 'exempt', replicaRollback: 'exempt',
      hashed: { classes: [], note: 'Not hashed: transport for the finalized ATTEST response. The applier re-verifies the signatures against the responsible set resolved from its OWN request row and synthesizes an ATTEST v1 action; the APPLIED state lives in attests, and the v0 status flip it drives is covered through resolved_block.' },
      note: 'Hub-mirrored, insert-only (no column is ever updated after insert) and never retracted: the mirror row is INERT without a pending local request, so a reorg that removes the request removes every applied row with it (they sit at blocks above the request) and the re-parse finds no request to re-bind to, while a reorg that keeps the request re-binds at the same block on every node. Deleting the mirror row on a local reorg would instead lose a response no chain replay can regenerate. Natural-key mirror on (network, request_id) with the hub id stripped on apply, so it also re-pages from since_id 0 (hub_db_sync FULL_REPAGE_TABLES).' },
    { table: 'state_tree_nodes', owner: 'indexer', replication: 'snapshot', rollback: 'exempt', replicaRollback: 'exempt',
      hashed: { classes: ['state_commitment'], note: 'Content-addressed SMT node store; nodes are keyed by their own hash.' },
      note: 'Copy-on-write: a node surviving a reorg is harmless (re-apply INSERT-IGNOREs the same hashes) and the surviving fork-point root in state_tree_roots anchors the correct tree. Orphans are reclaimed by the indexer\'s opt-in mark-and-sweep pruner (retention.js computeReachable/reclaimOrphanNodes, off unless STATE_ROOT_RETENTION_BLOCKS is positive AND STATE_NODE_RECLAIM is set, and serialized against block processing via runExclusive so a forward insert cannot re-reference a node between the mark and the delete); per-block deletion is impossible (no block_index, nodes shared across blocks).' },

    // ── Inert append-only lookups ──────────────────────────────────────
    // Id-keyed dedup lookups. Orphaned rows are harmless because block
    // hashes resolve ids to canonical strings before hashing and no wire
    // ^<id> form exists for these. Do not reintroduce a raw id from one of
    // these into any hashed projection, and do not add a ^<id> wire form
    // without moving the table to rollback 'index'.
    { table: 'index_actions',      owner: 'indexer', replication: 'stream:index', rollback: 'lookup', replicaRollback: 'lookup',
      hashed: { classes: [], note: 'Ids never hashed; resolved action strings are.' } },
    { table: 'index_coins',        owner: 'indexer', replication: 'stream:index', rollback: 'lookup', replicaRollback: 'lookup',
      hashed: { classes: [], note: 'Ids never hashed; resolved strings are.' } },
    { table: 'index_fiats',        owner: 'indexer', replication: 'stream:index', rollback: 'lookup', replicaRollback: 'lookup',
      hashed: { classes: [], note: 'Ids never hashed; resolved strings are.' } },
    { table: 'index_memos',        owner: 'indexer', replication: 'stream:index', rollback: 'lookup', replicaRollback: 'lookup',
      hashed: { classes: [], note: 'Ids never hashed; resolved strings are.' } },
    { table: 'index_mime_types',   owner: 'indexer', replication: 'stream:index', rollback: 'lookup', replicaRollback: 'lookup',
      hashed: { classes: [], note: 'Ids never hashed; resolved strings are.' } },
    { table: 'index_pubkeys',      owner: 'indexer', replication: 'stream:index', rollback: 'lookup', replicaRollback: 'lookup',
      hashed: { classes: [], note: 'Ids never hashed; resolved pubkey strings are.' } },
    { table: 'index_statuses',     owner: 'indexer', replication: 'stream:index', rollback: 'lookup', replicaRollback: 'lookup',
      hashed: { classes: [], note: 'Ids never hashed; resolved status strings are.' } },
    { table: 'index_transactions', owner: 'indexer', replication: 'stream:index', rollback: 'lookup', replicaRollback: 'lookup',
      hashed: { classes: [], note: 'Ids never hashed; resolved tx-hash strings are.' } },

    // ── Sync-owned tables that participate in the replication artifacts ─
    // Schema lives in xchain-sync/src/sql; listed here so the generated
    // stream topology and the replica rollback buckets stay complete.
    { table: 'sync_meta', owner: 'sync', replication: 'stream:special', rollback: null, replicaRollback: 'special',
      hashed: { classes: [], note: 'Transparency-log infrastructure over the hashes, not a hash input.' },
      note: 'Per-block transparency log. Streamed inline by ServerPoller (built from the block hashes AFTER payload build), so it joins the /status completeness count via the special bucket, never the blockScoped read path. Replica deletes by block_index on reorg, mirroring the server\'s TransparencyLog.pruneFrom.' },
    { table: 'merkle_epochs', owner: 'sync', replication: 'snapshot', rollback: null, replicaRollback: 'special',
      hashed: { classes: [], note: 'Transparency-log epoch roots, not a consensus hash input.' },
      note: 'Sync-owned Merkle epoch roots, applied INSERT IGNORE from snapshots. Replica deletes epochs with end_block in the orphaned range so corrected re-roots can land (a stale UNIQUE epoch row would otherwise silently survive forever).' },
];

module.exports = { TABLES };
