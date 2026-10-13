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
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Integration test: DELEGATE v1 rotation, in-window UNSTAKE, then reorg
 *
 * DB-backed against a real MariaDB. The real stake-ledger schema files are loaded, the
 * real materializeContractDelegations / rotateContractStakeKey run against them, and the
 * real rollback restore (src/db/rollback/stake_restores.js) plus the block-scoped deletes
 * undo the orphaned blocks. Each scenario compares the rolled-back ledger with the state
 * a from-genesis chain that never saw the orphaned blocks would hold.
 *
 * No decoder schema and no VM are needed: the harness drives the ledger layer directly.
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const {
    indexerQuery, createDatabases, closeAll,
} = require('../setup/db-connection');
const delegationRotation = require('../../../src/db/contracts/delegation_rotation.js');
const controllersVm      = require('../../../src/db/database/controllers_vm.js');
const indexTables        = require('../../../src/db/index_tables/index.js');
const restoreSql         = require('../../../src/db/rollback/stake_restores.js');

const SQL_DIR = path.resolve(__dirname, '../../../src/sql');
const TABLES = [
    'index_statuses', 'contract_stakes', 'contract_unstakes',
    'contract_delegations', 'contract_delegation_rotations',
];

const SOURCE = 7, CONTRACT = 50, TICK = 3;
const KEY_A = 101, KEY_D = 202, KEY_D2 = 303;

async function loadSchema() {
    for (const table of TABLES) {
        const sql = fs.readFileSync(path.join(SQL_DIR, table + '.sql'), 'utf8').replace(/--[^\n]*/g, '');
        for (let stmt of sql.split(';')) {
            stmt = stmt.trim();
            if (stmt) await indexerQuery(stmt);
        }
    }
}

// The slice of Database the rotation code touches, backed by the real methods.
function makeDb() {
    const db = {
        doQuery: (sql, args) => indexerQuery(sql, args),
        getStatusId: indexTables.getStatusId,
        rotateContractStakeKey: controllersVm.rotateContractStakeKey,
        createContractDelegationRotation: delegationRotation.createContractDelegationRotation,
        contractPubkeyClaimedElsewhere: delegationRotation.contractPubkeyClaimedElsewhere,
        materializeContractDelegations: delegationRotation.materializeContractDelegations,
        indexer: null,
    };
    return db;
}

let statusIds;

async function insertStake(actionIndex, key, block, deactivation) {
    await indexerQuery(
        `INSERT INTO contract_stakes (action_index, source_id, signing_pubkey_id, target_contract_index,
            tick_id, amount, status_id, block_index, activation_block, deactivation_block)
         VALUES (?, ?, ?, ?, ?, '100', ?, ?, ?, ?)`,
        [actionIndex, SOURCE, key, CONTRACT, TICK, statusIds.valid, block, block, deactivation]);
}
async function insertUnstake(actionIndex, key, block, status) {
    await indexerQuery(
        `INSERT INTO contract_unstakes (action_index, source_id, signing_pubkey_id, target_contract_index,
            tick_id, cooldown_end_block, amount, status_id, block_index)
         VALUES (?, ?, ?, ?, ?, ?, '100', ?, ?)`,
        [actionIndex, SOURCE, key, CONTRACT, TICK, block + 50, statusIds[status], block]);
}
async function insertDelegation(actionIndex, key, block, activation) {
    await indexerQuery(
        `INSERT INTO contract_delegations (action_index, source_id, signing_pubkey_id, target_contract_index,
            tick_id, status_id, block_index, activation_block)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [actionIndex, SOURCE, key, CONTRACT, TICK, statusIds.valid, block, activation]);
}

// Reorg: restore in-place rotations first, then the block-scoped deletes (as rollback does).
async function rollbackFrom(db, block) {
    await restoreSql.restoreDelegationRotations(db, block);
    for (const table of ['contract_delegation_rotations', 'contract_unstakes', 'contract_stakes', 'contract_delegations'])
        await indexerQuery(`DELETE FROM ${table} WHERE block_index >= ?`, [block]);
}

async function keyOf(table, actionIndex) {
    const rows = await indexerQuery(`SELECT signing_pubkey_id FROM ${table} WHERE action_index=?`, [actionIndex]);
    assert.strictEqual(rows.length, 1, `${table} row ${actionIndex} should exist`);
    return Number(rows[0].signing_pubkey_id);
}
async function count(table) {
    return Number((await indexerQuery(`SELECT COUNT(*) AS c FROM ${table}`))[0].c);
}

describe('Contract unstake rotation reorg: DELEGATE then in-window UNSTAKE then reorg @regression @tier3', function () {
    this.timeout(60000);
    let db;

    before(async function () {
        this.timeout(30000);
        await createDatabases(__filename);
    });

    beforeEach(async function () {
        await loadSchema();
        for (const status of ['valid', 'pending', 'completed'])
            await indexerQuery('INSERT INTO index_statuses (status) VALUES (?)', [status]);
        const rows = await indexerQuery('SELECT id, status FROM index_statuses');
        statusIds = {};
        for (const r of rows) statusIds[r.status] = Number(r.id);
        db = makeDb();
    });

    after(async function () {
        await closeAll();
    });

    it('rotates the stake row and the pending cooldown row onto the delegated key', async function () {
        await insertStake(1, KEY_A, 100, 130);          // unstaked in window: deactivation 130
        await insertUnstake(2, KEY_A, 110, 'pending');
        await insertDelegation(3, KEY_D, 112, 120);
        const applied = await db.materializeContractDelegations(120, false, true);
        assert.strictEqual(applied.length, 2);
        assert.strictEqual(await keyOf('contract_stakes', 1), KEY_D);
        assert.strictEqual(await keyOf('contract_unstakes', 2), KEY_D);
        assert.strictEqual(await count('contract_delegation_rotations'), 2);
    });

    it('restores both keys when the reorg orphans the delegation activation block', async function () {
        await insertStake(1, KEY_A, 100, 130);
        await insertUnstake(2, KEY_A, 110, 'pending');
        await insertDelegation(3, KEY_D, 120, 120);
        await db.materializeContractDelegations(120, false, true);
        await rollbackFrom(db, 120);
        assert.strictEqual(await keyOf('contract_stakes', 1), KEY_A);
        assert.strictEqual(await keyOf('contract_unstakes', 2), KEY_A);
        assert.strictEqual(await count('contract_delegation_rotations'), 0);
        assert.strictEqual(await count('contract_delegations'), 0);
    });

    it('keeps the rotation when only a later in-window UNSTAKE block is orphaned', async function () {
        await insertStake(1, KEY_A, 100, null);
        await insertDelegation(2, KEY_D, 105, 110);
        await db.materializeContractDelegations(110, false, true);
        assert.strictEqual(await keyOf('contract_stakes', 1), KEY_D);
        // UNSTAKE at 125 deactivates the stake and opens a cooldown row carrying the rotated key.
        await indexerQuery('UPDATE contract_stakes SET deactivation_block=145 WHERE action_index=1');
        await insertUnstake(3, KEY_D, 125, 'pending');
        await rollbackFrom(db, 125);
        assert.strictEqual(await count('contract_unstakes'), 0, 'orphaned cooldown row removed');
        assert.strictEqual(await keyOf('contract_stakes', 1), KEY_D, 'surviving rotation stays applied');
        assert.strictEqual(await count('contract_delegation_rotations'), 1);
    });

    it('restores each key to the value before the earliest orphaned rotation, leaving survivors', async function () {
        await insertStake(1, KEY_A, 100, null);
        await insertDelegation(2, KEY_D, 105, 110);
        await db.materializeContractDelegations(110, false, true);
        await insertDelegation(3, KEY_D2, 125, 140);
        await db.materializeContractDelegations(140, false, true);
        assert.strictEqual(await keyOf('contract_stakes', 1), KEY_D2);
        await rollbackFrom(db, 130);
        assert.strictEqual(await keyOf('contract_stakes', 1), KEY_D, 'only the orphaned rotation reverts');
        await rollbackFrom(db, 110);
        assert.strictEqual(await keyOf('contract_stakes', 1), KEY_A, 'full reorg returns the original key');
        assert.strictEqual(await count('contract_delegation_rotations'), 0);
    });

    it('does not rotate a completed cooldown row, and the reorg leaves it untouched', async function () {
        await insertStake(1, KEY_A, 100, 130);
        await insertUnstake(2, KEY_A, 105, 'completed');
        await insertUnstake(3, KEY_A, 110, 'pending');
        await insertDelegation(4, KEY_D, 115, 120);
        await db.materializeContractDelegations(120, false, true);
        assert.strictEqual(await keyOf('contract_unstakes', 2), KEY_A);
        assert.strictEqual(await keyOf('contract_unstakes', 3), KEY_D);
        await rollbackFrom(db, 115);
        assert.strictEqual(await keyOf('contract_unstakes', 2), KEY_A);
        assert.strictEqual(await keyOf('contract_unstakes', 3), KEY_A);
        assert.strictEqual(await keyOf('contract_stakes', 1), KEY_A);
    });

    it('without in-window rotation the deactivating stake keeps its key but the cooldown row rotates', async function () {
        await insertStake(1, KEY_A, 100, 130);
        await insertUnstake(2, KEY_A, 110, 'pending');
        await insertDelegation(3, KEY_D, 112, 120);
        await db.materializeContractDelegations(120, false, false);
        assert.strictEqual(await keyOf('contract_stakes', 1), KEY_A);
        assert.strictEqual(await keyOf('contract_unstakes', 2), KEY_D);
        await rollbackFrom(db, 112);
        assert.strictEqual(await keyOf('contract_unstakes', 2), KEY_A);
    });

    it('replaying the delegation after a reorg reproduces the pre-reorg ledger', async function () {
        await insertStake(1, KEY_A, 100, 130);
        await insertUnstake(2, KEY_A, 110, 'pending');
        await insertDelegation(3, KEY_D, 115, 120);
        await db.materializeContractDelegations(120, false, true);
        const before = await indexerQuery(
            'SELECT action_index, signing_pubkey_id FROM contract_unstakes ORDER BY action_index');
        await rollbackFrom(db, 115);
        await insertDelegation(3, KEY_D, 115, 120);
        await db.materializeContractDelegations(120, false, true);
        const after = await indexerQuery(
            'SELECT action_index, signing_pubkey_id FROM contract_unstakes ORDER BY action_index');
        assert.deepStrictEqual(after, before);
        assert.strictEqual(await keyOf('contract_stakes', 1), KEY_D);
    });
});
