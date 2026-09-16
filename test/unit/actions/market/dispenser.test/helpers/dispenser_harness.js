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
// The mock harness the whole Dispenser suite runs on: a mock indexer, the
// actions context dispenser.js is constructed with, the default token,
// balance and preference stubs, and the addresses and times the tests share.
// The suite is dispenser.test.js plus the files in dispenser.test/; each file
// keeps its own indexer/actionsCtx/dispenser names and fills them through
// useDispenserHarness, so the test bodies read the same in every file.

const sinon  = require('sinon');
const { createMockIndexer, createTokenInfo } = require('../../../../../fixtures/mocks');

const Dispenser = require('../../../../../../src/actions/dispenser/index.js');

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

function makeParams(str) {
    return String(str).split('|');
}

const OWNER_ADDR = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const OTHER_ADDR = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';
const BLOCK_TIME  = 1700000000;
const EXPIRATION  = BLOCK_TIME + 86400 * 30; // 30 days later

// One fresh harness, built the way every Dispenser test starts.
function createDispenserHarness() {
    const indexer    = createMockIndexer();
    const actionsCtx = makeActionsCtx(indexer);
    const dispenser  = new Dispenser(actionsCtx);

    // Default GIVE token exists
    indexer.indexerDb.getTokenInfo
        .withArgs('JDOG', sinon.match.any, sinon.match.any)
        .resolves(createTokenInfo({ TICK: 'JDOG', TICK_ID: 10, DECIMALS: 0, ALLOW_LIST: null, BLOCK_LIST: null }));

    // Default GET token (coin-denominated; GET_TICK empty so getTokenInfo returns null, that is fine)
    indexer.indexerDb.getTokenInfo
        .withArgs('', sinon.match.any, sinon.match.any)
        .resolves(null);
    indexer.indexerDb.getTokenInfo
        .withArgs(null, sinon.match.any, sinon.match.any)
        .resolves(null);
    indexer.indexerDb.getTokenInfo
        .withArgs(undefined, sinon.match.any, sinon.match.any)
        .resolves(null);

    // Default: sufficient balance (TICK_ID 10 → 1000 tokens)
    indexer.indexerDb.getAddressBalances.resolves({ 10: '1000' });

    // Default: not sleeping, action allowed
    indexer.indexerDb.isActionAllowed.resolves(true);

    // Default preferences
    indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });

    // Fee tick id
    indexer.indexerDb.getTickerId.resolves(99);
    return { indexer, actionsCtx, dispenser };
}

// The suite's hooks, installed in the calling describe: a fresh harness before
// every test, handed to `bind`, and every sinon stub restored after it.
function useDispenserHarness(bind) {
    beforeEach(function () {
        bind(createDispenserHarness());
    });

    afterEach(function () {
        sinon.restore();
    });
}

module.exports = {
    OWNER_ADDR, OTHER_ADDR, BLOCK_TIME, EXPIRATION,
    makeParams, createDispenserHarness, useDispenserHarness,
};
