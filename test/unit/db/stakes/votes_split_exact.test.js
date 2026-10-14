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
 * test/unit/db/stakes/votes_split_exact.test.js
 *
 * vote_settlement_exact_activation in db.getPollTally. Armed (regtest, genesis) a split
 * ballot's portions are floored to 18 decimal places and the remainder goes to the
 * largest share, the lowest option index on a tie, so they sum exactly to the voter's
 * weight. Unarmed (the committed mainnet and testnet rows) each portion is rounded
 * half-up on its own, exactly as before the row. Uses the getPollTally stub harness of
 * votes_tally_invariants.test.js.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../../../fixtures/config');
const { stubGate }      = require('../../../helpers/gate_modules.js');
const Utility           = require('../../../../src/utility');
const Database          = require('../../../../src/db');

const KEY = 'vote_settlement_exact_activation.VOTE_SETTLEMENT_EXACT_ACTIVATION';

function makeDb(network) {
    const config  = getTestConfig();
    if (network) config.NETWORK = network;
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const db      = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    db.pool = { getConnection: sinon.stub().rejects(new Error('no database in this suite')) };
    return db;
}

// A split poll over three options whose one voter holds `weight` and casts `rows`
// (votes rows in the order the read returns them).
async function tally(db, weight, rows, measureBlock) {
    sinon.stub(db, 'getPoll').resolves({
        action_index: 100, block_index: 90, tick_id: 7, end_block: 500,
        options: '["a","b","c"]', max_selections: 3, tally_mode: 'split',
        weight_mode: 'balance', quorum: null, min_voters: null, min_vote_balance: null,
    });
    sinon.stub(db, 'getTicker').resolves('TKN');
    sinon.stub(db, 'getHolders').resolves({ alice: weight });
    sinon.stub(db, 'getActiveDelegations').resolves({});
    sinon.stub(db, 'getLatestBlockIndex').resolves(600);
    sinon.stub(db, 'doQuery').callsFake(async (sql) => /FROM votes/i.test(sql) ? rows : []);
    const t = await db.getPollTally(100, measureBlock);
    return t.options.map(o => o.weight);
}

function ballot(...shares) {
    return shares.map((share, choice) => ({ address: 'alice', choice, share: String(share) }));
}

function sum(util, weights) {
    return util.bcstr(weights.reduce((acc, w) => util.bcadd(acc, w, 18), '0'));
}

// Armed cases: floors plus a remainder that lands on one deterministic pick.
function registerArmedCases() {
    it('splits 1:1:4 of 100 into floors whose remainder goes to the largest share', async function () {
        const db = makeDb();
        const w = await tally(db, '100', ballot(1, 1, 4));
        assert.deepStrictEqual(w, ['16.666666666666666666', '16.666666666666666666', '66.666666666666666668']);
        assert.strictEqual(sum(db.util, w), '100');
    });

    it('gives the remainder of an even split to the lowest option index, whatever the row order', async function () {
        const want = ['33.333333333333333334', '33.333333333333333333', '33.333333333333333333'];
        assert.deepStrictEqual(await tally(makeDb(), '100', ballot(1, 1, 1)), want);
        sinon.restore();
        assert.deepStrictEqual(await tally(makeDb(), '100', ballot(1, 1, 1).reverse()), want);
    });

    it('sums exactly to the weight for every share triple up to 8 and three weights', async function () {
        const db = makeDb();
        for (const weight of ['1', '7', '0.00000001']) {
            for (let a = 1; a <= 8; a++) for (let b = a; b <= 8; b++) for (let c = b; c <= 8; c++) {
                sinon.restore();
                const w = await tally(makeDb(), weight, ballot(a, b, c));
                assert.strictEqual(sum(db.util, w), db.util.bcstr(weight), weight + ' at ' + [a, b, c].join(':'));
            }
        }
    });
}

// Unarmed cases on one network's committed row: the per-portion half-up rule stands.
function registerUnarmedCases(network) {
    it('keeps the half-up portions of a 1:1:4 split of 100, which sum above the weight', async function () {
        const db = makeDb(network);
        const w = await tally(db, '100', ballot(1, 1, 4));
        assert.deepStrictEqual(w, ['16.6666666666666667', '16.6666666666666667', '66.6666666666666667']);
        assert.strictEqual(sum(db.util, w), '100.0000000000000001');
    });
}

// Height cases: the row is read at the tally's measure block.
function registerHeightCases() {
    beforeEach(function () {
        stubGate(sinon, KEY, false).callsFake((key, network, coin, height) => height >= 300);
    });

    it('a tally measured at 299 rounds half-up and one measured at 300 floors with a remainder', async function () {
        assert.deepStrictEqual(await tally(makeDb(), '100', ballot(1, 1, 4), 299),
            ['16.6666666666666667', '16.6666666666666667', '66.6666666666666667']);
        sinon.restore();
        stubGate(sinon, KEY, false).callsFake((key, network, coin, height) => height >= 300);
        assert.deepStrictEqual(await tally(makeDb(), '100', ballot(1, 1, 4), 300),
            ['16.666666666666666666', '16.666666666666666666', '66.666666666666666668']);
    });
}

describe('VOTE settlement exact activation: split tally @regression @tier1', function () {
    afterEach(() => sinon.restore());

    describe('armed (regtest from genesis)', registerArmedCases);
    for (const network of ['mainnet', 'testnet'])
        describe('unarmed (' + network + ' committed row)', function () { registerUnarmedCases(network); });
    describe('activation height', registerHeightCases);
});
