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
 * XChain Indexer - Hub DB Sync Client: watermark and transport state
 *
 * The stream and height watermarks, the price-event buffer and mirror bound,
 * the socket serialization chain, the heartbeat watchdog, the stall detector
 * and the drain reporting knobs: the second half of what the constructor sets,
 * as named initializers called in order.
 *
 * Part of the hub-mirror client (src/hub/hub_db_sync.js), which installs the
 * methods here onto HubDbSync.prototype. Vendored byte-identical into
 * xchain-explorer by bin/sync-hub-mirror-client.sh: edit the xchain-indexer copy.
 *
 ********************************************************************/

const { readEnvNow } = require('./env.js');
const { HUB_SYNC_WATERMARK_GRACE_S, resolveWatermarkGrace, resolveBarrierHoldCeilingMs,
        HUB_SYNC_WATERMARK_STALL_S, HUB_SYNC_WATERMARK_STALL_EXIT_S,
        resolveWatermarkStallMs } = require('./watermark_config.js');
const { PRICE_BATCH_APPLY_ROWS, BOOTSTRAP_PROGRESS_INTERVAL_MS,
        PRICE_MIRROR_LOOKBACK_S } = require('./mirror_bounds.js');
const { priceEraFloorS } = require('../../consensus/gates/price_batching_floor_gate.js');

function initWatermarkState(sync) {
    // Stream-position watermark: the hub's "you have received everything I
    // produced up to ts" signal, carried by the WS heartbeat ({type:'watermark'}),
    // the ready message, and REST snapshot responses. This is what lets the
    // barriers below distinguish "my mirror is BEHIND the hub" (must defer,
    // settling now could fork the ledger) from "no new rows exist anywhere"
    // (must proceed, deferring deadlocks the chain). The previous row-content
    // watermarks (MAX(effective_at)/MAX(effective_time)) could not make that
    // distinction: the first sparse row armed the barrier and the tip deferred
    // forever until the NEXT row arrived (review items #1984/#1986, live-repro'd
    // on the origin-host/test-host testbed 2026-06-09).
    //
    // Grace margins (seconds) cover rows whose effective time can precede their
    // insertion into the stream: oracle first-publishes are effective at their
    // action's block_time (source-chain indexing lag → retroactive arrival; see
    // the PriceAggregator retroactivity finding for the protocol-level fix),
    // price rounds finalize via PBFT some time after their anchor block, and
    // matches are stamped with the hub's wall clock (skew only).
    sync.streamWatermark      = 0;
    // Frozen protocol constants (600/600/120/120), env-overridable only on regtest;
    // off-regtest the override is ignored with a warning and a bad value throws.
    // See HUB_SYNC_WATERMARK_GRACE_S / resolveWatermarkGrace above.
    sync.priceWatermarkGraceS  = resolveWatermarkGrace(HUB_SYNC_WATERMARK_GRACE_S.price,  'HUB_SYNC_PRICE_GRACE_S',  sync.network);
    sync.oracleWatermarkGraceS = resolveWatermarkGrace(HUB_SYNC_WATERMARK_GRACE_S.oracle, 'HUB_SYNC_ORACLE_GRACE_S', sync.network);
    sync.matchWatermarkGraceS  = resolveWatermarkGrace(HUB_SYNC_WATERMARK_GRACE_S.match,  'HUB_SYNC_MATCH_GRACE_S',  sync.network);
    sync.callWatermarkGraceS   = resolveWatermarkGrace(HUB_SYNC_WATERMARK_GRACE_S.call,   'HUB_SYNC_CALL_GRACE_S',   sync.network);
    sync.anchorAttestWatermarkGraceS = resolveWatermarkGrace(HUB_SYNC_WATERMARK_GRACE_S.anchorAttest, 'HUB_SYNC_ANCHOR_ATTEST_GRACE_S', sync.network);
    sync._anchorAttestWaiters  = [];                   // pending waitForAnchorAttestationSync() resolvers
    // Finalized ATTEST responses. Named for the response mirror, NOT for the anchorAttest
    // pair above it, which means anchor-reward attestations and is a different barrier over
    // a different table.
    sync.attestResponseWatermarkGraceS = resolveWatermarkGrace(HUB_SYNC_WATERMARK_GRACE_S.attestResponse, 'HUB_SYNC_ATTEST_RESPONSE_GRACE_S', sync.network);
    sync._attestResponseWaiters = [];                  // pending waitForAttestationResponseSync() resolvers
    // The two bridge-family barriers. Each resolves its OWN frozen entry, so neither can
    // be retuned by moving another table's knob (see HUB_SYNC_WATERMARK_GRACE_S).
    sync.bridgeWatermarkGraceS = resolveWatermarkGrace(HUB_SYNC_WATERMARK_GRACE_S.bridge, 'HUB_SYNC_BRIDGE_GRACE_S', sync.network);
    sync.policyWatermarkGraceS = resolveWatermarkGrace(HUB_SYNC_WATERMARK_GRACE_S.policy, 'HUB_SYNC_POLICY_GRACE_S', sync.network);

    // Named ceiling on a mirror-barrier hold. Held here as well as on the
    // indexer because requestResync() rate-limits itself by the same value: one forced
    // resync per ceiling window, so a mirror that cannot converge is re-driven on a
    // known cadence instead of being reconnect-stormed once per block-poll tick.
    sync.barrierHoldCeilingMs = resolveBarrierHoldCeilingMs();
    sync._lastResyncRequestAt = 0;
    sync.forcedResyncCount    = 0;

    // Watermark advancement is gated on a completed bootstrap: WS heartbeats
    // certify only what was delivered ON THE SOCKET, so until the REST
    // bootstrap has fully drained every mirrored table (rows from before the
    // subscription), a heartbeat must not certify the mirror as caught-up.
    // Reset on disconnect; re-set after the reconnect re-bootstrap drains.
    sync._bootstrapDrained = false;
    sync._readyWatermark   = null;
}

function initHeightWatermarkState(sync) {
    // ── The per-table, per-chain HEIGHT watermark, the mirror-admission family's
    // completeness evidence ────────────────────────────────────────────────────
    //
    // Keyed table then UPPER-CASE chain code, each value a non-negative safe integer:
    // the greatest height on that chain such that every consensus round for that table
    // which opened at an observed admission tip at or below it has TERMINATED (finalized
    // and broadcast, or abandoned). Above the activation that is what every barrier
    // certifies against, in place of the seconds watermark.
    //
    // FAIL-CLOSED BY ABSENCE, at every granularity: no object, no table key, no chain key
    // inside a table, a non-finite value or a hub that never served one all read as NOT
    // satisfied, so the barrier defers exactly as it does today. An empty object is a
    // legitimate publication and is not the same as "not yet published"; both defer.
    //
    // Gated on the same bootstrap drain as the seconds watermark and cleared on
    // disconnect, for the same reason: a heights map certifies rounds the hub has
    // BROADCAST, and until the REST bootstrap has drained, this node does not hold the
    // rows those rounds produced.
    sync.heightWatermarks       = {};
    sync._readyHeights          = null;   // captured off the ready frame, installed at drain
    sync._pendingBootstrapHeights = null; // the newest REST snapshot page's map, same
    sync._heightsLastAdvanceAt  = null;   // null until a usable map has been installed once
    // The highest target (B - margin) each (table, chain) barrier came up short at, so the
    // stall detector can see a heights map that froze while `ts` kept ticking. Set by the
    // predicate itself because the hub publishes no admission tip of its own on any
    // carrier; cleared per entry the moment the published height reaches the target.
    sync._heightShortfalls      = {};
    // Set when a live row event is rejected for a schema_version mismatch. While
    // true the watermark heartbeat must NOT advance, or the price-sync barrier
    // would open and settle a block against mirror data we refused to apply.
    // Cleared on a clean re-bootstrap (which only drains when versions match).
    sync._schemaMismatchSeen = false;
    // Set when a live apply FAILED (the write did not land, or the handler threw).
    // Independent of the schema latch and needed for the same reason: the message
    // handler's catch logs and continues, so without this the very next heartbeat
    // certifies the stream as caught-up over a row this mirror never wrote, and the
    // settlement barriers open on it. Cleared only by a clean re-bootstrap drain,
    // exactly where _schemaMismatchSeen is cleared. The watermark-stall detector is
    // the bound: a frozen watermark under a live hub tip forces one resync and then
    // hands the process to its supervisor, so the latch cannot wedge silently.
    sync._applyFailureSeen = false;
}

function initPriceDrainState(sync, options) {
    // Live price_snapshots events are BUFFERED, not applied, until the
    // current connection's price_snapshots bootstrap has fully drained
    // (#2422). The WS subscription opens BEFORE the REST bootstrap and
    // price_snapshots deliberately drains LAST behind a multi-minute pull,
    // so a live row (a freshly-finalized round) applied mid-drain lands
    // ABOVE rows only the still-draining bootstrap will deliver. Every
    // MAX()-based refresh would then overstate the mirror (priceSyncHeight
    // jumps to the fresh round while earlier rounds are still absent) and
    // the height barrier would open over a HOLED mirror: a per-operator
    // divergent native-fee price read. The same out-of-order row would
    // also contaminate the re-bootstrap cursor (since_id = local MAX(id)
    // silently skips the gap under it). Deferring the apply keeps the
    // local mirror a CONTIGUOUS prefix of the hub's table at all times,
    // which is what makes the reconnect self-heal
    // (refreshAllSyncHeights) and the timeout self-heal safe to read
    // from it unguarded. _priceDrained is per-connection (reset on close,
    // like _bootstrapDrained); the buffer replays in arrival order once
    // the drain completes (see bootstrapTable), then the live path
    // resumes. _wsEpoch bumps on every disconnect so a flush racing a
    // close can never stale-arm _priceDrained for the next connection.
    sync._priceDrained         = false;
    sync._pendingPriceEvents   = [];
    sync._pendingPriceOverflow = false;
    sync._wsEpoch              = 0;

    // price_snapshots bootstrap bound. Optional async hook returning the
    // unix-second HORIZON below which no block this consumer will ever process can
    // read a price round; the drain then applies rounds at/after it plus a margin of
    // history below it (see the constant block above). Absent, unresolvable or
    // non-positive => no bound at all, which is the unbounded full mirror: the
    // explorer's vendored display mirror passes nothing and is unchanged.
    sync.getPriceMirrorHorizon = (typeof options.getPriceMirrorHorizon === 'function')
        ? options.getPriceMirrorHorizon : null;
    // How far below the horizon the current drain reaches, and the drain's own verdict
    // on whether that span was deep enough. Instance state, not constants, because a
    // short drain widens the span for the retry and a repeatedly short one disables the
    // bound outright.
    sync._priceMirrorLookbackS     = PRICE_MIRROR_LOOKBACK_S;
    sync._priceMirrorBoundDisabled = false;
    // Set when a block older than the bounded mirror's floor was seen; holds both price
    // barriers shut until a drain has mirrored price_snapshots in full again.
    sync._priceMirrorRefloor       = false;
    // Timestamp below which the local price_snapshots copy is deliberately incomplete,
    // or 0 when it holds everything the hub served. Read by the price barriers: a block
    // older than this is a block whose price reads the mirror cannot answer, so the
    // bound is abandoned and the table re-mirrored in full rather than settled against
    // (see notePriceMirrorFloor).
    sync._priceMirrorFloorTs   = 0;

    // Pre-batch era floor: the instant this network's price rail began. Blocks below
    // it hold no eligible price round on ANY node, so both price barriers resolve
    // immediately for them instead of waiting out a timeout that nothing can open
    // (see price_batching_floor_activation.js). 0 = no pre-batch era recognized,
    // which is every network as shipped and the barrier behaviour that deploys today.
    // Resolved once here rather than per block: the map is a frozen fleet-wide
    // constant, and both barrier paths run on every transaction-bearing block.
    sync._priceEraFloorS       = priceEraFloorS(sync.network, sync.coin);
}

function initTransportState(sync, options) {
    // Serialization chain for the WebSocket message handler. Each incoming
    // message appends its async work to this promise so that a watermark
    // heartbeat cannot advance streamWatermark while a preceding row:inserted
    // apply is still awaiting its DB write. The chain is reset on reconnect
    // (the old connection's in-flight work is abandoned on close anyway).
    sync._msgChain = Promise.resolve();

    // Heartbeat-timeout watchdog: the hub broadcasts a {type:'watermark'} frame
    // every WS_WATERMARK_INTERVAL_MS (10s server-side default; see HubDbBroadcaster). A
    // half-open TCP connection (NAT timeout, LB idle drop, hub host power loss)
    // fires neither 'close' nor 'error' on this socket, so without an explicit
    // liveness check the mirror can freeze silently for hours. _lastHeartbeatAt
    // is stamped in advanceWatermark's caller (the 'watermark' message handler)
    // and on every fresh connection; _watchdogTimer polls it while the socket is
    // open and terminates a stalled socket so the existing close-handler
    // reconnect path self-heals. See review finding 0af6d951.
    //
    // The watchdog timeout MUST exceed the hub's heartbeat interval. That interval
    // is now self-describing: the hub stamps its actual cadence into the 'ready'
    // message (watermark_interval_ms), and the ready handler resizes the watchdog
    // from it, so an operator raising WS_WATERMARK_INTERVAL_MS on the hub can no
    // longer make this consumer terminate a healthy socket. The env value below is
    // only the pre-ready seed and the fallback for older hubs that omit the field.
    sync._lastHeartbeatAt = null;
    sync._watchdogTimer = null;
    sync.watermarkIntervalMs = parseInt(options.watermarkIntervalMs || readEnvNow('HUB_SYNC_WATERMARK_INTERVAL_MS') || '10000');
    sync.watermarkTimeoutMs = sync.watermarkIntervalMs * 3;
}

function initStallDetectorState(sync, options) {
    // Stream-watermark stall detector; see the constant block above for the why.
    // The watchdog directly above proves FRAMES are arriving and says nothing about
    // whether any of them still moves the watermark, so these fields are the other
    // half of that pair. _hubTipTs is the newest tip the hub has claimed in a
    // heartbeat, recorded whether or not the gate let it through, which is the only
    // reason "hub ahead, us frozen" is observable at all. _lastWatermarkAdvanceAt is
    // when the watermark last actually moved. _watermarkStallResyncAt latches the one
    // forced resync per stall episode, so stage 2 times a window AFTER the remedy
    // instead of running a second detection window.
    sync._hubTipTs               = 0;
    sync._lastWatermarkAdvanceAt = null;
    sync._watermarkStallResyncAt = null;
    sync._stallTimer             = null;
    sync.watermarkStallMs     = Number.isFinite(options.watermarkStallMs)
        ? options.watermarkStallMs
        : resolveWatermarkStallMs(undefined, 'HUB_SYNC_WATERMARK_STALL_S', HUB_SYNC_WATERMARK_STALL_S);
    sync.watermarkStallExitMs = Number.isFinite(options.watermarkStallExitMs)
        ? options.watermarkStallExitMs
        : resolveWatermarkStallMs(undefined, 'HUB_SYNC_WATERMARK_STALL_EXIT_S', HUB_SYNC_WATERMARK_STALL_EXIT_S);
    // Fail-loud seam for stage 2. Left unwired, the detector re-subscribes and logs
    // but never ends the process, which is what a consumer that embeds this mirror
    // beside unrelated work needs (one chain's stalled mirror must not take down a
    // process serving several). The indexer wires its own exit so its supervisor can
    // restart it, which is the posture every other fatal in that service takes.
    sync._onFatalStall = (typeof options.onFatalStall === 'function') ? options.onFatalStall : null;
}

function initDrainReportingState(sync, options) {
    // Batched price applies and the drain's progress counter. Both are
    // reporting/throughput only - no barrier, floor or mirrored row depends on
    // either - so both carry a plain off switch rather than a fail-closed gate.
    sync._batchApplyDisabled = (options.batchApply === false) ||
                               (readEnvNow('HUB_SYNC_BATCH_APPLY') === 'false');
    sync._batchApplyWarned   = false;
    sync.batchApplyRows      = parseInt(options.batchApplyRows ||
                                        readEnvNow('HUB_SYNC_BATCH_APPLY_ROWS') || String(PRICE_BATCH_APPLY_ROWS));
    if (!Number.isFinite(sync.batchApplyRows) || sync.batchApplyRows < 2)
        sync.batchApplyRows = PRICE_BATCH_APPLY_ROWS;
    sync.bootstrapProgressMs = parseInt(options.bootstrapProgressMs ||
                                        readEnvNow('HUB_SYNC_BOOTSTRAP_PROGRESS_MS') || String(BOOTSTRAP_PROGRESS_INTERVAL_MS));
    if (!Number.isFinite(sync.bootstrapProgressMs) || sync.bootstrapProgressMs < 0)
        sync.bootstrapProgressMs = BOOTSTRAP_PROGRESS_INTERVAL_MS;
}

module.exports = { initWatermarkState, initHeightWatermarkState, initPriceDrainState, initTransportState,
                   initStallDetectorState, initDrainReportingState };
