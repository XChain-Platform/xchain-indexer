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
 ********************************************************************/

'use strict';

// The read lookups behind getbetfeeds, getbets, getopencrosschainorders,
// getanchoraction and oraclefeequote compare caller text against utf8mb3 columns.
// MariaDB refuses a utf8mb4 parameter holding a character above U+FFFF there with
// errno 1267 (Illegal mix of collations), so each lookup must answer the empty or
// absent result an unknown ASCII value gets, without binding the value at all.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { makeDb } = require('./db_queries.test/helpers/db_stub');
const { buildBetsRpc } = require('../../../src/api/rpc/bets.js');
const { buildOrdersRpc } = require('../../../src/api/rpc/orders.js');
const { validateAnchorActionParams } = require('../../../src/actions/anchor/anchor_action_query');
const { buildAnchorRpc } = require('../../../src/api/rpc/anchor.js');
const { buildFeesRpc } = require('../../../src/api/rpc/fees.js');

const EMOJI = 'a😀';

// A doQuery that behaves like a utf8mb3 equality: no rows for representable text,
// errno 1267 for any bound string holding a supplementary-plane character.
function collationQuery(){
    return sinon.spy(async function(query, args){
        for(let a of (args || [])){
            if(typeof a === 'string' && /[\u{10000}-\u{10FFFF}]/u.test(a)){
                let err = new Error('Illegal mix of collations (utf8mb3_general_ci,IMPLICIT) and ' +
                                    '(utf8mb4_unicode_ci,COERCIBLE) for operation \'=\'');
                err.errno = 1267;
                throw err;
            }
        }
        return [];
    });
}

function strictDb(){
    const db = makeDb();
    db.doQuery       = collationQuery();
    db.doQueryStrict = collationQuery();
    return db;
}

afterEach(function () {
    sinon.restore();
});

function betListingSuite(){
    for(let key of ['status', 'source']){
        it('getBetFeedRows with a supplementary ' + key + ' answers [] like the ASCII control, without querying', async function () {
            const control = strictDb();
            assert.deepStrictEqual(await control.getBetFeedRows({ [key]: 'unknownaddr', limit: 10 }), []);
            sinon.assert.calledOnce(control.doQuery);

            const db = strictDb();
            assert.deepStrictEqual(await db.getBetFeedRows({ [key]: EMOJI, limit: 10 }), []);
            sinon.assert.notCalled(db.doQuery);
        });

        it('getBetRows with a supplementary ' + key + ' answers [] without querying', async function () {
            const db = strictDb();
            assert.deepStrictEqual(await db.getBetRows({ [key]: EMOJI, limit: 10 }), []);
            sinon.assert.notCalled(db.doQuery);
        });
    }

    it('still binds a supplementary tick, since index_tickers is utf8mb4', async function () {
        const db = makeDb();
        db.doQuery = sinon.stub().resolves([]);
        await db.getBetFeedRows({ tick: EMOJI, limit: 10 });
        sinon.assert.calledOnce(db.doQuery);
        assert.ok(db.doQuery.firstCall.args[1].includes(EMOJI));
    });

    it('getbetfeeds answers the empty page, not a lookup failure', async function () {
        const db = strictDb();
        db.getLatestBlockIndex = sinon.stub().resolves(5);
        const indexer = { config: db.config, indexerDb: { apiView: () => db } };
        const rpc = buildBetsRpc({ indexer });
        for(let key of ['status', 'source']){
            let res = await rpc.getbetfeeds({ [key]: EMOJI, limit: 10 });
            assert.strictEqual(res.error, undefined, key + ': ' + res.error);
            assert.strictEqual(res.count, 0);
            assert.deepStrictEqual(res.feeds, []);
            assert.strictEqual(res.next_cursor, null);
        }
    });
}

function offerBookSuite(){
    it('getOpenCrossChainOffers with a supplementary to_coin answers the empty book without querying', async function () {
        const control = strictDb();
        let ascii = await control.getOpenCrossChainOffers(10, null, 'BTC', null);
        const db = strictDb();
        let offers = await db.getOpenCrossChainOffers(10, null, EMOJI, null);
        sinon.assert.notCalled(db.doQuery);
        assert.deepStrictEqual(offers, ascii);
        assert.strictEqual(offers.truncated, ascii.truncated);
        assert.strictEqual(offers.next_cursor, ascii.next_cursor);
    });

    it('getopencrosschainorders answers an empty book, not a lookup failure', async function () {
        const db = strictDb();
        db.getLatestBlockIndex = sinon.stub().resolves(5);
        db.getPushGeneration   = sinon.stub().resolves(0);
        db.getBlockTime        = sinon.stub().resolves(1700000000);
        const indexer = { config: db.config, util: db.util, indexerDb: { apiView: () => db } };
        const rpc = buildOrdersRpc({ indexer });
        let res = await rpc.getopencrosschainorders({ to_coin: EMOJI, limit: 10 });
        assert.strictEqual(res.error, undefined, String(res.error));
        let book = res.offers || res.orders;
        assert.ok(Array.isArray(book), JSON.stringify(res));
        assert.strictEqual(book.length, 0);
    });
}

function anchorActionSuite(){
    it('flags a supplementary chain or network as unmatchable, and leaves ASCII keys untouched', function () {
        let ascii = validateAnchorActionParams({ chain: 'BTC', network: 'regtest', block_index: 1, checkpoint_seq: 1 });
        assert.strictEqual(ascii.ok, true);
        assert.strictEqual('unmatchable' in ascii, false);
        for(let key of ['chain', 'network']){
            let params = { chain: 'BTC', network: 'regtest', block_index: 1, checkpoint_seq: 1 };
            params[key] = EMOJI;
            let v = validateAnchorActionParams(params);
            assert.strictEqual(v.ok, true, key);
            assert.strictEqual(v.unmatchable, true, key);
        }
    });

    it('getanchoraction answers not anchored for a supplementary chain or network, like the ASCII control', async function () {
        for(let key of ['chain', 'network']){
            const control = strictDb();
            control.getLatestBlockIndex = sinon.stub().resolves(5);
            const ctlRpc = buildAnchorRpc({ indexer: { config: control.config, indexerDb: { apiView: () => control } } });
            let ascii = await ctlRpc.getanchoraction({ chain: 'BTC', network: 'regtest', block_index: 1, checkpoint_seq: 1 });

            const db = strictDb();
            db.getLatestBlockIndex = sinon.stub().resolves(5);
            const rpc = buildAnchorRpc({ indexer: { config: db.config, indexerDb: { apiView: () => db } } });
            let params = { chain: 'BTC', network: 'regtest', block_index: 1, checkpoint_seq: 1 };
            params[key] = EMOJI;
            let res = await rpc.getanchoraction(params);
            assert.strictEqual(res.error, undefined, key + ': ' + res.error);
            assert.strictEqual(res.exists, false, key);
            assert.strictEqual(res.checkpoint_anchored, false, key);
            assert.deepStrictEqual(res, ascii, key);
            sinon.assert.notCalled(db.doQuery);
        }
    });
}


function oracleFeeQuoteSuite(){
    const NO_PRICE = { valid: false, error: 'invalid: ORACLE_ADDRESS (no effective oracle price)' };

    // A quoter that binds the four keys the way the oracle_prices read does, so an
    // unguarded supplementary key reaches the collation failure.
    function feesRpc(db){
        const view = Object.create(db);
        view._blockTimeCache = new Map();
        const indexerDb = { apiView: () => view };
        const util = {
            quoteOracleFee: sinon.spy(async function(ts, d){
                let rows = await db.doQueryStrict('SELECT 1 FROM oracle_prices',
                    [d.ORACLE_ADDRESS, d.GIVE_COIN, d.GIVE_TICK, d.FIAT_CODE]);
                return rows.length ? { valid: true } : { valid: false, error: NO_PRICE.error };
            }),
        };
        db.getLatestBlockIndex = sinon.stub().resolves(5);
        db.getBlockTime        = sinon.stub().resolves(1700000000);
        return { rpc: buildFeesRpc({ indexer: { indexerDb, util, config: { COIN: 'BTC' } } }), util };
    }

    const BASE = { oracleAddress: 'unknownaddr', giveCoin: 'BTC', giveTick: 'XCP', fiatCode: 'USD', giveEscrow: '1' };

    it('the ASCII control answers no effective oracle price', async function () {
        const db = strictDb();
        const { rpc } = feesRpc(db);
        assert.deepStrictEqual(await rpc.oraclefeequote(BASE), NO_PRICE);
        sinon.assert.calledOnce(db.doQueryStrict);
    });

    for(let key of ['oracleAddress', 'giveCoin', 'giveTick', 'fiatCode']){
        it('a supplementary ' + key + ' answers the ASCII control shape without querying', async function () {
            const db = strictDb();
            const { rpc, util } = feesRpc(db);
            let res = await rpc.oraclefeequote(Object.assign({}, BASE, { [key]: EMOJI }));
            assert.deepStrictEqual(res, NO_PRICE, key + ': ' + JSON.stringify(res));
            sinon.assert.notCalled(db.doQueryStrict);
            sinon.assert.notCalled(util.quoteOracleFee);
        });
    }
}

describe('utf8mb3 read RPC lookups answer empty for supplementary text @regression @tier1', function () {
    describe('bet listings', betListingSuite);
    describe('cross-chain offer book', offerBookSuite);
    describe('anchor action', anchorActionSuite);
    describe('oracle fee quote', oracleFeeQuoteSuite);
});
