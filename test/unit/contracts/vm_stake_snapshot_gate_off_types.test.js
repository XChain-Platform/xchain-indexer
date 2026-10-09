// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Pin the VM stake-read types and bytes before STAKE_SNAPSHOT_DECIMAL_STRINGS is enabled.

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');
const path   = require('path');
const sinon  = require('sinon');

const { getTestConfig } = require('../../fixtures/config');
const Utility           = require('../../../src/utility');
const Database          = require('../../../src/db');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');

const PUBKEYS = {
    eightA: '11'.repeat(32),
    eightB: '22'.repeat(32),
    wideA:  '33'.repeat(32),
    wideB:  '44'.repeat(32),
};

const STAKE_ROWS = [
    stakeRow(11, PUBKEYS.eightA, 8, 'EIGHT', '1.25000000'),
    stakeRow(12, PUBKEYS.eightB, 8, 'EIGHT', '2.50000000'),
    stakeRow(13, PUBKEYS.wideA, 18, 'WIDE', '4.000000000000000001'),
    stakeRow(14, PUBKEYS.wideB, 18, 'WIDE', '0.000000000000000003'),
];

const CONTRACT_CODE = `module.exports = function(xchain) {
    function read(token, pubkeys) {
        var total = xchain.contract.getTotalStaked(token);
        return {
            stakes: pubkeys.map(function(pubkey) {
                var value = xchain.contract.getStake(pubkey, token);
                return { pubkey: pubkey, type: typeof value, value: value };
            }),
            total: { type: typeof total, value: total },
            stakers: xchain.contract.getStakers(token).map(function(staker) {
                return { pubkey: staker.pubkey, amount: { type: typeof staker.amount, value: staker.amount } };
            })
        };
    }
    return {
        eight: read('EIGHT', ${JSON.stringify([PUBKEYS.eightA, PUBKEYS.eightB])}),
        wide: read('WIDE', ${JSON.stringify([PUBKEYS.wideA, PUBKEYS.wideB])})
    };
};`;

const SNAPSHOT_GOLDEN = JSON.stringify({
    stakeByPubkeyTick: {
        [PUBKEYS.eightA + '|EIGHT']: bigNumber('1.25'),
        [PUBKEYS.eightB + '|EIGHT']: bigNumber('2.5'),
        [PUBKEYS.wideA + '|WIDE']: bigNumber('4.000000000000000001'),
        [PUBKEYS.wideB + '|WIDE']: bigNumber('3e-18'),
    },
    totalByTick: { EIGHT: bigNumber('3.75'), WIDE: bigNumber('4.000000000000000004') },
    stakersByTick: {
        EIGHT: [staker(PUBKEYS.eightB, '2.5'), staker(PUBKEYS.eightA, '1.25')],
        WIDE: [staker(PUBKEYS.wideA, '4.000000000000000001'), staker(PUBKEYS.wideB, '3e-18')],
    },
});

const VM_GOLDEN = JSON.stringify({
    eight: vmTick(
        [vmStake(PUBKEYS.eightA, '1.25'), vmStake(PUBKEYS.eightB, '2.5')],
        '3.75',
        [vmStaker(PUBKEYS.eightB, '2.5'), vmStaker(PUBKEYS.eightA, '1.25')]
    ),
    wide: vmTick(
        [vmStake(PUBKEYS.wideA, '4.000000000000000001'), vmStake(PUBKEYS.wideB, '0.000000000000000003')],
        '4.000000000000000004',
        [vmStaker(PUBKEYS.wideA, '4.000000000000000001'), vmStaker(PUBKEYS.wideB, '3e-18')]
    ),
});

function bigNumber(value) {
    return { mathjs: 'BigNumber', value };
}

function stakeRow(signing_pubkey_id, pubkey, tick_id, tick, amount) {
    return { signing_pubkey_id, pubkey, tick_id, tick, amount,
             activation_block: 1, deactivation_block: null };
}

function staker(pubkey, amount) {
    return { pubkey, amount: bigNumber(amount) };
}

function vmStake(pubkey, value) {
    return { pubkey, type: 'string', value };
}

function vmStaker(pubkey, value) {
    return { pubkey, amount: { type: 'object', value: bigNumber(value) } };
}

function vmTick(stakes, total, stakers) {
    return { stakes, total: { type: 'object', value: bigNumber(total) }, stakers };
}

function makeDb() {
    const config = getTestConfig();
    const util = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    db.pool = { getConnection: sinon.stub().resolves({
        query: sinon.stub().resolves([]), release: sinon.stub().resolves(),
    }) };
    sinon.stub(db, 'getStatusId').resolves(1);
    sinon.stub(db, 'doQuery').resolves(STAKE_ROWS);
    sinon.stub(db, 'getTokenDecimalPrecision').callsFake(async tickId => tickId);
    return db;
}

function resolveVm() {
    let verdict;
    try {
        verdict = siblingCheckout(__dirname, require.resolve('xchain-vm/package.json'));
    } catch (e) {
        verdict = siblingCheckout(__dirname, '../../../../xchain-vm/package.json');
    }
    if (!verdict.usable) return verdict;
    try {
        return { usable: true, XChainVM: require(path.dirname(verdict.path)), reason: null };
    } catch (e) {
        return { usable: false, reason: 'xchain-vm did not load: ' + e.message };
    }
}

async function runContract(XChainVM, snapshot) {
    const vm = new XChainVM({
        execution: 'in-process', gasSchedule: getTestConfig()['GAS_SCHEDULE'], gasCeiling: 1000000,
    });
    vm.beginBlock();
    try {
        return await vm.execute({
            code: CONTRACT_CODE, state: {}, method: 'default', params: [], caller: 'gate-off-probe',
            contractAddress: 'C:BTC:42', contractIndex: 42,
            blockContext: { height: 306, timestamp: 1700000000, hash: 'gate-off-probe' },
            contractStakeData: snapshot,
        });
    } finally {
        vm.endBlock();
        await vm.shutdown();
    }
}

afterEach(function () { sinon.restore(); });

describe('VM stake snapshot decimal-string gate off @regression @tier1', function () {
    this.timeout(30000);

    it('pins snapshot JSON and the real VM stake-read types and values', async function () {
        const vm = resolveVm();
        if (!skipOrFail(this, vm, 'the VM stake snapshot gate-off characterization')) return;
        const db = makeDb();

        const snapshot = await db.getContractStakeDataForVM(42, 306, false);
        assert.strictEqual(JSON.stringify(snapshot), SNAPSHOT_GOLDEN);

        const result = await runContract(vm.XChainVM, snapshot);
        assert.strictEqual(result.success, true, result.error);
        assert.strictEqual(result.returnValue, VM_GOLDEN);
    });
});
