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
 * test/unit/db_queries.test/market_and_balances.test.js
 *
 * Market reads (getMarketInfo, getMarketId), address balances, ownerships,
 * preferences and escrows, token escrow methods and updateBalances.
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

// give_tick_id 10 == tick1, so price1 = get_amount / give_amount.
const leg = (give, get) => ({ give_tick_id: 10, give_amount: give, get_tick_id: 20, get_amount: get });

const getMarketInfoOn = (db) => db.getMarketInfo(1, 1000000);

// getMarketInfo
describe('Database.getMarketInfo() @regression @tier1', function () {
    // getMarketInfo issues six queries in order: market lookup, last trade, 24h-ago trade,
    // bid orders, ask orders, 24h matches. Feed each one by call index. A seventh, the
    // coin-label derive, runs only when the looked-up row is still unlabelled.
    function marketDb(bids, asks, matches) {
        const db = makeDb();
        const q  = sinon.stub(db, 'doQuery');
        // coin ids present: an already-labelled market skips the label-derive query, so
        // the six positions below stay the six this fixture programs.
        q.onCall(0).resolves([{ market_id: 1, tick1: 'AAA', tick1_id: 10, tick1_decimals: 8,
                                tick2: 'BBB', tick2_id: 20, tick2_decimals: 8,
                                coin1_id: 1, coin2_id: 1 }]);
        q.onCall(1).resolves([]);   // last trade price
        q.onCall(2).resolves([]);   // 24h-ago trade price
        q.onCall(3).resolves(bids);
        q.onCall(4).resolves(asks);
        q.onCall(5).resolves(matches);
        return db;
    }

    it('ranks bid/ask numerically, not as lexicographic strings', async function () {
        // getPrice returns a decimal.js bignumber; `price > best` coerces BOTH sides to
        // strings, and '10' ranks BELOW '9' as text. Best bid of a 9-then-10 book came back
        // as 9, and best ask of a 10-then-9 book came back as 10.
        const data = await getMarketInfoOn(marketDb(
            [leg('1', '9'), leg('1', '10')],
            [leg('1', '10'), leg('1', '9')],
            []));
        assert.strictEqual(String(data.tick1_bid), '10', 'best bid must be the numeric max');
        assert.strictEqual(String(data.tick1_ask), '9',  'best ask must be the numeric min');
    });

    it('ranks 24h high/low numerically', async function () {
        const data = await getMarketInfoOn(marketDb([], [],
            [leg('0.5', '4.5'), leg('0.4', '4'), leg('0.25', '2')]));   // prices 9, 10, 8
        assert.strictEqual(String(data.tick1_24hr_high), '10');
        assert.strictEqual(String(data.tick1_24hr_low),  '8');
    });

    it('sums 24h volume at the tick scale instead of quantizing to whole units', async function () {
        // bcadd with no decimals argument formats at precision 0, so each partial sum was
        // rounded half-up: 0.5 + 0.4 + 0.25 accumulated to 1 rather than 1.15.
        const data = await getMarketInfoOn(marketDb([], [],
            [leg('0.5', '4.5'), leg('0.4', '4'), leg('0.25', '2')]));
        assert.strictEqual(String(data.tick1_24hr_volume), '1.15');
        assert.strictEqual(String(data.tick2_24hr_volume), '10.5');
    });
});

describe('Database.getMarketInfo() @regression @tier1', function () {
    it('sums 24h volume at a 0-decimal tick without inventing units', async function () {
        const db = makeDb();
        const q  = sinon.stub(db, 'doQuery');
        q.onCall(0).resolves([{ market_id: 1, tick1: 'AAA', tick1_id: 10, tick1_decimals: 0,
                                tick2: 'BBB', tick2_id: 20, tick2_decimals: 0,
                                coin1_id: 1, coin2_id: 1 }]);
        q.onCall(1).resolves([]);
        q.onCall(2).resolves([]);
        q.onCall(3).resolves([]);
        q.onCall(4).resolves([]);
        q.onCall(5).resolves([leg('3', '6'), leg('4', '8')]);
        const data = await getMarketInfoOn(db);
        assert.strictEqual(String(data.tick1_24hr_volume), '7');
    });
});

// ---------------------------------------------------------------------------
// getAddressTableBalances
// ---------------------------------------------------------------------------
describe('Database.getAddressTableBalances() @regression @tier1', function () {
    it('returns empty object when no balances', async function () {
        const db = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        // createAddress
        stub.onCall(0).resolves([{ id: 1 }]);
        // SELECT balances
        stub.onCall(1).resolves([]);
        const result = await db.getAddressTableBalances('bc1qtest');
        assert.deepStrictEqual(result, {});
    });

    it('returns map of tick_id->amount', async function () {
        const db = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        // createAddress → hit
        stub.onCall(0).resolves([{ id: 2 }]);
        // SELECT balances
        stub.onCall(1).resolves([
            { tick_id: 1, amount: '500' },
            { tick_id: 2, amount: '250' }
        ]);
        const result = await db.getAddressTableBalances('addr1');
        assert.strictEqual(result[1], '500');
        assert.strictEqual(result[2], '250');
    });

    it('handles numeric address_id directly (bypasses createAddress)', async function () {
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        stub.resolves([{ tick_id: 5, amount: '999' }]);
        const result = await db.getAddressTableBalances(42); // numeric
        assert.strictEqual(result[5], '999');
    });
});

// ---------------------------------------------------------------------------
// getTokenEscrow / isOwnershipEscrowed / setTokenEscrow / clearTokenEscrow
// ---------------------------------------------------------------------------
describe('Database token escrow methods @regression @tier1', function () {
    it('getTokenEscrow returns null for null tick', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        assert.strictEqual(await db.getTokenEscrow(null), null);
    });

    it('getTokenEscrow returns null when no row found', async function () {
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        stub.onCall(0).resolves([{ id: 1 }]); // createTicker
        stub.onCall(1).resolves([]);           // SELECT escrow
        assert.strictEqual(await db.getTokenEscrow('PEPE'), null);
    });

    it('getTokenEscrow returns null when escrow_action_index is null', async function () {
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        stub.onCall(0).resolves([{ id: 1 }]);
        stub.onCall(1).resolves([{ escrow_action_index: null }]);
        assert.strictEqual(await db.getTokenEscrow('PEPE'), null);
    });

    it('getTokenEscrow returns action_index when escrowed', async function () {
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        stub.onCall(0).resolves([{ id: 1 }]);
        stub.onCall(1).resolves([{ escrow_action_index: 77 }]);
        assert.strictEqual(await db.getTokenEscrow('PEPE'), 77);
    });

    it('isOwnershipEscrowed returns true when escrow action_index is set', async function () {
        const db = makeDb();
        sinon.stub(db, 'getTokenEscrow').resolves(77);
        assert.strictEqual(await db.isOwnershipEscrowed('PEPE'), true);
    });

    it('isOwnershipEscrowed returns false when not escrowed', async function () {
        const db = makeDb();
        sinon.stub(db, 'getTokenEscrow').resolves(null);
        assert.strictEqual(await db.isOwnershipEscrowed('PEPE'), false);
    });

    it('setTokenEscrow calls doQuery with UPDATE', async function () {
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        stub.onCall(0).resolves([{ id: 3 }]); // createTicker
        stub.onCall(1).resolves([]);           // UPDATE
        await db.setTokenEscrow('PEPE', 55);
        assert.match(stub.getCall(1).args[0], /UPDATE tokens/i);
    });
});

describe('Database token escrow methods @regression @tier1', function () {
    it('clearTokenEscrow calls doQuery with UPDATE setting NULL', async function () {
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        stub.onCall(0).resolves([{ id: 3 }]); // createTicker
        stub.onCall(1).resolves([]);           // UPDATE
        await db.clearTokenEscrow('PEPE');
        const sql = stub.getCall(1).args[0];
        assert.match(sql, /UPDATE tokens/i);
        assert.match(sql, /NULL/);
    });
});

// ---------------------------------------------------------------------------
// getMarketId / createMarket
// ---------------------------------------------------------------------------
describe('Database.getMarketId() @regression @tier1', function () {
    it('returns null when not found', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getMarketId(1, 2), null);
    });

    it('returns numeric id when found', async function () {
        const db = dbWithDoQuery([{ id: 4 }]);
        assert.strictEqual(await db.getMarketId(1, 2), 4);
    });
});

// ---------------------------------------------------------------------------
// getAddressOwnerships
// ---------------------------------------------------------------------------
describe('Database.getAddressOwnerships() @regression @tier1', function () {
    it('returns empty array when none found', async function () {
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        stub.onCall(0).resolves([{ id: 1 }]); // createAddress
        stub.onCall(1).resolves([]);           // SELECT tokens
        const result = await db.getAddressOwnerships('addr1');
        assert.deepStrictEqual(result, []);
    });

    it('returns array of tick strings when found', async function () {
        // getAddressOwnerships returns data.push(row.tick), an array of strings
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        stub.onCall(0).resolves([{ id: 2 }]);
        stub.onCall(1).resolves([{ tick: 'PEPE' }, { tick: 'DOGE' }]);
        const result = await db.getAddressOwnerships('addr1');
        assert.deepStrictEqual(result, ['PEPE', 'DOGE']);
    });

    it('excludes ticks whose ownership is escrowed by an open offer', async function () {
        // Escrowed ownership is in protocol custody and must never appear in an
        // address's ownership snapshot (SWEEP OWNERSHIPS=1 reaches it only via
        // the offer-close path). Pin the SQL predicate so the guard can't be
        // dropped silently.
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        stub.onCall(0).resolves([{ id: 2 }]);
        stub.onCall(1).resolves([]);
        await db.getAddressOwnerships('addr1');
        const query = String(stub.secondCall.args[0]).replace(/\s+/g, ' ');
        assert.ok(query.includes('escrow_action_index IS NULL'),
            'getAddressOwnerships must filter out escrowed ownerships');
    });
});

// ---------------------------------------------------------------------------
// getAddressPreferences: defaults + query branch
// ---------------------------------------------------------------------------
describe('Database.getAddressPreferences() @regression @tier1', function () {
    it('returns defaults when no rows found', async function () {
        const db = makeDb();
        sinon.stub(db, 'createAddress').resolves(1);
        sinon.stub(db, 'doQuery').resolves([]);
        const prefs = await db.getAddressPreferences('addr1', null, null);
        assert.strictEqual(prefs['FEE_PREFERENCE'], 2);
        assert.strictEqual(prefs['REQUIRE_MEMO'], 0);
        assert.strictEqual(prefs['DISPENSER_PREFERENCE'], 1);
    });

    it('overrides defaults from row', async function () {
        const db = makeDb();
        sinon.stub(db, 'createAddress').resolves(1);
        sinon.stub(db, 'doQuery').resolves([{ fee_preference: 1, require_memo: 1, dispenser_preference: 0 }]);
        const prefs = await db.getAddressPreferences('addr1', null, null);
        assert.strictEqual(prefs['FEE_PREFERENCE'], 1);
        assert.strictEqual(prefs['REQUIRE_MEMO'], 1);
        assert.strictEqual(prefs['DISPENSER_PREFERENCE'], 0);
    });
});

// ---------------------------------------------------------------------------
// getAddressEscrows: returns combined list
// ---------------------------------------------------------------------------
describe('Database.getAddressEscrows() @regression @tier1', function () {
    it('returns empty array when no escrows', async function () {
        const db = makeDb();
        sinon.stub(db, 'createAddress').resolves(1);
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        const escrows = await db.getAddressEscrows('addr1', null, null);
        assert.deepStrictEqual(escrows, []);
        // 3 queries: orders, swaps, dispensers
        assert.strictEqual(dq.callCount, 3);
    });

    it('collects order and swap escrows', async function () {
        const db = makeDb();
        sinon.stub(db, 'createAddress').resolves(1);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([{ action_index: 5 }]);   // orders
        dq.onCall(1).resolves([{ action_index: 8 }]);   // swaps
        dq.onCall(2).resolves([]);                       // dispensers
        const escrows = await db.getAddressEscrows('addr1', null, null);
        assert.strictEqual(escrows.length, 2);
        assert.strictEqual(escrows[0].type, 'order');
        assert.strictEqual(escrows[1].type, 'swap');
    });
});

// ---------------------------------------------------------------------------
// updateBalances: string, array, boolean branches
// ---------------------------------------------------------------------------
describe('Database.updateBalances() @regression @tier1', function () {
    it('handles string address, calls updateAddressBalance once', async function () {
        const db = makeDb();
        const stub = sinon.stub(db, 'updateAddressBalance').resolves();
        await db.updateBalances('addr1', false);
        assert.strictEqual(stub.callCount, 1);
    });

    it('handles array of addresses', async function () {
        const db = makeDb();
        const stub = sinon.stub(db, 'updateAddressBalance').resolves();
        await db.updateBalances(['addr1', 'addr2'], false);
        assert.strictEqual(stub.callCount, 2);
    });

    it('handles boolean true, fetches all addresses then calls once per row', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([{ address: 'addr1' }, { address: 'addr2' }]);
        const stub = sinon.stub(db, 'updateAddressBalance').resolves();
        await db.updateBalances(true, false);
        assert.strictEqual(stub.callCount, 2);
    });
});
