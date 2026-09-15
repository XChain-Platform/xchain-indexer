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
 * XChain Indexer - Hub DB Sync Client: capability-snapshot presence barrier
 *
 * The set-dependent barrier that holds a block until every in-scope match and
 * call has its cross_chain capability snapshot mirrored.
 *
 * Part of the hub-mirror client (src/hub/hub_db_sync.js), which installs the
 * methods here onto HubDbSync.prototype. Vendored byte-identical into
 * xchain-explorer by bin/sync-hub-mirror-client.sh: edit the xchain-indexer copy.
 *
 ********************************************************************/


module.exports = {

    // ── Cross-chain capability-snapshot presence barrier ───────────────────────
    // Companion to the match barrier. A match is only settleable once the cross_chain
    // capability snapshot at its snapshot_block has mirrored in (cross_settle verifies
    // the match's signatures against that snapshot. If it is absent, cross_settle would
    // skip the match while the block advances, so the match settles at whatever later
    // block the snapshot first appears locally, a per-operator-variable height that
    // diverges the ledger. This barrier defers the block (never advancing) until every
    // cross-chain match effective at/before this block's time, for this coin, has its
    // snapshot present), so all operators settle each match at the same height.
    //
    // Scope is PRESENCE only (≥1 snapshot row for the block). Deterministic quorum-N
    // under partial snapshot arrival is a separate, narrower concern sealed by the
    // multi-node design (see cross_settle's N-handling); in the happy path the hub
    // broadcasts the snapshot rows before the match row, so presence implies the set.

    // True when sync is disabled, or when every finalized match effective at/before
    // blockTime for this coin has its cross_chain snapshot mirrored locally. A query
    // error (table not ready) reads as NOT satisfied so the barrier waits rather than
    // letting a block settle against a missing snapshot.
    //
    // THE SCOPE FILTER MOVES WITH MEMBERS 4 AND 5, and that is not optional (C7). This barrier
    // is content-keyed, so it never stalls on a future stamp, but its "which rows are in
    // scope" filter is `effective_time <= t(B)`, the very predicate the admission era
    // replaces. Left on the clock while the match and call members bind by height, one node's
    // snapshot scope disagrees with its own match set, and a match settles at a height its
    // peers do not agree on: a FORK rather than a stall.
    //
    // The admission-era filter is the C33 form and never a bare comparison on a nullable
    // column: `(admit_block_<c> IS NULL AND effective_time <= ?) OR (admit_block_<c> IS NOT
    // NULL AND admit_block_<c> <= ?)`. A bare `admit_block_<c> <= ?` evaluates to NULL for
    // every legacy row, silently drops it from the scope, and is a silent consensus change;
    // this codebase carries the written case study of exactly that failure. The rule holds at
    // EVERY height, so a row finalized below the producer activation and a row whose map
    // simply does not name this chain both bind here exactly as they do today.
    async snapshotSyncSatisfied(blockTime, blockHeight = null) {
        if (!this.enabled) return true;
        blockTime = Number(blockTime);
        const admission = this.admissionActiveAt(blockHeight);
        if (!admission && !Number.isFinite(blockTime)) return true;
        if (admission && !Number.isFinite(Number(blockHeight))) return false;   // fail closed
        try {
            // The scope clause and its bindings, one per table alias. Below the activation
            // this is the byte-identical `effective_time <= ?` the barrier has always used.
            const scope = (alias) => admission
                ? '(' + alias + '.' + this.admitColumn() + ' IS NULL AND ' + alias + '.effective_time <= ?) OR (' +
                  alias + '.' + this.admitColumn() + ' IS NOT NULL AND ' + alias + '.' + this.admitColumn() + ' <= ?)'
                : alias + '.effective_time <= ?';
            const scopeArgs = admission ? [blockTime, Number(blockHeight)] : [blockTime];

            // Any finalized, in-scope match (for this coin) whose snapshot_block has no
            // mirrored cross_chain capability_snapshots row → not yet satisfied. coin is
            // optional: without it, fall back to a (safe) superset over all chains.
            let coinClause = this.coin ? 'AND (m.a_chain = ? OR m.b_chain = ?)' : '';
            let args = this.coin ? scopeArgs.concat([this.coin, this.coin]) : scopeArgs.slice();
            let missing = await this.hubDb.doQuery(
                "SELECT 1 FROM cross_chain_matches m " +
                "WHERE m.status = 'finalized' AND (" + scope('m') + ") " + coinClause + " " +
                "AND NOT EXISTS (SELECT 1 FROM capability_snapshots s " +
                "                WHERE s.snapshot_block = m.snapshot_block AND s.capability = 'cross_chain') " +
                "LIMIT 1", args);
            if (missing.length > 0) return false;
            // Same presence rule for XCALL relay rows this chain will act on
            // (dispatches targeting it + results it originated); xexec.js /
            // xcall.processResult verify signatures against these snapshots.
            let callClause = this.coin ? 'AND (c.target_chain = ? OR c.source_chain = ?)' : '';
            let callArgs = this.coin ? scopeArgs.concat([this.coin, this.coin]) : scopeArgs.slice();
            let missingCalls = await this.hubDb.doQuery(
                "SELECT 1 FROM cross_chain_calls c " +
                "WHERE c.status = 'finalized' AND (" + scope('c') + ") " + callClause + " " +
                "AND NOT EXISTS (SELECT 1 FROM capability_snapshots s " +
                "                WHERE s.snapshot_block = c.snapshot_block AND s.capability = 'cross_chain') " +
                "LIMIT 1", callArgs);
            return missingCalls.length === 0;
        } catch (e) {
            return false;                                      // table not ready → wait, don't advance
        }
    },

    // This chain's admission column on the mirrored cross-chain tables, `admit_block_<c>` in
    // the hub's own DDL spelling. Built from the coin rather than interpolated from anything
    // that reaches this process over the wire, exactly like RETRACTION_COLUMNS above: a column
    // name is never taken from a frame. The columns themselves arrive with the indexer's dated
    // admission migration; nothing reads them below the activation, which is every network in
    // this train.
    admitColumn() {
        const chain = this.admissionChain();
        return 'admit_block_' + (chain === null ? 'btc' : chain.toLowerCase());
    },

    async releaseSnapshotWaiters() {
        if (this._snapshotWaiters.length === 0) return;
        let stillWaiting = [];
        for (let w of this._snapshotWaiters) {
            if (await this.snapshotSyncSatisfied(w.ts, w.height)) {
                clearTimeout(w.timer);
                w.resolve(true);
            } else {
                stillWaiting.push(w);
            }
        }
        this._snapshotWaiters = stillWaiting;
    },

    // Block-processing barrier: resolves once every effective cross-chain match for this
    // coin has its capability snapshot mirrored. Rejects after timeoutMs so the caller
    // DEFERS the block (counter not advanced) and retries; never settling a match whose
    // snapshot is missing. Resolves immediately when sync is disabled or already satisfied.
    async waitForSnapshotSync(blockTime, timeoutMs, blockHeight = null) {
        blockTime = Number(blockTime);
        if (!this.enabled || !Number.isFinite(blockTime)) return true;
        if (await this.snapshotSyncSatisfied(blockTime, blockHeight)) return true;

        let ms = parseInt(timeoutMs);
        if (!Number.isFinite(ms) || ms <= 0) ms = 60000;
        return new Promise((resolve, reject) => {
            let waiter = { ts: blockTime, height: blockHeight, resolve: resolve, timer: null };
            waiter.timer = setTimeout(async () => {
                // Self-heal before giving up, same intent as the scalar barriers above.
                // Snapshot-presence is set-dependent (recomputed by a live query rather
                // than a cached scalar), but release is still event-driven: a snapshot
                // that mirrored in without firing a cross-chain event would leave this
                // waiter armed until the timeout. Re-evaluate against the mirror here;
                // releaseSnapshotWaiters resolves+clears this waiter if satisfied now.
                try { await this.releaseSnapshotWaiters(); } catch (e) { /* fall through to reject */ }
                if (await this.snapshotSyncSatisfied(blockTime, blockHeight)) return;   // already resolved by the refresh
                this._snapshotWaiters = this._snapshotWaiters.filter(w => w !== waiter);
                reject(new Error('snapshot sync barrier timed out after ' + ms + 'ms waiting for block_time ' +
                                 blockTime + ' (a cross-chain match is missing its capability snapshot)'));
            }, ms);
            this._snapshotWaiters.push(waiter);
        });
    },

};
