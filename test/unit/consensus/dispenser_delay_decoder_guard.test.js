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
 *
 * Decoder coupling guard for the dispenser delay protocol-time arm.
 *
 * The decoder hands the indexer rows stamped with the RAW block timestamp,
 * which a miner chooses and which can run hours ahead of the median time past.
 * Once DISPENSER_DELAY_PROTOCOL_TIME_ACTIVATION is armed, the list and close
 * delays must be measured from the protocol time of the stored block and never
 * from the decoder's raw stamp. These tests pin that coupling, and pin that the
 * gate rows arm testnet (per chain) while leaving mainnet inert.
 *
 *********************************************************************/

'use strict';

const assert = require('assert');
const sinon  = require('sinon');

const dispensers   = require('../../../src/db/dispensers/index.js');
const gateRegistry = require('../../../src/consensus/gate_registry');
const protocolTime = require('../../../src/consensus/protocol_time');

const GATE = 'dispenser_delay_protocol_time_activation.DISPENSER_DELAY_PROTOCOL_TIME_ACTIVATION';
const COIN_ARM = { 'BTC:testnet': 156230, 'LTC:testnet': 4912984, 'DOGE:testnet': 67989993 };

// Raw decoder stamp far ahead of the protocol time the stored block resolves to.
const RAW_STAMP = 10000;
const PROTOCOL_STAMP = 500;

function dbFor(rows, protocolTimeFor) {
    return {
        config: { NETWORK: 'regtest', COIN: 'BTC', DISPENSER_LIST_DELAY: 100, DISPENSER_CLOSE_DELAY: 100 },
        util: {
            bcgt: (a, b) => Number(a) > Number(b),
            bcadd: (a, b) => String(Number(a) + Number(b)),
            isNull: value => value === null || value === undefined,
            isNumeric: value => value !== null && value !== '' && !isNaN(Number(value)),
        },
        doQuery: sinon.stub().resolves(rows),
        protocolTimeForStoredBlock: sinon.stub().callsFake(async index => protocolTimeFor(index)),
    };
}

describe('dispenser delay decoder coupling guard @regression @tier1', function () {

    it('arms testnet per chain and leaves mainnet inert', function () {
        for (const [key, height] of Object.entries(COIN_ARM)) {
            const [coin, network] = key.split(':');
            assert.strictEqual(gateRegistry.activeAt(GATE, network, coin, height - 1, null), false, key + ' before');
            assert.strictEqual(gateRegistry.activeAt(GATE, network, coin, height, null), true, key + ' at');
        }
        assert.strictEqual(gateRegistry.activeAt(GATE, 'mainnet', 'BTC', 99999999, null), false);
        assert.strictEqual(gateRegistry.activeAt(GATE, 'regtest', 'BTC', 0, null), true);
    });

    it('measures the list delay from protocol time, not the decoder raw stamp', async function () {
        const rows = [{ expiration: null, allow_list: 5, block_list: null, block_time: RAW_STAMP, block_index: 7 }];
        const db = dbFor(rows, () => PROTOCOL_STAMP);

        // 700 > 500 + 100 holds on protocol time, while 700 > 10000 + 100 would not.
        const edit = await dispensers.getDispenserEdits.call(db, 1, 700, 20);

        assert.strictEqual(edit.allow_list, 5);
        sinon.assert.calledOnceWithExactly(db.protocolTimeForStoredBlock, 7);
    });

    it('measures the close delay from protocol time, not the decoder raw stamp', async function () {
        const rows = [{ action_index: 9, block_time: RAW_STAMP, block_index: 7 }];
        const db = dbFor(rows, () => PROTOCOL_STAMP);

        const cancels = await dispensers.findCancelledDispensers.call(db, 700, 20);

        assert.deepStrictEqual(cancels, [9]);
        sinon.assert.calledOnceWithExactly(db.protocolTimeForStoredBlock, 7);
    });

    it('treats an unresolvable stored block as not yet elapsed instead of falling back to the raw stamp', async function () {
        const rows = [
            { expiration: null, allow_list: 5, block_list: null, block_time: 1, block_index: 7 },
        ];
        const db = dbFor(rows, () => null);

        const edit = await dispensers.getDispenserEdits.call(db, 1, 700, 20);

        // The raw stamp 1 would have elapsed long ago; the guard must not read it.
        assert.strictEqual(edit.allow_list, false);
    });

    it('keeps the decoder raw stamp when the gate is not active at the height', async function () {
        const rows = [{ expiration: null, allow_list: 5, block_list: null, block_time: RAW_STAMP, block_index: 7 }];
        const db = dbFor(rows, () => PROTOCOL_STAMP);
        db.config.NETWORK = 'mainnet';

        const edit = await dispensers.getDispenserEdits.call(db, 1, 700, 20);

        assert.strictEqual(edit.allow_list, false);
        sinon.assert.notCalled(db.protocolTimeForStoredBlock);
    });

    it('stamps decoder rows with the resolved protocol time at the one entry seam', function () {
        const txs = [{ tx_index: 1, block_time: RAW_STAMP }, { tx_index: 2, block_time: RAW_STAMP }];

        assert.strictEqual(protocolTime.stampProtocolTime(txs, PROTOCOL_STAMP), 2);
        assert.deepStrictEqual(txs.map(tx => tx.block_time), [PROTOCOL_STAMP, PROTOCOL_STAMP]);

        const untouched = [{ tx_index: 3, block_time: RAW_STAMP }];
        assert.strictEqual(protocolTime.stampProtocolTime(untouched, false), 0);
        assert.strictEqual(untouched[0].block_time, RAW_STAMP);
    });
});
