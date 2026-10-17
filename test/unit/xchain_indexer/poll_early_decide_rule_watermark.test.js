/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/xchain_indexer/poll_early_decide_rule_watermark.test.js
 *
 * The early-decide watermark across the vote_settlement_exact_activation height. A
 * split poll sits exactly at its decide threshold under the floored split rule and just
 * under it under the half-up rule, with no input row landing near the height. A node
 * whose watermark cache is warm from the block before the height and a node that starts
 * cold at the height must both close the poll early at the height itself. Unarmed, both
 * keep the poll open and the cached fingerprint is the plain input-row watermark.
 * Uses a real Database and the real getPollTally with its reads stubbed; no MariaDB.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../../fixtures/config');
const { stubGate }      = require('../../helpers/gate_modules.js');
const Utility           = require('../../../src/utility');
const Database          = require('../../../src/db');

const KEY = 'vote_settlement_exact_activation.VOTE_SETTLEMENT_EXACT_ACTIVATION';
const ARM_HEIGHT = 300;
// One voter holds the whole supply of 1 and splits 1:1:1. Floored, option 0 takes the
// remainder and reaches 0.333333333333333334; half-up, every option is 0.333333333333333333.
const THRESHOLD = '0.333333333333333334';

// A node: its own Database (so its own watermark cache) over the same stubbed chain state.
function makeNode(network) {
    const config = getTestConfig();
    if (network) config.NETWORK = network;
    const util = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    db.pool = { getConnection: sinon.stub().rejects(new Error('no database in this suite')) };
    sinon.stub(db, 'getDuePolls').resolves([]);
    sinon.stub(db, 'getPoll').resolves({
        action_index: 42, block_index: 90, tick_id: 7, end_block: 1000,
        options: '["a","b","c"]', max_selections: 3, tally_mode: 'split',
        weight_mode: 'balance', quorum: null, min_voters: null, min_vote_balance: null,
    });
    sinon.stub(db, 'getTicker').resolves('TKN');
    sinon.stub(db, 'getHolders').resolves({ alice: '1' });
    sinon.stub(db, 'getActiveDelegations').resolves({});
    sinon.stub(db, 'getLatestBlockIndex').resolves(ARM_HEIGHT);
    // The ballot rows, and an input-row watermark that never moves near the height.
    sinon.stub(db, 'doQuery').callsFake(async (sql) => /COALESCE\(MAX/.test(sql)
        ? [{ v: 5, d: 0, l: 9 }]
        : ['0', '1', '2'].map((c) => ({ address: 'alice', choice: Number(c), share: '1' })));
    const actions = { processAction: sinon.stub().resolves(), actionVote: { processDueCallbacks: sinon.stub().resolves() } };
    // The poll stays armed until this node's own early-decide finalizes it.
    sinon.stub(db, 'getArmedPolls').callsFake(async () => actions.processAction.called ? []
        : [{ action_index: 42, tick_id: 7, weight_mode: 'balance', decide_threshold: THRESHOLD }]);
    return { db, util, actions };
}

// The blocks at which the node injected an early-decide VOTE v2.
function closeBlocks(node) {
    return node.actions.processAction.getCalls().map((c) => c.args[2]['EFFECTIVE_CLOSE_BLOCK']);
}

async function runBlocks(node, from, to) {
    for (let h = from; h <= to; h++)
        await node.util.processVoteFinalizations(node.actions, node.db, h, 1700000000 + h * 600);
}

describe('early-decide watermark across the vote settlement exact activation @regression @tier1', function () {
    afterEach(() => sinon.restore());

    describe('armed at a height', function () {
        beforeEach(function () {
            stubGate(sinon, KEY, false).callsFake((key, network, coin, height) => height >= ARM_HEIGHT);
        });

        it('a warm node and a cold node both close the split poll at the arming height', async function () {
            const warm = makeNode();
            const cold = makeNode();
            await runBlocks(warm, ARM_HEIGHT - 2, ARM_HEIGHT - 1);
            assert.deepStrictEqual(closeBlocks(warm), [], 'the half-up tally stays under the threshold');
            assert.ok(warm.db.pollTallyWatermarkMatches(42, '5:0:9'), 'the warm cache holds the pre-height fingerprint');
            await runBlocks(warm, ARM_HEIGHT, ARM_HEIGHT);
            await runBlocks(cold, ARM_HEIGHT, ARM_HEIGHT);
            assert.deepStrictEqual(closeBlocks(warm), [ARM_HEIGHT]);
            assert.deepStrictEqual(closeBlocks(cold), [ARM_HEIGHT]);
        });

        it('a node that restarts between the height and a later block agrees on the close block', async function () {
            const before = makeNode();
            await runBlocks(before, ARM_HEIGHT - 3, ARM_HEIGHT - 1);
            const restarted = makeNode();
            await runBlocks(restarted, ARM_HEIGHT, ARM_HEIGHT + 1);
            await runBlocks(before, ARM_HEIGHT, ARM_HEIGHT + 1);
            assert.deepStrictEqual(closeBlocks(before), closeBlocks(restarted));
            assert.deepStrictEqual(closeBlocks(before), [ARM_HEIGHT]);
        });
    });

    for (const network of ['mainnet', 'testnet']) {
        it('unarmed on ' + network + ': warm and cold nodes keep the poll open and cache the plain watermark', async function () {
            const warm = makeNode(network);
            const cold = makeNode(network);
            await runBlocks(warm, ARM_HEIGHT - 2, ARM_HEIGHT);
            await runBlocks(cold, ARM_HEIGHT, ARM_HEIGHT);
            assert.deepStrictEqual(closeBlocks(warm), []);
            assert.deepStrictEqual(closeBlocks(cold), []);
            assert.ok(warm.db.pollTallyWatermarkMatches(42, '5:0:9'));
            assert.ok(cold.db.pollTallyWatermarkMatches(42, '5:0:9'));
        });
    }
});
