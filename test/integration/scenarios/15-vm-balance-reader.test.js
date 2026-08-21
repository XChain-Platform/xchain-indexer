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
 * Integration test: db.buildVmBalancesAndTokenInfo, the loader that backs the
 * VM gateway's xchain.getBalance(address, tick) and xchain.getTokenInfo(tick).
 *
 * Before this wiring the EXECUTE/DEPLOY paths passed `balances: null` /
 * `tokenInfo: null`, so a contract could never read what it held (the blocker
 * for every value-custody contract: escrow, vesting, AMM, ...). This test pins
 * the loader's two responsibilities directly (the harness runs VM-less, so the
 * full DEPOSIT->EXECUTE->getBalance flow lives in the regtest e2e):
 *
 *   1. SHAPE: re-keys the indexer's flat { tick_id: amount } into the nested,
 *      SYMBOL-keyed { address: { tickSymbol: amount } } the gateway consumes,
 *      and loads { tickSymbol: tokenInfo } for every referenced tick.
 *   2. PRE-ACTION BOUND (determinism): balances reflect state strictly BEFORE
 *      the passed action_index (a contract sees what it held going in; its own
 *      mid-execution emissions are not yet persisted), identical on every node.
 *
 * Run with the disposable test DB (handoff runbook), Node 22:
 *   TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=13307 TEST_DB_USER=root TEST_DB_PASS=mvhtest \
 *   INDEXER_COIN=BTC INDEXER_NETWORK=regtest \
 *   npx mocha test/integration/scenarios/15-vm-balance-reader.test.js
 */

'use strict';

const assert = require('assert');
const { decoderQuery, indexerQuery,
        createDatabases, createDecoderSchema,
        resetDecoderDb, resetIndexerDb, closeAll } = require('../setup/db-connection');
const DecoderSeeder = require('../setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer, destroyFileIndexers } = require('../setup/indexer-launcher');
const { getLastActionIndexByType } = require('../setup/assertion-helpers');
const { seedGas } = require('../setup/gas-seeder');

const ADDR1 = 'msK1rsgNVFPM4cR3X5rngczTKa6EtT4WKD'; // issuer
const ADDR2 = 'mjifPngDYQ6HHPNQdGk1kQuFkJWEiQksQp'; // recipient (stands in for any held address)
const NOBODY = 'mvQLUzhdrR1gGQmHLkMy62Y86o6ahgRo8h'; // never holds anything
const T0  = 1700000000;
const BLK = 600;
const HIGH_ACTION = 999999999; // action_index ceiling: `< ?` includes every prior action

describe('VM ledger-read loader: buildVmBalancesAndTokenInfo @regression @tier2', function () {
    this.timeout(240000); // cold-DB schema creation (verifyTables builds ~60 tables) needs headroom

    before(async function () {
        this.timeout(30000);
        process.env.INDEXER_COIN    = 'BTC';
        process.env.INDEXER_NETWORK = 'regtest';
        await createDatabases(__filename);
        await createDecoderSchema();
    });

    after(async function () {
        await destroyFileIndexers(__filename);
        await closeAll();
    });

    beforeEach(async function () {
        this.timeout(15000);
        await resetDecoderDb();
        await resetIndexerDb();
    });

    it('re-keys to nested symbol-keyed balances + loads tokenInfo, bounded by action_index', async function () {
        const seeder = new DecoderSeeder(decoderQuery);

        // Fee era: ISSUE + SEND draw gas from the issuer's XCHAIN balance.
        await seedGas(seeder, { addresses: [ADDR1, ADDR2] });

        // ISSUE TOK (decimals 8) minting 1000 to ADDR1, then SEND 300 to ADDR2.
        // ISSUE|0|TICK|MAX_SUPPLY|MAX_MINT|DECIMALS|DESCRIPTION|MINT_SUPPLY
        await seeder.seedBlock(100, T0, [
            { source: ADDR1, destination: null, amount: '0',
              data: 'ISSUE|0|TOK|1000|1000|8|vm balance reader token|1000' },
        ]);
        await seeder.seedBlock(101, T0 + BLK, [
            { source: ADDR1, destination: ADDR2, amount: '0',
              data: 'SEND|0|TOK|300|' + ADDR2 },
        ]);

        const indexer = await initIndexer();
        try {
            await processBlocks(indexer);
            const db = indexer.indexerDb;

            // The SEND's action_index: the bound that should EXCLUDE the SEND credit.
            const sendIdx = await getLastActionIndexByType(indexerQuery, 'SEND');
            assert.ok(sendIdx !== null, 'SEND action_index should exist');

            // ---- 1. SHAPE: post-state, both addresses, nested + symbol-keyed ----
            const post = await db.buildVmBalancesAndTokenInfo([ADDR1, ADDR2], 200, HIGH_ACTION);

            assert.ok(post.balances[ADDR1], 'ADDR1 bucket present');
            assert.ok(post.balances[ADDR2], 'ADDR2 bucket present');
            assert.strictEqual(Number(post.balances[ADDR1].TOK), 700, 'ADDR1 holds 700 TOK');
            assert.strictEqual(Number(post.balances[ADDR2].TOK), 300, 'ADDR2 holds 300 TOK');

            // tokenInfo is symbol-keyed and carries the metadata a contract reads.
            assert.ok(post.tokenInfo.TOK, 'tokenInfo[TOK] present');
            assert.strictEqual(post.tokenInfo.TOK.TICK, 'TOK', 'tokenInfo carries the symbol');
            assert.strictEqual(Number(post.tokenInfo.TOK.DECIMALS), 8, 'decimals round-trip');

            // ---- 2. PRE-ACTION BOUND: at the SEND's own index the credit is unseen ----
            const atSend = await db.buildVmBalancesAndTokenInfo([ADDR2], 200, sendIdx);
            assert.ok(atSend.balances[ADDR2], 'ADDR2 bucket present even when empty');
            assert.strictEqual(atSend.balances[ADDR2].TOK, undefined,
                'action_index < sendIdx must EXCLUDE the SEND credit (pre-action state)');

            // ---- 3. Unknown address resolves to an empty bucket (gateway -> null) ----
            const none = await db.buildVmBalancesAndTokenInfo([NOBODY], 200, HIGH_ACTION);
            assert.deepStrictEqual(none.balances[NOBODY], {}, 'unknown address has no balances');
            assert.deepStrictEqual(none.tokenInfo, {}, 'no tokenInfo without referenced ticks');

            // ---- 4. Null entries are skipped, not crashed on ----
            const withNull = await db.buildVmBalancesAndTokenInfo([null, ADDR1, undefined], 200, HIGH_ACTION);
            assert.strictEqual(Number(withNull.balances[ADDR1].TOK), 700, 'null/undefined addresses skipped');
        } finally {
            await destroyIndexer(indexer);
        }
    });
});
