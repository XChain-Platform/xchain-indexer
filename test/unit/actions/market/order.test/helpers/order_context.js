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
// The addresses, block time and per-test context the ORDER suite shares
// (order.test.js plus the files in order.test/). makeOrderContext builds a
// fresh mock indexer, actions context and handler with both test tokens, a
// funded balance and permissive preferences; each block calls it from its own
// beforeEach.

const sinon  = require('sinon');
const { createMockIndexer, createTokenInfo } = require('../../../../../fixtures/mocks');

const Order = require('../../../../../../src/actions/order/index.js');

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// Build a pipe-delimited param string and split it the same way the indexer does
function makeParams(str) {
    return String(str).split('|');
}

// Default addresses used in tests
const OWNER_ADDR = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const OTHER_ADDR = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';

// Block time fixed; expiration must be strictly greater than this
const BLOCK_TIME  = 1700000000;
const EXPIRATION  = BLOCK_TIME + 86400 * 30; // 30 days later

// A fresh mock indexer, actions context and ORDER handler for one test.
function makeOrderContext() {
    const indexer    = createMockIndexer();
    const actionsCtx = makeActionsCtx(indexer);
    const order      = new Order(actionsCtx);

    // Default: both GIVE and GET tokens exist
    indexer.indexerDb.getTokenInfo
        .withArgs('RAREPEPE', sinon.match.any, sinon.match.any)
        .resolves(createTokenInfo({ TICK: 'RAREPEPE', TICK_ID: 10, DECIMALS: 0 }));
    indexer.indexerDb.getTokenInfo
        .withArgs('PEPECASH', sinon.match.any, sinon.match.any)
        .resolves(createTokenInfo({ TICK: 'PEPECASH', TICK_ID: 20, DECIMALS: 0 }));

    // Default: sufficient balance for GIVE_AMOUNT
    indexer.indexerDb.getAddressBalances.resolves({ 10: '100', 20: '999999' });

    // Default: address / tick not sleeping; action allowed
    indexer.indexerDb.isActionAllowed.resolves(true);

    // Preferences with FEE_PREFERENCE=0, REQUIRE_MEMO=0
    indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });

    // Fee tick id
    indexer.indexerDb.getTickerId.resolves(99);
    return { indexer, actionsCtx, order };
}

module.exports = { OWNER_ADDR, OTHER_ADDR, BLOCK_TIME, EXPIRATION, makeParams, makeOrderContext };
