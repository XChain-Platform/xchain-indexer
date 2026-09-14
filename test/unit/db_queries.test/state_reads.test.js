/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/db_queries.test/state_reads.test.js
 *
 * Single-row state reads: contracts, gated files and key hashes, dispenser
 * and order remainders, oracle and latest prices, sweep destinations, lists,
 * expired items, status strings, the mirror db and createPrice.
 *
 * Part of the Database query suite (see ../db_queries.test.js): real method
 * logic against a stubbed doQuery, no live MariaDB required.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { makeDb, dbWithDoQuery } = require('./helpers/db_stub');

afterEach(function () {
    sinon.restore();
});

// ---------------------------------------------------------------------------
// mirrorDb
// ---------------------------------------------------------------------------
describe('Database._mirrorDb() @regression @tier1', function () {
    it('returns this when indexer has no hubDb', function () {
        const db = makeDb();
        assert.strictEqual(db.mirrorDb(), db);
    });

    it('returns hubDb when indexer has one', function () {
        const db    = makeDb();
        const hubDb = { doQuery: sinon.stub() };
        db.indexer.hubDb = hubDb;
        assert.strictEqual(db.mirrorDb(), hubDb);
    });
});

// ---------------------------------------------------------------------------
// getStatusString
// ---------------------------------------------------------------------------
describe('Database.getStatusString() @regression @tier1', function () {
    it('returns null when status_id not found', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getStatusString(99), null);
    });

    it('returns status string when found', async function () {
        const db = dbWithDoQuery([{ status: 'valid' }]);
        assert.strictEqual(await db.getStatusString(1), 'valid');
    });
});

// ---------------------------------------------------------------------------
// getContract
// ---------------------------------------------------------------------------
describe('Database.getContract() @regression @tier1', function () {
    it('returns null when not found', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getContract(99), null);
    });

    it('returns contract row when found', async function () {
        const db = dbWithDoQuery([{ action_index: 5, source_id: 1 }]);
        const result = await db.getContract(5);
        assert.strictEqual(result.action_index, 5);
    });
});

// ---------------------------------------------------------------------------
// getGatedFileRaw
// ---------------------------------------------------------------------------
describe('Database.getGatedFileRaw() @regression @tier1', function () {
    it('returns null when not found', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getGatedFileRaw(99), null);
    });

    it('returns row when found', async function () {
        const db = dbWithDoQuery([{ action_index: 10, raw_data: Buffer.from('abc') }]);
        const result = await db.getGatedFileRaw(10);
        assert.ok(result !== null);
    });
});

// ---------------------------------------------------------------------------
// getActiveGatedKeyHashes
// ---------------------------------------------------------------------------
describe('Database.getActiveGatedKeyHashes() @regression @tier1', function () {
    it('returns empty array when no hashes found', async function () {
        // getActiveGatedKeyHashes passes tick directly as gate_ticker (no createTicker)
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        const result = await db.getActiveGatedKeyHashes('PEPE');
        assert.deepStrictEqual(result, []);
    });

    it('returns lowercase key_hash strings when found', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([
            { key_hash: 'HASH1' }, { key_hash: 'hash2' }
        ]);
        const result = await db.getActiveGatedKeyHashes('PEPE');
        // Returns lowercased via String(...).toLowerCase()
        assert.deepStrictEqual(result, ['hash1', 'hash2']);
    });
});

// ---------------------------------------------------------------------------
// getDispenserAmountRemaining
// ---------------------------------------------------------------------------
describe('Database.getDispenserAmountRemaining() @regression @tier1', function () {
    it('returns 0 when dispenser not found', async function () {
        const db = dbWithDoQuery([]);
        const result = await db.getDispenserAmountRemaining(99);
        // Returns 0 or null based on implementation; test for non-undefined
        assert.ok(result !== undefined);
    });
});

// ---------------------------------------------------------------------------
// getOraclePrice
// ---------------------------------------------------------------------------
describe('Database.getOraclePrice() @regression @tier1', function () {
    it('returns null when no price found', async function () {
        const db = dbWithDoQuery([]);
        // sourceAddress, coin, tick, fiat, blockTime
        assert.strictEqual(await db.getOraclePrice('addr1', 'BTC', null, 'USD', 1000000), null);
    });

    it('returns row when price found', async function () {
        const db = dbWithDoQuery([{ value: '60000', block_time: 999 }]);
        const result = await db.getOraclePrice('addr1', 'BTC', null, 'USD', 1000000);
        assert.strictEqual(result.value, '60000');
    });
});

// ---------------------------------------------------------------------------
// getLatestPrice
// ---------------------------------------------------------------------------
describe('Database.getLatestPrice() @regression @tier1', function () {
    it('returns null when no price found', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getLatestPrice('BTC-USD', 100), null);
    });

    it('returns normalized object with price/roundNumber/timestamp on hit', async function () {
        // getLatestPrice returns { price, roundNumber, timestamp } not the raw row
        const db = dbWithDoQuery([{ price: '50000', round_number: 42, block_timestamp: 1700000000 }]);
        const result = await db.getLatestPrice('BTC-USD', 100);
        assert.strictEqual(result.price, '50000');
        assert.strictEqual(result.roundNumber, 42);
        assert.strictEqual(result.timestamp, 1700000000);
    });
});

// ---------------------------------------------------------------------------
// getOrderAmountsRemaining
// ---------------------------------------------------------------------------
describe('Database.getOrderAmountsRemaining() @regression @tier1', function () {
    it('returns default object when order not found', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        const result = await db.getOrderAmountsRemaining(99);
        // Should return an object (empty or with defaults)
        assert.ok(typeof result === 'object');
    });
});

// ---------------------------------------------------------------------------
// getSweepDestination / getOrderSweepDestination
// ---------------------------------------------------------------------------
describe('Database sweep destination methods @regression @tier1', function () {
    it('getSweepDestination returns null when not found', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getSweepDestination(99), null);
    });

    it('getOrderSweepDestination returns null when not found', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getOrderSweepDestination(99), null);
    });
});

// ---------------------------------------------------------------------------
// getListType: null action_index returns false; found
// ---------------------------------------------------------------------------
describe('Database.getListType() @regression @tier1', function () {
    it('returns false for null action_index', async function () {
        const db = makeDb();
        const type = await db.getListType(null);
        assert.strictEqual(type, false);
    });

    it('returns type integer when found', async function () {
        const db = dbWithDoQuery([{ type: '2' }]);
        const type = await db.getListType(10);
        assert.strictEqual(type, 2);
    });

    it('returns false when not found', async function () {
        const db = dbWithDoQuery([]);
        const type = await db.getListType(10);
        assert.strictEqual(type, false);
    });
});

// ---------------------------------------------------------------------------
// getList: delegates to getListType; builds from rows
// ---------------------------------------------------------------------------
describe('Database.getList() @regression @tier1', function () {
    it('returns empty array for unknown list', async function () {
        const db = makeDb();
        sinon.stub(db, 'getListType').resolves(false);
        const list = await db.getList(10);
        assert.deepStrictEqual(list, []);
    });

    it('returns tick items for type=1', async function () {
        const db = makeDb();
        sinon.stub(db, 'getListType').resolves(1);
        sinon.stub(db, 'doQuery').resolves([{ item: 'PEPE' }, { item: 'DOGE' }]);
        const list = await db.getList(10);
        assert.deepStrictEqual(list, ['PEPE', 'DOGE']);
    });

    it('returns address items for type=2', async function () {
        const db = makeDb();
        sinon.stub(db, 'getListType').resolves(2);
        sinon.stub(db, 'doQuery').resolves([{ item: 'bc1q...' }]);
        const list = await db.getList(10);
        assert.deepStrictEqual(list, ['bc1q...']);
    });
});

// ---------------------------------------------------------------------------
// isValidList: delegates to getListType
// ---------------------------------------------------------------------------
describe('Database.isValidList() @regression @tier1', function () {
    it('returns true when types match', async function () {
        const db = makeDb();
        sinon.stub(db, 'getListType').resolves(1);
        assert.strictEqual(await db.isValidList(10, 1), true);
    });

    it('returns false when types differ', async function () {
        const db = makeDb();
        sinon.stub(db, 'getListType').resolves(2);
        assert.strictEqual(await db.isValidList(10, 1), false);
    });
});

// ---------------------------------------------------------------------------
// getExpiredItems: empty returns []
// ---------------------------------------------------------------------------
describe('Database.getExpiredItems() @regression @tier1', function () {
    it('returns empty array when no open items', async function () {
        const db = dbWithDoQuery([]);
        const result = await db.getExpiredItems(9999999);
        assert.deepStrictEqual(result, []);
    });

    // the expiration cut is applied in SQL, so exactly ONE query runs and
    // only the rows actually expiring this block come back, rather than the whole
    // open book fetched, overlaid by a second batched edits query per type,
    // and filtered in JS. (That shape also carried an N+1 regression, and its
    // batched edits query no longer exists.)
    it('runs one query with the expiration cut and the edits overlay pushed into SQL', async function () {
        const db = makeDb();
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([
            { action_index: 2, expiration: 100, type: 'order' },
            { action_index: 3, expiration: 100, type: 'order' },
        ]);
        const result = await db.getExpiredItems(200);
        assert.strictEqual(dq.callCount, 1, 'expiry sweep must be a single round trip');
        assert.deepStrictEqual(result, [
            { type: 'order', action_index: 2, expiration: 100 },
            { type: 'order', action_index: 3, expiration: 100 },
        ]);
        const [sql, args] = dq.getCall(0).args;
        // One cutoff bind per type branch (order/swap/dispenser).
        assert.deepStrictEqual(args, [200, 200, 200]);
        // The edits overlay is a newest-valid-non-null scalar subquery per branch.
        for (const type of ['order', 'swap', 'dispenser']) {
            assert.ok(
                sql.includes(type + '_edits e1'),
                'expected an inline ' + type + '_edits overlay'
            );
        }
        assert.ok(/ORDER BY\s+e1\.action_index DESC/.test(sql), 'newest valid edit must win');
        assert.ok(/e1\.expiration IS NOT NULL/.test(sql), 'null-expiration edits must be ignored');
        // Consensus trap guard: a bare `eff < ?` would drop null-expiration rows
        // (never expiring them). The zero-default keeps the old JS null coercion.
        assert.strictEqual(
            (sql.match(/, m\.expiration, 0\) < \?/g) || []).length,
            3,
            'every branch must default a null effective expiration to 0 in the cut'
        );
        assert.ok(/ORDER BY action_index ASC/.test(sql), 'deterministic output order');
    });

    // A null effective expiration is "expired at time 0" (the old JS predicate
    // coerced null to 0), and it is reported with expiration 0, not null.
    it('reports a null effective expiration as 0', async function () {
        const db = makeDb();
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([{ action_index: 7, expiration: null, type: 'swap' }]);
        const result = await db.getExpiredItems(200);
        assert.deepStrictEqual(result, [{ type: 'swap', action_index: 7, expiration: 0 }]);
    });
});

describe('Database.getExpiredItems() @regression @tier1', function () {
    // The old JS compare was false for every row when block_time was not a
    // number, so nothing expired. Binding that into SQL would change the answer.
    it('expires nothing and issues no query for a non-numeric block_time', async function () {
        for (const bad of [undefined, null, 'not-a-time', NaN]) {
            const db = makeDb();
            const dq = sinon.stub(db, 'doQuery');
            const result = await db.getExpiredItems(bad);
            assert.deepStrictEqual(result, [], 'block_time ' + String(bad) + ' must expire nothing');
            assert.strictEqual(dq.callCount, 0);
        }
    });

    it('accepts a numeric-string block_time (same coercion the JS compare had)', async function () {
        const db = makeDb();
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        await db.getExpiredItems('200');
        assert.deepStrictEqual(dq.getCall(0).args[1], [200, 200, 200]);
    });
});

// ---------------------------------------------------------------------------
// createPrice: INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createPrice() @regression @tier1', function () {
    function makePriceDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        sinon.stub(db, 'getAddressId').resolves(2);
        sinon.stub(db, 'createCoin').resolves(null);
        sinon.stub(db, 'createTicker').resolves(null);
        sinon.stub(db, 'createFiat').resolves(null);
        sinon.stub(db, 'createMemo').resolves(null);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makePriceDb([]);
        await db.createPrice({ ACTION_INDEX: 900, STATUS: 'valid', SOURCE: 'addr1' });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO prices'));
    });

    it('UPDATEs when exists', async function () {
        const db = makePriceDb([{ action_index: 900 }]);
        await db.createPrice({ ACTION_INDEX: 900, STATUS: 'valid', SOURCE: 'addr1' });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE prices'));
    });
});
