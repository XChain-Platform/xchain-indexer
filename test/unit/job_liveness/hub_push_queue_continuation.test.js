// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const HubPushQueue = require('../../../src/hub/hub_push_queue.js');
const HubPushDeliveryStore = require('../../../src/db/hub_pushes/hub_push_delivery_store.js');
const { makeIndexer, makeRow } = require('../hub/hub_push_queue.test/helpers/fixtures.js');

function deferred() {
    let resolve;
    const promise = new Promise(ok => { resolve = ok; });
    return { promise, resolve };
}

describe('HubPushQueue backlog continuation', function () {
    let clock;

    beforeEach(function () { clock = sinon.useFakeTimers(); });
    afterEach(function () { clock.restore(); sinon.restore(); });

    it('uses the short delay only after a fully delivered full batch', async function () {
        const q = new HubPushQueue(makeIndexer(), { intervalMs: 1000, continueDelayMs: 50 });
        const tick = sinon.stub(q, 'drainAndLog');
        tick.onFirstCall().resolves({ more: true });
        tick.resolves();

        q.start();
        await clock.tickAsync(1000);
        assert.strictEqual(tick.callCount, 1);
        await clock.tickAsync(49);
        assert.strictEqual(tick.callCount, 1);
        await clock.tickAsync(1);
        assert.strictEqual(tick.callCount, 2);
        q.stop();
    });

    it('keeps the normal cadence when a drain does not report more work', async function () {
        const q = new HubPushQueue(makeIndexer(), { intervalMs: 1000, continueDelayMs: 50 });
        const tick = sinon.stub(q, 'drainAndLog').resolves();

        q.start();
        await clock.tickAsync(1000);
        await clock.tickAsync(999);
        assert.strictEqual(tick.callCount, 1);
        await clock.tickAsync(1);
        assert.strictEqual(tick.callCount, 2);
        q.stop();
    });

    it('does not re-arm after stop while a drain is still in flight', async function () {
        const gate = deferred();
        const q = new HubPushQueue(makeIndexer(), { intervalMs: 1000, continueDelayMs: 50 });
        const tick = sinon.stub(q, 'drainAndLog').returns(gate.promise);

        q.start();
        await clock.tickAsync(1000);
        q.stop();
        gate.resolve({ more: true });
        await clock.tickAsync(5000);
        assert.strictEqual(tick.callCount, 1);
        assert.strictEqual(q.timer, null);
    });

    it('keeps one timer chain when restarted while an older drain is settling', async function () {
        const gate = deferred();
        const q = new HubPushQueue(makeIndexer(), { intervalMs: 1000, continueDelayMs: 50 });
        const tick = sinon.stub(q, 'drainAndLog');
        tick.onFirstCall().returns(gate.promise);
        tick.resolves();

        q.start();
        await clock.tickAsync(1000);
        assert.strictEqual(tick.callCount, 1);
        q.stop();
        q.start();
        gate.resolve({ more: true });
        await clock.tickAsync(0);
        assert.strictEqual(clock.countTimers(), 1);
        await clock.tickAsync(1000);
        assert.strictEqual(tick.callCount, 2);
        assert.strictEqual(clock.countTimers(), 1);
        await clock.tickAsync(1000);
        assert.strictEqual(tick.callCount, 3);
        q.stop();
        assert.strictEqual(clock.countTimers(), 0);
    });

    it('keeps the chain alive when a tick rejects', async function () {
        const q = new HubPushQueue(makeIndexer(), { intervalMs: 1000, continueDelayMs: 50 });
        const tick = sinon.stub(q, 'drainAndLog');
        tick.onFirstCall().rejects(new Error('tick failed'));
        tick.resolves();

        q.start();
        await clock.tickAsync(2000);
        assert.strictEqual(tick.callCount, 2);
        q.stop();
    });

    it('reports more only when every row in a full batch was delivered', async function () {
        const indexer = makeIndexer();
        const rows = [makeRow({ id: 1 }), makeRow({ id: 2 })];
        indexer.indexerDb.getPendingHubPushes.resolves(rows);
        const q = new HubPushQueue(indexer, { batchSize: 2, failedRetentionSec: 0 });
        sinon.stub(q, 'attempt');
        q.attempt.onCall(0).resolves(true);
        q.attempt.onCall(1).resolves(true);
        q.attempt.onCall(2).resolves(true);
        q.attempt.onCall(3).resolves(false);

        assert.deepStrictEqual(await q.drain(), { more: true });
        assert.strictEqual(await q.drain(), undefined);
    });

    it('does not continue when a due-row recheck skips a row', async function () {
        const indexer = makeIndexer();
        indexer.indexerDb.getPendingHubPushes.resolves([
            makeRow({ id: 1 }), makeRow({ id: 2 })
        ]);
        const q = new HubPushQueue(indexer, { batchSize: 2, failedRetentionSec: 0 });
        sinon.stub(q.hubPushDeliveries, 'isDueAfterMove').onFirstCall().resolves(false).onSecondCall().resolves(true);
        sinon.stub(q, 'attempt').resolves(true);

        assert.strictEqual(await q.drain(), undefined);
        assert.strictEqual(q.attempt.callCount, 1);
    });

    it('returns delivery state from both single-hub and fan-out attempts', async function () {
        const q = new HubPushQueue(makeIndexer(), { failedRetentionSec: 0 });
        assert.strictEqual(await q.attempt(makeRow()), true);

        const indexerDb = {
            poolQuery: sinon.stub(),
            markHubPushDelivered: sinon.stub().resolves()
        };
        indexerDb.poolQuery.onFirstCall().resolves([{ delivered_to: '[]' }]);
        indexerDb.poolQuery.onSecondCall().resolves({ affectedRows: 1 });
        const queue = {
            indexerDb,
            hubClient: {},
            indexer: {},
            parseHubPushPayload: async () => ({ payload: {} }),
            deliverHubPush: async () => true,
            recordHubPushFailure: async () => {}
        };
        const store = new HubPushDeliveryStore(queue, { status: () => ({ candidates: ['a'] }) });
        assert.strictEqual(await store.attempt(makeRow(), ['a']), true);

        const refusal = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
        const limited = Object.assign(new Error('hold'), { rateLimited: true, retryAfterMs: 30000 });
        indexerDb.poolQuery.resetHistory();
        indexerDb.poolQuery.onFirstCall().resolves([{ delivered_to: '[]' }]);
        queue.deliverHubPush = sinon.stub();
        queue.deliverHubPush.onFirstCall().rejects(refusal);
        queue.deliverHubPush.onSecondCall().rejects(limited);
        queue.recordHubPushFailure = sinon.stub().resolves();
        const held = new HubPushDeliveryStore(queue, { status: () => ({ candidates: ['a', 'b', 'c'] }) });
        assert.strictEqual(await held.attempt(makeRow(), ['a', 'b', 'c']), false);
        assert.strictEqual(queue.deliverHubPush.callCount, 2, 'fan-out stops at the rate-limited hub');
        assert.strictEqual(queue.recordHubPushFailure.firstCall.args[1], limited,
            'the rate limit reaches the queue even after an earlier refusal');
    });
});
