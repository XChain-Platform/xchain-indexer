// Copyright © 2025–2026 Dankest, LLC
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
const { createMockIndexer } = require('../../fixtures/mocks');

const dispatchMethods = require('../../../src/actions/actions_class/dispatch.js');
const Rollback = require('../../../src/rollback/index.js');

function entityRow(address, tick) {
    return {
        address,
        tick,
        address2: null,
        address3: null,
        tick1_id: null,
        tick2_id: null,
        coin1_id: null,
        coin2_id: null,
    };
}

// Exercise the same processAction entry used by a fee-quote dry run. The small context
// keeps only the dispatcher dependencies needed for an UNKNOWN action: processAction itself
// performs the production resetLists call, then this handler represents the quoted action
// adding its own entity to the shared utility lists.
async function dispatchFeeQuoteAction(sharedUtil, row) {
    const ctx = {
        util: sharedUtil,
        _actionCounters: {},
        assignActionAddressIds: async () => {},
        actionUnknown: {
            parse: async () => sharedUtil.addAddressTicker(row.address, row.tick),
        },
    };
    await dispatchMethods.processAction.call(ctx, 'UNKNOWN', [], { STATUS: 'valid' }, false);
}

describe('Rollback fee-quote dry-run entity-list interleave @regression @tier3', function () {
    it('materializes private address and ticker lists on the rollback utility view', function () {
        const indexer = createMockIndexer();
        const rollback = new Rollback(indexer);

        // Object.create plus resetLists must materialize both mutable lists on the rollback
        // view. Inheriting either list from indexer.util would leave it exposed to the reset.
        assert.strictEqual(Object.getPrototypeOf(rollback.util), indexer.util);
        assert.ok(Object.prototype.hasOwnProperty.call(rollback.util, 'addresses'));
        assert.ok(Object.prototype.hasOwnProperty.call(rollback.util, 'tickers'));
        assert.notStrictEqual(rollback.util.getAddressesList(), indexer.util.getAddressesList());
        assert.notStrictEqual(rollback.util.getTickersList(), indexer.util.getTickersList());
    });

    it('keeps rollback entities across a processAction reset between table reads', async function () {
        const indexer = createMockIndexer();
        const rollback = new Rollback(indexer);
        const first = entityRow('rollback-address-first', 'FIRST');
        const second = entityRow('rollback-address-second', 'SECOND');
        const quoted = entityRow('fee-quote-address', 'QUOTED');

        rollback.dataTables = ['credits', 'debits'];
        let queryNumber = 0;
        indexer.indexerDb.doQueryStrict = async () => {
            queryNumber++;
            if(queryNumber === 1)
                return [first];

            // This is the vulnerable schedule: the first table has been absorbed and the
            // collector is awaiting the second table when fee-quote dispatch resets and
            // refills indexer.util.
            await dispatchFeeQuoteAction(indexer.util, quoted);
            return [second];
        };

        const result = await rollback.collectAffectedEntities(500);

        assert.deepStrictEqual(Object.keys(result.addresses), [first.address, second.address]);
        assert.deepStrictEqual(result.tickers, [first.tick, second.tick]);
        assert.deepStrictEqual(Object.keys(indexer.util.getAddressesList()), [quoted.address]);
        assert.deepStrictEqual(indexer.util.getTickersList(), [quoted.tick]);
        assert.strictEqual(queryNumber, 2, 'the interleave must occur between two table reads');
    });
});
