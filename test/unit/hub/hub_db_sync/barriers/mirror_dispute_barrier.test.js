// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Two mirror determinism defects from the offrail-mirror lane (2026-10-14):
//   - a hub price dispute (reorg_handler executeRollback, status 'disputed') never
//     reached a running mirror, because the price upsert refused finalized -> disputed,
//     so a long-running node kept reading a round a fresh node never held;
//   - the bridge, match and call content shortcuts opened on a MAX(effective_time) taken
//     over rows stamped with different relay margins, so a row stamped far ahead (a
//     DOGE -> BTC out-leg, a DOGE/BTC match, a dispatch sent to BTC) opened the barrier
//     while a row due earlier on this chain was not yet local.
//
// The upsert cases run the statement applyRow issues on a real SQL engine (node:sqlite,
// with the MariaDB ODKU spelled as the equivalent sqlite upsert), because a regex over
// the SQL text cannot say which row a mirror ends up holding.

process.env.INDEXER_COIN = 'DOGE';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { DatabaseSync } = require('node:sqlite');

const HubDbSync = require('../../../../../src/hub/hub_db_sync.js');
const { mirrorUpsertSql } = require('../../../../../src/hub/hub_db_sync/row_upserts.js');

// MariaDB `INSERT ... ON DUPLICATE KEY UPDATE` as the sqlite upsert on the same unique key.
// Every assignment here reads VALUES(status) and the row's own old column, so evaluating
// all of them against the old row (sqlite) and left to right (MariaDB) agree.
function toSqliteUpsert(sql, conflictKey) {
    return sql
        .replace(' ON DUPLICATE KEY UPDATE ', ' ON CONFLICT(' + conflictKey + ') DO UPDATE SET ')
        .replace(/VALUES\(`?(\w+)`?\)/g, 'excluded.$1')
        .replace(/\bIF\(/g, 'iif(')
        .replace(/\bGREATEST\(/g, 'max(')
        .replace(/`/g, '"');
}

const PRICE_COLS = ['round_number', 'coin_pair', 'price', 'reference_block', 'block_timestamp', 'status',
                    'source_chain', 'source_action_index', 'push_generation', 'batch_block_time'];

function priceDb() {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE price_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, round_number INTEGER NOT NULL, ' +
            'coin_pair TEXT NOT NULL, price TEXT, reference_block INTEGER, block_timestamp INTEGER, status TEXT NOT NULL, ' +
            'source_chain TEXT, source_action_index INTEGER, push_generation INTEGER, batch_block_time INTEGER, ' +
            'UNIQUE (round_number, coin_pair))');
    const sql = toSqliteUpsert(mirrorUpsertSql('price_snapshots', PRICE_COLS), 'round_number, coin_pair');
    const apply = (row) => db.prepare(sql).run(...PRICE_COLS.map(c => row[c] === undefined ? null : row[c]));
    const read = () => db.prepare('SELECT * FROM price_snapshots').all().map(r => Object.assign({}, r));
    return { db, apply, read };
}

function round(over) {
    return Object.assign({ round_number: 3, coin_pair: 'DOGE/USD', price: '0.3', reference_block: 103,
        block_timestamp: 5003, status: 'finalized', source_chain: 'DOGE', source_action_index: 503,
        push_generation: 0, batch_block_time: 0 }, over || {});
}

describe('hub_db_sync price dispute reaches a running mirror @regression @tier1', function () {
    it('a disputed row takes a mirrored finalized round out of the finalized set', function () {
        const m = priceDb();
        m.apply(round());
        m.apply(round({ status: 'disputed' }));
        const rows = m.read();
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].status, 'disputed', 'a running mirror must land on the hub row');
    });

    it('lands on the same row a fresh drain of the hub table inserts', function () {
        const running = priceDb(), fresh = priceDb();
        running.apply(round());
        running.apply(round({ status: 'disputed', batch_block_time: 5500 }));
        fresh.apply(round({ status: 'disputed', batch_block_time: 5500 }));
        const strip = (rows) => rows.map(r => { const o = Object.assign({}, r); delete o.id; return o; });
        assert.deepStrictEqual(strip(running.read()), strip(fresh.read()));
    });

    it('redelivery of the dispute is idempotent', function () {
        const m = priceDb();
        m.apply(round());
        m.apply(round({ status: 'disputed' }));
        const once = JSON.stringify(m.read());
        m.apply(round({ status: 'disputed' }));
        assert.strictEqual(JSON.stringify(m.read()), once);
    });

    it('a skipped placeholder never demotes a finalized or a disputed round', function () {
        const m = priceDb();
        m.apply(round());
        m.apply(round({ status: 'skipped', price: null }));
        assert.strictEqual(m.read()[0].status, 'finalized');
        assert.strictEqual(m.read()[0].price, '0.3');
        m.apply(round({ status: 'disputed' }));
        m.apply(round({ status: 'skipped', price: null }));
        assert.strictEqual(m.read()[0].status, 'disputed');
    });

    it('a round the hub re-finalizes after a dispute comes back, and skipped still upgrades', function () {
        const m = priceDb();
        m.apply(round({ status: 'disputed' }));
        m.apply(round({ price: '0.31' }));
        assert.strictEqual(m.read()[0].status, 'finalized');
        assert.strictEqual(m.read()[0].price, '0.31');
        const s = priceDb();
        s.apply(round({ status: 'skipped', price: null }));
        s.apply(round());
        assert.strictEqual(s.read()[0].status, 'finalized');
        assert.strictEqual(s.read()[0].price, '0.3');
    });
});

// A HubDbSync for chain `coin` whose watermark read answers `answer(sql, args)`.
function makeSync(coin, answer) {
    const calls = [];
    const doQuery = sinon.stub().callsFake(async (sql, args) => {
        calls.push({ sql, args });
        if (/information_schema\.TABLES/i.test(sql)) return [{ TABLE_NAME: args[0] }];
        return answer ? answer(sql, args) : [];
    });
    const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test', coin: coin });
    sync._bootstrapDrained = true;
    return { sync, calls };
}

// A hub clock second the relay cases below are stamped from.
const t = 20000;

describe('hub_db_sync match and call content shortcuts read one relay margin @regression @tier1', function () {

    it('match: a DOGE/BTC match stamped 2400 s ahead does not vouch for a DOGE/LTC match due earlier', async function () {
        // DOGE/BTC finalized at t carries t + 2400; a DOGE/LTC match finalized at t + 100
        // carries t + 700. On a DOGE node the block at t + 800 must wait for it.
        const { sync } = makeSync('DOGE', () => [{ ts: t + 2400, finalized_ts: t }]);
        sync.matchBootstrapped = true;
        await sync.refreshMatchSyncTimestamp();
        assert.strictEqual(sync.matchSyncTimestamp, t + 2400);
        assert.strictEqual(sync.matchSyncSatisfied(t + 800), false, 'the shortcut must not open');
        // Through t + 240 nothing finalized after t can be due: every match touching DOGE
        // carries at least DOGE's own 240 s floor.
        assert.strictEqual(sync.matchSyncSatisfied(t + 240), true);
    });

    it('match: the coverage statement computes each match\'s own margin on a real engine', async function () {
        const db = new DatabaseSync(':memory:');
        db.exec('CREATE TABLE cross_chain_matches (a_chain TEXT, b_chain TEXT, effective_time INTEGER, status TEXT)');
        const ins = db.prepare('INSERT INTO cross_chain_matches VALUES (?, ?, ?, ?)');
        ins.run('DOGE', 'BTC', t + 2400, 'finalized');      // stamped at t
        ins.run('DOGE', 'LTC', t - 500 + 600, 'finalized');  // stamped at t - 500
        ins.run('BTC', 'LTC', t + 9000, 'finalized');        // touches neither leg on DOGE
        const { sync, calls } = makeSync('DOGE', (sql, args) =>
            db.prepare(toSqliteUpsert(sql, '')).all(...args).map(r => Object.assign({}, r)));
        sync.matchBootstrapped = true;
        await sync.refreshMatchSyncTimestamp();
        assert.ok(calls.some(c => /FROM cross_chain_matches/.test(c.sql)));
        assert.strictEqual(sync.matchSyncTimestamp, t + 2400);
        assert.strictEqual(sync.matchCoveredTimestamp, t + 240);
    });

    it('call: a dispatch this chain sent to BTC does not vouch for a dispatch it must inject', async function () {
        // The DOGE -> BTC dispatch is gated by BTC (t + 2400); the LTC -> DOGE dispatch
        // finalized after it is gated by DOGE and due at t + 340.
        const { sync, calls } = makeSync('DOGE', () => [{ ts: t + 2400, gated_ts: null }]);
        sync.callBootstrapped = true;
        await sync.refreshCallSyncTimestamp();
        assert.ok(calls.some(c => /phase = 'dispatch' AND target_chain = \?/.test(c.sql)));
        assert.strictEqual(sync.callSyncTimestamp, t + 2400);
        assert.strictEqual(sync.callSyncSatisfied(t + 400), false, 'the shortcut must not open');
        sync.callGatedSyncTimestamp = t + 400;
        assert.strictEqual(sync.callSyncSatisfied(t + 400), true);
    });

});

describe('hub_db_sync bridge content shortcut and empty-mirror paths @regression @tier1', function () {
    it('bridge: an out-leg stamped with a longer margin does not open the shortcut, an in-leg does', async function () {
        // offrail-mirror bridge_content_escape: on DOGE, a DOGE -> BTC out-leg finalized at t
        // carries t + 2400 while an LTC -> DOGE in-leg finalized at t + 100 carries t + 340.
        const { sync, calls } = makeSync('DOGE', () => [{ ts: t + 2400, dest_ts: null }]);
        sync.bridgeBootstrapped = true;
        await sync.refreshBridgeSyncTimestamp();
        assert.ok(calls.some(c => /CASE WHEN dest_chain = \? THEN effective_time END/.test(c.sql)));
        assert.strictEqual(sync.bridgeSyncTimestamp, t + 2400);
        assert.strictEqual(sync.bridgeDestSyncTimestamp, null);
        assert.strictEqual(sync.bridgeSyncSatisfied(t + 400), false, 'an out-leg must not open the barrier');
        // An in-leg effective at or past the block proves every earlier in-leg is local.
        sync.bridgeDestSyncTimestamp = t + 400;
        assert.strictEqual(sync.bridgeSyncSatisfied(t + 400), true);
    });

    it('bridge: the empty-mirror path waits for a drained connection', function () {
        // bridgeBootstrapped outlives a close; resetOnSocketClose clears _bootstrapDrained.
        // A transfer finalized during the outage is due 240 s later on DOGE and is not local.
        const { sync } = makeSync('DOGE');
        sync.bridgeBootstrapped  = true;
        sync.bridgeSyncTimestamp = null;
        sync._bootstrapDrained   = false;
        assert.strictEqual(sync.bridgeSyncSatisfied(1000), false, 'closed socket: must defer');
        sync._bootstrapDrained   = true;
        assert.strictEqual(sync.bridgeSyncSatisfied(1000), true, 're-drained: the empty scope is proven again');
    });

    it('match and call: the empty-mirror path waits for a drained connection', function () {
        const { sync } = makeSync('DOGE');
        sync.matchBootstrapped = true; sync.callBootstrapped = true;
        sync.matchSyncTimestamp = null; sync.callSyncTimestamp = null;
        sync._bootstrapDrained = false;
        assert.strictEqual(sync.matchSyncSatisfied(1000), false);
        assert.strictEqual(sync.callSyncSatisfied(1000), false);
        sync._bootstrapDrained = true;
        assert.strictEqual(sync.matchSyncSatisfied(1000), true);
        assert.strictEqual(sync.callSyncSatisfied(1000), true);
    });
});
