// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const sinon = require('sinon');

const HubDbSync = require('../../../../../src/hub/hub_db_sync.js');
const { HUB_SCHEMA_VERSION } = require('../../../../../src/hub/hub_schema_version.js');
const { CAPABILITY_SNAPSHOT_KEY_CAP, capabilitySnapshotKey } = require(
    '../../../../../src/hub/hub_db_sync/mirror_bounds.js');

const ROW = Object.freeze({
    id: 31,
    snapshot_block: 700,
    capability: 'cross_chain',
    signing_pubkey: 'aa11',
    amount: '25.00000000',
    source: 'validator/one'
});

function persistentMirror(localMaxId = 0) {
    const persistent = { inserted: [], localMaxId };
    persistent.hubDb = {
        doQuery: sinon.stub().callsFake(async (sql, args) => {
            if (/^INSERT/.test(sql)) {
                persistent.inserted.push({ sql, args });
                persistent.localMaxId++;
                return { affectedRows: 1 };
            }
            if (/^SELECT MAX\(id\) AS max_id FROM capability_snapshots/.test(sql))
                return [{ max_id: persistent.localMaxId }];
            return [];
        })
    };
    return persistent;
}

function makeSync(judge, persistent = persistentMirror()) {
    const authoritativeDb = { verifyCapabilitySnapshotRow: sinon.stub().callsFake(judge) };
    const sync = new HubDbSync(persistent.hubDb, {
        hubUrl: 'http://hub.test', network: 'regtest', authoritativeDb: authoritativeDb
    });
    sinon.stub(sync, 'localColumns').resolves(
        new Set(['id', 'snapshot_block', 'capability', 'signing_pubkey', 'amount', 'source']));
    sinon.stub(sync, 'httpGet').resolves({ proof: 'ok' });
    return { sync, inserted: persistent.inserted, authoritativeDb, persistent };
}

function stopRetry(sync) {
    if (sync._capabilityProofRetryTimer !== null) clearTimeout(sync._capabilityProofRetryTimer);
    sync._capabilityProofRetryTimer = null;
}

function proofRow(id, snapshotBlock, overrides = {}) {
    return Object.assign({}, ROW, {
        id,
        snapshot_block: snapshotBlock,
        signing_pubkey: id.toString(16).padStart(64, '0'),
        source: 'validator/' + id,
    }, overrides);
}

function proofResponse(path) {
    const params = new URL(path, 'http://example.invalid').searchParams;
    const pubkeys = String(params.get('pubkeys')).split(',');
    return { proof: { members: pubkeys.map(pubkey => ({ pubkey })) } };
}

function unavailable(statusCode) {
    const error = new Error('HTTP ' + statusCode);
    error.statusCode = statusCode;
    return error;
}

describe('capability snapshot proof hold barrier @regression @tier1', function () {
    const syncs = [];

    afterEach(function () {
        for (const sync of syncs) stopRetry(sync);
        syncs.length = 0;
        sinon.restore();
    });

    it('keeps a held row absent, blocks, then applies and releases it after proof arrives', async function () {
        let verdict = 'held';
        const made = makeSync(async (row, options) => {
            await options.fetchProof(row.snapshot_block, row.capability, ['aa11', 'bb/22']);
            return { verdict };
        });
        const { sync, inserted } = made;
        syncs.push(sync);

        assert.strictEqual(await sync.applyRow('capability_snapshots', ROW), false);
        assert.strictEqual(inserted.length, 0);
        assert.strictEqual(sync.capabilityProofSatisfied(), false);
        assert.strictEqual(sync.repageOwedSeq('capability_snapshots') !== undefined, true);

        let released = false;
        const waiting = sync.waitForCapabilityProof(2000).then(() => { released = true; });
        await Promise.resolve();
        assert.strictEqual(released, false, 'the block-loop waiter must remain parked');

        verdict = 'verified';
        sync.httpGet.resetHistory();
        await sync.retryHeldCapabilityRows();
        await waiting;

        assert.strictEqual(sync.httpGet.callCount, 1, 'one proof fetch serves the set on this retry pass');
        assert.strictEqual(inserted.length, 1);
        assert.strictEqual(sync.capabilityProofSatisfied(), true);
        assert.strictEqual(released, true);
    });

    it('deduplicates proof fetches by snapshot block and capability during one retry pass', async function () {
        let verdict = 'held';
        const made = makeSync(async (row, options) => {
            await options.fetchProof(row.snapshot_block, row.capability, [row.signing_pubkey]);
            return { verdict };
        });
        const { sync, inserted } = made;
        syncs.push(sync);
        await sync.applyRow('capability_snapshots', ROW);
        await sync.applyRow('capability_snapshots', Object.assign({}, ROW, { id: 32, signing_pubkey: 'bb22' }));

        verdict = 'verified';
        sync.httpGet.resetHistory();
        await sync.retryHeldCapabilityRows();

        assert.strictEqual(sync.httpGet.callCount, 1);
        assert.match(sync.httpGet.firstCall.args[0], /pubkeys=aa11%2Cbb22$/);
        assert.strictEqual(inserted.length, 2);
    });

    it('chunks a large held-row retry by encoded request path length', async function () {
        const made = makeSync(async (row, options) => {
            await options.fetchProof(row.snapshot_block, row.capability, [row.signing_pubkey]);
            return { verdict: 'verified' };
        });
        const { sync, inserted } = made;
        syncs.push(sync);
        for(let index = 1; index <= 300; index++){
            const held = Object.assign({}, ROW, {
                id: ROW.id + index,
                signing_pubkey: index.toString(16).padStart(64, '0'),
                source: 'validator/' + index,
            });
            sync._capabilityProofHolds.set(capabilitySnapshotKey(held), held);
        }

        await sync.retryHeldCapabilityRows();

        const paths = sync.httpGet.getCalls().map(call => call.args[0]);
        assert.ok(paths.length > 1, 'the retry must split a 300-key proof group');
        for(const path of paths){
            assert.ok(Buffer.byteLength(path) <= 8000, 'request path exceeds 8 KB budget');
            const keys = String(new URL(path, 'http://example.invalid').searchParams.get('pubkeys')).split(',');
            assert.ok(keys.length <= 256, 'request exceeds the endpoint key cap');
        }
        assert.strictEqual(inserted.length, 300);
    });

    it('releases an existing waiter when ordinary redelivery verifies the held row', async function () {
        let verdict = 'held';
        const made = makeSync(async () => ({ verdict }));
        const { sync, inserted } = made;
        syncs.push(sync);
        await sync.applyRow('capability_snapshots', ROW);
        const waiting = sync.waitForCapabilityProof(2000);

        verdict = 'verified';
        await sync.applyRow('capability_snapshots', ROW);
        await waiting;

        assert.strictEqual(inserted.length, 1);
        assert.strictEqual(sync._capabilityProofWaiters.length, 0);
        assert.strictEqual(sync.capabilityProofSatisfied(), true);
    });

    it('keeps refused rows absent and applies unknown rows without creating a hold', async function () {
        let verdict = { verdict: 'refused', reason: 'proof contradicts the row' };
        const made = makeSync(async () => verdict);
        const { sync, inserted } = made;
        syncs.push(sync);
        sinon.stub(console, 'error');

        assert.strictEqual(await sync.applyRow('capability_snapshots', ROW), false);
        assert.strictEqual(inserted.length, 0);
        assert.strictEqual(sync.capabilityProofSatisfied(), true);

        verdict = { verdict: 'unknown', reason: 'checkpoint not available' };
        await sync.applyRow('capability_snapshots', ROW);
        assert.strictEqual(inserted.length, 1);
        assert.strictEqual(sync.capabilityProofSatisfied(), true);
    });

    it('applies and releases a held row when a retry can no longer judge it', async function () {
        let unavailable = false;
        const made = makeSync(async () => {
            if (unavailable) throw new Error('proof endpoint unavailable');
            return { verdict: 'held' };
        });
        const { sync, inserted } = made;
        syncs.push(sync);
        sinon.stub(console, 'warn');

        await sync.applyRow('capability_snapshots', ROW);
        unavailable = true;
        await sync.retryHeldCapabilityRows();

        assert.strictEqual(inserted.length, 1);
        assert.strictEqual(sync.capabilityProofSatisfied(), true);
    });

    it('encodes every proof endpoint parameter', async function () {
        const made = makeSync(async () => ({ verdict: 'verified' }));
        const { sync } = made;
        syncs.push(sync);

        await sync.fetchCapabilitySnapshotProof(12, 'cross chain/x', ['aa/11', 'bb?22']);
        assert.strictEqual(sync.httpGet.firstCall.args[0],
            '/hub-db/snapshot/capability_snapshot_proof?snapshot_block=12&capability=cross%20chain%2Fx&' +
            'pubkeys=aa%2F11%2Cbb%3F22');
    });

    it('paces proof request starts below the indexer rate limit', async function () {
        const clock = sinon.useFakeTimers({ now: 1000 });
        const made = makeSync(async () => ({ verdict: 'verified' }));
        const { sync } = made;
        syncs.push(sync);
        const startedAt = [];
        sync.httpGet.callsFake(async () => {
            startedAt.push(Date.now());
            return { proof: 'ok' };
        });

        const requests = [
            sync.fetchCapabilitySnapshotProof(12, 'cross_chain', ['aa11']),
            sync.fetchCapabilitySnapshotProof(13, 'cross_chain', ['bb22']),
            sync.fetchCapabilitySnapshotProof(14, 'cross_chain', ['cc33'])
        ];
        await clock.tickAsync(0);
        assert.deepStrictEqual(startedAt, [1000]);
        await clock.tickAsync(109);
        assert.deepStrictEqual(startedAt, [1000]);
        await clock.tickAsync(1);
        assert.deepStrictEqual(startedAt, [1000, 1110]);
        await clock.tickAsync(110);
        await Promise.all(requests);

        assert.deepStrictEqual(startedAt, [1000, 1110, 1220]);
    });

    it('bounds the hold map, notes a full map once, and leaves overflow for a re-page', function () {
        const made = makeSync(async () => ({ verdict: 'held' }));
        const { sync } = made;
        syncs.push(sync);
        let writes = 0;
        sync._capabilityProofHolds = {
            size: CAPABILITY_SNAPSHOT_KEY_CAP,
            has: () => false,
            set: () => { writes++; }
        };
        sinon.stub(console, 'warn');

        sync.holdCapabilitySnapshot(ROW);
        sync.holdCapabilitySnapshot(Object.assign({}, ROW, { signing_pubkey: 'bb22' }));

        assert.strictEqual(writes, 0);
        assert.strictEqual(sync._capabilityProofHoldCapNoted, true);
        assert.strictEqual(sync._capabilityProofOverflow, true);
        assert.strictEqual(console.warn.callCount, 1);
        assert.strictEqual(sync.repageOwedSeq('capability_snapshots') !== undefined, true);
    });

    it('keeps the barrier closed for overflow until the required re-page drains', async function () {
        const made = makeSync(async () => ({ verdict: 'verified' }));
        const { sync } = made;
        syncs.push(sync);
        sync._capabilityProofOverflow = true;
        const bootstrap = sinon.stub(sync, 'bootstrapTable').resolves(44);
        const waiting = sync.waitForCapabilityProof(2000);

        await sync.retryHeldCapabilityRows();
        await waiting;

        assert.strictEqual(bootstrap.calledOnceWithExactly('capability_snapshots'), true);
        assert.strictEqual(sync._capabilityProofOverflow, false);
        assert.strictEqual(sync.capabilityProofSatisfied(), true);
    });

    it('a retained bootstrap hold preserves a re-page reason the drain opened under', async function () {
        const made = makeSync(async () => ({ verdict: 'held' }));
        const { sync } = made;
        syncs.push(sync);
        sync.markRepageOwed(['capability_snapshots']);
        const owed = sync.repageOwedSeq('capability_snapshots');

        sync._bootstrapping = true;
        assert.strictEqual(await sync.refuseUnprovenCapabilitySnapshot(ROW), true);
        sync._bootstrapping = false;

        assert.strictEqual(sync.repageOwedSeq('capability_snapshots'), owed);
    });

    it('a frontier hold ends the drain and leaves the heartbeat gate open', async function () {
        const made = makeSync(async row => ({
            verdict: row.id === ROW.id ? 'held' : 'verified',
            reason: row.id === ROW.id ? 'SNAPSHOT_NOT_YET_CHECKPOINTED' : undefined
        }));
        const { sync, inserted } = made;
        syncs.push(sync);
        const before = Object.assign({}, ROW, { id: ROW.id - 1, signing_pubkey: '0011' });
        sync.httpGet.callsFake(async path => path.includes('/hub-db/snapshot/capability_snapshots')
            ? { schema_version: HUB_SCHEMA_VERSION, rows: [before, ROW], watermark: 91 }
            : { proof: 'ok' });
        sinon.stub(sync, 'mirrorNetworkScope').resolves(null);
        sinon.stub(sync, 'reconcileForeignCapabilitySnapshots').resolves();
        sinon.stub(sync, 'releaseSnapshotWaiters').resolves();
        const bootstrapTable = sync.bootstrapTable.bind(sync);
        sinon.stub(sync, 'bootstrapTable').callsFake(async table =>
            table === 'capability_snapshots' ? bootstrapTable(table) : 100);

        await sync.bootstrapAll();

        assert.strictEqual(inserted.length, 1, 'the verified predecessor applies');
        assert.strictEqual(sync._drainPositions.capability_snapshots, ROW.id,
            'the held frontier is a handled wire position');
        assert.strictEqual(sync._capabilityProofHolds.size, 1);
        assert.strictEqual(sync.capabilityProofSatisfied(), false, 'the proof barrier remains closed');
        assert.strictEqual(sync.repageOwedSeq('capability_snapshots'), undefined);
        assert.strictEqual(sync._bootstrapDrained, true, 'the heartbeat gate opens after the complete drain');
        assert.strictEqual(sync.streamWatermark, 91);
    });

    it('a held frontier retry does not reopen the bootstrap drain', async function () {
        const made = makeSync(async () => ({
            verdict: 'held',
            reason: 'SNAPSHOT_NOT_YET_CHECKPOINTED'
        }));
        const { sync } = made;
        syncs.push(sync);

        sync._bootstrapping = true;
        assert.strictEqual(await sync.refuseUnprovenCapabilitySnapshot(ROW), true);
        sync._bootstrapping = false;
        sync._bootstrapDrained = true;
        assert.strictEqual(sync.repageOwedSeq('capability_snapshots'), undefined);

        await sync.retryHeldCapabilityRows();

        assert.strictEqual(sync._capabilityProofHolds.size, 1, 'the proof barrier retains the row');
        assert.strictEqual(sync.capabilityProofSatisfied(), false);
        assert.strictEqual(sync.repageOwedSeq('capability_snapshots'), undefined,
            'the retained retry is not a new source gap');
        assert.strictEqual(sync._bootstrapDrained, true, 'the completed bootstrap stays complete');
    });

    it('bounds proof requests above a permanent frontier across thousands of rows and drains bridge transfers',
        async function () {
        const rows = Array.from({ length: 2005 }, (_, index) => proofRow(index + 1, 700 + index));
        const made = makeSync(async (row, options) => {
            try {
                await options.fetchProof(row.snapshot_block, row.capability, [row.signing_pubkey]);
                return { verdict: 'verified' };
            } catch (error) {
                return { verdict: 'held', reason: error.message };
            }
        });
        const { sync, inserted } = made;
        syncs.push(sync);
        sync.batchApplyRows = 256;
        sinon.stub(sync, 'paceCapabilityProofRequest').resolves();
        let proofRequests = 0;
        sync.httpGet.callsFake(async path => {
            if (path.includes('/hub-db/snapshot/capability_snapshots'))
                return { schema_version: HUB_SCHEMA_VERSION, rows, watermark: 91 };
            proofRequests++;
            if (proofRequests > 8) return new Promise(() => {});
            const snapshotBlock = Number(new URL(path, 'http://example.invalid').searchParams.get('snapshot_block'));
            if (snapshotBlock >= 705) throw unavailable(503);
            return proofResponse(path);
        });
        sinon.stub(sync, 'mirrorNetworkScope').resolves(null);
        sinon.stub(sync, 'reconcileForeignCapabilitySnapshots').resolves();
        sinon.stub(sync, 'releaseSnapshotWaiters').resolves();
        const bootstrapTable = sync.bootstrapTable.bind(sync);
        const drainedTables = [];
        sinon.stub(sync, 'bootstrapTable').callsFake(async table => {
            drainedTables.push(table);
            return table === 'capability_snapshots' ? bootstrapTable(table) : 100;
        });

        const finished = await Promise.race([
            sync.bootstrapAll().then(() => true),
            new Promise(resolve => setTimeout(() => resolve(false), 1000)),
        ]);

        assert.strictEqual(finished, true, 'the capability drain must not consume the later table window');
        assert.strictEqual(proofRequests, 6, 'five proved groups and one unavailable frontier probe');
        assert.strictEqual(inserted.length, 5);
        assert.strictEqual(sync._capabilityProofHolds.size, 2000);
        assert.strictEqual(drainedTables.includes('bridge_transfers'), true);
    });

    it('retries around an unavailable middle group without stranding a newer group', async function () {
        const made = makeSync(async (row, options) => {
            try {
                await options.fetchProof(row.snapshot_block, row.capability, [row.signing_pubkey]);
                return { verdict: 'verified' };
            } catch (error) {
                return { verdict: 'held', reason: error.message };
            }
        });
        const { sync, inserted } = made;
        syncs.push(sync);
        sinon.stub(sync, 'paceCapabilityProofRequest').resolves();
        const rows = [proofRow(1, 700), proofRow(2, 701), proofRow(3, 702)];
        for (const row of rows) sync._capabilityProofHolds.set(capabilitySnapshotKey(row), row);
        let unavailableBlock = 701;
        const requested = [];
        sync.httpGet.callsFake(async path => {
            const snapshotBlock = Number(new URL(path, 'http://example.invalid').searchParams.get('snapshot_block'));
            requested.push(snapshotBlock);
            if (snapshotBlock === unavailableBlock) throw unavailable(503);
            return proofResponse(path);
        });
        const applies = sinon.spy(sync, 'applyRow');

        await sync.retryHeldCapabilityRows();

        assert.deepStrictEqual(requested, [700, 701, 702]);
        assert.strictEqual(inserted.length, 2);
        assert.strictEqual(sync._capabilityProofHolds.size, 1);
        assert.deepStrictEqual(applies.getCalls().map(call => call.args[1].snapshot_block), [700, 702]);

        unavailableBlock = null;
        requested.length = 0;
        applies.resetHistory();
        await sync.retryHeldCapabilityRows();

        assert.deepStrictEqual(requested, [701]);
        assert.strictEqual(inserted.length, 3);
        assert.strictEqual(sync._capabilityProofHolds.size, 0);
        assert.deepStrictEqual(applies.getCalls().map(call => call.args[1].snapshot_block), [701]);
    });

    it('P1 applies newer checkpointed groups when the oldest group stays 404', async function () {
        const made = makeSync(async (row, options) => {
            try {
                await options.fetchProof(row.snapshot_block, row.capability, [row.signing_pubkey]);
                return { verdict: 'verified' };
            } catch (error) {
                return { verdict: 'held', reason: error.message };
            }
        });
        const { sync, inserted } = made;
        syncs.push(sync);
        sinon.stub(sync, 'paceCapabilityProofRequest').resolves();
        const rows = [proofRow(1, 700), proofRow(2, 701), proofRow(3, 45000)];
        for (const item of rows) sync._capabilityProofHolds.set(capabilitySnapshotKey(item), item);
        const requested = [];
        sync.httpGet.callsFake(async path => {
            const snapshotBlock = Number(new URL(path, 'http://example.invalid')
                .searchParams.get('snapshot_block'));
            requested.push(snapshotBlock);
            if (snapshotBlock === 700) throw unavailable(404);
            return proofResponse(path);
        });

        await sync.retryHeldCapabilityRows();

        assert.deepStrictEqual(requested, [700, 45000, 701]);
        assert.strictEqual(inserted.length, 2);
        assert.strictEqual(sync._capabilityProofHolds.size, 1);
        assert.strictEqual(sync._capabilityProofHolds.has(capabilitySnapshotKey(rows[0])), true);
    });

    it('P2 isolates an unavailable proof frontier to its capability', async function () {
        const made = makeSync(async (row, options) => {
            try {
                await options.fetchProof(row.snapshot_block, row.capability, [row.signing_pubkey]);
                return { verdict: 'verified' };
            } catch (error) {
                return { verdict: 'held', reason: error.message };
            }
        });
        const { sync, inserted } = made;
        syncs.push(sync);
        sinon.stub(sync, 'paceCapabilityProofRequest').resolves();
        const rows = [
            proofRow(1, 700, { capability: 'attestation' }),
            proofRow(2, 700, { capability: 'cross_chain' }),
            proofRow(3, 701, { capability: 'price' }),
        ];
        for (const item of rows) sync._capabilityProofHolds.set(capabilitySnapshotKey(item), item);
        const requested = [];
        sync.httpGet.callsFake(async path => {
            const params = new URL(path, 'http://example.invalid').searchParams;
            requested.push(params.get('capability') + '@' + params.get('snapshot_block'));
            if (params.get('capability') === 'attestation') throw unavailable(503);
            return proofResponse(path);
        });

        await sync.retryHeldCapabilityRows();

        assert.deepStrictEqual(requested, ['attestation@700', 'cross_chain@700', 'price@701']);
        assert.strictEqual(inserted.length, 2);
        assert.strictEqual(sync._capabilityProofHolds.size, 1);
        assert.strictEqual(sync._capabilityProofHolds.has(capabilitySnapshotKey(rows[0])), true);
    });

    it('P3 falls back per row after a multi-pubkey 503', async function () {
        const badPubkey = 'ff'.repeat(32);
        const rows = [proofRow(1, 700), proofRow(2, 700),
            proofRow(3, 700, { signing_pubkey: badPubkey })];
        const made = makeSync(async (row, options) => {
            try {
                await options.fetchProof(row.snapshot_block, row.capability, [row.signing_pubkey]);
                return { verdict: 'verified' };
            } catch (error) {
                return { verdict: 'held', reason: error.message };
            }
        });
        const { sync, inserted } = made;
        syncs.push(sync);
        sinon.stub(sync, 'paceCapabilityProofRequest').resolves();
        sync.httpGet.callsFake(async path => {
            if (path.includes('/hub-db/snapshot/capability_snapshots'))
                return { schema_version: HUB_SCHEMA_VERSION, rows, watermark: 9 };
            const pubkeys = String(new URL(path, 'http://example.invalid')
                .searchParams.get('pubkeys')).split(',');
            if (pubkeys.includes(badPubkey)) throw unavailable(503);
            return proofResponse(path);
        });
        sinon.stub(sync, 'mirrorNetworkScope').resolves(null);
        sinon.stub(sync, 'reconcileForeignCapabilitySnapshots').resolves();
        sinon.stub(sync, 'releaseSnapshotWaiters').resolves();
        sync.batchApplyRows = 10;
        sync._bootstrapping = true;

        await sync.bootstrapTable('capability_snapshots');

        const proofPaths = sync.httpGet.getCalls().map(call => call.args[0])
            .filter(path => path.includes('capability_snapshot_proof'));
        assert.strictEqual(proofPaths.length, 4, 'one shared request plus three row fallbacks');
        assert.strictEqual(inserted.length, 2);
        assert.strictEqual(sync._capabilityProofHolds.size, 1);
        assert.strictEqual(sync._capabilityProofHolds.has(capabilitySnapshotKey(rows[2])), true);
    });

    it('R4 probes a provable group between permanent oldest and newest holes', async function () {
        const made = makeSync(async (row, options) => {
            try {
                await options.fetchProof(row.snapshot_block, row.capability, [row.signing_pubkey]);
                return { verdict: 'verified' };
            } catch (error) {
                return { verdict: 'held', reason: error.message };
            }
        });
        const { sync, inserted } = made;
        syncs.push(sync);
        sinon.stub(sync, 'paceCapabilityProofRequest').resolves();
        const rows = [proofRow(1, 700), proofRow(2, 701), proofRow(3, 702)];
        for (const item of rows) sync._capabilityProofHolds.set(capabilitySnapshotKey(item), item);
        const requested = [];
        sync.httpGet.callsFake(async path => {
            const snapshotBlock = Number(new URL(path, 'http://example.invalid')
                .searchParams.get('snapshot_block'));
            requested.push(snapshotBlock);
            if (snapshotBlock === 700) throw unavailable(404);
            if (snapshotBlock === 702) throw unavailable(503);
            return proofResponse(path);
        });

        await sync.retryHeldCapabilityRows();

        assert.deepStrictEqual(requested, [700, 702, 701]);
        assert.strictEqual(inserted.length, 1);
        assert.strictEqual(sync._capabilityProofHolds.size, 2);
        assert.strictEqual(sync._capabilityProofHolds.has(capabilitySnapshotKey(rows[1])), false);
    });

    it('R5 retries a frontier-held multi-pubkey group one row at a time after a 503', async function () {
        const badPubkey = 'ff'.repeat(32);
        const rows = [proofRow(1, 700), proofRow(2, 701), proofRow(3, 701),
            proofRow(4, 701, { signing_pubkey: badPubkey })];
        const made = makeSync(async (row, options) => {
            try {
                await options.fetchProof(row.snapshot_block, row.capability, [row.signing_pubkey]);
                return { verdict: 'verified' };
            } catch (error) {
                return { verdict: 'held', reason: error.message };
            }
        });
        const { sync, inserted } = made;
        syncs.push(sync);
        sinon.stub(sync, 'paceCapabilityProofRequest').resolves();
        sync.httpGet.callsFake(async path => {
            if (path.includes('/hub-db/snapshot/capability_snapshots'))
                return { schema_version: HUB_SCHEMA_VERSION, rows, watermark: 9 };
            const params = new URL(path, 'http://example.invalid').searchParams;
            const pubkeys = String(params.get('pubkeys')).split(',');
            if (Number(params.get('snapshot_block')) === 700) throw unavailable(404);
            if (pubkeys.includes(badPubkey)) throw unavailable(503);
            return proofResponse(path);
        });
        sinon.stub(sync, 'mirrorNetworkScope').resolves(null);
        sinon.stub(sync, 'reconcileForeignCapabilitySnapshots').resolves();
        sinon.stub(sync, 'releaseSnapshotWaiters').resolves();
        sync.batchApplyRows = 10;
        sync._bootstrapping = true;

        await sync.bootstrapTable('capability_snapshots');

        assert.strictEqual(inserted.length, 0, 'the frontier holds every newer row untried');
        assert.strictEqual(sync._capabilityProofHolds.size, 4);
        const beforeRetry = sync.httpGet.callCount;

        await sync.retryHeldCapabilityRows();

        const retryPubkeys = sync.httpGet.getCalls().slice(beforeRetry)
            .map(call => String(new URL(call.args[0], 'http://example.invalid')
                .searchParams.get('pubkeys')).split(','));
        assert.deepStrictEqual(retryPubkeys, [
            [rows[0].signing_pubkey],
            [rows[1].signing_pubkey, rows[2].signing_pubkey, badPubkey],
            [rows[1].signing_pubkey],
            [rows[2].signing_pubkey],
            [badPubkey],
        ]);
        assert.strictEqual(inserted.length, 2);
        assert.strictEqual(sync._capabilityProofHolds.size, 2);
        assert.strictEqual(sync._capabilityProofHolds.has(capabilitySnapshotKey(rows[1])), false);
        assert.strictEqual(sync._capabilityProofHolds.has(capabilitySnapshotKey(rows[2])), false);
        assert.strictEqual(sync._capabilityProofHolds.has(capabilitySnapshotKey(rows[3])), true);
    });

    it('R6 drains every group between two permanent holes within the rotating probe bound',
        async function () {
        const middleProbeGroupsPerPass = 12;
        const middleGroupCount = 1998;
        const passCount = Math.ceil(middleGroupCount / middleProbeGroupsPerPass);
        const made = makeSync(async (row, options) => {
            try {
                await options.fetchProof(row.snapshot_block, row.capability, [row.signing_pubkey]);
                return { verdict: 'verified' };
            } catch (error) {
                return { verdict: 'held', reason: error.message };
            }
        });
        const { sync, inserted } = made;
        syncs.push(sync);
        sinon.stub(sync, 'paceCapabilityProofRequest').resolves();
        const rows = Array.from({ length: 2000 }, (_, index) => proofRow(index + 1, 700 + index));
        for (const item of rows) sync._capabilityProofHolds.set(capabilitySnapshotKey(item), item);
        sync.httpGet.callsFake(async path => {
            const snapshotBlock = Number(new URL(path, 'http://example.invalid')
                .searchParams.get('snapshot_block'));
            if (snapshotBlock === 700 || snapshotBlock === 2699) throw unavailable(503);
            return proofResponse(path);
        });
        const requestsPerPass = [];

        for (let pass = 0; pass < passCount; pass++) {
            const before = sync.httpGet.callCount;
            await sync.retryHeldCapabilityRows();
            requestsPerPass.push(sync.httpGet.callCount - before);
        }

        assert.strictEqual(passCount, 167);
        assert.deepStrictEqual(requestsPerPass.slice(0, -1), Array(166).fill(14));
        assert.strictEqual(requestsPerPass[requestsPerPass.length - 1], 8);
        assert.strictEqual(inserted.length, middleGroupCount);
        assert.strictEqual(sync._capabilityProofHolds.size, 2);
        assert.strictEqual(sync._capabilityProofHolds.has(capabilitySnapshotKey(rows[0])), true);
        assert.strictEqual(sync._capabilityProofHolds.has(capabilitySnapshotKey(rows[1999])), true);
    });

    it('does not treat a proof response mismatch as not yet available', async function () {
        const made = makeSync(async (row, options) => {
            await options.fetchProof(row.snapshot_block, row.capability, [row.signing_pubkey]);
            if (row.snapshot_block === 700) return {
                verdict: 'held',
                reason: 'capability snapshot proof response is for another snapshot',
            };
            return { verdict: 'verified' };
        });
        const { sync, inserted } = made;
        syncs.push(sync);
        sinon.stub(sync, 'paceCapabilityProofRequest').resolves();
        const rows = [proofRow(1, 700), proofRow(2, 701)];
        for (const row of rows) sync._capabilityProofHolds.set(capabilitySnapshotKey(row), row);
        const requested = [];
        sync.httpGet.callsFake(async path => {
            requested.push(Number(new URL(path, 'http://example.invalid').searchParams.get('snapshot_block')));
            return proofResponse(path);
        });

        await sync.retryHeldCapabilityRows();

        assert.deepStrictEqual(requested, [700, 701]);
        assert.strictEqual(inserted.length, 1);
        assert.strictEqual(sync._capabilityProofHolds.size, 1);
        assert.strictEqual(sync._capabilityProofHolds.has(capabilitySnapshotKey(rows[0])), true);
    });

    it('classifies only 404, 503, checkpoint-missing, proof-unavailable and indexer-behind holds as not yet available',
        function () {
            const made = makeSync(async () => ({ verdict: 'verified' }));
            const { sync } = made;
            syncs.push(sync);

            for (const value of [
                unavailable(404),
                unavailable(503),
                { verdict: 'held', reason: 'SNAPSHOT_NOT_YET_CHECKPOINTED' },
                { verdict: 'held', reason: 'PROOF_UNAVAILABLE' },
                { verdict: 'held', reason: 'INDEXER_BEHIND_CHECKPOINT' },
                { verdict: 'held', reason: 'block_index 700 not yet indexed (latest: 699)' },
            ]) assert.strictEqual(sync.capabilityProofNotYetAvailable(value), true);

            for (const reason of [
                'HTTP 429',
                'capability snapshot proof response is for another snapshot',
                'capability stake member proof is invalid',
                'capability stake amount does not match snapshot row',
            ]) assert.strictEqual(sync.capabilityProofNotYetAvailable({ verdict: 'held', reason }), false);
        });

    it('re-serves and later applies a held row after a restart with persisted local rows', async function () {
        let verdict = 'held';
        const persistent = persistentMirror(7);
        const beforeRestart = makeSync(async () => ({ verdict }), persistent);
        syncs.push(beforeRestart.sync);
        beforeRestart.sync._drainPositions.capability_snapshots = ROW.id - 1;
        beforeRestart.sync.httpGet.callsFake(async path => path.includes('/hub-db/snapshot/capability_snapshots')
            ? { schema_version: HUB_SCHEMA_VERSION, rows: [ROW], watermark: 90 }
            : { proof: 'ok' });
        sinon.stub(beforeRestart.sync, 'mirrorNetworkScope').resolves(null);
        sinon.stub(beforeRestart.sync, 'reconcileForeignCapabilitySnapshots').resolves();
        sinon.stub(beforeRestart.sync, 'releaseSnapshotWaiters').resolves();
        beforeRestart.sync._bootstrapping = true;
        assert.strictEqual(await beforeRestart.sync.bootstrapTable('capability_snapshots'), 90);
        beforeRestart.sync._bootstrapping = false;
        assert.strictEqual(beforeRestart.inserted.length, 0);
        assert.strictEqual(beforeRestart.sync._drainPositions.capability_snapshots, ROW.id);
        stopRetry(beforeRestart.sync);

        const afterRestart = makeSync(async () => ({ verdict }), persistent);
        const { sync, inserted } = afterRestart;
        syncs.push(sync);
        assert.notStrictEqual(sync, beforeRestart.sync);
        assert.strictEqual(sync._drainPositions.capability_snapshots, undefined);
        assert.strictEqual(sync._capabilityProofHolds.size, 0);
        sync.httpGet.callsFake(async path => path.includes('/hub-db/snapshot/capability_snapshots')
            ? { schema_version: HUB_SCHEMA_VERSION, rows: [ROW], watermark: 91 }
            : { proof: 'ok' });
        sinon.stub(sync, 'mirrorNetworkScope').resolves(null);
        sinon.stub(sync, 'reconcileForeignCapabilitySnapshots').resolves();
        sinon.stub(sync, 'releaseSnapshotWaiters').resolves();

        sync._bootstrapping = true;
        assert.strictEqual(await sync.bootstrapTable('capability_snapshots'), 91);
        sync._bootstrapping = false;
        const snapshotCall = sync.httpGet.getCalls().find(call =>
            call.args[0].includes('/hub-db/snapshot/capability_snapshots'));
        assert.ok(snapshotCall.args[0].includes('since_id=0'), snapshotCall.args[0]);
        assert.strictEqual(persistent.hubDb.doQuery.calledWithMatch(
            sinon.match(/^SELECT MAX\(id\) AS max_id FROM capability_snapshots/)), true);
        assert.strictEqual(inserted.length, 0);
        assert.strictEqual(sync._capabilityProofHolds.size, 1);

        verdict = 'verified';
        await sync.retryHeldCapabilityRows();

        assert.strictEqual(inserted.length, 1);
        assert.strictEqual(sync._capabilityProofHolds.size, 0);
        assert.strictEqual(sync.capabilityProofSatisfied(), true);
    });
});
