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
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');

const List = require('../../../src/actions/list.js');

describe('List @regression @tier3', function () {
    let indexer, actionsCtx, handler;

    const SOURCE  = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
    const ADDR1   = 'mmqFL1hiu2RDuyS69KS9ko6uaMryhANwsz';
    const ADDR2   = 'mk7MdP3qzVkgyjaYNR2sUY8Ggn4DWxt2KS';

    beforeEach(function () {
        indexer = createMockIndexer();
        actionsCtx = {
            config:          indexer.config,
            util:            indexer.util,
            mapper:          indexer.mapper,
            decoderDb:       indexer.decoderDb,
            indexerDb:       indexer.indexerDb,
            protocolChanges: {
                isDefined:  sinon.stub().returns(true),
                isEnabled:  sinon.stub().resolves(true),
            },
            processAction:   sinon.stub().resolves(),
        };
        handler = new List(actionsCtx);
        indexer.util.resetLists();
    });

    afterEach(function () {
        sinon.restore();
    });

    describe('format 0: create LIST', function () {

        it('create address list: createList, createListItem called for each address', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 0, SOURCE });
            // TYPE=2 (address), items are ADDR1 and ADDR2
            const params = ['0', '2', ADDR1, ADDR2];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createList.called, 'createList should be called');
            assert.ok(indexer.indexerDb.createListItem.callCount >= 2, 'createListItem called for each address');
        });

        it('create tick list: createList, createListItem called for each tick', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1 });
            indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 0, SOURCE });
            // TYPE=1 (tick), item is TEST
            const params = ['0', '1', 'TEST'];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createList.called);
            assert.ok(indexer.indexerDb.createListItem.called);
        });

        it('unknown TYPE → invalid', async function () {
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 0, SOURCE });
            const params = ['0', '99', ADDR1];  // TYPE=99 is unknown

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

        it('unknown format version → invalid', async function () {
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 99, SOURCE });
            const params = ['99', '2', ADDR1];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

    });

    describe('format 1: edit LIST', function () {

        it('add address to existing list: createListEdit called', async function () {
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves([ADDR1]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 1, SOURCE });
            // FORMAT 1: VERSION|EDIT|LIST_ACTION_INDEX|ITEM...
            // EDIT=1 (add), LIST_ACTION_INDEX=5
            const params = ['1', '1', '5', ADDR2];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createListEdit.called, 'createListEdit should be called');
        });

        it('remove address from existing list: createListEdit called', async function () {
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves([ADDR1, ADDR2]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 1, SOURCE });
            // EDIT=2 (remove)
            const params = ['1', '2', '5', ADDR1];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createListEdit.called);
        });

        it('LIST_ACTION_INDEX not found → invalid', async function () {
            indexer.indexerDb.getListType.resolves(false);
            indexer.indexerDb.getList.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 1, SOURCE });
            const params = ['1', '1', '9999', ADDR1];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

        // the edit must be built on the list's CURRENT membership (the head
        // of its edit chain), not on the create-time item set, and the parent it
        // stores must be the CREATE that roots the chain so the next edit finds it.
        it('reads the parent membership with block context so the flag day can gate it', async function () {
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves([ADDR1]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 1, SOURCE, BLOCK_INDEX: 4242 });
            const params = ['1', '1', '5', ADDR2];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            const call = indexer.indexerDb.getList.getCall(0);
            assert.ok(call, 'getList should be called for an edit');
            assert.strictEqual(call.args[1], 4242, 'getList must receive the block index');
        });

        it('normalizes LIST_ACTION_INDEX to the CREATE that roots the edit chain', async function () {
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves([ADDR1]);
            indexer.indexerDb.isActionAllowed.resolves(true);
            // The wire named edit 7; edit 7 is itself an edit of create 5.
            indexer.indexerDb.getListRootIndex.withArgs('7').resolves(5);
            indexer.indexerDb.getListRootIndex.withArgs(7).resolves(5);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 1, SOURCE });
            const params = ['1', '1', '7', ADDR2];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(Number(data['LIST_ACTION_INDEX']), 5,
                'the stored parent must be the create, so every edit hangs off one root');
            assert.strictEqual(Number(indexer.indexerDb.getList.getCall(0).args[0]), 5,
                'the membership read must use the normalized root');
        });

        it('leaves LIST_ACTION_INDEX untouched while the flag day is inert', async function () {
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves([ADDR1]);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.isListEditResolutionActive.returns(false);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 1, SOURCE });
            const params = ['1', '1', '7', ADDR2];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(!indexer.indexerDb.getListRootIndex.called,
                'no normalization below the activation height');
            assert.strictEqual(Number(data['LIST_ACTION_INDEX']), 7, 'the wire value is stored verbatim');
        });

        it('a REMOVE writes the spliced membership, dropping the removed item', async function () {
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves([ADDR1, ADDR2]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 1, SOURCE });
            const params = ['1', '2', '5', ADDR1];  // EDIT=2 (remove) ADDR1

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            const written = indexer.indexerDb.createListItem.getCalls().map(c => c.args[1]);
            assert.deepStrictEqual(written, [ADDR2],
                'the edit snapshot must be the full remaining membership');
        });

        it('a REMOVE of the last member writes an EMPTY snapshot', async function () {
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves([ADDR1]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 1, SOURCE });
            const params = ['1', '2', '5', ADDR1];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(indexer.indexerDb.createListItem.callCount, 0,
                'an emptied list writes no item rows, which getList reads back as []');
        });

        it('invalid EDIT value → invalid', async function () {
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 1, SOURCE });
            // EDIT=99 is unknown
            const params = ['1', '99', '5', ADDR1];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

    });

    describe('type 1: TICK item validation', function () {

        it('unknown TICK in list → createListItemInvalid called', async function () {
            // Token not found for the item
            indexer.indexerDb.getTokenInfo.resolves(null);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 0, SOURCE });
            // TYPE=1 (tick), item UNKNOWN does not exist
            const params = ['0', '1', 'UNKNOWN'];

            await handler.parse(params, data, null);

            // List is valid overall but the item is flagged as invalid
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createListItemInvalid.called, 'createListItemInvalid should be called for unknown tick');
        });

        it('valid TICK in list → createListItem called', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1 });
            indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 0, SOURCE });
            const params = ['0', '1', 'TEST'];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createListItem.called);
            assert.ok(!indexer.indexerDb.createListItemInvalid.called, 'createListItemInvalid should not be called for valid tick');
        });

        it('mix of valid and invalid TICKs: valid gets createListItem, invalid gets createListItemInvalid', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1 });
            indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo);
            indexer.indexerDb.getTokenInfo.withArgs('INVALID').resolves(null);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 0, SOURCE });
            const params = ['0', '1', 'TEST', 'INVALID'];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createListItem.called);
            assert.ok(indexer.indexerDb.createListItemInvalid.called);
        });

    });

    describe('type 2: ADDRESS item validation', function () {

        it('invalid address format → createListItemInvalid called', async function () {
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 0, SOURCE });
            // TYPE=2, item is not a valid crypto address
            const params = ['0', '2', 'not-a-real-address'];

            await handler.parse(params, data, null);

            // List is valid overall; invalid address is flagged
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createListItemInvalid.called, 'createListItemInvalid for bad address');
        });

        it('valid address → createListItem called', async function () {
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 0, SOURCE });
            const params = ['0', '2', ADDR1];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createListItem.called);
        });

    });

    describe('SOURCE sleeping', function () {

        it('SOURCE sleeping → invalid', async function () {
            indexer.indexerDb.isActionAllowed.callsFake((address, tick, block) => {
                if (address && !tick) return Promise.resolve(false);
                return Promise.resolve(true);
            });

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 0, SOURCE });
            const params = ['0', '2', ADDR1];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

    });

    describe('record creation', function () {

        it('createList always called', async function () {
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 0, SOURCE });
            const params = ['0', '99', ADDR1];  // invalid TYPE

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.createList.called, 'createList should be called even on invalid');
        });

        it('mapper.createMappings called after parse', async function () {
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 0, SOURCE });
            const params = ['0', '2', ADDR1];

            await handler.parse(params, data, null);

            assert.ok(indexer.mapper.createMappings.called);
        });

    });
});
