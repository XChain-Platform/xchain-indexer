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
 ********************************************************************/
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const {
    createDatabases,
    createDecoderSchema,
    decoderQuery,
    indexerQuery,
    closeAll,
} = require('../../../setup/db-connection');
const DecoderSeeder = require('../../../setup/decoder-seeder');
const {
    initIndexer,
    processBlocks,
    destroyIndexer,
    destroyFileIndexers,
} = require('../../../setup/indexer-launcher');
const { seedGas } = require('../../../setup/gas-seeder');
const {
    ALLOW_GUARD,
    custodyAddress,
    depositLine,
    withdrawLine,
    bindTokenLine,
    bindAddressLine,
    armCustodyGuardAt,
} = require('./helpers/custody_rail.js');
const { sumMeteredFees } = require('./helpers/fee_sum.js');

const SOURCE = 'msK1rsgNVFPM4cR3X5rngczTKa6EtT4WKD';
const TICK = 'CGAL';
const T0 = 1700000000;
const ACTIVATION_TIME = T0 + 500;
const DEPOSIT_BLOCK = 102;
const WITHDRAW_BLOCK = 103;
const TARGET = "module.exports={ meta:{ name:'Custody Target', description:'Accepts deposits and permits owner withdrawal.', version:'1.0.0', ownerWithdraw:true }, noop:function(){} };";
const b64 = value => Buffer.from(value, 'utf8').toString('base64');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

let seeder;
let indexer;
let restoreCustodyGuard;
let allowIndex;
let targetIndex;
let gasBefore;

async function contractIndexByCode(code) {
    const codeHash = sha(code);
    const rows = await indexerQuery('SELECT action_index, code_hash FROM contracts', []);
    const row = rows.find(candidate => candidate.code_hash === codeHash);
    return row ? Number(row.action_index) : null;
}

async function balanceOf(address, tick) {
    const rows = await indexerQuery(
        `SELECT b.amount FROM balances b
         JOIN index_addresses ia ON ia.id = b.address_id
         JOIN index_tickers it ON it.id = b.tick_id
         WHERE ia.address = ? AND it.tick = ?`, [address, tick]);
    return rows.length ? String(rows[0].amount) : '0';
}

async function validCustodyRows() {
    return await indexerQuery(
        `SELECT 'DEPOSIT' AS action, ist.status FROM deposits d
         JOIN index_statuses ist ON ist.id = d.status_id
         WHERE d.block_index = ?
         UNION ALL
         SELECT 'WITHDRAW' AS action, ist.status FROM withdrawals w
         JOIN index_statuses ist ON ist.id = w.status_id
         WHERE w.block_index = ?
         ORDER BY action`, [DEPOSIT_BLOCK, WITHDRAW_BLOCK]);
}

async function guardExecutions() {
    return await indexerQuery(
        `SELECT block_index, gas_used, gas_used * ? AS metered_fee
         FROM contract_executions
         WHERE block_index IN (?, ?) AND method_name = 'guard'
         ORDER BY block_index`,
        [indexer.config.GAS_PRICE, DEPOSIT_BLOCK, WITHDRAW_BLOCK]);
}

function billedGuardRuns(executions) {
    return executions.flatMap(row => [row, row]);
}

async function seedScenario() {
    seeder = new DecoderSeeder(decoderQuery);
    await seedGas(seeder, { addresses: [SOURCE], amount: '1000' });
    await seeder.seedBlock(100, T0, [
        { source: SOURCE, data: `ISSUE|0|${TICK}|1000|1000|0|custody allow token|1000` },
        { source: SOURCE, data: `DEPLOY|0|${b64(ALLOW_GUARD)}|300000|` },
        { source: SOURCE, data: `DEPLOY|0|${b64(TARGET)}|300000|` },
    ]);
    indexer = await initIndexer();
    await processBlocks(indexer);
    allowIndex = await contractIndexByCode(ALLOW_GUARD);
    targetIndex = await contractIndexByCode(TARGET);
}

async function bindAllowControllers() {
    await seeder.seedBlock(101, T0 + 100, [
        { source: SOURCE, data: bindTokenLine(TICK, allowIndex, 'all', 'bind-token-allow') },
        { source: SOURCE, data: bindAddressLine(allowIndex, 'all', 'bind-source-allow') },
    ]);
    await processBlocks(indexer);
    gasBefore = await balanceOf(SOURCE, indexer.config.GAS);
}

async function setupSuite() {
    try { require('xchain-vm'); } catch (error) { return this.skip(); }
    process.env.INDEXER_COIN = process.env.INDEXER_COIN || 'BTC';
    process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';
    restoreCustodyGuard = armCustodyGuardAt(ACTIVATION_TIME);
    await createDatabases(__filename);
    await createDecoderSchema();
    await seedScenario();
    await bindAllowControllers();
}

async function teardownSuite() {
    try {
        if(indexer) await destroyIndexer(indexer);
        await destroyFileIndexers(__filename);
        await closeAll();
    } finally {
        if(restoreCustodyGuard) restoreCustodyGuard();
    }
}

async function testSetup() {
    assert.ok(allowIndex, 'allow guard deployed');
    assert.ok(targetIndex, 'custody target deployed');
    assert.strictEqual(await balanceOf(SOURCE, TICK), '1000');
}

async function testAllowedDeposit() {
    const custody = custodyAddress(indexer.config.CHAIN, targetIndex);
    await seeder.seedBlock(DEPOSIT_BLOCK, T0 + 1000, [
        { source: SOURCE, data: depositLine(targetIndex, TICK, 40) },
    ]);
    assert.strictEqual(await processBlocks(indexer), 1);
    assert.strictEqual(await balanceOf(SOURCE, TICK), '960');
    assert.strictEqual(await balanceOf(custody, TICK), '40');
}

async function testAllowedWithdrawalAndGas() {
    const custody = custodyAddress(indexer.config.CHAIN, targetIndex);
    await seeder.seedBlock(WITHDRAW_BLOCK, T0 + 1100, [
        { source: SOURCE, data: withdrawLine(targetIndex, TICK, 15) },
    ]);
    assert.strictEqual(await processBlocks(indexer), 1);
    assert.strictEqual(await balanceOf(SOURCE, TICK), '975');
    assert.strictEqual(await balanceOf(custody, TICK), '25');

    const custodyRows = await validCustodyRows();
    assert.deepStrictEqual(custodyRows.map(row => [row.action, row.status]), [
        ['DEPOSIT', 'valid'],
        ['WITHDRAW', 'valid'],
    ]);

    const executions = await guardExecutions();
    assert.strictEqual(executions.length, 2, 'one shared guard execution row persisted per custody leg');
    assert.ok(executions.every(row => Number(row.gas_used) > 0), 'both persisted guard meters are nonzero');
    const gasAfter = await balanceOf(SOURCE, indexer.config.GAS);
    const gasBurn = Number(indexer.util.bcsub(gasBefore, gasAfter, 8));
    assert.strictEqual(gasBurn, sumMeteredFees(billedGuardRuns(executions)));
}

describe('Controller custody guard ALLOW legs and metered GAS burn', function () {
    this.timeout(600000);
    before(setupSuite);
    after(teardownSuite);
    it('sets up the allow controller and owner-withdrawable custody target', testSetup);
    it('allows an all-bound deposit above the custody-guard activation', testAllowedDeposit);
    it('allows an all-bound withdrawal and burns the sum of all metered guard runs', testAllowedWithdrawalAndGas);
});
