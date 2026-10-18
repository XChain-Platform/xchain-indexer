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
 * test/unit/db/db_queries.test/active_stake_collation.test.js
 *
 * Validator-set ordering across the active-stake collation flag day.
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

async function capture(reader, network, blockIndex) {
    const db = makeDb();
    db.config.NETWORK = network;
    db.config.COIN = 'BTC';
    db.config.VALIDATOR_QUERY_LIMIT = 37;
    db.config.STAKING = { CAPABILITIES: { attestation: { MIN_STAKE: '5' } } };

    sinon.stub(db, 'getStatusId').resolves(7);
    sinon.stub(db, 'effectiveCapabilitySetSql').returns({
        sql: 'SELECT ? AS pubkey, ? AS total',
        args: ['inner-bind', 9]
    });
    const query = sinon.stub(db, 'doQuery').resolves([]);

    if(reader === 'getActiveValidators')
        await db.getActiveValidators(blockIndex);
    else
        await db.getValidatorsByCapability('attestation', blockIndex);

    return {
        sql: query.firstCall.args[0],
        args: query.firstCall.args[1]
    };
}

function assertOrder(call, collate) {
    const suffix = collate ? ' COLLATE utf8_bin' : '';
    assert.match(call.sql, new RegExp('GROUP BY pubkey\\s+ORDER BY pubkey' + suffix + '\\s+LIMIT \\?$'));
    assert.deepStrictEqual(call.args, ['inner-bind', 9, 37]);
}

for(const reader of ['getActiveValidators', 'getValidatorsByCapability']){
    describe('Database.' + reader + '() active-stake collation @regression @tier1', function () {
        it('pins binary validator ordering on regtest at the activation height', async function () {
            assertOrder(await capture(reader, 'regtest', 0), true);
        });

        for(const network of ['testnet', 'mainnet']){
            it('keeps bare validator ordering on ' + network, async function () {
                assertOrder(await capture(reader, network, 500), false);
            });
        }

        it('keeps bare validator ordering when blockIndex is undefined', async function () {
            assertOrder(await capture(reader, 'regtest', undefined), false);
        });
    });
}
