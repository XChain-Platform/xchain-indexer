// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// LIST format 1 edits: add and remove against the list's current membership,
// the parent normalized to the CREATE that roots the edit chain (and left
// verbatim while that flag day is inert), and a bad EDIT value.
// Part of the LIST suite; see ../list.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData } = require('../../../../fixtures/mocks');
const { SOURCE, ADDR1, ADDR2, makeListContext } = require('./helpers/list_context.js');

let indexer, handler;

// Each test starts from its own mock indexer and LIST handler.
function freshList() {
    ({ indexer, handler } = makeListContext());
}

// ─── Format 1: Edit LIST ──────────────────────────────────────────

describe('List @regression @tier3', function () {
    beforeEach(freshList);
    afterEach(() => sinon.restore());

    describe('format 1: edit LIST', function () {
        it('add address to existing list: createListEdit called', async function () {
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves([ADDR1]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 1, SOURCE });
            // FORMAT 1: VERSION|EDIT|LIST_ACTION_INDEX|ITEM...
            // EDIT=1 (add), LIST_ACTION_INDEX=5
            const params = ['1', '1', '5', '', ADDR2];

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
            const params = ['1', '2', '5', '', ADDR1];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createListEdit.called);
        });

        it('LIST_ACTION_INDEX not found → invalid', async function () {
            indexer.indexerDb.getListType.resolves(false);
            indexer.indexerDb.getList.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 1, SOURCE });
            const params = ['1', '1', '9999', '', ADDR1];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });
    });
});

describe('List @regression @tier3', function () {
    beforeEach(freshList);
    afterEach(() => sinon.restore());

    describe('format 1: edit LIST', function () {
        // the edit must be built on the list's CURRENT membership (the head
        // of its edit chain), not on the create-time item set, and the parent it
        // stores must be the CREATE that roots the chain so the next edit finds it.
        it('reads the parent membership with block context so the flag day can gate it', async function () {
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves([ADDR1]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 1, SOURCE, BLOCK_INDEX: 4242 });
            const params = ['1', '1', '5', '', ADDR2];

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
            const params = ['1', '1', '7', '', ADDR2];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(Number(data['LIST_ACTION_INDEX']), 5,
                'the stored parent must be the create, so every edit hangs off one root');
            assert.strictEqual(Number(indexer.indexerDb.getList.getCall(0).args[0]), 5,
                'the membership read must use the normalized root');
        });
    });
});

describe('List @regression @tier3', function () {
    beforeEach(freshList);
    afterEach(() => sinon.restore());

    describe('format 1: edit LIST', function () {
        it('leaves LIST_ACTION_INDEX untouched while the flag day is inert', async function () {
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves([ADDR1]);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.isListEditResolutionActive.returns(false);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 1, SOURCE });
            const params = ['1', '1', '7', '', ADDR2];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            // The flag day governs the STORED parent, not whether a root is ever resolved:
            // the edit-authorization rules (bridge-owned lists, the owner check) walk
            // to the root for their own read at every height and never write it back.
            assert.strictEqual(Number(data['LIST_ACTION_INDEX']), 7, 'the wire value is stored verbatim');
            assert.strictEqual(Number(indexer.indexerDb.getList.getCall(0).args[0]), 7,
                'the membership read must use the un-normalized wire value below the flag');
        });

        it('a REMOVE writes the spliced membership, dropping the removed item', async function () {
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves([ADDR1, ADDR2]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 1, SOURCE });
            const params = ['1', '2', '5', '', ADDR1];  // EDIT=2 (remove) ADDR1

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
            const params = ['1', '2', '5', '', ADDR1];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(indexer.indexerDb.createListItem.callCount, 0,
                'an emptied list writes no item rows, which getList reads back as []');
        });
    });
});

describe('List @regression @tier3', function () {
    beforeEach(freshList);
    afterEach(() => sinon.restore());

    describe('format 1: edit LIST', function () {
        it('invalid EDIT value → invalid', async function () {
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 1, SOURCE });
            // EDIT=99 is unknown
            const params = ['1', '99', '5', '', ADDR1];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

    });
});
