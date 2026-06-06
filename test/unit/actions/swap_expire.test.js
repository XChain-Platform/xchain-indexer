// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Swap_Expire = require('../../../src/actions/swap_expire.js');

describe('Swap_Expire action handler @regression @tier2', function () {
    let indexer, actionsCtx, handler;

    function makeSwapInfo(overrides) {
        return {
            ACTION_INDEX: 10,
            SOURCE: '1SourceAddressXXXXXXXXXXXXXXXYs6gYt',
            GIVE_TICK: 'TEST',
            GIVE_AMOUNT: '100',
            GIVE_REMAINING: '80',
            GET_TICK: 'OTHER',
            GET_ADDRESS: '1SourceAddressXXXXXXXXXXXXXXXYs6gYt',
            ...overrides,
        };
    }

    beforeEach(function () {
        indexer = createMockIndexer();
        actionsCtx = {
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
        handler = new Swap_Expire(actionsCtx);
        indexer.util.resetLists();
    });

    it('returns early when swapInfo is null (already expired or rolled back)', async function () {
        indexer.indexerDb.getSwapInfo.resolves(null);
        const data = createBaseData({ ACTION: 'SWAP_EXPIRE', ACTION_INDEX: 10, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        assert.ok(indexer.indexerDb.createSwapExpire.notCalled);
        assert.ok(indexer.indexerDb.createSwapStatus.notCalled);
    });

    it('credits GIVE_REMAINING back to SOURCE on expiry', async function () {
        const swapInfo = makeSwapInfo({ GIVE_REMAINING: '80' });
        indexer.indexerDb.getSwapInfo.resolves(swapInfo);
        const data = createBaseData({ ACTION: 'SWAP_EXPIRE', ACTION_INDEX: 10, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        assert.ok(indexer.indexerDb.createSwapExpire.calledOnce);
    });

    it('creates an expired status record', async function () {
        const swapInfo = makeSwapInfo();
        indexer.indexerDb.getSwapInfo.resolves(swapInfo);
        const data = createBaseData({ ACTION: 'SWAP_EXPIRE', ACTION_INDEX: 10, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        const statusCall = indexer.indexerDb.createSwapStatus.getCall(0);
        assert.ok(statusCall, 'createSwapStatus should have been called');
        assert.strictEqual(statusCall.args[2], 'expired');
    });

    it('calls updateBalances after processing', async function () {
        const swapInfo = makeSwapInfo();
        indexer.indexerDb.getSwapInfo.resolves(swapInfo);
        const data = createBaseData({ ACTION: 'SWAP_EXPIRE', ACTION_INDEX: 10, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        assert.ok(indexer.indexerDb.updateBalances.calledOnce);
    });

    it('calls mapper.createMappings after processing', async function () {
        const swapInfo = makeSwapInfo();
        indexer.indexerDb.getSwapInfo.resolves(swapInfo);
        const data = createBaseData({ ACTION: 'SWAP_EXPIRE', ACTION_INDEX: 10, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        assert.ok(indexer.mapper.createMappings.calledOnce);
    });
});
