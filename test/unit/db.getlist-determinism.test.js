/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * test/unit/db.getlist-determinism.test.js
 *
 * db.getList() consensus ordering (3c05dcb9). list_items has no ORDER BY on its
 * AUTO_INCREMENT insert order, so the row order MariaDB returns is engine/plan
 * arbitrary; the consuming AIRDROP recipient loop builds credits in that order.
 * Both branches must impose a deterministic total order on the resolved item
 * string with a BINARY collation (tick = utf8mb4_bin, address = utf8_bin),
 * mirroring the getHolders / getBlockHashes hardening.
 *
 * UNGATED, mirroring getHolders' own ungated sort: the change is invariant to the
 * ledger hash (getBlockHashes re-sorts credits on the resolved address/tick/amount
 * columns and never hashes a surrogate id), so ordered and unordered produce
 * byte-identical block hashes; the sort only removes the engine-order dependency at
 * the source. This is a mock-based structural lock (doQuery stubbed); the whole-file
 * ratchet in db.orderby-determinism.test.js additionally proves these clauses carry
 * a recognized tiebreaker.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

// A Database whose doQuery answers getListType with the given type and captures
// the branch query.
function dbForListType(type) {
    const config = getTestConfig();
    const util   = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    const calls = [];
    sinon.stub(db, 'doQuery').callsFake((query, args) => {
        calls.push({ query, args });
        if (/SELECT\s+type\s+FROM\s+lists/i.test(query)) return Promise.resolve([{ type }]);
        return Promise.resolve([]);
    });
    db._calls = calls;
    return db;
}

function branchQuery(db) {
    const hit = db._calls.find(c => /FROM\s+list_items/i.test(c.query));
    assert.ok(hit, 'getList did not emit its list_items branch query');
    return hit.query.replace(/\s+/g, ' ');
}

afterEach(function () { sinon.restore(); });

describe('db.getList() consensus ordering (3c05dcb9) @regression @tier1', function () {

    it('TICK list (type 1) orders by the resolved tick with a binary collation', async function () {
        const db = dbForListType(1);
        await db.getList(7);
        const q = branchQuery(db);
        assert.match(q, /ORDER BY t\.tick COLLATE utf8mb4_bin ASC/, 'tick branch must impose a binary-collated total order');
    });

    it('ADDRESS list (type 2) orders by the resolved address with a binary collation', async function () {
        const db = dbForListType(2);
        await db.getList(9);
        const q = branchQuery(db);
        assert.match(q, /ORDER BY a\.address COLLATE utf8_bin ASC/, 'address branch must impose a binary-collated total order');
    });

    it('binary collation is required so the sort is independent of the folding index_addresses default', async function () {
        // index_addresses is utf8_general_ci (case/accent-folding); an un-collated
        // ORDER BY a.address would fold distinct addresses and re-introduce an
        // engine-arbitrary tie order. Pinning utf8_bin is the same hazard-closure the
        // house convention applies in getBlockHashes.
        const db = dbForListType(2);
        await db.getList(9);
        assert.doesNotMatch(branchQuery(db), /ORDER BY a\.address ASC/, 'must not order by the folding-collated address without utf8_bin');
    });
});
