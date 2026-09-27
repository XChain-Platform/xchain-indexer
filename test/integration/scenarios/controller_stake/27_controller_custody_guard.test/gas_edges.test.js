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

// Exercise DEPOSIT custody guard gas edges above the CONTROLLER_CUSTODY_GUARD
// override with real MariaDB rows and the real isolated-vm guard.
// Keep every scenario block at or after the configured override time.

// Follow the scenario 25 harness model and seed through
// 27_controller_custody_guard.test/helpers/custody_rail.js.
// Use the shared seeder, indexer launcher, and database connection manager.

// Verify a GAS-less BTC SOURCE depositing a transfer-bound tick is refused before
// the guard runs, with no custody credit, SOURCE debit, or contract execution row.
// Expect the exact status 'invalid: insufficient funds (guard gas)'.

// Verify an unbound tick from an unbound SOURCE settles valid without changing its
// GAS balance because no controller resolves and no guard-gas reservation applies.
// Confirm the deposit still moves the requested token amount into custody.

// Supply TEST_DB values only when the integration venue does not use harness defaults.

// Override schema names when the venue requires dedicated test databases.

// Run against a disposable MariaDB integration venue:
// TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=<port> TEST_DB_USER=<u> TEST_DB_PASS=<pw> \
// TEST_DECODER_DB=cv_bt_decoder TEST_INDEXER_DB=cv_bt_indexer TEST_INDEXER_DB_B=cv_bt_indexer_b \

// Continue with the decoder schema and indexer network settings:
// XCHAIN_DECODER_SQL_PATH=<xchain-decoder/src/sql> INDEXER_COIN=BTC INDEXER_NETWORK=regtest \
// npx mocha --no-config --exit test/integration/scenarios/controller_stake/27_controller_custody_guard.test/gas_edges.test.js
'use strict';

const assert = require('assert');
const crypto = require('crypto');

// Load the guard VM eagerly so missing native support fails the suite.
require('xchain-vm');

const { createDatabases, createDecoderSchema, decoderQuery, indexerQuery,
        closeAll } = require('../../../setup/db-connection');
const DecoderSeeder = require('../../../setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer, destroyFileIndexers } = require('../../../setup/indexer-launcher');
const { seedGas, GAS_TICK } = require('../../../setup/gas-seeder');
const { ALLOW_GUARD, custodyAddress, depositLine, bindTokenLine,
        armCustodyGuardAt } = require('./helpers/custody_rail.js');

const OWNER        = 'msK1rsgNVFPM4cR3X5rngczTKa6EtT4WKD'; // issues tokens, deploys the guard, binds
const SOURCE_NOGAS = 'mjifPngDYQ6HHPNQdGk1kQuFkJWEiQksQp'; // holds BOUND, never seeded any GAS
const SOURCE_PLAIN = 'mn2YrLgFdvZ9MUK64a7TBn3ZVDKFo13b86'; // holds PLAIN, seeded GAS, never bound
const BOUND = 'CGE1'; // transfer-class bound to the ALLOW guard
const PLAIN = 'CGEP'; // no controller anywhere
const T0    = 1700000000;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

let seeder, indexer, contractIndex, custody, restoreCustodyGuard;

async function contractIndexByCode(code) {
    const h = sha(code);
    const rows = await indexerQuery('SELECT action_index, code_hash FROM contracts', []);
    const r = rows.find(x => x.code_hash === h);
    return r ? Number(r.action_index) : null;
}
async function balanceOf(address, tick) {
    const rows = await indexerQuery(
        `SELECT b.amount FROM balances b
         JOIN index_addresses ia ON ia.id = b.address_id
         JOIN index_tickers   it ON it.id = b.tick_id
         WHERE ia.address = ? AND it.tick = ?`, [address, tick]);
    return rows.length ? String(rows[0].amount) : '0';
}
async function latestDepositStatus(address, tick) {
    const rows = await indexerQuery(
        `SELECT s.status AS status FROM deposits d
         JOIN index_addresses ia ON ia.id = d.source_id
         JOIN index_tickers   it ON it.id = d.tick_id
         JOIN index_statuses  s  ON s.id = d.status_id
         WHERE ia.address = ? AND it.tick = ? ORDER BY d.action_index DESC LIMIT 1`, [address, tick]);
    return rows.length ? rows[0].status : null;
}
async function contractExecutionsCount() {
    const rows = await indexerQuery('SELECT COUNT(*) AS c FROM contract_executions', []);
    return Number(rows[0].c);
}

async function setupGasEdgeSuite() {
    process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
    process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';
    await createDatabases(__filename);
    await createDecoderSchema();
    seeder = new DecoderSeeder(decoderQuery);
    // Place the override at T0 so every scenario block runs above it.
    // Keep this file limited to behavior after activation.
    // Leave below-override cases to the neighboring deposit guard suite.
    restoreCustodyGuard = armCustodyGuardAt(T0);
    await seedGas(seeder, { addresses: [OWNER, SOURCE_PLAIN], amount: '10' });
    // Deploy the guard alongside issuance so its action index is available for binding.
    await seeder.seedBlock(100, T0, [
        { source: OWNER, data: `ISSUE|0|${BOUND}|100000|10000|0|gas edge bound|1000` },
        { source: OWNER, data: `ISSUE|0|${PLAIN}|100000|10000|0|gas edge plain|1000` },
        { source: OWNER, data: `DEPLOY|0|${Buffer.from(ALLOW_GUARD, 'utf8').toString('base64')}|300000|` },
    ]);
    indexer = await initIndexer();
    await processBlocks(indexer);
    contractIndex = await contractIndexByCode(ALLOW_GUARD);
    custody = custodyAddress('BTC', contractIndex);
    // Distribute the ticks before binding so these setup SENDs remain ungated.
    await seeder.seedBlock(101, T0 + 100, [
        { source: OWNER, data: `SEND|0|${BOUND}|500|${SOURCE_NOGAS}|seed-nogas` },
        { source: OWNER, data: `SEND|0|${PLAIN}|500|${SOURCE_PLAIN}|seed-plain` },
    ]);
    await processBlocks(indexer);
    // Bind only BOUND so PLAIN and both SOURCE addresses remain unbound.
    await seeder.seedBlock(102, T0 + 200, [
        { source: OWNER, data: bindTokenLine(BOUND, contractIndex, 'transfer', 'bind-bound-transfer') },
    ]);
    await processBlocks(indexer);
}
async function teardownGasEdgeSuite() {
    if (indexer) await destroyIndexer(indexer);
    await destroyFileIndexers(__filename);
    await closeAll();
    if (restoreCustodyGuard) restoreCustodyGuard();
}
async function testGasEdgeSetup() {
    assert.ok(contractIndex, 'the ALLOW guard deployed');
    assert.strictEqual(await balanceOf(SOURCE_NOGAS, BOUND), '500', 'SOURCE_NOGAS seeded with the bound tick');
    assert.strictEqual(await balanceOf(SOURCE_PLAIN, PLAIN), '500', 'SOURCE_PLAIN seeded with the plain tick');
    assert.strictEqual(await balanceOf(SOURCE_NOGAS, GAS_TICK), '0', 'SOURCE_NOGAS holds no GAS at all');
}

async function testGaslessBoundDepositRefused() {
    const beforeExecs = await contractExecutionsCount();
    await seeder.seedBlock(103, T0 + 300, [
        { source: SOURCE_NOGAS, data: depositLine(contractIndex, BOUND, '5') },
    ]);
    await processBlocks(indexer);
    assert.strictEqual(await latestDepositStatus(SOURCE_NOGAS, BOUND),
        'invalid: insufficient funds (guard gas)', 'refused before the guard ran');
    assert.strictEqual(await balanceOf(SOURCE_NOGAS, BOUND), '500', 'SOURCE balance untouched');
    assert.strictEqual(await balanceOf(custody, BOUND), '0', 'custody never credited');
    assert.strictEqual(await balanceOf(SOURCE_NOGAS, GAS_TICK), '0', 'still no GAS debited');
    assert.strictEqual(await contractExecutionsCount(), beforeExecs, 'no guard leg was written');
}

async function testUnboundDepositLeavesGasUnchanged() {
    const gasBefore = await balanceOf(SOURCE_PLAIN, GAS_TICK);
    const execsBefore = await contractExecutionsCount();
    await seeder.seedBlock(104, T0 + 400, [
        { source: SOURCE_PLAIN, data: depositLine(contractIndex, PLAIN, '5') },
    ]);
    await processBlocks(indexer);
    assert.strictEqual(await latestDepositStatus(SOURCE_PLAIN, PLAIN), 'valid', 'no controller anywhere: valid');
    assert.strictEqual(await balanceOf(SOURCE_PLAIN, PLAIN), '495', 'SOURCE debited the deposited amount');
    assert.strictEqual(await balanceOf(custody, PLAIN), '5', 'custody credited the deposited amount');
    assert.strictEqual(await balanceOf(SOURCE_PLAIN, GAS_TICK), gasBefore, 'GAS balance unchanged: no guard-gas reservation ran');
    assert.strictEqual(await contractExecutionsCount(), execsBefore, 'no guard ran for an unbound tick/address pair');
}

describe('Controller: DEPOSIT custody guard gas edges, above the override (real DB + real VM) @phaseE', function () {
    this.timeout(600000);
    before(setupGasEdgeSuite);
    after(teardownGasEdgeSuite);
    it('set up the bound/plain ticks, the guard and the distributions', testGasEdgeSetup);
    it('a GAS-less SOURCE depositing a bound tick is refused with no legs written', testGaslessBoundDepositRefused);
    it('an unbound tick from an unbound address settles valid and leaves GAS unchanged', testUnboundDepositLeavesGasUnchanged);
});
