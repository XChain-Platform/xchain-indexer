// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The capability proof barrier, scoped to the snapshot a block reads. The rail shape:
// an LTC indexer at landing height 98582 with the newest BTC frontier snapshot
// (snapshot_block 6486) held for its checkpoint proof. A block that reads no held
// snapshot commits; a block whose quorum read keys on the held snapshot fails closed
// at the read and its retry waits for that snapshot's proof.

'use strict';

const assert = require('assert');
const sinon = require('sinon');

const HubDbSync = require('../../../../../src/hub/hub_db_sync.js');
const mirrorBarriers = require('../../../../../src/XChainIndexer/mirror_barriers.js');
const blockCommit = require('../../../../../src/XChainIndexer/block_commit.js');
const connections = require('../../../../../src/db/database/connections.js');
const capabilities = require('../../../../../src/db/capabilities/index.js');
const { txEpochStore } = require('../../../../../src/db/shared.js');
const { rethrowIfInfraFault } = require('../../../../../src/consensus/fault_guard.js');
const {
    CAPABILITY_PROOF_DEFERRED,
    capabilityReadHeld
} = require('../../../../../src/consensus/capability_snapshot_proof/held_read.js');

const LTC_BLOCK = 98582;
const PROVEN_SNAPSHOT = 6480;
const FRONTIER_SNAPSHOT = 6486;

function frontierRow(capability, pubkey) {
    return { snapshot_block: FRONTIER_SNAPSHOT, capability: capability, signing_pubkey: pubkey,
             amount: '25.00000000', source: 'validator/' + pubkey };
}

function makeSync() {
    const hubDb = { doQuery: sinon.stub().resolves([]) };
    const sync = new HubDbSync(hubDb, { hubUrl: 'http://hub.test', network: 'regtest' });
    sync.holdCapabilitySnapshot(frontierRow('price', 'aa11'));
    sync.holdCapabilitySnapshot(frontierRow('price', 'bb22'));
    if (sync._capabilityProofRetryTimer !== null) clearTimeout(sync._capabilityProofRetryTimer);
    sync._capabilityProofRetryTimer = null;
    sync.waitForSnapshotSync = sinon.stub().resolves(true);
    return sync;
}

function makeIndexer(sync) {
    return Object.assign({
        hubDbSync: sync,
        config: { COIN: 'LTC', NETWORK: 'regtest' },
        priceSyncTimeoutMs: 60,
        util: { sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) },
        stallReason: null,
        stallClearsAt: null,
        capabilityProofBarrierBlock: null,
        capabilityProofBarrierSkipped: false,
        capabilityProofHeldRead: null
    }, mirrorBarriers);
}

function makeDb(indexer) {
    const mirror = {
        doQueryStrict: sinon.stub().resolves([{ pubkey: 'cc33', amount: '25.00000000' }])
    };
    const db = Object.assign({
        indexer: indexer,
        config: { COIN: 'LTC', VALIDATOR_QUERY_LIMIT: 1000 },
        util: { throwError(e) { throw e; } },
        mirrorDb() { return mirror; }
    }, connections, capabilities);
    return { db, mirror };
}

function inBlock(fn) {
    return txEpochStore.run({ owner: {}, epoch: 1, consensus: true }, fn);
}

function heldReadMatchesKey() {
    const sync = makeSync();
    assert.strictEqual(capabilityReadHeld(sync, 'price', FRONTIER_SNAPSHOT), true);
    assert.strictEqual(capabilityReadHeld(sync, 'price', String(FRONTIER_SNAPSHOT)), true);
    assert.strictEqual(capabilityReadHeld(sync, 'price', PROVEN_SNAPSHOT), false);
    assert.strictEqual(capabilityReadHeld(sync, 'attestation', FRONTIER_SNAPSHOT), false);
    assert.strictEqual(capabilityReadHeld(null, 'price', FRONTIER_SNAPSHOT), false);
    sync._capabilityProofOverflow = true;
    assert.strictEqual(capabilityReadHeld(sync, 'attestation', PROVEN_SNAPSHOT), true,
        'an armed overflow may hide a held row at any snapshot');
    sync.enabled = false;
    assert.strictEqual(capabilityReadHeld(sync, 'price', FRONTIER_SNAPSHOT), false);
}

async function passesUnreadFrontier() {
    const sync = makeSync();
    const indexer = makeIndexer(sync);
    const { db, mirror } = makeDb(indexer);

    assert.strictEqual(await indexer.deferOnSnapshotSync(LTC_BLOCK, 1700000000), false);
    assert.strictEqual(indexer.stallReason, null);
    assert.strictEqual(indexer.capabilityProofBarrierSkipped, true);
    assert.strictEqual(sync.waitForSnapshotSync.callCount, 1);

    const rows = await inBlock(() => db.getCapabilitySnapshotValidators('price', PROVEN_SNAPSHOT));
    assert.deepStrictEqual(rows.map(r => r.pubkey), ['cc33']);
    assert.strictEqual(mirror.doQueryStrict.callCount, 1);
    assert.strictEqual(indexer.capabilityProofHeldRead, null);
}

async function heldReadFailsClosedAndWaits() {
    const sync = makeSync();
    const indexer = makeIndexer(sync);
    const { db, mirror } = makeDb(indexer);

    assert.strictEqual(await indexer.deferOnSnapshotSync(LTC_BLOCK, 1700000000), false);
    for (const read of [
        () => db.getCapabilitySnapshotValidators('price', FRONTIER_SNAPSHOT),
        () => db.getCapabilitySnapshotWeights('price', FRONTIER_SNAPSHOT),
        () => db.getCapabilitySnapshotCount('price', FRONTIER_SNAPSHOT),
        () => db.isPubkeyInCapabilitySnapshot('aa11', 'price', FRONTIER_SNAPSHOT)
    ]) {
        let thrown = null;
        try { await inBlock(read); } catch (e) { thrown = e; }
        assert.ok(thrown, 'the held read must not return a partial set');
        assert.strictEqual(thrown.code, CAPABILITY_PROOF_DEFERRED);
        assert.throws(() => rethrowIfInfraFault(thrown), e => e === thrown,
            'an action catch must not turn the deferral into a verdict');
    }
    assert.strictEqual(mirror.doQueryStrict.callCount, 0);
    assert.deepStrictEqual(indexer.capabilityProofHeldRead,
        { block: LTC_BLOCK, capability: 'price', snapshotBlock: FRONTIER_SNAPSHOT });

    // The abandoned block's retry waits on the one snapshot it read, then defers.
    indexer.capabilityProofBarrierSkipped = false;
    assert.strictEqual(await indexer.deferOnSnapshotSync(LTC_BLOCK, 1700000000), true);
    assert.strictEqual(indexer.stallReason, 'capability_proof_unavailable');
    assert.strictEqual(indexer.stallClearsAt, null);
    assert.strictEqual(sync.waitForSnapshotSync.callCount, 1, 'presence is not checked while deferred');

    // A later block is not held by this block's read.
    indexer.stallReason = null;
    assert.strictEqual(await indexer.deferOnSnapshotSync(LTC_BLOCK + 1, 1700000001), false);
    assert.strictEqual(indexer.stallReason, null);

    // Once the snapshot proves, the retry of the held block runs.
    for (const key of Array.from(sync._capabilityProofHolds.keys())) sync._capabilityProofHolds.delete(key);
    assert.strictEqual(await indexer.deferOnSnapshotSync(LTC_BLOCK, 1700000000), false);
    const rows = await inBlock(() => db.getCapabilitySnapshotValidators('price', FRONTIER_SNAPSHOT));
    assert.deepStrictEqual(rows.map(r => r.pubkey), ['cc33']);
}

async function retryReleasesOnProof() {
    const sync = makeSync();
    const indexer = makeIndexer(sync);
    indexer.priceSyncTimeoutMs = 2000;
    indexer.capabilityProofHeldRead = { block: LTC_BLOCK, capability: 'price', snapshotBlock: FRONTIER_SNAPSHOT };
    setTimeout(() => sync._capabilityProofHolds.clear(), 100);
    const started = Date.now();
    assert.strictEqual(await indexer.deferOnSnapshotSync(LTC_BLOCK, 1700000000), false);
    assert.ok(Date.now() - started < 1500);
    assert.strictEqual(indexer.stallReason, null);
}

async function offBlockReadsUnpoliced() {
    const sync = makeSync();
    const indexer = makeIndexer(sync);
    const { db } = makeDb(indexer);
    indexer.capabilityProofBarrierSkipped = true;
    const rows = await db.getCapabilitySnapshotValidators('price', FRONTIER_SNAPSHOT);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(indexer.capabilityProofHeldRead, null);
}

function commitClearsHeldRead() {
    const indexer = {
        capabilityProofBarrierSkipped: true,
        capabilityProofHeldRead: { block: LTC_BLOCK, capability: 'price', snapshotBlock: FRONTIER_SNAPSHOT }
    };
    blockCommit.markBlockCommitted.call(Object.assign(indexer, { barrierHold: null }), LTC_BLOCK);
    assert.strictEqual(indexer.capabilityProofBarrierSkipped, false);
    assert.strictEqual(indexer.capabilityProofHeldRead, null);
}

describe('capability proof barrier scoped to the snapshot a block reads @regression @tier1', function () {
    it('capabilityReadHeld matches the held (snapshot_block, capability) only', heldReadMatchesKey);
    it('a block passes an unproven frontier snapshot it does not read', passesUnreadFrontier);
    it('a block that reads the held snapshot fails closed and its retry waits for the proof', heldReadFailsClosedAndWaits);
    it('the retry releases as soon as the held snapshot proves inside the wait', retryReleasesOnProof);
    it('reads outside block processing are never policed', offBlockReadsUnpoliced);
    it('committing the held block clears its recorded read and the skip flag', commitClearsHeldRead);
});
