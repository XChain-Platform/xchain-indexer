// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer } = require('../../../fixtures/mocks');
const fs                    = require('fs');
const path                  = require('path');
const { makeMigrationDb, toSqlite } = require('../../../helpers/sqlMigrationDb');
const Rollback              = require('../../../../src/rollback/index.js');

const LOADED = ['index_statuses', 'index_tickers', 'tokens', 'xbridges'];

// sqlite takes no inline KEY clauses, so xbridges loads with its comments and keys dropped;
// keys change plans, never results.
function xbridgesDdl() {
    const ddl = fs.readFileSync(path.join(__dirname, '../../../../src/sql/xbridges.sql'), 'utf8');
    return toSqlite(ddl.replace(/--[^\n]*/g, ''))
        .replace(/^\s*(UNIQUE\s+)?KEY\b[^\n]*\n/gim, '').replace(/,\s*\)/g, ')');
}

// The four tables the bridged bit depends on, from the project's own DDL. A statement that
// names any other table belongs to a rollback step this suite does not exercise and answers
// empty; every statement over the loaded tables runs for real.
function makeStore() {
    const sql = makeMigrationDb(['index_statuses.sql', 'index_tickers.sql', 'tokens.sql']);
    sql.db.exec(xbridgesDdl());
    sql.insert('index_statuses', { id: 1, status: 'valid' });
    sql.insert('index_statuses', { id: 2, status: 'invalid: TICK (not native here)' });
    sql.insert('index_tickers', { id: 7, tick: 'GOLD' });
    sql.insert('index_tickers', { id: 8, tick: 'SILVER' });
    sql.insert('index_tickers', { id: 9, tick: 'LEAD' });
    for (const tick_id of [7, 8, 9]) sql.insert('tokens', { tick_id, action_index: tick_id, supply: '100', bridged: 1 });
    // GOLD's only lock is orphaned; SILVER keeps a surviving lock; LEAD's surviving lock was refused.
    sql.insert('xbridges', { action_index: 60, version: 3, tick_id: 7, status_id: 1, block_index: 100 });
    sql.insert('xbridges', { action_index: 20, version: 3, tick_id: 8, status_id: 1, block_index: 90 });
    sql.insert('xbridges', { action_index: 21, version: 3, tick_id: 9, status_id: 2, block_index: 90 });
    const tables = (q) => [...q.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+`?(\w+)/gi)].map(m => m[1]);
    const doQuery = async (q, args) => {
        if (!tables(q).every(t => LOADED.includes(t))) return [];
        const stmt = sql.db.prepare(q);
        return /^\s*SELECT/i.test(q) ? stmt.all(...(args || [])) : stmt.run(...(args || []));
    };
    return { sql, doQuery };
}

describe('reorg rollback re-derives tokens.bridged from the surviving locks @regression @tier3', function () {
    afterEach(() => sinon.restore());

    it('clears the bit an orphaned first lock set, and keeps every bit a surviving lock explains', async function () {
        const store   = makeStore();
        const indexer = createMockIndexer();
        indexer.indexerDb.doQuery = sinon.spy(store.doQuery);
        const rollback = new Rollback(indexer);

        await rollback.restoreInPlaceFlips(100, 50);

        const bridged = store.sql.rows('SELECT tick_id, bridged FROM tokens ORDER BY tick_id');
        // A node that never saw action 60 holds GOLD unbridged and SILVER bridged. LEAD's
        // refused lock never set the bit on a clean node, so a stale 1 there clears as well.
        assert.deepStrictEqual(bridged, [
            { tick_id: 7, bridged: 0 },
            { tick_id: 8, bridged: 1 },
            { tick_id: 9, bridged: 0 },
        ]);
        assert.deepStrictEqual(store.sql.rows('SELECT action_index FROM xbridges ORDER BY action_index'),
            [{ action_index: 20 }, { action_index: 21 }], 'the orphaned lock row itself is purged');
        store.sql.close();
    });

    it('leaves the bit alone when nothing was orphaned', async function () {
        const store   = makeStore();
        const indexer = createMockIndexer();
        indexer.indexerDb.doQuery = sinon.spy(store.doQuery);
        await new Rollback(indexer).restoreInPlaceFlips(100, null);
        assert.strictEqual(store.sql.rows('SELECT bridged FROM tokens WHERE tick_id=7')[0].bridged, 1);
        store.sql.close();
    });
});
