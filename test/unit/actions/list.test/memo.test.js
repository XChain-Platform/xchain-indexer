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
// LIST MEMO: where the memo sits relative to the variadic ITEM tail, the null
// memo, and the delimiter and length rules.
// Part of the LIST suite; see ../list.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData } = require('../../../fixtures/mocks');
const { SOURCE, ADDR1, ADDR2, makeListContext } = require('./helpers/list_context.js');

let indexer, handler;

// Each test starts from its own mock indexer and LIST handler.
function freshList() {
    ({ indexer, handler } = makeListContext());
}

// LIST was the one action with no MEMO support. MEMO was added in place on
// v0/v1 (a pre-launch amendment, not new format versions) and sits BEFORE the
// variadic ITEM tail, because a trailing memo cannot be told apart from one
// more item. That position is the whole risk in the change: get it wrong and
// the first item is eaten as the memo, or the memo is stored as a list member.
describe('List @regression @tier3', function () {
    beforeEach(freshList);
    afterEach(() => sinon.restore());

    describe('MEMO', function () {
        it('stores the MEMO and does NOT treat it as a list item (format 0)', async function () {
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 0, SOURCE });
            const params = ['0', '2', 'my allow list', ADDR1, ADDR2];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['MEMO'], 'my allow list');
            const items = indexer.indexerDb.createListItem.getCalls().map(c => c.args[1]);
            assert.deepStrictEqual(items.sort(), [ADDR1, ADDR2].sort(),
                'the memo must not appear as a list item, and no item may be swallowed by it');
        });

        it('stores the MEMO and does NOT treat it as a list item (format 1)', async function () {
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getListType.resolves('2');
            indexer.indexerDb.getList.resolves([]);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 1, SOURCE });
            const params = ['1', '1', '5', 'adding a partner', ADDR1];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['MEMO'], 'adding a partner');
            const items = indexer.indexerDb.createListItem.getCalls().map(c => c.args[1]);
            assert.deepStrictEqual(items, [ADDR1]);
        });
    });
});

describe('List @regression @tier3', function () {
    beforeEach(freshList);
    afterEach(() => sinon.restore());

    describe('MEMO', function () {
        it('an empty MEMO slot is a null memo, not an empty-string list item', async function () {
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 0, SOURCE });
            const params = ['0', '2', '', ADDR1];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['MEMO'], null, 'setActionParams nulls an empty field');
            const items = indexer.indexerDb.createListItem.getCalls().map(c => c.args[1]);
            assert.deepStrictEqual(items, [ADDR1]);
        });

        it('rejects a MEMO carrying the action delimiter', async function () {
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 0, SOURCE });
            const params = ['0', '2', 'one;two', ADDR1];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'invalid: MEMO (semicolon)');
        });
    });
});

describe('List @regression @tier3', function () {
    beforeEach(freshList);
    afterEach(() => sinon.restore());

    describe('MEMO', function () {
        it('rejects a MEMO longer than MAX_MEMO_LENGTH', async function () {
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 0, SOURCE });
            const params = ['0', '2', 'x'.repeat(indexer.config['MAX_MEMO_LENGTH'] + 1), ADDR1];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'invalid: MEMO (length)');
        });

        it('accepts a MEMO of exactly MAX_MEMO_LENGTH', async function () {
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 0, SOURCE });
            const params = ['0', '2', 'x'.repeat(indexer.config['MAX_MEMO_LENGTH']), ADDR1];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
        });

    });
});
