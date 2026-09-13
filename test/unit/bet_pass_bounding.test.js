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
// Bounded BET latch+expire pass (spec
// sec 6; Utility.processBetPasses). The pass is a deliberate BOUNDED sibling
// of processExpirations, doubly capped: feed rows (latch AND expiry, or a
// zero-bet feed flood makes the credit budget alone unbounded) and refund
// credits (expiry, whole feeds, exact prefix of the ordered due list - STOP
// at the first non-fitting feed, never skip past it).

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createMockIndexer } = require('../fixtures/mocks');

describe('BET bounded latch+expire pass @regression @tier2', function () {

    let indexer, actions;

    beforeEach(function () {
        indexer = createMockIndexer();
        actions = { processAction: sinon.stub().resolves() };
    });

    it('latch step: latches every due feed, passing the MAX_BET_PASS_ROWS cap to the query', async function () {
        indexer.indexerDb.getBetFeedsDueLatch.resolves([{ action_index: 3 }, { action_index: 7 }]);
        await indexer.util.processBetPasses(actions, indexer.indexerDb, 500, 1700000000);
        assert.ok(indexer.indexerDb.getBetFeedsDueLatch.calledOnceWith(1700000000, indexer.util.config['MAX_BET_PASS_ROWS']));
        assert.ok(indexer.indexerDb.latchBetFeedClosed.calledTwice);
        assert.deepStrictEqual(indexer.indexerDb.latchBetFeedClosed.firstCall.args, [3, 500]);
        assert.deepStrictEqual(indexer.indexerDb.latchBetFeedClosed.secondCall.args, [7, 500]);
    });

    it('expiry step: whole feeds in order, STOPS at the first feed past the credit budget', async function () {
        // Budget 20000: feed 1 (15000) fits; feed 2 (6000) does not fit the
        // remaining 5000 -> STOP; feed 3 (1) is NOT processed even though it
        // would fit (exact-prefix determinism)
        indexer.indexerDb.getBetFeedsDueExpiry.resolves([
            { action_index: 1, open_bets: 15000 },
            { action_index: 2, open_bets: 6000 },
            { action_index: 3, open_bets: 1 },
        ]);
        await indexer.util.processBetPasses(actions, indexer.indexerDb, 500, 1700000000);
        assert.strictEqual(actions.processAction.callCount, 1);
        const [action, , data] = actions.processAction.firstCall.args;
        assert.strictEqual(action, 'BET_EXPIRE');
        assert.strictEqual(data['ACTION_INDEX'], 1);
        assert.strictEqual(data['BLOCK_INDEX'], 500);
        assert.strictEqual(data['BLOCK_TIME'], 1700000000);
    });

    it('a max-size feed always fits a full budget (no wedge), and zero-bet feeds are row-bounded', async function () {
        assert.ok(indexer.util.config['MAX_BET_PASS_CREDITS'] >= indexer.util.config['MAX_BETS_PER_FEED'],
            'MAX_BET_PASS_CREDITS must be >= MAX_BETS_PER_FEED or a full feed can never expire');
        // A flood of zero-bet feeds consumes no credits; the row cap is what
        // bounds it: the due query is limited to MAX_BET_PASS_ROWS rows
        const flood = Array.from({ length: 50 }, (_, i) => ({ action_index: i + 1, open_bets: 0 }));
        indexer.indexerDb.getBetFeedsDueExpiry.resolves(flood);
        await indexer.util.processBetPasses(actions, indexer.indexerDb, 501, 1700000000);
        assert.ok(indexer.indexerDb.getBetFeedsDueExpiry.calledOnceWith(1700000000, indexer.util.config['MAX_BET_PASS_ROWS']));
        assert.strictEqual(actions.processAction.callCount, 50); // all 50 rows (query-capped), none blocked by credits
    });

    it('latch runs before expiry, so a feed can latch and expire in the same pass', async function () {
        const calls = [];
        indexer.indexerDb.getBetFeedsDueLatch.callsFake(async () => { calls.push('latch-query'); return [{ action_index: 9 }]; });
        indexer.indexerDb.latchBetFeedClosed.callsFake(async () => { calls.push('latch-write'); });
        indexer.indexerDb.getBetFeedsDueExpiry.callsFake(async () => { calls.push('expiry-query'); return [{ action_index: 9, open_bets: 2 }]; });
        actions.processAction.callsFake(async () => { calls.push('expire'); });
        await indexer.util.processBetPasses(actions, indexer.indexerDb, 502, 1700000000);
        assert.deepStrictEqual(calls, ['latch-query', 'latch-write', 'expiry-query', 'expire']);
    });
});
