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

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const addressMethods = require('../../../../../src/db/index_tables/addresses.js');
const dispenserWrites = require('../../../../../src/db/dispensers/writes.js');
const { createBaseData } = require('../../../../fixtures/mocks');
const {
    OWNER_ADDR, BLOCK_TIME, EXPIRATION, makeParams, useDispenserHarness,
} = require('./helpers/dispenser_harness.js');

let indexer, dispenser;
const bind = (h) => { ({ indexer, dispenser } = h); };

describe('Dispenser supplementary GET_ADDRESS @regression @tier1', function () {
    useDispenserHarness(bind);

    it('records the intended invalid verdict without issuing an utf8mb3 lookup', async function () {
        const supplementaryAddress = 'x\ud83d\ude00';
        const lookupDb = {
            util: indexer.util,
            _internCache: null,
            suppressIndexIdCreation: false,
            transactionConnection: null,
            deterministicIndexingStarted: false,
            normalizeDataValues: value => value,
            fitRefusedIntegerFields: value => value,
            getAddressId: addressMethods.getAddressId,
            createAddress: addressMethods.createAddress,
            createCoin: sinon.stub().resolves(1),
            createTicker: sinon.stub().resolves(2),
            createFiat: sinon.stub().resolves(null),
            createMemo: sinon.stub().resolves(null),
            createStatus: sinon.stub().resolves(3),
            doQuery: sinon.stub().callsFake(async (query, args) => {
                if(args && args.some(value => String(value).includes('\ud83d\ude00'))){
                    const error = new Error('Illegal mix of collations');
                    error.errno = 1267;
                    throw error;
                }
                return [];
            }),
        };
        indexer.indexerDb.createDispenser.callsFake(
            async data => dispenserWrites.createDispenser.call(lookupDb, data));
        const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${supplementaryAddress}||||${EXPIRATION}|||`);
        const data = createBaseData({
            ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC',
        });

        await dispenser.parse(params, data, false);

        assert.strictEqual(data['STATUS'], 'invalid: GET_ADDRESS (format)');
        sinon.assert.calledWithExactly(lookupDb.createStatus, 'invalid: GET_ADDRESS (format)');
        const insert = lookupDb.doQuery.getCalls().find(call =>
            call.args[0].startsWith('INSERT INTO dispensers'));
        assert.ok(insert, 'the invalid dispenser row was not recorded');
        assert.strictEqual(insert.args[1][8], null, 'GET_ADDRESS id must stay null');
        assert.strictEqual(lookupDb.doQuery.getCalls().some(call =>
            call.args[0].includes('index_addresses')), false);
    });
});
