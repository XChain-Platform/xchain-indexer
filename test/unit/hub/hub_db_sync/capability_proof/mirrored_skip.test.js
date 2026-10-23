// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A restarted indexer pages capability_snapshots from id 0 over its intact mirror DB.
// Rows whose key the mirror already holds are not proven again (INSERT IGNORE would not
// write them), so the page costs no proof fetch for them; a key the mirror lacks, as
// after a local rollback, is judged and held exactly as before.

'use strict';

const assert = require('assert');
const sinon = require('sinon');

const HubDbSync = require('../../../../../src/hub/hub_db_sync.js');
const { HUB_SCHEMA_VERSION } = require('../../../../../src/hub/hub_schema_version.js');

const COLUMNS = ['id', 'snapshot_block', 'capability', 'signing_pubkey', 'amount', 'source'];

function snapshotRow(id, pubkey) {
    return { id: id, snapshot_block: 700, capability: 'cross_chain', signing_pubkey: pubkey,
             amount: '25.00000000', source: 'validator/' + pubkey };
}

const A = Object.freeze(snapshotRow(11, 'aa11'));
const B = Object.freeze(snapshotRow(12, 'bb22'));
const C = Object.freeze(snapshotRow(13, 'cc33'));

function keyOf(row) {
    return [row.snapshot_block, row.capability, row.signing_pubkey, row.source == null ? '' : row.source]
        .map(v => String(v).toLowerCase()).join('|');
}

// The local mirror DB that survives the restart: INSERT IGNORE on the natural key, the
// presence read by that key, and the MAX(id) the drain records before its first page.
function localMirror(rows) {
    const mirror = { rows: rows.map(row => Object.assign({}, row)), inserts: [] };
    mirror.presenceAnswer = null;
    mirror.hubDb = {
        doQuery: sinon.stub().callsFake(async (sql, args) => {
            if (/^INSERT IGNORE INTO capability_snapshots/.test(sql)) {
                const cols = sql.match(/\(([^)]*)\) VALUES/)[1].split(', ');
                const row = {};
                cols.forEach((col, i) => { row[col] = args[i]; });
                mirror.inserts.push(row);
                if (mirror.rows.some(local => keyOf(local) === keyOf(row))) return { affectedRows: 0 };
                mirror.rows.push(row);
                return { affectedRows: 1 };
            }
            if (/^SELECT snapshot_block, capability, signing_pubkey, source FROM capability_snapshots WHERE/.test(sql)) {
                if (mirror.presenceAnswer) return mirror.presenceAnswer;
                const wanted = keyOf({ snapshot_block: args[0], capability: args[1],
                                       signing_pubkey: args[2], source: args[3] });
                return mirror.rows.filter(local => keyOf(local) === wanted).slice(0, 1);
            }
            if (/^SELECT MAX\(id\) AS max_id FROM capability_snapshots/.test(sql))
                return [{ max_id: mirror.rows.length }];
            return [];
        })
    };
    return mirror;
}

// A freshly constructed client over `mirror`, as after a process restart: no drain
// position and no hold map. `verdictFor` decides each judged row; every judgement
// fetches its proof through the hub, as a mirror-resolved chain's judge does.
function restartedSync(mirror, verdictFor, servedRows) {
    const judged = [];
    const authoritativeDb = {
        verifyCapabilitySnapshotRow: sinon.stub().callsFake(async (row, options) => {
            judged.push(row.signing_pubkey);
            await options.fetchProof(row.snapshot_block, row.capability, [row.signing_pubkey]);
            return { verdict: verdictFor(row) };
        })
    };
    const sync = new HubDbSync(mirror.hubDb, {
        hubUrl: 'http://hub.test', network: 'regtest', authoritativeDb: authoritativeDb
    });
    sinon.stub(sync, 'localColumns').resolves(new Set(COLUMNS));
    sinon.stub(sync, 'httpGet').callsFake(async path => path.includes('/hub-db/snapshot/capability_snapshots')
        ? { schema_version: HUB_SCHEMA_VERSION, rows: servedRows, watermark: 91 }
        : { proof: 'ok' });
    sinon.stub(sync, 'mirrorNetworkScope').resolves(null);
    sinon.stub(sync, 'reconcileForeignCapabilitySnapshots').resolves();
    sinon.stub(sync, 'releaseSnapshotWaiters').resolves();
    return { sync, judged };
}

function proofFetches(sync) {
    return sync.httpGet.getCalls().filter(call => call.args[0].includes('capability_snapshot_proof')).length;
}

function snapshotPages(sync) {
    return sync.httpGet.getCalls().map(call => call.args[0])
        .filter(path => path.includes('/hub-db/snapshot/capability_snapshots'));
}

async function drainOnce(sync) {
    sync._bootstrapping = true;
    try {
        return await sync.bootstrapTable('capability_snapshots');
    } finally {
        sync._bootstrapping = false;
    }
}

// The clients a suite made, with their proof retry timers stopped after each test.
function trackSyncs() {
    const syncs = [];
    afterEach(function () {
        for (const sync of syncs) {
            if (sync._capabilityProofRetryTimer !== null) clearTimeout(sync._capabilityProofRetryTimer);
            sync._capabilityProofRetryTimer = null;
        }
        syncs.length = 0;
        sinon.restore();
    });
    return syncs;
}

describe('capability snapshot re-page after a restart skips rows already mirrored @regression @tier1', function () {
    const syncs = trackSyncs();

    it('pages from id 0 over an intact mirror and proves only the row it lacks', async function () {
        const mirror = localMirror([A, B]);
        const { sync, judged } = restartedSync(mirror, () => 'verified', [A, B, C]);
        syncs.push(sync);
        assert.strictEqual(sync._drainPositions.capability_snapshots, undefined);

        assert.strictEqual(await drainOnce(sync), 91);

        assert.ok(snapshotPages(sync)[0].includes('since_id=0'), 'the restart still pages from id 0');
        assert.deepStrictEqual(judged, ['cc33'], 'only the unmirrored row is judged');
        assert.strictEqual(proofFetches(sync), 1, 'no proof fetch for rows already mirrored');
        assert.strictEqual(mirror.rows.length, 3);
        assert.strictEqual(sync._drainPositions.capability_snapshots, C.id);
        assert.strictEqual(sync.capabilityProofSatisfied(), true);
    });

    it('judges every row a rolled-back local mirror no longer holds', async function () {
        const mirror = localMirror([A]);
        const { sync, judged } = restartedSync(mirror, () => 'verified', [A, B, C]);
        syncs.push(sync);

        assert.strictEqual(await drainOnce(sync), 91);

        assert.deepStrictEqual(judged, ['bb22', 'cc33']);
        assert.strictEqual(proofFetches(sync), 2);
        assert.strictEqual(mirror.rows.length, 3);
    });

    it('still holds and later applies an unmirrored frontier row re-served after the restart', async function () {
        let frontier = 'held';
        const mirror = localMirror([A]);
        const { sync, judged } = restartedSync(mirror,
            row => (row.signing_pubkey === 'bb22' ? frontier : 'verified'), [A, B]);
        syncs.push(sync);

        assert.strictEqual(await drainOnce(sync), 91);

        assert.deepStrictEqual(judged, ['bb22'], 'the mirrored predecessor is not judged');
        assert.strictEqual(mirror.rows.length, 1, 'the held row stays out of the mirror');
        assert.strictEqual(sync._capabilityProofHolds.size, 1);
        assert.strictEqual(sync.capabilityProofSatisfied(), false, 'the block loop still waits on it');

        frontier = 'verified';
        await sync.retryHeldCapabilityRows();

        assert.strictEqual(mirror.rows.length, 2);
        assert.strictEqual(sync.capabilityProofSatisfied(), true);
    });
});

describe('capability snapshot judge skips a key the mirror already holds @regression @tier1', function () {
    const syncs = trackSyncs();

    it('judges a row when the presence read answers with a different key', async function () {
        const mirror = localMirror([]);
        mirror.presenceAnswer = [{ snapshot_block: 700, capability: 'cross_chain',
                                   signing_pubkey: 'ff99', source: 'validator/ff99' }];
        const { sync, judged } = restartedSync(mirror, () => 'verified', [A]);
        syncs.push(sync);

        assert.strictEqual(await sync.applyRow('capability_snapshots', A), undefined);

        assert.deepStrictEqual(judged, ['aa11']);
        assert.strictEqual(mirror.rows.length, 1);
    });

    it('clears a hold without a proof fetch once the held key is mirrored', async function () {
        const mirror = localMirror([]);
        const { sync, judged } = restartedSync(mirror, () => 'held', [B]);
        syncs.push(sync);

        assert.strictEqual(await sync.applyRow('capability_snapshots', B), false);
        assert.strictEqual(sync.capabilityProofSatisfied(), false);
        const waiting = sync.waitForCapabilityProof(2000);

        mirror.rows.push(Object.assign({}, B));
        assert.strictEqual(await sync.applyRow('capability_snapshots', B), undefined);
        await waiting;

        assert.deepStrictEqual(judged, ['bb22'], 'the redelivery is not judged again');
        assert.strictEqual(proofFetches(sync), 1);
        assert.strictEqual(sync.capabilityProofSatisfied(), true);
        assert.strictEqual(mirror.rows.length, 1);
    });

    it('a retained-hold retry settles a now-mirrored key without a proof fetch', async function () {
        const mirror = localMirror([]);
        const { sync, judged } = restartedSync(mirror, () => 'held', [B]);
        syncs.push(sync);
        await sync.applyRow('capability_snapshots', B);
        mirror.rows.push(Object.assign({}, B));

        await sync.retryHeldCapabilityRows();

        assert.deepStrictEqual(judged, ['bb22']);
        assert.strictEqual(proofFetches(sync), 1);
        assert.strictEqual(sync._capabilityProofHolds.size, 0);
        assert.strictEqual(sync.capabilityProofSatisfied(), true);
    });
});
