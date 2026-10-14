// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig }     = require('../../../fixtures/config');
const { createMockIndexer } = require('../../../fixtures/mocks');
const Utility               = require('../../../../src/utility');
const Database              = require('../../../../src/db');
const Rollback              = require('../../../../src/rollback/index.js');

const T0 = 1700000000;
const timeOf = (h) => T0 + h * 600;

// A Database whose blocks table is an in-memory map of height to time, read through the
// real getBlockTime and its memo. Every other step of the refresh is stubbed.
function makeDb(heights) {
    const util = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config: getTestConfig(), util });
    db.blocks = new Map(heights.map(h => [h, timeOf(h)]));
    db.doQueryStrict = async (sql, args) => {
        if (/FROM blocks\s+where block_index=\?/i.test(sql))
            return db.blocks.has(Number(args[0])) ? [{ block_time: db.blocks.get(Number(args[0])) }] : [];
        if (/FROM blocks\s+WHERE block_index < \?/i.test(sql))
            return [...db.blocks.keys()].filter(h => h < args[0]).sort((a, b) => b - a).slice(0, args[1])
                .map(h => ({ block_time: db.blocks.get(h) }));
        return [];
    };
    for (const step of ['updateBalances', 'updateTokens', 'sanityCheck', 'updateMarketInfo']) sinon.stub(db, step).resolves();
    sinon.stub(db, 'getMarketId').resolves(1);
    sinon.stub(db, 'getMarketInfo').callsFake(async (market_id, block_time) => ({ market_id, last_updated: block_time }));
    return db;
}

// Delete the orphaned heights the way the rollback's block-table purge does, then run the
// rollback's projection refresh for one market touched in the orphaned range.
async function refreshAfterRollback(db, target) {
    for (const h of [...db.blocks.keys()]) if (h >= target) db.blocks.delete(h);
    const indexer = createMockIndexer();
    indexer.indexerDb = db;
    await new Rollback(indexer).refreshDerivedProjections(target, {}, [], [{ tick1_id: 1, tick2_id: 2 }]);
    return db.updateMarketInfo.getCalls().map(c => c.args[0].last_updated);
}

// The time a node that never saw the orphaned blocks reads for the surviving tip.
async function cleanTipTime(heights, tip) {
    return makeDb(heights.filter(h => h <= tip)).getBlockTime(tip);
}

describe('reorg rollback stamps markets from the surviving tip @regression @tier3', function () {
    afterEach(() => sinon.restore());

    const heights = Array.from({ length: 20 }, (_, i) => 81 + i);

    it('ignores the orphaned block time a warm memo still holds', async function () {
        const db = makeDb(heights);
        await db.getBlockTime(100);
        const stamps = await refreshAfterRollback(db, 100);
        assert.deepStrictEqual(stamps, [await cleanTipTime(heights, 99)]);
    });

    it('never stamps a row with an unresolvable time once the target row is gone', async function () {
        const db = makeDb(heights);
        const stamps = await refreshAfterRollback(db, 100);
        assert.deepStrictEqual(stamps, [await cleanTipTime(heights, 99)]);
        assert.ok(stamps.every(t => Number(t) > 0), 'no market is stamped 0 or false');
    });

    it('skips the refresh when no block survives below the target', async function () {
        const db = makeDb(heights);
        const stamps = await refreshAfterRollback(db, 81);
        assert.deepStrictEqual(stamps, [], 'no market is written with an unresolvable time');
    });
});
