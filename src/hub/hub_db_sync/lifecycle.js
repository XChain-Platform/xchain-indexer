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
 * XChain Indexer - Hub DB Sync Client: lifecycle
 *
 * Starting and stopping the mirror, the bootstrap of every table and the verdict
 * that certifies a full drain, the status snapshot, forced resyncs, reconnects
 * and the polling fallback.
 *
 * Part of the hub-mirror client (src/hub/hub_db_sync.js), which installs the
 * methods here onto HubDbSync.prototype. Vendored byte-identical into
 * xchain-explorer by bin/sync-hub-mirror-client.sh: edit the xchain-indexer copy.
 *
 ********************************************************************/

// One logger for the whole service (CODE-STYLE.md, Logging). The accessor is read per
// call, so it resolves exactly when console did and falls through to console before the
// shim is installed. The explorer's vendored copy reaches the same path because it
// carries the hub-canonical observability shim at src/observability/.
const { getLogger } = require('../../observability/index.js');
const { CROSS_CHAIN_TABLES, HUB_STATE_TABLES } = require('./mirror_tables.js');
const { WebSocket } = require('./transport.js');

module.exports = {

    // Start: open WebSocket and await the hub's ready acknowledgement (confirming
    // the subscription is registered), then bootstrap from REST snapshots. This
    // order ensures no rows can be broadcast between the snapshot response and our
    // subscription becoming active. Rows that arrive via the stream during the
    // bootstrap window are harmless duplicates (applyRow uses INSERT IGNORE).
    async start() {
        if (!this.enabled) {
            getLogger().info('HubDbSync: disabled (no hub URL or no local hub DB connection)');
            return;
        }
        this.running = true;
        // Armed from the start, but inert until the watermark has advanced at least once:
        // a cold start that never drains is the block loop's hold ceiling to bound, not
        // this detector's, and exiting during a first drain would only restart-loop.
        this.startStallDetector();

        if (WebSocket) {
            // Subscribe first so no row is missed between the REST snapshot and
            // when the hub registers us as a subscriber.
            try {
                await this.connectWebSocket();
            } catch (err) {
                getLogger().warn('HubDbSync: WebSocket not ready before bootstrap:', err);
                // Continue: bootstrap still runs; scheduleReconnect is already queued
            }
        } else {
            getLogger().warn('HubDbSync: ws package not available, falling back to periodic polling');
            // Select the poll fallback BEFORE the first bootstrap so even that initial
            // drain fails closed (does not certify the watermark); see bootstrapAll (#2476).
            this._pollMode = true;
        }

        // Bootstrap each tracked table after the subscription is confirmed active
        await this.bootstrapAll();

        if (!WebSocket) {
            this.startPolling();
        }
    },

    // Bootstrap every mirrored table. When ALL of them fully drain (each REST
    // snapshot returned fewer rows than its page limit and applied cleanly),
    // the mirror provably holds everything the hub had at the OLDEST of the
    // per-table response watermarks, then advance the stream watermark to it and
    // open the heartbeat gate.
    //
    // A partial drain leaves the gate closed and SCHEDULES A RETRY. The retry is
    // load-bearing in WS mode: there is no poll loop while the socket is healthy,
    // so without it one failed table would freeze the watermark at 0 until the
    // next reconnect (which on a stable connection is never the case; prod incident
    // 2026-06-11: BTC mainnet deferred every tip block in 60s loops because the
    // single-page bootstrap could not drain a >10k-row price_snapshots table and
    // nothing ever re-attempted it).
    async bootstrapAll() {
        if (this._bootstrapping) return;                     // reconnect + retry timer may overlap
        this._bootstrapping = true;
        const drainEpoch = this._wsEpoch;
        try {
            this._pendingBootstrapHeights = null;
            let drained = await this.drainEveryTable();
            // A disconnect leaves a delivery gap that only the replacement
            // connection's own drain can close. Results started on the prior
            // connection cannot certify its replacement.
            const sameConnection = this._wsEpoch === drainEpoch;
            if (drained.allDrained && drained.marks.length > 0 && sameConnection)
                this.certifyFullDrain(drained.marks, drainEpoch);
            else if (this.running) this.scheduleBootstrapRetry();
        } finally {
            this._bootstrapping = false;
        }
    },

    // Drain every mirrored table once, in the order below, and report the per-table
    // watermarks of the ones that drained in full.
    // price_snapshots bootstraps LAST so EVERY per-block barrier that gates block
    // processing (oracle, cross-chain match, cross-chain call, capability snapshot)
    // arms its empty-mirror fast path before the one heavy table drains. Each of those
    // barriers' "no-op on an empty mirror" path requires its OWN <x>Bootstrapped flag,
    // which only flips after that table's bootstrap completes; serialized behind a
    // multi-minute price_snapshots drain they all stay false, so a cold-start indexer at
    // chain tip with empty hub mirrors defers every block 60s on the FIRST unarmed
    // barrier (LTC-testnet 2026-06-16: a 37,032-row price_snapshots drain held the oracle
    // barrier at 'oracle mirror at null' for 3.5 min). Ordering price_snapshots first
    // only relocated that stall to the next barrier in sequence; draining it last lets
    // the small barrier tables (typically empty on non-BTC chains) arm in ~1s. The
    // price_snapshots barrier (waitForPriceSyncHeight) is BTC-only and runs FIRST in the
    // block loop, so BTC waits for price_snapshots there regardless of bootstrap order;
    // draining it last means BTC waits ONCE (its price barrier) instead of twice (price
    // then match). Consensus-neutral: the global stream watermark still advances only
    // after ALL tables drain, independent of order.
    async drainEveryTable() {
        let marks = [];
        let allDrained = true;
        for (let table of ['oracle_prices'].concat(CROSS_CHAIN_TABLES, HUB_STATE_TABLES, ['price_snapshots'])) {
            try {
                let mark = await this.bootstrapTable(table);
                if (mark === null) allDrained = false;
                else marks.push(mark);
            } catch (err) {
                allDrained = false;
                getLogger().warn('HubDbSync: ' + table + ' bootstrap failed:', err);
            }
        }
        return { marks: marks, allDrained: allDrained };
    },

    // Every table drained in full: open the heartbeat gate and advance the stream
    // watermark to the oldest per-table mark, unless this mirror is in poll mode.
    certifyFullDrain(marks, drainEpoch) {
        // Keep the epoch check at the certification boundary as well as at the
        // bootstrap caller. No alternate caller may open the gate with a drain
        // whose socket closed before certification.
        if (this._wsEpoch !== drainEpoch) return false;
        this._bootstrapDrained = true;
        // A clean full drain proves the hub's schema_version matched (a
        // mismatch parks the bootstrap), so any earlier live mismatch is
        // resolved: re-open the watermark gate.
        this._schemaMismatchSeen = false;
        // Same reasoning for the apply-failure latch: a clean full drain re-wrote
        // every table from the hub, so whatever a live apply failed to write is
        // present again and the gate may re-open.
        this._applyFailureSeen = false;
        if (this._pollMode) {
            // Poll-mode fail-closed (#2476): the REST snapshot endpoints are
            // append-only, so a poll cycle observes new-id INSERTs but can NEVER
            // receive an in-place upsert (skipped->finalized, anchor stamp,
            // generation bump) or a row:deleted retraction the way the WS stream
            // does. Advancing the watermark here would certify the mirror as
            // live-complete through min(marks) and let the watermark-escape paths
            // in the settlement barriers open over data that can be silently
            // stale, forking the ledger. Freeze the watermark and warn every
            // cycle instead; the barriers fall back to their content paths and
            // DEFER rather than certify. Mirroring itself still ran above.
            getLogger().warn('HubDbSync: poll-mode mirror: watermark frozen, WS unavailable, ' +
                'upserts/retractions cannot be received; settlement barriers will not certify');
        } else {
            // Install the height map from whichever carrier served one this drain,
            // preferring the snapshot pages over the ready frame because they are the
            // later statement. Neither means CLEAR, the fail-closed direction: a hub
            // that publishes no heights cannot certify a re-keyed barrier.
            this.noteHeights(this._pendingBootstrapHeights || this._readyHeights);
            this.advanceWatermark(Math.min.apply(null, marks));
        }
        return true;
    },

    // A partial drain leaves the gate closed and comes back around after one poll interval.
    scheduleBootstrapRetry() {
        getLogger().warn('HubDbSync: bootstrap partial, retrying in ' + this.pollIntervalMs + 'ms (heartbeat gate stays closed)');
        setTimeout(() => {
            if (this.running && !this._bootstrapDrained) this.bootstrapAll();
        }, this.pollIntervalMs);
    },

    stop() {
        this.running = false;
        this.stopStallDetector();
        if (this.ws) {
            try { this.ws.close(); } catch (e) { /* ignore */ }
            this.ws = null;
        }
    },

    // Read-only status snapshot for /status: composed from state already tracked
    // on the instance, so a caller never reaches into private fields to answer
    // "is the mirror connected, and how far behind". Disabled reports configured:false
    // rather than a zeroed shape that would read as a live mirror stalled at genesis.
    mirrorStatus() {
        if (!this.enabled) {
            return { configured: false, connected: false, bootstrapped: false, streamWatermark: null,
                     tables: {}, heights: {} };
        }
        let tables = {};
        // HUB_STATE_TABLES rides the global streamWatermark, not a per-table
        // scalar: that IS what gates each of them (§4.2).
        for (let table of HUB_STATE_TABLES) tables[table] = this.streamWatermark;
        tables.oracle_prices       = this.oracleSyncTimestamp;
        tables.cross_chain_matches = this.matchSyncTimestamp;
        tables.cross_chain_calls   = this.callSyncTimestamp;
        // capability_snapshots satisfaction is a live per-block query, never a
        // cached scalar (snapshotSyncSatisfied); nothing in-memory to report.
        tables.capability_snapshots = null;
        tables.price_snapshots      = this.priceSyncMaxTimestamp;
        tables.bridge_transfers     = this.bridgeSyncTimestamp;
        tables.policy_snapshots     = this.policySyncTimestamp;
        return {
            configured: true,
            connected: !!this.ws,
            bootstrapped: this._bootstrapDrained,
            streamWatermark: this.streamWatermark,
            // The stall detector's two inputs, surfaced so an operator can read the
            // "hub ahead, mirror frozen" gap off /status instead of inferring it from
            // deferral logs. null age means the mirror has not certified anything yet.
            hubTipTs: this._hubTipTs,
            watermarkFrozenMs: (this._lastWatermarkAdvanceAt == null)
                ? null : (Date.now() - this._lastWatermarkAdvanceAt),
            tables: tables,
            // The per-table per-chain height watermark, beside the seconds one. Additive,
            // node-local and hashed by nothing: it exists so an operator can read "the hub's
            // heights map for my chain stopped at H while I need B - margin" off /status
            // instead of inferring it from deferral logs.
            heights: this.heightWatermarks,
            // The comparisons that came up short, and how long the map has been quiet. Null
            // age means no heights map has ever been installed, which is a cold start on this
            // axis rather than a stall.
            heightShortfalls: Object.assign({}, this._heightShortfalls),
            heightsFrozenMs: (this._heightsLastAdvanceAt == null)
                ? null : (Date.now() - this._heightsLastAdvanceAt)
        };
    },

    // Force a fresh subscribe-then-bootstrap cycle on this mirror.
    //
    // Called by the block loop when one block has been held at a mirror-completeness
    // barrier for longer than the named hold ceiling. Every one of those barriers opens
    // on the stream watermark, the watermark only advances while _bootstrapDrained is
    // set, and nothing else in this module ever re-arms that flag once a drain has
    // stalled: the socket can stay open and heartbeating (so the watchdog is satisfied)
    // while the mirror certifies nothing, indefinitely. Tearing the socket down puts the
    // mirror back through the ONE path that does re-arm it, which the close handler
    // already implements and exercises on every ordinary disconnect
    // (scheduleReconnect -> connectWebSocket -> refreshAllSyncHeights -> bootstrapAll).
    //
    // This opens NO barrier and commits NO block: a mirror that is genuinely missing
    // rows keeps deferring after the resync, which is the fail-closed outcome. It only
    // ensures the wait is bounded by a re-drive rather than by nothing at all.
    //
    // Safe to fire while a re-bootstrap is already draining, which is the case it is most
    // likely to hit: bootstrapTable pages from the LOCAL max id as since_id, so a restarted
    // drain resumes where the applied rows end rather than starting over. The cost of a
    // mistimed resync is one in-flight page refetched, and the throttle below caps that at
    // one per ceiling window.
    //
    // Rate-limited to one resync per ceiling window, and a no-op on a disabled or
    // stopped mirror, so the block loop can call it on every deferring poll tick.
    // Returns true when a resync was actually kicked.
    requestResync(reason) {
        if (!this.enabled || !this.running) return false;
        if (!Number.isFinite(this.barrierHoldCeilingMs) || this.barrierHoldCeilingMs <= 0) return false;
        const now = Date.now();
        if (this._lastResyncRequestAt && (now - this._lastResyncRequestAt) < this.barrierHoldCeilingMs) return false;
        this._lastResyncRequestAt = now;
        return this.driveResync(reason);
    },

    // The resync itself, without the hold-ceiling throttle above. Split out because the
    // watermark-stall detector has to be able to spend its ONE remedy on its own
    // schedule: sharing requestResync's rate limiter would let an unrelated block-loop
    // resync minutes earlier swallow the stage-1 attempt whose outcome stage 2 then
    // measures, and the detector would exit having never actually retried.
    driveResync(reason) {
        this.forcedResyncCount++;
        getLogger().warn('HubDbSync: forcing a mirror resync (' + String(reason || 'barrier hold ceiling reached') + ')');
        if (this.ws) {
            // terminate() over close(): a half-open socket may never complete a closing
            // handshake, and the 'close' handler runs either way to schedule the reconnect.
            try {
                if (typeof this.ws.terminate === 'function') this.ws.terminate();
                else if (typeof this.ws.close === 'function') this.ws.close();
            } catch (err) {
                getLogger().warn('HubDbSync: forced resync could not terminate the socket: ' + (err && err.message));
            }
            return true;
        }
        // No live socket: poll mode, or a reconnect already pending. Re-drive the
        // bootstrap directly so a stuck poll-mode mirror still gets a fresh pull.
        Promise.resolve()
            .then(() => this.bootstrapAll())
            .catch(err => getLogger().warn('HubDbSync: forced resync bootstrap failed: ' + (err && err.message)));
        return true;
    },

    scheduleReconnect() {
        if (!this.running) return;
        setTimeout(async () => {
            if (!this.running) return;

            // Await the hub's ready acknowledgement before re-bootstrapping, for the
            // same reason as start(): no row must fall in the gap between the REST
            // snapshot and the subscription becoming active on the hub side.
            try {
                await this.connectWebSocket();
            } catch (err) {
                // connectWebSocket already queued another scheduleReconnect via the
                // close handler; nothing more to do here.
                return;
            }

            // Proactively re-sync the barrier heights from the LOCAL mirror the
            // instant the socket is back (before re-bootstrap). The disconnect may
            // have frozen the in-memory heights behind a mirror that is already
            // current (or close to it); refreshing here clears any block deferred
            // only on that staleness immediately, instead of making each wait for
            // re-bootstrap to redeliver rows or fall through to the 60s timeout.
            await this.refreshAllSyncHeights();

            // Re-bootstrap to fill in rows missed while disconnected. bootstrapTable
            // uses the local max-ID as since_id, so it fetches only genuinely-missing
            // rows; re-receives are harmless thanks to INSERT IGNORE in applyRow.
            // A full drain re-opens the heartbeat gate and advances the watermark.
            await this.bootstrapAll();
        }, 5000);
    },

    // Polling fallback when ws is not available. Poll-mode mirrors do NOT get the
    // same liveness semantics as the WS heartbeat (#2476): the REST snapshot
    // endpoints are append-only, so a poll cycle can observe new-id INSERTs but can
    // never receive an in-place upsert or a row:deleted retraction. bootstrapAll
    // therefore refuses to advance the stream watermark while _pollMode is set, so
    // the settlement barriers fail closed (defer) rather than certify against a
    // mirror that may be silently stale. Bootstrapping/mirroring still runs each cycle.
    startPolling() {
        let poll = async () => {
            if (!this.running) return;
            try {
                await this.bootstrapAll();
            } catch (err) {
                getLogger().warn('HubDbSync: poll error:', err);
            }
            if (this.running) setTimeout(poll, this.pollIntervalMs);
        };
        setTimeout(poll, this.pollIntervalMs);
    },

};
