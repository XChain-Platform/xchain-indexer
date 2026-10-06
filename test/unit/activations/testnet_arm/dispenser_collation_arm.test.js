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
 * test/unit/activations/testnet_arm/dispenser_collation_arm.test.js
 *
 * Pins every armed testnet slot of the dispenser send-amount compare and the
 * stake-weight collation gates, and drives the real query builders
 * (findDispenserSends, stakeWeightsWithCap) one block below and at each height.
 * Below the height the emitted SQL is the legacy text; at the height it
 * diverges from it.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../../../fixtures/config');
const Utility           = require('../../../../src/utility');
const Database          = require('../../../../src/db');
const dsc               = require('../../../../src/db/dispensers/dispenser_send_amount_compare_gate.js');
const swc               = require('../../../../src/consensus/gates/stake_weight_collation_gate');

const ARMED = {
    'BTC:testnet':  155001,
    'LTC:testnet':  4906040,
    'DOGE:testnet': 67962387,
};

const LEGACY_PREDICATE = 's1.amount >= d1.get_amount AND';

function dbFor(network, coin) {
    const config   = getTestConfig();
    config.NETWORK = network;
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
    const db = dbFor('testnet', coin);
    await db.findDispenserSends(1, height);
    const hit = db._calls.find(c => /FROM\s+sends s1/.test(c.query));
    assert.ok(hit, 'findDispenserSends emitted no sends query');
    sinon.restore();
    return hit.query;
}

async function stakeQuery(coin, height) {
    const db = dbFor('testnet', coin);
    await db.stakeWeightsWithCap(1, height, '0', 'test');
    const q = db._calls.map(c => c.query).join('\n');
    assert.ok(q.length > 0, 'stakeWeightsWithCap emitted no query');
    sinon.restore();
    return q;
}

afterEach(function () { sinon.restore(); });

describe('testnet arm: dispenser compare and stake-weight collation @regression @tier1', function () {
    it('pins all six testnet slots', function () {
        for (const [key, height] of Object.entries(ARMED)) {
            assert.strictEqual(dsc.DISPENSER_SEND_AMOUNT_COMPARE_ACTIVATION[key], height, 'dispenser ' + key);
            assert.strictEqual(swc.STAKE_WEIGHT_COLLATION_ACTIVATION[key], height, 'collation ' + key);
        }
    });

    for (const [key, height] of Object.entries(ARMED)) {
        const coin = key.split(':')[0];

        describe(key, function () {
            it('dispenser send compare keeps the legacy predicate one block below and diverges at the height', async function () {
                const below = await sendsQuery(coin, height - 1);
                const at    = await sendsQuery(coin, height);
                assert.ok(below.includes(LEGACY_PREDICATE), 'below the height must emit the legacy lexicographic compare');
                assert.doesNotMatch(below, /CAST\(/);
                assert.doesNotMatch(at, /s1\.amount >= d1\.get_amount/, 'legacy compare survived at the height');
                assert.match(at.replace(/\s+/g, ' '),
                    /CAST\(s1\.amount AS DECIMAL\(60,18\)\) >= CAST\(d1\.get_amount AS DECIMAL\(60,18\)\)/);
                assert.notStrictEqual(at, below);
            });

            it('stake-weight collation emits no COLLATE one block below and pins utf8_bin at the height', async function () {
                const below = await stakeQuery(coin, height - 1);
                const at    = await stakeQuery(coin, height);
                assert.doesNotMatch(below, /COLLATE/, 'below the height the ordering must be the legacy folding one');
                assert.match(at, /COLLATE utf8_bin/, 'at the height the ordering must be binary');
                assert.notStrictEqual(at, below);
                assert.strictEqual(at.split(' COLLATE utf8_bin').join(''), below,
                    'the gate may add COLLATE and nothing else');
            });

            it('both predicates flip exactly at the height', function () {
                assert.strictEqual(dsc.isDispenserSendAmountCompareActive(height - 1, 'testnet', coin), false);
                assert.strictEqual(dsc.isDispenserSendAmountCompareActive(height, 'testnet', coin), true);
                assert.strictEqual(swc.isStakeWeightBinCollationActive(height - 1, 'testnet', coin), false);
                assert.strictEqual(swc.isStakeWeightBinCollationActive(height, 'testnet', coin), true);
            });
        });
    }
});
