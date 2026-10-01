'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const sinon = require('sinon');

const gateRegistry = require('../../../../src/consensus/gate_registry');
const tickerQueries = require('../../../../src/db/index_tables/tickers');
const { listItemId } = require('../../../../src/db/lists/membership');

const GATE_KEY = 'list_tick_coin_activation.LIST_TICK_COIN_ACTIVATION';

function harness(extraRows=[]){
    const rows = [
        { id: 40, tick: 'doge:pepe', block_index: 900 },
        ...extraRows,
    ];
    const inserts = [];
    const queries = [];
    const db = {
        config: {
            NETWORK: 'regtest',
            COIN: 'BTC',
            COINS: ['BTC', 'DOGE'],
        },
        util: {
            isNull: value => value === null || value === undefined || value === '',
        },
        transactionConnection: { id: 1 },
        blockIndex: 901,
        suppressIndexIdCreation: false,
        deterministicIndexingStarted: true,
        _internCache: null,
        createAddress: sinon.stub().resolves(80),

        async doQuery(sql, args=[]){
            queries.push({ sql, args });
            if(sql === 'SELECT id FROM index_tickers WHERE tick=? LIMIT 1'){
                const row = rows.find(candidate => candidate.tick === args[0]);
                return row ? [{ id: row.id }] : [];
            }
            if(sql === 'SELECT id FROM index_tickers WHERE LOWER(tick)=? ORDER BY id ASC LIMIT 1'){
                const matches = rows
                    .filter(candidate => candidate.tick.toLowerCase() === args[0])
                    .sort((left, right) => left.id - right.id);
                return matches.length > 0 ? [{ id: matches[0].id }] : [];
            }
            if(sql === 'SELECT id FROM index_tickers ORDER BY id DESC LIMIT 1 FOR UPDATE'){
                const ordered = rows.slice().sort((left, right) => right.id - left.id);
                return ordered.length > 0 ? [{ id: ordered[0].id }] : [];
            }
            if(sql === 'INSERT IGNORE INTO index_tickers (`id`, `tick`, `block_index`) values (?, ?, ?)'){
                const [id, tick, block_index] = args;
                inserts.push({ id, tick, block_index });
                if(!rows.some(candidate => candidate.tick === tick))
                    rows.push({ id, tick, block_index });
                return { affectedRows: 1 };
            }
            throw new Error('Unexpected query: ' + sql);
        },
    };
    Object.assign(db, tickerQueries);
    return { db, rows, inserts, queries };
}

describe('LIST tick-coin exact-case storage @unit @regression', function () {
    afterEach(function () { sinon.restore(); });

    it('keeps qualified ticker storage case-folded below the gate', async function () {
        const { db, rows, inserts } = harness();
        sinon.stub(gateRegistry, 'activeAt').withArgs(
            GATE_KEY, 'regtest', 'BTC', 901, null
        ).returns(false);
        const legacy = sinon.spy(db, 'createTicker');
        const exact = sinon.spy(db, 'createTickerExact');

        assert.strictEqual(await listItemId(db, 1, 'DOGE:PEPE'), 40);
        sinon.assert.calledOnceWithExactly(legacy, 'DOGE:PEPE');
        sinon.assert.notCalled(exact);
        assert.deepStrictEqual(rows, [{ id: 40, tick: 'doge:pepe', block_index: 900 }]);
        assert.deepStrictEqual(inserts, []);
    });

    it('assigns and reuses an exact case variant with its block stamp when armed', async function () {
        const { db, rows, inserts, queries } = harness();
        sinon.stub(gateRegistry, 'activeAt').withArgs(
            GATE_KEY, 'regtest', 'BTC', 901, null
        ).returns(true);

        assert.strictEqual(await listItemId(db, 1, 'DOGE:PEPE'), 41);
        assert.strictEqual(await listItemId(db, 1, 'DOGE:PEPE'), 41);
        assert.deepStrictEqual(inserts, [
            { id: 41, tick: 'DOGE:PEPE', block_index: 901 },
        ]);
        assert.deepStrictEqual(rows, [
            { id: 40, tick: 'doge:pepe', block_index: 900 },
            { id: 41, tick: 'DOGE:PEPE', block_index: 901 },
        ]);

        assert.strictEqual(await db.getTickerId('doge:pepe'), 40);
        const lookup = queries[queries.length - 1];
        assert.strictEqual(lookup.sql,
            'SELECT id FROM index_tickers WHERE LOWER(tick)=? ORDER BY id ASC LIMIT 1');
        assert.deepStrictEqual(lookup.args, ['doge:pepe']);
    });

    it('resolves existing exact rows but creates none during rollback refresh', async function () {
        const { db, inserts } = harness([
            { id: 41, tick: 'DOGE:PEPE', block_index: 901 },
        ]);
        sinon.stub(gateRegistry, 'activeAt').returns(true);
        db.suppressIndexIdCreation = true;

        assert.strictEqual(await listItemId(db, 1, 'DOGE:PEPE'), 41);
        assert.strictEqual(await listItemId(db, 1, 'DOGE:SHIB'), null);
        assert.deepStrictEqual(inserts, []);
    });

    it('keeps bare tickers, addresses, and union ids on their existing paths', async function () {
        const { db } = harness();
        sinon.stub(gateRegistry, 'activeAt').returns(true);
        sinon.stub(db, 'createTicker').resolves(50);
        const exact = sinon.spy(db, 'createTickerExact');

        assert.strictEqual(await listItemId(db, 1, 'PEPE'), 50);
        assert.strictEqual(await listItemId(db, 2, 'address'), 80);
        assert.strictEqual(await listItemId(db, 3, '123'), '123');
        assert.strictEqual(await listItemId(db, 3, '0123'), null);
        sinon.assert.calledOnceWithExactly(db.createTicker, 'PEPE');
        sinon.assert.calledOnceWithExactly(db.createAddress, 'address');
        sinon.assert.notCalled(exact);
    });
});
