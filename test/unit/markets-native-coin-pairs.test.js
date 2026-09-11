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
 * A market side is a token OR the chain's native coin, and the coin has no
 * index_tickers row. These pin the sentinel that lets such a pair be one row:
 * the two collectors agree on it, createMarket writes it, and the reorg sweeps
 * that read `markets` do not mistake it for a dangling ticker id.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const sinon  = require('sinon');

const { getTestConfig }     = require('../fixtures/config');
const { createMockIndexer } = require('../fixtures/mocks');
const Utility               = require('../../src/utility');
const Database              = require('../../src/db');
const Rollback              = require('../../src/rollback');

// Ids used throughout: DOGESWAP is a token, the native coin has no ticker.
const TOKEN_A = 5;
const TOKEN_B = 9;
const COIN    = 1;

function makeDb() {
    const util = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'db', 'u', 'p', { config: getTestConfig(), util });
    db.pool = { getConnection: sinon.stub().resolves({}) };
    sinon.stub(db, 'getBlockTime').resolves(1700000000);
    return db;
}

// Program the block-path collector with one ORDER batch.
function collectorOn(db, orderRows) {
    sinon.stub(db, 'doQuery').callsFake(async (query) => {
        if (/count\(\*\) as count/.test(query)) return [{ count: orderRows.length, type: 'ORDER' }];
        if (/FROM\s+orders o1/.test(query)) return orderRows;
        return [];
    });
}

// The orientation-free identity of a collected pair, so the two collectors can be
// compared without depending on which orientation each happened to see first.
const pairKey = (p) => Math.min(p.tick1_id, p.tick2_id) + ':' + Math.max(p.tick1_id, p.tick2_id);

afterEach(function () { sinon.restore(); });

describe('markets: a token against the native coin @regression @tier1', function () {

    it('collects ONE pair from two opposite-orientation orders on a token/native market', async function () {
        const db = makeDb();
        collectorOn(db, [
            // give DOGESWAP, get the native coin
            { action_index: 1, tick1_id: null,    tick2_id: TOKEN_A, coin1_id: COIN, coin2_id: COIN },
            // the same market, written the other way round
            { action_index: 2, tick1_id: TOKEN_A, tick2_id: null,    coin1_id: COIN, coin2_id: COIN }
        ]);
        const markets = await db.getMarkets(100, false);
        assert.strictEqual(markets.length, 1,
            'both orientations of one token/native market must dedupe to a single pair');
        assert.deepStrictEqual(markets[0], {
            tick1_id: Database.MARKET_NATIVE_TICK_ID,
            tick2_id: TOKEN_A,
            coin1_id: COIN,
            coin2_id: COIN
        });
    });

    it('leaves a token/token pair on exactly the ids it always carried', async function () {
        const db = makeDb();
        collectorOn(db, [
            { action_index: 1, tick1_id: TOKEN_A, tick2_id: TOKEN_B, coin1_id: COIN, coin2_id: COIN },
            { action_index: 2, tick1_id: TOKEN_B, tick2_id: TOKEN_A, coin1_id: COIN, coin2_id: COIN }
        ]);
        const markets = await db.getMarkets(100, false);
        assert.strictEqual(markets.length, 1);
        assert.strictEqual(markets[0].tick1_id, TOKEN_A);
        assert.strictEqual(markets[0].tick2_id, TOKEN_B);
    });

    it('createMarket writes the sentinel and the coin ids, never a NULL side', async function () {
        const db = makeDb();
        const q  = sinon.stub(db, 'doQuery');
        q.onCall(0).resolves([]);                  // getMarketId: no such market yet
        q.onCall(1).resolves({ insertId: 42 });    // the INSERT
        const id = await db.createMarket(null, TOKEN_A, COIN, COIN);
        assert.strictEqual(id, 42);
        assert.deepStrictEqual(q.getCall(0).args[1], [0, TOKEN_A, TOKEN_A, 0],
            'getMarketId must look the pair up under the sentinel; a NULL argument matches no row');
        assert.ok(/INSERT INTO markets \(tick1_id, tick2_id, coin1_id, coin2_id\)/.test(q.getCall(1).args[0]));
        assert.deepStrictEqual(q.getCall(1).args[1], [0, TOKEN_A, COIN, COIN]);
    });

    it('labels an existing unlabelled row with exactly one UPDATE', async function () {
        const db = makeDb();
        const q  = sinon.stub(db, 'doQuery');
        // The row every live database already holds for a token/native pair: keyed on
        // the sentinel by the collector, written before the coin columns existed.
        q.onCall(0).resolves([{ id: 42, tick1_id: 0, coin1_id: 0, coin2_id: 0 }]);
        q.onCall(1).resolves({ affectedRows: 1 });
        const id = await db.createMarket(null, TOKEN_A, COIN, COIN);
        assert.strictEqual(id, 42);
        assert.strictEqual(q.callCount, 2, 'the lookup, then exactly one heal');
        const [sql, args] = q.getCall(1).args;
        assert.ok(/^UPDATE\s+markets/.test(sql.trim()),
            'an existing row never reaches the INSERT, so nothing else can label it');
        assert.ok(/WHERE id=\? AND \(coin1_id=0 OR coin2_id=0\)/.test(sql),
            'the heal must not overwrite a row that is already labelled');
        // Two CASEs keyed on the row's own tick1_id: getMarketRow matches either
        // orientation, so the coin ids have to follow the one the row stores.
        assert.ok(/coin1_id = CASE WHEN tick1_id=\? THEN \? ELSE \? END/.test(sql));
        assert.ok(/coin2_id = CASE WHEN tick1_id=\? THEN \? ELSE \? END/.test(sql));
        assert.deepStrictEqual(args, [0, COIN, COIN, 0, COIN, COIN, 42]);
    });

    it('leaves a row that already carries its coin ids untouched', async function () {
        const db = makeDb();
        const q  = sinon.stub(db, 'doQuery');
        q.onCall(0).resolves([{ id: 42, tick1_id: 0, coin1_id: COIN, coin2_id: COIN }]);
        const id = await db.createMarket(null, TOKEN_A, COIN, COIN);
        assert.strictEqual(id, 42);
        assert.strictEqual(q.callCount, 1, 'a labelled row costs the lookup and nothing else');
    });

    it('the ageing sweep labels a row the block path can never reach', async function () {
        const db = makeDb();
        const q  = sinon.stub(db, 'doQuery');
        q.onCall(0).resolves([{ market_id: 7, tick1: null, tick1_id: 0, tick1_decimals: 8,
                                tick2: 'DOGESWAP', tick2_id: TOKEN_A, tick2_decimals: 8,
                                coin1_id: 0, coin2_id: 0 }]);
        // The pair's earliest order gives the token and gets the coin, so the row's
        // side 1 (the sentinel) is the order's GET side. The two coin ids differ only
        // so the assertion can tell the sides apart; a live market carries one id.
        q.onCall(1).resolves([{ give_tick_id: TOKEN_A, give_coin_id: 2, get_coin_id: 3 }]);
        q.resolves([]);
        const data = await db.getMarketInfo(7, 1700000000);
        const derive = q.getCall(1).args[0];
        assert.ok(/FROM orders o/.test(derive) && /ORDER BY o\.action_index ASC/.test(derive),
            'the labels come from the pair\'s earliest order, which is what createMarket saw');
        assert.strictEqual(data.coin1_id, 3);
        assert.strictEqual(data.coin2_id, 2);
    });

    it('persists the derived labels, and only once both sides are known', async function () {
        const db = makeDb();
        const q  = sinon.stub(db, 'doQuery').resolves({});
        await db.updateMarketInfo({ market_id: 7, coin1_id: COIN, coin2_id: COIN });
        assert.ok(/coin1_id=\?/.test(q.getCall(0).args[0]) && /coin2_id=\?/.test(q.getCall(0).args[0]));
        assert.deepStrictEqual(q.getCall(0).args[1].slice(-3), [COIN, COIN, 7]);
        q.resetHistory();
        await db.updateMarketInfo({ market_id: 7 });
        assert.ok(!/coin1_id=\?/.test(q.getCall(0).args[0]),
            'a pair with no surviving order keeps whatever labels it has, never a 0');
        assert.strictEqual(q.getCall(0).args[1].slice(-1)[0], 7);
    });

    it('getMarketInfo resolves a tickerless side through index_coins', async function () {
        const db = makeDb();
        const q  = sinon.stub(db, 'doQuery').resolves([]);
        await db.getMarketInfo(7, 1700000000);
        const lookup = q.getCall(0).args[0];
        assert.ok(/LEFT JOIN index_coins   c1/.test(lookup) && /LEFT JOIN index_coins   c2/.test(lookup),
            'the market lookup must reach index_coins for a side that has no ticker');
        assert.ok(!/INNER JOIN tokens/.test(lookup),
            'an inner join on tokens drops the whole market when either side is the native coin');
        assert.ok(/COALESCE\(t3\.tick, c1\.coin\)/.test(lookup));
        // The five stats queries filter order/order_matches sides, which store NULL there.
        const filtered = q.getCalls().slice(1).filter(c => /COALESCE\((m1|o1)\.give_tick_id,0\)=\?/.test(c.args[0]));
        assert.strictEqual(filtered.length, 5,
            'every price/bid/ask/volume query must compare the sides NULL-aware, or the pair prices at zero');
    });
});

describe('markets: the rollback collector agrees with the block path @regression @tier1', function () {
    let indexer, rollback;

    beforeEach(function () {
        indexer = createMockIndexer();
        indexer.protocolChanges = {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true)
        };
        rollback = new Rollback(indexer);
        indexer.util.resetLists();
    });

    it('keeps the token/native pair the block path keeps, under the same key', async function () {
        const orderRows = [
            { tick1_id: null,    tick2_id: TOKEN_A, coin1_id: COIN, coin2_id: COIN },
            { tick1_id: TOKEN_A, tick2_id: null,    coin1_id: COIN, coin2_id: COIN }
        ];
        indexer.indexerDb.doQuery.callsFake(async (query) => {
            if (/FROM\s+actions\s+a/i.test(query) && /a\.action_index/i.test(query)) return [{ action_index: 50 }];
            if (/FROM\s+orders\s+m/i.test(query) && /m\.give_tick_id/i.test(query)) return orderRows;
            // A surviving order for the pair, so the zombie sweep does not delete it.
            if (/SELECT 1 FROM orders o/i.test(query)) return [{ 1: 1 }];
            return [];
        });
        await rollback.rollback(100);
        const pairs = indexer.indexerDb.updateMarkets.getCall(0).args[0];
        assert.deepStrictEqual(pairs.map(pairKey), [Database.MARKET_NATIVE_TICK_ID + ':' + TOKEN_A],
            'a reorg that orphans a token/native market must schedule that market for recompute');
        assert.strictEqual(pairs[0].coin1_id, COIN);
        assert.strictEqual(pairs[0].coin2_id, COIN);
    });

    it('exempts the sentinel from the dangling-ticker sweep', async function () {
        indexer.indexerDb.doQuery.onFirstCall().resolves([{ action_index: 50 }]);
        indexer.indexerDb.doQuery.resolves([]);
        await rollback.rollback(100);
        const sweep = indexer.indexerDb.doQuery.getCalls().find(c =>
            /DELETE FROM markets\s+WHERE/.test(c.args[0]) && /NOT IN \(SELECT id FROM index_tickers\)/.test(c.args[0]));
        assert.ok(sweep, 'expected the dangling-ticker markets sweep');
        assert.ok(/tick1_id <> \? AND/.test(sweep.args[0]) && /tick2_id <> \? AND/.test(sweep.args[0]),
            'the sweep must skip the native-coin sentinel, which is not a dangling ticker id');
        assert.deepStrictEqual(sweep.args[1],
            [Database.MARKET_NATIVE_TICK_ID, Database.MARKET_NATIVE_TICK_ID]);
    });

    it('probes order survival NULL-aware, so a live token/native market is not swept as a zombie', async function () {
        indexer.indexerDb.doQuery.callsFake(async (query) => {
            if (/FROM\s+actions\s+a/i.test(query) && /a\.action_index/i.test(query)) return [{ action_index: 50 }];
            if (/FROM\s+orders\s+m/i.test(query) && /m\.give_tick_id/i.test(query))
                return [{ tick1_id: null, tick2_id: TOKEN_A, coin1_id: COIN, coin2_id: COIN }];
            if (/SELECT 1 FROM orders o/i.test(query)) return [{ 1: 1 }];
            return [];
        });
        await rollback.rollback(100);
        const probe = indexer.indexerDb.doQuery.getCalls().find(c => /SELECT 1 FROM orders o/.test(c.args[0]));
        assert.ok(probe, 'expected the per-pair survival probe');
        assert.ok(/COALESCE\(o\.give_tick_id,0\)=\?/.test(probe.args[0]),
            'orders store NULL where markets stores the sentinel; a bare compare finds no survivor and deletes a live market');
        const zombieDelete = indexer.indexerDb.doQuery.getCalls().find(c =>
            /DELETE FROM markets WHERE \(tick1_id=\? AND tick2_id=\?\)/.test(c.args[0]));
        assert.strictEqual(zombieDelete, undefined,
            'a pair with a surviving order must not be deleted');
    });
});

describe('markets: the migration that rebuilds the missing rows @regression @tier1', function () {
    const FILE = path.join(__dirname, '..', '..', 'src', 'sql', 'migrations',
                           '2026-09-10-markets-native-coin-side.sql');
    const raw  = fs.readFileSync(FILE, 'utf8');
    // The same header read and quote-aware split runMigrations applies to the file.
    const mode = Database.prototype._migrationMode.call({}, raw);
    const statements = Database.prototype.splitSqlStatements.call(Database.prototype, raw)
        .map(s => String(s).trim()).filter(Boolean);

    it('parses into the five statements the runner will execute, in order', function () {
        const heads = statements.map(s => s.split(/\s+/).slice(0, 2).join(' ').toUpperCase());
        assert.deepStrictEqual(heads,
            ['ALTER TABLE', 'DELETE M', 'UPDATE MARKETS', 'UPDATE MARKETS', 'INSERT INTO', 'UPDATE MARKETS']);
    });

    it('collapses surplus rows BEFORE normalizing a NULL side onto the sentinel', function () {
        const del  = statements.findIndex(s => /^DELETE/i.test(s));
        const norm = statements.findIndex(s => /^UPDATE markets SET tick1_id = 0/i.test(s));
        assert.ok(del >= 0 && norm >= 0);
        assert.ok(del < norm,
            'two rows differing only in a NULL side normalize onto one key, so the ' +
            'UPDATE aborts on uq_markets_pair unless the surplus row is gone first');
    });

    it('deletes only surplus rows of a pair that keeps its lowest-id row', function () {
        const deletes = statements.filter(s => /^DELETE/i.test(s));
        assert.strictEqual(deletes.length, 1, 'a replica upsert can never remove a row it was sent');
        assert.ok(/MIN\(id\) AS keep_id/.test(deletes[0]) && /m\.id <> dup\.keep_id/.test(deletes[0]),
            'the survivor is the lowest id, so no market_id moves');
    });

    it('adds a missing pair instead of rebuilding every pair', function () {
        const insert = statements.find(s => /^INSERT INTO markets/i.test(s));
        assert.ok(/LEFT JOIN \(SELECT tick1_id, tick2_id FROM markets\) m/.test(insert) &&
                  /WHERE m\.tick1_id IS NULL/.test(insert),
            'a pair that still has its row must be anti-joined out, id and orientation intact');
        assert.ok(/k\.first_key = f\.ord_key/.test(insert),
            'orientation comes from the pair\'s earliest action, so two nodes agree');
    });

    it('is manual, and cannot be retagged auto', function () {
        assert.strictEqual(mode, 'manual');
        const flagged = statements.filter(s =>
            Database.prototype._destructiveAutoStatement.call(Database.prototype, [s]));
        assert.ok(flagged.length >= 3,
            'the DELETE and the bare UPDATEs each refuse the auto path, so a mode=auto ' +
            'tag would make runMigrations throw at boot rather than run unattended');
    });
});
