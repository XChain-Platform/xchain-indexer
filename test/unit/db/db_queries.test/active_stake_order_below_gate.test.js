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
 * test/unit/db/db_queries.test/active_stake_order_below_gate.test.js
 *
 * Validator-set ordering before network activation: both reads retain the
 * historical bare-pubkey order on every network below its activation height.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { makeDb } = require('./helpers/db_stub');

afterEach(function () {
    sinon.restore();
});

const cases = [
    ['mainnet', 500],
    ['testnet', 500],
    ['regtest', undefined]
];

function assertBarePubkeyOrder(call, limit) {
    const tail = call.sql.slice(call.sql.lastIndexOf(') eff'));
    assert.match(tail, /^\) eff\s+GROUP BY pubkey\s+ORDER BY pubkey\s+LIMIT \?$/);
    assert.strictEqual(call.args[call.args.length - 1], limit);
}

describe('Database validator-set ordering below activation @regression @tier1', function () {
    for(const [network, blockIndex] of cases){
        it('getActiveValidators orders by bare pubkey on ' + network, async function () {
            const db = makeDb();
            db.config.NETWORK = network;

            const calls = [];
            db.getStatusId = async function () { return 1; };
            db.doQuery = async function (sql, args) {
                calls.push({ sql, args });
                return [];
            };

            await db.getActiveValidators(blockIndex);

            assert.strictEqual(calls.length, 1);
            assertBarePubkeyOrder(calls[0], db.config.VALIDATOR_QUERY_LIMIT);
        });

        it('getValidatorsByCapability orders by bare pubkey on ' + network, async function () {
            const db = makeDb();
            db.config.NETWORK = network;
            const capability = Object.keys(db.config.STAKING.CAPABILITIES)[0];
            assert.ok(capability);

            const calls = [];
            db.getStatusId = async function () { return 1; };
            db.doQuery = async function (sql, args) {
                calls.push({ sql, args });
                return [];
            };

            await db.getValidatorsByCapability(capability, blockIndex);

            assert.strictEqual(calls.length, 1);
            assertBarePubkeyOrder(calls[0], db.config.VALIDATOR_QUERY_LIMIT);
        });
    }
});
