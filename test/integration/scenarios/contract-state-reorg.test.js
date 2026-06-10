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
 * Integration test — Reorg rollback of CONTRACT state
 *
 * The existing 05-reorg scenarios only exercise ISSUE/MINT/SEND. rollback.js DOES delete
 * the contract tables (contracts, contract_stakes, deposits, …) and reverse the
 * contract-balance ledger, but nothing tested it — so a regression there would silently
 * corrupt contract state across a reorg. This covers that gap:
 *
 *   Phase 1 — ISSUE a token, DEPLOY v1 a (stakeable) contract; read its action_index.
 *   Phase 2 — DEPOSIT the token into the contract and STAKE v3 the token against it.
 *   Phase 3 — reorg below the DEPLOY block; assert every contract row is gone and the
 *             deployer's token balance is fully restored (deposit + stake debits reversed).
 *
 * Note: EXECUTE (and thus contract_state / contract_emissions) is NOT exercised here —
 * xchain-vm isn't resolvable in the integration env, so contract code can't run. DEPLOY,
 * DEPOSIT and STAKE v3 don't need the VM, so this still covers the contracts /
 * contract_stakes / deposits / contract-balance rollback paths. Their rollback
 * shares the same block-scoped DELETE in rollback.js, so the EXECUTE-produced tables roll
 * back by the same mechanism.
 */

const assert = require('assert');
const {
    decoderQuery, indexerQuery,
    createDatabases, createDecoderSchema,
    resetDecoderDb, resetIndexerDb, closeAll,
} = require('../setup/db-connection');
const DecoderSeeder = require('../setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer } = require('../setup/indexer-launcher');
const helpers = require('../setup/assertion-helpers');

const DEPLOYER = 'n391LfrxqfPYEdeLqB1QgHUubTjkPbmZ19';
const PUBKEY   = 'ab'.repeat(32); // 64-hex signing pubkey for STAKE v3
const T0  = 1700000000;
const BLK = 600;

// Trivial contract — never executed here (no VM); just needs to hex-decode under the size
// cap. DEPLOY's syntax check is skipped when the VM is unavailable.
const CODE_HEX = Buffer.from('module.exports={ping:function(){return "ok";}};', 'utf8').toString('hex');

async function deleteDecoderBlocksFrom(blockIndex) {
    await decoderQuery(
        'DELETE FROM transaction_outputs WHERE tx_index IN ' +
        '(SELECT tx_index FROM transactions WHERE block_index >= ?)', [blockIndex]);
    await decoderQuery('DELETE FROM transactions WHERE block_index >= ?', [blockIndex]);
    await decoderQuery('DELETE FROM blocks WHERE block_index >= ?', [blockIndex]);
}

async function countRows(table) {
    const rows = await indexerQuery(`SELECT COUNT(*) AS c FROM ${table}`);
    return Number(rows[0].c);
}

describe('Contract State Reorg — rollback of contract tables @regression @tier3', function () {
    this.timeout(60000);

    before(async function () {
        this.timeout(30000);
        await createDatabases();
        await createDecoderSchema();
    });

    after(async function () {
        await closeAll();
    });

    beforeEach(async function () {
        this.timeout(15000);
        await resetDecoderDb();
        await resetIndexerDb();
    });

    it('reorg below a DEPLOY clears contracts / stakes / deposits and restores balances', async function () {
        const seeder = new DecoderSeeder(decoderQuery);

        // Phase 1 — ISSUE the token to the deployer, then DEPLOY a stakeable (v1) contract.
        await seeder.seedBlock(100, T0, [
            { source: DEPLOYER, destination: null, amount: '0',
              data: 'ISSUE|0|CTRT|1000|1000|0|contract reorg token|1000' },
        ]);
        await seeder.seedBlock(101, T0 + BLK, [
            // DEPLOY|1|CODE|GAS_LIMIT|CONSTRUCTOR|COOLDOWN_BLOCKS|SLASH_DESTINATION
            { source: DEPLOYER, destination: null, amount: '0',
              data: 'DEPLOY|1|' + CODE_HEX + '|100000||100|' },
        ]);

        let indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        await helpers.assertTokenSupply(indexerQuery, 'CTRT', '1000');
        assert.strictEqual(await countRows('contracts'), 1, 'contract should exist after DEPLOY');
        const ci = Number((await indexerQuery('SELECT action_index FROM contracts LIMIT 1'))[0].action_index);

        // Phase 2 — DEPOSIT into the contract and STAKE v3 the token against it.
        await seeder.seedBlock(102, T0 + BLK * 2, [
            { source: DEPLOYER, destination: null, amount: '0',
              data: 'DEPOSIT|0|' + ci + '|CTRT|100' },
            { source: DEPLOYER, destination: null, amount: '0',
              data: 'STAKE|3|200|' + PUBKEY + '|' + ci + '|CTRT' },
        ]);

        indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        // Pre-reorg: all contract rows present, and the deployer's 1000 has been drawn down
        // by the 100 deposit + 200 stake (300 escrowed into the contract / stake).
        assert.strictEqual(await countRows('deposits'), 1, 'deposit row should exist');
        assert.strictEqual(await countRows('contract_stakes'), 1, 'stake row should exist');
        await helpers.assertBalance(indexerQuery, DEPLOYER, 'CTRT', '700');

        // Phase 3 — reorg at block 101 (removes the DEPLOY and everything after).
        await seeder.seedReorgEvent([101]);
        await deleteDecoderBlocksFrom(101);
        await seeder.seedBlock(101, T0 + BLK, []); // benign empty replacement block

        indexer = await initIndexer();
        await processBlocks(indexer);
        await destroyIndexer(indexer);

        // Every contract row must be gone, and the deployer's balance fully restored.
        assert.strictEqual(await countRows('contracts'), 0, 'contracts cleared by reorg');
        assert.strictEqual(await countRows('contract_stakes'), 0, 'contract_stakes cleared by reorg');
        assert.strictEqual(await countRows('deposits'), 0, 'deposits cleared by reorg');
        await helpers.assertBalance(indexerQuery, DEPLOYER, 'CTRT', '1000');
    });
});
