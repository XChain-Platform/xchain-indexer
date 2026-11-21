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

const HubDbSync = require('../../../../../src/hub/hub_db_sync.js');

// A mirror whose own rollback generation is 6, so a price_snapshots fence at 6 is refused.
// Its re-page marks are the real ones (markRepageOwed / repageOwedSeq / settleRepageOwed).
function makeRefusingSync() {
    const doQuery = sinon.stub().callsFake(async () => []);
    const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test', coin: 'BTC',
        getOwnRollbackGeneration: async () => 6 });
    sync._bootstrapDrained = true;
    return sync;
}

// A bootstrapTable stand-in that, like the real one, settles only the mark its drain
// opened under. Each drain waits until the test releases it.
function holdPriceDrains(sync) {
    const holds = [];
    sync.bootstrapTable = sinon.spy(async table => {
        const drain = { table, repageSeq: sync.repageOwedSeq(table), fullTable: true };
        await new Promise(resolve => holds.push(resolve));
        sync.settleRepageOwed(drain);
        return 9;
    });
    return holds;
}

const REFUSED = { table: 'price_snapshots', source_chain: 'BTC', from_action_index: 10, retraction_generation: 6 };
const RANGE = { from: 10, gen: 6 };
const turn = () => new Promise(resolve => setImmediate(resolve));

// Release every held drain, including drains started by earlier releases.
async function releaseAll(holds) {
    for (let i = 0; i < 20; i++) {
        while (holds.length > 0) holds.shift()();
        await turn();
    }
}

describe('HubDbSync refused own-chain price re-page @regression @tier1', function () {
    it('runs a trailing price drain for a refusal that lands mid-drain', async function () {
        const sync = makeRefusingSync();
        const holds = holdPriceDrains(sync);
        await sync.applyRetraction(REFUSED);
        await sync.applyRetraction(REFUSED);
        assert.strictEqual(sync.bootstrapTable.callCount, 1, 'one drain at a time');
        holds.shift()();
        await turn();
        assert.strictEqual(sync.bootstrapTable.callCount, 2, 'the mid-drain mark gets its own drain');
        await releaseAll(holds);
        assert.strictEqual(sync.repageOwedSeq('price_snapshots'), undefined, 'no price debt left owed');
        assert.strictEqual(sync._refusedPriceRetractionRepage, null);
    });

    it('never strands a refusal that lands as the last drain settles', async function () {
        for (let depth = 0; depth < 10; depth++) {
            const sync = makeRefusingSync();
            const holds = holdPriceDrains(sync);
            await sync.applyRetraction(REFUSED);
            holds.shift()();
            for (let i = 0; i < depth; i++) await Promise.resolve();
            sync.owePriceRepageAfterRefusedRetraction(REFUSED, RANGE);
            await releaseAll(holds);
            assert.strictEqual(sync.repageOwedSeq('price_snapshots'), undefined,
                'a refusal ' + depth + ' microtask(s) after the drain settled was left owed');
        }
    });

    it('leaves a failed price drain owed without looping when no newer mark arrived', async function () {
        const sync = makeRefusingSync();
        sync.bootstrapTable = sinon.stub().resolves(null);
        await sync.applyRetraction(REFUSED);
        await sync._refusedPriceRetractionRepage;
        assert.strictEqual(sync.bootstrapTable.callCount, 1);
        assert.notStrictEqual(sync.repageOwedSeq('price_snapshots'), undefined, 'the debt stays for the bootstrap pass');
    });

    it('leaves a mid-drain mark from another source to the bootstrap loop', async function () {
        const sync = makeRefusingSync();
        const holds = holdPriceDrains(sync);
        await sync.applyRetraction(REFUSED);
        sync.markRepageOwed(['price_snapshots']);
        await releaseAll(holds);
        assert.strictEqual(sync.bootstrapTable.callCount, 1, 'only refusal marks rerun the drain');
        assert.notStrictEqual(sync.repageOwedSeq('price_snapshots'), undefined);
    });
});

// Before certification the debt belongs to the bootstrap loop, which never certifies
// while price_snapshots is owed, so a refusal there only marks it.
describe('HubDbSync refused own-chain price re-page ownership @regression @tier1', function () {
    it('stops looping once the mirror is no longer certified', async function () {
        const sync = makeRefusingSync();
        const holds = holdPriceDrains(sync);
        await sync.applyRetraction(REFUSED);
        await sync.applyRetraction(REFUSED);
        sync._bootstrapDrained = false;
        await releaseAll(holds);
        assert.strictEqual(sync.bootstrapTable.callCount, 1, 'an uncertified mirror re-bootstraps on its own');
        assert.strictEqual(sync._refusedPriceRetractionRepage, null);
    });

    it('only marks the debt while a bootstrap pass is running', async function () {
        const sync = makeRefusingSync();
        sync._bootstrapping = true;
        sync.bootstrapTable = sinon.stub().resolves(9);
        await sync.applyRetraction(REFUSED);
        assert.ok(sync.bootstrapTable.notCalled, 'the running pass owns the drain');
        assert.notStrictEqual(sync.repageOwedSeq('price_snapshots'), undefined, 'the pass cannot certify past it');
    });

    it('only marks the debt before the mirror has certified', async function () {
        const sync = makeRefusingSync();
        sync._bootstrapDrained = false;
        sync.bootstrapTable = sinon.stub().resolves(9);
        await sync.applyRetraction(REFUSED);
        assert.ok(sync.bootstrapTable.notCalled, 'the bootstrap retry owns the drain');
        assert.notStrictEqual(sync.repageOwedSeq('price_snapshots'), undefined);
    });
});
