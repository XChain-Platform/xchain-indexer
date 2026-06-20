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
 * RECOVERY ID-DETERMINISM DRILL (consensus).
 *
 * recovery.js pre-seeds reward-source addresses via createAddress() OUTSIDE a block
 * transaction (legacy AUTO_INCREMENT, block_index NULL) BEFORE the reindex. The dense
 * counter getNextAddressId() is MAX(id)+1 over ALL rows (including pre-seeded ones), so
 * those pre-seeded rows shift every subsequent in-block deterministic id. A recovered
 * node therefore builds a DIFFERENT index_addresses id map than a from-genesis node over
 * the identical chain, which forks every wire ^id resolution and breaks the stated
 * "validator_rewards byte-identical across the recovery boundary" invariant (db.js:8182).
 *
 * This drill exercises the REAL createAddress / getNextAddressId against a real DB.
 *
 *  - The CHARACTERIZATION test documents the current divergence (passes today; it is the
 *    RED gate that proves the gap exists).
 *  - The F1-ACCEPTANCE test (skipped) asserts the maps are IDENTICAL; un-skip it (and drop
 *    the characterization) once F1 lands so recovery no longer perturbs the counter.
 *
 * Needs a real MariaDB. Set TEST_DB_HOST/PORT/USER/PASS; the suite self-skips if absent.
 * See claude/reports/2026-06-19_id-determinism-gap-scoping.md.
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

const SCHEMA = fs.readFileSync(path.join(__dirname, '../../src/sql/index_addresses.sql'), 'utf8');

const SEQ     = ['bc1qAlice', 'bc1qBob', 'bc1qCarol'];   // in-block address sequence (both nodes)
const PRESEED = ['bc1qRewardSrc1', 'bc1qRewardSrc2'];    // recovery.js reward-source pre-seed

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

// Build the from-genesis index map: just the in-block sequence, no pre-seed.
async function genesisMap() {
    await freshSchema();
    const db = makeDb();
    try { return await inBlockSequence(db, SEQ, 1); } finally { await db.pool.end(); }
}

// Build the recovered index map: pre-seed reward sources out-of-tx (recovery.js), then the
// identical in-block sequence.
async function recoveryMap() {
    await freshSchema();
    const db = makeDb();
    try {
        for (const a of PRESEED) await db.createAddress(a);   // out-of-tx -> AUTO_INCREMENT, NULL block_index
        return await inBlockSequence(db, SEQ, 1);
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

    // CHARACTERIZATION (passes today): proves the gap. Pre-seeding N reward sources offsets
    // every in-block deterministic id by N, so the two maps diverge.
    it('CONFIRMS the gap: recovery pre-seed offsets the deterministic id map', async function () {
        const genesis  = await genesisMap();
        const recovery = await recoveryMap();

        // from-genesis assigns the dense sequence 1,2,3...
        assert.deepStrictEqual(genesis, { bc1qAlice: 1, bc1qBob: 2, bc1qCarol: 3 });
        // recovery offsets every id by the pre-seed count (2)
        for (const a of SEQ) {
            assert.strictEqual(recovery[a], genesis[a] + PRESEED.length,
                a + ' should be offset by the pre-seed count on a recovered node');
        }
        // therefore the maps diverge -> ^id and validator_rewards.source_id fork across nodes
        assert.notDeepStrictEqual(recovery, genesis,
            'recovered and from-genesis nodes must NOT (today) agree on the id map');
    });

    // F1 ACCEPTANCE GATE (skip until F1 lands). After recovery no longer assigns ids
    // out-of-band / perturbs the counter, the two maps MUST be identical. Un-skip then.
    it.skip('F1 acceptance: recovered and from-genesis id maps are IDENTICAL', async function () {
        const genesis  = await genesisMap();
        const recovery = await recoveryMap();
        assert.deepStrictEqual(recovery, genesis,
            'after F1, recovery must reproduce the from-genesis deterministic id map exactly');
    });
});
