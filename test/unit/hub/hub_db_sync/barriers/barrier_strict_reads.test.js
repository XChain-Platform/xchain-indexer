// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Barrier and watermark reads of the hub mirror fail closed on a query error. The double's
// doQuery answers [] the way the shared Db wrapper swallows a non-transactional error, and
// its doQueryStrict throws, so a barrier still reading through doQuery would open.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const HubDbSync = require('../../../../../src/hub/hub_db_sync.js');

const T = 1000;
const B = 1000;
const PRIOR_TS = 500;

// Build a sync whose strict read throws while its lenient read swallows to [].
function faultingSync() {
    const fault = Object.assign(new Error('lock wait timeout'), { errno: 1205 });
    const hubDb = { doQuery: async () => [], doQueryStrict: async () => { throw fault; } };
    const sync = new HubDbSync(hubDb, { hubUrl: 'http://hub.test', coin: 'BTC', network: 'regtest' });
    sync._mirrorTableMemo = {
        bridge_transfers: { present: true, at: Date.now() },
        policy_snapshots: { present: true, at: Date.now() },
        list_snapshots:   { present: true, at: Date.now() },
    };
    return sync;
}

describe('hub mirror barrier reads fail closed on a query error @regression @tier1', function () {
    it('the snapshot presence barrier stays shut when the mirror read throws', async function () {
        assert.strictEqual(await faultingSync().snapshotSyncSatisfied(T, B), false);
    });

    for (const [table, refresh, field, flag] of [
        ['oracle_prices', 'refreshOracleSyncTimestamp', 'oracleSyncTimestamp', 'oracleBootstrapped'],
        ['cross_chain_matches', 'refreshMatchSyncTimestamp', 'matchSyncTimestamp', 'matchBootstrapped'],
        ['cross_chain_calls', 'refreshCallSyncTimestamp', 'callSyncTimestamp', 'callBootstrapped'],
        ['bridge_transfers', 'refreshBridgeSyncTimestamp', 'bridgeSyncTimestamp', 'bridgeBootstrapped'],
        ['policy_snapshots', 'refreshPolicySyncTimestamp', 'policySyncTimestamp', 'policyBootstrapped'],
    ]) {
        it(`a failed ${table} watermark read keeps the prior watermark instead of the empty-mirror value`, async function () {
            const sync = faultingSync();
            sync[flag] = true;
            sync[field] = PRIOR_TS;
            await sync[refresh](true);
            assert.strictEqual(sync[field], PRIOR_TS);
        });
    }

    it('a failed list-share read leaves the mirror-empty flag untouched', async function () {
        const sync = faultingSync();
        sync.listShareMirrorEmpty = false;
        await sync.refreshListShareSyncState(true);
        assert.strictEqual(sync.listShareMirrorEmpty, false);
    });

    it('a failed price read leaves the synced height untouched', async function () {
        const sync = faultingSync();
        sync.priceSyncHeight = 100;
        await sync.refreshPriceSyncHeight();
        assert.strictEqual(sync.priceSyncHeight, 100);
    });
});

describe('hub mirror barrier reads fail closed on a query error @regression @tier1', function () {
    // The explorer's HubMirrorPool exposes doQuery only, and its doQuery already throws.
    const poolSync = (doQuery) => new HubDbSync({ doQuery },
        { hubUrl: 'http://hub.test', coin: 'BTC', network: 'regtest' });

    it('a doQuery-only pool still answers an empty mirror as satisfied', async function () {
        assert.strictEqual(await poolSync(async () => []).snapshotSyncSatisfied(T, B), true);
    });

    it('a doQuery-only pool that throws keeps the snapshot barrier shut', async function () {
        const sync = poolSync(async () => { throw new Error('pool down'); });
        assert.strictEqual(await sync.snapshotSyncSatisfied(T, B), false);
    });
});
