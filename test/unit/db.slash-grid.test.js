/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/db.slash-grid.test.js
 *
 * ECONOMIC REGRESSION GUARD for slashContractStake() off-grid value inflation.
 *
 * The row write and the credit were rounded SEPARATELY at the tick's decimals, and
 * util.bcsub / util.bcadd round HALF-UP there. With a decimals=0 tick, a stake row of
 * '1' and a slash of '0.5': bcsub('1','0.5',0) is '1', so the row is written back
 * UNCHANGED, while bcadd('0','0.5',0) is '1', so _processSlashEmission releases a full
 * unit of escrow and credits a full unit against a stake that was never debited. The
 * stake stays slashable again and withdrawable.
 *
 * slash_grid_activation.js floors the request onto the tick's grid once and derives the
 * take from the reduction actually written. The invariant these cases assert is the one
 * that was broken: total === sum(releases) === sum(prev_amount - written amount).
 *
 * The legacy cases are here to PIN the pre-activation arithmetic byte for byte: the gate
 * is inert on every unpinned chain, so a replay of already-processed blocks must still
 * produce the inflated figures.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');
const slashGrid         = require('../../src/slash_grid_activation');

// `network` picks the gate state: 'regtest' is armed at genesis, 'mainnet' is unpinned
// and therefore inert, which is what makes the legacy cases below reachable at all.
function makeDb(network) {
    const config  = Object.assign({}, getTestConfig(), { NETWORK: network, COIN: 'BTC' });
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const indexer = { config, util };
    const db      = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
    db.pool = { getConnection: sinon.stub().resolves({
        query:   sinon.stub().resolves([]),
        release: sinon.stub().resolves()
    }) };
    return db;
}

afterEach(function () { sinon.restore(); });

describe('Database.slashContractStake() off-grid conservation guard @regression @tier1', function () {

    it('gate is armed on regtest and inert on every unpinned chain', function () {
        assert.strictEqual(slashGrid.isSlashGridActive(0, 'regtest', 'BTC'), true);
        assert.strictEqual(slashGrid.isSlashGridActive(9e9, 'mainnet', 'BTC'), false);
        assert.strictEqual(slashGrid.isSlashGridActive(9e9, 'testnet', 'BTC'), false);
    });

    // The defect itself, pinned pre-activation. If this case ever goes green with a '0'
    // total on an unpinned chain, the gate has stopped being inert and historical replay
    // has moved.
    it('LEGACY (inert gate): a 0.5 slash of a decimals=0 stake credits 1 and debits nothing', async function () {
        const db = makeDb('mainnet');
        const calls = [];
        sinon.stub(db, 'getStatusId').callsFake(async (s) => (s === 'valid' ? 1 : (s === 'pending' ? 2 : null)));
        sinon.stub(db, 'getTokenDecimalPrecision').resolves(0);
        sinon.stub(db, 'createContractSlashDebit').resolves();
        sinon.stub(db, 'doQuery').callsFake(async (sql, args) => {
            if (/SELECT[\s\S]*FROM\s+contract_stakes/i.test(sql))
                return [{ action_index: 7, amount: '1', source_address: 'staker1' }];
            if (/SELECT[\s\S]*FROM\s+contract_unstakes/i.test(sql)) return [];
            if (/UPDATE\s+contract_stakes\s+SET amount=\?/i.test(sql)) calls.push(String(args[0]));
            return [];
        });

        const res = await db.slashContractStake(1, 10, 1, '0.5', 500, 99, 0);

        assert.strictEqual(String(res.total), '1', 'legacy credits a full unit');
        assert.deepStrictEqual(calls, ['1'], 'legacy writes the row back UNCHANGED');
        assert.strictEqual(res.releases.length, 1);
        assert.strictEqual(String(res.releases[0].amount), '1');
    });

    it('ACTIVE: a 0.5 slash of a decimals=0 stake takes nothing and credits nothing', async function () {
        const db = makeDb('regtest');
        const updates = [];
        sinon.stub(db, 'getStatusId').callsFake(async (s) => (s === 'valid' ? 1 : (s === 'pending' ? 2 : null)));
        sinon.stub(db, 'getTokenDecimalPrecision').resolves(0);
        const debit = sinon.stub(db, 'createContractSlashDebit').resolves();
        sinon.stub(db, 'doQuery').callsFake(async (sql, args) => {
            if (/SELECT[\s\S]*FROM\s+contract_stakes/i.test(sql))
                return [{ action_index: 7, amount: '1', source_address: 'staker1' }];
            if (/SELECT[\s\S]*FROM\s+contract_unstakes/i.test(sql)) return [];
            if (/UPDATE\s+contract_(un)?stakes\s+SET amount=\?/i.test(sql)) updates.push(String(args[0]));
            return [];
        });

        const res = await db.slashContractStake(1, 10, 1, '0.5', 500, 99, 0);

        assert.strictEqual(String(res.total), '0', 'an off-grid punishment credits nothing');
        assert.deepStrictEqual(res.releases, [], 'and releases no escrow');
        assert.deepStrictEqual(updates, [], 'and touches no row');
        assert.strictEqual(debit.callCount, 0, 'and journals no debit for rollback to restore');
    });

    it('ACTIVE: a 1.5 slash of a decimals=0 stake takes exactly 1 and credits exactly 1', async function () {
        const db = makeDb('regtest');
        const updates = [];
        const debits  = [];
        sinon.stub(db, 'getStatusId').callsFake(async (s) => (s === 'valid' ? 1 : (s === 'pending' ? 2 : null)));
        sinon.stub(db, 'getTokenDecimalPrecision').resolves(0);
        sinon.stub(db, 'createContractSlashDebit').callsFake(async (e, p, t, ai, prev, amt) => {
            debits.push({ prev: String(prev), amount: String(amt) });
        });
        sinon.stub(db, 'doQuery').callsFake(async (sql, args) => {
            if (/SELECT[\s\S]*FROM\s+contract_stakes/i.test(sql))
                return [{ action_index: 7, amount: '1', source_address: 'staker1' }];
            if (/SELECT[\s\S]*FROM\s+contract_unstakes/i.test(sql)) return [];
            if (/UPDATE\s+contract_(un)?stakes\s+SET amount=\?/i.test(sql)) updates.push(String(args[0]));
            return [];
        });

        const res = await db.slashContractStake(1, 10, 1, '1.5', 500, 99, 0);

        assert.strictEqual(String(res.total), '1');
        assert.deepStrictEqual(updates, ['0'], 'the row is emptied, not left at 1');
        assert.deepStrictEqual(debits, [{ prev: '1', amount: '1' }]);
        assert.strictEqual(String(res.releases[0].amount), '1');
        // total === sum(releases) === sum(prev_amount - written amount)
        const released = res.releases.reduce((n, r) => n + Number(r.amount), 0);
        const written  = debits.reduce((n, d, i) => n + (Number(d.prev) - Number(updates[i])), 0);
        assert.strictEqual(Number(res.total), released);
        assert.strictEqual(Number(res.total), written);
    });

    it('ACTIVE: the cooldown pass carries the same rule (0.5 takes nothing, 1.5 takes 1)', async function () {
        for (const [amount, expectTotal, expectUpdates] of [['0.5', '0', []], ['1.5', '1', ['0']]]) {
            const db = makeDb('regtest');
            const updates = [];
            sinon.stub(db, 'getStatusId').callsFake(async (s) => (s === 'valid' ? 1 : (s === 'pending' ? 2 : null)));
            sinon.stub(db, 'getTokenDecimalPrecision').resolves(0);
            sinon.stub(db, 'createContractSlashDebit').resolves();
            sinon.stub(db, 'doQuery').callsFake(async (sql, args) => {
                if (/SELECT[\s\S]*FROM\s+contract_stakes/i.test(sql)) return [];
                if (/SELECT[\s\S]*FROM\s+contract_unstakes/i.test(sql))
                    return [{ action_index: 5, amount: '1', source_address: 'staker1' }];
                if (/UPDATE\s+contract_unstakes\s+SET amount=\?/i.test(sql)) updates.push(String(args[0]));
                return [];
            });

            const res = await db.slashContractStake(1, 10, 1, amount, 500, 99, 0);

            assert.strictEqual(String(res.total), expectTotal, 'cooldown total for ' + amount);
            assert.deepStrictEqual(updates, expectUpdates, 'cooldown row writes for ' + amount);
            sinon.restore();
        }
    });

    it('ACTIVE: an off-grid STORED row still credits only what it held', async function () {
        // The delta must not be re-rounded at the tick's grid: a '0.5' row on a decimals=0
        // tick would otherwise report a full unit taken while only half a unit left the row.
        const db = makeDb('regtest');
        const updates = [];
        sinon.stub(db, 'getStatusId').callsFake(async (s) => (s === 'valid' ? 1 : (s === 'pending' ? 2 : null)));
        sinon.stub(db, 'getTokenDecimalPrecision').resolves(0);
        sinon.stub(db, 'createContractSlashDebit').resolves();
        sinon.stub(db, 'doQuery').callsFake(async (sql, args) => {
            if (/SELECT[\s\S]*FROM\s+contract_stakes/i.test(sql))
                return [{ action_index: 7, amount: '0.5', source_address: 'staker1' }];
            if (/SELECT[\s\S]*FROM\s+contract_unstakes/i.test(sql)) return [];
            if (/UPDATE\s+contract_stakes\s+SET amount=\?/i.test(sql)) updates.push(String(args[0]));
            return [];
        });

        const res = await db.slashContractStake(1, 10, 1, '1', 500, 99, 0);

        assert.strictEqual(String(res.total), '0.5', 'credits the half unit the row actually held');
        assert.deepStrictEqual(updates, ['0']);
        assert.strictEqual(String(res.releases[0].amount), '0.5');
    });

    it('ACTIVE: an on-grid slash is arithmetically unchanged from the legacy path', async function () {
        const run = async (network) => {
            const db = makeDb(network);
            const updates = [];
            sinon.stub(db, 'getStatusId').callsFake(async (s) => (s === 'valid' ? 1 : (s === 'pending' ? 2 : null)));
            sinon.stub(db, 'getTokenDecimalPrecision').resolves(8);
            sinon.stub(db, 'createContractSlashDebit').resolves();
            sinon.stub(db, 'doQuery').callsFake(async (sql, args) => {
                if (/SELECT[\s\S]*FROM\s+contract_stakes/i.test(sql))
                    return [{ action_index: 7, amount: '100.00000000', source_address: 'staker1' }];
                if (/SELECT[\s\S]*FROM\s+contract_unstakes/i.test(sql)) return [];
                if (/UPDATE\s+contract_stakes\s+SET amount=\?/i.test(sql)) updates.push(String(args[0]));
                return [];
            });
            const res = await db.slashContractStake(1, 10, 1, '30.12345678', 500, 99, 0);
            const out = { total: String(res.total), updates, releases: res.releases.map(r => String(r.amount)) };
            sinon.restore();
            return out;
        };
        assert.deepStrictEqual(await run('regtest'), await run('mainnet'));
    });
});
