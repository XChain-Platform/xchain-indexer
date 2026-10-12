/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * A contract's stake snapshot omits rows whose activation block is still in
 * the future. The legacy slash LIFO nevertheless selected a newer pending row
 * before the active stake the contract saw. The gate makes Pass 1 consume
 * active rows first, then pending rows, before Pass 2 reaches cooldown rows.
 *
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const { getTestConfig } = require('../../fixtures/config');
const Utility = require('../../../src/utility');
const Database = require('../../../src/db');
const ProtocolChanges = require('../../../src/protocol_changes');

const KEY = 'contract_slash_active_first_activation.CONTRACT_SLASH_ACTIVE_FIRST_ACTIVATION';

function makeDb(network, rows, updates) {
    const config = Object.assign({}, getTestConfig(), { NETWORK: network, COIN: 'BTC' });
    const util = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    sinon.stub(db, 'getStatusId').callsFake(async (status) => status === 'valid' ? 1 : status === 'pending' ? 2 : null);
    sinon.stub(db, 'getTokenDecimalPrecision').resolves(8);
    sinon.stub(db, 'createContractSlashDebit').resolves();
    sinon.stub(db, 'doQuery').callsFake(async (sql, args) => {
        if (/FROM contract_stakes/.test(sql)) {
            const ordered = rows.map((row) => Object.assign({ source_address: 'owner' }, row));
            if (/activation_block <= \?/.test(sql)) {
                const blockIndex = args[args.length - 1];
                ordered.sort((a, b) => Number(b.activation_block <= blockIndex) - Number(a.activation_block <= blockIndex)
                    || b.action_index - a.action_index);
            } else {
                ordered.sort((a, b) => b.action_index - a.action_index);
            }
            return ordered;
        }
        if (/FROM contract_unstakes/.test(sql)) return [];
        if (/^UPDATE contract_stakes/.test(sql)) updates.push({ amount: String(args[0]), actionIndex: args[1] });
        return [];
    });
    return db;
}

afterEach(function () { sinon.restore(); });

describe('slashContractStake active-first gate @regression @tier1', function () {
    const rows = [
        { action_index: 10, amount: '100', activation_block: 90 },
        { action_index: 20, amount: '25', activation_block: 110 },
    ];

    it('is armed on regtest and at the per-chain testnet cut, while mainnet stays inert', function () {
        const row = ProtocolChanges.get(KEY);
        assert.strictEqual(ProtocolChanges.activeAt(KEY, 'regtest', 'BTC', 0, null), true);
        assert.strictEqual(ProtocolChanges.activeAt(KEY, 'mainnet', 'BTC', 9999999998, null), false);
        assert.strictEqual(ProtocolChanges.activeAt(KEY, 'testnet', 'BTC', row['BTC:testnet'] - 1, null), false);
        assert.strictEqual(ProtocolChanges.activeAt(KEY, 'testnet', 'BTC', row['BTC:testnet'], null), true);
    });

    it('armed: debits visible active stake before a newer pending-activation row', async function () {
        const updates = [];
        const result = await makeDb('regtest', rows, updates).slashContractStake(1, 5, 3, '40', 100, 50, 0);
        assert.strictEqual(String(result.total), '40');
        assert.deepStrictEqual(updates, [{ amount: '60', actionIndex: 10 }]);
    });

    it('armed: falls through to pending stake only after exhausting active stake', async function () {
        const updates = [];
        const result = await makeDb('regtest', rows, updates).slashContractStake(1, 5, 3, '110', 100, 50, 0);
        assert.strictEqual(String(result.total), '110');
        assert.deepStrictEqual(updates, [
            { amount: '0', actionIndex: 10 },
            { amount: '15', actionIndex: 20 },
        ]);
    });

    it('legacy: keeps action-index LIFO and therefore debits pending stake first', async function () {
        const updates = [];
        const result = await makeDb('mainnet', rows, updates).slashContractStake(1, 5, 3, '20', 100, 50, 0);
        assert.strictEqual(String(result.total), '20');
        assert.deepStrictEqual(updates, [{ amount: '5', actionIndex: 20 }]);
    });
});
