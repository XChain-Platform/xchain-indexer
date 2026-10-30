/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/api/health/reorg_health_stats_null.test.js
 *
 * getReorgHealthStats() feeds the /health reorg counters. The dashboard reads a null
 * reorgsProcessed as "not read this tick" and any number, 0 included, as a real count it
 * rebaselines on, so a failed count read must report null and a genuine zero must stay 0.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../../../fixtures/config');
const Utility           = require('../../../../src/utility');
const Database          = require('../../../../src/db');

// Build a Database over dummy connection settings with error logging silenced.
function makeDb() {
    const config  = getTestConfig();
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const indexer = { config, util };
    return new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
}

// Answer the two reads in call order: the COUNT first, then the last-marker lookup.
function stubReads(db, method, count, last) {
    const stub = sinon.stub(db, method);
    stub.onCall(0).callsFake(() => count instanceof Error ? Promise.reject(count) : Promise.resolve(count));
    stub.onCall(1).callsFake(() => last instanceof Error ? Promise.reject(last) : Promise.resolve(last));
    return stub;
}

describe('getReorgHealthStats() null-on-failure contract', function () {

    afterEach(() => sinon.restore());

    it('reports reorgsProcessed null when the count read fails on the committed view', async function () {
        const db = makeDb();
        sinon.stub(db, 'poolQuery').rejects(new Error('ECONNRESET'));
        const stats = await db.apiView().getReorgHealthStats();
        assert.deepStrictEqual(stats, { reorgsProcessed: null, lastReorgBlock: null, lastReorgAt: null });
    });

    it('reports reorgsProcessed null when a raw-handle query error would otherwise read as no rows', async function () {
        const db = makeDb();
        const conn = { query: sinon.stub().rejects(new Error('ER_LOCK_WAIT_TIMEOUT')), release: sinon.stub().resolves() };
        sinon.stub(db, 'getConnection').resolves(conn);
        const stats = await db.getReorgHealthStats();
        assert.strictEqual(stats.reorgsProcessed, null);
        assert.ok(conn.release.called, 'the pooled connection must still be released');
    });

    it('reports reorgsProcessed null when the count read returns no row', async function () {
        const db = makeDb();
        stubReads(db, 'doQueryStrict', [], []);
        const stats = await db.getReorgHealthStats();
        assert.strictEqual(stats.reorgsProcessed, null);
    });

    it('keeps a genuine zero as 0', async function () {
        const db = makeDb();
        stubReads(db, 'doQueryStrict', [{ n: 0 }], []);
        const stats = await db.getReorgHealthStats();
        assert.deepStrictEqual(stats, { reorgsProcessed: 0, lastReorgBlock: null, lastReorgAt: null });
    });

    it('keeps the count when only the last-marker read fails', async function () {
        const db = makeDb();
        stubReads(db, 'doQueryStrict', [{ n: 7 }], new Error('ECONNRESET'));
        const stats = await db.getReorgHealthStats();
        assert.deepStrictEqual(stats, { reorgsProcessed: 7, lastReorgBlock: null, lastReorgAt: null });
    });

    it('reports the count, block and time of the latest marker on a good read', async function () {
        const db = makeDb();
        stubReads(db, 'doQueryStrict', [{ n: 7 }], [{ time: '2026-01-01T00:00:00Z', data: '{"block_index":123}' }]);
        const stats = await db.getReorgHealthStats();
        assert.strictEqual(stats.reorgsProcessed, 7);
        assert.strictEqual(stats.lastReorgBlock, 123);
        assert.strictEqual(stats.lastReorgAt, Date.parse('2026-01-01T00:00:00Z'));
    });
});

const reorgHealthWarn = require('../../../../src/db/events/reorg_health_warn.js');
const { getLogger }   = require('../../../../src/observability/index.js');

// Stub the shared logger's warn around each case, with the rate-limit state cleared.
function watchWarn() {
    const watch = { warn: null };
    beforeEach(() => {
        reorgHealthWarn.resetReorgHealthWarnState();
        watch.warn = sinon.stub(getLogger(), 'warn');
    });
    afterEach(() => {
        sinon.restore();
        reorgHealthWarn.resetReorgHealthWarnState();
    });
    return watch;
}

describe('getReorgHealthStats() logs a failed read at warn', function () {

    const watch = watchWarn();
    let warn;
    beforeEach(() => { warn = watch.warn; });

    it('warns once naming the count stage when the count read fails, and still returns null stats', async function () {
        const db = makeDb();
        stubReads(db, 'doQueryStrict', new Error('ER_LOCK_WAIT_TIMEOUT'), []);
        const stats = await db.getReorgHealthStats();
        assert.deepStrictEqual(stats, { reorgsProcessed: null, lastReorgBlock: null, lastReorgAt: null });
        assert.strictEqual(warn.callCount, 1);
        assert.match(warn.firstCall.args[0], /REORG count read failed/);
        assert.match(warn.firstCall.args[0], /ER_LOCK_WAIT_TIMEOUT/);
    });

    it('warns naming the last-marker stage when only that read fails, and keeps the count', async function () {
        const db = makeDb();
        stubReads(db, 'doQueryStrict', [{ n: 7 }], new Error('ECONNRESET'));
        const stats = await db.getReorgHealthStats();
        assert.strictEqual(stats.reorgsProcessed, 7);
        assert.strictEqual(warn.callCount, 1);
        assert.match(warn.firstCall.args[0], /REORG last-marker read failed/);
    });

    it('logs nothing on a good read', async function () {
        const db = makeDb();
        stubReads(db, 'doQueryStrict', [{ n: 7 }], [{ time: '2026-01-01T00:00:00Z', data: '{"block_index":123}' }]);
        await db.getReorgHealthStats();
        assert.strictEqual(warn.callCount, 0);
    });
});

describe('getReorgHealthStats() rate-limits its failed-read warn', function () {

    const watch = watchWarn();
    let warn;
    beforeEach(() => { warn = watch.warn; });

    it('suppresses repeat failures inside the interval and reports the suppressed count on the next warn', async function () {
        const clock = sinon.useFakeTimers({ now: 1000000 });
        const db = makeDb();
        sinon.stub(db, 'doQueryStrict').rejects(new Error('ECONNRESET'));
        await db.getReorgHealthStats();
        await db.getReorgHealthStats();
        await db.getReorgHealthStats();
        assert.strictEqual(warn.callCount, 1);
        clock.tick(reorgHealthWarn.WARN_INTERVAL_MS);
        await db.getReorgHealthStats();
        assert.strictEqual(warn.callCount, 2);
        assert.match(warn.secondCall.args[0], /\[2 similar failures suppressed\]/);
    });

    it('rate-limits across fresh committed-view wrappers, the way the /health handler calls it', async function () {
        const db = makeDb();
        sinon.stub(db, 'poolQuery').rejects(new Error('ECONNRESET'));
        await db.apiView().getReorgHealthStats();
        await db.apiView().getReorgHealthStats();
        assert.strictEqual(warn.callCount, 1);
    });
});
