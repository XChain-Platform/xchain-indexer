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
 * XChain Indexer - Hub DB Sync Client: mirrored-table registries
 *
 * Which hub tables the mirror carries and what each one needs: the retraction
 * column maps, the cross-chain and federation-state table sets, and the local
 * schema requirements. Every list is local to this module so no table or column
 * name is ever taken from the wire.
 *
 * Part of the hub-mirror client (src/hub/hub_db_sync.js), which installs the
 * methods here onto HubDbSync.prototype. Vendored byte-identical into
 * xchain-explorer by bin/sync-hub-mirror-client.sh: edit the xchain-indexer copy.
 *
 ********************************************************************/

// Maps each mirrored hub table to the column holding the source-chain action_index.
// Read to apply reorg retractions (row:deleted events) against the local copy.
// Kept local (not taken from the wire) so the DELETE never interpolates an
// attacker-supplied column name.
const RETRACTION_COLUMNS = {
    price_snapshots: 'source_action_index',
    oracle_prices:   'action_index',
    // bridge_transfers is ONE-SIDED: a transfer is retracted when the single source leg
    // (the v0 lock or the v1 burn named by src_chain/src_action_index) is reorged away, so
    // one column names the range. cross_chain_matches is two-sided and has its own branch
    // in applyRetraction; this table does not need one.
    //
    // policy_snapshots and list_snapshots deliberately have NO entry here, and the
    // omission is the decision: a superseding version arrives as a NEW row at a higher
    // sequence, never as a deletion, and this map names a numeric source-chain action
    // index neither table carries. Absent from the map, applyRetraction skips any
    // deletion event naming either one.
    //
    // remote_token_snapshots has no entry either: neither its hub nor its indexer DDL has
    // the push_generation fence column a quorum-class DELETE names, and no hub path emits a
    // deletion for it, so a newer version arrives as a new row and a source-chain reorg
    // does not remove an older one.
    bridge_transfers: 'src_action_index'
};

// The source-chain column for a mirrored table whose retraction range is keyed by
// something other than `source_chain`. bridge_transfers spells its source leg
// src_chain/src_action_index (the DDL's own names, chosen so `direction` is derived and
// never stored), so the generic DELETE has to read the pair off the table rather than
// assume the older spelling: a hard-coded `source_chain` here is errno 1054, which the
// retraction path would swallow as an unappliable event and leave the retracted row
// mirrored forever. Kept local, like RETRACTION_COLUMNS, so no column name ever comes
// from the wire. A table absent from this map keeps `source_chain`.
const RETRACTION_CHAIN_COLUMNS = {
    bridge_transfers:       'src_chain'
};

// Tables mirrored for the cross-chain DEX + cross-chain contract calls.
// cross_chain_matches carries finalized, validator-signed matches;
// cross_chain_calls carries quorum-signed XCALL dispatch/result relay rows;
// capability_snapshots carries the block-boundary cross_chain validator set the
// indexer verifies both against. Retraction of cross_chain_matches is two-sided
// (either order leg); cross_chain_calls retracts on its source-chain request;
// both handled specially in applyRetraction; capability_snapshots are
// immutable history and never retracted.
//
// bridge_transfers, policy_snapshots and list_snapshots join the list because membership
// buys the btc_chain_id fence through CHAIN_ID_FENCED_TABLES below (all three DDLs carry the
// column, and a regtest venue that re-genesises its Bitcoin chain otherwise keeps serving
// dead-chain transfers to every fresh indexer), the envelope chain-id handshake, snapshot
// waiter release and a place in the bootstrap concat loop, ahead of
// the one heavy table. Membership does NOT make a table quorum-class: that is the
// QUORUM_CLASS_TABLES registry below, which demands the push_generation
// fence and the 2f+1 co-signature set and, of these three, names only bridge_transfers.
// bridge_transfers also gets the RETRACTION_COLUMNS pair above; policy_snapshots and
// list_snapshots are never retracted, so deletion events naming them are skipped rather
// than applied. Giving either one a RETRACTION_COLUMNS entry also requires adding it to
// QUORUM_CLASS_TABLES below and to the hub's twin set in xchain-hub
// src/consensus/retraction/wire.js, or its deletions are accepted unfenced and unsigned.
const CROSS_CHAIN_TABLES = ['cross_chain_matches', 'cross_chain_calls', 'capability_snapshots',
                            'bridge_transfers', 'policy_snapshots', 'list_snapshots'];

// Every mirrored table whose DDL carries btc_chain_id: membership buys the apply-time refusal,
// the hub-adoption probe and the foreign-chain purge, nothing else (remote_token_snapshots'
// signed content omits the column, so only this fence keeps a dead chain's row off the pin).
const CHAIN_ID_FENCED_TABLES = CROSS_CHAIN_TABLES.concat(['remote_token_snapshots']);

// Mirrored validity inputs whose deletion changes a consensus decision and therefore
// requires the generation fence and, after activation, validator co-signatures.
const QUORUM_CLASS_TABLES = ['cross_chain_matches', 'cross_chain_calls', 'bridge_transfers'];

// Tables read while deciding whether a cross-chain action is valid. Keep this explicit:
// a new validity read must be classified for watermarking and retraction safety here.
const VALIDITY_READ_TABLES = ['remote_token_snapshots', 'list_snapshots', 'policy_snapshots',
                              'bridge_transfers', 'cross_chain_matches', 'cross_chain_calls'];

const MIRRORED_TABLES = ['price_snapshots', 'oracle_prices', 'cross_chain_matches', 'cross_chain_calls',
                         'capability_snapshots', 'bridge_transfers', 'policy_snapshots', 'list_snapshots',
                         'remote_token_snapshots', 'state_checkpoints', 'anchor_reward_attestations',
                         'attestation_responses'];

// These tables historically copied the serving hub's id. Their existing local tables must
// have AUTO_INCREMENT before id-less writes are enabled, or a deployment with an older
// hand-built schema would fail every insert after startup.
const AUTO_INCREMENT_ID_TABLES = ['price_snapshots', 'oracle_prices', 'cross_chain_matches', 'cross_chain_calls',
                                  'bridge_transfers', 'policy_snapshots', 'list_snapshots',
                                  'remote_token_snapshots', 'state_checkpoints', 'anchor_reward_attestations'];

// Tables whose validity barrier is certified by the hub's per-chain height watermark.
// They still participate in every complete bootstrap drain, but mirrorStatus reports
// their evidence through the heights map rather than the global seconds watermark.
const HEIGHT_MIRROR_TABLES = ['remote_token_snapshots'];

// Hub federation state tables. state_checkpoints carries quorum-signed per-chain
// state-hash commitments (the explorer/SDK verification source). Append-only,
// never retracted. A reorged height is superseded by a new row with a higher
// checkpoint_seq. Not on any settlement-critical path (no block-loop barrier).
// anchor_reward_attestations carries the hub's XANCPUB publisher-attestation
// quorum per attested reward tuple; the BTC indexer derives the COLLECT-spendable
// anchor/archive reward from it (mirror is transport, not trust: it re-verifies the
// sigs against its own local oracle_publish set). Append-only, content-keyed INSERT IGNORE,
// never retracted (rows are written only post-quorum for a finalized checkpoint).
// attestation_responses carries the FINALIZED ATTEST response (one row per terminal round,
// status 'ok' or 'expired'). The legacy route for it is a validator-paid ATTEST v1
// transaction; the BTC indexer binds it to a block from its own signed effective_time and
// synthesizes the v1 action locally. Insert-only in every SIGNED column; the one exception is
// batch_action_index, the display link to the ATTEST v5/v6 batch that later carries the body
// on chain, which the hub stamps after that batch lands and re-broadcasts, so the apply is an
// upsert of that single column that follows the hub, a reorg clear included (see applyRow).
// No re-page is needed for content convergence: the link is not a consensus input, and the
// stamp arrives as a broadcast rather than as something a cursor has to re-fetch.
// Never retracted either: the mirror row is inert without a pending local request, so a reorg
// that removes the request simply leaves nothing for it to bind to (spec §4.5). It is a
// NATURAL-KEY mirror on (network, request_id, effective_time). Every mirrored table uses
// its content key; its local id is only a local surrogate.
//
// bridge_transfers, policy_snapshots and list_snapshots are deliberately NOT here either,
// even though policy_snapshots is otherwise shaped like state_checkpoints. Membership of
// THIS list means
// one thing operationally: the table rides the global streamWatermark instead of a per-table
// watermark (see mirrorStatus), which is only correct for tables no block-loop barrier gates
// on. Each gates one: waitForBridgeSync and waitForPolicySync cache their own
// MAX(effective_time), while waitForListShareSync uses the per-chain height watermark.
const HUB_STATE_TABLES = ['state_checkpoints', 'anchor_reward_attestations', 'attestation_responses'];

// The tables whose hub rows change under an id the mirror has already paged past, or
// vanish by a deletion the hub never replays: price_snapshots (the batch_block_time stamp,
// skipped to finalized, the unsigned retraction DELETE), oracle_prices (a generation
// republish, the unsigned retraction DELETE), cross_chain_matches and cross_chain_calls
// (re-finalized in place after a retraction) and bridge_transfers (revived in place). A
// since_id page from a stored position never re-serves any of those changes, so every new
// connection owes each of these tables one re-page from zero, and that complete page is
// also what arms the reconciliation passes that clear what the hub no longer holds. Cost:
// the whole of each table is served once per reconnect; price_snapshots dominates.
const REPAGE_PER_CONNECTION_TABLES = ['price_snapshots', 'oracle_prices', 'cross_chain_matches',
                                      'cross_chain_calls', 'bridge_transfers'];

// The column that names a mirrored row to an operator when a mirror fence refuses or purges
// it, and the settlement family tag its refusal carries. A fence runs BEFORE the settlement
// screen, so for a refused row the fence's own line is the only record of which row it was;
// the tag is the one the screen would have logged under (XPOLICY, XBRIDGE), so an operator
// or a rail drill that greps a family for an id finds the refusal wherever it happened. Each
// column is that table's UNIQUE natural key; a table not listed is named by its hub id.
const REFUSED_ROW_NAMES = Object.freeze({
    list_snapshots:        Object.freeze({ column: 'snapshot_id', tag: 'XLISTSHARE' }),
    policy_snapshots:      Object.freeze({ column: 'snapshot_id', tag: 'XPOLICY' }),
    bridge_transfers:      Object.freeze({ column: 'transfer_id', tag: 'XBRIDGE' }),
    cross_chain_matches:   Object.freeze({ column: 'match_id',    tag: null }),
    cross_chain_calls:     Object.freeze({ column: 'call_id',     tag: null }),
    attestation_responses: Object.freeze({ column: 'request_id',  tag: null })
});

// At most this many ids are named on one refusal line; the rest are counted. A relic table
// can hold thousands of rows, and ten is enough to find the rest by their shared cause.
const REFUSED_ROW_NAME_LIMIT = 10;

// How many named ids a process remembers, so that one refused row is named once however
// many bootstraps re-serve it (every reconnect re-pages the table). Oldest forgotten first.
const REFUSED_ROW_NAMED_CAP = 10000;

module.exports = {
    RETRACTION_COLUMNS, RETRACTION_CHAIN_COLUMNS,
    CROSS_CHAIN_TABLES, CHAIN_ID_FENCED_TABLES, HUB_STATE_TABLES, HEIGHT_MIRROR_TABLES,
    VALIDITY_READ_TABLES, QUORUM_CLASS_TABLES,
    MIRRORED_TABLES, AUTO_INCREMENT_ID_TABLES,
    REPAGE_PER_CONNECTION_TABLES,
    REFUSED_ROW_NAMES, REFUSED_ROW_NAME_LIMIT, REFUSED_ROW_NAMED_CAP,
};
