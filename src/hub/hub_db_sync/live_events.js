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
 * XChain Indexer - Hub DB Sync Client: live events
 *
 * Routing one live row event from the subscription stream, and the price-event
 * buffer that holds live rounds until the price bootstrap has drained.
 *
 * Part of the hub-mirror client (src/hub/hub_db_sync.js), which installs the
 * methods here onto HubDbSync.prototype. Vendored byte-identical into
 * xchain-explorer by bin/sync-hub-mirror-client.sh: edit the xchain-indexer copy.
 *
 ********************************************************************/

const { getLogger } = require('../../observability/index.js');
const { HUB_SCHEMA_VERSION } = require('../hub-schema-version');
const { CROSS_CHAIN_TABLES } = require('./mirror_tables.js');
const { PENDING_PRICE_EVENT_CAP } = require('./mirror_bounds.js');

module.exports = {

    // Route one live row event (row:inserted / row:deleted) from the
    // subscription stream. Split from the socket handler so the buffering
    // decision is unit-testable; always invoked through _msgChain, so calls
    // are serialized against each other and against the drain-time flush.
    // Order matters: the schema fail-closed check runs first (a mismatched
    // row must freeze the watermark gate even mid-bootstrap and must never be
    // buffered for a later replay), then price_snapshots events are BUFFERED
    // while this connection's price bootstrap has not drained (#2422; see the
    // constructor note: applying them early holes the mirror under the
    // still-draining REST pull and every MAX()-based refresh would open the
    // height barrier over the hole), and only then does the normal
    // apply-and-refresh path run.
    async handleRowEvent(event) {
        if (event.schema_version != null && event.schema_version !== HUB_SCHEMA_VERSION) {
            // Schema-version mismatch: the hub is broadcasting a mirror row shape
            // this indexer was not built for, so applying it (or its retraction)
            // risks dropping a consensus-relevant column and forking the ledger.
            // Fail closed: do not apply, do not advance the watermark, so the
            // barrier stays shut and the block is deferred rather than settled
            // against mismatched mirror data. The != null guard keeps older hubs
            // that send no version working unchanged.
            getLogger().error('HubDbSync: hub schema_version ' + event.schema_version +
                ' != local ' + HUB_SCHEMA_VERSION + ' for ' + event.table +
                '; refusing to apply row. Restart this indexer after upgrading the hub.');
            // Freeze the watermark gate until a clean re-bootstrap, so a
            // following heartbeat cannot certify the stream as caught-up
            // while we are dropping rows we cannot apply.
            this._schemaMismatchSeen = true;
            return;
        }
        if (event.table === 'price_snapshots' && !this._priceDrained) {
            this.bufferPriceEvent(event);
            return;
        }
        if (event.type === 'row:inserted' && event.table && event.row) {
            // A live cross-chain row naming another chain is the one case where the mirror
            // may be the stale side: a consumer that learned its expectation FROM the hub
            // re-asks the hub once before refusing, so a venue re-genesis the hub has
            // adopted cannot strand a running DOGE/LTC mirror. A locally-measured
            // expectation is never adopted away from (see maybeAdoptHubChainId).
            await this.maybeAdoptHubChainId(event.table, event.row);
            await this.applyRow(event.table, event.row);
            this.reportRefusedChainRows(event.table);
            if (event.table === 'price_snapshots')     await this.refreshPriceSyncHeight();
            if (event.table === 'oracle_prices')       await this.refreshOracleSyncTimestamp();
            if (event.table === 'cross_chain_matches') await this.refreshMatchSyncTimestamp();
            if (event.table === 'cross_chain_calls')   await this.refreshCallSyncTimestamp();
            if (event.table === 'bridge_transfers')    await this.refreshBridgeSyncTimestamp();
            if (event.table === 'policy_snapshots')    await this.refreshPolicySyncTimestamp();
            if (CROSS_CHAIN_TABLES.indexOf(event.table) !== -1) await this.releaseSnapshotWaiters();
        } else if (event.type === 'row:deleted' && event.table) {
            await this.applyRetraction(event);
            if (event.table === 'price_snapshots')     await this.refreshPriceSyncHeight();
            if (event.table === 'oracle_prices')       await this.refreshOracleSyncTimestamp();
            if (event.table === 'cross_chain_matches') await this.refreshMatchSyncTimestamp();
            if (event.table === 'cross_chain_calls')   await this.refreshCallSyncTimestamp();
            // bridge_transfers refreshes inside applyRetraction (the only path that can
            // delete one), so it is deliberately not repeated here; policy_snapshots is
            // never retracted at all.
            if (event.table === 'cross_chain_matches' || event.table === 'cross_chain_calls') await this.releaseSnapshotWaiters();
        }
    },

    // Queue a live price_snapshots event for replay after the price bootstrap
    // drains (#2422). Inserts AND deletions buffer: replaying a fenced
    // retraction before the insert it retracts would no-op the delete and then
    // re-insert the retracted row, so arrival order is consensus-relevant. On
    // overflow the buffer is abandoned and flagged: the flush then reports the
    // table not-drained so bootstrapAll re-pages the dropped rows straight
    // from the hub (they are in its DB) instead of opening the gate over the
    // loss; dropped deletions are redelivered by the hub's deferred-retraction
    // path (item 5296), same as deletions missed while disconnected.
    bufferPriceEvent(event) {
        if (this._pendingPriceOverflow) return;
        if (this._pendingPriceEvents.length >= PENDING_PRICE_EVENT_CAP) {
            getLogger().error('HubDbSync: pending price_snapshots event buffer overflow (' +
                PENDING_PRICE_EVENT_CAP + '); discarding and forcing a re-drain');
            this._pendingPriceOverflow = true;
            this._pendingPriceEvents = [];
            return;
        }
        this._pendingPriceEvents.push(event);
    },

    // Replay the live price_snapshots events buffered during the bootstrap
    // drain, in arrival order. Returns true when every buffered event applied
    // (re-receives of rows the final drain pages already fetched are harmless:
    // the price upsert is idempotent). On a failure it stops AT the failed
    // event, keeping it and the tail buffered, and returns false so the caller
    // reports the table not-drained: local MAX(id) stays at the contiguous
    // drain frontier, the retry re-fetches the failed row over REST, and a
    // persistently bad row wedges the barrier (defer) rather than silently
    // forking, the module's fail-closed contract (BOOTSTRAP-HOLE-1).
    async flushPendingPriceEvents() {
        if (this._pendingPriceOverflow) {
            this._pendingPriceOverflow = false;
            this._pendingPriceEvents = [];
            return false;
        }
        while (this._pendingPriceEvents.length > 0) {
            let event = this._pendingPriceEvents[0];
            try {
                if (event.type === 'row:inserted' && event.row) {
                    await this.applyRow('price_snapshots', event.row);
                } else if (event.type === 'row:deleted') {
                    await this.applyRetraction(event);
                }
            } catch (err) {
                getLogger().warn('HubDbSync: failed to replay buffered price_snapshots event:', err);
                // The event stays at the head of the buffer and the table reports
                // not-drained, but the watermark gate has its own key: latch here too so a
                // heartbeat arriving before the retry cannot certify coverage.
                this._applyFailureSeen = true;
                return false;
            }
            this._pendingPriceEvents.shift();
        }
        return true;
    },

};
