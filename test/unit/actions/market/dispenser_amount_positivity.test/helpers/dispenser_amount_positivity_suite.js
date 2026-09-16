// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Shared fixtures for dispenser_amount_positivity.test.js and its part in
// test/unit/actions/dispenser_amount_positivity.test/.

'use strict';

const sinon = require('sinon');
const { createMockIndexer, createTokenInfo } = require('../../../../../fixtures/mocks');
const Dispenser = require('../../../../../../src/actions/dispenser/index.js');
const Dispense  = require('../../../../../../src/actions/dispense/index.js');
// Any network name the registry row (dispenser_amount_positivity_activation, read by
// the create and dispense paths through activeAt) does not carry reads as OFF, which is
// how these tests reach the legacy behavior without editing a threshold.
const GATE_OFF_NETWORK = 'no-such-network';
const OWNER_ADDR = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const BUYER_ADDR = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';
const BLOCK_TIME = 1700000000;
const EXPIRATION = BLOCK_TIME + 86400 * 30;

function makeActionsCtx(indexer) {
    return {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: {
            isDefined:  sinon.stub().returns(true),
            isEnabled:  sinon.stub().resolves(true),
        },
        processAction: sinon.stub().resolves(),
    };
}

function makeDispenser(indexer) {
    return new Dispenser(makeActionsCtx(indexer));
}

function makeDispenserInfo(overrides = {}) {
    return {
        ACTION_INDEX: 10, SOURCE: OWNER_ADDR, GET_ADDRESS: OWNER_ADDR,
        GIVE_COIN: 'BTC', GIVE_TICK: 'JDOG', GIVE_AMOUNT: '1',
        GIVE_REMAINING: '10', GET_COIN: 'BTC', GET_TICK: null,
        GET_AMOUNT: '0.01', ALLOW_LIST: null, BLOCK_LIST: null,
        DISPENSER_STATUS: 'open', ...overrides,
    };
}

function freshDispenserCreateSuite() {
    const indexer = createMockIndexer();
    const dispenser = makeDispenser(indexer);
    indexer.indexerDb.getTokenInfo
        .withArgs('JDOG', sinon.match.any, sinon.match.any)
        .resolves(createTokenInfo({ TICK: 'JDOG', TICK_ID: 10, DECIMALS: 0, ALLOW_LIST: null, BLOCK_LIST: null }));
    for (const empty of ['', null, undefined])
        indexer.indexerDb.getTokenInfo.withArgs(empty, sinon.match.any, sinon.match.any).resolves(null);
    indexer.indexerDb.getAddressBalances.resolves({ 10: '1000' });
    indexer.indexerDb.isActionAllowed.resolves(true);
    indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
    indexer.indexerDb.getTickerId.resolves(99);
    return { indexer, dispenser };
}

function freshDispenseSuite() {
    const indexer = createMockIndexer();
    const dispense = new Dispense(makeActionsCtx(indexer));
    indexer.indexerDb.findMatchingDispensers.resolves([10]);
    indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo());
    indexer.indexerDb.getTokenInfo
        .withArgs('JDOG', sinon.match.any, sinon.match.any)
        .resolves(createTokenInfo({ TICK: 'JDOG', TICK_ID: 10, ALLOW_LIST: null, BLOCK_LIST: null }));
    for (const empty of [null, undefined])
        indexer.indexerDb.getTokenInfo.withArgs(empty, sinon.match.any, sinon.match.any).resolves(null);
    indexer.indexerDb.createActionIndex.resolves(200);
    return { indexer, dispense };
}

module.exports = {
    GATE_OFF_NETWORK, OWNER_ADDR, BUYER_ADDR, BLOCK_TIME, EXPIRATION,
    makeActionsCtx, makeDispenser, makeDispenserInfo, freshDispenserCreateSuite, freshDispenseSuite,
};
