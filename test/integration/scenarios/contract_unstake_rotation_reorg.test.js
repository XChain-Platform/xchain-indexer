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
 * DB-backed against a real MariaDB. The real ledger schema files are loaded and every
 * write goes through production code: STAKE and DELEGATE rows through the real Database
 * createContractStake / createContractDelegation, UNSTAKE through the real
 * Unstake.parseContractUnstake handler (src/actions/unstake), rotations through
 * materializeContractDelegations, and the reorg through the real rollback restores
 * (stake_restores.js, in_place_flips.clearOrphanedDeactivations) plus the block-scoped
 * deletes. No ledger row is written or edited with hand-rolled SQL.
 *
 * Only the UNSTAKE settlement tail (empty credits and debits, mapper) and the sleep gate
 * are stubbed; neither touches the stake or cooldown rows under test.
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const {
    indexerQuery, createDatabases, closeAll,
} = require('../setup/db-connection');
const Database    = require('../../../src/db/index.js');
const Unstake     = require('../../../src/actions/unstake/index.js');
const Utility     = require('../../../src/utility.js');
const { getTestConfig } = require('../../fixtures/config');
const restoreSql  = require('../../../src/db/rollback/stake_restores.js');
const flipsSql    = require('../../../src/db/rollback/in_place_flips.js');

const SQL_DIR = path.resolve(__dirname, '../../../src/sql');
const TABLES = [
    'index_statuses', 'index_pubkeys', 'index_tickers', 'index_addresses', 'issues', 'contracts',
    'stakes', 'unstakes', 'delegations',
    'contract_stakes', 'contract_unstakes', 'contract_delegations', 'contract_delegation_rotations',
];

const SOURCE = 'bc1qsourceaddressforunstaketests', TICK = 'STAKETOK', CONTRACT = 50;
const ACTIVATION_DELAY = 10;
const PK_A  = 'a1'.repeat(32);
const PK_D  = 'd2'.repeat(32);
const PK_D2 = 'e3'.repeat(32);

async function loadSchema() {
    for (const table of TABLES) {
        const sql = fs.readFileSync(path.join(SQL_DIR, table + '.sql'), 'utf8').replace(/--[^\n]*/g, '');
        for (let stmt of sql.split(';')) {
            stmt = stmt.trim();
            if (stmt) await indexerQuery(stmt);
        }
    }
}

// The real Database prototype over the test connection (no pool is opened).
function makeDb(util, config) {
    const db = Object.create(Database.prototype);
    Object.assign(db, {
        config, util, indexer: null, _internCache: null, transactionConnection: null,
        _statusActionIdCache: {
            committed: { status: new Map(), action: new Map() },
            pending:   { status: new Map(), action: new Map() },
        },
        suppressIndexIdCreation: false, deterministicIndexingStarted: false,
        doQuery: (sql, args) => indexerQuery(sql, args),
        isActionAllowed: async () => true,
    });
    return db;
}

// The real UNSTAKE handler wired to that Database.
function makeUnstake(db, util, config) {
    const unstake = new Unstake({
        config, decoderDb: null, indexerDb: db, util,
        mapper: { createMappings: async () => {} },
        protocolChanges: { isEnabled: async () => false },
    });
    unstake.postLedgerChanges = async () => {};
    return unstake;
}

let db, util, unstaker;
let nextAction;

async function stake(actionIndex, pubkey, block) {
    await db.createContractStake({
        STATUS: 'valid', SOURCE, SIGNING_PUBKEY: pubkey, TARGET_CONTRACT_INDEX: CONTRACT, TICK,
        ACTION_INDEX: actionIndex, VERSION: 3, AMOUNT: '100', BLOCK_INDEX: block, ACTIVATION_BLOCK: block,
    });
}
async function delegate(actionIndex, pubkey, block, activation) {
    await db.createContractDelegation({
        STATUS: 'valid', SOURCE, SIGNING_PUBKEY: pubkey, TARGET_CONTRACT_INDEX: CONTRACT, TICK,
        ACTION_INDEX: actionIndex, BLOCK_INDEX: block, ACTIVATION_BLOCK: activation,
    });
}
// UNSTAKE v1 through the production handler.
async function unstake(actionIndex, pubkey, block) {
    await unstaker.parse(['1', pubkey, String(CONTRACT), TICK], {
        FORMAT: 1, SOURCE, COIN: 'BTC', ACTION_INDEX: actionIndex, BLOCK_INDEX: block,
    }, null);
}
async function materialize(block, inWindow) {
    return db.materializeContractDelegations(block, false, inWindow);
}

// Reorg: restore in-place rotations, re-NULL orphaned deactivation stamps, then the
// block-scoped deletes (the order rollback runs them: the child rows must still exist).
async function rollbackFrom(block) {
    await restoreSql.restoreDelegationRotations(db, block);
    await flipsSql.clearOrphanedDeactivations(db, block, ACTIVATION_DELAY);
    for (const table of ['contract_delegation_rotations', 'contract_unstakes', 'contract_stakes', 'contract_delegations'])
        await indexerQuery(`DELETE FROM ${table} WHERE block_index >= ?`, [block]);
}

async function pk(pubkey) { return Number(await db.getPubkeyId(pubkey)); }
async function keyOf(table, actionIndex) {
    const rows = await indexerQuery(`SELECT signing_pubkey_id FROM ${table} WHERE action_index=?`, [actionIndex]);
    assert.strictEqual(rows.length, 1, `${table} row ${actionIndex} should exist`);
    return Number(rows[0].signing_pubkey_id);
}
async function deactivationOf(actionIndex) {
    const rows = await indexerQuery('SELECT deactivation_block FROM contract_stakes WHERE action_index=?', [actionIndex]);
    return rows[0].deactivation_block === null ? null : Number(rows[0].deactivation_block);
}
async function statusOf(actionIndex) {
    const rows = await indexerQuery(
        `SELECT s.status FROM contract_unstakes u JOIN index_statuses s ON s.id=u.status_id WHERE u.action_index=?`,
        [actionIndex]);
    return rows[0].status;
}
async function count(table) {
    return Number((await indexerQuery(`SELECT COUNT(*) AS c FROM ${table}`))[0].c);
}

describe('Contract unstake rotation reorg: DELEGATE then in-window UNSTAKE then reorg @regression @tier3', function () {
    this.timeout(60000);

    before(async function () {
        this.timeout(30000);
        await createDatabases(__filename);
    });

    beforeEach(async function () {
        await loadSchema();
        const config = Object.assign({}, getTestConfig(), {
            ACTIVATION_DELAY_BLOCKS: ACTIVATION_DELAY, STAKING: undefined,
        });
        util = new Utility(config);
        util.logError = () => {};
        db = makeDb(util, config);
        unstaker = makeUnstake(db, util, config);
        // Seed the interned ids and the stakeable target contract
        const sourceId = await db.createAddress(SOURCE, 1);
        await db.createTicker(TICK, 1);
        await db.createStatus('valid');
        await indexerQuery(
            `INSERT INTO contracts (action_index, source_id, code, code_hash, status_id, block_index, cooldown_blocks)
             VALUES (?, ?, 'x', ?, ?, 1, 50)`,
            [CONTRACT, sourceId, 'f'.repeat(64), await db.getStatusId('valid')]);
        for (const key of [PK_A, PK_D, PK_D2]) await db.getOrCreatePubkeyId(key);
    });

    after(async function () {
        await closeAll();
    });

    it('rotates the stake row and the pending cooldown row of a real in-window UNSTAKE onto the delegated key', async function () {
        await stake(1, PK_A, 100);
        await unstake(2, PK_A, 110);                   // real handler: deactivation 120, cooldown row
        assert.strictEqual(await deactivationOf(1), 110 + ACTIVATION_DELAY);
        assert.strictEqual(await statusOf(2), 'valid');
        await delegate(3, PK_D, 112, 115);
        const applied = await materialize(115, true);  // 115 is inside the 110..120 window
        assert.strictEqual(applied.length, 2);
        assert.strictEqual(await keyOf('contract_stakes', 1), await pk(PK_D));
        assert.strictEqual(await keyOf('contract_unstakes', 2), await pk(PK_D));
        assert.strictEqual(await count('contract_delegation_rotations'), 2);
    });

    it('restores both keys and keeps the UNSTAKE when the reorg orphans the delegation activation block', async function () {
        await stake(1, PK_A, 100);
        await unstake(2, PK_A, 110);
        await delegate(3, PK_D, 115, 115);
        await materialize(115, true);
        await rollbackFrom(115);
        assert.strictEqual(await keyOf('contract_stakes', 1), await pk(PK_A));
        assert.strictEqual(await keyOf('contract_unstakes', 2), await pk(PK_A));
        assert.strictEqual(await deactivationOf(1), 110 + ACTIVATION_DELAY, 'surviving UNSTAKE keeps its stamp');
        assert.strictEqual(await count('contract_delegation_rotations'), 0);
        assert.strictEqual(await count('contract_delegations'), 0);
    });

    it('keeps the rotation when only a later UNSTAKE by the rotated key is orphaned, and re-opens the stake', async function () {
        await stake(1, PK_A, 100);
        await delegate(2, PK_D, 105, 110);
        await materialize(110, true);
        assert.strictEqual(await keyOf('contract_stakes', 1), await pk(PK_D));
        // The staker now names the rotated key; the real lookup must resolve it to the stake
        await unstake(3, PK_D, 125);
        assert.strictEqual(await statusOf(3), 'valid');
        assert.strictEqual(await deactivationOf(1), 125 + ACTIVATION_DELAY);
        assert.strictEqual(await keyOf('contract_unstakes', 3), await pk(PK_D));
        await rollbackFrom(125);
        assert.strictEqual(await count('contract_unstakes'), 0, 'orphaned cooldown row removed');
        assert.strictEqual(await deactivationOf(1), null, 'orphaned deactivation stamp cleared');
        assert.strictEqual(await keyOf('contract_stakes', 1), await pk(PK_D), 'surviving rotation stays applied');
        assert.strictEqual(await count('contract_delegation_rotations'), 1);
    });

    it('restores each key to the value before the earliest orphaned rotation, leaving survivors', async function () {
        await stake(1, PK_A, 100);
        await delegate(2, PK_D, 105, 110);
        await materialize(110, true);
        await delegate(3, PK_D2, 125, 140);
        await materialize(140, true);
        assert.strictEqual(await keyOf('contract_stakes', 1), await pk(PK_D2));
        await rollbackFrom(130);
        assert.strictEqual(await keyOf('contract_stakes', 1), await pk(PK_D), 'only the orphaned rotation reverts');
        await rollbackFrom(110);
        assert.strictEqual(await keyOf('contract_stakes', 1), await pk(PK_A), 'full reorg returns the original key');
        assert.strictEqual(await count('contract_delegation_rotations'), 0);
    });

    it('does not rotate a completed cooldown row, and the reorg leaves it untouched', async function () {
        await stake(1, PK_A, 100);
        await unstake(3, PK_A, 110);
        // A cooldown row that already matured: completed by the sweep before the delegation
        await indexerQuery(
            `INSERT INTO contract_unstakes (action_index, source_id, signing_pubkey_id, target_contract_index,
                tick_id, cooldown_end_block, amount, status_id, block_index)
             SELECT 2, source_id, signing_pubkey_id, target_contract_index, tick_id, 105, amount,
                    (SELECT id FROM index_statuses WHERE status='valid'), 101
             FROM contract_unstakes WHERE action_index=3`);
        await indexerQuery("INSERT INTO index_statuses (status) VALUES ('completed')");
        await indexerQuery(
            "UPDATE contract_unstakes SET status_id=(SELECT id FROM index_statuses WHERE status='completed') WHERE action_index=2");
        await delegate(4, PK_D, 115, 115);
        await materialize(115, true);
        assert.strictEqual(await keyOf('contract_unstakes', 2), await pk(PK_A));
        assert.strictEqual(await keyOf('contract_unstakes', 3), await pk(PK_D));
        await rollbackFrom(115);
        assert.strictEqual(await keyOf('contract_unstakes', 2), await pk(PK_A));
        assert.strictEqual(await keyOf('contract_unstakes', 3), await pk(PK_A));
        assert.strictEqual(await keyOf('contract_stakes', 1), await pk(PK_A));
    });

    it('without in-window rotation the deactivating stake keeps its key', async function () {
        await stake(1, PK_A, 100);
        await unstake(2, PK_A, 110);
        await delegate(3, PK_D, 112, 115);
        await materialize(115, false);
        assert.strictEqual(await keyOf('contract_stakes', 1), await pk(PK_A));
        await rollbackFrom(112);
        assert.strictEqual(await keyOf('contract_stakes', 1), await pk(PK_A));
        assert.strictEqual(await count('contract_delegation_rotations'), 0);
    });

    it('replaying the delegation after a reorg reproduces the pre-reorg ledger', async function () {
        await stake(1, PK_A, 100);
        await unstake(2, PK_A, 110);
        await delegate(3, PK_D, 115, 115);
        await materialize(115, true);
        const snapshot = async () => indexerQuery(
            `SELECT 'u' AS t, action_index, signing_pubkey_id, NULL AS deactivation_block FROM contract_unstakes
             UNION ALL
             SELECT 's', action_index, signing_pubkey_id, deactivation_block FROM contract_stakes
             ORDER BY t, action_index`);
        const before = await snapshot();
        await rollbackFrom(115);
        await delegate(3, PK_D, 115, 115);
        await materialize(115, true);
        assert.deepStrictEqual(await snapshot(), before);
        assert.strictEqual(await keyOf('contract_stakes', 1), await pk(PK_D));
    });
});
