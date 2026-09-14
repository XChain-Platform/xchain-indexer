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
 * Shared fixtures of the DISPENSE unit suite: test/unit/actions/dispense.test.js
 * and the parts beside it in dispense.test/.
 *
 * The suite is one describe title spread over several files, so the handler
 * context, the canonical dispenser and the per-test setup live here once.
 * freshDispenseSuite() is the body of the suite's beforeEach: every block calls
 * it before each test and gets a new mock indexer, handler context and DISPENSE
 * handler back, with one open dispenser matching by default.
 */

'use strict';

const sinon  = require('sinon');
const { createMockIndexer, createTokenInfo } = require('../../../../fixtures/mocks');

const Dispense = require('../../../../../src/actions/dispense/index.js');

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

// Canonical dispenser fixture used across tests
function makeDispenserInfo(overrides = {}) {
    return {
        ACTION_INDEX:   10,
        SOURCE:         'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
        GET_ADDRESS:    'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
        GIVE_COIN:      'BTC',
        GIVE_TICK:      'JDOG',
        GIVE_AMOUNT:    '1',        // dispense 1 JDOG per GET_AMOUNT unit
        GIVE_REMAINING: '10',       // 10 JDOG left in escrow
        GET_COIN:       'BTC',
        GET_TICK:       null,
        GET_AMOUNT:     '0.01',     // 0.01 BTC triggers 1 GIVE_AMOUNT
        ALLOW_LIST:     null,
        BLOCK_LIST:     null,
        DISPENSER_STATUS: 'open',
        ...overrides,
    };
}

const OWNER_ADDR  = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const BUYER_ADDR  = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';
const BLOCK_TIME  = 1700000000;

// The body of the suite's beforeEach: a fresh mock indexer answering for the
// canonical dispenser and its tokens, a handler context and a DISPENSE handler.
function freshDispenseSuite() {
    let indexer, actionsCtx, dispense;
    indexer    = createMockIndexer();
    actionsCtx = makeActionsCtx(indexer);
    dispense   = new Dispense(actionsCtx);

    // Default: findMatchingDispensers returns one dispenser action_index
    indexer.indexerDb.findMatchingDispensers.resolves([10]);

    // Default: getDispenserInfo returns the canonical dispenser
    indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo());

    // Default: token info for GIVE and GET ticks
    indexer.indexerDb.getTokenInfo
        .withArgs('JDOG', sinon.match.any, sinon.match.any)
        .resolves(createTokenInfo({ TICK: 'JDOG', TICK_ID: 10, ALLOW_LIST: null, BLOCK_LIST: null }));
    indexer.indexerDb.getTokenInfo
        .withArgs(null, sinon.match.any, sinon.match.any)
        .resolves(null);
    indexer.indexerDb.getTokenInfo
        .withArgs(undefined, sinon.match.any, sinon.match.any)
        .resolves(null);

    // Default: createActionIndex returns a new index
    indexer.indexerDb.createActionIndex.resolves(200);
    return { indexer, actionsCtx, dispense };
}

module.exports = {
    makeActionsCtx, makeDispenserInfo, OWNER_ADDR, BUYER_ADDR, BLOCK_TIME, freshDispenseSuite,
};
