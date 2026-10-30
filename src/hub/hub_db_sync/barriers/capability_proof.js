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
const CAPABILITY_PROOF_PUBKEY_CAP = 256;
const CAPABILITY_PROOF_PATH_BUDGET = 8000;
const CAPABILITY_PROOF_MIDDLE_PROBE_GROUPS = 12;
const CAPABILITY_PUBKEY = /^[0-9a-fA-F]{64}$/;
const CAPABILITY_PROOF_NOT_YET_AVAILABLE = new Set([
    'SNAPSHOT_NOT_YET_CHECKPOINTED',
    'PROOF_UNAVAILABLE',
    'INDEXER_BEHIND',
]);

// These transport outcomes say only that the proof source has not reached the
// requested checkpoint yet. Proof mismatches and malformed or invalid proofs are
// deliberately outside this class, so they keep their existing per-row handling.
function capabilityProofUnavailableStatus(value) {
    const status = Number(value && value.statusCode);
    if (status === 404 || status === 503) return status;
    const reason = String(value && value.reason !== undefined ? value.reason :
        value && value.message !== undefined ? value.message : value || '').trim().toUpperCase();
    const match = /^HTTP (404|503)(?:\b|$)/.exec(reason);
    return match ? Number(match[1]) : null;
}

function capabilityProofNotYetAvailable(value) {
    if (capabilityProofUnavailableStatus(value) !== null) return true;
    const reason = String(value && value.reason !== undefined ? value.reason :
        value && value.message !== undefined ? value.message : value || '').trim().toUpperCase();
    if (CAPABILITY_PROOF_NOT_YET_AVAILABLE.has(reason)) return true;
    return reason.startsWith('INDEXER_BEHIND_') ||
        /^BLOCK_INDEX \d+ NOT YET INDEXED \(LATEST: \d+\)$/.test(reason);
}

function snapshotBlockAfter(value, frontier) {
    if (frontier === null || frontier === undefined) return false;
    const block = Number(value);
    const boundary = Number(frontier);
    return Number.isSafeInteger(block) && Number.isSafeInteger(boundary) && block > boundary;
}

function compareHeldRows(left, right) {
    const leftBlock = Number(left[1] && left[1].snapshot_block);
    const rightBlock = Number(right[1] && right[1].snapshot_block);
    if (Number.isSafeInteger(leftBlock) && Number.isSafeInteger(rightBlock) && leftBlock !== rightBlock)
        return leftBlock - rightBlock;
    const capabilityOrder = String(left[1] && left[1].capability)
        .localeCompare(String(right[1] && right[1].capability));
    return capabilityOrder || String(left[0]).localeCompare(String(right[0]));
}

function proofGroupKey(snapshotBlock, capability) {
    return String(snapshotBlock) + '\u0000' + String(capability);
}

function proofMemberKey(snapshotBlock, capability, pubkey) {
    return proofGroupKey(snapshotBlock, capability) + '\u0000' + String(pubkey).toLowerCase();
}

function proofRequestPath(snapshotBlock, capability, pubkeys) {
    return '/hub-db/snapshot/capability_snapshot_proof?snapshot_block=' +
        encodeURIComponent(String(snapshotBlock)) + '&capability=' +
        encodeURIComponent(String(capability)) + '&pubkeys=' +
        encodeURIComponent((Array.isArray(pubkeys) ? pubkeys : []).map(String).join(','));
}

function chunkProofPubkeys(snapshotBlock, capability, pubkeys) {
    const chunks = [];
    let chunk = [];
    for (const value of pubkeys) {
        const candidate = chunk.concat(String(value));
        if (chunk.length > 0 && (candidate.length > CAPABILITY_PROOF_PUBKEY_CAP ||
            Buffer.byteLength(proofRequestPath(snapshotBlock, capability, candidate)) >
                CAPABILITY_PROOF_PATH_BUDGET)) {
            chunks.push(chunk);
            chunk = [String(value)];
        } else {
            chunk = candidate;
        }
    }
    if (chunk.length > 0) chunks.push(chunk);
    return chunks;
}

module.exports = {

    // During one bootstrap flush, rows sharing a snapshot and capability can use one
    // proof response within both the request-path budget and the transport's key cap.
    // Entries are lazy so an intact local mirror still skips every proof GET after its
    // natural-key reads.
    beginCapabilityProofBatch(table, rows, drain) {
        if (table !== 'capability_snapshots' || !Array.isArray(rows)) return null;

        const groups = new Map();
        for (const row of rows) {
            if (!row || !CAPABILITY_PUBKEY.test(String(row.signing_pubkey))) continue;
            const group = proofGroupKey(row.snapshot_block, row.capability);
            if (!groups.has(group)) groups.set(group, {
                snapshotBlock: row.snapshot_block,
                capability: row.capability,
                pubkeys: new Map(),
            });
            const pubkey = String(row.signing_pubkey);
            groups.get(group).pubkeys.set(pubkey.toLowerCase(), pubkey);
        }

        const batch = new Map();
        // Carry each capability's first unavailable snapshot through every flush of
        // this table drain. Availability of one capability says nothing about another.
        batch.unavailableSnapshotBlocks = drain &&
            drain.capabilityProofUnavailableSnapshotBlocks instanceof Map
            ? drain.capabilityProofUnavailableSnapshotBlocks : new Map();
        if (drain)
            drain.capabilityProofUnavailableSnapshotBlocks = batch.unavailableSnapshotBlocks;
        for (const group of groups.values()) {
            const pubkeys = Array.from(group.pubkeys.values());
            for (const chunk of chunkProofPubkeys(group.snapshotBlock, group.capability, pubkeys)) {
                const entry = {
                    promise: null,
                    pubkeyCount: chunk.length,
                    noteUnavailable: error => {
                        if (!capabilityProofNotYetAvailable(error)) return;
                        const block = Number(group.snapshotBlock);
                        const capability = String(group.capability);
                        const previous = batch.unavailableSnapshotBlocks.get(capability);
                        if (Number.isSafeInteger(block) &&
                            (!Number.isSafeInteger(previous) || block < previous))
                            batch.unavailableSnapshotBlocks.set(capability, block);
                    },
                    fetch: () => {
                        if (entry.promise === null)
                            entry.promise = this.fetchCapabilitySnapshotProofDirect(
                                group.snapshotBlock, group.capability, chunk);
                        return entry.promise;
                    },
                };
                for (const pubkey of chunk)
                    batch.set(proofMemberKey(group.snapshotBlock, group.capability, pubkey), entry);
            }
        }
        const token = {
            previous: this._capabilityProofBatchOwner || null,
            mine: batch,
            active: true,
        };
        this._capabilityProofBatchOwner = token;
        this._capabilityProofBatch = batch;
        return token;
    },

    restoreCapabilityProofBatch(token) {
        if (!token || token.active !== true) return;
        token.active = false;
        if (this._capabilityProofBatchOwner !== token) return;
        let previous = token.previous;
        while (previous && previous.active !== true) previous = previous.previous;
        this._capabilityProofBatchOwner = previous || null;
        this._capabilityProofBatch = previous ? previous.mine : null;
    },

    sharedCapabilityProof(snapshotBlock, capability, pubkeys) {
        if (!(this._capabilityProofBatch instanceof Map) ||
            !Array.isArray(pubkeys) || pubkeys.length !== 1) return null;
        const entry = this._capabilityProofBatch.get(
            proofMemberKey(snapshotBlock, capability, pubkeys[0]));
        // A batch frontier must never affect a retry pass, live row, or overlapping
        // flush whose member is absent from the installed capability batch.
        if (!entry) return null;
        const unavailableSnapshotBlock = this._capabilityProofBatch.unavailableSnapshotBlocks
            .get(String(capability));
        if (snapshotBlockAfter(snapshotBlock, unavailableSnapshotBlock)) {
            const error = new Error('capability proof not yet available beyond snapshot block ' +
                unavailableSnapshotBlock);
            error.statusCode = 503;
            const held = Promise.reject(error);
            held.capabilityProofSkipFallback = true;
            return held;
        }
        const shared = entry.fetch();
        shared.capabilityProofPubkeyCount = entry.pubkeyCount;
        shared.capabilityProofNoteUnavailable = entry.noteUnavailable;
        return shared;
    },

    capabilityProofNotYetAvailable(value) {
        return capabilityProofNotYetAvailable(value);
    },

    capabilityProofRequestPath(snapshotBlock, capability, pubkeys) {
        return proofRequestPath(snapshotBlock, capability, pubkeys);
    },

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
        let held = Array.from(this._capabilityProofHolds.entries()).sort(compareHeldRows);
        let capabilityGroups = new Map();
        let proofPubkeys = new Map();
        for (let [key, row] of held) {
            let capability = String(row.capability);
            let group = proofGroupKey(row.snapshot_block, capability);
            if (!capabilityGroups.has(capability)) capabilityGroups.set(capability, new Map());
            if (!capabilityGroups.get(capability).has(group))
                capabilityGroups.get(capability).set(group, {
                    snapshotBlock: row.snapshot_block,
                    rows: [],
                });
            capabilityGroups.get(capability).get(group).rows.push([key, row]);
            if (!proofPubkeys.has(group)) proofPubkeys.set(group, new Set());
            proofPubkeys.get(group).add(String(row.signing_pubkey));
        }
        let proofFetches = new Map();
        for (let [group, pubkeys] of proofPubkeys) {
            let split = group.indexOf('\u0000');
            let snapshotBlock = group.slice(0, split);
            let capability = group.slice(split + 1);
            for (let chunk of chunkProofPubkeys(snapshotBlock, capability, Array.from(pubkeys))) {
                let entry = { promise: null, pubkeyCount: chunk.length };
                entry.fetch = () => {
                    if (entry.promise === null)
                        entry.promise = this.fetchCapabilitySnapshotProof(snapshotBlock, capability, chunk);
                    return entry.promise;
                };
                for (let pubkey of chunk)
                    proofFetches.set(proofMemberKey(snapshotBlock, capability, pubkey), entry);
            }
        }
        let fetchProof = async (snapshotBlock, capability, pubkeys) => {
            let member = Array.isArray(pubkeys) && pubkeys.length > 0 ? pubkeys[0] : '';
            let entry = proofFetches.get(proofMemberKey(snapshotBlock, capability, member));
            if (!entry)
                return this.fetchCapabilitySnapshotProof(snapshotBlock, capability, pubkeys);
            try {
                return await entry.fetch();
            } catch (error) {
                if (entry.pubkeyCount <= 1 || capabilityProofUnavailableStatus(error) !== 503)
                    throw error;
                return this.fetchCapabilitySnapshotProofDirect(snapshotBlock, capability, [member]);
            }
        };
        try {
            const processGroup = async group => {
                let unavailable = false;
                for (let [key, row] of group.rows) {
                    if (!this._capabilityProofHolds.has(key)) continue;
                    let judgement = { fetchProof: fetchProof, retainHold: true };
                    let refused = await this.refuseUnprovenCapabilitySnapshot(row, judgement);
                    if (judgement.verdict === 'held') {
                        if (judgement.notYetAvailable) unavailable = true;
                        continue;
                    }
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
                return unavailable;
            };
            if (!(this._capabilityProofProbeCursors instanceof Map))
                this._capabilityProofProbeCursors = new Map();
            for (let [capability, grouped] of capabilityGroups) {
                const groups = Array.from(grouped.values()).sort((left, right) => {
                    const leftBlock = Number(left.snapshotBlock);
                    const rightBlock = Number(right.snapshotBlock);
                    if (Number.isSafeInteger(leftBlock) && Number.isSafeInteger(rightBlock) &&
                        leftBlock !== rightBlock) return leftBlock - rightBlock;
                    return String(left.snapshotBlock).localeCompare(String(right.snapshotBlock));
                });
                let unavailableIndex = -1;
                for (let index = 0; index < groups.length; index++) {
                    if (await processGroup(groups[index])) {
                        unavailableIndex = index;
                        break;
                    }
                }
                if (unavailableIndex < 0 || unavailableIndex === groups.length - 1) {
                    this._capabilityProofProbeCursors.delete(capability);
                    continue;
                }

                // A permanent hole cannot monopolize a capability. Probe its newest
                // held group every pass; on success, walk down until another hole.
                let newestUnavailableIndex = -1;
                for (let index = groups.length - 1; index > unavailableIndex; index--) {
                    if (await processGroup(groups[index])) {
                        newestUnavailableIndex = index;
                        break;
                    }
                }
                if (newestUnavailableIndex <= unavailableIndex + 1) {
                    this._capabilityProofProbeCursors.delete(capability);
                    continue;
                }

                // Two permanent holes must not strand the groups between them. Keep a
                // cursor per capability and spend a fixed request window walking upward
                // through the middle, wrapping only after reaching the newer hole.
                const middleStart = unavailableIndex + 1;
                const middleCount = newestUnavailableIndex - middleStart;
                const cursor = this._capabilityProofProbeCursors.get(capability);
                let probeIndex = middleStart;
                if (cursor !== undefined) {
                    const cursorNumber = Number(cursor);
                    const afterCursor = groups.findIndex((group, index) => {
                        if (index < middleStart || index >= newestUnavailableIndex) return false;
                        const block = Number(group.snapshotBlock);
                        if (Number.isSafeInteger(block) && Number.isSafeInteger(cursorNumber))
                            return block > cursorNumber;
                        return String(group.snapshotBlock).localeCompare(String(cursor)) > 0;
                    });
                    if (afterCursor >= middleStart) probeIndex = afterCursor;
                }
                const probeCount = Math.min(CAPABILITY_PROOF_MIDDLE_PROBE_GROUPS, middleCount);
                for (let probed = 0; probed < probeCount; probed++) {
                    const group = groups[probeIndex];
                    await processGroup(group);
                    this._capabilityProofProbeCursors.set(capability, group.snapshotBlock);
                    probeIndex++;
                    if (probeIndex >= newestUnavailableIndex) probeIndex = middleStart;
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
