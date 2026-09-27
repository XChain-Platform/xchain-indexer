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
const ACTIVATION_TIME = T0 + 1000;
const POST_FIRST = 104;
const POST_LAST = 110;
const OWNER = 'msK1rsgNVFPM4cR3X5rngczTKa6EtT4WKD';
const DEPOSITOR_A = 'mjifPngDYQ6HHPNQdGk1kQuFkJWEiQksQp';
const DEPOSITOR_B = 'mn2YrLgFdvZ9MUK64a7TBn3ZVDKFo13b86';
const OWNER_B = 'mwGujTXFXMLN2YXqo4mQK4DcKy31DUcwoi';
const ALLOW_SOURCE = 'mgNErQKtZ6V6ZZLrbdmtLBd5bHJzBDDC3L';
const SOURCE_NOGAS = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';
const SOURCE_PLAIN = 'mpAEYsk8fhxph1f8P9k7nYxfixstUr6LV9';
const DENY_TICK = 'CGD1';
const ADDRESS_TICK = 'CGDP';
const WITHDRAW_TICK = 'CGWP';
const ALLOW_TICK = 'CGAL';
const GASLESS_TICK = 'CGE1';
const PLAIN_TICK = 'CGEP';

const TARGET_A = "module.exports={ meta:{ name:'Custody Vault A', description:'Holds controller-bound deposits.', version:'1.0.0', ownerWithdraw:true }, ping:function(){ return 'a'; } };";
const TARGET_B = "module.exports={ meta:{ name:'Custody Vault B', description:'Holds address-bound withdrawals.', version:'1.0.0', ownerWithdraw:true }, ping:function(){ return 'b'; } };";
const TARGET_ALLOW = "module.exports={ meta:{ name:'Custody Vault Allow', description:'Holds allowed and unbound deposits.', version:'1.0.0', ownerWithdraw:true }, ping:function(){ return 'allow'; } };";

const {
    DENY_GUARD,
    ALLOW_GUARD,
    custodyAddress,
    depositLine,
    withdrawLine,
    bindTokenLine,
    bindAddressLine,
    armCustodyGuardAt,
} = require('./27_controller_custody_guard.test/helpers/custody_rail.js');
const { sumMeteredFees } = require('./27_controller_custody_guard.test/helpers/fee_sum.js');

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
const { seedGas, GAS_TICK } = require('../../setup/gas-seeder');
const { deleteDecoderBlocksFrom } = require('../core/05_reorg.test/helpers/reorg_chain');

const b64 = value => Buffer.from(value, 'utf8').toString('base64');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

let seeder;
let indexer;
let denyIndex;
let allowIndex;
let targetAIndex;
let targetBIndex;
let targetAllowIndex;
let allowGasBefore;
let plainGasBefore;
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

async function custodyRowsFrom(firstBlock) {
    return await indexerQuery(
        `SELECT d.block_index, d.action_index, 'DEPOSIT' AS action, ia.address AS source,
                it.tick, d.contract_index, d.amount, s.status
         FROM deposits d
         JOIN index_addresses ia ON ia.id = d.source_id
         JOIN index_tickers it ON it.id = d.tick_id
         JOIN index_statuses s ON s.id = d.status_id
         WHERE d.block_index >= ?
         UNION ALL
         SELECT w.block_index, w.action_index, 'WITHDRAW' AS action, ia.address AS source,
                it.tick, w.contract_index, w.amount, s.status
         FROM withdrawals w
         JOIN index_addresses ia ON ia.id = w.source_id
         JOIN index_tickers it ON it.id = w.tick_id
         JOIN index_statuses s ON s.id = w.status_id
         WHERE w.block_index >= ?
         ORDER BY block_index, action_index`, [firstBlock, firstBlock]);
}

async function guardExecutions() {
    return await indexerQuery(
        `SELECT ce.block_index, ce.action_index, ce.contract_index, ce.method_name,
                ce.gas_used, ce.gas_used * ? AS metered_fee, s.status
         FROM contract_executions ce
         JOIN index_statuses s ON s.id = ce.status_id
         WHERE ce.block_index >= ? AND ce.method_name = 'guard'
         ORDER BY ce.block_index, ce.action_index`, [indexer.config.GAS_PRICE, POST_FIRST]);
}

async function ledgerLegs(table) {
    assert.ok(table === 'credits' || table === 'debits');
    return await indexerQuery(
        `SELECT a.block_index, l.action_index, ia.address, it.tick, l.amount
         FROM ${table} l
         JOIN actions a ON a.action_index = l.action_index
         JOIN index_addresses ia ON ia.id = l.address_id
         JOIN index_tickers it ON it.id = l.tick_id
         WHERE a.block_index >= ?
         ORDER BY a.block_index, l.action_index, ia.address, it.tick, l.amount`, [POST_FIRST]);
}

async function relevantBalances() {
    const custodyA = custodyAddress(indexer.config.CHAIN, targetAIndex);
    const custodyB = custodyAddress(indexer.config.CHAIN, targetBIndex);
    const custodyAllow = custodyAddress(indexer.config.CHAIN, targetAllowIndex);
    return {
        depositorDeny: await balanceOf(DEPOSITOR_A, DENY_TICK),
        custodyDeny: await balanceOf(custodyA, DENY_TICK),
        depositorAddress: await balanceOf(DEPOSITOR_B, ADDRESS_TICK),
        custodyAddress: await balanceOf(custodyA, ADDRESS_TICK),
        ownerWithdraw: await balanceOf(OWNER_B, WITHDRAW_TICK),
        custodyWithdraw: await balanceOf(custodyB, WITHDRAW_TICK),
        allowSource: await balanceOf(ALLOW_SOURCE, ALLOW_TICK),
        allowCustody: await balanceOf(custodyAllow, ALLOW_TICK),
        allowGas: await balanceOf(ALLOW_SOURCE, GAS_TICK),
        noGasSource: await balanceOf(SOURCE_NOGAS, GASLESS_TICK),
        noGasCustody: await balanceOf(custodyAllow, GASLESS_TICK),
        noGasBalance: await balanceOf(SOURCE_NOGAS, GAS_TICK),
        plainSource: await balanceOf(SOURCE_PLAIN, PLAIN_TICK),
        plainCustody: await balanceOf(custodyAllow, PLAIN_TICK),
        plainGas: await balanceOf(SOURCE_PLAIN, GAS_TICK),
    };
}

async function scenarioSnapshot() {
    return {
        balances: await relevantBalances(),
        custodyRows: await custodyRowsFrom(POST_FIRST),
        executions: await guardExecutions(),
        credits: await ledgerLegs('credits'),
        debits: await ledgerLegs('debits'),
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
    const funded = [OWNER, DEPOSITOR_A, DEPOSITOR_B, OWNER_B, ALLOW_SOURCE, SOURCE_PLAIN];
    await seedGas(seeder, { addresses: funded, amount: '1000' });
    await seeder.seedBlock(100, T0, [
        { source: OWNER, data: `ISSUE|0|${DENY_TICK}|1000|1000|0|deny custody tick|1000` },
        { source: OWNER, data: `ISSUE|0|${ADDRESS_TICK}|1000|1000|0|address custody tick|1000` },
        { source: OWNER_B, data: `ISSUE|0|${WITHDRAW_TICK}|1000|1000|0|withdraw custody tick|1000` },
        { source: ALLOW_SOURCE, data: `ISSUE|0|${ALLOW_TICK}|1000|1000|0|allow custody tick|1000` },
        { source: OWNER, data: `ISSUE|0|${GASLESS_TICK}|1000|1000|0|gas edge bound tick|1000` },
        { source: OWNER, data: `ISSUE|0|${PLAIN_TICK}|1000|1000|0|gas edge plain tick|1000` },
        { source: OWNER, data: `DEPLOY|0|${b64(DENY_GUARD)}|300000|` },
        { source: OWNER, data: `DEPLOY|0|${b64(ALLOW_GUARD)}|300000|` },
        { source: OWNER, data: `DEPLOY|0|${b64(TARGET_A)}|300000|` },
        { source: OWNER_B, data: `DEPLOY|0|${b64(TARGET_B)}|300000|` },
        { source: ALLOW_SOURCE, data: `DEPLOY|0|${b64(TARGET_ALLOW)}|300000|` },
    ]);
    indexer = await initIndexer();
    assert.strictEqual(await processBlocks(indexer), 2);
}

async function resolveContractIndexes() {
    denyIndex = await contractIndexByCode(DENY_GUARD);
    allowIndex = await contractIndexByCode(ALLOW_GUARD);
    targetAIndex = await contractIndexByCode(TARGET_A);
    targetBIndex = await contractIndexByCode(TARGET_B);
    targetAllowIndex = await contractIndexByCode(TARGET_ALLOW);
    assert.ok(denyIndex && allowIndex && targetAIndex && targetBIndex && targetAllowIndex,
        'both guards and all custody targets deployed');
}

async function seedDistributionsAndBindings() {
    await seeder.seedBlock(101, T0 + 100, [
        { source: OWNER, data: `SEND|0|${DENY_TICK}|300|${DEPOSITOR_A}|seed-deny` },
        { source: OWNER, data: `SEND|0|${ADDRESS_TICK}|300|${DEPOSITOR_B}|seed-address` },
        { source: OWNER, data: `SEND|0|${GASLESS_TICK}|100|${SOURCE_NOGAS}|seed-nogas` },
        { source: OWNER, data: `SEND|0|${PLAIN_TICK}|100|${SOURCE_PLAIN}|seed-plain` },
    ]);
    await seeder.seedBlock(102, T0 + 200, [
        { source: OWNER, data: bindTokenLine(DENY_TICK, denyIndex, 'transfer', 'bind-tick-deny') },
        { source: DEPOSITOR_B, data: bindAddressLine(denyIndex, 'transfer', 'bind-address-deny') },
        { source: OWNER, data: bindTokenLine(GASLESS_TICK, allowIndex, 'transfer', 'bind-gasless-allow') },
        { source: ALLOW_SOURCE, data: bindTokenLine(ALLOW_TICK, allowIndex, 'all', 'bind-token-allow') },
    ]);
    assert.strictEqual(await processBlocks(indexer), 2);
}

async function seedBelowActivationCustody() {
    await seeder.seedBlock(103, T0 + 300, [
        { source: DEPOSITOR_A, data: depositLine(targetAIndex, DENY_TICK, 50) },
        { source: DEPOSITOR_B, data: depositLine(targetAIndex, ADDRESS_TICK, 50) },
        { source: OWNER_B, data: depositLine(targetBIndex, WITHDRAW_TICK, 60) },
    ]);
    assert.strictEqual(await processBlocks(indexer), 1);
    allowGasBefore = await balanceOf(ALLOW_SOURCE, GAS_TICK);
    plainGasBefore = await balanceOf(SOURCE_PLAIN, GAS_TICK);
}

async function seedPostActivationBlocks() {
    await seeder.seedBlock(104, ACTIVATION_TIME + 100, [
        { source: DEPOSITOR_A, data: depositLine(targetAIndex, DENY_TICK, 25) },
        { source: DEPOSITOR_B, data: depositLine(targetAIndex, ADDRESS_TICK, 25) },
        { source: OWNER, data: withdrawLine(targetAIndex, DENY_TICK, 20) },
    ]);
    await seeder.seedBlock(105, ACTIVATION_TIME + 200, [
        { source: OWNER_B, data: bindAddressLine(denyIndex, 'transfer', 'bind-owner-deny') },
    ]);
    await seeder.seedBlock(106, ACTIVATION_TIME + 300, [
        { source: OWNER_B, data: withdrawLine(targetBIndex, WITHDRAW_TICK, 60) },
    ]);
    await seeder.seedBlock(107, ACTIVATION_TIME + 400, [
        { source: ALLOW_SOURCE, data: depositLine(targetAllowIndex, ALLOW_TICK, 40) },
    ]);
    await seeder.seedBlock(108, ACTIVATION_TIME + 500, [
        { source: ALLOW_SOURCE, data: `ISSUE|6|${ALLOW_TICK}||all|0|1|unbind-token-allow` },
        { source: ALLOW_SOURCE, data: bindAddressLine(allowIndex, 'all', 'bind-source-allow') },
        { source: ALLOW_SOURCE, data: withdrawLine(targetAllowIndex, ALLOW_TICK, 15) },
    ]);
    await seeder.seedBlock(109, ACTIVATION_TIME + 600, [
        { source: SOURCE_NOGAS, data: depositLine(targetAllowIndex, GASLESS_TICK, 5) },
    ]);
    await seeder.seedBlock(110, ACTIVATION_TIME + 700, [
        { source: SOURCE_PLAIN, data: depositLine(targetAllowIndex, PLAIN_TICK, 5) },
    ]);
}

async function processPostActivationBlocks() {
    assert.strictEqual(await processBlocks(indexer), POST_LAST - POST_FIRST + 1);
    for (let block = POST_FIRST; block <= POST_LAST; block++)
        await indexer.indexerDb.sanityCheck(block);
}

async function setupSuite() {
    await createDatabases(__filename);
    await createDecoderSchema();
    seeder = new DecoderSeeder(decoderQuery);
    await seedFoundation();
    await resolveContractIndexes();
    await seedDistributionsAndBindings();
    await seedBelowActivationCustody();
    await seedPostActivationBlocks();
    await processPostActivationBlocks();
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

async function assertBelowActivationBypasses() {
    const rows = await custodyRowsFrom(103);
    const below = rows.filter(row => Number(row.block_index) === 103);
    assert.deepStrictEqual(below.map(row => row.status), ['valid', 'valid', 'valid']);
    assert.strictEqual(await balanceOf(DEPOSITOR_A, DENY_TICK), '250');
    assert.strictEqual(await balanceOf(DEPOSITOR_B, ADDRESS_TICK), '250');
    assert.strictEqual(await balanceOf(custodyAddress('BTC', targetAIndex), DENY_TICK), '50');
    assert.strictEqual(await balanceOf(custodyAddress('BTC', targetAIndex), ADDRESS_TICK), '50');
    const executions = await indexerQuery(
        "SELECT COUNT(*) AS count FROM contract_executions WHERE block_index = 103 AND method_name = 'guard'", []);
    assert.strictEqual(Number(executions[0].count), 0);
}

function assertPostStatuses(snapshot) {
    assert.deepStrictEqual(snapshot.custodyRows.map(row => [row.action, row.status]), [
        ['DEPOSIT', 'invalid: controller (reverted)'],
        ['DEPOSIT', 'invalid: controller (reverted)'],
        ['WITHDRAW', 'invalid: controller (reverted)'],
        ['WITHDRAW', 'invalid: controller (reverted)'],
        ['DEPOSIT', 'valid'],
        ['WITHDRAW', 'valid'],
        ['DEPOSIT', 'invalid: insufficient funds (guard gas)'],
        ['DEPOSIT', 'valid'],
    ]);
}

function assertPostBalances(snapshot) {
    assert.deepStrictEqual(snapshot.balances, {
        depositorDeny: '250', custodyDeny: '50',
        depositorAddress: '250', custodyAddress: '50',
        ownerWithdraw: '940', custodyWithdraw: '60',
        allowSource: '975', allowCustody: '25', allowGas: snapshot.balances.allowGas,
        noGasSource: '100', noGasCustody: '0', noGasBalance: '0',
        plainSource: '95', plainCustody: '5', plainGas: plainGasBefore,
    });
}

function assertGuardGas(snapshot) {
    assert.deepStrictEqual(snapshot.executions.map(row => [
        Number(row.block_index), Number(row.contract_index), row.status,
    ]), [
        [107, allowIndex, 'valid'],
        [108, allowIndex, 'valid'],
    ]);
    assert.ok(snapshot.executions.every(row => Number(row.gas_used) > 0));
    const gasBurn = Number(indexer.util.bcsub(allowGasBefore, snapshot.balances.allowGas, 8));
    assert.strictEqual(gasBurn, sumMeteredFees(snapshot.executions));
}

async function captureCanonicalState() {
    await assertBelowActivationBypasses();
    expectedSnapshot = await scenarioSnapshot();
    assertPostStatuses(expectedSnapshot);
    assertPostBalances(expectedSnapshot);
    assertGuardGas(expectedSnapshot);
    assert.ok(expectedSnapshot.credits.length > 0 && expectedSnapshot.debits.length > 0);
    assert.deepStrictEqual(await orphanCounts(), { executions: 0, debits: 0 });
}

async function replayPostActivationBlocks() {
    await destroyIndexer(indexer);
    indexer = null;
    await seeder.seedReorgEvent([POST_FIRST]);
    await deleteDecoderBlocksFrom(POST_FIRST);
    await seedPostActivationBlocks();
    indexer = await initIndexer();
    await processPostActivationBlocks();
    assert.deepStrictEqual(await scenarioSnapshot(), expectedSnapshot);
    assert.deepStrictEqual(await orphanCounts(), { executions: 0, debits: 0 });
}

describe('Controller custody guard end-to-end reorg replay', function () {
    this.timeout(600000);
    before(setupSuite);
    after(teardownSuite);
    it('covers DENY, ALLOW, gas refusal, and unbound custody routing', captureCanonicalState);
    it('rolls back and reprocesses every post-activation custody row exactly', replayPostActivationBlocks);
});
