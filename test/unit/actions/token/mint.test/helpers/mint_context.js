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
// The constants, builders and per-test context the MINT suite shares
// (mint.test.js plus the files in mint.test/). makeMintContext builds a fresh
// mock indexer, actions context and handler over a mintable TEST token; each
// block calls it from its own beforeEach.

const sinon  = require('sinon');

const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../../../fixtures/mocks');

const Mint = require('../../../../../../src/actions/mint/index.js');

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
 * Build a data object for a MINT transaction.
 */
function makeData(overrides = {}) {
    return createBaseData(Object.assign({ ACTION: 'MINT', FORMAT: 0 }, overrides));
}

// Shared addresses
const SOURCE      = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const DESTINATION = 'mtr6NtB5KJRAxTX5AbuRtV7S4FF2PZJXUs';
const BLOCK       = 100;

/**
 * Build a minimal tokenInfo for a mintable token.
 */
function makeMintableToken(overrides = {}) {
    return createTokenInfo(Object.assign({
        TICK:             'TEST',
        TICK_ID:          1,
        DECIMALS:         0,
        MAX_SUPPLY:       '1000',
        MAX_MINT:         '100',
        SUPPLY:           '0',
        LOCK_MINT:        0,
        MINT_ADDRESS_MAX: null,
        MINT_START_BLOCK: null,
        MINT_STOP_BLOCK:  null,
        BLOCK_INDEX:      50,   // token was issued at block 50, below current BLOCK=100
    }, overrides));
}

// A fresh mock indexer, actions context and MINT handler, with a mintable TEST
// token issued below the current block and nothing minted so far.
function makeMintContext() {
    const indexer    = createMockIndexer();
    const actionsCtx = makeActionsCtx(indexer);
    const handler    = new Mint(actionsCtx);

    const token = makeMintableToken();
    indexer.indexerDb.getTokenInfo.resolves(token);
    indexer.indexerDb.isActionAllowed.resolves(true);
    indexer.indexerDb.getActionCreditDebitAmount.resolves('0'); // minted so far = 0
    indexer.indexerDb.validTickerBeforeTxIndex.resolves(true);
    return { indexer, actionsCtx, handler };
}

module.exports = { SOURCE, DESTINATION, BLOCK, makeData, makeMintableToken, makeMintContext };
