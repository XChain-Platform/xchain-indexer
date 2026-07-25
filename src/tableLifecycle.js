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
 * XChain Indexer - Table Lifecycle Registry
 *
 * Single source of truth for what happens to every indexer-DB table across
 * the three consensus-critical lifecycle artifacts that were previously
 * maintained by hand in separate places (and drifted, e.g. the VOTE tables
 * shipping unreplicated and unrolled-back):
 *
 *   1. REPLICATION  - how (and whether) xchain-sync delivers the table to
 *                     followers. Generates the per-block stream topology
 *                     (xchain-sync/src/replicatedTables.js TOPOLOGY.indexer).
 *   2. ROLLBACK     - how a chain reorg unwinds the table, on the source
 *                     indexer (src/rollback.js) and on every replica
 *                     (xchain-sync/src/ClientRollback.js). Generates both
 *                     sets of generic delete lists.
 *   3. HASH COVERAGE- which integrity hash (if any) would catch a divergence
 *                     in the table. Declarative: guards in
 *                     test/unit/hash-coverage.test.js bind the declarations
 *                     to the actual hashing code.
 *
 * Adding a table: create src/sql/<table>.sql, then add ONE entry here
 * declaring all three dimensions. test/unit/rollback-coverage.test.js fails
 * until the entry exists, and the per-dimension guards fail until the entry
 * matches reality. Classify by understanding the table, not by silencing
 * the tests.
 *
 * BYTE-ALIGNED TWIN: copied verbatim into xchain-sync/src/tableLifecycle.js
 * (sync has no dependency on this package by design; same convention as
 * stateHash.js / merkle.js). Edit here, then `cp` to the twin; the sync
 * rollback-coverage suite asserts byte-identity.
 *
 * Entry fields:
 *   table       table name (src/sql/<table>.sql for owner 'indexer')
 *   owner       'indexer' (schema in this repo) | 'sync' (schema in
 *               xchain-sync/src/sql; participates in replication artifacts)
 *   replication how rows reach a follower:
 *                 'stream:action'  per-block stream, action_index scoped
 *                 'stream:block'   per-block stream, block_index scoped
 *                 'stream:index'   per-block stream, append-only lookup
 *                 'stream:special' in the /status completeness count but not
 *                                  extracted by ServerPoller's scope loops
 *                 'snapshot'       full/incremental snapshot ride-along only
 *                 'hub-mirror'     mirrored from the hub (hub_db_sync); never
 *                                  carried by xchain-sync in any channel
 *                 'local'          never leaves the node (OPERATOR_LOCAL)
 *                 'follower-derived' recomputed by the follower, not carried
 *   rollback    source-indexer reorg handling (src/rollback.js):
 *                 'action'      generic DELETE by action_index (dataTables)
 *                 'block'       generic DELETE by block_index (blockTables)
 *                 'index'       block-scoped lookup delete (indexTables)
 *                 'recomputed'  rebuilt from surviving rows during rollback()
 *                 'special'     bespoke logic in rollback() (cascade/sweep)
 *                 'exempt'      intentionally never rolled back (note = why)
 *                 'lookup'      append-only id-keyed dedup lookup; orphaned
 *                               rows are inert (only ever referenced by id)
 *               null for owner 'sync' (not a source-indexer table)
 *   replicaRollback  replica-side reorg handling (ClientRollback.js):
 *                 'mirror'      same generic list as the source
 *                 'recomputed' | 'special' | 'exempt' | 'lookup'  as above
 *                 'local'       indexer-local; table never exists on replicas
 *   alsoRecomputed  true when a generically-deleted table is ADDITIONALLY
 *               refreshed by the recompute pass (coverage is a union)
 *   hashed      { classes: [...], note }. classes from:
 *                 'ledger' | 'actions' | 'contracts'  the three consensus
 *                     block hashes (db.js getBlockHashes)
 *                 'state_hash'   replication-integrity 4th hash over in-place
 *                     mutations + backdated credits (stateHash.js)
 *                 'state_commitment'  light-client SMT roots
 *                     (stateCommitment.js: balances + BTC stakes)
 *                 'index_map'    id->string delta class of state_hash
 *                     (armed per-chain; stateHash.js)
 *                 'quorum'       not block-hashed, but every row carries (or
 *                     is derived under) federation quorum signatures
 *               classes may be empty; the note must then say why no hash is
 *               needed (typically: a deterministic projection of hashed
 *               actions, where any divergence surfaces through the ledger/
 *               actions/contracts hashes of the affected blocks on replay).
 *   note        rationale worth keeping next to the classification
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
    { table: 'cross_chain_call_executions', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'cross_chain_call_callbacks',  owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'xcalls', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror',
      hashed: { classes: ['state_hash'],
                note: 'The v0 request_status terminal flip is an in-place mutation on a surviving row; the state_hash request_status class covers it. New rows are otherwise action-derived.' } },
    { table: 'sweeps', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'tokens', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', alsoRecomputed: true,
      hashed: { classes: ['state_hash'],
                note: 'The in-place supply mutation on a surviving token row (carried forward by the updated_rows tokens-supply class) is covered by the state_hash token_supply class: (tick, supply) per ledger-touched tick, flag-day gated per chain (TOKEN_SUPPLY_STATE_HASH_ACTIVATION, armed 2026-07-07 at tip + margin). Supply is also recomputed and sanity-checked against credits/debits/escrows each block; new rows are otherwise action-derived. This closed the F-1 supply-forward gap.' } },
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
                note: 'The v0 request_status terminal flip is an in-place mutation on a surviving row; the state_hash request_status class covers it. New rows are otherwise action-derived.' } },
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

    // ── BET parimutuel betting ( P4) ─────────────────────────────
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
    { table: 'votes', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror',
      hashed: DERIVED,
      note: 'Append-only: a re-vote inserts a new action_index set and tallies read each voter\'s MAX(action_index) set, so the generic delete re-exposes the prior surviving ballot on reorg.' },
    { table: 'poll_results', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'vote_delegations', owner: 'indexer', replication: 'stream:action', rollback: 'action', replicaRollback: 'mirror', hashed: DERIVED },

    // ── Block-scoped consensus tables ──────────────────────────────────
    { table: 'blocks', owner: 'indexer', replication: 'stream:block', rollback: 'block', replicaRollback: 'mirror',
      hashed: { classes: [], note: 'Carrier of the hash chain itself (ledger/actions/contract/state hash ids per block).' } },
    { table: 'transactions', owner: 'indexer', replication: 'stream:block', rollback: 'block', replicaRollback: 'mirror',
      hashed: { classes: [], note: 'Mirror of decoder-confirmed chain transactions; correctness anchors to the coin chain, and action rows referencing them are hashed.' } },
    { table: 'validator_rewards', owner: 'indexer', replication: 'stream:block', rollback: 'block', replicaRollback: 'mirror',
      hashed: { classes: [],
                note: 'Oracle/attest rewards derive deterministically during block processing; anchor_* rounds arrive via hub push but are quorum-verified before persistence. Reward credits they mint are ledger-hashed.' } },
    { table: 'contract_state', owner: 'indexer', replication: 'stream:block', rollback: 'block', replicaRollback: 'mirror',
      hashed: { classes: ['contracts'], note: 'Latest value per state key written in the block.' } },
    { table: 'slash_events', owner: 'indexer', replication: 'stream:block', rollback: 'block', replicaRollback: 'mirror', hashed: DERIVED },
    { table: 'contract_slash_debits', owner: 'indexer', replication: 'stream:block', rollback: 'block', replicaRollback: 'mirror',
      hashed: DERIVED,
      note: 'Per-row slash debit log (pre-slash prev_amount per in-place stake reduction). Rollback reads it to restore slashed amounts BEFORE the generic block delete drops the orphaned rows; replicas must replicate it for the same restore.' },
    { table: 'capability_slash_events', owner: 'indexer', replication: 'stream:block', rollback: 'block', replicaRollback: 'mirror',
      hashed: DERIVED, note: 'WI-2 bump 2 capability-stake twin of slash_events.' },
    { table: 'capability_slash_debits', owner: 'indexer', replication: 'stream:block', rollback: 'block', replicaRollback: 'mirror',
      hashed: DERIVED, note: 'WI-2 bump 2 capability-stake twin of contract_slash_debits, with the same reorg-restore requirement.' },
    { table: 'anchor_reward_reconcile_log', owner: 'indexer', replication: 'stream:block', rollback: 'block', replicaRollback: 'mirror',
      hashed: DERIVED,
      note: 'Pre-image log of validator_rewards loser rows an anchor reconcile DELETEd (RB-ANCHOR). Same reorg-restore requirement as the slash-debit logs: rollback re-INSERTs the deleted losers whose earn-block survives the reorg BEFORE the generic block delete drops the log rows; replicas must replicate it for the same restore.' },
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
      note: 'Source recomputes affected pairs on rollback; the thin replica cannot recompute OHLCV, so it refreshes values via the snapshot upsert and mirrors only the orphaned-tick sweep (id-reclaim protection).' },
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
      note: 'F1a id-determinism staging: archived validator rewards keyed by raw address string, drained into validator_rewards by the createAddress apply hook. rollback() RE-ARMs it (applied=0 reset) so re-materialization happens on the canonical chain, but that is a parity convenience, not an index-keyed delete.' },
    { table: 'cross_chain_call_rejections', owner: 'indexer', replication: 'local', rollback: 'exempt', replicaRollback: 'local',
      hashed: { classes: [], note: 'Node-local XEXEC refusal diagnostics; signature sets are per-hub so nodes mirroring different hubs legitimately differ. Never a consensus reader.' },
      note: 'Observability-only upsert log of refused dispatch injections (XDISP-1 quorum starvation). Never gates retry; the row is deleted when the call eventually executes, and post-reorg retries repopulate it, so rolling it back would only erase the starvation evidence.' },
    { table: 'push_generations', owner: 'indexer', replication: 'snapshot', rollback: 'exempt', replicaRollback: 'local',
      hashed: { classes: [], note: 'Hub-replication metadata stamped onto hub rows only; not chain truth.' },
      note: 'Source-chain reorg fence counter (item 5308): one monotonic generation per coin, bumped at the START of every rollback so re-published rows outrank orphaned ones. Rolling it back is exactly the bug it fixes.' },
    { table: 'cross_chain_matches', owner: 'indexer', replication: 'hub-mirror', rollback: 'exempt', replicaRollback: 'special',
      hashed: { classes: ['quorum'], note: 'Hub-federation co-signed match rows.' },
      note: 'Hub-mirrored two-sided DEX state, not produced by local block processing. Both sides locally pre-delete the orphaned range (CROSS-CHAIN-MIRROR-REORG-DELETE markers, byte-identical predicates) to close the hub-blip window; hub retraction is the idempotent backstop. Exempt = not a generic-list delete.' },
    { table: 'cross_chain_calls', owner: 'indexer', replication: 'hub-mirror', rollback: 'exempt', replicaRollback: 'special',
      hashed: { classes: ['quorum'], note: 'Hub-federation quorum-signed relay rows; XEXEC injection re-verifies 2f+1 sigs.' },
      note: 'Hub-mirrored XCALL relay rows; the indexer only SELECTs them. Same local pre-delete + hub-retraction-backstop model as cross_chain_matches.' },
    { table: 'oracle_prices', owner: 'indexer', replication: 'hub-mirror', rollback: 'exempt', replicaRollback: 'special',
      hashed: { classes: [], note: 'Hub-mirrored permissionless PRICE v1 rows; consensus effects (fee quotes) re-verify against them deterministically per block.' },
      note: 'action_index here refers to the row\'s SOURCE chain, usually a different chain from the one reorging, so a blanket local-height delete would corrupt the mirror; both sides delete only rows tagged with the local chain, and source-chain reorgs converge mirror-side via the pushpricereorg rail.' },
    { table: 'capability_snapshots', owner: 'indexer', replication: 'hub-mirror', rollback: 'exempt', replicaRollback: 'exempt',
      hashed: { classes: ['quorum'], note: 'Immutable BTC-anchored snapshots the federation quorum-locked.' },
      note: 'Hub-mirrored, immutable block-boundary capability snapshots, synced via an id cursor and never retracted. Block replay does not recreate them, so the chain-reorg path must not delete them.' },
    { table: 'state_checkpoints', owner: 'indexer', replication: 'hub-mirror', rollback: 'exempt', replicaRollback: 'exempt',
      hashed: { classes: ['quorum'], note: 'Quorum-signed checkpoints; verified against pinned validator sets by consumers.' },
      note: 'Hub-mirrored, never retracted: a reorged height is superseded by a re-broadcast row with a higher checkpoint_seq. The on-chain ANCHOR record (anchor_actions) rolls back normally as a dataTable.' },
    { table: 'anchor_reward_attestations', owner: 'indexer', replication: 'hub-mirror', rollback: 'exempt', replicaRollback: 'exempt',
      hashed: { classes: [], note: 'Not hashed: transport for the XANCPUB quorum. The BTC indexer re-verifies the sigs and derives validator_rewards, which itself is not in the state-hash preimage (COLLECT-mediated only).' },
      note: ' hub-mirrored, append-only, never retracted: written only after the XANCPUB quorum resolves for a FINALIZED checkpoint, so there is no un-finalize to retract. The derived validator_rewards row (block_index = snapshot_block) rolls back normally as a dataTable and re-derives idempotently on replay; a DOGE reorg cannot un-quorum an already-attested publish.' },
    { table: 'state_tree_nodes', owner: 'indexer', replication: 'snapshot', rollback: 'exempt', replicaRollback: 'exempt',
      hashed: { classes: ['state_commitment'], note: 'Content-addressed SMT node store; nodes are keyed by their own hash.' },
      note: 'Copy-on-write: a node surviving a reorg is harmless (re-apply INSERT-IGNOREs the same hashes) and the surviving fork-point root in state_tree_roots anchors the correct tree. Orphans await a mark-and-sweep pruner; per-block deletion is impossible (no block_index, nodes shared across blocks).' },

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

// The derived/cache tables swept when their referenced index id no longer
// resolves, and the index each dangles against. rollback-coverage suites in
// both repos assert the corresponding DELETE ... NOT IN (SELECT id FROM ...)
// exists in the rollback source, so this classification cannot outlive a
// removed sweep.
//
// `replica: true` means the sweep is MIRRORED on the replica: the sync-side
// rollback-coverage guard derives its assertion set from
// ORPHAN_SWEEPS.filter(s => s.replica) and requires a matching
// DELETE ... NOT IN (SELECT id FROM ...) in ClientRollback, so flipping the
// flag without shipping (or removing) the replica sweep fails CI (#2273).
// balances stays replica:false on both rows: the replica recomputes it
// wholesale (rebuildBalances), so no mirrored sweep exists there; only the
// source orphan-sweeps balances.
const ORPHAN_SWEEPS = [
    { table: 'icons',    index: 'tokens',          replica: true  },
    { table: 'balances', index: 'index_addresses', replica: false },
    { table: 'balances', index: 'index_tickers',   replica: false },
    { table: 'markets',  index: 'index_tickers',   replica: true  },
    { table: 'pubkeys',  index: 'index_addresses', replica: true  },
];

// ── Derivation helpers ──────────────────────────────────────────────────

function allTables(){
    return TABLES.slice();
}

function entry(table){
    return TABLES.find(t => t.table === table) || null;
}

function tablesWhere(fn){
    return TABLES.filter(fn).map(t => t.table);
}

// Source-indexer generic rollback lists (xchain-indexer/src/rollback.js).
function rollbackTables(){
    return {
        dataTables:  tablesWhere(t => t.rollback === 'action'),
        blockTables: tablesWhere(t => t.rollback === 'block'),
        indexTables: tablesWhere(t => t.rollback === 'index'),
    };
}

// Replica generic rollback lists (xchain-sync/src/ClientRollback.js): the
// source lists minus indexer-local tables that never exist on a replica.
function replicaRollbackTables(){
    return {
        dataTables:  tablesWhere(t => t.rollback === 'action' && t.replicaRollback === 'mirror'),
        blockTables: tablesWhere(t => t.rollback === 'block'  && t.replicaRollback === 'mirror'),
        indexTables: tablesWhere(t => t.rollback === 'index'  && t.replicaRollback === 'mirror'),
    };
}

// Per-block stream topology for the indexer DB (xchain-sync/src/
// replicatedTables.js TOPOLOGY.indexer). The decoder DB topology is NOT
// generated from this registry: that schema is owned by xchain-decoder and
// stays declared literally in replicatedTables.js.
function streamTopology(){
    let scoped = (scope) => tablesWhere(t => t.replication === 'stream:' + scope);
    return {
        blockScoped:  scoped('block'),
        txScoped:     [],   // the indexer joins via actions, never directly via tx_index
        actionScoped: scoped('action'),
        index:        scoped('index'),
        special:      scoped('special'),
    };
}

// Source-side coverage buckets for the rollback-coverage guard.
function rollbackBuckets(){
    let sweepTables = [...new Set(ORPHAN_SWEEPS.map(s => s.table))];
    let RECOMPUTED = tablesWhere(t => t.rollback === 'recomputed' || t.alsoRecomputed);
    let SPECIAL_CASE = [...new Set([...tablesWhere(t => t.rollback === 'special'), ...sweepTables])];
    let ROLLBACK_EXEMPT = {};
    for(let t of TABLES){
        if(t.rollback === 'exempt') ROLLBACK_EXEMPT[t.table] = t.note || '';
    }
    return { RECOMPUTED, SPECIAL_CASE, ROLLBACK_EXEMPT };
}

// Replica-side coverage buckets (xchain-sync rollback-coverage guard).
function replicaRollbackBuckets(){
    let RECOMPUTED = tablesWhere(t => t.replicaRollback === 'recomputed');
    let SPECIAL_CASE = tablesWhere(t => t.replicaRollback === 'special');
    let ROLLBACK_EXEMPT = {};
    let INDEXER_LOCAL = {};
    for(let t of TABLES){
        if(t.replicaRollback === 'exempt') ROLLBACK_EXEMPT[t.table] = t.note || '';
        if(t.replicaRollback === 'local')  INDEXER_LOCAL[t.table]  = t.note || '';
    }
    return { RECOMPUTED, SPECIAL_CASE, ROLLBACK_EXEMPT, INDEXER_LOCAL };
}

// Tables declaring a given hash-coverage class.
function hashClassTables(cls){
    return tablesWhere(t => t.hashed && t.hashed.classes.indexOf(cls) !== -1);
}

module.exports = {
    TABLES, ORPHAN_SWEEPS,
    allTables, entry, tablesWhere,
    rollbackTables, replicaRollbackTables, streamTopology,
    rollbackBuckets, replicaRollbackBuckets, hashClassTables,
};
