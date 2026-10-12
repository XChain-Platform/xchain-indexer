// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const HubDbSync = require('../../../src/hub/hub_db_sync.js');

const TABLES = ['bridge_transfers', 'policy_snapshots'];

function makeSync() {
    return new HubDbSync({ doQuery: sinon.stub().resolves([]) }, { hubUrl: 'http://hub-a.test', network: 'regtest' });
}

describe('hub mirror ready-frame ceilings for bridge_transfers and policy_snapshots @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    for (const table of TABLES) {
        describe(table, function () {
            it('adopts the ceiling the ready frame advertises', function () {
                const sync = makeSync();
                sync.adoptReadyFrame({}, { type: 'ready', max_ids: { [table]: 42 } });
                assert.strictEqual(sync.readyCeilingFor(table), 42);
            });

            it('accepts a zero ceiling for an empty hub table', function () {
                const sync = makeSync();
                sync._readyMaxIds = { [table]: 0 };
                assert.strictEqual(sync.readyCeilingFor(table), 0);
            });

            it('has no ceiling when the key is absent or the frame carries no max_ids', function () {
                const sync = makeSync();
                sync._readyMaxIds = { price_snapshots: 9 };
                assert.ok(Number.isNaN(sync.readyCeilingFor(table)));
                sync._readyMaxIds = undefined;
                assert.ok(Number.isNaN(sync.readyCeilingFor(table)));
            });

            for (const bad of [null, '', '7', true, -1, 1.5, NaN, Infinity, {}, []]) {
                it('refuses the untrustworthy ceiling ' + String(JSON.stringify(bad)) + ' (' + typeof bad + ')', function () {
                    const sync = makeSync();
                    sync._readyMaxIds = { [table]: bad };
                    assert.ok(Number.isNaN(sync.readyCeilingFor(table)));
                });
            }

            it('keeps a resumed position when the ceiling is not trustworthy', async function () {
                const sync = makeSync();
                sync._drainPositions[table] = 30;
                sync._readyMaxIds = { [table]: null };
                const cursor = await sync.resolveDrainCursor(table, null);
                assert.strictEqual(cursor.lastId, 30);
                assert.ok(Number.isNaN(cursor.readyCeiling));
            });

            it('re-pages from zero when the position sits above the advertised ceiling', async function () {
                const sync = makeSync();
                sync._drainPositions[table] = 30;
                sync._readyMaxIds = { [table]: 12 };
                const cursor = await sync.resolveDrainCursor(table, null);
                assert.strictEqual(cursor.lastId, 0);
                assert.strictEqual(cursor.readyCeiling, 12);
                assert.strictEqual(sync._drainPositions[table], 0);
            });

            it('keeps a position at or below the advertised ceiling', async function () {
                const sync = makeSync();
                sync._drainPositions[table] = 12;
                sync._readyMaxIds = { [table]: 12 };
                const cursor = await sync.resolveDrainCursor(table, null);
                assert.strictEqual(cursor.lastId, 12);
            });
        });
    }
});
