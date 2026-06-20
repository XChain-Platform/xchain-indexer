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
 * test/unit/db.getHolders-tiebreak.test.js
 *
 * CONSENSUS REGRESSION GUARD for db.getHolders() equal-balance tiebreak determinism.
 *
 * getHolders() builds the holder list that DIVIDEND, AIRDROP, and CALLBACK iterate to push
 * credits into the ledger (dividend.js / airdrop.js / callback.js). The two source queries
 * carry a GROUP BY but NO ORDER BY, so MariaDB returns equal-balance holders in engine-
 * arbitrary row order; Node's stable sort then preserves that arbitrary order whenever the
 * balance comparator returns 0. Two honest validators whose engine returns the GROUP BY tie
 * differently would push credits in different order → different InnoDB pk order → divergent
 * ledger hash → chain fork (and divergent ANCHOR checkpoint signatures). This is the holder-
 * side sibling of the getBlockHashes tie-order fork guarded by db.getBlockHashes-tieorder.test.js.
 *
 * Fix: the getHolders sort comparator falls back to a lexicographic address tiebreak when two
 * holders share a balance, giving a total order independent of GROUP BY return order.
 *
 * Technique mirrors db.queries.test.js / db.getBlockHashes-tieorder.test.js: stub doQuery on a
 * prototype-borrowed Database so the real getHolders logic runs against injected rows; no live
 * MariaDB. A negative control (balance-only comparator = the pre-fix sort) proves the test has
 * teeth: it leaves the injected scramble intact and therefore forks.
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
    // Replace the real pool so the constructor doesn't try to connect.
    db.pool = { getConnection: sinon.stub().resolves({
        query:   sinon.stub().resolves([]),
        release: sinon.stub().resolves()
    }) };
    return db;
}

// Run getHolders against an injected set of equal-balance credit rows returned in `creditRows`
// order (no debits). Returns the ordered list of holder addresses as getHolders would iterate it.
async function holderOrder(creditRows) {
    const db = makeDb();
    sinon.stub(db, 'createTicker').resolves(1);
    sinon.stub(db, 'getTokenDecimalPrecision').resolves(8);
    sinon.stub(db, 'doQuery').callsFake(async (sql) => {
        // The credits GROUP BY query feeds the holder balances; debits query returns nothing.
        if (/FROM\s+credits\b/i.test(sql)) return creditRows;
        return [];
    });
    const holders = await db.getHolders('TESTTOKEN', 306, 999);
    return Object.keys(holders);
}

afterEach(function () { sinon.restore(); });

describe('Database.getHolders() equal-balance tiebreak determinism @regression @tier1', function () {

    // (1) Property: three holders with identical balances must iterate in the SAME order no
    //     matter what physical order the GROUP BY returned them in. The fix sorts the tie by
    //     address lexicographically, so the order is total and engine-independent.
    it('returns equal-balance holders in a stable order regardless of GROUP BY return order', async function () {
        const rowsAsc  = [
            { address: 'addrA', credits: '100' },
            { address: 'addrB', credits: '100' },
            { address: 'addrC', credits: '100' }
        ];
        // Same logical rows, scrambled physical order (what a different engine/node might return).
        const rowsScrambled = [
            { address: 'addrC', credits: '100' },
            { address: 'addrA', credits: '100' },
            { address: 'addrB', credits: '100' }
        ];

        const orderA = await holderOrder(rowsAsc);
        const orderB = await holderOrder(rowsScrambled);

        assert.deepStrictEqual(
            orderA, orderB,
            'getHolders iteration order must not depend on the engine-returned order of equal-balance holders'
        );
        // And it must specifically be lexicographic address order.
        assert.deepStrictEqual(orderA, ['addrA', 'addrB', 'addrC']);
    });

    // (2) Mixed balances still sort by balance descending; only true ties fall back to address.
    it('keeps balance-descending order, using the address tiebreak only on equal balances', async function () {
        const rows = [
            { address: 'addrZ', credits: '100' },  // tie with addrA at 100
            { address: 'addrM', credits: '500' },  // largest
            { address: 'addrA', credits: '100' }   // tie with addrZ at 100
        ];
        const order = await holderOrder(rows);
        // 500 first, then the two 100-balance holders in lexicographic address order.
        assert.deepStrictEqual(order, ['addrM', 'addrA', 'addrZ']);
    });

    // (3) Negative control: the PRE-FIX balance-only comparator leaves the injected scramble
    //     intact (Node's sort is stable), proving the property test above is not vacuous.
    it('negative control: a balance-only comparator forks on equal-balance holders', function () {
        const util = new Utility();
        const balanceOnly = ([, a], [, b]) => util.bcgt(b, a) ? 1 : util.bclt(b, a) ? -1 : 0;

        const scrambleA = [['addrA', '100'], ['addrB', '100'], ['addrC', '100']];
        const scrambleB = [['addrC', '100'], ['addrA', '100'], ['addrB', '100']];

        const orderA = scrambleA.slice().sort(balanceOnly).map(([a]) => a);
        const orderB = scrambleB.slice().sort(balanceOnly).map(([a]) => a);

        assert.notDeepStrictEqual(
            orderA, orderB,
            'sanity: balance-only ordering MUST preserve the scramble here, else the property test is vacuous'
        );
    });
});
