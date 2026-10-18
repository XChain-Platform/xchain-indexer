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
const sinon = require('sinon');
const {
    createMockIndexer,
    createBaseData,
    createTokenInfo,
} = require('../../../../fixtures/mocks');
const Dispenser = require('../../../../../src/actions/dispenser/index.js');

const OWNER_ADDR = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const ORACLE_ADDR = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';

function createScenario(network, blockTime, fiatPricing, oraclePrice) {
    const indexer = createMockIndexer();
    indexer.config.NETWORK = network;

    const isEnabled = sinon.stub().resolves(true);
    if (!fiatPricing) {
        isEnabled.withArgs('FIAT_DISPENSER_PRICING').resolves(false);
    }

    const dispenser = new Dispenser({
        config: indexer.config,
        util: indexer.util,
        mapper: indexer.mapper,
        decoderDb: indexer.decoderDb,
        indexerDb: indexer.indexerDb,
        protocolChanges: {
            isDefined: sinon.stub().returns(true),
            isEnabled,
        },
        processAction: sinon.stub().resolves(),
    });
    const db = indexer.indexerDb;

    db.getTokenInfo
        .withArgs('JDOG', sinon.match.any, sinon.match.any)
        .resolves(createTokenInfo({
            TICK: 'JDOG',
            TICK_ID: 10,
            DECIMALS: 0,
            ALLOW_LIST: null,
            BLOCK_LIST: null,
            OWNER: OWNER_ADDR,
        }));
    for (const emptyTick of ['', null, undefined]) {
        db.getTokenInfo
            .withArgs(emptyTick, sinon.match.any, sinon.match.any)
            .resolves(null);
    }
    db.getAddressBalances.resolves({ 10: '0', 99: '999999999' });
    db.isActionAllowed.resolves(true);
    db.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
    db.getTickerId.resolves(99);
    db.isOwnershipEscrowed.resolves(false);
    db.setTokenEscrow = sinon.stub().resolves();
    db.getPricesInTimeRange = sinon.stub().resolves([
        { price: '50000', timestamp: blockTime - 7200 },
    ]);
    db.getOraclePricesInTimeRange = sinon.stub().resolves([
        { price: '0.05', effectiveAt: blockTime - 3600 },
    ]);
    db.getOraclePrice = sinon.stub().resolves(oraclePrice);

    const params = [
        '0', 'BTC', 'JDOG', '', '1', '', 'BTC', '', '0.01', OWNER_ADDR,
        'USD', '', ORACLE_ADDR, String(blockTime + 2592000), '', '',
        'Ownership Mode B',
    ];
    const data = createBaseData({
        ACTION: 'DISPENSER',
        FORMAT: 0,
        SOURCE: OWNER_ADDR,
        BLOCK_TIME: blockTime,
        COIN: 'BTC',
    });

    return { dispenser, db, params, data };
}

async function parseScenario(network, blockTime, fiatPricing, oraclePrice) {
    const scenario = createScenario(network, blockTime, fiatPricing, oraclePrice);
    await scenario.dispenser.parse(scenario.params, scenario.data, false);
    return scenario;
}

describe('Dispenser effective oracle price on every network @regression @tier2', function () {
    afterEach(function () {
        sinon.restore();
    });

    for (const network of ['mainnet', 'testnet', 'regtest']) {
        for (const blockTime of [1700000000, 1900000000]) {
            it(`enforces the Mode B create rule on ${network} at ${blockTime}`, async function () {
                const unpriced = await parseScenario(network, blockTime, true, null);
                assert.strictEqual(
                    unpriced.data.STATUS,
                    'invalid: ORACLE_ADDRESS (no effective oracle price)'
                );
                sinon.assert.notCalled(unpriced.db.setTokenEscrow);
                sinon.assert.calledOnce(unpriced.db.getOraclePrice);

                const priced = await parseScenario(
                    network,
                    blockTime,
                    true,
                    { value: '0.05', fee: '0.01' }
                );
                assert.strictEqual(priced.data.STATUS, 'valid', priced.data.STATUS);
                sinon.assert.calledOnce(priced.db.setTokenEscrow);
                sinon.assert.called(priced.db.getOraclePrice);

                const pricingOff = await parseScenario(network, blockTime, false, null);
                assert.strictEqual(pricingOff.data.STATUS, 'valid', pricingOff.data.STATUS);
                sinon.assert.calledOnce(pricingOff.db.setTokenEscrow);
                sinon.assert.notCalled(pricingOff.db.getOraclePrice);
            });
        }
    }
});
