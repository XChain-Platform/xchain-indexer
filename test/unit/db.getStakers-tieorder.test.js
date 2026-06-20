/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/db.getStakers-tieorder.test.js
 *
 * CONSENSUS REGRESSION GUARD for getContractStakeDataForVM() staker ordering determinism.
 *
 * getContractStakeDataForVM() builds the per-tick stakers snapshot a contract observes through
 * xchain.contract.getStakers(). The source query carries NO ORDER BY, so MariaDB returns
 * equal-amount stakers in engine-arbitrary row order. The sort used to compare amounts only, so
 * Node's stable sort preserved that arbitrary order on ties. That forks consensus twice:
 *   (1) iteration order: a contract iterating getStakers() observes a different order per node;
 *   (2) the 1000-staker cap: `arr.slice(0, 1000)` keeps a DIFFERENT membership per node when
 *       ties straddle the 1000th position.
 * Either diverges getStakers() output (and any contract branching on it) across validators.
 * This is the staking sibling of the getHolders / getBlockHashes tie-order forks guarded by
 * db.getHolders-tiebreak.test.js and db.getBlockHashes-tieorder.test.js.
 *
 * Fix: the staker sort falls back to a lexicographic pubkey tiebreak on equal amounts, giving a
 * total order independent of the query's return order (pubkey is unique per tick after
 * aggregation). A negative control (amount-only comparator = the pre-fix sort) proves teeth.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

function makeDb() {
    const config  = getTestConfig();
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const indexer = { config, util };
    const db      = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
    db.pool = { getConnection: sinon.stub().resolves({
        query:   sinon.stub().resolves([]),
        release: sinon.stub().resolves()
    }) };
    return db;
}

// Run getContractStakeDataForVM against an injected set of stake rows (returned in `rows` order)
// and return the ordered pubkey list for the tick as a contract's getStakers() would observe it.
async function stakerOrder(rows, tick = 'tick') {
    const db = makeDb();
    sinon.stub(db, 'getStatusId').resolves(1);
    sinon.stub(db, 'doQuery').resolves(rows);
    const res = await db.getContractStakeDataForVM(42, 306);
    return (res.stakersByTick[tick] || []).map(s => s.pubkey);
}

function stakeRow(pubkey, amount, tick = 'tick') {
    return { signing_pubkey_id: pubkey, pubkey, tick_id: 1, tick, amount,
             activation_block: 1, deactivation_block: null };
}

afterEach(function () { sinon.restore(); });

describe('getContractStakeDataForVM() staker tie-order determinism @regression @tier1', function () {

    // (1) Property: equal-amount stakers must order the SAME way regardless of the physical
    //     row order the query returned, via the lexicographic pubkey tiebreak.
    it('orders equal-amount stakers deterministically regardless of query return order', async function () {
        const asc       = [stakeRow('pka', '100'), stakeRow('pkb', '100'), stakeRow('pkc', '100')];
        const scrambled = [stakeRow('pkc', '100'), stakeRow('pka', '100'), stakeRow('pkb', '100')];

        const orderA = await stakerOrder(asc);
        const orderB = await stakerOrder(scrambled);

        assert.deepStrictEqual(orderA, orderB,
            'getStakers order must not depend on the query-returned order of equal-amount stakers');
        assert.deepStrictEqual(orderA, ['pka', 'pkb', 'pkc']);
    });

    // (2) Mixed amounts still sort by amount descending; only true ties fall back to pubkey.
    it('keeps amount-descending order, using the pubkey tiebreak only on equal amounts', async function () {
        const rows = [
            stakeRow('pkz', '100'),  // tie with pka at 100
            stakeRow('pkm', '500'),  // largest
            stakeRow('pka', '100')   // tie with pkz at 100
        ];
        const order = await stakerOrder(rows);
        assert.deepStrictEqual(order, ['pkm', 'pka', 'pkz']);
    });

    // (3) The 1000-cap keeps a DETERMINISTIC membership when ties straddle the boundary.
    //     1001 equal-amount stakers: the lexicographically-largest pubkey is the one dropped,
    //     identically for any input order.
    it('applies the 1000-staker cap to a deterministic membership regardless of input order', async function () {
        // pk0000..pk1000, zero-padded so lexicographic order == numeric order.
        const pubkeys = [];
        for (let i = 0; i <= 1000; i++) pubkeys.push('pk' + String(i).padStart(4, '0'));
        const inOrder  = pubkeys.map(pk => stakeRow(pk, '100'));
        const reversed = inOrder.slice().reverse();

        const survivorsA = await stakerOrder(inOrder);
        const survivorsB = await stakerOrder(reversed);

        assert.strictEqual(survivorsA.length, 1000, 'cap keeps exactly 1000');
        assert.deepStrictEqual(survivorsA, survivorsB,
            'which 1000 stakers survive the cap must not depend on query return order');
        // pk1000 (largest pubkey) is the one dropped; pk0000..pk0999 survive in order.
        assert.strictEqual(survivorsA[0], 'pk0000');
        assert.strictEqual(survivorsA[999], 'pk0999');
        assert.ok(!survivorsA.includes('pk1000'), 'the lexicographically-largest pubkey is dropped');
    });

    // (4) Negative control: the PRE-FIX amount-only comparator leaves the injected scramble
    //     intact (Node's sort is stable), proving the property tests above are not vacuous.
    it('negative control: an amount-only comparator forks on equal-amount stakers', function () {
        const util = new Utility();
        const amountOnly = (a, b) => util.bcgt(b.amount, a.amount) ? 1 : (util.bcgt(a.amount, b.amount) ? -1 : 0);

        const scrambleA = [{ pubkey: 'pka', amount: '100' }, { pubkey: 'pkb', amount: '100' }, { pubkey: 'pkc', amount: '100' }];
        const scrambleB = [{ pubkey: 'pkc', amount: '100' }, { pubkey: 'pka', amount: '100' }, { pubkey: 'pkb', amount: '100' }];

        const orderA = scrambleA.slice().sort(amountOnly).map(s => s.pubkey);
        const orderB = scrambleB.slice().sort(amountOnly).map(s => s.pubkey);

        assert.notDeepStrictEqual(orderA, orderB,
            'sanity: amount-only ordering MUST preserve the scramble here, else the property tests are vacuous');
    });
});
