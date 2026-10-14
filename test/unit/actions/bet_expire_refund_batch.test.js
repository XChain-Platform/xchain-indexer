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

const assert = require('assert');
const sinon  = require('sinon');
const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');
const { ALICE, BOB, feedInfo } = require('./bridge/bet.test/helpers/bet_fixtures.js');

const Bet_Expire = require('../../../src/actions/bet_expire.js');

// A BET_EXPIRE handler over the shared mock indexer with ledger writes captured.
function expireHandler() {
    const indexer = createMockIndexer();
    indexer.util.resetLists();
    const ledger  = sinon.stub(indexer.util, 'processTransactionLedgerChanges').resolves();
    const handler = new Bet_Expire({ config: indexer.config, util: indexer.util, mapper: indexer.mapper,
        decoderDb: indexer.decoderDb, indexerDb: indexer.indexerDb });
    return { indexer, ledger, handler };
}

describe('BET_EXPIRE refunds open bets through one batched terminal write @regression @tier2', function () {

    afterEach(() => sinon.restore());

    it('flips every open bet in one settleBetsBatch call and never per bet', async function () {
        const { indexer, ledger, handler } = expireHandler();
        indexer.indexerDb.getBetFeedInfo.resolves(feedInfo({ FEED_STATUS: 'closed' }));
        indexer.indexerDb.createActionIndex.resolves(88);
        indexer.indexerDb.getOpenBetsByFeed.resolves([
            { ACTION_INDEX: 10, OUTCOME: 0, AMOUNT: '1.5', SOURCE: ALICE },
            { ACTION_INDEX: 11, OUTCOME: 1, AMOUNT: '2',   SOURCE: BOB },
        ]);
        const data = createBaseData({ ACTION: 'BET_EXPIRE', ACTION_INDEX: 5, BLOCK_INDEX: 321 });

        await handler.parse([], data, null);

        sinon.assert.calledOnceWithExactly(indexer.indexerDb.settleBetsBatch, 88, [10, 11], 'refunded', 321);
        sinon.assert.notCalled(indexer.indexerDb.setBetSettled);
        sinon.assert.notCalled(indexer.indexerDb.createBetStatus);
        sinon.assert.calledOnceWithExactly(indexer.indexerDb.setBetFeedTerminal, 5, 'expired', 321);
        // Refund credits and escrow releases are unchanged by the batching
        const [, , credits, , escrows] = ledger.firstCall.args;
        assert.deepStrictEqual(credits, [['TEST', '1.5', ALICE], ['TEST', '2', BOB]]);
        assert.deepStrictEqual(escrows.map(e => [e[0], String(e[1]), e[2]]), [['TEST', '-1.5', ALICE], ['TEST', '-2', BOB]]);
    });

    it('still calls the batch writer with an empty list when the feed has no open bets', async function () {
        const { indexer, handler } = expireHandler();
        indexer.indexerDb.getBetFeedInfo.resolves(feedInfo());
        indexer.indexerDb.createActionIndex.resolves(89);
        const data = createBaseData({ ACTION: 'BET_EXPIRE', ACTION_INDEX: 5, BLOCK_INDEX: 322 });

        await handler.parse([], data, null);

        sinon.assert.calledOnceWithExactly(indexer.indexerDb.settleBetsBatch, 89, [], 'refunded', 322);
    });
});
