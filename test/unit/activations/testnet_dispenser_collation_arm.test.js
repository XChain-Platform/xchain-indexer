/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * test/unit/activations/testnet_dispenser_collation_arm.test.js
 *
 * Pins the six testnet slots of the dispenser send-amount compare and
 * stake-weight collation gates, and drives the real query builders one block
 * below and at each armed height so the armed output is shown to differ from
 * the legacy output rather than only the gate flipping.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../../fixtures/config');
const Utility           = require('../../../src/utility');
const Database          = require('../../../src/db');
const dsc               = require('../../../src/db/dispensers/dispenser_send_amount_compare_gate.js');
const swc               = require('../../../src/consensus/gates/stake_weight_collation_gate');
const swqCap            = require('../../../src/consensus/gates/swq_source_cap_gate');

const ARMED = {
    'BTC:testnet':  155001,
    'LTC:testnet':  4906040,
    'DOGE:testnet': 67962387,
};

function dbFor(coin) {
    const config   = getTestConfig();
    config.NETWORK = 'testnet';
    config.COIN    = coin;
    const util     = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    const calls = [];
    sinon.stub(db, 'doQuery').callsFake((query, args) => { calls.push({ query, args }); return Promise.resolve([]); });
    db._calls = calls;
    return db;
}

async function sendsQuery(coin, height) {
    const db = dbFor(coin);
    await db.findDispenserSends(1, height);
    const hit = db._calls.find(c => /FROM\s+sends s1/.test(c.query));
    assert.ok(hit, 'findDispenserSends emitted no sends query');
    sinon.restore();
    return hit.query;
}

async function stakeQuery(coin, height) {
    const db = dbFor(coin);
    await db.stakeWeightsWithCap(1, height, '0', 'test');
    const q = db._calls.map(c => c.query).join('\n');
    sinon.restore();
    return q;
}

afterEach(function () { sinon.restore(); });

describe('testnet dispenser compare and stake collation arm @regression @tier1', function () {
    it('pins all six testnet slots', function () {
        for (const [key, height] of Object.entries(ARMED)) {
            assert.strictEqual(dsc.DISPENSER_SEND_AMOUNT_COMPARE_ACTIVATION[key], height, 'dispenser compare ' + key);
            assert.strictEqual(swc.STAKE_WEIGHT_COLLATION_ACTIVATION[key], height, 'stake collation ' + key);
        }
    });

    for (const [key, height] of Object.entries(ARMED)) {
        const coin = key.split(':')[0];

        it(coin + ':testnet dispenser compare is legacy one block below and numeric at ' + height, async function () {
            const below = await sendsQuery(coin, height - 1);
            const at    = await sendsQuery(coin, height);
            assert.match(below, /s1\.amount >= d1\.get_amount/);
            assert.doesNotMatch(below, /CAST\(/);
            assert.match(at.replace(/\s+/g, ' '),
                /CAST\(s1\.amount AS DECIMAL\(60,18\)\) >= CAST\(d1\.get_amount AS DECIMAL\(60,18\)\)/);
            assert.doesNotMatch(at, /s1\.amount >= d1\.get_amount/);
            assert.notStrictEqual(at, below, 'armed predicate must diverge from the legacy output');
        });

        it(coin + ':testnet stake collation is folding one block below and utf8_bin at ' + height, async function () {
            assert.ok(swqCap.SWQ_SOURCE_CAP_ACTIVATION[key] === undefined || swqCap.SWQ_SOURCE_CAP_ACTIVATION[key] < height,
                'the straddle assumes the source cap is already active at the collation height');
            const below = await stakeQuery(coin, height - 1);
            const at    = await stakeQuery(coin, height);
            assert.ok(below.length > 0 && at.length > 0, 'no stake query emitted');
            assert.doesNotMatch(below, /COLLATE/);
            assert.match(at.replace(/\s+/g, ' '), /ORDER BY b\.source COLLATE utf8_bin/);
            assert.notStrictEqual(at, below, 'armed collation must diverge from the legacy output');
            assert.strictEqual(at.split(' COLLATE utf8_bin').join(''), below,
                'collation is the only difference between the two heights');
        });
    }
});
