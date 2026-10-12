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
 * TBTC action 376 fixture: BTC testnet block 155120 reads the price while rounds 5435 to 5448
 * sit in the hub table. The landing barrier holds the block until landed.DOGE passes its time,
 * and the live read then equals the replay read: round 5447.
 */

'use strict';

const assert = require('assert');
const sinon  = require('sinon');

const HubDbSync         = require('../../../../../src/hub/hub_db_sync.js');
const Database          = require('../../../../../src/db');
const Utility           = require('../../../../../src/utility');
const { getTestConfig } = require('../../../../fixtures/config');
const { stubActiveAt }  = require('../../../../helpers/gate_modules.js');

const LANDED_ROW   = 'price_fee_batch_landed_activation.PRICE_FEE_BATCH_LANDED_ACTIVATION';
const BLOCK_HEIGHT = 155120;
const T            = 1791200000;
const FIRST_ROUND  = 5435;
const LAST_ROUND   = 5448;
const EXPECTED     = 5447;
const STAMP        = T - 100;

function landed(dogeTime) {
    return { DOGE: { block: 67970000, protocol_time: dogeTime } };
}

function makeSync() {
    const sync = new HubDbSync({ doQuery: async () => [] }, { enabled: true, network: 'testnet', coin: 'TBTC' });
    sync.enabled = true;
    return sync;
}

// Rounds finalized 600 s apart. Round 5448 finalizes after T, so no read at T may return it.
function rounds(stamp) {
    const out = [];
    for (let n = FIRST_ROUND; n <= LAST_ROUND; n++) {
        out.push({ coin_pair: 'BTC/USD', price: String(60000 + n), round_number: n,
                   block_timestamp: T - 600 * (EXPECTED - n) - 1, reference_block: 150000 + n,
                   batch_block_time: stamp ? (n === LAST_ROUND ? T + 500 : STAMP) : 0, status: 'finalized' });
    }
    return out;
}

function makeDb(rows) {
    const config = getTestConfig();
    config['NETWORK'] = 'testnet';
    config['COIN'] = 'TBTC';
    const util = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_tbtc_testnet', 'u', 'p', { config, util });
    sinon.stub(db, 'doQueryStrict').callsFake(async (query, args) => {
        const bound = /batch_block_time > 0 AND batch_block_time <= \?/.test(query);
        const bt = bound ? Number(args[args.length - 1]) : null;
        return rows.filter(r => r.status === 'finalized' &&
                                (!bound || (r.batch_block_time > 0 && r.batch_block_time <= bt)))
                   .sort((a, b) => b.round_number - a.round_number).slice(0, 1);
    });
    return db;
}

describe('price landing barrier, TBTC action 376 fixture @regression @tier1', function () {

    beforeEach(function () {
        stubActiveAt(sinon, LANDED_ROW, true);
    });

    afterEach(function () {
        sinon.restore();
    });

    it('holds block 155120 until landed.DOGE passes its time, then live equals replay at round 5447', async function () {
        const opts = { blockTime: T, maxAgeSeconds: 3600, selectByTime: true };
        const sync = makeSync();
        sync.noteLanded(landed(T - 500));

        await assert.rejects(sync.waitForPriceLandingSync(BLOCK_HEIGHT, T, 20),
            /landing chain DOGE landed time 1791199500, needs 1791200001 \(short by 501s\)/);

        sync.noteLanded(landed(T + 1));
        await sync.waitForPriceLandingSync(BLOCK_HEIGHT, T, 20);
        const live = await makeDb(rounds(true)).getLatestPrice('BTC/USD', BLOCK_HEIGHT, opts);
        const replay = await makeDb(rounds(true)).getLatestPrice('BTC/USD', BLOCK_HEIGHT, opts);

        assert.strictEqual(live.roundNumber, EXPECTED);
        assert.strictEqual(live.price, String(60000 + EXPECTED));
        assert.deepStrictEqual(live, replay);
    });

    it('an unstamped live read answers differently, the split the barrier closes', async function () {
        const opts = { blockTime: T, maxAgeSeconds: 3600, selectByTime: true };
        const early = await makeDb(rounds(false)).getLatestPrice('BTC/USD', BLOCK_HEIGHT, opts);
        assert.strictEqual(early, null);
    });

    it('the fixture spans rounds 5435 to 5448', function () {
        const all = rounds(true);
        assert.strictEqual(all.length, 14);
        assert.strictEqual(all[0].round_number, FIRST_ROUND);
        assert.strictEqual(all[all.length - 1].round_number, LAST_ROUND);
    });
});
