// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
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
const { createMockIndexer } = require('../../fixtures/mocks');

const Rollback = require('../../../src/rollback.js');

// Regression for the reorg entity-collect race: rollback() reads the addresses/tickers
// lists that collectAffectedEntities fills, and those same lists are shared, in-place,
// with the fee-quote dry-run path (Actions.processAction -> util.resetLists). If a
// microtask-only gap separates the last row absorbed by collectAffectedEntities from the
// point where rollback() reads the lists back out, a dry-run that lands in that gap can
// wipe the fill before it is read. The fix keeps the read inside collectAffectedEntities'
// own synchronous tail (no await between the last absorb and the read), so nothing queued
// after the absorb can land before the read, however that microtask is timed.
//
// This test does not wait on a real timer or a real dry-run. It attaches the wipe
// directly to the SAME query promise collectAffectedEntities awaits, registered only
// after production code has already subscribed to it, so the wipe's continuation is
// queued to run one microtask after the absorb - exactly the gap under test - on every
// run, deterministically.

// The two reads readRollbackScope issues before collectAffectedEntities runs: resolve at
// once, with a range that makes firstActionIndex non-null so the collect loop runs.
function scopeQueryResult(callIndex) {
    if (callIndex === 1) return Promise.resolve([{ action_index: 500 }]);
    if (callIndex === 2) return Promise.resolve([{ last_action_index: 600 }]);
    return null;
}

// Builds collectAffectedEntities' one and only query (the 'credits' table, given
// dataTables is narrowed to it below). Returns a pending promise so the wipe can be
// attached to it before it settles, then schedules the attach-and-resolve one microtask
// later so production's own `await` has already subscribed by the time the wipe attaches
// (see the file comment above for why that ordering is what reproduces the gap).
function collectQueryPromise(util, collectedRow) {
    let resolveQuery;
    const queryPromise = new Promise((resolve) => { resolveQuery = resolve; });
    queueMicrotask(() => {
        queryPromise.then(() => { util.resetLists(); });
        resolveQuery([collectedRow]);
    });
    return queryPromise;
}

// The interleaved doQueryStrict stand-in: dispatches by call order to the scope reads,
// then to the one entity-collect read that carries the race.
function makeInterleavedDoQueryStrict(util, collectedRow) {
    let queryCallCount = 0;
    return function () {
        queryCallCount++;
        const scoped = scopeQueryResult(queryCallCount);
        if (scoped) return scoped;
        return collectQueryPromise(util, collectedRow);
    };
}

describe('Rollback collectAffectedEntities capture race @regression @tier3', function () {
    let indexer, rollback;

    beforeEach(function () {
        indexer = createMockIndexer();
        indexer.protocolChanges = {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        };
        rollback = new Rollback(indexer);
        indexer.util.resetLists();
        // Narrow the entity-collect loop to a single table, so the query this test
        // controls is unambiguously the LAST (and only) one collectAffectedEntities
        // issues, and the wipe lands right after the only absorb there is.
        rollback.dataTables = ['credits'];
    });

    it('reads the address/ticker lists it collected even when a same-tick concurrent reset lands right after the absorb', async function () {
        const collectedRow = {
            address: 'mzCollectedAddr1111111111111111111',
            tick: 'XCP',
            address2: null,
            address3: null,
            tick1_id: null,
            tick2_id: null,
            coin1_id: null,
            coin2_id: null,
        };
        indexer.indexerDb.doQueryStrict = makeInterleavedDoQueryStrict(indexer.util, collectedRow);

        const runTxnStub = sinon.stub(rollback, 'runRollbackTransaction')
            .resolves({ retractionGeneration: null, stagedRetractions: [] });
        sinon.stub(rollback, 'deliverStagedRetractions').resolves();
        sinon.stub(rollback, 'logRollbackSummary');

        await rollback.rollback(500);

        assert.ok(runTxnStub.calledOnce, 'runRollbackTransaction should run once');
        // runRollbackTransaction(block_index, scope, markets, addresses, tickers)
        const [, , , addressesArg, tickersArg] = runTxnStub.firstCall.args;

        assert.ok(
            Object.prototype.hasOwnProperty.call(addressesArg, collectedRow.address),
            'the collected address must survive the read even though a concurrent reset ' +
            'landed one microtask after the last absorb'
        );
        assert.ok(
            tickersArg.includes(collectedRow.tick),
            'the collected ticker must survive the read even though a concurrent reset ' +
            'landed one microtask after the last absorb'
        );
    });
});
