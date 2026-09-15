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
// The mock CALLBACK handler, the addresses and the token fixtures the CALLBACK
// suite shares (callback.test.js plus the files in callback.test/). Every
// block's beforeEach calls freshCallback; the per-behaviour stubs stay in the
// file that uses them.

const sinon = require('sinon');
const { createMockIndexer, createTokenInfo } = require('../../../../fixtures/mocks');

const Callback = require('../../../../../src/actions/callback/index.js');

const OWNER   = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const OTHER   = '1OtherAddressXXXXXXXXXXXXXXXXVtKwXp';
const HOLDER1 = 'mmqFL1hiu2RDuyS69KS9ko6uaMryhANwsz';
const HOLDER2 = 'mk7MdP3qzVkgyjaYNR2sUY8Ggn4DWxt2KS';

// The callback-bearing token: TEST pays CALLBACK_AMOUNT of CBTEST to its holders.
function makeTokenInfo(overrides = {}) {
    return createTokenInfo({
        TICK: 'TEST',
        TICK_ID: 1,
        OWNER,
        DECIMALS: 0,
        LOCK_CALLBACK: 0,
        CALLBACK_BLOCK: 90,
        CALLBACK_TICK: 'CBTEST',
        CALLBACK_AMOUNT: '1',
        ...overrides,
    });
}

// The token the callback pays out in.
function makeCallbackTokenInfo(overrides = {}) {
    return createTokenInfo({
        TICK: 'CBTEST',
        TICK_ID: 2,
        DECIMALS: 0,
        ALLOW_LIST: null,
        BLOCK_LIST: null,
        ...overrides,
    });
}

// A fresh mock indexer, action context and CALLBACK handler, rebuilt before
// every case.
function freshCallback() {
    const indexer = createMockIndexer();
    const actionsCtx = {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: {
            isDefined:  sinon.stub().returns(true),
            isEnabled:  sinon.stub().resolves(true),
        },
        processAction:   sinon.stub().resolves(),
    };
    const handler = new Callback(actionsCtx);
    indexer.util.resetLists();
    return { indexer, actionsCtx, handler };
}

module.exports = {
    OWNER, OTHER, HOLDER1, HOLDER2,
    makeTokenInfo, makeCallbackTokenInfo, freshCallback,
};
