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

// Exercise post-activation withdrawal denials for balances deposited before the custody guard.
// Verify both token and owner-address transfer controllers with MariaDB and the real guard VM.

'use strict';

const assert = require('assert');
const crypto = require('crypto');

require('xchain-vm');

const { createDatabases, createDecoderSchema, decoderQuery, indexerQuery,
        closeAll } = require('../../../setup/db-connection');
const DecoderSeeder = require('../../../setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer, destroyFileIndexers } = require('../../../setup/indexer-launcher');
const { seedGas } = require('../../../setup/gas-seeder');
const {
    DENY_GUARD, custodyAddress, depositLine, withdrawLine, bindTokenLine,
    bindAddressLine, armCustodyGuardAt,
} = require('./helpers/custody_rail.js');

const OWNER_A = 'msK1rsgNVFPM4cR3X5rngczTKa6EtT4WKD';
const OWNER_B = 'mn2YrLgFdvZ9MUK64a7TBn3ZVDKFo13b86';
const BOUND = 'CGW1';
const PLAIN = 'CGWP';
const T0 = 1700000000;
const OVERRIDE_TIME = T0 + 1000;
const b64 = value => Buffer.from(value, 'utf8').toString('base64');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

const VAULT_A = "module.exports={ meta:{ name:'Vault A', description:'Token-controller withdrawal target.', version:'1.0.0', ownerWithdraw:true }, ping:function(){ return 'a'; } };";
const VAULT_B = "module.exports={ meta:{ name:'Vault B', description:'Address-controller withdrawal target.', version:'1.0.0', ownerWithdraw:true }, ping:function(){ return 'b'; } };";

let seeder, indexer, restoreCustodyGuard, denyIndex, vaultAIndex, vaultBIndex;

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

async function latestWithdrawalStatus(source, tick, contractIndex) {
    const rows = await indexerQuery(
        `SELECT s.status FROM withdrawals w
         JOIN index_addresses ia ON ia.id = w.source_id
         JOIN index_tickers it ON it.id = w.tick_id
         JOIN index_statuses s ON s.id = w.status_id
         WHERE ia.address = ? AND it.tick = ? AND w.contract_index = ?
         ORDER BY w.action_index DESC LIMIT 1`, [source, tick, contractIndex]);
    return rows.length ? rows[0].status : null;
}

async function seedContractsAndTicks() {
    await seedGas(seeder, { addresses: [OWNER_A, OWNER_B], amount: '1000' });
    await seeder.seedBlock(100, T0, [
        { source: OWNER_A, data: `ISSUE|0|${BOUND}|100000|10000|0|bound custody tick|1000` },
        { source: OWNER_B, data: `ISSUE|0|${PLAIN}|100000|10000|0|plain custody tick|1000` },
        { source: OWNER_A, data: `DEPLOY|0|${b64(DENY_GUARD)}|300000|` },
        { source: OWNER_A, data: `DEPLOY|0|${b64(VAULT_A)}|300000|` },
        { source: OWNER_B, data: `DEPLOY|0|${b64(VAULT_B)}|300000|` },
    ]);
    indexer = await initIndexer();
    await processBlocks(indexer);
    denyIndex = await contractIndexByCode(DENY_GUARD);
    vaultAIndex = await contractIndexByCode(VAULT_A);
    vaultBIndex = await contractIndexByCode(VAULT_B);
}

async function depositBeforeActivation() {
    await seeder.seedBlock(101, T0 + 100, [
        { source: OWNER_A, data: depositLine(vaultAIndex, BOUND, 40) },
        { source: OWNER_B, data: depositLine(vaultBIndex, PLAIN, 60) },
    ]);
    await processBlocks(indexer);
    await seeder.seedBlock(102, T0 + 200, [
        { source: OWNER_A, data: bindTokenLine(BOUND, denyIndex, 'transfer', 'bind-withdraw-deny') },
    ]);
    await processBlocks(indexer);
}

async function setupWithdrawGuardSuite() {
    process.env.INDEXER_COIN = process.env.INDEXER_COIN || 'BTC';
    process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';
    restoreCustodyGuard = armCustodyGuardAt(OVERRIDE_TIME);
    await createDatabases(__filename);
    await createDecoderSchema();
    seeder = new DecoderSeeder(decoderQuery);
    await seedContractsAndTicks();
    await depositBeforeActivation();
}

async function teardownWithdrawGuardSuite() {
    if (indexer) await destroyIndexer(indexer);
    await destroyFileIndexers(__filename);
    await closeAll();
    if (restoreCustodyGuard) restoreCustodyGuard();
}

async function testDepositedBalances() {
    assert.ok(denyIndex, 'the DENY guard deployed');
    assert.ok(vaultAIndex, 'the first vault deployed');
    assert.ok(vaultBIndex, 'the second vault deployed');
    assert.strictEqual(await balanceOf(custodyAddress('BTC', vaultAIndex), BOUND), '40',
        'the bound tick entered custody before activation');
    assert.strictEqual(await balanceOf(custodyAddress('BTC', vaultBIndex), PLAIN), '60',
        'the plain tick entered the second contract custody before activation');
}

async function testNoGrandfatherWithdrawal() {
    const custody = custodyAddress('BTC', vaultAIndex);
    const ownerBefore = await balanceOf(OWNER_A, BOUND);
    await seeder.seedBlock(103, OVERRIDE_TIME + 100, [
        { source: OWNER_A, data: withdrawLine(vaultAIndex, BOUND, 40) },
    ]);
    await processBlocks(indexer);
    assert.strictEqual(await latestWithdrawalStatus(OWNER_A, BOUND, vaultAIndex),
        'invalid: controller (reverted)', 'the later token binding denies the earlier custody balance');
    assert.strictEqual(await balanceOf(custody, BOUND), '40', 'denied withdrawal leaves custody unchanged');
    assert.strictEqual(await balanceOf(OWNER_A, BOUND), ownerBefore, 'denied withdrawal does not credit the owner');
}

async function testAddressBoundWithdrawal() {
    const custody = custodyAddress('BTC', vaultBIndex);
    await seeder.seedBlock(104, OVERRIDE_TIME + 200, [
        { source: OWNER_B, data: bindAddressLine(denyIndex, 'transfer', 'bind-owner-deny') },
    ]);
    await processBlocks(indexer);
    const ownerBefore = await balanceOf(OWNER_B, PLAIN);
    await seeder.seedBlock(105, OVERRIDE_TIME + 300, [
        { source: OWNER_B, data: withdrawLine(vaultBIndex, PLAIN, 60) },
    ]);
    await processBlocks(indexer);
    assert.strictEqual(await latestWithdrawalStatus(OWNER_B, PLAIN, vaultBIndex),
        'invalid: controller (reverted)', 'the owner address transfer controller denies the withdrawal');
    assert.strictEqual(await balanceOf(custody, PLAIN), '60', 'address denial leaves custody unchanged');
    assert.strictEqual(await balanceOf(OWNER_B, PLAIN), ownerBefore, 'address denial does not credit the owner');
}

describe('Controller: WITHDRAW gated by CONTROLLER_CUSTODY_GUARD (real DB + real VM) @phaseE', function () {
    this.timeout(600000);
    before(setupWithdrawGuardSuite);
    after(teardownWithdrawGuardSuite);
    it('deposits both custody balances before activation and binds the first tick later', testDepositedBalances);
    it('does not grandfather an earlier custody balance against a later token denial', testNoGrandfatherWithdrawal);
    it('lets a second contract owner bind its address and deny a plain-tick withdrawal', testAddressBoundWithdrawal);
});
