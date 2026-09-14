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

const HubDbSync = require('../../../src/hub/hub_db_sync.js');

// Build a HubDbSync whose enabled flag is true (needs both a hub URL and a hub DB),
// backed by a stubbed doQuery we drive per-test to simulate the local price mirror.
function makeSync(maxReferenceBlock) {
    const doQuery = sinon.stub();
    doQuery.callsFake(async () => [{ h: maxReferenceBlock }]);
    const hubDb = { doQuery };
    const sync = new HubDbSync(hubDb, { hubUrl: 'http://hub.test' });
    return { sync, hubDb, doQuery };
}

// Regression (fleet incident 2026-06-16): the hub serves rows as JSON, so a
// DATETIME column (price_snapshots.created_at) arrives as an ISO-8601 string
// ('2026-06-16T10:33:01.000Z'). MariaDB strict mode rejects the 'T'/'Z' form
// for a DATETIME column (ER_TRUNCATED_WRONG_VALUE, 22007) and silently kills
// the mirror; BTC indexers stalled at 'price mirror at 0' once the oracle
// resumed finalizing rounds. _applyRow must reformat ISO datetimes to MySQL
// 'YYYY-MM-DD HH:MM:SS' (UTC) and leave every other value untouched.

function makeApplySync(localCols) {
    const doQuery = sinon.stub();
    doQuery.withArgs(sinon.match(/^SHOW COLUMNS/)).resolves(localCols.map(f => ({ Field: f })));
    doQuery.resolves([]);
    const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
    return { sync, doQuery };
}

function argFor(doQuery, table, col, cols) {
    const insert = doQuery.getCalls().find(c => /INSERT/.test(c.args[0]) && c.args[0].includes(table));
    return insert.args[1][cols.indexOf(col)];
}

// A real SHOW COLUMNS result carries Type beside Field. When it does, the
// coercion is keyed on the column TYPE, not on the value's shape, so a
// free-text column whose value merely LOOKS like a timestamp lands verbatim.
// oracle_prices.memo is unvalidated operator input (PRICE v1 validates
// VALUE/FEE, never MEMO), so without this a shape-keyed rewrite hits an
// ISO-shaped memo in every distributed mirror while a hubDb pointed straight at the hub keeps the
// original bytes - mirror content that depended on deployment topology,
// against src/sql/oracle_prices.sql's verbatim-parity contract.
function makeTypedApplySync(colTypes) {
    const doQuery = sinon.stub();
    doQuery.withArgs(sinon.match(/^SHOW COLUMNS/)).resolves(
        Object.keys(colTypes).map(f => ({ Field: f, Type: colTypes[f] })));
    doQuery.resolves([]);
    const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
    return { sync, doQuery };
}

describe('HubDbSync _applyRow datetime coercion @regression @tier2', function () {
    it('reformats an ISO-8601 created_at (T/Z) to MySQL DATETIME', async function () {
        const cols = ['round_number', 'coin_pair', 'status', 'created_at'];
        const { sync, doQuery } = makeApplySync(cols);
        await sync._applyRow('price_snapshots',
            { round_number: 5, coin_pair: 'BTC/USD', status: 'finalized', created_at: '2026-06-16T10:33:01.000Z' });
        assert.strictEqual(argFor(doQuery, 'price_snapshots', 'created_at', cols), '2026-06-16 10:33:01');
    });

    it('normalizes a non-UTC offset to UTC wall-clock', async function () {
        const cols = ['id', 'created_at'];
        const { sync, doQuery } = makeApplySync(cols);
        await sync._applyRow('oracle_prices', { id: 1, created_at: '2026-06-16T12:33:01+02:00' });
        assert.strictEqual(argFor(doQuery, 'oracle_prices', 'created_at', cols), '2026-06-16 10:33:01');
    });

    it('leaves an already-MySQL-format datetime untouched', async function () {
        const cols = ['id', 'created_at'];
        const { sync, doQuery } = makeApplySync(cols);
        await sync._applyRow('oracle_prices', { id: 1, created_at: '2026-06-14 00:00:00' });
        assert.strictEqual(argFor(doQuery, 'oracle_prices', 'created_at', cols), '2026-06-14 00:00:00');
    });

    it('does not mangle non-datetime string columns (hashes, ticks)', async function () {
        const cols = ['coin_pair', 'consensus_proof'];
        const { sync, doQuery } = makeApplySync(cols);
        const proof = '[{"pubkey":"4a523cf4ae4f","sig":"deadbeef"}]';
        await sync._applyRow('oracle_prices', { coin_pair: 'BTC/USD', consensus_proof: proof });
        assert.strictEqual(argFor(doQuery, 'oracle_prices', 'coin_pair', cols), 'BTC/USD');
        assert.strictEqual(argFor(doQuery, 'oracle_prices', 'consensus_proof', cols), proof);
    });

    it('passes numeric and null values through unchanged', async function () {
        const cols = ['reference_block', 'price'];
        const { sync, doQuery } = makeApplySync(cols);
        await sync._applyRow('oracle_prices', { reference_block: 800000, price: null });
        assert.strictEqual(argFor(doQuery, 'oracle_prices', 'reference_block', cols), 800000);
        assert.strictEqual(argFor(doQuery, 'oracle_prices', 'price', cols), null);
    });

    it('leaves an ISO-shaped value in a VARCHAR column verbatim when the type is known', async function () {
        const cols = ['id', 'memo', 'created_at'];
        const { sync, doQuery } = makeTypedApplySync({
            id: 'int(11)', memo: 'varchar(255)', created_at: 'timestamp'
        });
        const memo = '2026-06-16T10:33:01+09:00';
        await sync._applyRow('oracle_prices',
            { id: 1, memo: memo, created_at: '2026-06-16T10:33:01.000Z' });
        assert.strictEqual(argFor(doQuery, 'oracle_prices', 'memo', cols), memo,
            'a VARCHAR memo must mirror byte-verbatim');
        assert.strictEqual(argFor(doQuery, 'oracle_prices', 'created_at', cols), '2026-06-16 10:33:01',
            'a timestamp column is still reformatted for MariaDB strict mode');
    });
});

describe('HubDbSync _applyRow datetime coercion @regression @tier2', function () {
    it('still reformats a DATETIME column when the type is known', async function () {
        const cols = ['id', 'created_at'];
        const { sync, doQuery } = makeTypedApplySync({ id: 'int(11)', created_at: 'datetime' });
        await sync._applyRow('oracle_prices', { id: 1, created_at: '2026-06-16T12:33:01+02:00' });
        assert.strictEqual(argFor(doQuery, 'oracle_prices', 'created_at', cols), '2026-06-16 10:33:01');
    });

    it('falls back to the shape rewrite when the column type is unknown', async function () {
        // A cache miss (or a driver that serves no Type) must never regress the
        // 2026-06-16 ER_TRUNCATED_WRONG_VALUE mirror-kill: with no type to key on,
        // an ISO-8601 string is still reformatted.
        const sync = new HubDbSync({ doQuery: sinon.stub().resolves([]) }, { hubUrl: 'http://hub.test' });
        assert.strictEqual(sync.cachedColumnType('oracle_prices', 'created_at'), '');
        const cols = ['id', 'created_at'];
        const { sync: s2, doQuery } = makeApplySync(cols);
        await s2._applyRow('oracle_prices', { id: 1, created_at: '2026-06-16T10:33:01.000Z' });
        assert.strictEqual(argFor(doQuery, 'oracle_prices', 'created_at', cols), '2026-06-16 10:33:01');
    });
});

describe('HubDbSync mirror-table cold-start (missing table) @regression @tier2', function () {

    // Prod rollout abort 2026-06-17: on a fresh `reset`, hub_db_sync began
    // bootstrapping before the indexer's verifyTables() had created price_snapshots.
    // doQuery swallows the 1146 (missing table) for non-transactional reads and
    // returns [], so localColumns cached an EMPTY column set for the whole process
    // lifetime; every _applyRow then filtered to zero columns and silently no-op'd
    // (while still counting the row as "applied", hence "bootstrapped 44614 rows"),
    // the mirror stayed at 0, and the BTC-only price barrier deferred every block
    // until a process restart. The fix: never cache an empty/failed column lookup,
    // and bail-to-retry instead of poisoning the mirror.

    it('_localColumns refuses to cache an empty column set and throws (table not ready)', async function () {
        const doQuery = sinon.stub().resolves([]);              // SHOW COLUMNS on a missing table
        const sync = new HubDbSync({ doQuery }, {});
        await assert.rejects(() => sync.localColumns('price_snapshots'), /not available yet/);
        assert.ok(!sync._localColumnCache || !sync._localColumnCache['price_snapshots'],
            'an empty/failed lookup must NOT be cached (else it poisons the mirror until restart)');
    });

    it('_bootstrapTable bails to retry (returns null) when the mirror table is absent', async function () {
        const doQuery = sinon.stub().resolves([]);              // table missing -> empty SHOW COLUMNS
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        const httpGet = sinon.stub(sync, '_httpGet');
        assert.strictEqual(await sync._bootstrapTable('price_snapshots'), null,
            'an absent table must report not-drained so bootstrapAll schedules a retry');
        assert.strictEqual(httpGet.callCount, 0,
            'must not fetch from the hub at all when the local table is absent');
    });

    it('recovers WITHOUT a restart once the table exists (cache was never poisoned)', async function () {
        const doQuery = sinon.stub();
        doQuery.onCall(0).resolves([]);                                       // round 1 SHOW COLUMNS: absent
        doQuery.onCall(1).resolves([{ Field: 'id' }, { Field: 'status' }]);  // round 2 SHOW COLUMNS: present
        doQuery.resolves([{ max_id: null }]);                                // subsequent MAX(id)
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        sinon.stub(sync, '_applyRow').resolves();
        sinon.stub(sync, '_refreshPriceSyncHeight').resolves();
        sinon.stub(sync, '_httpGet').resolves({ rows: [{ id: 1 }], watermark: 77 });

        assert.strictEqual(await sync._bootstrapTable('price_snapshots'), null,
            'round 1: table absent -> not-drained');
        assert.strictEqual(await sync._bootstrapTable('price_snapshots'), 77,
            'round 2: table now present -> drains cleanly (no restart needed)');
    });
});

describe('HubDbSync bootstrap fail-closed on partial drain / holes @regression @tier1', function () {
    // No mirror holes: on an apply failure mid-page the cursor must not advance past the
    // failed row (directly or via a later row in the page), or the next retry's since_id =
    // SELECT MAX(id) skips it forever and, once the retry drains clean, the heartbeat gate
    // opens over a permanent mirror hole. Likewise, a partial drain must
    // not arm the *Bootstrapped flag, or the barrier's empty/content fast path opens against
    // an incomplete mirror and forks.
    it('stops the page at the first apply failure and does not arm the barrier', async function () {
        const doQuery = sinon.stub();
        doQuery.withArgs(sinon.match(/SHOW COLUMNS/)).resolves([{ Field: 'id' }, { Field: 'status' }]);
        doQuery.withArgs(sinon.match(/MAX\(id\)/)).resolves([{ max_id: 0 }]);
        doQuery.resolves([]);
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        sinon.stub(sync, '_httpGet').resolves({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }], watermark: 99 });
        const applied = [];
        sinon.stub(sync, '_applyRow').callsFake(async (t, row) => {
            if (row.id === 2) throw new Error('unappliable row');
            applied.push(row.id);
        });
        const refresh = sinon.stub(sync, '_refreshPriceSyncHeight').resolves();

        const result = await sync._bootstrapTable('price_snapshots');

        assert.strictEqual(result, null, 'a hole must report not-drained');
        assert.deepStrictEqual(applied, [1],
            'stops at the first failure; row 3 (after the hole) is never applied, so local MAX(id) stays below the hole');
        assert.ok(refresh.notCalled,
            'a partial drain must NOT arm the barrier (BOOTSTRAP-FLAG-PARTIAL-DRAIN)');
    });

    it('a clean full drain still arms the barrier (no regression)', async function () {
        const doQuery = sinon.stub();
        doQuery.withArgs(sinon.match(/SHOW COLUMNS/)).resolves([{ Field: 'id' }]);
        doQuery.withArgs(sinon.match(/MAX\(id\)/)).resolves([{ max_id: 0 }]);
        doQuery.resolves([]);
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        sinon.stub(sync, '_httpGet').resolves({ rows: [{ id: 1 }], watermark: 77 });
        sinon.stub(sync, '_applyRow').resolves();
        const refresh = sinon.stub(sync, '_refreshPriceSyncHeight').resolves();

        const result = await sync._bootstrapTable('price_snapshots');

        assert.strictEqual(result, 77, 'clean drain returns the watermark');
        assert.ok(refresh.calledOnce, 'a full drain arms the barrier');
    });
});

describe('HubDbSync bootstrap fail-closed on partial drain / holes @regression @tier1', function () {
    // Catch-up schema guard: the hub_ready_max_id catch-up fetch must honor the same
    // schema_version fail-closed as the main page loop; a mismatched catch-up page marks
    // the table not-drained rather than applying rows of an unknown shape.
    it('a schema-mismatched catch-up page fails closed (not drained)', async function () {
        const doQuery = sinon.stub();
        doQuery.withArgs(sinon.match(/SHOW COLUMNS/)).resolves([{ Field: 'id' }]);
        doQuery.withArgs(sinon.match(/MAX\(id\)/)).resolves([{ max_id: 5 }]);
        doQuery.resolves([{ max_id: 5 }]);
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        sync._readyMaxIds = { oracle_prices: 100 };            // hub advertises rows past our local max
        const httpGet = sinon.stub(sync, '_httpGet');
        httpGet.onFirstCall().resolves({ rows: [], watermark: 10 });          // main page: clean short drain
        httpGet.onSecondCall().resolves({ rows: [{ id: 6 }], schema_version: 999999 });  // catch-up: mismatch
        sinon.stub(sync, '_applyRow').resolves();
        const refresh = sinon.stub(sync, 'refreshOracleSyncTimestamp').resolves();

        const result = await sync._bootstrapTable('oracle_prices');

        assert.strictEqual(result, null, 'a schema-mismatched catch-up must mark the table not-drained');
        assert.ok(refresh.notCalled, 'and must not arm the barrier');
    });
});
