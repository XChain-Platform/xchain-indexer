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
 * column maps, the cross-chain and federation-state table sets, the tables that
 * re-page from id 0 on every bootstrap, and the natural keys the rebuilt-source
 * probe compares. Every list is local to this module so no table or column name
 * is ever taken from the wire.
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
    // policy_snapshots deliberately has NO entry here, and the omission is the decision:
    // a superseding policy arrives as a NEW row at a higher policy_seq, never as a
    // deletion, and this map names a numeric source-chain action index that table does
    // not carry. Absent from the map, applyRetraction skips any deletion event naming it.
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
    bridge_transfers: 'src_chain'
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
// bridge_transfers and policy_snapshots join the list because membership buys exactly the
// two things a federation-signed mirrored table needs and nothing else: refuseForeignChainRow
// fences their btc_chain_id (both DDLs carry the column, and a regtest venue that re-genesises
// its Bitcoin chain otherwise keeps serving dead-chain transfers to every fresh indexer), and
// applyRetraction treats a deletion naming them as quorum-class, so it demands the
// push_generation fence and the 2f+1 co-signature set instead of accepting a bare wire event.
// Membership also puts them in the bootstrap concat loop below, ahead of the one heavy table.
// bridge_transfers additionally gets the RETRACTION_COLUMNS pair above; policy_snapshots is
// never retracted, so a deletion event naming it is skipped rather than applied.
const CROSS_CHAIN_TABLES = ['cross_chain_matches', 'cross_chain_calls', 'capability_snapshots',
                            'bridge_transfers', 'policy_snapshots'];

// Tables that must re-page from since_id=0 on EVERY bootstrap. A cursor of
// since_id = MAX(local id) is INSERT-shaped: it can only deliver rows with a NEW id,
// so it can never re-fetch an in-place UPGRADE that kept the same hub id. Three
// mirrored tables are upgraded in place on the hub (price_snapshots skipped->
// finalized, cross_chain_calls re-finalized, cross_chain_matches anchor_txid
// stamping AND retract->revive content); if the upgrade broadcast is missed while
// this mirror is disconnected, only a full re-page re-delivers the row so the
// idempotent applyRow ODKUs converge it (#2491, #3211). capability_snapshots is here
// for a related reason (locally-assigned ids, #2270). The three keep hub-id parity
// (only capability_snapshots strips id in applyRow); the re-page cost is O(table)
// per reconnect, accepted. cross_chain_matches additionally runs a reconciliation
// pass over the completed re-page (reconcileRetractedMatches), because the one
// mutation the hub CANNOT re-serve is a retraction: the snapshot endpoint filters
// retracted rows out entirely, so there is no row to converge against.
// attestation_responses is here for capability_snapshots' SECOND reason alone, and it is
// REQUIRED rather than a precaution: nothing in that table is ever updated in place, but
// applyRow strips its hub id (every hub that holds the finalized artifact writes its own
// row and gossips it, so the ids differ for one logical row), which makes the local ids
// LOCALLY assigned. A since_id = MAX(local id) cursor is then not a position in the
// followed hub's id space at all: it can ask for rows past the end of that hub's table and
// strand the mirror, and a wire id can land on a locally-assigned PK where the INSERT
// IGNORE drops a real row without an error, leaving a permanent mirror hole (#2270). The
// natural key (network, request_id) dedupes the re-page, and a missed response here is a
// permanent fork rather than a lag, so the O(table) re-page per bootstrap is cheap.
//
// bridge_transfers and policy_snapshots are deliberately NOT here, and the omission rests on
// the two properties this list actually tests for. Neither is upgraded in place on the hub:
// a bridge transfer's terms are fixed by the signed canonical the round closed on, and a
// changed policy is a NEW row at the next policy_seq rather than an edit of the old one, so
// there is no in-place upgrade a since_id cursor could miss. And neither strips its wire id
// in applyRow (they keep hub-id parity like cross_chain_matches/calls, which is what makes
// since_id = MAX(local id) a real position in the followed hub's id space). What a re-page
// could not re-serve for either is a RETRACTION, and that is why bridge_transfers rides the
// quorum-class fence in applyRetraction rather than a re-page, while policy_snapshots is
// never retracted at all. Both tables are small (one row per transfer, one per policy edit),
// so the cost was not the deciding argument in either direction.
const FULL_REPAGE_TABLES = ['capability_snapshots', 'price_snapshots', 'cross_chain_calls', 'cross_chain_matches',
                            'attestation_responses'];

// Hub federation state tables. state_checkpoints carries quorum-signed per-chain
// state-hash commitments (the explorer/SDK verification source). Append-only,
// never retracted. A reorged height is superseded by a new row with a higher
// checkpoint_seq. Not on any settlement-critical path (no block-loop barrier).
// anchor_reward_attestations carries the hub's XANCPUB publisher-attestation
// quorum per attested reward tuple; the BTC indexer derives the COLLECT-spendable
// anchor/archive reward from it (mirror is transport, not trust: it re-verifies the
// sigs against its own local oracle_publish set). Append-only, id-parity INSERT IGNORE,
// never retracted (rows are written only post-quorum for a finalized checkpoint).
// attestation_responses carries the FINALIZED ATTEST response (one row per terminal round,
// status 'ok' or 'expired'). The legacy route for it is a validator-paid ATTEST v1
// transaction; the BTC indexer binds it to a block from its own signed effective_time and
// synthesizes the v1 action locally. Insert-only in every SIGNED column; the one exception is
// batch_action_index, the display link to the ATTEST v5/v6 batch that later carries the body
// on chain, which the hub stamps after that batch lands and re-broadcasts, so the apply is a
// first-stamp-wins upsert of that single column (see applyRow). No re-page is needed for
// content convergence: the link is not a consensus input, and the stamp arrives as a
// broadcast rather than as something a cursor has to re-fetch.
// Never retracted either: the mirror row is inert without a pending local request, so a reorg
// that removes the request simply leaves nothing for it to bind to (spec §4.5). It is a
// NATURAL-KEY mirror on (network, request_id) rather than an id-parity one, unlike the two
// above; see the id strip in applyRow and the FULL_REPAGE_TABLES entry that follows from it.
//
// bridge_transfers and policy_snapshots are deliberately NOT here either, even though
// policy_snapshots is otherwise shaped like state_checkpoints. Membership of THIS list means
// one thing operationally: the table rides the global streamWatermark instead of a per-table
// watermark (see mirrorStatus), which is only correct for tables no block-loop barrier gates
// on. Both of these gate one: waitForBridgeSync and waitForPolicySync each cache their own
// MAX(effective_time), scoped to the chains that can apply the row, so each reports that
// scalar rather than the global watermark.
const HUB_STATE_TABLES = ['state_checkpoints', 'anchor_reward_attestations', 'attestation_responses'];

// Tables whose local id N and hub id N are THE SAME ROW, and whose rows are never updated
// in place. Both properties are needed before a difference in content at a shared id can
// mean anything: id parity makes the two rows comparable at all (the FULL_REPAGE tables
// that strip the wire id have locally-assigned ids, where id N names nothing on the hub),
// and append-only makes a difference a CONTRADICTION rather than a version skew.
//
// The columns are each table's UNIQUE natural key - the tuple that says WHICH logical row
// this is, which is exactly the question "did the source's id space get replaced" asks.
// They are signed/consensus inputs and immutable once written, so a legitimate mirror can
// never hold a different one at the hub's id. See detectRebuiltSourceByContent.
const REBUILT_SOURCE_IDENTITY_COLUMNS = Object.freeze({
    state_checkpoints:          Object.freeze(['chain', 'network', 'checkpoint_seq']),
    anchor_reward_attestations: Object.freeze(['chain', 'network', 'reward_type', 'round_reference',
                                               'snapshot_block', 'publisher'])
});

// How many rows of the hub's FIRST page the content probe compares. A rebuilt source
// restarts its ids at 1, so the retired ids a re-grown source now reuses are the LOWEST
// ones it holds, and the contradiction (if there is one) is in this window. Sized to stay
// one small request while covering more than the "handful of rows" exposure that made the
// overlap case reachable in the first place.
const REBUILT_SOURCE_PROBE_ROWS = 200;

module.exports = {
    RETRACTION_COLUMNS, RETRACTION_CHAIN_COLUMNS,
    CROSS_CHAIN_TABLES, FULL_REPAGE_TABLES, HUB_STATE_TABLES,
    REBUILT_SOURCE_IDENTITY_COLUMNS, REBUILT_SOURCE_PROBE_ROWS,
};
