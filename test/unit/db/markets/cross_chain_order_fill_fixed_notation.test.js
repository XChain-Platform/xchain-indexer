// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// recordCrossChainOrderFill stores its fill amounts in fixed notation, the byte form the
// local matcher writes to the same order_matches table: an exponential hub string or a
// clamped bignumber (whose toString goes exponential below 1e-7) must not reach the row.

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const Utility = require('../../../../src/utility');
const matchRows = require('../../../../src/db/orders/match_rows.js');

// A db stand-in that captures the order_matches INSERT arguments.
function makeDb() {
    const inserts = [];
    const db = Object.assign(Object.create(matchRows), {
        util: new Utility(),
        createCoin: sinon.stub().resolves(1),
        createTicker: sinon.stub().resolves(2),
        createStatus: sinon.stub().resolves(3),
        doQuery: sinon.stub().callsFake(async (sql, args) => {
            if (/INSERT INTO order_matches/.test(sql)) inserts.push(args);
            return [];
        }),
    });
    return { db, inserts };
}

describe('recordCrossChainOrderFill fixed-notation amounts @regression @tier1', function () {
    it('renders an exponential hub string in fixed notation', async function () {
        const { db, inserts } = makeDb();
        await db.recordCrossChainOrderFill(500, 100, '5e-8', '1.5', 'BTC', 'TOK', 'LTC', null);
        assert.strictEqual(inserts.length, 1);
        assert.strictEqual(inserts[0][2], '0.00000005');
        assert.strictEqual(inserts[0][6], '1.5');
    });

    it('renders a clamped bignumber in fixed notation, never "5e-8"', async function () {
        const { db, inserts } = makeDb();
        const clamped = db.util.bcsub('0.00000015', '0.0000001', 64);
        await db.recordCrossChainOrderFill(501, 100, clamped, '2', 'BTC', 'TOK', 'LTC', null);
        assert.strictEqual(inserts[0][2], '0.00000005');
    });

    it('passes a null or non-numeric amount through unchanged', async function () {
        const { db, inserts } = makeDb();
        await db.recordCrossChainOrderFill(502, 100, null, 'abc', 'BTC', 'TOK', 'LTC', null);
        assert.strictEqual(inserts[0][2], null);
        assert.strictEqual(inserts[0][6], 'abc');
    });
});
