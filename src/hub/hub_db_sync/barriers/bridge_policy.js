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
 * XChain Indexer - Hub DB Sync Client: bridge and policy barriers
 *
 * The content-watermark barriers over bridge_transfers and policy_snapshots,
 * shaped like the match and call barriers with their own scope rules.
 *
 * Both tables are read only after the connected schema has been asked whether it
 * carries them: a consumer whose hub DB predates them would otherwise fail one
 * statement per refresh forever, silently, with its barrier shut either way.
 *
 * Part of the hub-mirror client (src/hub/hub_db_sync.js), which installs the
 * methods here onto HubDbSync.prototype. Vendored byte-identical into
 * xchain-explorer by bin/sync-hub-mirror-client.sh: edit the xchain-indexer copy.
 *
 ********************************************************************/

const { strictHubRead } = require('../mirror_write.js');
const { mirrorTablePresent, noteWatermarkReadFailure } = require('./mirror_table_probe.js');
const { RELAY_MIN_FUTURE_S, RELAY_MAX_FUTURE_S } = require('./relay_margin.js');

// How far apart the stamps of two honest snapshots can sit when the later-signed one is
// stamped EARLIER. A snapshot's effective_time is the proposing leader's clock at proposal
// plus the largest relay floor over the tick's copies (xchain-hub src/cross_chain/bridge/
// policy_poll.js), and the only bound every honest row meets is the follower window: each
// co-signer holds the stamp between RELAY_MIN_FUTURE_S and RELAY_MAX_FUTURE_S ahead of its own
// clock when it signs. Rounds for different ticks run concurrently under their own leaders, so
// one signed a moment after another can be stamped up to RELAY_MAX_FUTURE_S - RELAY_MIN_FUTURE_S
// (3540 s) before it, whatever the margin table says.
const POLICY_STAMP_SPREAD_S = RELAY_MAX_FUTURE_S - RELAY_MIN_FUTURE_S;

// The mirror tables this file reads a watermark from. Named as data because the
// probe (mirror_table_probe.js) asks information_schema for exactly these names: a consumer schema
// carries them only once the bridge tables have been created in it.
const BRIDGE_TABLE = 'bridge_transfers';
const POLICY_TABLE = 'policy_snapshots';
const LIST_SHARE_TABLE = 'list_snapshots';

module.exports = {

    // ── XBRIDGE transfer sync barrier (mirrors the match/call barriers exactly) ──

    async refreshBridgeSyncTimestamp(armBootstrap = this._bootstrapDrained) {
        let ts = null, destTsValue = null;
        // Ask the schema for the table before naming it: on a consumer whose hub DB was
        // never given the bridge mirror tables, the statement below is error 1146 every
        // time this runs, swallowed, and the operator is told nothing at all.
        if (!await mirrorTablePresent(this, BRIDGE_TABLE)) return;
        try {
            // Scope the watermark to transfers that touch THIS coin on either leg, the same
            // rule the match and call barriers apply and for the same reason: the hub
            // broadcasts every finalized transfer to every mirror, so a global
            // MAX(effective_time) could be bumped past this block's time by a transfer
            // between two other chains. The barrier would then open before every transfer
            // this chain must apply at that block is local, and two operators of this chain
            // would mint the same bridged credit at divergent blocks and fork.
            //
            // Both legs are scoped, not just dest_chain: the source chain reads its own
            // escrow and burn state out of the same mirror for the invariant, and an
            // out-leg's source is named by src_chain.
            //
            // The second aggregate is the content shortcut's own watermark, scoped to
            // dest_chain alone. A transfer's effective_time is the hub's clock at
            // finalization plus relayMarginFloorS(dest_chain) (BTC 2400 s, LTC 600 s,
            // DOGE 240 s), so only rows sharing one destination share one margin and grow
            // in finalization order. A DOGE -> BTC out-leg finalized first can carry a
            // later effective_time than an LTC -> DOGE in-leg finalized after it, so a
            // MAX over both legs proves nothing about the in-legs this chain mints
            // (getFinalizedBridgeTransfersForChain reads dest_chain = this chain only).
            // Without a coin (the explorer's display mirror) the unscoped MAX stands.
            let where = "WHERE status = 'finalized'";
            let args  = [];
            let select = 'SELECT MAX(effective_time) AS ts';
            if (this.coin) {
                where += " AND (src_chain = ? OR dest_chain = ?)";
                select += ', MAX(CASE WHEN dest_chain = ? THEN effective_time END) AS dest_ts';
                args = [this.coin, this.coin, this.coin];
            }
            let rows = await strictHubRead(this.hubDb, select + " FROM bridge_transfers " + where, args);
            if (rows.length > 0 && rows[0].ts !== null && rows[0].ts !== undefined) ts = Number(rows[0].ts);
            if (rows.length > 0 && rows[0].dest_ts !== null && rows[0].dest_ts !== undefined) destTsValue = Number(rows[0].dest_ts);
        } catch (e) {
            noteWatermarkReadFailure(this, BRIDGE_TABLE, e);     // barrier stays closed
            return;
        }
        this.bridgeSyncTimestamp = ts;
        this.bridgeDestSyncTimestamp = this.coin ? destTsValue : ts;
        // Arm only under a full bootstrap drain; reconnect / live-row refreshes default
        // armBootstrap to _bootstrapDrained so they cannot arm the NULL fast path from a
        // holed mirror and fork (#1788).
        if (armBootstrap) this.bridgeBootstrapped = true;
        this.releaseBridgeWaiters();
    },

    // ADMISSION ERA: the bridge_transfers height watermark for this chain has reached B - 4,
    // replacing both clock cases exactly as the match and call members above.
    //
    // The empty-mirror fast path also needs a drained connection. bridgeBootstrapped
    // survives a socket close (resetOnSocketClose clears _bootstrapDrained, not this
    // flag), and an empty scope proves nothing about a transfer finalized while the socket
    // was down, so the path waits for the re-drain like the heartbeat gate does.
    //
    // The content shortcut reads bridgeDestSyncTimestamp, the newest in-leg alone (see
    // refreshBridgeSyncTimestamp): in-legs share this chain's margin, so an in-leg
    // effective at or past this block's time proves every in-leg finalized before it is
    // local and every one finalized after it is effective no earlier. The stream escape
    // below needs no scoping, because a frozen or live watermark only vouches for rows
    // finalized before it.
    bridgeSyncSatisfied(blockTime, blockHeight = null) {
        const certified = this.bridgeBootstrapped &&
            this.tableCertifiedOnCurrentConnection('bridge_transfers');
        if (!certified) return false;
        if (this.bridgeSyncTimestamp === null) return true;
        if (this.admissionActiveAt(blockHeight))
            return this.heightSatisfied('bridge_transfers', blockHeight);
        if (this.bridgeDestSyncTimestamp !== null && this.bridgeDestSyncTimestamp !== undefined &&
            this.bridgeDestSyncTimestamp >= blockTime) return true;
        // Stream watermark escape: a transfer is broadcast the moment the hub finalizes it,
        // and its effective_time is stamped FORWARD (now + the destination's relay margin
        // floor), so a watermark past this block's time plus the grace means every transfer
        // effective at or before it is already local. Without this the FIRST bridge transfer
        // anywhere would freeze every replica until the next one arrived (the #1984 class).
        //
        // Uses bridgeWatermarkGraceS, never the match or call grace: the bridge engine is a
        // third producer with its own stamping rule, and sharing a grace is the documented
        // mistake the call barrier was split out to end.
        if (this.tableWatermark('bridge_transfers') >=
            blockTime + this.bridgeWatermarkGraceS) return true;
        return false;
    },

    releaseBridgeWaiters() {
        if (this._bridgeWaiters.length === 0) return;
        let stillWaiting = [];
        for (let w of this._bridgeWaiters) {
            if (this.bridgeSyncSatisfied(w.ts, w.height)) {
                clearTimeout(w.timer);
                w.resolve(this.bridgeSyncTimestamp);
            } else {
                stillWaiting.push(w);
            }
        }
        this._bridgeWaiters = stillWaiting;
    },

    // Block-processing barrier for the XBRIDGE settle pass. Resolves once the local
    // bridge_transfers copy holds every transfer effective at or before this block's time,
    // so every operator of this chain mints the same bridged credits at the same block.
    // Rejects after timeoutMs so the caller can DEFER the block and retry; never mint
    // against a stale transfer mirror.
    waitForBridgeSync(blockTime, timeoutMs, blockHeight = null) {
        blockTime = Number(blockTime);
        if (!this.enabled || !Number.isFinite(blockTime)) return Promise.resolve(this.bridgeSyncTimestamp);
        if (this.bridgeSyncSatisfied(blockTime, blockHeight)) return Promise.resolve(this.bridgeSyncTimestamp);

        let ms = parseInt(timeoutMs);
        if (!Number.isFinite(ms) || ms <= 0) ms = 60000;
        return new Promise((resolve, reject) => {
            let waiter = { ts: blockTime, height: blockHeight, resolve: resolve, timer: null };
            waiter.timer = setTimeout(async () => {
                // Self-heal before giving up, same as the match and call barriers: a missed
                // refresh on a stream/reconnect edge can leave bridgeSyncTimestamp stale
                // behind a mirror that is actually current. refreshBridgeSyncTimestamp
                // resolves and clears this waiter via releaseBridgeWaiters if so.
                try { await this.refreshBridgeSyncTimestamp(); } catch (e) { /* fall through to reject */ }
                if (this.bridgeSyncSatisfied(blockTime, blockHeight)) return;  // already resolved by the refresh
                this._bridgeWaiters = this._bridgeWaiters.filter(w => w !== waiter);
                // Above the activation only the admission height gates the barrier, so the
                // clock watermark would read as a frozen mirror and is left out.
                const waiting = 'bridge sync barrier timed out after ' + ms + 'ms';
                reject(new Error(this.admissionActiveAt(blockHeight)
                    ? waiting + this.heightTail('bridge_transfers', blockHeight)
                    : waiting + ' waiting for block_time ' + blockTime +
                      ' (bridge mirror at ' + this.bridgeSyncTimestamp + ')'));
            }, ms);
            this._bridgeWaiters.push(waiter);
        });
    },

    // ── XPOLICY snapshot sync barrier (the bridge barrier, keyed on origin_chain) ──

    async refreshPolicySyncTimestamp(armBootstrap = this._bootstrapDrained) {
        let ts = null;
        // Same schema probe as the bridge barrier above, and for the same reason: the
        // policy table ships in the same migration, so a schema missing one is missing both.
        if (!await mirrorTablePresent(this, POLICY_TABLE)) return;
        try {
            // Scoped on origin_chain ALONE, and that is the one place this barrier departs
            // from the bridge barrier above. A policy snapshot names no destination: it is
            // the origin issuer's membership lists, and every chain holding a copy of the
            // tick applies it. There is therefore no dest_chain to scope by, and the only
            // rows this chain can ignore are the ones it originates itself (it already holds
            // that policy natively, from the local LIST/ISSUE/SLEEP actions, and re-applying
            // a mirrored copy of its own state would inject actions on the origin chain).
            let where = "WHERE status = 'finalized'";
            let args  = [];
            if (this.coin) { where += " AND origin_chain <> ?"; args = [this.coin]; }
            let rows = await strictHubRead(this.hubDb,
                "SELECT MAX(effective_time) AS ts FROM policy_snapshots " + where, args);
            if (rows.length > 0 && rows[0].ts !== null) ts = Number(rows[0].ts);
        } catch (e) {
            noteWatermarkReadFailure(this, POLICY_TABLE, e);     // barrier stays closed
            return;
        }
        this.policySyncTimestamp = ts;
        this.policyCoveredTimestamp = this.policyContentCoverage(ts);
        if (armBootstrap) this.policyBootstrapped = true;
        this.releasePolicyWaiters();
    },

    // The block time through which every snapshot this chain reads is local, or null when
    // nothing vouches for it. The newest local stamp was signed while every co-signer's clock
    // read at least that stamp minus RELAY_MAX_FUTURE_S, and a snapshot signed after it was
    // stamped at least RELAY_MIN_FUTURE_S past a later clock reading, so a snapshot still
    // missing is effective no earlier than MAX(effective_time) - POLICY_STAMP_SPREAD_S. The raw
    // MAX alone vouches for much less: a snapshot whose copies sit on BTC is stamped 2400 s
    // ahead and one whose copies sit on DOGE 240 s ahead, on different leaders' clocks.
    //
    // This assumes the local rows arrived in the order the hub signed them. Time a round spends
    // between its signatures and the hub's write, and time a written row spends reaching this
    // mirror, has no protocol bound; the stream escape below and the bridge barrier rest on the
    // same assumption.
    // Without a coin (the explorer's display mirror) the unscoped MAX stands.
    policyContentCoverage(ts) {
        if (!this.coin) return ts;
        if (ts === null || ts === undefined) return null;
        return ts - POLICY_STAMP_SPREAD_S;
    },

    // ADMISSION ERA: the policy_snapshots height watermark for this chain has reached B - 4.
    // This is the rail where the per-chain MAP matters most: a policy snapshot's read scope is
    // EVERY chain with no clause at all, so its map must name every chain the federation
    // serves, and a chain the map omits binds by the legacy rule on this rail rather than
    // being admitted by somebody else's height.
    //
    // The empty-mirror fast path and the content shortcut both need a drained connection.
    // policyBootstrapped survives a socket close (resetOnSocketClose clears _bootstrapDrained,
    // not this flag), and neither an empty scope nor a mirrored stamp proves anything about a
    // snapshot finalized while the socket was down, so both wait for the re-drain.
    //
    // The content shortcut reads policyCoveredTimestamp (see policyContentCoverage), never
    // the raw MAX: snapshot stamps come from different leaders' clocks plus different margins,
    // so the newest stamp vouches only for snapshots due at least the stamp spread before it.
    // Holding longer than the raw MAX
    // would is safe, because a barrier decides only WHEN a block runs and never what it
    // applies, and the stream escape below still opens every block on a live connection.
    policySyncSatisfied(blockTime, blockHeight = null) {
        const certified = this.policyBootstrapped &&
            this.tableCertifiedOnCurrentConnection('policy_snapshots');
        if (certified && this.policySyncTimestamp === null) return true;
        if (this.admissionActiveAt(blockHeight))
            return certified && this.heightSatisfied('policy_snapshots', blockHeight);
        if (certified &&
            this.policyCoveredTimestamp !== null && this.policyCoveredTimestamp !== undefined &&
            this.policyCoveredTimestamp >= blockTime) return true;
        // Stream watermark escape: a snapshot is broadcast once the hub writes it and is
        // stamped at least RELAY_MIN_FUTURE_S ahead of its signers' clocks, so a watermark past this
        // block's time plus the grace means every snapshot effective at or before it is
        // already local. This is what opens a block on a healthy node when no recent stamp
        // covers it, and what keeps a quiet table from freezing the tip.
        if (certified && this.tableWatermark('policy_snapshots') >=
            blockTime + this.policyWatermarkGraceS) return true;
        return false;
    },

    releasePolicyWaiters() {
        if (this._policyWaiters.length === 0) return;
        let stillWaiting = [];
        for (let w of this._policyWaiters) {
            if (this.policySyncSatisfied(w.ts, w.height)) {
                clearTimeout(w.timer);
                w.resolve(this.policySyncTimestamp);
            } else {
                stillWaiting.push(w);
            }
        }
        this._policyWaiters = stillWaiting;
    },

    // Block-processing barrier for the policy-snapshot apply pass. Resolves once the local
    // policy_snapshots copy holds every snapshot effective at or before this block's time,
    // so every operator of this chain materializes the same membership at the same block.
    // Rejects after timeoutMs so the caller can DEFER the block and retry; never materialize
    // a token policy against a stale snapshot mirror.
    waitForPolicySync(blockTime, timeoutMs, blockHeight = null) {
        blockTime = Number(blockTime);
        if (!this.enabled || !Number.isFinite(blockTime)) return Promise.resolve(this.policySyncTimestamp);
        if (this.policySyncSatisfied(blockTime, blockHeight)) return Promise.resolve(this.policySyncTimestamp);

        let ms = parseInt(timeoutMs);
        if (!Number.isFinite(ms) || ms <= 0) ms = 60000;
        return new Promise((resolve, reject) => {
            let waiter = { ts: blockTime, height: blockHeight, resolve: resolve, timer: null };
            waiter.timer = setTimeout(async () => {
                try { await this.refreshPolicySyncTimestamp(); } catch (e) { /* fall through to reject */ }
                if (this.policySyncSatisfied(blockTime, blockHeight)) return;  // already resolved by the refresh
                this._policyWaiters = this._policyWaiters.filter(w => w !== waiter);
                // Above the activation only the admission height gates the barrier, so the
                // clock watermark would read as a frozen mirror and is left out.
                const waiting = 'policy sync barrier timed out after ' + ms + 'ms';
                reject(new Error(this.admissionActiveAt(blockHeight)
                    ? waiting + this.heightTail('policy_snapshots', blockHeight)
                    : waiting + ' waiting for block_time ' + blockTime +
                      ' (policy mirror at ' + this.policySyncTimestamp + ')'));
            }, ms);
            this._policyWaiters.push(waiter);
        });
    },

    async refreshListShareSyncState(armBootstrap = this._bootstrapDrained) {
        if (!await mirrorTablePresent(this, LIST_SHARE_TABLE)) return;
        try {
            let rows = await strictHubRead(this.hubDb, "SELECT 1 FROM list_snapshots LIMIT 1");
            this.listShareMirrorEmpty = rows.length === 0;
        } catch (e) {
            noteWatermarkReadFailure(this, LIST_SHARE_TABLE, e);
            return;
        }
        if (armBootstrap) this.listShareBootstrapped = true;
        this.releaseListShareWaiters();
    },

    // The empty-mirror fast path needs a drained connection, as at the bridge and policy
    // barriers: listShareBootstrapped survives a socket close, and an empty table proves
    // nothing about a first list version written while the socket was down.
    listShareSyncSatisfied(blockHeight) {
        const certified = this.listShareBootstrapped &&
            this.tableCertifiedOnCurrentConnection(LIST_SHARE_TABLE);
        if (certified && this.listShareMirrorEmpty) return true;
        return certified && this.heightSatisfied(LIST_SHARE_TABLE, blockHeight);
    },

    releaseListShareWaiters() {
        if (this._listShareWaiters.length === 0) return;
        let stillWaiting = [];
        for (let w of this._listShareWaiters) {
            if (this.listShareSyncSatisfied(w.height)) {
                clearTimeout(w.timer);
                w.resolve(true);
            } else {
                stillWaiting.push(w);
            }
        }
        this._listShareWaiters = stillWaiting;
    },

    waitForListShareSync(timeoutMs, blockHeight) {
        blockHeight = Number(blockHeight);
        if (!this.enabled || !Number.isFinite(blockHeight)) return Promise.resolve(true);
        if (this.listShareSyncSatisfied(blockHeight)) return Promise.resolve(true);

        let ms = parseInt(timeoutMs);
        if (!Number.isFinite(ms) || ms <= 0) ms = 60000;
        return new Promise((resolve, reject) => {
            let waiter = { height: blockHeight, resolve: resolve, timer: null };
            waiter.timer = setTimeout(async () => {
                try { await this.refreshListShareSyncState(); } catch (e) { /* fall through to reject */ }
                if (this.listShareSyncSatisfied(blockHeight)) return;
                this._listShareWaiters = this._listShareWaiters.filter(w => w !== waiter);
                reject(new Error('list share sync barrier timed out after ' + ms +
                                 'ms waiting for block_height ' + blockHeight +
                                 this.heightTail(LIST_SHARE_TABLE, blockHeight)));
            }, ms);
            this._listShareWaiters.push(waiter);
        });
    },

};
