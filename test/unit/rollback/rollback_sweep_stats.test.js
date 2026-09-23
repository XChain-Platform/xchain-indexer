// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer } = require('../../fixtures/mocks');
const { getLogger } = require('../../../src/observability/index.js');
const sweepSql = require('../../../src/db/rollback/sweeps.js');

const Rollback = require('../../../src/rollback/index.js');

// The orphan sweeps report each table's time and rows removed on the rollback
// completion line, and a later rollback reports only its own sweeps.

const SWEEP_ROWS = { balances: 7, markets: 2, pubkeys: 1, icons: 3 };

// The swept table a query deletes from, or null for any other statement.
function sweptTable(query) {
    const m = /^\s*DELETE FROM (balances|markets|pubkeys|icons)\s+WHERE[\s\S]*NOT IN/.exec(query || '');
    return m ? m[1] : null;
}

// A doQuery fake: an orphaned action range when withActions, the given affectedRows per sweep.
function fakeDoQuery(rows, withActions) {
    let first = true;
    return async (query) => {
        if (first) { first = false; return withActions ? [{ action_index: 50 }] : []; }
        const table = sweptTable(query);
        return table ? { affectedRows: rows[table] } : [];
    };
}

// The single 'Rollback complete' line the stubbed logger received.
function summaryLine(info) {
    const lines = info.getCalls().map(c => String(c.args[0])).filter(l => l.startsWith('Rollback complete'));
    assert.strictEqual(lines.length, 1, 'expected exactly one completion summary');
    return lines[0];
}

describe('Rollback sweep stats @regression @tier3', function () {
    let indexer, rollback, info;

    beforeEach(function () {
        indexer = createMockIndexer();
        rollback = new Rollback(indexer);
        indexer.util.resetLists();
        info = sinon.stub(getLogger(), 'info');
    });

    afterEach(function () {
        sinon.restore();
    });

    it('returns time and rows per table from the dangling-reference sweep', async function () {
        const db = { doQuery: sinon.stub().callsFake(async (q) => ({ affectedRows: SWEEP_ROWS[sweptTable(q)] })) };
        const stats = await sweepSql.sweepDanglingIndexReferences(db, 0);
        assert.deepStrictEqual(stats.map(s => [s.table, s.rows]), [['balances', 7], ['markets', 2], ['pubkeys', 1]]);
        stats.forEach(s => assert.ok(Number.isFinite(s.ms) && s.ms >= 0, s.table + ' ms'));
        const bare = await sweepSql.sweepDanglingIndexReferences({ doQuery: sinon.stub().resolves([]) }, 0);
        assert.deepStrictEqual(bare.map(s => s.rows), [null, null, null], 'no OkPacket reads as unknown, not zero');
    });

    it('names every orphan sweep with its rows removed on the completion line', async function () {
        indexer.indexerDb.doQuery.callsFake(fakeDoQuery(SWEEP_ROWS, true));
        await rollback.rollback(100);
        const line = summaryLine(info);
        for (const [table, n] of Object.entries(SWEEP_ROWS)) {
            assert.match(line, new RegExp('\\b' + table + ' \\d+ms ' + n + ' rows\\b'), table + ' in: ' + line);
        }
    });

    it('reports only the current rollback sweeps, not an earlier one', async function () {
        indexer.indexerDb.doQuery.callsFake(fakeDoQuery(SWEEP_ROWS, true));
        await rollback.rollback(100);
        info.resetHistory();
        indexer.indexerDb.doQuery.callsFake(fakeDoQuery({ balances: 4, markets: 0, pubkeys: 0 }, false));
        await rollback.rollback(100);
        const line = summaryLine(info);
        assert.match(line, /\bbalances \d+ms 4 rows\b/);
        assert.doesNotMatch(line, /\bicons\b/, 'icons sweep runs only with an orphaned action range');
        assert.doesNotMatch(line, /\b7 rows\b/, 'the earlier rollback leaked into this summary');
    });
});
