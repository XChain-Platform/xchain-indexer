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
 * XChain Indexer - Hub DB Sync Client: capability proof hold barrier
 *
 * Rows whose checkpoint proof is temporarily unavailable stay outside the
 * mirror until a retry can judge them. The block loop waits on this set before
 * checking snapshot presence, so it never reads an absent partial snapshot.
 *
 * Part of the hub-mirror client (src/hub/hub_db_sync.js), which installs the
 * methods here onto HubDbSync.prototype. Vendored byte-identical into
 * xchain-explorer by bin/sync-hub-mirror-client.sh: edit the xchain-indexer copy.
 *
 ********************************************************************/

const { getLogger } = require('../../../observability/index.js');
const { CAPABILITY_SNAPSHOT_KEY_CAP, capabilitySnapshotKey } = require('../mirror_bounds.js');

const CAPABILITY_PROOF_RETRY_MS = 15000;
const CAPABILITY_PROOF_REQUEST_INTERVAL_MS = 110;

module.exports = {

    // Spaces this client's proof GETs. The hub's shared budget bounds what all of its
    // clients together send the BTC indexer; this keeps one client from queueing a
    // burst at the hub. The wait is re-read after each sleep because a 429 that lands
    // meanwhile (deferCapabilityProofRequests) moves it later.
    async paceCapabilityProofRequest() {
        let previous = this._capabilityProofPaceChain || Promise.resolve();
        let turn = previous.then(async () => {
            for (;;) {
                let earliest = Number(this._capabilityProofNextRequestAt) || 0;
                let delay = Math.max(0, earliest - Date.now());
                if (delay <= 0) break;
                await new Promise(resolve => setTimeout(resolve, delay));
            }
            this._capabilityProofNextRequestAt = Date.now() + CAPABILITY_PROOF_REQUEST_INTERVAL_MS;
        });
        this._capabilityProofPaceChain = turn.catch(() => {});
        return turn;
    },

    // A hub 429 carries the Retry-After its budget, or the BTC indexer behind it, asked
    // for: hold every later proof GET from this client until then instead of retrying
    // into the refusal. Any other failure leaves the pacing as it was.
    deferCapabilityProofRequests(error) {
        if (!error || Number(error.statusCode) !== 429) return;
        let retryAfterMs = Number(error.retryAfterMs);
        if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return;
        this._capabilityProofNextRequestAt = Math.max(
            Number(this._capabilityProofNextRequestAt) || 0, Date.now() + retryAfterMs);
    },

    // The judge for one served row, skipped when the local mirror already holds the row's
    // natural key. capability_snapshots lands by plain INSERT IGNORE on that key, so a row
    // already mirrored writes nothing whatever its proof says, and no verdict deletes a
    // local row: re-proving it cannot change the mirror and could only hold a row that is
    // present. Every restart, failover and owed re-page serves the whole table from id 0
    // (see resolveDrainCursor), and on a chain that proves rows through the hub each judge
    // is one paced proof GET, so re-proving an intact mirror blocked parsing about 22 min.
    // A key the mirror lacks (a fresh or rolled-back local DB) is judged exactly as before.
    async judgeUnmirroredCapabilityRow(db, row, fetchProof) {
        if (await this.capabilitySnapshotMirrored(row))
            return { verdict: 'mirrored', reason: 'the local mirror already holds this key' };
        return db.verifyCapabilitySnapshotRow(row, { fetchProof: fetchProof });
    },

    // True only when a local row reads back with this row's own natural key. doQuery
    // reports a failed read as no rows, so any doubt leaves the row to the judge.
    async capabilitySnapshotMirrored(row) {
        let rows = await this.hubDb.doQuery(
            'SELECT snapshot_block, capability, signing_pubkey, source FROM capability_snapshots ' +
            'WHERE snapshot_block = ? AND capability = ? AND signing_pubkey = ? AND source = ? LIMIT 1',
            [row.snapshot_block, row.capability, row.signing_pubkey, row.source == null ? '' : row.source]);
        let key = capabilitySnapshotKey(row);
        return Array.isArray(rows) && rows.some(local => local && capabilitySnapshotKey(local) === key);
    },

    capabilityProofSatisfied() {
        return !this.enabled || (this._capabilityProofHolds.size === 0 && !this._capabilityProofOverflow);
    },

    capabilityProofWaiterSatisfied(waiter) {
        if (!this.enabled) return true;
        if (!waiter || !(waiter.holds instanceof Set)) return this.capabilityProofSatisfied();
        for (let key of waiter.holds) {
            if (this._capabilityProofHolds.has(key)) return false;
        }
        return !waiter.overflow || !this._capabilityProofOverflow;
    },

    waitForCapabilityProof(timeoutMs) {
        if (this.capabilityProofSatisfied()) return Promise.resolve(true);
        let ms = parseInt(timeoutMs);
        if (!Number.isFinite(ms) || ms <= 0) ms = 60000;
        return new Promise((resolve, reject) => {
            let waiter = {
                resolve: resolve,
                timer: null,
                holds: new Set(this._capabilityProofHolds.keys()),
                overflow: this._capabilityProofOverflow
            };
            waiter.timer = setTimeout(() => {
                this.releaseCapabilityProofWaiters();
                if (this._capabilityProofWaiters.indexOf(waiter) === -1) return;
                this._capabilityProofWaiters = this._capabilityProofWaiters.filter(w => w !== waiter);
                let held = Array.from(waiter.holds).filter(key => this._capabilityProofHolds.has(key)).length;
                reject(new Error('capability proof barrier timed out after ' + ms + 'ms with ' +
                    held + ' observed row(s) held' +
                    (waiter.overflow && this._capabilityProofOverflow ? ' and a re-page pending' : '')));
            }, ms);
            this._capabilityProofWaiters.push(waiter);
        });
    },

    releaseCapabilityProofWaiters() {
        let waiting = [];
        for (let waiter of this._capabilityProofWaiters) {
            if (!this.capabilityProofWaiterSatisfied(waiter)) {
                waiting.push(waiter);
                continue;
            }
            clearTimeout(waiter.timer);
            waiter.resolve(true);
        }
        this._capabilityProofWaiters = waiting;
    },

    holdCapabilitySnapshot(row) {
        let key = capabilitySnapshotKey(row);
        if (this._capabilityProofHolds.has(key)) this._capabilityProofHolds.set(key, Object.assign({}, row));
        else if (this._capabilityProofHolds.size < CAPABILITY_SNAPSHOT_KEY_CAP) {
            this._capabilityProofHolds.set(key, Object.assign({}, row));
        } else if (!this._capabilityProofHoldCapNoted) {
            this._capabilityProofHoldCapNoted = true;
            getLogger().warn('HubDbSync: capability proof hold map reached its ' +
                CAPABILITY_SNAPSHOT_KEY_CAP + '-row cap; additional rows will wait for the next re-page');
        }
        if (!this._capabilityProofHolds.has(key)) this._capabilityProofOverflow = true;
        this.markRepageOwed(['capability_snapshots']);
        this.scheduleCapabilityProofRetry();
    },

    scheduleCapabilityProofRetry() {
        if ((this._capabilityProofHolds.size === 0 && !this._capabilityProofOverflow) ||
            this._capabilityProofRetryTimer !== null) return;
        this._capabilityProofRetryTimer = setTimeout(() => {
            this._capabilityProofRetryTimer = null;
            this.retryHeldCapabilityRows().catch(err => {
                getLogger().warn('HubDbSync: capability proof retry failed:', err);
                this.scheduleCapabilityProofRetry();
            });
        }, CAPABILITY_PROOF_RETRY_MS);
        if (this._capabilityProofRetryTimer.unref) this._capabilityProofRetryTimer.unref();
    },

    async retryHeldCapabilityRows() {
        if (this._capabilityProofRetrying) return;
        this._capabilityProofRetrying = true;
        if (this._capabilityProofRetryTimer !== null) {
            clearTimeout(this._capabilityProofRetryTimer);
            this._capabilityProofRetryTimer = null;
        }
        let held = Array.from(this._capabilityProofHolds.entries());
        let proofPubkeys = new Map();
        for (let [, row] of held) {
            let group = String(row.snapshot_block) + '\u0000' + String(row.capability);
            if (!proofPubkeys.has(group)) proofPubkeys.set(group, new Set());
            proofPubkeys.get(group).add(String(row.signing_pubkey));
        }
        let proofFetches = new Map();
        let fetchProof = (snapshotBlock, capability, pubkeys) => {
            let key = String(snapshotBlock) + '\u0000' + String(capability);
            if (!proofFetches.has(key)) proofFetches.set(key,
                this.fetchCapabilitySnapshotProof(snapshotBlock, capability,
                    proofPubkeys.has(key) ? Array.from(proofPubkeys.get(key)) : pubkeys));
            return proofFetches.get(key);
        };
        try {
            for (let [key, row] of held) {
                let judgement = { fetchProof: fetchProof, retainHold: true };
                let refused = await this.refuseUnprovenCapabilitySnapshot(row, judgement);
                if (judgement.verdict === 'held') continue;
                if (refused) {
                    this._capabilityProofHolds.delete(key);
                    continue;
                }
                this._capabilityProofRetryApproved.add(key);
                try {
                    await this.applyRow('capability_snapshots', row);
                    this._capabilityProofHolds.delete(key);
                } finally {
                    this._capabilityProofRetryApproved.delete(key);
                }
            }
            await this.retryCapabilityProofOverflow();
        } finally {
            this._capabilityProofRetrying = false;
            this.releaseCapabilityProofWaiters();
            this.scheduleCapabilityProofRetry();
        }
    },

    async retryCapabilityProofOverflow() {
        if (!this._capabilityProofOverflow || this._capabilityProofHolds.size > 0 || this._bootstrapping) return;
        this._capabilityProofOverflow = false;
        let mark = null;
        try {
            mark = await this.bootstrapTable('capability_snapshots');
        } catch (err) {
            getLogger().warn('HubDbSync: capability proof overflow re-page failed:', err);
        }
        if (mark === null && this._capabilityProofHolds.size === 0) this._capabilityProofOverflow = true;
    },

};
