// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer } = require('../../../../fixtures/mocks');
const Swap_Match = require('../../../../../src/actions/swap_match/index.js');

const SWAP_ADDRESS = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const MATCH_ADDRESS = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';

function makeSwapInfo(){
    return {
        GIVE_COIN: 'BTC', GIVE_TICK: 'GIVE',
        GET_COIN: 'BTC', GET_TICK: 'GET',
        GET_ADDRESS: SWAP_ADDRESS,
        ALLOW_LIST: null, BLOCK_LIST: null,
    };
}

function makeMatchInfo(){
    return {
        GIVE_COIN: 'BTC', GIVE_TICK: 'GET',
        GET_COIN: 'BTC', GET_TICK: 'GIVE',
        GET_ADDRESS: MATCH_ADDRESS,
        ALLOW_LIST: null, BLOCK_LIST: null,
    };
}

function makeLists(overrides = {}){
    return {
        getTokenAllowList: [], getTokenBlockList: [],
        giveTokenAllowList: [], giveTokenBlockList: [],
        swapInfoAllowList: [], swapInfoBlockList: [],
        ...overrides,
    };
}

function makeHandler(network, lists){
    const indexer = createMockIndexer();
    indexer.config.NETWORK = network;
    const handler = new Swap_Match({
        config: indexer.config,
        util: indexer.util,
        mapper: indexer.mapper,
        decoderDb: indexer.decoderDb,
        indexerDb: indexer.indexerDb,
    });
    sinon.stub(handler, 'loadSwapLists').resolves(lists);
    return handler;
}

async function findMatch(handler){
    return handler.findSwapMatch(
        { BLOCK_INDEX: 200 },
        { BLOCK_INDEX: 200, ACTION_INDEX: 10 },
        makeSwapInfo(),
        [makeMatchInfo()]
    );
}

describe('Swap_Match payout token policies @regression @tier2', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('keeps the below-gate rule that checks the GET-token policy against both payouts', async function () {
        const handler = makeHandler('mainnet', makeLists({ getTokenAllowList: [SWAP_ADDRESS] }));

        assert.strictEqual(await findMatch(handler), false);
    });

    it('checks the active GET-token policy only against the swap payout', async function () {
        const handler = makeHandler('regtest', makeLists({ getTokenAllowList: [SWAP_ADDRESS] }));

        assert.deepStrictEqual(await findMatch(handler), makeMatchInfo());
    });

    it('checks the active GIVE-token policy only against the matching payout', async function () {
        const handler = makeHandler('regtest', makeLists({ giveTokenAllowList: [MATCH_ADDRESS] }));

        assert.deepStrictEqual(await findMatch(handler), makeMatchInfo());
    });
});
