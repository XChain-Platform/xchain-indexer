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
// The fixtures and mock harness the whole Send suite runs on. The suite is
// send.test.js plus the files in send.test/; each file keeps its own names
// for the indexer and handler, and the main handler describe fills them
// through useSendHarness, so the test bodies read exactly as they did when the
// suite was one file.

const sinon  = require('sinon');

const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../../fixtures/mocks');

const Send = require('../../../../../src/actions/send/index.js');

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

/**
 * Build data object for a SEND transaction.
 */
function makeData(overrides = {}) {
    return createBaseData(Object.assign({ ACTION: 'SEND', FORMAT: 0 }, overrides));
}

// Valid BTC addresses used across tests
const SOURCE      = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const DESTINATION = 'mtr6NtB5KJRAxTX5AbuRtV7S4FF2PZJXUs';
const DEST2       = 'n2j7X44Gm6P4E9cs2H13EkBAotYbjPZW17';

// A tokenInfo with TICK_ID = 1 so hasBalance checks work
function makeToken(overrides = {}) {
    return createTokenInfo(Object.assign({
        TICK:     'TEST',
        TICK_ID:  1,
        DECIMALS: 0,
    }, overrides));
}

// Balance map: { [TICK_ID]: amount }
function makeBalances(tickId, amount) {
    return { [tickId]: amount };
}

// The main handler suite's hooks, installed in the calling describe: a fresh
// mock indexer, actions context and handler before every test, with a known
// token, open addresses, a funded SOURCE and no matching dispensers, handed to
// `bind`; every sinon stub restored after it.
function useSendHarness(bind) {
    let indexer, actionsCtx, handler;

    beforeEach(function () {
        indexer    = createMockIndexer();
        actionsCtx = makeActionsCtx(indexer);
        handler    = new Send(actionsCtx);

        // Defaults
        const token = makeToken();
        indexer.indexerDb.getTokenInfo.resolves(token);
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        // Sufficient balance: 1000 of TICK_ID=1
        indexer.indexerDb.getAddressBalances.resolves(makeBalances(1, 1000));
        // Dispenser integration: no matching dispensers
        indexer.indexerDb.findMatchingDispensers.resolves([]);
        indexer.indexerDb.findDispenserSends.resolves([]);
        bind({ indexer, actionsCtx, handler });
    });

    afterEach(function () {
        sinon.restore();
    });
}

module.exports = {
    SOURCE, DESTINATION, DEST2, makeActionsCtx, makeData, makeToken, makeBalances, useSendHarness,
};
