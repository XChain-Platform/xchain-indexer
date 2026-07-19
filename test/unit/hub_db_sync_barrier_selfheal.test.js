// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// ITEM 2492: the price barriers (waitForPriceSyncHeight/waitForPriceSyncTime)
// self-heal on timeout: their timeout handler re-reads the local mirror before
// rejecting, so a block deferred only because the in-memory scalar froze behind a
// mirror that is actually current resolves instead of timing out. The sibling
// barriers (oracle, match, call) rejected DIRECTLY without that self-heal, so the
// same stale-scalar condition wedged a healthy mirror for the full timeout on every
// block. The snapshot barrier (set-dependent, live-query) rejected without a final
// re-evaluation too. Each barrier's timeout handler now re-checks satisfaction
// against the refreshed mirror and resolves if caught up.

const assert = require('assert');
const sinon = require('sinon');

const HubDbSync = require('../../src/hub_db_sync.js');

describe('HubDbSync barrier timeout self-heal (ITEM 2492) @regression @tier2', function () {

    it('oracle: stale in-memory scalar + current mirror => waiter resolves at timeout, not rejects', async function () {
        // Mirror MAX(effective_at) is current (1600), but the in-memory scalar is frozen
        // behind the target (500). Before the fix the timeout rejected; now it re-reads.
        const doQuery = sinon.stub().callsFake(async () => [{ ts: 1600 }]);
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        sync.oracleBootstrapped  = true;
        sync.oracleSyncTimestamp = 500;                 // stale, behind the target block time
        const got = await sync.waitForOracleSyncTimestamp(1500, 50);
        assert.strictEqual(got, 1600, 'timeout path must adopt the caught-up mirror timestamp');
        assert.strictEqual(sync._oracleWaiters.length, 0, 'self-healed waiter should be cleared');
    });

    it('oracle: still REJECTS on timeout when the mirror genuinely stays behind', async function () {
        const doQuery = sinon.stub().callsFake(async () => [{ ts: 500 }]);
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        sync.oracleBootstrapped  = true;
        sync.oracleSyncTimestamp = 500;
        await assert.rejects(sync.waitForOracleSyncTimestamp(1500, 50), /oracle sync barrier timed out/);
        assert.strictEqual(sync._oracleWaiters.length, 0, 'timed-out waiter should be removed');
    });

    it('match: stale in-memory scalar + current mirror => waiter resolves at timeout, not rejects', async function () {
        const doQuery = sinon.stub().callsFake(async () => [{ ts: 1600 }]);
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        sync.matchBootstrapped  = true;
        sync.matchSyncTimestamp = 500;
        const got = await sync.waitForMatchSync(1500, 50);
        assert.strictEqual(got, 1600, 'timeout path must adopt the caught-up match mirror timestamp');
        assert.strictEqual(sync._matchWaiters.length, 0, 'self-healed waiter should be cleared');
    });

    it('match: still REJECTS on timeout when the mirror genuinely stays behind', async function () {
        const doQuery = sinon.stub().callsFake(async () => [{ ts: 500 }]);
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        sync.matchBootstrapped  = true;
        sync.matchSyncTimestamp = 500;
        await assert.rejects(sync.waitForMatchSync(1500, 50), /match sync barrier timed out/);
        assert.strictEqual(sync._matchWaiters.length, 0, 'timed-out waiter should be removed');
    });

    it('call: stale in-memory scalar + current mirror => waiter resolves at timeout, not rejects', async function () {
        const doQuery = sinon.stub().callsFake(async () => [{ ts: 1600 }]);
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        sync.callBootstrapped  = true;
        sync.callSyncTimestamp = 500;
        const got = await sync.waitForCallSync(1500, 50);
        assert.strictEqual(got, 1600, 'timeout path must adopt the caught-up call mirror timestamp');
        assert.strictEqual(sync._callWaiters.length, 0, 'self-healed waiter should be cleared');
    });

    it('call: still REJECTS on timeout when the mirror genuinely stays behind', async function () {
        const doQuery = sinon.stub().callsFake(async () => [{ ts: 500 }]);
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        sync.callBootstrapped  = true;
        sync.callSyncTimestamp = 500;
        await assert.rejects(sync.waitForCallSync(1500, 50), /call sync barrier timed out/);
        assert.strictEqual(sync._callWaiters.length, 0, 'timed-out waiter should be removed');
    });

    it('snapshot: a snapshot that mirrored in without an event => waiter resolves at timeout, not rejects', async function () {
        // Set-dependent barrier: initially a finalized match is missing its capability
        // snapshot (the match query returns a row => unsatisfied). The snapshot then
        // mirrors in with no cross-chain event to release the waiter; the timeout
        // handler re-evaluates and resolves instead of rejecting.
        let hasSnapshot = false;
        const doQuery = sinon.stub().callsFake(async (sql) => {
            if (/cross_chain_matches/.test(sql)) return hasSnapshot ? [] : [{ '1': 1 }];
            return [];                                   // cross_chain_calls: nothing missing
        });
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test', coin: 'BTC' });
        const pending = sync.waitForSnapshotSync(1000, 60);
        await new Promise((r) => setImmediate(r));       // let the entry check arm the waiter
        assert.strictEqual(sync._snapshotWaiters.length, 1, 'waiter armed while the snapshot is absent');
        hasSnapshot = true;                              // snapshot mirrors in, no event fires
        const got = await pending;
        assert.strictEqual(got, true, 'timeout path must resolve once the snapshot is present');
        assert.strictEqual(sync._snapshotWaiters.length, 0, 'self-healed waiter should be cleared');
    });

    it('snapshot: still REJECTS on timeout when the snapshot stays missing', async function () {
        const doQuery = sinon.stub().callsFake(async (sql) => {
            if (/cross_chain_matches/.test(sql)) return [{ '1': 1 }];   // always missing
            return [];
        });
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test', coin: 'BTC' });
        await assert.rejects(sync.waitForSnapshotSync(1000, 50), /snapshot sync barrier timed out/);
        assert.strictEqual(sync._snapshotWaiters.length, 0, 'timed-out waiter should be removed');
    });
});
