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
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN = process.env.INDEXER_COIN || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const { getTestConfig } = require('../../fixtures/config.js');
const Utility = require('../../../src/utility.js');
const Database = require('../../../src/db/index.js');

const PUBKEY_A = '11'.repeat(32);
const PUBKEY_B = '22'.repeat(32);
const ROWS = [
    row(11, PUBKEY_A, '4.000000000000000001'),
    row(11, PUBKEY_A, '0.000000000000000002'),
    row(12, PUBKEY_B, '0.000000000000000003'),
];

function row(signing_pubkey_id, pubkey, amount) {
    return {
        action_index: signing_pubkey_id,
        signing_pubkey_id,
        pubkey,
        tick_id: 18,
        tick: 'WIDE',
        amount,
        activation_block: 1,
        deactivation_block: null,
    };
}

function makeDb() {
    const util = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', {
        config: getTestConfig(),
        util,
    });
    db.pool = { getConnection: sinon.stub().resolves({
        query: sinon.stub().resolves([]),
        release: sinon.stub().resolves(),
    }) };
    sinon.stub(db, 'getStatusId').resolves(1);
    sinon.stub(db, 'doQuery').resolves(ROWS);
    sinon.stub(db, 'getTokenDecimalPrecision').resolves(18);
    return db;
}

function amounts(snapshot) {
    return [
        ...Object.values(snapshot.stakeByPubkeyTick),
        ...Object.values(snapshot.totalByTick),
        ...Object.values(snapshot.stakersByTick).flat().map(staker => staker.amount),
    ];
}

afterEach(function () { sinon.restore(); });

describe('getContractStakeDataForVM decimal strings @regression @tier1', function () {
    it('returns only canonical plain-decimal amount strings once active', async function () {
        const snapshot = await makeDb().getContractStakeDataForVM(42, 306, false, true);

        assert.deepStrictEqual(snapshot, {
            stakeByPubkeyTick: {
                [PUBKEY_A + '|WIDE']: '4.000000000000000003',
                [PUBKEY_B + '|WIDE']: '0.000000000000000003',
            },
            totalByTick: { WIDE: '4.000000000000000006' },
            stakersByTick: { WIDE: [
                { pubkey: PUBKEY_A, amount: '4.000000000000000003' },
                { pubkey: PUBKEY_B, amount: '0.000000000000000003' },
            ] },
        });
        assert.ok(amounts(snapshot).every(amount => typeof amount === 'string'));
        assert.ok(amounts(snapshot).every(amount => !/[eE]/.test(amount)));
    });

    it('preserves legacy BigNumber amounts before activation', async function () {
        const snapshot = await makeDb().getContractStakeDataForVM(42, 306, false, false);

        assert.ok(amounts(snapshot).every(amount => amount && typeof amount === 'object'));
        assert.ok(amounts(snapshot).every(amount => amount.isBigNumber === true));
        assert.strictEqual(snapshot.totalByTick.WIDE.toFixed(), '4.000000000000000006');
    });
});
