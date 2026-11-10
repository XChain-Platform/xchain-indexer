// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A hub that paces its snapshot pages can hold one page in flight longer than a short
// hold ceiling. The ceiling times row progress, so without a page-age allowance the
// forced resync replaced a drain that was only waiting on the hub, and dropped the price
// re-page floor so the next drain restarted from id 0. A page in flight under its age cap
// is spared; past the cap the ceiling still forces the resync, and a resync that replaces
// a drain that had progressed keeps the floor for a same-instance hub.

const { assert, sinon, HubDbSync } = require('./helpers/barrier_hold_ceiling.js');
const { HUB_SCHEMA_VERSION } = require('../../../../src/hub/hub_schema_version');

const PAGE = 10000;
const SHORT_CEILING_MS = 60000;
// Retry budget (120 s) + longest retry wait (30 s) + the default request deadline (120 s).
const PAGE_AGE_CAP_MS = 270000;
const FLOOR = { wireId: 4242, floorTs: 1700000000 };

let clock;

function page(first, count) {
    const rows = [];
    for (let i = 0; i < count; i++) rows.push({ id: first + i });
    return rows;
}

function snapshot(rows, watermark) {
    return { schema_version: HUB_SCHEMA_VERSION, rows: rows, watermark: watermark };
}

function makeDrainingSync() {
    const sync = new HubDbSync({ doQuery: sinon.stub().resolves([]) }, { hubUrl: 'http://hub.test' });
    sync.running = true;
    sync.barrierHoldCeilingMs = SHORT_CEILING_MS;
    sync.ws = { terminate() { sync.resetOnSocketClose(); } };
    sync._lastHubInstanceId = 'hub-a';
    sync._priceRepageFloor = Object.assign({}, FLOOR);
    sinon.stub(sync, 'localColumns').resolves(new Set(['id']));
    sinon.stub(sync, 'applyRow').resolves(true);
    sinon.stub(sync, 'scheduleBootstrapRetry');
    const real = sync.bootstrapTable.bind(sync);
    sinon.stub(sync, 'bootstrapTable').callsFake(table => (table === 'price_snapshots' ? real(table) : Promise.resolve(9000)));
    return sync;
}

// The first price page lands after 1 s and fills the page limit; the second is the slow one.
function firstPageThen(sync, secondPage) {
    const httpGet = sinon.stub(sync, 'httpGet');
    httpGet.onCall(0).callsFake(() => new Promise(resolve => setTimeout(() => resolve(snapshot(page(1, PAGE), 7000)), 1000)));
    httpGet.onCall(1).callsFake(secondPage);
    return httpGet;
}

async function pacedPageSpared() {
    const sync = makeDrainingSync();
    const httpGet = firstPageThen(sync, () => new Promise(resolve =>
        setTimeout(() => resolve(snapshot(page(PAGE + 1, 5), 7001)), 200000)));

    const boot = sync.bootstrapAll();
    await clock.tickAsync(1000 + 100000);
    assert.strictEqual(sync.requestResync('held at 100 s'), false, 'a page 100 s in flight is the hub pacing, not a stall');
    await clock.tickAsync(60000);
    assert.strictEqual(sync.requestResync('held at 160 s'), false);
    assert.strictEqual(sync.forcedResyncCount, 0);
    assert.deepStrictEqual(sync._priceRepageFloor, FLOOR, 'the floor survives while the drain waits');

    await clock.tickAsync(200000);
    await boot;
    assert.strictEqual(sync._wsEpoch, 0, 'the connection was never replaced');
    assert.strictEqual(sync._bootstrapDrained, true, 'the paced drain certifies');
    assert.strictEqual(httpGet.callCount, 2);
}

async function pastCapKeepsFloor() {
    const sync = makeDrainingSync();
    let release;
    firstPageThen(sync, () => new Promise(resolve => { release = resolve; }));

    const boot = sync.bootstrapAll();
    await clock.tickAsync(1000 + 100000);
    assert.strictEqual(sync.requestResync('inside the cap'), false);
    await clock.tickAsync(PAGE_AGE_CAP_MS - 100000);
    assert.strictEqual(sync.requestResync('past the cap'), true, 'a page past its age cap is wedged');
    assert.strictEqual(sync._wsEpoch, 1, 'the connection was replaced');
    assert.strictEqual(sync.forcedResyncCount, 1);
    assert.deepStrictEqual(sync._priceRepageFloor, FLOOR, 'a drain that had progressed keeps its floor start');
    assert.strictEqual(sync._lastHubInstanceId, 'hub-a');

    sync.adoptReadyFrame({}, { type: 'ready', hub_instance_id: 'hub-a', max_ids: {} });
    assert.deepStrictEqual(sync._priceRepageFloor, FLOOR, 'a same-instance reconnect keeps the floor');
    assert.ok(sync.repageOwedSeq('price_snapshots') !== undefined, 'the price table is still owed its re-page');
    sync.adoptReadyFrame({}, { type: 'ready', hub_instance_id: 'hub-b', max_ids: {} });
    assert.strictEqual(sync._priceRepageFloor, null, 'another hub instance still clears the floor');

    release(snapshot(page(PAGE + 1, 5), 7001));
    await clock.tickAsync(1);
    await boot;
    assert.strictEqual(sync._bootstrapDrained, false, 'the replaced drain must not certify');
}

async function noProgressForgetsFloor() {
    const sync = makeDrainingSync();
    let release;
    sinon.stub(sync, 'httpGet').returns(new Promise(resolve => { release = resolve; }));

    const boot = sync.bootstrapAll();
    await clock.tickAsync(PAGE_AGE_CAP_MS + 1);
    assert.strictEqual(sync.requestResync('no page ever arrived'), true);
    assert.strictEqual(sync._priceRepageFloor, null);
    assert.strictEqual(sync._lastHubInstanceId, null);

    release(snapshot([], 7000));
    await clock.tickAsync(1);
    await boot;
    assert.strictEqual(sync._bootstrapDrained, false);
}

describe('hub mirror drain on a hub-paced page @regression @tier1', function () {
    beforeEach(function () {
        clock = sinon.useFakeTimers({ now: 1800000000000, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        sinon.stub(console, 'warn');
        sinon.stub(console, 'log');
    });
    afterEach(function () { clock.restore(); sinon.restore(); });

    it('spares a drain whose page is in flight past a short ceiling but under the page-age cap', pacedPageSpared);
    it('forces the resync once the page passes its age cap, and keeps the floor of a drain that progressed', pastCapKeepsFloor);
    it('a resync over a drain that never progressed still forgets the floor and the instance', noProgressForgetsFloor);
});
