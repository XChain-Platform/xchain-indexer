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

const sinon = require('sinon');
const { createBaseData } = require('../../../../fixtures/mocks');
const { stubActiveAt } = require('../../../../helpers/gate_modules.js');
const { SOURCE, ADDR1, ADDR2, makeListContext } = require('./helpers/list_context.js');

const REMATCH_GATE = 'list_change_rematch_activation.LIST_CHANGE_REMATCH_ACTIVATION';

let indexer, actionsCtx, handler;

function freshList() {
    ({ indexer, actionsCtx, handler } = makeListContext());
    stubActiveAt(sinon, REMATCH_GATE, false);
    indexer.indexerDb.isActionAllowed.resolves(true);
}

function assertCommonWrites(data) {
    sinon.assert.calledOnceWithExactly(indexer.indexerDb.createList, data);
    sinon.assert.calledOnceWithExactly(indexer.mapper.createMappings, data);
    sinon.assert.notCalled(actionsCtx.processAction);
}

describe('List @regression @tier3', function () {
    beforeEach(freshList);
    afterEach(() => sinon.restore());

    describe('unarmed list change rematch', function () {
        it('keeps a valid format 0 create on the storage-only path', async function () {
            const data = createBaseData({ ACTION: 'LIST', FORMAT: 0, SOURCE });
            const params = ['0', '2', '', ADDR1];

            await handler.parse(params, data, null);

            sinon.assert.match(data, { STATUS: 'valid' });
            assertCommonWrites(data);
            sinon.assert.calledOnceWithExactly(indexer.indexerDb.createListEdit, data, ADDR1, 'valid');
            sinon.assert.calledOnceWithExactly(indexer.indexerDb.createListItem, data, ADDR1);
        });

        it('keeps a valid format 1 add on the storage-only path', async function () {
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves([ADDR1]);

            const data = createBaseData({ ACTION: 'LIST', FORMAT: 1, SOURCE });
            const params = ['1', '1', '5', '', ADDR2];

            await handler.parse(params, data, null);

            sinon.assert.match(data, { STATUS: 'valid' });
            assertCommonWrites(data);
            sinon.assert.calledOnceWithExactly(indexer.indexerDb.createListEdit, data, ADDR2, 'valid');
            sinon.assert.callCount(indexer.indexerDb.createListItem, 2);
            sinon.assert.calledWithExactly(indexer.indexerDb.createListItem, data, ADDR1);
            sinon.assert.calledWithExactly(indexer.indexerDb.createListItem, data, ADDR2);
        });

        it('keeps a valid format 1 remove on the storage-only path', async function () {
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves([ADDR1, ADDR2]);

            const data = createBaseData({ ACTION: 'LIST', FORMAT: 1, SOURCE });
            const params = ['1', '2', '5', '', ADDR1];

            await handler.parse(params, data, null);

            sinon.assert.match(data, { STATUS: 'valid' });
            assertCommonWrites(data);
            sinon.assert.calledOnceWithExactly(indexer.indexerDb.createListEdit, data, ADDR1, 'valid');
            sinon.assert.calledOnceWithExactly(indexer.indexerDb.createListItem, data, ADDR2);
        });

        it('keeps an unknown format 1 parent on the refused storage-only path', async function () {
            indexer.indexerDb.getListType.resolves(false);

            const data = createBaseData({ ACTION: 'LIST', FORMAT: 1, SOURCE });
            const params = ['1', '1', '9999', '', ADDR1];

            await handler.parse(params, data, null);

            sinon.assert.match(data, {
                STATUS: 'invalid: LIST_ACTION_INDEX (unknown)',
                LIST_ACTION_INDEX: null,
            });
            assertCommonWrites(data);
            sinon.assert.notCalled(indexer.indexerDb.createListEdit);
            sinon.assert.notCalled(indexer.indexerDb.createListItem);
            sinon.assert.notCalled(indexer.indexerDb.createListItemInvalid);
        });
    });
});
