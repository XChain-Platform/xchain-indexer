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

process.env.INDEXER_COIN = 'DOGE';
process.env.INDEXER_NETWORK = 'testnet';

const assert = require('assert');
const sinon = require('sinon');

const Database = require('../../../../src/db');
const HubDbSync = require('../../../../src/hub/hub_db_sync.js');
const Utility = require('../../../../src/utility');
const gateRegistry = require('../../../../src/consensus/gate_registry.js');
const { getTestConfig } = require('../../../fixtures/config');
const { stubActiveAt } = require('../../../helpers/gate_modules.js');

const LANDED_ROW = 'price_fee_batch_landed_activation.PRICE_FEE_BATCH_LANDED_ACTIVATION';
const STRICT_ROW = 'price_landed_strict_activation.PRICE_LANDED_STRICT_ACTIVATION';
const BLOCK_HEIGHT = 67970000;
const BLOCK_TIME = 1791144199;

function makeDb(coin){
    const config = getTestConfig();
    config['NETWORK'] = 'testnet';
    config['COIN'] = coin;
    const util = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_test', 'u', 'p', { config, util });
    db.lastQuery = null;
    sinon.stub(db, 'doQueryStrict').callsFake(async (query, args) => {
        db.lastQuery = { query, args };
        const strict = /batch_block_time > 0 AND batch_block_time < \?/.test(query);
        const inclusive = /batch_block_time > 0 AND batch_block_time <= \?/.test(query);
        if((strict && !(BLOCK_TIME < args[args.length - 1])) ||
           (inclusive && !(BLOCK_TIME <= args[args.length - 1]))) return [];
        return [{ price: '0.10', round_number: 7, block_timestamp: BLOCK_TIME - 60 }];
    });
    return db;
}

async function latest(db){
    return db.getLatestPrice(db.config['COIN'] + '/USD', BLOCK_HEIGHT,
        { blockTime: BLOCK_TIME, maxAgeSeconds: 3600, selectByTime: true });
}

function makeSync(){
    const sync = new HubDbSync({ doQuery: async () => [] },
        { enabled: true, network: 'testnet', coin: 'DOGE' });
    sync.enabled = true;
    return sync;
}

afterEach(function () {
    sinon.restore();
});

describe('strict same-chain price landings @regression @tier1', function () {
    beforeEach(function () {
        stubActiveAt(sinon, LANDED_ROW, true);
    });

    it('is unpinned on every declared network until the release cut', function () {
        const row = gateRegistry.get(STRICT_ROW);
        assert.ok(Object.values(row).every((height) => height === null));
        assert.strictEqual(gateRegistry.activeAt(STRICT_ROW, 'testnet', 'DOGE', BLOCK_HEIGHT, null), false);
    });

    it('excludes a DOGE round stamped at exactly T(B) when strict landing is armed', async function () {
        stubActiveAt(sinon, STRICT_ROW, true);
        const db = makeDb('DOGE');
        assert.strictEqual(await latest(db), null);
        assert.ok(/batch_block_time > 0 AND batch_block_time < \?/.test(db.lastQuery.query));
        assert.deepStrictEqual(db.lastQuery.args, ['DOGE/USD', BLOCK_TIME, BLOCK_TIME]);
    });

    it('keeps the inclusive query byte-for-byte when strict landing is unarmed', async function () {
        stubActiveAt(sinon, STRICT_ROW, false);
        const db = makeDb('DOGE');
        assert.strictEqual((await latest(db)).roundNumber, 7);
        assert.ok(/batch_block_time > 0 AND batch_block_time <= \?/.test(db.lastQuery.query));
        assert.ok(!/batch_block_time > 0 AND batch_block_time < \?/.test(db.lastQuery.query));
        assert.deepStrictEqual(db.lastQuery.args, ['DOGE/USD', BLOCK_TIME, BLOCK_TIME]);
    });

    it('leaves BTC inclusive even when the strict gate seam is forced active', async function () {
        stubActiveAt(sinon, STRICT_ROW, true);
        const db = makeDb('BTC');
        assert.strictEqual((await latest(db)).roundNumber, 7);
        assert.ok(/batch_block_time > 0 AND batch_block_time <= \?/.test(db.lastQuery.query));
    });

    it('waits for the preceding own landing block instead of own protocol time', function () {
        stubActiveAt(sinon, STRICT_ROW, true);
        const short = makeSync();
        short.noteLanded({ DOGE: { block: BLOCK_HEIGHT - 2, protocol_time: BLOCK_TIME + 1000 } });
        assert.strictEqual(short.landingSyncSatisfied(BLOCK_HEIGHT, BLOCK_TIME), false);
        assert.deepStrictEqual(short.landingShortfall(BLOCK_HEIGHT, BLOCK_TIME),
            { chain: 'DOGE', have: BLOCK_HEIGHT - 2, need: BLOCK_HEIGHT - 1, unit: 'block' });

        const ready = makeSync();
        ready.noteLanded({ DOGE: { block: BLOCK_HEIGHT - 1, protocol_time: 0 } });
        assert.strictEqual(ready.landingSyncSatisfied(BLOCK_HEIGHT, BLOCK_TIME), true);
    });

    it('advances the own landing block when protocol time is unchanged', function () {
        stubActiveAt(sinon, STRICT_ROW, true);
        const sync = makeSync();
        sync.noteLanded({ DOGE: { block: BLOCK_HEIGHT - 2, protocol_time: BLOCK_TIME } });
        assert.strictEqual(sync.noteLanded(
            { DOGE: { block: BLOCK_HEIGHT - 1, protocol_time: BLOCK_TIME } }), true);
        assert.strictEqual(sync.landingSyncSatisfied(BLOCK_HEIGHT, BLOCK_TIME), true);
    });
});
