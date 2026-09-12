// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

/*
 * Fee pricing must not select a price round the CHAIN has not shown the node yet.
 *
 * A hub-connected node's oracle mirror holds a round the moment consensus finalizes
 * it, a whole batch window before the PRICE batch carrying it is mined. A node that
 * reads only the chain cannot hold that round until the batch lands in a block it has
 * processed. Both nodes are honest, and unbounded getLatestPrice has them price the
 * same fee-bearing action against different rounds.
 *
 * These cases drive the two node kinds as two ROW SETS over the same block, and the
 * query getLatestPrice emits is EVALUATED against them rather than pattern-matched:
 * applyQuery below applies exactly the bounds the WHERE clause declares, in the order
 * it declares them, against the arguments actually bound. A clause that carries no
 * argument, or an argument that no clause consumes, fails here.
 */

'use strict';

process.env.INDEXER_COIN    = 'DOGE';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');
const landedGate        = require('../../src/price_fee_batch_landed_activation');

// One block: its height on the processing chain and its own clock.
const BLOCK_HEIGHT = 6280000;
const BLOCK_TIME   = 1700010000;

// Round 41's batch landed two blocks ago; round 42 finalized 9 minutes ago and its
// batch has not been mined at all. reference_block on a landed row is the landing
// block on the LANDING chain (D8), which is why it is not the discriminator here.
const ROUND_41_LANDED = {
    coin_pair: 'DOGE/USD', price: '0.085', round_number: 41,
    block_timestamp: BLOCK_TIME - 3000, reference_block: 6279900,
    batch_block_time: BLOCK_TIME - 900, status: 'finalized'
};
const ROUND_42_UNLANDED = {
    coin_pair: 'DOGE/USD', price: '0.101', round_number: 42,
    block_timestamp: BLOCK_TIME - 540, reference_block: 6279950,
    batch_block_time: 0, status: 'finalized'
};

// What each node kind holds at this block: the hub-connected mirror carries the
// freshly finalized round as well, the chain-only node cannot.
const HUB_CONNECTED = [ROUND_41_LANDED, ROUND_42_UNLANDED];
const CHAIN_ONLY    = [ROUND_41_LANDED];

// The bounds getLatestPrice can declare, each paired with the predicate it means.
// Order of appearance in the WHERE decides which argument each one consumes.
const BOUNDS = [
    { re: /block_timestamp <= \?/,
      pred: (v) => (r) => Number(r.block_timestamp) <= Number(v) },
    { re: /reference_block <= \?/,
      pred: (v) => (r) => Number(r.reference_block) <= Number(v) },
    { re: /batch_block_time > 0 AND batch_block_time <= \?/,
      pred: (v) => (r) => Number(r.batch_block_time) > 0 && Number(r.batch_block_time) <= Number(v) }
];

// Evaluate the emitted statement against `rows`. Deliberately strict about the
// argument list: a bound whose argument is missing or misordered changes the answer
// here exactly as it would against MariaDB.
function applyQuery(query, args, rows) {
    assert.ok(/coin_pair = \?/.test(query), 'the pair must be bound: ' + query);
    assert.ok(/status = 'finalized'/.test(query), 'only finalized rounds are selectable: ' + query);
    assert.ok(/price IS NOT NULL/.test(query), 'a withheld price is not selectable: ' + query);
    assert.ok(/ORDER BY round_number DESC LIMIT 1/.test(query), 'newest round wins: ' + query);

    let declared = BOUNDS.filter(b => b.re.test(query))
                         .sort((a, b) => query.search(a.re) - query.search(b.re));
    assert.strictEqual(args.length, 1 + declared.length,
        'the argument list must carry exactly one value per declared bound; declared ' +
        declared.length + ', bound ' + (args.length - 1) + ' in ' + query);

    let preds = [(r) => r.coin_pair === args[0]];
    declared.forEach((b, i) => preds.push(b.pred(args[i + 1])));

    return rows.filter(r => preds.every(p => p(r)))
               .sort((a, b) => b.round_number - a.round_number)
               .slice(0, 1);
}

function makeDb(rows) {
    const config  = getTestConfig();
    config['NETWORK'] = 'regtest';
    config['COIN']    = 'DOGE';
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const indexer = { config, util };
    const db = new Database('127.0.0.1', 3306, 'xchain_doge_regtest', 'u', 'p', indexer);
    db.lastQuery = null;
    sinon.stub(db, 'doQueryStrict').callsFake(async (query, args) => {
        db.lastQuery = { query, args };
        return applyQuery(query, args || [], rows);
    });
    return db;
}

// Price the same block on both node kinds and report the round each one selected.
async function priceOnBothNodeKinds() {
    const hubNode   = makeDb(HUB_CONNECTED);
    const chainNode = makeDb(CHAIN_ONLY);
    const opts = { blockTime: BLOCK_TIME, maxAgeSeconds: 3600, selectByTime: true };
    return {
        hub:   await hubNode.getLatestPrice('DOGE/USD', BLOCK_HEIGHT, opts),
        chain: await chainNode.getLatestPrice('DOGE/USD', BLOCK_HEIGHT, opts),
        query: hubNode.lastQuery
    };
}

afterEach(function () {
    sinon.restore();
});

describe('getLatestPrice() landed-batch fee bound @regression @tier1', function () {

    it('the defect, unbounded: the two node kinds price the same block against different rounds', async function () {
        const got = await priceOnBothNodeKinds();
        assert.strictEqual(got.hub.roundNumber, 42, 'the mirror serves the round no block carries yet');
        assert.strictEqual(got.chain.roundNumber, 41, 'the chain-only node can only see the landed round');
        assert.notStrictEqual(got.hub.price, got.chain.price, 'the same fee is valued two ways');
    });

    it('armed: both node kinds price against the round whose batch had landed', async function () {
        sinon.stub(landedGate, 'isPriceFeeBatchLandedActive').returns(true);
        const got = await priceOnBothNodeKinds();
        assert.strictEqual(got.hub.roundNumber, 41);
        assert.strictEqual(got.chain.roundNumber, 41);
        assert.strictEqual(got.hub.price, got.chain.price);
        assert.strictEqual(got.hub.price, '0.085', 'the PRE-BATCH price is the one used');
    });

    it('armed: a round whose batch lands in a LATER block than this one is not selectable', async function () {
        sinon.stub(landedGate, 'isPriceFeeBatchLandedActive').returns(true);
        // Same row set, but round 41's batch landed one second after this block's clock.
        const rows = [Object.assign({}, ROUND_41_LANDED, { batch_block_time: BLOCK_TIME + 1 }),
                      ROUND_42_UNLANDED];
        const db  = makeDb(rows);
        const got = await db.getLatestPrice('DOGE/USD', BLOCK_HEIGHT,
            { blockTime: BLOCK_TIME, maxAgeSeconds: 3600, selectByTime: true });
        assert.strictEqual(got, null, 'no round the chain had shown this block, so no price');
    });

    it('armed: the height-selected (reference chain) path carries the bound too', async function () {
        sinon.stub(landedGate, 'isPriceFeeBatchLandedActive').returns(true);
        const db  = makeDb(HUB_CONNECTED);
        const got = await db.getLatestPrice('DOGE/USD', BLOCK_HEIGHT,
            { blockTime: BLOCK_TIME, maxAgeSeconds: 3600 });
        assert.ok(/reference_block <= \?/.test(db.lastQuery.query), 'still height-selected');
        assert.strictEqual(got.roundNumber, 41, 'and still only the landed round');
    });

    it('armed: no chain-derived block time means NO price, never an unbounded one', async function () {
        sinon.stub(landedGate, 'isPriceFeeBatchLandedActive').returns(true);
        sinon.stub(console, 'warn');
        const db  = makeDb(HUB_CONNECTED);
        const got = await db.getLatestPrice('DOGE/USD', BLOCK_HEIGHT);
        assert.strictEqual(got, null);
        assert.strictEqual(db.lastQuery, null, 'it must not fall back to the unbounded selection');
        assert.ok(console.warn.calledOnce, 'and it must say so once');
    });

    it('unarmed: the statement and its arguments are byte-identical to the pre-gate ones', async function () {
        const db = makeDb(HUB_CONNECTED);
        await db.getLatestPrice('DOGE/USD', BLOCK_HEIGHT,
            { blockTime: BLOCK_TIME, maxAgeSeconds: 3600, selectByTime: true });
        assert.ok(!/batch_block_time/.test(db.lastQuery.query),
            'below the height no bound is added: ' + db.lastQuery.query);
        assert.deepStrictEqual(db.lastQuery.args, ['DOGE/USD', BLOCK_TIME]);
    });
});

describe('PRICE_FEE_BATCH_LANDED_ACTIVATION sizing @regression @tier1', function () {

    it('mainnet is unarmed at every height', function () {
        assert.strictEqual(landedGate.PRICE_FEE_BATCH_LANDED_ACTIVATION.mainnet, null);
        assert.strictEqual(landedGate.isPriceFeeBatchLandedActive(0, 'mainnet', 'BTC'), false);
        assert.strictEqual(landedGate.isPriceFeeBatchLandedActive(Number.MAX_SAFE_INTEGER, 'mainnet', 'DOGE'), false);
    });

    it('every network the map declares is unarmed, and an undeclared one is inert', function () {
        for (const net of Object.keys(landedGate.PRICE_FEE_BATCH_LANDED_ACTIVATION)) {
            assert.strictEqual(landedGate.isPriceFeeBatchLandedActive(9e9, net, 'DOGE'), false, net);
        }
        assert.strictEqual(landedGate.isPriceFeeBatchLandedActive(9e9, 'someothernet', 'DOGE'), false);
        assert.strictEqual(landedGate.isPriceFeeBatchLandedActive(9e9, undefined, undefined), false);
    });

    it('an armed threshold is inclusive at the height and off one block below it', function () {
        // Arming is a coordinated event, so the map ships unarmed; the comparison itself
        // still has to be pinned, or the first network armed would be the test of it.
        const map = landedGate.PRICE_FEE_BATCH_LANDED_ACTIVATION;
        map['DOGE:regtest'] = 500;
        try {
            assert.strictEqual(landedGate.isPriceFeeBatchLandedActive(499, 'regtest', 'DOGE'), false);
            assert.strictEqual(landedGate.isPriceFeeBatchLandedActive(500, 'regtest', 'DOGE'), true);
            assert.strictEqual(landedGate.isPriceFeeBatchLandedActive(501, 'regtest', 'DOGE'), true);
            // The per-chain key must not leak onto a sibling chain of the same network.
            assert.strictEqual(landedGate.isPriceFeeBatchLandedActive(9e9, 'regtest', 'LTC'), false);
            assert.strictEqual(landedGate.isPriceFeeBatchLandedActive('not a height', 'regtest', 'DOGE'), false);
        } finally {
            delete map['DOGE:regtest'];
        }
    });
});
