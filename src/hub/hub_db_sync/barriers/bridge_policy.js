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

const { getLogger } = require('../../../observability/index.js');

// The two mirror tables this file reads a watermark from. Named as data because the
// probe below asks information_schema for exactly these names: a consumer schema
// carries them only once the bridge tables have been created in it.
const BRIDGE_TABLE = 'bridge_transfers';
const POLICY_TABLE = 'policy_snapshots';

// How long a NEGATIVE table probe is trusted. A positive answer is kept for the life
// of the process (a mirror table cannot vanish from under a running client), a
// negative one expires so that creating the table heals the barrier by itself rather
// than needing the consumer restarted.
const MIRROR_TABLE_PROBE_TTL_MS = 60000;

// MariaDB error 1146 (ER_NO_SUCH_TABLE), matched on the numeric errno as well as the
// name because the two spellings come from different layers of the driver and only
// the number is stable.
function isMissingTableError(err) {
    const cause = (err && err.cause) ? err.cause : err;
    return Number(cause && cause.errno) === 1146 || (cause && cause.code) === 'ER_NO_SUCH_TABLE';
}

// Report a mirror table the consumer's schema does not carry, and remember it, so the
// next refresh skips a statement that cannot work. Reported, not swallowed: a barrier
// held shut by a table nobody created is indistinguishable from a mirror that is merely
// behind, and only this line separates them.
function noteMirrorTableAbsent(sync, table) {
    if (!sync._mirrorTableMemo) sync._mirrorTableMemo = {};
    sync._mirrorTableMemo[table] = { present: false, at: Date.now() };
    getLogger().warn('HubDbSync: this schema has no ' + table + ' table, so its sync barrier stays ' +
                     'closed and every block needing it will defer; create the bridge mirror tables ' +
                     'in the hub DB this consumer reads');
}

// Whether the connected schema carries `table`, memoized on the instance rather than
// asked per refresh: the refreshes run on every mirrored row, and the answer only
// changes when somebody creates the table. DATABASE() rather than a configured name,
// so the answer is about the schema the read itself lands in.
//
// A probe that ITSELF fails answers true, which is the behaviour before this guard
// existed: the caller's catch below is the net, so a broken probe costs one failed
// statement and never a barrier that opens on a watermark it did not read.
async function mirrorTablePresent(sync, table) {
    if (!sync._mirrorTableMemo) sync._mirrorTableMemo = {};
    let memo = sync._mirrorTableMemo[table];
    if (memo && (memo.present || (Date.now() - memo.at) < MIRROR_TABLE_PROBE_TTL_MS)) return memo.present;
    let rows;
    try {
        rows = await sync.hubDb.doQuery(
            "SELECT TABLE_NAME FROM information_schema.TABLES " +
            "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", [table]);
    } catch (e) {
        return true;
    }
    if (rows.length > 0) {
        sync._mirrorTableMemo[table] = { present: true, at: Date.now() };
        return true;
    }
    noteMirrorTableAbsent(sync, table);
    return false;
}

// Why a watermark read failed, said out loud. A missing table is the pre-migration
// schema, and the memo makes the next refresh skip the statement; anything else is a
// real fault, and a barrier held shut by a broken connection or a lost grant is worth
// exactly one log line per refresh rather than silence.
function noteWatermarkReadFailure(sync, table, err) {
    if (isMissingTableError(err)) { noteMirrorTableAbsent(sync, table); return; }
    getLogger().warn('HubDbSync: could not read the ' + table + ' watermark, so its sync barrier ' +
                     'stays closed: ' + (err && err.message));
}

module.exports = {

    // ── XBRIDGE transfer sync barrier (mirrors the match/call barriers exactly) ──

    async refreshBridgeSyncTimestamp(armBootstrap = this._bootstrapDrained) {
        let ts = null;
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
            let where = "WHERE status = 'finalized'";
            let args  = [];
            if (this.coin) { where += " AND (src_chain = ? OR dest_chain = ?)"; args = [this.coin, this.coin]; }
            let rows = await this.hubDb.doQuery(
                "SELECT MAX(effective_time) AS ts FROM bridge_transfers " + where, args);
            if (rows.length > 0 && rows[0].ts !== null) ts = Number(rows[0].ts);
        } catch (e) {
            noteWatermarkReadFailure(this, BRIDGE_TABLE, e);     // barrier stays closed
            return;
        }
        this.bridgeSyncTimestamp = ts;
        // Arm only under a full bootstrap drain; reconnect / live-row refreshes default
        // armBootstrap to _bootstrapDrained so they cannot arm the NULL fast path from a
        // holed mirror and fork (#1788).
        if (armBootstrap) this.bridgeBootstrapped = true;
        this.releaseBridgeWaiters();
    },

    // ADMISSION ERA: the bridge_transfers height watermark for this chain has reached B - 4,
    // replacing both clock cases exactly as the match and call members above.
    bridgeSyncSatisfied(blockTime, blockHeight = null) {
        if (this.bridgeBootstrapped && this.bridgeSyncTimestamp === null) return true;
        if (this.admissionActiveAt(blockHeight))
            return this.bridgeBootstrapped && this.heightSatisfied('bridge_transfers', blockHeight);
        if (this.bridgeSyncTimestamp !== null && this.bridgeSyncTimestamp >= blockTime) return true;
        // Stream watermark escape: a transfer is broadcast the moment the hub finalizes it,
        // and its effective_time is stamped FORWARD (now + the destination's relay margin
        // floor), so a watermark past this block's time plus the grace means every transfer
        // effective at or before it is already local. Without this the FIRST bridge transfer
        // anywhere would freeze every replica until the next one arrived (the #1984 class).
        //
        // Uses bridgeWatermarkGraceS, never the match or call grace: the bridge engine is a
        // third producer with its own stamping rule, and sharing a grace is the documented
        // mistake the call barrier was split out to end.
        if (this.bridgeBootstrapped && this.streamWatermark >= blockTime + this.bridgeWatermarkGraceS) return true;
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
                reject(new Error('bridge sync barrier timed out after ' + ms + 'ms waiting for block_time ' +
                                 blockTime + ' (bridge mirror at ' + this.bridgeSyncTimestamp + ')' +
                                 (this.admissionActiveAt(blockHeight)
                                     ? this.heightTail('bridge_transfers', blockHeight) : '')));
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
            let rows = await this.hubDb.doQuery(
                "SELECT MAX(effective_time) AS ts FROM policy_snapshots " + where, args);
            if (rows.length > 0 && rows[0].ts !== null) ts = Number(rows[0].ts);
        } catch (e) {
            noteWatermarkReadFailure(this, POLICY_TABLE, e);     // barrier stays closed
            return;
        }
        this.policySyncTimestamp = ts;
        if (armBootstrap) this.policyBootstrapped = true;
        this.releasePolicyWaiters();
    },

    // ADMISSION ERA: the policy_snapshots height watermark for this chain has reached B - 4.
    // This is the rail where the per-chain MAP matters most: a policy snapshot's read scope is
    // EVERY chain with no clause at all, so its map must name every chain the federation
    // serves, and a chain the map omits binds by the legacy rule on this rail rather than
    // being admitted by somebody else's height.
    policySyncSatisfied(blockTime, blockHeight = null) {
        if (this.policyBootstrapped && this.policySyncTimestamp === null) return true;
        if (this.admissionActiveAt(blockHeight))
            return this.policyBootstrapped && this.heightSatisfied('policy_snapshots', blockHeight);
        if (this.policySyncTimestamp !== null && this.policySyncTimestamp >= blockTime) return true;
        // Stream watermark escape, exactly as above. Note the cached scalar is a MAX over a
        // column that is NOT monotonic across policy_seq: a later seq can carry an EARLIER
        // effective_time, because the stamp is the max relay floor over the chains holding
        // copies and that set changes. That is safe here and is why the ordering rule lives
        // in the apply pass instead: this barrier only ever answers "has the mirror been
        // told everything effective by now", and a seq whose stamp is earlier than one
        // already mirrored is, by that question, already covered.
        if (this.policyBootstrapped && this.streamWatermark >= blockTime + this.policyWatermarkGraceS) return true;
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
                reject(new Error('policy sync barrier timed out after ' + ms + 'ms waiting for block_time ' +
                                 blockTime + ' (policy mirror at ' + this.policySyncTimestamp + ')' +
                                 (this.admissionActiveAt(blockHeight)
                                     ? this.heightTail('policy_snapshots', blockHeight) : '')));
            }, ms);
            this._policyWaiters.push(waiter);
        });
    },

};
