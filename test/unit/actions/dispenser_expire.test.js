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
const sinon = require('sinon');
const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Dispenser_Expire = require('../../../src/actions/dispenser_expire.js');

describe('Dispenser_Expire action handler @regression @tier2', function () {
    let indexer, actionsCtx, handler;

    function makeDispenser(overrides) {
        return {
            ACTION_INDEX: 50,
            SOURCE: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
            GIVE_TICK: 'TEST',
            GIVE_REMAINING: '200',
            GET_ADDRESS: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
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
        handler = new Dispenser_Expire(actionsCtx);
        indexer.util.resetLists();
    });

    it('does nothing when dispenser is not found', async function () {
        indexer.indexerDb.getDispenserInfo.resolves(null);
        const data = createBaseData({ ACTION: 'DISPENSER_EXPIRE', ACTION_INDEX: 50, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        assert.ok(indexer.indexerDb.createDispenserExpire.notCalled);
        assert.ok(indexer.indexerDb.createDispenserStatus.notCalled);
    });

    it('creates a dispenser_expire record when dispenser exists', async function () {
        const dispenser = makeDispenser();
        indexer.indexerDb.getDispenserInfo.resolves(dispenser);
        const data = createBaseData({ ACTION: 'DISPENSER_EXPIRE', ACTION_INDEX: 50, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        assert.ok(indexer.indexerDb.createDispenserExpire.calledOnce);
    });

    it('creates an expired status record', async function () {
        const dispenser = makeDispenser();
        indexer.indexerDb.getDispenserInfo.resolves(dispenser);
        const data = createBaseData({ ACTION: 'DISPENSER_EXPIRE', ACTION_INDEX: 50, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        const statusCall = indexer.indexerDb.createDispenserStatus.getCall(0);
        assert.ok(statusCall, 'createDispenserStatus should have been called');
        assert.strictEqual(statusCall.args[2], 'expired');
    });

    it('credits GIVE_REMAINING back to SOURCE on expiry', async function () {
        const dispenser = makeDispenser({ GIVE_REMAINING: '123' });
        indexer.indexerDb.getDispenserInfo.resolves(dispenser);
        const data = createBaseData({ ACTION: 'DISPENSER_EXPIRE', ACTION_INDEX: 50, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        // The SOURCE address should be tracked in the addresses list
        const addresses = indexer.util.getAddressesList();
        assert.ok(Object.keys(addresses).includes(dispenser['SOURCE']), 'SOURCE should be tracked for balance update');
    });

    it('calls updateBalances after processing', async function () {
        const dispenser = makeDispenser();
        indexer.indexerDb.getDispenserInfo.resolves(dispenser);
        const data = createBaseData({ ACTION: 'DISPENSER_EXPIRE', ACTION_INDEX: 50, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        assert.ok(indexer.indexerDb.updateBalances.calledOnce);
    });

    it('calls mapper.createMappings after processing', async function () {
        const dispenser = makeDispenser();
        indexer.indexerDb.getDispenserInfo.resolves(dispenser);
        const data = createBaseData({ ACTION: 'DISPENSER_EXPIRE', ACTION_INDEX: 50, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        assert.ok(indexer.mapper.createMappings.calledOnce);
    });
});
