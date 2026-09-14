'use strict';

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
// The constants, builders and per-test context the WITHDRAW suite shares
// (withdraw.test.js plus the files in withdraw.test/). makeWithdrawContext
// builds a fresh mock indexer, actions context and handler with the owned
// contract, token and balance defaults; each block calls it from its own
// beforeEach.

const sinon  = require('sinon');

const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../../fixtures/mocks');

const Withdraw = require('../../../../../src/actions/withdraw.js');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOURCE           = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const CONTRACT_INDEX   = '7';
const TICK             = 'TEST';
const BLOCK            = 100;
// Contract address as computed by the handler: 'C:BTC:<contract_action_index>'
const CONTRACT_ADDRESS = 'C:BTC:' + CONTRACT_INDEX;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeData(overrides = {}) {
    return createBaseData(Object.assign({ ACTION: 'WITHDRAW', FORMAT: 0, COIN: 'BTC', BLOCK_INDEX: BLOCK, SOURCE }, overrides));
}

function makeToken(overrides = {}) {
    return createTokenInfo(Object.assign({ TICK, TICK_ID: 1, DECIMALS: 0 }, overrides));
}

/** A fresh mock indexer, actions context and WITHDRAW handler, as every withdraw test starts from. */
function makeWithdrawContext() {
    const indexer    = createMockIndexer();
    const actionsCtx = makeActionsCtx(indexer);
    const handler    = new Withdraw(actionsCtx);

    // Extra stubs not present in default mock
    indexer.indexerDb.createWithdrawal = sinon.stub().resolves();
    indexer.indexerDb.getContract      = sinon.stub().resolves(null);

    // Default: contract exists and caller is owner (source_id matches)
    indexer.indexerDb.getContract.resolves({ source_id: 42 });
    indexer.indexerDb.getAddressId.resolves(42);

    // Default: token exists
    indexer.indexerDb.getTokenInfo.resolves(makeToken());

    // Default: contract has sufficient balance
    // getAddressBalances is called with the contract address
    indexer.indexerDb.getAddressBalances.resolves({ 1: '1000' });

    // Default: source not sleeping
    indexer.indexerDb.isActionAllowed.resolves(true);

    indexer.util.resetLists();
    return { indexer, actionsCtx, handler };
}

module.exports = {
    SOURCE, CONTRACT_INDEX, TICK, BLOCK, CONTRACT_ADDRESS,
    makeActionsCtx, makeData, makeToken, makeWithdrawContext,
};
