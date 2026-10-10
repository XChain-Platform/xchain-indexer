// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { assert, sinon, HubDbSync } = require('./helpers/barrier_hold_ceiling.js');
const { HUB_SCHEMA_VERSION } = require('../../../../src/hub/hub_schema_version');

const PAGE = 10000;
const PAGE_LATENCY_MS = 400000;
const STEP_MS = 300000;

function page(first, count) {
    const rows = [];
    for (let i = 0; i < count; i++) rows.push({ id: first + i });
    return rows;
}

function makeDrainingSync() {
    const sync = new HubDbSync({ doQuery: sinon.stub().resolves([]) }, { hubUrl: 'http://hub.test' });
    sync.running = true;
    sync.ws = { terminate() { sync.resetOnSocketClose(); } };
    sinon.stub(sync, 'localColumns').resolves(new Set(['id']));
    sinon.stub(sync, 'applyRow').resolves(true);
    sinon.stub(sync, 'scheduleBootstrapRetry');
    const real = sync.bootstrapTable.bind(sync);
    sinon.stub(sync, 'bootstrapTable').callsFake(table => (table === 'price_snapshots' ? real(table) : Promise.resolve(9000)));
    return sync;
}

let clock;
function useFixedClock() {
    beforeEach(function () {
        clock = sinon.useFakeTimers({ now: 1800000000000 });
        sinon.stub(console, 'warn');
        sinon.stub(console, 'log');
    });
    afterEach(function () { clock.restore(); sinon.restore(); });
}

function slowPages(sync, pages) {
    const httpGet = sinon.stub(sync, 'httpGet');
    pages.forEach((rows, i) => httpGet.onCall(i).callsFake(() => new Promise(resolve =>
        setTimeout(() => resolve({ schema_version: HUB_SCHEMA_VERSION, rows: rows, watermark: 7000 + i }), PAGE_LATENCY_MS))));
    return httpGet;
}

describe('hub mirror drain that keeps applying rows @regression @tier1', function () {
    useFixedClock();

    it('a multi-page drain that keeps applying rows keeps its connection epoch and certifies', async function () {
        const sync = makeDrainingSync();
        const pages = [page(1, PAGE), page(PAGE + 1, PAGE), page(2 * PAGE + 1, PAGE), page(3 * PAGE + 1, 5)];
        const httpGet = slowPages(sync, pages);

        const boot = sync.bootstrapAll();
        const verdicts = [];
        for (let w = 0; w < 5; w++) {
            await clock.tickAsync(STEP_MS);
            verdicts.push(sync.requestResync('barrier still held'));
        }
        await clock.tickAsync(PAGE_LATENCY_MS * 4);
        await boot;

        assert.ok(clock.now - 1800000000000 > sync.barrierHoldCeilingMs, 'the drain spanned more than one ceiling window');
        assert.deepStrictEqual(verdicts, [false, false, false, false, false]);
        assert.strictEqual(httpGet.callCount, 4);
        assert.strictEqual(sync._wsEpoch, 0);
        assert.strictEqual(sync.forcedResyncCount, 0);
        assert.strictEqual(sync._bootstrapDrained, true);
        assert.strictEqual(sync.streamWatermark, 7003);
        assert.strictEqual(sync.applyRow.callCount, 3 * PAGE + 5);
    });
});

describe('hub mirror drain that stops applying rows @regression @tier1', function () {
    useFixedClock();

    it('a drain whose page never returns is replaced once a ceiling window passes with no progress', async function () {
        const sync = makeDrainingSync();
        const httpGet = sinon.stub(sync, 'httpGet');
        httpGet.onCall(0).callsFake(() => new Promise(resolve =>
            setTimeout(() => resolve({ schema_version: HUB_SCHEMA_VERSION, rows: page(1, PAGE), watermark: 1 }), 1000)));
        let release;
        httpGet.onCall(1).returns(new Promise(resolve => { release = resolve; }));

        const boot = sync.bootstrapAll();
        await clock.tickAsync(STEP_MS);
        assert.strictEqual(sync.requestResync('window one'), false, 'rows applied inside the window');
        await clock.tickAsync(sync.barrierHoldCeilingMs);
        assert.strictEqual(sync.requestResync('window two'), true, 'a whole window passed with no row applied');
        assert.strictEqual(sync._wsEpoch, 1, 'the connection was replaced');
        assert.strictEqual(sync.forcedResyncCount, 1);

        release({ schema_version: HUB_SCHEMA_VERSION, rows: page(PAGE + 1, 5), watermark: 2 });
        await clock.tickAsync(1);
        await boot;
        assert.strictEqual(sync._bootstrapDrained, false, 'the stale drain must not certify the new connection');
        assert.strictEqual(sync.scheduleBootstrapRetry.callCount, 1);
    });
});
