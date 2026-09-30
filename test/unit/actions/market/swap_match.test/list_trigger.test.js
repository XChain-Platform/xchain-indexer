// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../../fixtures/mocks');
const { stubGate } = require('../../../../helpers/gate_modules.js');
const Swap_Match = require('../../../../../src/actions/swap_match/index.js');

const SWAP_EDIT_REMATCH_KEY = 'swap_edit_rematch_activation.SWAP_EDIT_REMATCH_ACTIVATION';
const LIST_ACTION_INDEX = 502;
const LIST_EDIT_ACTION_INDEX = 702;
const LIST_BLOCK_INDEX = 902;
const RESTING_ACTION_INDEX = 102;
const LIST_OWNER = 'mnListOwner2222222222222222222222222';
const RESTING_OWNER = 'mrRestingOwner2222222222222222222222';
const COUNTERPARTY = 'mpCounterparty222222222222222222222';

let indexer, handler;

function makeListData(source = LIST_OWNER) {
    return createBaseData({
        ACTION: 'LIST',
        FORMAT: 1,
        SOURCE: source,
        ACTION_INDEX: LIST_EDIT_ACTION_INDEX,
        BLOCK_INDEX: LIST_BLOCK_INDEX,
        STATUS: 'valid',
        EDIT: 1,
        LIST_ACTION_INDEX,
        ITEM: [COUNTERPARTY],
    });
}

function makeRestingSwap() {
    return {
        ACTION_INDEX: RESTING_ACTION_INDEX,
        SOURCE: RESTING_OWNER,
        SWAP_STATUS: 'open',
        GIVE_COIN: 'BTC',
        GIVE_TICK: 'GIVE',
        GIVE_AMOUNT: '10',
        GET_COIN: 'BTC',
        GET_TICK: 'GET',
        GET_AMOUNT: '5',
        GET_ADDRESS: RESTING_OWNER,
        ALLOW_LIST: LIST_ACTION_INDEX,
        BLOCK_LIST: null,
    };
}

function makeCounterparty() {
    return {
        ACTION_INDEX: 203,
        SOURCE: COUNTERPARTY,
        SWAP_STATUS: 'open',
        GIVE_COIN: 'BTC',
        GIVE_TICK: 'GET',
        GIVE_AMOUNT: '5',
        GET_COIN: 'BTC',
        GET_TICK: 'GIVE',
        GET_AMOUNT: '10',
        GET_ADDRESS: COUNTERPARTY,
        ALLOW_LIST: null,
        BLOCK_LIST: null,
    };
}

function setupMarket(listMembers) {
    stubGate(sinon, SWAP_EDIT_REMATCH_KEY, true);
    indexer = createMockIndexer();
    handler = new Swap_Match({
        config: indexer.config,
        util: indexer.util,
        mapper: indexer.mapper,
        decoderDb: indexer.decoderDb,
        indexerDb: indexer.indexerDb,
        protocolChanges: indexer.protocolChanges,
        processAction: sinon.stub().resolves(),
    });

    const restingSwap = makeRestingSwap();
    const counterparty = makeCounterparty();
    indexer.indexerDb.getSwapInfo.resolves(restingSwap);
    indexer.indexerDb.findSwapMatches.resolves([counterparty]);
    indexer.indexerDb.getList.resolves(listMembers);
    indexer.indexerDb.getTokenInfo.callsFake(async (tick) => createTokenInfo({
        TICK: tick,
        DECIMALS: 0,
        ALLOW_LIST: null,
        BLOCK_LIST: null,
    }));
    return { restingSwap, counterparty };
}

function assertListBlockContext() {
    const reads = indexer.indexerDb.getList.getCalls();
    assert.ok(reads.length > 0);
    assert.ok(reads.every((call) => call.args[1] === LIST_BLOCK_INDEX));
}

describe('Swap_Match LIST trigger @regression @tier2', function () {
    afterEach(function () { sinon.restore(); });

    it('matches the looked-up resting swap using the LIST block context', async function () {
        const { restingSwap, counterparty } = setupMarket([COUNTERPARTY]);
        const listData = makeListData();
        const trigger = { ...listData, SWAP_ACTION_INDEX: RESTING_ACTION_INDEX };

        await handler.parse(null, trigger, null);

        sinon.assert.calledOnceWithExactly(
            indexer.indexerDb.getSwapInfo, 'BTC', RESTING_ACTION_INDEX
        );
        sinon.assert.neverCalledWith(
            indexer.indexerDb.getSwapInfo, 'BTC', LIST_EDIT_ACTION_INDEX
        );
        sinon.assert.calledOnceWithExactly(indexer.indexerDb.findSwapMatches, restingSwap);
        assert.notStrictEqual(indexer.indexerDb.findSwapMatches.firstCall.args[0], trigger);
        assertListBlockContext();
        sinon.assert.calledOnce(indexer.indexerDb.createSwapMatch);
        assert.strictEqual(indexer.indexerDb.createSwapMatch.firstCall.args[2], counterparty);
    });

    it('does not book a counterparty absent from the resting swap allow list', async function () {
        setupMarket([]);
        const listData = makeListData();
        const trigger = { ...listData, SWAP_ACTION_INDEX: RESTING_ACTION_INDEX };

        await handler.parse(null, trigger, null);

        assertListBlockContext();
        sinon.assert.notCalled(indexer.indexerDb.createSwapMatch);
    });

    it('books the same counterparty for an edit-shaped trigger', async function () {
        const { restingSwap, counterparty } = setupMarket([COUNTERPARTY]);
        const listData = makeListData();
        const trigger = {
            ...listData,
            SOURCE: restingSwap.SOURCE,
            SWAP_ACTION_INDEX: RESTING_ACTION_INDEX,
        };

        await handler.parse(null, trigger, null);

        sinon.assert.calledOnceWithExactly(indexer.indexerDb.findSwapMatches, restingSwap);
        sinon.assert.calledOnce(indexer.indexerDb.createSwapMatch);
        assert.strictEqual(indexer.indexerDb.createSwapMatch.firstCall.args[2], counterparty);
    });
});
