/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/
process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';
const sinon = require("sinon");
const { createMockIndexer, createBaseData, createTokenInfo } = require("../../fixtures/mocks");
const { stubGate } = require("../../helpers/gate_modules.js");
const Swap_Match = require("../../../src/actions/swap_match/index.js");
const KEY = 'empty_allow_list_denies_activation.EMPTY_ALLOW_LIST_DENIES';
let indexer, handler;
// ALLOW_LIST / BLOCK_LIST 0 is what the real getSwapInfo returns for a NULL column.
const swapInfo = () => ({ ACTION_INDEX: 10, SOURCE: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH', SWAP_STATUS: 'open',
    GIVE_COIN: 'BTC', GIVE_TICK: 'GIVE', GIVE_AMOUNT: '10', GET_COIN: 'BTC', GET_TICK: 'GET', GET_AMOUNT: '5',
    GET_ADDRESS: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH', ALLOW_LIST: 0, BLOCK_LIST: 0 });
const matchInfo = () => ({ ACTION_INDEX: 20, SOURCE: 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
    GIVE_COIN: 'BTC', GIVE_TICK: 'GET', GIVE_AMOUNT: '5', GET_COIN: 'BTC', GET_TICK: 'GIVE', GET_AMOUNT: '10',
    GET_ADDRESS: 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM', ALLOW_LIST: 0, BLOCK_LIST: 0 });
describe('unlisted swaps vs EMPTY_ALLOW_LIST_DENIES', function () {
    beforeEach(function () {
        indexer = createMockIndexer();
        handler = new Swap_Match({ config: indexer.config, util: indexer.util, mapper: indexer.mapper,
            decoderDb: indexer.decoderDb, indexerDb: indexer.indexerDb,
            protocolChanges: { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) },
            processAction: sinon.stub().resolves() });
        indexer.util.resetLists();
        const g = createTokenInfo({ TICK: 'GIVE', TICK_ID: 1, DECIMALS: 0, ALLOW_LIST: null, BLOCK_LIST: null });
        const t = createTokenInfo({ TICK: 'GET', TICK_ID: 2, DECIMALS: 0, ALLOW_LIST: null, BLOCK_LIST: null });
        indexer.indexerDb.getTokenInfo.callsFake(async (tick) => tick === 'GIVE' ? g : tick === 'GET' ? t : null);
        indexer.indexerDb.getList.resolves([]);
    });
    afterEach(() => sinon.restore());
    for (const gate of [false, true]) it('unlisted swap pair matches, gate ' + gate, async function () {
        stubGate(sinon, KEY, gate);
        indexer.indexerDb.getSwapInfo.resolves(swapInfo());
        indexer.indexerDb.findSwapMatches.resolves([matchInfo()]);
        await handler.parse(null, createBaseData({ ACTION: 'SWAP_MATCH', ACTION_INDEX: 10, BLOCK_INDEX: 200 }), null);
        sinon.assert.calledOnce(indexer.indexerDb.createSwapMatch);
    });
});
