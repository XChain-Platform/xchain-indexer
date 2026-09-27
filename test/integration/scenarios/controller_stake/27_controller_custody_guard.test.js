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

assert.ok(process.env.TEST_DB_PASS, 'TEST_DB_PASS is required for the real MariaDB integration');
require('xchain-vm');

const T0 = 1700000000;
const ACTIVATION_TIME = T0 + 500;
const POST_FIRST = 102;
const SOURCE = 'msK1rsgNVFPM4cR3X5rngczTKa6EtT4WKD';
const TICK = 'CGRG';
const TARGET = "module.exports={ meta:{ name:'Replay Vault', description:'Holds guarded replay deposits.', version:'1.0.0', ownerWithdraw:true }, ping:function(){ return 'ok'; } };";

const {
    ALLOW_GUARD,
    custodyAddress,
    depositLine,
    withdrawLine,
    bindTokenLine,
    bindAddressLine,
    armCustodyGuardAt,
} = require('./27_controller_custody_guard.test/helpers/custody_rail.js');

const priorCoin = process.env.INDEXER_COIN;
const priorNetwork = process.env.INDEXER_NETWORK;
process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';
const restoreCustodyGuard = armCustodyGuardAt(ACTIVATION_TIME);

const {
    createDatabases,
    createDecoderSchema,
    decoderQuery,
    indexerQuery,
    closeAll,
} = require('../../setup/db-connection');
const DecoderSeeder = require('../../setup/decoder-seeder');
const {
    initIndexer,
    processBlocks,
    destroyIndexer,
    destroyFileIndexers,
} = require('../../setup/indexer-launcher');
const { seedGas } = require('../../setup/gas-seeder');
const { deleteDecoderBlocksFrom } = require('../core/05_reorg.test/helpers/reorg_chain');

const b64 = value => Buffer.from(value, 'utf8').toString('base64');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

let seeder;
let indexer;
let allowIndex;
let targetIndex;
let custody;
let expectedSnapshot;

function restoreEnv(name, prior) {
    if (prior === undefined) delete process.env[name];
    else process.env[name] = prior;
}

async function contractIndexByCode(code) {
    const rows = await indexerQuery('SELECT action_index, code_hash FROM contracts', []);
    const row = rows.find(candidate => candidate.code_hash === sha(code));
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

async function custodyStatuses() {
    return await indexerQuery(
        `SELECT a.block_index, s.status
         FROM deposits d
         JOIN actions a ON a.action_index = d.action_index
         JOIN index_statuses s ON s.id = d.status_id
         WHERE a.block_index >= ?
         UNION ALL
         SELECT a.block_index, s.status
         FROM withdrawals w
         JOIN actions a ON a.action_index = w.action_index
         JOIN index_statuses s ON s.id = w.status_id
         WHERE a.block_index >= ?
         ORDER BY block_index`, [POST_FIRST, POST_FIRST]);
}

async function guardExecutions() {
    return await indexerQuery(
        `SELECT ce.block_index, ce.contract_index, ce.method_name, ce.gas_used, s.status
         FROM contract_executions ce
         JOIN index_statuses s ON s.id = ce.status_id
         WHERE ce.block_index >= ? AND ce.method_name = 'guard'
         ORDER BY ce.block_index, ce.action_index`, [POST_FIRST]);
}

async function debitLegs() {
    return await indexerQuery(
        `SELECT a.block_index, ia.address, it.tick, d.amount
         FROM debits d
         JOIN actions a ON a.action_index = d.action_index
         JOIN index_addresses ia ON ia.id = d.address_id
         JOIN index_tickers it ON it.id = d.tick_id
         WHERE a.block_index >= ?
         ORDER BY a.block_index, d.action_index, ia.address, it.tick, d.amount`, [POST_FIRST]);
}

async function scenarioSnapshot() {
    return {
        sourceTick: await balanceOf(SOURCE, TICK),
        custodyTick: await balanceOf(custody, TICK),
        sourceGas: await balanceOf(SOURCE, indexer.config.GAS),
        statuses: await custodyStatuses(),
        executions: await guardExecutions(),
        debits: await debitLegs(),
    };
}

async function orphanCounts() {
    const rows = await indexerQuery(
        `SELECT
            (SELECT COUNT(*) FROM contract_executions ce
             LEFT JOIN actions a ON a.action_index = ce.action_index
             WHERE a.action_index IS NULL) AS executions,
            (SELECT COUNT(*) FROM debits d
             LEFT JOIN actions a ON a.action_index = d.action_index
             WHERE a.action_index IS NULL) AS debits`, []);
    return { executions: Number(rows[0].executions), debits: Number(rows[0].debits) };
}

async function seedFoundation() {
    await seedGas(seeder, { addresses: [SOURCE], amount: '1000' });
    await seeder.seedBlock(100, T0, [
        { source: SOURCE, data: `ISSUE|0|${TICK}|1000|1000|0|guard replay token|1000` },
        { source: SOURCE, data: `DEPLOY|0|${b64(ALLOW_GUARD)}|300000|` },
        { source: SOURCE, data: `DEPLOY|0|${b64(TARGET)}|300000|` },
    ]);
    indexer = await initIndexer();
    await processBlocks(indexer);
    allowIndex = await contractIndexByCode(ALLOW_GUARD);
    targetIndex = await contractIndexByCode(TARGET);
    custody = custodyAddress(indexer.config.CHAIN, targetIndex);
}

async function seedBindings() {
    await seeder.seedBlock(101, T0 + 100, [
        { source: SOURCE, data: bindTokenLine(TICK, allowIndex, 'all', 'bind-token-allow') },
        { source: SOURCE, data: bindAddressLine(allowIndex, 'all', 'bind-source-allow') },
    ]);
    await processBlocks(indexer);
}

async function seedCustodyLegs() {
    await seeder.seedBlock(102, ACTIVATION_TIME + 100, [
        { source: SOURCE, data: depositLine(targetIndex, TICK, 40) },
    ]);
    await seeder.seedBlock(103, ACTIVATION_TIME + 200, [
        { source: SOURCE, data: withdrawLine(targetIndex, TICK, 15) },
    ]);
}

async function setupSuite() {
    await createDatabases(__filename);
    await createDecoderSchema();
    seeder = new DecoderSeeder(decoderQuery);
    await seedFoundation();
    await seedBindings();
    await seedCustodyLegs();
    assert.strictEqual(await processBlocks(indexer), 2);
    await indexer.indexerDb.sanityCheck(102);
    await indexer.indexerDb.sanityCheck(103);
}

async function teardownSuite() {
    try {
        if (indexer) await destroyIndexer(indexer);
        await destroyFileIndexers(__filename);
        await closeAll();
    } finally {
        restoreCustodyGuard();
        restoreEnv('INDEXER_COIN', priorCoin);
        restoreEnv('INDEXER_NETWORK', priorNetwork);
    }
}

async function captureCanonicalState() {
    assert.ok(allowIndex, 'the ALLOW guard deployed');
    assert.ok(targetIndex, 'the custody target deployed');
    expectedSnapshot = await scenarioSnapshot();
    assert.strictEqual(expectedSnapshot.sourceTick, '975');
    assert.strictEqual(expectedSnapshot.custodyTick, '25');
    assert.deepStrictEqual(expectedSnapshot.statuses.map(row => row.status), ['valid', 'valid']);
    assert.strictEqual(expectedSnapshot.executions.length, 2,
        'deposit and withdrawal each persisted a guard execution');
    assert.ok(expectedSnapshot.debits.length > 0, 'the guarded custody legs wrote debit rows');
    assert.deepStrictEqual(await orphanCounts(), { executions: 0, debits: 0 });
}

async function replayPostActivationBlocks() {
    await destroyIndexer(indexer);
    indexer = null;
    await seeder.seedReorgEvent([POST_FIRST]);
    await deleteDecoderBlocksFrom(POST_FIRST);
    await seedCustodyLegs();
    indexer = await initIndexer();
    assert.strictEqual(await processBlocks(indexer), 2);
    await indexer.indexerDb.sanityCheck(102);
    await indexer.indexerDb.sanityCheck(103);
    assert.deepStrictEqual(await scenarioSnapshot(), expectedSnapshot);
    assert.deepStrictEqual(await orphanCounts(), { executions: 0, debits: 0 });
}

describe('Controller custody guard reorg replay', function () {
    this.timeout(600000);
    before(setupSuite);
    after(teardownSuite);
    it('captures valid guarded custody balances and action-scoped rows', captureCanonicalState);
    it('rolls back and reprocesses guarded blocks without duplicate or orphan rows', replayPostActivationBlocks);
});
