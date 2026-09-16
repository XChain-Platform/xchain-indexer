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
 * XChain Indexer - Hub DB Sync Client
 *
 * Maintains a local read-only copy of the hub's price_snapshots and
 * oracle_prices tables. On startup, fetches a snapshot via REST. After
 * bootstrap, subscribes to a WebSocket channel for live row updates.
 *
 * Used in distributed deployments where the indexer is on a different
 * host from the hub. For single-host deployments, the indexer can simply
 * point its hubDb connection directly at the hub's MariaDB instead.
 *
 * Pure Node.js. Uses built-in http/https + the `ws` package only when present.
 *
 * Relationship to xchain-sync (deliberately separate, not accidental dup)
 * ----------------------------------------------------------------------
 * xchain-sync solves a superficially similar problem (snapshot-then-stream a
 * MariaDB table) but is a different abstraction: it fans *validated ledger*
 * data DOWNSTREAM from a master to many validator replicas, with Merkle
 * transparency, cross-source hash verification, and rollback. This module
 * pulls oracle config UPSTREAM from the hub (the producer) into a single
 * consumer (the indexer's own hub-DB mirror), and its real payload is the
 * `waitForPriceSyncHeight` consensus barrier wired into the block loop
 * (XChainIndexer.js), NOT the plumbing. The two are kept apart on purpose:
 * xchain-sync's schema/replicated_tables.js excludes price_snapshots as "hub-mirrored"
 * and SnapshotBuilder defers to this file. See review finding e800fdf6.
 *
 * TRIGGER for revisiting: if a THIRD cross-service table (e.g. validator-set
 * or attestation-results) needs the same snapshot-then-stream treatment, do
 * NOT copy this file a third time. Extract the shared mechanics: the
 * subscribe-before-bootstrap ordering handshake, INSERT IGNORE applier,
 * reconnect/re-bootstrap, and retraction-by-known-column, into one small
 * applier library that both this module and the new consumer use. Merging the
 * two services wholesale is the wrong move (different trust direction, and the
 * consensus barrier belongs to the indexer loop, not to a replication fabric).
 *
 * LAYOUT. This file is the entry: the class, its constructor, and the one export.
 * The behaviour lives in src/hub/hub_db_sync/, one part per concern (bootstrap,
 * row apply and retraction, foreign-row reconciliation, the barriers, the socket
 * transport, the env reads), each exporting an object of methods this file
 * installs onto HubDbSync.prototype, the same shape src/XChainIndexer.js takes
 * with its parts. The entry and every part are vendored byte-identical into
 * xchain-explorer by bin/sync-hub-mirror-client.sh, so a part is never edited
 * on the explorer side, and a part added here must be added to that script's
 * vendored set (the explorer conformance suite walks the directory and fails on
 * a part the script does not carry).
 *
 ********************************************************************/

const { HUB_STATE_TABLES } = require('./hub_db_sync/mirror_tables.js');
const { HUB_SYNC_WATERMARK_GRACE_S, resolveWatermarkGrace,
        HUB_SYNC_BARRIER_HOLD_CEILING_S, resolveBarrierHoldCeilingMs,
        HUB_SYNC_WATERMARK_STALL_S, HUB_SYNC_WATERMARK_STALL_EXIT_S, WATERMARK_STALL_CHECK_MS,
        resolveWatermarkStallMs, watermarkStallVerdict,
        sanitizeHeights, heightsAdvanced } = require('./hub_db_sync/watermark_config.js');
const { PRICE_BATCH_APPLY_ROWS, BOOTSTRAP_PROGRESS_INTERVAL_MS, PRICE_MIRROR_ROUND_MARGIN,
        PRICE_MIRROR_MIN_PRE_HORIZON_ROUNDS, PRICE_MIRROR_LOOKBACK_S } = require('./hub_db_sync/mirror_bounds.js');
const { priceUpsertSql } = require('./hub_db_sync/mirror_write.js');
const { ensureTables } = require('./hub_db_sync/ensure_tables.js');
const { initConnection, initPriceBarrierState, initContentBarrierState, initConsumerHooks,
        initChainIdentityState } = require('./hub_db_sync/instance_state.js');
const { initWatermarkState, initHeightWatermarkState, initPriceDrainState, initTransportState,
        initStallDetectorState, initDrainReportingState } = require('./hub_db_sync/watermark_state.js');
const watermarkMethods       = require('./hub_db_sync/watermarks.js');
const lifecycleMethods       = require('./hub_db_sync/lifecycle.js');
const bootstrapDrainMethods  = require('./hub_db_sync/bootstrap/drain.js');
const bootstrapFlushMethods  = require('./hub_db_sync/bootstrap/flush.js');
const bootstrapVerdictMethods = require('./hub_db_sync/bootstrap/verdict.js');
const mirrorScopeMethods     = require('./hub_db_sync/mirror_scope.js');
const chainIdentityMethods   = require('./hub_db_sync/chain_identity.js');
const reconciliationMethods  = require('./hub_db_sync/foreign_reconciliation.js');
const priceBarrierMethods    = require('./hub_db_sync/barriers/price.js');
const contentBarrierMethods  = require('./hub_db_sync/barriers/oracle_match_call.js');
const bridgePolicyBarrierMethods = require('./hub_db_sync/barriers/bridge_policy.js');
const attestBarrierMethods   = require('./hub_db_sync/barriers/attest.js');
const snapshotBarrierMethods = require('./hub_db_sync/barriers/snapshot.js');
const rowApplyMethods        = require('./hub_db_sync/row_apply.js');
const retractionMethods      = require('./hub_db_sync/retractions.js');
const liveEventMethods       = require('./hub_db_sync/live_events.js');
const { transportMethods }   = require('./hub_db_sync/transport.js');

class HubDbSync {

    // Every field is set by a named initializer, in the order the parts depend on
    // one another: the consumer hooks name the network and coin the watermark graces
    // and the pre-batch era floor are resolved for.
    constructor(hubDb, options) {
        initConnection(this, hubDb, options);
        initPriceBarrierState(this);
        initContentBarrierState(this);
        initConsumerHooks(this, options);
        initChainIdentityState(this);
        initWatermarkState(this);
        initHeightWatermarkState(this);
        initPriceDrainState(this, options);
        initTransportState(this, options);
        initStallDetectorState(this, options);
        initDrainReportingState(this, options);
    }
}

// The parts, installed in dependency order for the reader: the split is by concern,
// and no part reaches another except through `this`, so the order only decides what
// a later part could shadow, which none does (the names are disjoint by construction:
// a duplicate here would be a second definition of one method, and the drift guard
// in the entry test compares the installed names against each part's own).
Object.assign(HubDbSync.prototype, watermarkMethods, lifecycleMethods,
              bootstrapDrainMethods, bootstrapFlushMethods, bootstrapVerdictMethods,
              mirrorScopeMethods, chainIdentityMethods, reconciliationMethods,
              priceBarrierMethods, contentBarrierMethods, bridgePolicyBarrierMethods,
              attestBarrierMethods, snapshotBarrierMethods,
              rowApplyMethods, retractionMethods, liveEventMethods, transportMethods);

// ONE export shape: the class. Everything a consumer reaches beside it (ensureTables,
// the frozen constants and their resolvers) is attached to the class before it is
// exported, so `require(...).X` resolves exactly as it did when these were properties
// of module.exports, and the module still exports one thing.
HubDbSync.ensureTables = ensureTables;
// Exported so tests assert against the frozen source of truth rather than
// restating its numbers, which would let a future change here pass a stale test.
HubDbSync.HUB_SYNC_WATERMARK_GRACE_S = HUB_SYNC_WATERMARK_GRACE_S;
// Exported for the direct-hub-DB (no-mirror) call barrier in XChainIndexer.js, which
// opens on the SAME frozen call grace as callSyncSatisfied's watermark escape. It has
// to resolve that grace through this exact function, not a private copy: the regtest
// override, the off-regtest ignore-with-warning and the invalid-value throw are part of
// the constant's contract, and two nodes resolving it differently fork settlement.
HubDbSync.resolveWatermarkGrace = resolveWatermarkGrace;

// The named ceiling on a mirror-barrier hold, and its resolver. Exported so
// XChainIndexer reads the SAME value the resync rate-limiter uses: a block loop that
// declared a crossing on one number while the mirror throttled on another would either
// storm the hub or never re-drive it at all.
HubDbSync.HUB_SYNC_BARRIER_HOLD_CEILING_S = HUB_SYNC_BARRIER_HOLD_CEILING_S;
HubDbSync.resolveBarrierHoldCeilingMs     = resolveBarrierHoldCeilingMs;
// The stall detector's windows, their resolver and the verdict itself. The verdict is
// exported because it is the whole decision: a test that drove it only through timers
// and a socket could not tell a suppression apart from a window that had not elapsed.
HubDbSync.HUB_SYNC_WATERMARK_STALL_S      = HUB_SYNC_WATERMARK_STALL_S;
HubDbSync.HUB_SYNC_WATERMARK_STALL_EXIT_S = HUB_SYNC_WATERMARK_STALL_EXIT_S;
HubDbSync.WATERMARK_STALL_CHECK_MS        = WATERMARK_STALL_CHECK_MS;
HubDbSync.resolveWatermarkStallMs         = resolveWatermarkStallMs;
HubDbSync.watermarkStallVerdict           = watermarkStallVerdict;

// The height watermark's two pure helpers, exported so the wire-shape rules (what counts as
// a height, what counts as an advance) are drivable without a socket, a DB or a real clock.
HubDbSync.sanitizeHeights                 = sanitizeHeights;
HubDbSync.heightsAdvanced                 = heightsAdvanced;
// The batch's chunk size and the drain's progress cadence, plus the shared upsert
// builder: exported so the test can prove the batched statement and the per-row
// statement are the same statement, which is the only thing keeping the ODKU body
// from being maintained twice.
HubDbSync.PRICE_BATCH_APPLY_ROWS         = PRICE_BATCH_APPLY_ROWS;
HubDbSync.BOOTSTRAP_PROGRESS_INTERVAL_MS = BOOTSTRAP_PROGRESS_INTERVAL_MS;
HubDbSync.priceUpsertSql                 = priceUpsertSql;
// The price-mirror bootstrap bound numbers, exported for the same reason as the
// grace constants above and, in the margin case, for one more: it has to stay above
// protocol/constants.js ORACLE_VM_ROUND_WINDOW, and the only place that lockstep can be
// checked is a test that reads both.
HubDbSync.PRICE_MIRROR_ROUND_MARGIN           = PRICE_MIRROR_ROUND_MARGIN;
HubDbSync.PRICE_MIRROR_MIN_PRE_HORIZON_ROUNDS = PRICE_MIRROR_MIN_PRE_HORIZON_ROUNDS;
HubDbSync.PRICE_MIRROR_LOOKBACK_S             = PRICE_MIRROR_LOOKBACK_S;
// A frozen COPY, not the live array: a caller iterating the mirrored-table set
// (a guard asserting every member keeps some property) must not be able to
// mutate the module's own membership by mutating what it was handed.
HubDbSync.HUB_STATE_TABLES = Object.freeze(HUB_STATE_TABLES.slice());

module.exports = HubDbSync;
