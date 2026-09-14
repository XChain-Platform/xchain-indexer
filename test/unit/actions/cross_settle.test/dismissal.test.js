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
// CROSS_SETTLE dismissal of a match whose local leg is provably absent: judged
// once before any signature work, retried while unreached, re-evaluated after a
// rollback. Part of the Cross_Settle suite; see ../cross_settle.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { makeMatch, signMatch, makeData, useCrossSettleHarness } = require('./helpers/cross_settle_harness.js');

// The harness under test. useCrossSettleHarness rebuilds it before every test and
// restores sinon after it; bind copies it into the names the tests read.
let indexer, handler;
const bind = (h) => { ({ indexer, handler } = h); };

let warn;

describe('Cross_Settle action handler @regression @tier1', function () {
    useCrossSettleHarness(bind);

    // A match the mirror keeps serving whose local leg is an indexed action that is not an
    // offer (a hub database that outlived a regtest re-genesis) can never settle here; it
    // is judged once, before any signature work, and skipped silently on later blocks.
    describe('dismissal of a provably absent local leg', function () {
        beforeEach(function () { warn = sinon.stub(console, 'warn'); });

        it('dismisses a swap leg whose action index is parsed but is not an offer, before any signature work, and writes nothing', async function () {
            indexer.indexerDb.getSwapInfo.resolves(null);
            indexer.indexerDb.isActionIndexParsed.resolves(true);
            const match = makeMatch();                       // unsigned: the quorum path must never run
            await handler.parse(null, makeData({ MATCH: match, BLOCK_INDEX: 200 }), null);
            assert.ok(warn.calledOnce && /dismissed until a reorg below block 200/.test(warn.firstCall.args[0]));
            assert.ok(indexer.indexerDb.getValidatorsByCapability.notCalled, 'no signature work');
            assert.ok(indexer.indexerDb.createActionIndex.notCalled, 'no action minted');
            assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled, 'no settlement row');
            // Later blocks: no re-read, no re-log.
            await handler.parse(null, makeData({ MATCH: match, BLOCK_INDEX: 201 }), null);
            await handler.parse(null, makeData({ MATCH: match, BLOCK_INDEX: 202 }), null);
            assert.ok(indexer.indexerDb.getSwapInfo.calledOnce, 'the leg is not re-read once dismissed');
            assert.ok(warn.calledOnce, 'the verdict is logged once');
        });

        it('keeps retrying a leg the replay has not reached (action index not yet parsed)', async function () {
            indexer.indexerDb.getSwapInfo.resolves(null);
            indexer.indexerDb.isActionIndexParsed.resolves(false);
            const { match, validators } = signMatch(makeMatch(), 1);
            indexer.indexerDb.getValidatorsByCapability.resolves(validators);
            await handler.parse(null, makeData({ MATCH: match, BLOCK_INDEX: 200 }), null);
            await handler.parse(null, makeData({ MATCH: match, BLOCK_INDEX: 201 }), null);
            assert.ok(indexer.indexerDb.getSwapInfo.calledTwice, 'an unreached leg is re-read on the next block');
            assert.ok(indexer.indexerDb.createActionIndex.notCalled);
            assert.ok(!warn.args.some(a => /dismissed/.test(a[0])), 'never dismissed');
        });
    });
});

describe('Cross_Settle action handler @regression @tier1', function () {
    useCrossSettleHarness(bind);

    describe('dismissal of a provably absent local leg', function () {
        beforeEach(function () { warn = sinon.stub(console, 'warn'); });

        it('re-evaluates a dismissed match once the chain is no longer above the judging block (rollback), and settles if the offer is then open', async function () {
            indexer.indexerDb.getSwapInfo.resolves(null);
            indexer.indexerDb.isActionIndexParsed.resolves(true);
            const { match, validators } = signMatch(makeMatch(), 1);
            indexer.indexerDb.getValidatorsByCapability.resolves(validators);
            await handler.parse(null, makeData({ MATCH: match, BLOCK_INDEX: 200 }), null);
            assert.ok(warn.calledOnce);
            // The block that judged it is re-parsed after a rollback and now holds the open offer.
            indexer.indexerDb.getSwapInfo.resolves({ SOURCE: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH', SWAP_STATUS: 'open' });
            const data = makeData({ MATCH: match, BLOCK_INDEX: 200 });
            await handler.parse(null, data, null);
            assert.ok(indexer.indexerDb.getSwapInfo.calledTwice, 're-read at the judging block');
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createActionIndex.calledOnce, 'settles once the offer exists');
        });

        it('dismisses an order leg through the order lookup', async function () {
            indexer.indexerDb.getOrderInfo.resolves(null);
            indexer.indexerDb.isActionIndexParsed.resolves(true);
            const match = makeMatch({ a_kind: 'order', b_kind: 'order' });
            await handler.parse(null, makeData({ MATCH: match, BLOCK_INDEX: 200 }), null);
            assert.ok(warn.calledOnce && /local order BTC:42 is an indexed action/.test(warn.firstCall.args[0]));
            assert.ok(indexer.indexerDb.getOrderInfo.calledOnce);
            assert.ok(indexer.indexerDb.getSwapInfo.notCalled);
            assert.ok(indexer.indexerDb.createActionIndex.notCalled);
        });
    });

    describe('dismissal of a provably absent local leg', function () {
        beforeEach(function () { warn = sinon.stub(console, 'warn'); });

        it('leaves a match that is not this chain\'s untouched and undismissed', async function () {
            indexer.indexerDb.isActionIndexParsed.resolves(true);
            const match = makeMatch({ a_chain: 'LTC', b_chain: 'DOGE' });
            await handler.parse(null, makeData({ MATCH: match, BLOCK_INDEX: 200 }), null);
            assert.ok(indexer.indexerDb.getSwapInfo.notCalled);
            assert.ok(warn.notCalled);
        });
    });
});
