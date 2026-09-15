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
 * XChain Indexer - Table Lifecycle Registry part: action-scoped rows
 *
 * The first half of the registry TABLES list: every action-scoped consensus
 * table, BET included, in rollback dataTables order. The entry file
 * (table_lifecycle.js beside this directory) concatenates this list ahead of
 * block_and_special_tables.js and documents every field an entry declares.
 * Split out only to keep each file readable: a twin copy of this part sits
 * at the same relative path in xchain-sync, and both are byte-identical.
 *
 ********************************************************************/

'use strict';

// Shorthand: most action tables are deterministic projections of hashed
// actions, so their hash declaration is identical prose.
const DERIVED = {
    classes: [],
    note: 'Deterministic projection of hashed actions; divergence surfaces via the ledger/actions/contracts hashes on replay.'
};

const TABLES = [

    // ── Action-scoped consensus tables ─────────────────────────────────
    // Streamed per block via the action_index join, rolled back by the
    // generic action_index delete on source and replica alike. Order here is
    // the rollback dataTables order (deletes are order-independent: the
    // schema declares no FKs, and the one real dependency, contract_emissions
    // on contract_executions, is handled bespoke before the generic loop).
    { table: 'actions',   owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror',
      hashed: { classes: ['actions'], note: 'The action rows themselves (resolved action-type strings).' } },
    { table: 'addresses', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'airdrops',  owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'batches',   owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'broadcasts', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'callbacks', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'credits',   owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror',
      hashed: { classes: ['ledger', 'state_hash'],
                note: 'Ledger hash covers block-scoped rows; the state_hash credits class covers backdated cooldown-maturity refund credits (they reuse an earlier action_index, invisible to the block-scoped ledger hash).' } },
    { table: 'debits',    owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror',
      hashed: { classes: ['ledger'], note: 'Resolved address/tick strings, never surrogate ids.' } },
    { table: 'coinpay_expires',     owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'coinpay_obligations', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'coinpay_statuses',    owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'coinpays',  owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'destroys',  owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'dispensers', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'dispenser_cancels',  owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'dispenser_closes',   owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'dispenser_edits',    owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'dispenser_expires',  owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'dispenser_statuses', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'dispenses', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'dividends', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'escrows',   owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror',
      hashed: { classes: ['ledger'], note: 'Resolved address/tick strings, never surrogate ids.' } },
    { table: 'fees',      owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'files',     owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'gated_files', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'issues',    owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'links',     owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    // LIST create + edits. Every row is owned by the action that wrote it and is
    // NEVER mutated in place: a valid edit writes a COMPLETE new membership
    // snapshot under its OWN action_index, and getList resolves a list reference
    // to the newest valid action in its edit chain (see
    // list_edit_resolution_activation.js). That is deliberately NOT the BET-latch
    // shape - remapping an edit's item rows onto the parent's action_index would
    // mutate rows written in an earlier block and would then need a block stamp, a
    // rollback reset and a state-hash class. As written, the action-scoped stream
    // carries each edit with its own block and the generic action-scoped delete
    // rolls it back, after which resolution falls back to the previous head.
    { table: 'lists',     owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'list_edits', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'list_items', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'list_items_invalid', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'mappings_actions', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'mappings_files',   owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'messages',  owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'mints',     owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'orders',    owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'order_cancels', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'order_edits',   owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'order_expires', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'order_matches', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'order_statuses', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'sends',     owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    // XBRIDGE action record: one row per broadcast lock/burn (v0/v1/v3/v4), keyed by
    // action_index like every other per-action table (sends, destroys, xcalls). System-
    // injected settle legs (v2/v5) write no row here; that side is bridge_settlements.
    { table: 'xbridges',  owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'sleeps',    owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'swaps',     owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'swap_cancels', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'swap_edits',   owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'swap_expires', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'swap_matches', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'swap_statuses', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    // Cross-chain action tables: internally-minted rows (settlement legs,
    // XCALL requests/expiries, injected XEXEC executions, processed
    // callbacks), each keyed by a rollback-able action_index.
    { table: 'cross_chain_settlements',     owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    // The bridge's twin of cross_chain_settlements: one row per APPLIED XBRIDGE leg or
    // applied XPOLICY snapshot, keyed (transfer_id, kind). Same class for the same reason -
    // the mirrored bridge_transfers / policy_snapshots row can be deleted by a later fenced
    // retraction, so "did this chain already apply it?" has to be answered from a local,
    // reorg-rollback-able table rather than from the mirror.
    { table: 'bridge_settlements',          owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'cross_chain_call_executions', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'cross_chain_call_callbacks',  owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'xcalls', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror',
      hashed: { classes: ['state_hash'],
                note: 'The v0 request_status terminal flip is an in-place mutation on a surviving row; the state_hash request_status class covers it. New rows are otherwise action-derived.' } },
    { table: 'sweeps', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'tokens', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', alsoRecomputed: true,
      hashed: { classes: ['state_hash'],
                note: 'The in-place supply mutation on a surviving token row (carried forward by the updated_rows tokens-supply class) is covered by the state_hash token_supply class: (tick, supply) per ledger-touched tick, flag-day gated per chain (TOKEN_SUPPLY_STATE_HASH_ACTIVATION, armed 2026-07-07 at tip + margin). Supply is also recomputed and sanity-checked against credits/debits/escrows each block; new rows are otherwise action-derived. This closes a supply-forward gap that would otherwise exist.' } },
    { table: 'stakes', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror',
      hashed: { classes: ['state_hash', 'state_commitment'],
                note: 'state_hash covers the in-place deactivation_block stamps and capability SLASH amount cuts; the light-client state commitment covers active BTC stake weights.' } },
    { table: 'unstakes', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror',
      hashed: { classes: ['state_hash'],
                note: 'state_hash covers the capability SLASH amount cuts and the in-place cooldown-maturity status flips.' } },
    { table: 'delegations', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror',
      hashed: { classes: ['state_hash'], note: 'state_hash covers the in-place deactivation_block stamps written by DELEGATE revokes.' } },
    { table: 'stake_key_revocations', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'reward_claims', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'full_node_verifications', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror',
      hashed: DERIVED,
      note: 'NODEPROOF verdict rows: one verdict action_index writes one row per PASS pubkey, all sharing it, so they roll back as a unit.' },
    { table: 'rollcall_signers', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror',
      hashed: DERIVED,
      note: 'ROLLCALL presence signatures, DOGE side. One action writes one row per VERIFIED signer, all sharing its action_index, so they roll back as a unit. A first-seen index (INSERT IGNORE on (epoch_height, pubkey)): the BTC close queries it BY KEY over a bounded list it supplies, never by enumeration, so no attacker-inflated action set can page-walk the answer into unknown.' },
    { table: 'contracts', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror',
      hashed: { classes: ['contracts'], note: 'Deploy rows: resolved source address + code_hash + status string. Chunked DEPLOY bytes are bound via code_hash, so deploy_chunks needs no hash of its own.' } },
    { table: 'contract_permissions', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'deploy_chunks', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror',
      hashed: { classes: [], note: 'Un-consumed/orphan chunk metadata only; assembled code bytes are sha256-bound into contracts.code_hash at assembly, which IS contract-hashed.' } },
    { table: 'contract_stakes', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror',
      hashed: { classes: ['state_hash'], note: 'state_hash covers the in-place deactivation_block stamps and contract SLASH amount cuts.' } },
    { table: 'contract_unstakes', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror',
      hashed: { classes: ['state_hash'], note: 'state_hash covers the contract SLASH amount cuts and the in-place cooldown-maturity status flips.' } },
    { table: 'contract_delegations', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror',
      hashed: { classes: ['state_hash'], note: 'state_hash covers the in-place deactivation_block stamps written by DELEGATE v3 contract revokes.' } },
    { table: 'contract_executions', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror',
      hashed: { classes: ['contracts'], note: 'Resolved caller address, gas_used, status string, emitted_count.' } },
    { table: 'deposits', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror',
      hashed: { classes: ['contracts'], note: 'Resolved address/tick/status strings with BINARY-collation-pinned ordering.' } },
    { table: 'withdrawals', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror',
      hashed: { classes: ['contracts'], note: 'Resolved address/tick/status strings with BINARY-collation-pinned ordering.' } },
    { table: 'anchor_actions', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror',
      hashed: { classes: ['state_hash'],
                note: 'The in-place invalid_archive stamp on a surviving v1 parent is covered by the state_hash anchor_invalid class. New rows are otherwise action-derived; status_id is deliberately in no block-hash projection.' } },
    { table: 'attests', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror',
      hashed: { classes: ['state_hash'],
                note: 'The v0 request_status terminal flip (updateAttestationRequestStatus) is an in-place mutation on a surviving row; the state_hash request_status class covers it. Its reorg-side reset, resetOrphanedAttestRequests (src/db/rollback/in_place_flips.js), puts an orphaned flip back to pending on both the source and the replica. Four more in-place writers exist. setAttestationResponseCallbackIndex and setAttestationResponseBatchIndex stamp action_index links (callback_execute_action_index, batch_action_index) on a surviving v1 row; both are display-only and deliberately in no hash projection (state_hash reads attests at version 0 only). setAttestBatchStatus re-stamps status_id on a surviving v5 batch head when the completing v6 continuation fails reassembly or quorum, and that stamp is a KNOWN GAP: it is in no state_hash class and not carried by the updated_rows forward channel. Its reorg-side reset is restoreStampedAttestHeads (src/db/rollback/batch_heads.js), which puts the head back to valid on both the source and the replica (ClientRollback.js mirrors it); only the forward carry and the hash class remain open. Closing the remainder needs a flag-day-gated class in the anchor_invalid shape plus the forward carry.' } },
    { table: 'prices', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'pending_hub_pushes', owner: 'indexer', replication: 'local', rollback: 'action', replicaRollback: 'local',
      hashed: { classes: [], note: 'Indexer-local outbound hub-push queue; never replicated (OPERATOR_LOCAL) and meaningless on a replica.' } },
    // Programmable-policy controller bind/unbind event logs: append-only,
    // never mutated in place (cooldown expiry is computed at read time).
    { table: 'token_controllers',   owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'address_controllers', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    // VOTE governance: polls (v0 create), votes (v1 ballots, append-only),
    // poll_results (v2 finalization), vote_delegations (v3 set/clear log).
    { table: 'polls', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror',
      hashed: { classes: ['state_hash'],
                note: 'The in-place finalization flip on a surviving polls row (updated_rows POLL_FINALIZE channel) is covered by the state_hash poll_finalize class, flag-day gated per chain (POLL_FINALIZE_STATE_HASH_ACTIVATION, armed 2026-07-07 at tip + margin; fleet must deploy before the earliest height). New rows are otherwise action-derived.' } },

    // ── BET parimutuel betting ─────────────────────────────
    { table: 'bet_feeds', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror',
      hashed: { classes: ['state_hash'],
                note: 'Three in-place flips on surviving rows, each block-stamped: the closed latch (closed_block, written by the end-of-block pass with NO causing action) and the terminal flip (terminal_block: resolved/resolved_void/cancelled/expired). Covered by the state_hash bet_feed_status class (BET_STATUS_STATE_HASH_ACTIVATION, per-chain flag-day) and the updated_rows BET channel; rollback.js resets both stamps explicitly (closed/open two-step). New rows are otherwise action-derived.' } },
    { table: 'bets', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror',
      hashed: { classes: ['state_hash'],
                note: 'The settlement flip (open -> won/lost/refunded, stamped settled_block) is an in-place mutation on a surviving row; the state_hash bet_status class covers it (same flag-day as bet_feeds), the updated_rows BET channel replicates it, and rollback.js re-opens stakes settled in an orphaned range. New rows are otherwise action-derived.' } },
    // Status history: every row is caused by a real action (create / cancel /
    // resolve tx or BET_EXPIRE's minted action row), so the generic
    // action-scoped delete covers rollback. The closed latch writes NO history
    // row by design (no causing action; bet_feeds.closed_block is its record).
    { table: 'bet_feed_statuses', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'bet_statuses',      owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    // Typed rows for the two lifecycle legs that have no other row of their own (BET
    // format 1 cancel / format 3 resolve), the order_cancels / dispenser_cancels
    // pattern. One row per action, written whatever the parse status, so a
    // chain-rejected cancel or resolve persists a readable status instead of
    // vanishing. Pure reporting: no validation or settlement path reads
    // them, so they are action-derived for hashing like the other BET projections.
    { table: 'bet_cancels',       owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'bet_resolves',      owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'votes', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror',
      hashed: DERIVED,
      note: 'Append-only: a re-vote inserts a new action_index set and tallies read each voter\'s MAX(action_index) set, so the generic delete re-exposes the prior surviving ballot on reorg.' },
    { table: 'poll_results', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'vote_delegations', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
];

module.exports = { DERIVED, TABLES };
