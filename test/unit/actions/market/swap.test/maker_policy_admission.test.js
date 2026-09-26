// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
const sinon = require('sinon');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../../fixtures/mocks');
const Swap = require('../../../../../src/actions/swap/index.js');

const VALID_GET_ADDRESS = 'mqmJDcs5nXFHrj9q7a2G5sBVmjcQTDdUZp';
const FUTURE_EXPIRATION = 9999999999;

let indexer;
let handler;

function setupSwap() {
    indexer = createMockIndexer();
    const actionsCtx = {
        config: indexer.config,
        util: indexer.util,
        mapper: indexer.mapper,
        decoderDb: indexer.decoderDb,
        indexerDb: indexer.indexerDb,
        protocolChanges: {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        },
        processAction: sinon.stub().resolves(),
    };
    handler = new Swap(actionsCtx);
    indexer.util.resetLists();
    const giveToken = createTokenInfo({ TICK: 'GIVE', TICK_ID: 1, DECIMALS: 0 });
    const getToken = createTokenInfo({ TICK: 'GET', TICK_ID: 2, DECIMALS: 0 });
    indexer.indexerDb.getTokenInfo.callsFake(async (tick) => {
        if (tick === 'GIVE') return giveToken;
        if (tick === 'GET') return getToken;
        return null;
    });
    indexer.indexerDb.getAddressBalances.resolves({ 1: '1000', 2: '1000', 99: '1000' });
    indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
    indexer.indexerDb.getTickerId.resolves(99);
}

function makerParams() {
    return ['0', 'BTC', 'GIVE', '10', '', 'BTC', 'GET', '5', '', VALID_GET_ADDRESS,
        String(FUTURE_EXPIRATION), '', '', ''];
}

describe('Swap action handler maker policy admission @regression @tier2', function () {
    beforeEach(setupSwap);
    afterEach(() => sinon.restore());

    it('rejects a maker GET_ADDRESS forbidden by the GIVE token policy after activation', async function () {
        indexer.indexerDb.isActionAllowed.withArgs(VALID_GET_ADDRESS, 'GIVE').resolves(false);
        const data = createBaseData({ ACTION: 'SWAP', FORMAT: 0, BLOCK_TIME: 1700000000 });
        await handler.parse(makerParams(), data, null);
        assert.strictEqual(data['STATUS'], 'invalid: GET_ADDRESS (not authorized for GIVE_TICK)');
        sinon.assert.notCalled(indexer.indexerDb.updateBalances);
    });

    it('rejects a maker GET_ADDRESS forbidden by the GET token policy after activation', async function () {
        indexer.indexerDb.isActionAllowed.withArgs(VALID_GET_ADDRESS, 'GET').resolves(false);
        const data = createBaseData({ ACTION: 'SWAP', FORMAT: 0, BLOCK_TIME: 1700000000 });
        await handler.parse(makerParams(), data, null);
        assert.strictEqual(data['STATUS'], 'invalid: GET_ADDRESS (not authorized for GET_TICK)');
        sinon.assert.notCalled(indexer.indexerDb.updateBalances);
    });

    it('preserves legacy admission below the maker policy gate', async function () {
        indexer.config['NETWORK'] = 'mainnet';
        indexer.indexerDb.isActionAllowed.withArgs(VALID_GET_ADDRESS, 'GIVE').resolves(false);
        indexer.indexerDb.isActionAllowed.withArgs(VALID_GET_ADDRESS, 'GET').resolves(false);
        const data = createBaseData({ ACTION: 'SWAP', FORMAT: 0, BLOCK_TIME: 1700000000 });
        await handler.parse(makerParams(), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        sinon.assert.calledOnce(indexer.indexerDb.updateBalances);
    });
});
