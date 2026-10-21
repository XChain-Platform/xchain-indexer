// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const { createBaseData } = require('../../../../fixtures/mocks');
const { useBatchHarness } = require('./helpers/batch_harness.js');
const gateRegistry = require('../../../../../src/consensus/gate_registry');

const GATE = 'batch_airdrop_leg_weight_activation.BATCH_AIRDROP_LEG_WEIGHT_ACTIVATION';

let indexer, handler;
const bind = (h) => { ({ indexer, handler } = h); };

const commands = {
    format0: 'AIRDROP|0|T0|1|10|memo',
    format1: 'AIRDROP|1|10|T0|1|T1|2|memo',
    format2: 'AIRDROP|2|T0|1|10|T1|2|11|memo',
    format3: 'AIRDROP|3|T0|1|10|m0|T1|2|11|m1',
};

describe('BATCH AIRDROP per-leg weight @regression @tier3', function () {
    useBatchHarness(bind);

    it('uses the registered height gate at the exact regtest boundary', function () {
        assert.strictEqual(gateRegistry.activeAt(GATE, 'regtest', 'BTC', -1, null), false);
        assert.strictEqual(gateRegistry.activeAt(GATE, 'regtest', 'BTC', 0, null), true);
        assert.strictEqual(gateRegistry.activeAt(GATE, 'regtest', 'BTC', 1, null), true);
        assert.strictEqual(gateRegistry.activeAt(GATE, 'mainnet', 'BTC', 100, null), false);
        assert.strictEqual(gateRegistry.activeAt(GATE, 'testnet', 'DOGE', 100, null), false);
    });

    it('charges format 0 once and formats 1 to 3 once per decoded leg', async function () {
        const data = createBaseData();
        assert.strictEqual(await handler.subCommandWeight('AIRDROP', commands.format0, data, true), 25);
        assert.strictEqual(await handler.subCommandWeight('AIRDROP', commands.format1, data, true), 50);
        assert.strictEqual(await handler.subCommandWeight('AIRDROP', commands.format2, data, true), 50);
        assert.strictEqual(await handler.subCommandWeight('AIRDROP', commands.format3, data, true), 50);
    });

    it('keeps the historical flat weight immediately below activation', async function () {
        const below = createBaseData({ BLOCK_INDEX: -1 });
        const at = createBaseData({ BLOCK_INDEX: 0 });

        assert.strictEqual(await handler.subCommandWeight('AIRDROP', commands.format3, below, true), 25);
        assert.strictEqual(await handler.subCommandWeight('AIRDROP', commands.format3, at, true), 50);
    });

    it('counts eleven format 1 legs without resolving a list', async function () {
        const fields = ['AIRDROP', '1', '10'];
        for(let i = 0; i < 11; i++) fields.push('T' + i, String(i + 1));
        fields.push('memo');

        assert.strictEqual(
            await handler.subCommandWeight('AIRDROP', fields.join('|'), createBaseData(), true),
            275);
        assert.strictEqual(indexer.indexerDb.getTokenInfo.callCount, 0);
        assert.strictEqual(indexer.indexerDb.getAddressBalances.callCount, 0);
    });

    it('keeps DIVIDEND and malformed AIRDROP at one table-weight unit', async function () {
        const data = createBaseData();
        assert.strictEqual(await handler.subCommandWeight('DIVIDEND', 'DIVIDEND|0|T0|PAY|1|memo', data, true), 25);
        assert.strictEqual(await handler.subCommandWeight('AIRDROP', 'AIRDROP|9|not|a|format', data, true), 25);
        assert.strictEqual(await handler.subCommandWeight('AIRDROP', 'AIRDROP|2', data, true), 25);
    });
});
