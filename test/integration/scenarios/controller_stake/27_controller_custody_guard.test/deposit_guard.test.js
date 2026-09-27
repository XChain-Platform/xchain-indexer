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
 * Integration: DEPOSIT is gated by the CONTROLLER_CUSTODY_GUARD flag day (real MariaDB +
 * real isolated-vm guard).
 *
 * Before the flag day a bound transfer-class controller (on the deposited tick, or on the
 * depositor's own address) has no effect on DEPOSIT: the custody leg does not yet consult
 * it. From the flag day on, DEPOSIT runs both the token's and the SOURCE address's
 * transfer-class guard before moving funds into custody, so either bound DENY reverts it.
 * Proves, over real DB rows + a real guard VM:
 *   1. Below the flag day, a deposit of a transfer-class DENY-bound tick still commits.
 *   2. Below the flag day, a deposit from a depositor whose OWN address is bound to a
 *      transfer-class DENY controller (ADDRESS v1) still commits.
 *   3. Above the flag day, re-depositing the DENY-bound tick is refused; custody and the
 *      depositor's balance are unchanged.
 *   4. Above the flag day, the address-bound depositor's repeat deposit is refused the
 *      same way.
 *
 * Run (disposable MariaDB, e.g. the integration venue):
 *   TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=<port> TEST_DB_USER=<u> TEST_DB_PASS=<pw> \
 *   TEST_DECODER_DB=cv_dg_decoder TEST_INDEXER_DB=cv_dg_indexer TEST_INDEXER_DB_B=cv_dg_indexer_b \
 *   XCHAIN_DECODER_SQL_PATH=<xchain-decoder/src/sql> INDEXER_COIN=BTC INDEXER_NETWORK=regtest \
 *   npx mocha --no-config --exit test/integration/scenarios/controller_stake/27_controller_custody_guard.test/deposit_guard.test.js
 ********************************************************************/
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { createDatabases, createDecoderSchema, decoderQuery, indexerQuery,
        closeAll } = require('../../../setup/db-connection');
const DecoderSeeder = require('../../../setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer, destroyFileIndexers } = require('../../../setup/indexer-launcher');
const { seedGas } = require('../../../setup/gas-seeder');
const {
    DENY_GUARD, custodyAddress, depositLine, bindTokenLine, bindAddressLine, armCustodyGuardAt,
} = require('./helpers/custody_rail.js');

const OWNER       = 'msK1rsgNVFPM4cR3X5rngczTKa6EtT4WKD'; // issues tokens, deploys contracts, binds the tick
const DEPOSITOR_A = 'mjifPngDYQ6HHPNQdGk1kQuFkJWEiQksQp'; // holds the DENY-bound tick
const DEPOSITOR_B = 'mn2YrLgFdvZ9MUK64a7TBn3ZVDKFo13b86'; // self-binds an ADDRESS v1 transfer DENY
const CGD1        = 'CGD1'; // token-level transfer DENY controller
const CGDP        = 'CGDP'; // no token controller; DEPOSITOR_B's address is DENY-bound instead
const T0          = 1700000000;
const OVERRIDE_TIME = T0 + 10000; // CONTROLLER_CUSTODY_GUARD arms here

const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

// A no-op contract, distinct from the guard, used purely as the DEPOSIT custody target.
// CONTRACT_META_REQUIRED is genesis-active on regtest, so it carries `meta`.
const VAULT_CODE = "module.exports={ meta:{ name:'Vault', description:'Deposit target used by the custody guard drill.', version:'1.0.0' }, ping:function(){ return 'ok'; } };";

let seeder, indexer, restoreGuard, denyIdx, vaultIdx;

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

async function setupCustodyGuardSuite() {
    try { require('xchain-vm'); } catch (e) { return this.skip(); }
    process.env.INDEXER_COIN    = 'BTC';
    process.env.INDEXER_NETWORK = 'regtest';
    restoreGuard = armCustodyGuardAt(OVERRIDE_TIME);
    await createDatabases(__filename);
    await createDecoderSchema();
    seeder = new DecoderSeeder(decoderQuery);
    await seedGas(seeder, { addresses: [OWNER, DEPOSITOR_A, DEPOSITOR_B], amount: '1000' });
    // Block 100 (below the flag day): issue both tokens and deploy the guard + vault.
    await seeder.seedBlock(100, T0, [
        { source: OWNER, data: `ISSUE|0|${CGD1}|100000|10000|0|deny-bound custody tick|1000` },
        { source: OWNER, data: `ISSUE|0|${CGDP}|100000|10000|0|plain custody tick|1000` },
        { source: OWNER, data: `DEPLOY|0|${b64(DENY_GUARD)}|300000|` },
        { source: OWNER, data: `DEPLOY|0|${b64(VAULT_CODE)}|300000|` },
    ]);
    indexer = await initIndexer();
    await processBlocks(indexer);
    denyIdx  = await contractIndexByCode(DENY_GUARD);
    vaultIdx = await contractIndexByCode(VAULT_CODE);
    // Block 101: distribute the tokens to the two depositors before either bind.
    await seeder.seedBlock(101, T0 + 100, [
        { source: OWNER, data: `SEND|0|${CGD1}|300|${DEPOSITOR_A}|seed-a` },
        { source: OWNER, data: `SEND|0|${CGDP}|300|${DEPOSITOR_B}|seed-b` },
    ]);
    await processBlocks(indexer);
    // Block 102: bind CGD1's transfer class to DENY, and DEPOSITOR_B self-binds the same.
    await seeder.seedBlock(102, T0 + 200, [
        { source: OWNER,       data: bindTokenLine(CGD1, denyIdx, 'transfer', 'bind-tick-deny') },
        { source: DEPOSITOR_B, data: bindAddressLine(denyIdx, 'transfer', 'bind-addr-deny') },
    ]);
    await processBlocks(indexer);
}
async function teardownCustodyGuardSuite() {
    if (indexer) await destroyIndexer(indexer);
    await destroyFileIndexers(__filename);
    await closeAll();
    if (restoreGuard) restoreGuard();
}

async function testSuiteSetup() {
    assert.ok(denyIdx,  'deny guard deployed');
    assert.ok(vaultIdx, 'vault contract deployed');
    assert.strictEqual(await balanceOf(DEPOSITOR_A, CGD1), '300', 'DEPOSITOR_A seeded with the DENY-bound tick');
    assert.strictEqual(await balanceOf(DEPOSITOR_B, CGDP), '300', 'DEPOSITOR_B seeded with the plain tick');
}

// --- below the CONTROLLER_CUSTODY_GUARD flag day: both binds are inert on DEPOSIT ---
async function testBelowOverrideDeposits() {
    const vault = custodyAddress('BTC', vaultIdx);
    await seeder.seedBlock(103, T0 + 300, [
        { source: DEPOSITOR_A, data: depositLine(vaultIdx, CGD1, 50) },
        { source: DEPOSITOR_B, data: depositLine(vaultIdx, CGDP, 50) },
    ]);
    await processBlocks(indexer);
    assert.strictEqual(await balanceOf(DEPOSITOR_A, CGD1), '250',
        'below the flag day, a deposit of the DENY-bound tick still commits (bypass witness)');
    assert.strictEqual(await balanceOf(vault, CGD1), '50', 'the custody address received the DENY-bound tick');
    assert.strictEqual(await balanceOf(DEPOSITOR_B, CGDP), '250',
        'below the flag day, the DENY-bound depositor\'s deposit still commits (bypass witness)');
    assert.strictEqual(await balanceOf(vault, CGDP), '50', 'the custody address received the address-bound depositor\'s tick');
}

// --- above the flag day: the token-level DENY on CGD1 reverts a repeat deposit ---
async function testAboveOverrideDenyTickDeposit() {
    const vault = custodyAddress('BTC', vaultIdx);
    await seeder.seedBlock(104, OVERRIDE_TIME + 10000, [
        { source: DEPOSITOR_A, data: depositLine(vaultIdx, CGD1, 25) },
    ]);
    await processBlocks(indexer);
    assert.strictEqual(await balanceOf(DEPOSITOR_A, CGD1), '250',
        'above the flag day, the transfer-class DENY on the tick reverts the deposit');
    assert.strictEqual(await balanceOf(vault, CGD1), '50', 'custody balance unchanged by the denied deposit');
}

// --- above the flag day: DEPOSITOR_B's own ADDRESS v1 DENY reverts a repeat deposit ---
async function testAboveOverrideDenyAddressDeposit() {
    const vault = custodyAddress('BTC', vaultIdx);
    await seeder.seedBlock(105, OVERRIDE_TIME + 10100, [
        { source: DEPOSITOR_B, data: depositLine(vaultIdx, CGDP, 25) },
    ]);
    await processBlocks(indexer);
    assert.strictEqual(await balanceOf(DEPOSITOR_B, CGDP), '250',
        'above the flag day, the depositor\'s own transfer-class DENY reverts the deposit');
    assert.strictEqual(await balanceOf(vault, CGDP), '50', 'custody balance unchanged by the denied deposit');
}

describe('Controller: DEPOSIT gated by CONTROLLER_CUSTODY_GUARD (real DB + real VM) @phaseE', function () {
    this.timeout(600000);
    before(setupCustodyGuardSuite);
    after(teardownCustodyGuardSuite);
    it('set up tokens, guard, vault, distributions, and both binds', testSuiteSetup);
    it('below the flag day, a DENY-bound tick and a DENY-bound depositor both deposit', testBelowOverrideDeposits);
    it('above the flag day, the DENY-bound tick refuses a repeat deposit', testAboveOverrideDenyTickDeposit);
    it('above the flag day, the DENY-bound depositor refuses a repeat deposit', testAboveOverrideDenyAddressDeposit);
});
