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
 *
 * RECOVERY ID-DETERMINISM DRILL (consensus) - F1a acceptance.
 *
 * THE PRIMITIVE (test 1, characterization): createAddress() OUTSIDE a block tx takes the
 * legacy AUTO_INCREMENT / NULL-block_index path and occupies low ids. getNextAddressId() is
 * MAX(id)+1 over ALL rows, so those low ids offset every subsequent in-block deterministic
 * id. This is WHY recovery must never assign ids out-of-band before the reindex.
 *
 * THE FIX (test 2, F1a acceptance): recovery.js no longer calls createAddress at restore
 * time. It STAGES each archived reward in recovery_pending_rewards keyed by the raw source
 * address string (assigning no id). During the reindex, when the source address first gets
 * its deterministic in-block id, createAddress's apply hook materializes the staged reward
 * into validator_rewards under that deterministic source_id. The counter is never perturbed,
 * so a recovered node reproduces the EXACT from-genesis id map, and the reward lands under
 * the deterministic source_id (COLLECT-correct + from-genesis parity).
 *
 * This drill exercises the REAL createAddress / getNextAddressId / apply hook against a real
 * DB. Needs a real MariaDB. Set TEST_DB_HOST/PORT/USER/PASS; the suite self-skips if absent.
 * See claude/reports/2026-06-19_id-determinism-F1-implementation-plan.md.
 *
 ********************************************************************/
'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert  = require('assert');
const fs      = require('fs');
const path    = require('path');
const mariadb = require('mariadb');

const { getTestConfig } = require('../fixtures/config');
const Utility  = require('../../src/utility');
const Database = require('../../src/db');

const DB_HOST = process.env.TEST_DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.TEST_DB_PORT) || 3306;
const DB_USER = process.env.TEST_DB_USER || 'root';
const DB_PASS = process.env.TEST_DB_PASS;            // undefined => self-skip
const DB_NAME = 'xchain_recovery_id_drill';

const SQL_DIR = path.join(__dirname, '../../src/sql');
// The apply hook touches index_addresses + index_pubkeys + validator_rewards, and reads the
// recovery_pending_rewards staging table.
const SCHEMA_FILES = ['index_addresses.sql', 'index_pubkeys.sql', 'validator_rewards.sql', 'recovery_pending_rewards.sql'];
const SCHEMA = SCHEMA_FILES.map(f => fs.readFileSync(path.join(SQL_DIR, f), 'utf8')).join('\n');

const SEQ    = ['bc1qAlice', 'bc1qBob', 'bc1qCarol'];   // in-block address sequence (both nodes)
const PRESEED = ['bc1qLegacy1', 'bc1qLegacy2'];          // out-of-tx createAddress (the primitive)

// A staged archived reward whose source IS an in-block address (Alice). Recovery earns
// rewards for staking sources, which always appear in-chain via their STAKE action.
const STAGED_REWARD = {
    source_address:   'bc1qAlice',
    validator_pubkey: 'ab'.repeat(32),                  // 64-hex
    reward_type:      'anchor_BTC',
    round_reference:  42,
    amount:           '1000',
    block_index:      7
};

async function freshSchema() {
    const admin = await mariadb.createConnection({ host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS, multipleStatements: true });
    await admin.query('DROP DATABASE IF EXISTS ' + DB_NAME + '; CREATE DATABASE ' + DB_NAME + ';');
    await admin.query('USE ' + DB_NAME + '; ' + SCHEMA);
    await admin.end();
}

function makeDb() {
    const util = new Utility();
    util.logError = () => {};
    return new Database(DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS, { config: getTestConfig(), util });
}

async function inBlockSequence(db, addrs, blockIndex) {
    await db.beginTransaction();
    db.blockIndex = blockIndex;
    const map = {};
    for (const a of addrs) map[a] = Number(await db.createAddress(a));
    await db.commitTransaction();
    return map;
}

// Build the from-genesis index map: just the in-block sequence, no pre-seed, no staging.
async function genesisMap() {
    await freshSchema();
    const db = makeDb();
    try { return await inBlockSequence(db, SEQ, 1); } finally { await db.pool.end(); }
}

// The PRIMITIVE: out-of-tx createAddress occupies low ids and offsets the in-block sequence.
async function legacyPreseedMap() {
    await freshSchema();
    const db = makeDb();
    try {
        for (const a of PRESEED) await db.createAddress(a);   // out-of-tx -> AUTO_INCREMENT, NULL block_index
        return await inBlockSequence(db, SEQ, 1);
    } finally { await db.pool.end(); }
}

// The F1a recovery path: stage the archived reward by raw string (what recovery.js now does),
// then run the identical in-block reindex sequence. Returns { map, rewards }.
async function recoveryMap() {
    await freshSchema();
    const db = makeDb();
    try {
        // recovery.js: stage, assign NO id.
        await db.doQuery(
            `INSERT INTO recovery_pending_rewards
                (source_address, validator_pubkey, reward_type, round_reference, amount, block_index)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [STAGED_REWARD.source_address, STAGED_REWARD.validator_pubkey, STAGED_REWARD.reward_type,
             STAGED_REWARD.round_reference, STAGED_REWARD.amount, STAGED_REWARD.block_index]);
        const map = await inBlockSequence(db, SEQ, 1);   // apply hook fires when Alice gets her id
        const rewards = await db.doQuery(
            "SELECT vr.source_id, vr.reward_type, vr.round_reference, vr.amount, vr.block_index, pk.pubkey " +
            "FROM validator_rewards vr JOIN index_pubkeys pk ON pk.id = vr.signing_pubkey_id");
        const staged = await db.doQuery("SELECT applied, source_id FROM recovery_pending_rewards");
        return { map, rewards, staged };
    } finally { await db.pool.end(); }
}

describe('Recovery id-determinism (consensus) @integration', function () {
    this.timeout(60000);

    before(async function () {
        if (DB_PASS === undefined) { this.skip(); return; }
        try {
            const c = await mariadb.createConnection({ host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS, connectTimeout: 4000 });
            await c.query('SELECT 1'); await c.end();
        } catch (e) { this.skip(); }
    });

    after(async function () {
        if (DB_PASS === undefined) return;
        try {
            const admin = await mariadb.createConnection({ host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS });
            await admin.query('DROP DATABASE IF EXISTS ' + DB_NAME); await admin.end();
        } catch (e) { /* best effort */ }
    });

    // THE PRIMITIVE (characterization): out-of-tx createAddress offsets the deterministic id
    // space. This is the hazard F1a removes from recovery; createAddress itself is unchanged.
    it('primitive: out-of-tx createAddress offsets the deterministic id map', async function () {
        const genesis = await genesisMap();
        const legacy  = await legacyPreseedMap();

        assert.deepStrictEqual(genesis, { bc1qAlice: 1, bc1qBob: 2, bc1qCarol: 3 });
        for (const a of SEQ) {
            assert.strictEqual(legacy[a], genesis[a] + PRESEED.length,
                a + ' is offset by the out-of-tx pre-seed count');
        }
    });

    // F1a ACCEPTANCE: the real recovery path (stage by string, no id) reproduces the
    // from-genesis id map EXACTLY, and materializes the staged reward under the deterministic
    // source_id when the source address first gets its in-block id.
    it('F1a acceptance: staged-recovery id map is IDENTICAL to from-genesis', async function () {
        const genesis = await genesisMap();
        const { map, rewards, staged } = await recoveryMap();

        // (1) The counter was never perturbed -> identical id map.
        assert.deepStrictEqual(map, genesis,
            'after F1a, staged recovery must reproduce the from-genesis deterministic id map exactly');

        // (2) The staged reward materialized under Alice's deterministic source_id.
        assert.strictEqual(rewards.length, 1, 'exactly one reward materialized');
        assert.strictEqual(Number(rewards[0].source_id), genesis['bc1qAlice'],
            'reward source_id equals the deterministic in-block id for the source address');
        assert.strictEqual(rewards[0].reward_type, STAGED_REWARD.reward_type);
        assert.strictEqual(Number(rewards[0].round_reference), STAGED_REWARD.round_reference);
        assert.strictEqual(String(rewards[0].amount), STAGED_REWARD.amount);
        assert.strictEqual(Number(rewards[0].block_index), STAGED_REWARD.block_index,
            'archived earn-block carried verbatim onto validator_rewards');
        assert.strictEqual(rewards[0].pubkey, STAGED_REWARD.validator_pubkey);

        // (3) The staging row is marked applied with the resolved source_id (for reorg re-arm).
        assert.strictEqual(staged.length, 1);
        assert.strictEqual(Number(staged[0].applied), 1);
        assert.strictEqual(Number(staged[0].source_id), genesis['bc1qAlice']);
    });

    // Defense-in-depth: a NULL-block (out-of-band) id is NOT resolvable as a wire ^id (F2
    // gate in resolveAddressRef), while an in-block id is. Confirms the gate is live.
    it('F2 gate: resolveAddressRef resolves only block-stamped ids', async function () {
        await freshSchema();
        const db = makeDb();
        try {
            // Out-of-tx -> NULL block_index.
            const legacyId = Number(await db.createAddress('bc1qLegacyOnly'));
            // In-tx -> deterministic, block-stamped.
            await db.beginTransaction();
            db.blockIndex = 5;
            const blockId = Number(await db.createAddress('bc1qInBlock'));
            await db.commitTransaction();

            assert.strictEqual(await db.resolveAddressRef('^' + blockId), 'bc1qInBlock',
                'block-stamped id resolves');
            assert.strictEqual(await db.resolveAddressRef('^' + legacyId), '^' + legacyId,
                'NULL-block id is returned unchanged (rejected downstream), not resolved');
        } finally { await db.pool.end(); }
    });
});
