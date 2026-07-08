// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

/*
 * H-3 / NATIVE_FEE_PRICE_TIME_GATE + M-17 regressions.
 *
 * H-3: price rounds are anchored to BTC heights, so getLatestPrice's
 * `reference_block <= blockIndex` gate is vacuous against LTC/DOGE heights;
 * the query returned whatever globally-latest round the local mirror held
 * (mirror lag forked the fleet; a from-genesis replay read today's newest
 * round instead of the round used live). At/after the flag-day, non-reference
 * chains select by the round's consensus timestamp and the block loop gates
 * on the time-keyed price barrier.
 *
 * M-17: the price read is a consensus input served by the hub-DB mirror
 * OUTSIDE the block transaction, where doQuery swallowed query errors into []
 * ("no price" → fee fails closed on this node only → fork). getLatestPrice
 * now reads via doQueryStrict, which always throws, so block processing
 * rolls back and retries instead.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');
const changes           = require('../../src/protocol_changes.js');

const GATE = changes.NATIVE_FEE_PRICE_TIME_GATE_MAINNET_TIME;

function makeDb() {
    const config  = getTestConfig();
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const indexer = { config, util };
    const db      = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
    db.pool = { getConnection: sinon.stub().resolves({
        query:            sinon.stub().resolves([]),
        release:          sinon.stub().resolves(),
        beginTransaction: sinon.stub().resolves(),
        commit:           sinon.stub().resolves(),
        rollback:         sinon.stub().resolves()
    }) };
    return db;
}

afterEach(function () {
    sinon.restore();
});

describe('NATIVE_FEE_PRICE_TIME_GATE predicate @regression @tier1', function () {

    it('the flag day is the pinned coordinated contract-era timestamp', function () {
        assert.strictEqual(GATE, 1790812800);
    });

    it('mainnet: inactive one second below the flag day, active at it', function () {
        assert.strictEqual(changes.isNativeFeePriceTimeGateActive('mainnet', GATE - 1), false);
        assert.strictEqual(changes.isNativeFeePriceTimeGateActive('mainnet', GATE), true);
    });

    it('testnet/regtest: active from genesis', function () {
        assert.strictEqual(changes.isNativeFeePriceTimeGateActive('regtest', 1), true);
        assert.strictEqual(changes.isNativeFeePriceTimeGateActive('testnet', 1), true);
    });

    it('unknown/empty network is treated like mainnet (conservative)', function () {
        assert.strictEqual(changes.isNativeFeePriceTimeGateActive(undefined, GATE - 1), false);
        assert.strictEqual(changes.isNativeFeePriceTimeGateActive(undefined, GATE), true);
    });
});

describe('Database.getLatestPrice() time-gated selection (H-3) @regression @tier1', function () {

    it('selectByTime pins the round by block_timestamp <= blockTime, not reference_block', async function () {
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQueryStrict').resolves([
            { price: '1.5', round_number: 7, block_timestamp: 1000 }
        ]);
        const got = await db.getLatestPrice('LTC/USD', 2700000, { blockTime: 1234, selectByTime: true });
        const [query, args] = stub.firstCall.args;
        assert.ok(/block_timestamp\s*<=\s*\?/.test(query), 'query must gate on block_timestamp: ' + query);
        assert.ok(!/reference_block/.test(query), 'query must not gate on reference_block: ' + query);
        assert.deepStrictEqual(args, ['LTC/USD', 1234], 'the gate arg must be the block time, not the height');
        assert.strictEqual(got.roundNumber, 7);
    });

    it('without selectByTime the height-gated selection is byte-identical to before', async function () {
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQueryStrict').resolves([]);
        await db.getLatestPrice('BTC/USD', 900000, { blockTime: 1234 });
        const [query, args] = stub.firstCall.args;
        assert.ok(/reference_block\s*<=\s*\?/.test(query), 'reference-chain path must still gate on reference_block');
        assert.deepStrictEqual(args, ['BTC/USD', 900000]);
    });

    it('M-17: a query error propagates instead of collapsing into "no price"', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQueryStrict').rejects(new Error('ER_LOCK_WAIT_TIMEOUT'));
        await assert.rejects(() => db.getLatestPrice('LTC/USD', 1, { blockTime: 1, selectByTime: true }),
            /ER_LOCK_WAIT_TIMEOUT/);
    });

    it('M-17: doQueryStrict throws on a NON-transactional query error (where doQuery swallows)', async function () {
        const db = makeDb();
        const conn = {
            query:   sinon.stub().rejects(new Error('boom')),
            release: sinon.stub().resolves()
        };
        db.pool = { getConnection: sinon.stub().resolves(conn) };
        // Contrast pin: doQuery's historical swallow (returns []) is unchanged...
        const swallowed = await db.doQuery('SELECT 1', []);
        assert.deepStrictEqual(swallowed, []);
        // ...while the strict path surfaces the same fault, releasing the connection.
        await assert.rejects(() => db.doQueryStrict('SELECT 1', []), /boom/);
        assert.ok(conn.release.called, 'strict path must still release the pooled connection');
    });
});

describe('Utility.getFeeOraclePrices() gate threading (H-3) @regression @tier1', function () {

    function priceDbCapture() {
        const calls = [];
        return {
            calls,
            getLatestPrice: async (pair, blockIndex, opts) => {
                calls.push({ pair, blockIndex, opts });
                return { price: '2', roundNumber: 3, timestamp: 100 };
            }
        };
    }

    it('non-reference chain + gate active: selects by time', async function () {
        const util = new Utility({ NETWORK: 'regtest' });
        const priceDb = priceDbCapture();
        const res = await util.getFeeOraclePrices({ indexer: { hubDb: priceDb } }, 'LTC', 2700000, 1000, 1800);
        assert.ok(!res.error, res.error);
        assert.strictEqual(priceDb.calls.length, 2, 'COIN/USD and XCHAIN/USD');
        for (const c of priceDb.calls)
            assert.strictEqual(c.opts.selectByTime, true, c.pair + ' must select by time');
    });

    it('reference chain (BTC) keeps height selection even with the gate active', async function () {
        const util = new Utility({ NETWORK: 'regtest' });
        const priceDb = priceDbCapture();
        await util.getFeeOraclePrices({ indexer: { hubDb: priceDb } }, 'BTC', 900000, 1000, 1800);
        for (const c of priceDb.calls)
            assert.strictEqual(c.opts.selectByTime, false, c.pair + ' must stay height-gated on BTC');
    });

    it('mainnet below the flag day: selection unchanged (pre-activation behavior preserved)', async function () {
        const util = new Utility({ NETWORK: 'mainnet' });
        const priceDb = priceDbCapture();
        await util.getFeeOraclePrices({ indexer: { hubDb: priceDb } }, 'LTC', 2700000, GATE - 1, 1800);
        for (const c of priceDb.calls)
            assert.strictEqual(c.opts.selectByTime, false, c.pair + ' must stay pre-activation below the flag day');
    });

    it('mainnet at the flag day: non-reference chains flip to time selection', async function () {
        const util = new Utility({ NETWORK: 'mainnet' });
        const priceDb = priceDbCapture();
        await util.getFeeOraclePrices({ indexer: { hubDb: priceDb } }, 'DOGE', 6280000, GATE, 1800);
        for (const c of priceDb.calls)
            assert.strictEqual(c.opts.selectByTime, true, c.pair + ' must be time-gated at the flag day');
    });
});
