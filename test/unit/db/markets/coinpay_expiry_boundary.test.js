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
 * test/unit/db/markets/coinpay_expiry_boundary.test.js
 *
 * The COINPAY_EXPIRE boundary under settlement_bounds_activation. A COINPAY is refused once
 * block_time >= expiration. Armed (regtest, genesis) the end-of-block pass expires a pending
 * obligation in the block whose time equals its expiration, the same instant; unarmed (the
 * committed mainnet and testnet rows) it expires one block later, at block_time > expiration.
 * The due query runs for real on node:sqlite over the project's own DDL.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const sinon  = require('sinon');

const { getTestConfig }    = require('../../../fixtures/config');
const { mysqlDdlToSqlite } = require('../../../helpers/sqlAnchorDb.js');
const Utility              = require('../../../../src/utility');
const Database             = require('../../../../src/db');

const SQL_DIR    = path.join(__dirname, '..', '..', '..', '..', 'src', 'sql');
const EXPIRATION = 1700007200;

// A Database whose doQuery runs on an in-memory sqlite holding one pending obligation
// (ORDER_MATCH 50, expiring at EXPIRATION) and one already fulfilled (51, same expiration).
function makeDb(network) {
    const { DatabaseSync } = require('node:sqlite');
    const sql = new DatabaseSync(':memory:');
    for (const file of ['index_statuses.sql', 'coinpay_obligations.sql', 'coinpay_statuses.sql']) {
        const ddl = fs.readFileSync(path.join(SQL_DIR, file), 'utf8').split('\n').filter(l => !/^\s*CREATE\s+(UNIQUE\s+)?INDEX/i.test(l)).join('\n');
        sql.exec(mysqlDdlToSqlite(ddl));
    }
    for (const s of ['pending_coinpay', 'fulfilled'])
        sql.prepare('INSERT INTO index_statuses (status) VALUES (?)').run(s);
    const obligation = sql.prepare('INSERT INTO coinpay_obligations (action_index, payer_address_id, payee_address_id, coin_id, coin_amount, expiration, block_index) VALUES (?, 1, 2, 1, ?, ?, 10)');
    const status = sql.prepare('INSERT INTO coinpay_statuses (action_index, coinpay_action_index, status_id) VALUES (?, ?, ?)');
    obligation.run(50, '0.001', EXPIRATION);
    status.run(50, 50, 1);
    obligation.run(51, '0.001', EXPIRATION);
    status.run(51, 51, 1);
    status.run(52, 51, 2);

    const config = getTestConfig();
    if (network) config.NETWORK = network;
    const util = new Utility(config);
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    db.doQuery = async (q, args) => sql.prepare(q).all(...(args || [])).map(r => Object.assign({}, r));
    db.getExpiredItems = async () => [];
    return { db, util };
}

// The obligations processExpirations hands to COINPAY_EXPIRE at block 30, time `blockTime`.
async function expiredAt(network, blockTime) {
    const { db, util } = makeDb(network);
    const actions = { processAction: sinon.stub().resolves() };
    await util.processExpirations(actions, db, 30, blockTime);
    return actions.processAction.getCalls().filter(c => c.args[0] === 'COINPAY_EXPIRE').map(c => c.args[2]['ACTION_INDEX']);
}

describe('COINPAY_EXPIRE boundary: getExpiredCoinpayObligations', function () {
    afterEach(function () { sinon.restore(); });

    it('returns a pending obligation at its expiration only when asked to include it', async function () {
        const { db } = makeDb();
        assert.deepStrictEqual((await db.getExpiredCoinpayObligations(EXPIRATION, true)).map(o => o.action_index), [50]);
        assert.deepStrictEqual((await db.getExpiredCoinpayObligations(EXPIRATION, false)).map(o => o.action_index), []);
        assert.deepStrictEqual((await db.getExpiredCoinpayObligations(EXPIRATION)).map(o => o.action_index), []);
    });

    it('returns it past its expiration either way, and never a fulfilled one', async function () {
        const { db } = makeDb();
        for (const atExpiration of [true, false])
            assert.deepStrictEqual((await db.getExpiredCoinpayObligations(EXPIRATION + 1, atExpiration)).map(o => o.action_index), [50]);
        assert.deepStrictEqual((await db.getExpiredCoinpayObligations(EXPIRATION - 1, true)).map(o => o.action_index), []);
    });
});

describe('COINPAY_EXPIRE boundary: the end-of-block pass', function () {
    afterEach(function () { sinon.restore(); });

    it('armed (regtest) expires the obligation in the block whose time equals its expiration', async function () {
        assert.deepStrictEqual(await expiredAt('regtest', EXPIRATION - 1), []);
        assert.deepStrictEqual(await expiredAt('regtest', EXPIRATION), [50]);
    });

    it('unarmed (mainnet, testnet) expires it only once block_time passes its expiration', async function () {
        for (const network of ['mainnet', 'testnet']) {
            assert.deepStrictEqual(await expiredAt(network, EXPIRATION), [], network);
            assert.deepStrictEqual(await expiredAt(network, EXPIRATION + 1), [50], network);
        }
    });
});
