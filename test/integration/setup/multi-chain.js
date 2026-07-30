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
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Multi-chain test harness for integration scenarios.
 *
 * The indexer's behavior is chain-parameterized through process.env.INDEXER_COIN /
 * INDEXER_NETWORK, which config.getConfig() RE-READS on every call (src/config.js:31,
 * no memoization). Address validation is length-only with no chain prefixes
 * (src/utility.js isCryptoAddress), and the indexer DB schema is identical across
 * coins. Together that means we can sweep BTC/LTC/DOGE in a SINGLE mocha process by
 * setting the coin, rebuilding a fresh indexer against a clean DB, and reusing generic
 * test addresses (no per-chain address generation needed).
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

// The unset/placeholder FEE_DESTINATION sentinel detectFeePaymentMode treats as
// "no native fee destination configured" (src/utility.js), which routes every
// action to the xchain-balance fee path.
const FEE_PLACEHOLDER = 'X'.repeat(34);

/**
 * Pin an already-initialized indexer to the xchain-balance fee path by blanking
 * FEE_DESTINATION on the LIVE config snapshot (shared by reference with Actions /
 * Utility / Mapper, so detectFeePaymentMode sees the change).
 *
 * The parity suites need every coin on the SAME fee path (their premise is
 * "identical input -> identical ledger"). The old route (placeholder via the
 * XCHAIN_FEE_DESTINATION_*_REGTEST env override) now fails closed at startup on
 * LTC/DOGE (src/config.js FEE_DESTINATION guard), which is correct for a real
 * node (a placeholder would silently flip it to a divergent acceptance rule) but
 * would abort these single-process test indexers. Mutating the snapshot after a
 * clean startup keeps the production guard intact while still exercising the
 * chain-agnostic fee math.
 */
function forceXchainFeeMode(indexer) {
    indexer.config.ADDRESS.FEE_DESTINATION = FEE_PLACEHOLDER;
}

/**
 * Run `fn` against a freshly-built indexer configured for `coin` on `network`.
 *
 * Sets the chain env BEFORE building the indexer (config is read at init time), wipes both
 * decoder and indexer DBs for a clean slate, and tears the indexer down afterward so the
 * next coin starts from zero. `fn` receives { indexer, seeder, coin } and its return value
 * is passed through.
 *
 * The chain env is RESTORED afterwards. Mocha runs every file in one process, so leaving
 * INDEXER_COIN on the last coin of the sweep silently re-chains whichever suite runs next:
 * on LTC/DOGE the native-fee path is live, and a BTC-shaped fixture then fails with
 * 'insufficient fee (native coin output required)', which reads as a product defect and is
 * not one. Today an unrelated suite happens to re-pin BTC in between; that is luck, not a
 * contract.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.xchainFeeMode] - apply forceXchainFeeMode after init.
 */
async function withCoin(coin, network, fn, opts = {}) {
    const prevCoin    = process.env.INDEXER_COIN;
    const prevNetwork = process.env.INDEXER_NETWORK;
    process.env.INDEXER_COIN    = coin;
    process.env.INDEXER_NETWORK = network || 'regtest';

    await resetDecoderDb();
    await resetIndexerDb();

    const seeder  = new DecoderSeeder(decoderQuery);
    const indexer = await initIndexer();
    if (opts.xchainFeeMode) forceXchainFeeMode(indexer);
    try {
        return await fn({ indexer, seeder, coin });
    } finally {
        await destroyIndexer(indexer);
        restoreEnv('INDEXER_COIN',    prevCoin);
        restoreEnv('INDEXER_NETWORK', prevNetwork);
    }
}

// Put one env var back exactly as it was, including "was not set at all".
function restoreEnv(name, value) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

module.exports = { COINS, withCoin, processBlocks, forceXchainFeeMode };
