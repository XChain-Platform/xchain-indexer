// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The per-block cross-chain passes read every finalized mirror row for the chain and cap
// afterwards, so the read grows with history while the cap does not. These pin the
// measurement of that read: the full row count is recorded (never the capped count), an
// empty mirror records zero, the warning fires once at the threshold, the single-DB result
// reader records nothing, and a failing observer never changes what a reader returns.

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../../fixtures/config');
const Utility           = require('../../../src/utility');
const Database          = require('../../../src/db');
const observability     = require('../../../src/observability');
const diag              = require('../../../src/actions/anchor/diagnostic_events.js');

let sink;

function makeDb(hubDb) {
    const config  = getTestConfig();
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const indexer = { config, util };
    if (hubDb) indexer.hubDb = hubDb;
    return new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
}

function rows(prefix, n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push({ match_id: prefix + String(i).padStart(6, '0'),
                                           call_id: prefix + String(i).padStart(6, '0'), snapshot_block: 1 });
    return out;
}

function gaugeValue(pass) {
    const line = observability.getRegistry().render().split('\n')
        .find(l => l.startsWith('xchain_indexer_cross_chain_mirror_rows_read{pass="' + pass + '"}'));
    return line ? Number(line.trim().split(' ').pop()) : null;
}

function readCount(pass) {
    const line = observability.getRegistry().render().split('\n')
        .find(l => l.startsWith('xchain_indexer_cross_chain_mirror_read_seconds_count{pass="' + pass + '"}'));
    return line ? Number(line.trim().split(' ').pop()) : 0;
}

function warnings() {
    return sink.lines.filter(l => l.includes('CROSS_CHAIN_MIRROR_BACKLOG'));
}

// Each pass: how to build a db whose full mirror read returns n rows, and the call under test.
const PASSES = [
    { pass: 'cross_settle',   call: db => db.getEffectiveUnsettledMatches('BTC', 1700, 25) },
    { pass: 'xexec_dispatch', call: db => db.getEffectiveUndispatchedCalls('BTC', 'regtest', 1700, 25) },
    { pass: 'xcall_result',   call: db => db.getEffectiveUnprocessedCallResults('BTC', 'regtest', 1700, 25),
      remote: true }
];

// The mirror read lives on a stubbed hub connection for xcall_result (the separate-mirror branch is
// the only one that reads the full set) and on the local connection for the other two.
function dbFor(entry, mirrorRows) {
    if (entry.remote) {
        const db = makeDb({ doQueryStrict: sinon.stub().resolves(mirrorRows) });
        sinon.stub(db, 'doQuery').resolves([]);
        return db;
    }
    const db = makeDb(null);
    sinon.stub(db, 'doQueryStrict').resolves(mirrorRows);
    sinon.stub(db, 'doQuery').resolves([]);
    return db;
}

describe('cross-chain mirror read metrics', function () {
    beforeEach(function () {
        observability._resetObservability();
        diag.resetDiagnostics();
        sink = { lines: [] };
        const push = (m) => sink.lines.push(m);
        observability.installObservability(null, {
            service: 'xchain-indexer', env: {}, console: { log: push, warn: push, error: push }
        });
    });

    afterEach(function () {
        sinon.restore();
        observability._resetObservability();
        diag.resetDiagnostics();
    });

    for (const entry of PASSES) {
        it(entry.pass + ' records the full mirror row count, not the capped count', async function () {
            const out = await entry.call(dbFor(entry, rows('a', 60)));
            assert.strictEqual(out.length, 25, 'the reader still caps what it returns');
            assert.strictEqual(gaugeValue(entry.pass), 60, 'the gauge reports the rows read, before the cap');
            assert.strictEqual(readCount(entry.pass), 1, 'one read observed');
        });

        it(entry.pass + ' records zero for an empty mirror', async function () {
            const out = await entry.call(dbFor(entry, []));
            assert.deepStrictEqual(out, []);
            assert.strictEqual(gaugeValue(entry.pass), 0);
            assert.strictEqual(readCount(entry.pass), 1);
        });

        it(entry.pass + ' warns once at the threshold and not below it', async function () {
            const below = diag.MIRROR_BACKLOG_WARN_ROWS - 1;
            await entry.call(dbFor(entry, rows('b', below)));
            assert.strictEqual(warnings().length, 0, 'no warning under the threshold');
            await entry.call(dbFor(entry, rows('b', diag.MIRROR_BACKLOG_WARN_ROWS)));
            await entry.call(dbFor(entry, rows('b', diag.MIRROR_BACKLOG_WARN_ROWS + 5)));
            assert.strictEqual(warnings().length, 1, 'exactly one warning per pass per process');
            assert.ok(warnings()[0].includes('read=' + entry.pass), 'the warning names the pass');
        });

        it(entry.pass + ' returns the same ordered rows when the observer throws', async function () {
            const all = rows('c', 40);
            const baseline = await entry.call(dbFor(entry, all));
            sinon.stub(observability.getRegistry(), 'gauge').throws(new Error('registry down'));
            diag.resetDiagnostics();
            const out = await entry.call(dbFor(entry, all));
            assert.deepStrictEqual(out.map(r => r.call_id), baseline.map(r => r.call_id));
            assert.deepStrictEqual(out.map(r => r.call_id), all.slice(0, 25).map(r => r.call_id));
        });
    }

    it('the single-DB result reader records nothing', async function () {
        const db = makeDb(null);
        sinon.stub(db, 'doQueryStrict').resolves(rows('d', 10));
        sinon.stub(db, 'doQuery').resolves([]);
        await db.getEffectiveUnprocessedCallResults('BTC', 'regtest', 1700, 25);
        assert.strictEqual(gaugeValue('xcall_result'), null, 'the SQL-limited branch reads no full set');
        assert.strictEqual(readCount('xcall_result'), 0);
    });
});
