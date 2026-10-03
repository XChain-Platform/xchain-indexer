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

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');
const { stubGate } = require('../../helpers/gate_modules.js');
const Database = require('../../../src/db');
const Swap_Match = require('../../../src/actions/swap_match/index.js');
const gateRegistry = require('../../../src/consensus/gate_registry');

const GATE_KEY = 'swap_edit_rematch_activation.SWAP_EDIT_REMATCH_ACTIVATION';
const RESTING_ACTION_INDEX = 10;
const EDIT_ACTION_INDEX = 22;

function restingSwap() {
    return {
        ACTION_INDEX: RESTING_ACTION_INDEX,
        SOURCE: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
        SWAP_STATUS: 'open',
        GIVE_COIN: 'BTC',
        GIVE_TICK: 'GIVE',
        GIVE_AMOUNT: '10',
        GET_COIN: 'BTC',
        GET_TICK: 'GET',
        GET_AMOUNT: '5',
    };
}

function setup() {
    const indexer = createMockIndexer();
    indexer.indexerDb.findSwapMatches = Database.prototype.findSwapMatches;
    indexer.indexerDb.getSwapInfo.resolves(restingSwap());
    indexer.indexerDb.createAddress.resolves(7);
    indexer.indexerDb.doQuery.resolves([]);
    const handler = new Swap_Match({
        config: indexer.config,
        util: indexer.util,
        mapper: indexer.mapper,
        decoderDb: indexer.decoderDb,
        indexerDb: indexer.indexerDb,
    });
    const edit = createBaseData({
        ACTION: 'SWAP',
        ACTION_INDEX: EDIT_ACTION_INDEX,
        SWAP_ACTION_INDEX: RESTING_ACTION_INDEX,
        BLOCK_INDEX: 200,
    });
    return { indexer, handler, edit };
}

describe('SWAP edit rematch activation @regression @tier2', function () {
    afterEach(function () { sinon.restore(); });

    it('is armed from genesis on regtest, unarmed on mainnet and armed on every testnet chain at the v0.21.3 heights', function () {
        assert.strictEqual(gateRegistry.activeAt(GATE_KEY, 'regtest', 'BTC', 0, null), true);
        assert.strictEqual(gateRegistry.activeAt(GATE_KEY, 'mainnet', 'BTC', 1_000_000_000, null), false);
        assert.strictEqual(gateRegistry.activeAt(GATE_KEY, 'testnet', null, 1_000_000_000, null), false);
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            assert.strictEqual(gateRegistry.activeAt(GATE_KEY, 'testnet', coin, 1_000_000_000, null), true);
        }
        assert.strictEqual(gateRegistry.activeAt(GATE_KEY, 'testnet', 'BTC', 154970, null), false);
    });

    for (const [armed, expectedActionIndex] of [[true, RESTING_ACTION_INDEX], [false, EDIT_ACTION_INDEX]]) {
        it(`binds the ${armed ? 'resting swap' : 'edit'} ACTION_INDEX when ${armed ? 'armed' : 'unarmed'}`, async function () {
            stubGate(sinon, GATE_KEY, armed);
            const { indexer, handler, edit } = setup();

            await handler.parse(null, edit, null);

            sinon.assert.calledWith(indexer.indexerDb.getSwapInfo, 'BTC', RESTING_ACTION_INDEX);
            sinon.assert.calledOnce(indexer.indexerDb.doQuery);
            assert.deepStrictEqual(indexer.indexerDb.doQuery.firstCall.args[1], [expectedActionIndex, 7]);
        });
    }
});
