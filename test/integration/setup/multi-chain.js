'use strict';

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Multi-chain test harness for integration scenarios.
 *
 * The indexer's behavior is chain-parameterized through process.env.INDEXER_COIN /
 * INDEXER_NETWORK, which config.getConfig() RE-READS on every call (src/config.js:31 —
 * no memoization). Address validation is length-only with no chain prefixes
 * (src/utility.js isCryptoAddress), and the indexer DB schema is identical across
 * coins. Together that means we can sweep BTC/LTC/DOGE in a SINGLE mocha process by
 * setting the coin, rebuilding a fresh indexer against a clean DB, and reusing generic
 * test addresses — no per-chain address generation needed.
 *
 *   const { COINS, withCoin } = require('../setup/multi-chain');
 *   for (const coin of COINS) {
 *     it(`does X on ${coin}`, () => withCoin(coin, 'regtest', async ({ seeder, indexer }) => {
 *       await seeder.seedBlock(...); await processBlocks(indexer); ...assert...
 *     }));
 *   }
 */

const { decoderQuery, resetDecoderDb, resetIndexerDb } = require('./db-connection');
const DecoderSeeder = require('./decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer } = require('./indexer-launcher');

// The three protocol chains (config.js:55 RESERVED_TICKS source list).
const COINS = ['BTC', 'LTC', 'DOGE'];

/**
 * Run `fn` against a freshly-built indexer configured for `coin` on `network`.
 *
 * Sets the chain env BEFORE building the indexer (config is read at init time), wipes both
 * decoder and indexer DBs for a clean slate, and tears the indexer down afterward so the
 * next coin starts from zero. `fn` receives { indexer, seeder, coin } and its return value
 * is passed through.
 */
async function withCoin(coin, network, fn) {
    process.env.INDEXER_COIN    = coin;
    process.env.INDEXER_NETWORK = network || 'regtest';

    await resetDecoderDb();
    await resetIndexerDb();

    const seeder  = new DecoderSeeder(decoderQuery);
    const indexer = await initIndexer();
    try {
        return await fn({ indexer, seeder, coin });
    } finally {
        await destroyIndexer(indexer);
    }
}

module.exports = { COINS, withCoin, processBlocks };
