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
// LIST handler: format 0 creation, TICK and ADDRESS item validation, SOURCE
// sleeping and record creation. The format 1 edit blocks and the MEMO blocks
// live beside it in list.test/; every file opens the same 'List @regression @tier3'
// describe, so each full test title stays under one suite name.
// list.test/helpers/list_context.js holds the addresses and the per-test mock
// indexer and handler every block starts from.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData, createTokenInfo } = require('../../fixtures/mocks');
const { SOURCE, ADDR1, ADDR2, makeListContext } = require('./list.test/helpers/list_context.js');

let indexer, handler;

// Each test starts from its own mock indexer and LIST handler.
function freshList() {
    ({ indexer, handler } = makeListContext());
}

// ─── Format 0: Create LIST ────────────────────────────────────────

describe('List @regression @tier3', function () {
    beforeEach(freshList);
    afterEach(() => sinon.restore());

    describe('format 0: create LIST', function () {

        it('create address list: createList, createListItem called for each address', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 0, SOURCE });
            // TYPE=2 (address), items are ADDR1 and ADDR2
            const params = ['0', '2', '', ADDR1, ADDR2];

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
            const params = ['0', '1', '', 'TEST'];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createList.called);
            assert.ok(indexer.indexerDb.createListItem.called);
        });
    });
});

describe('List @regression @tier3', function () {
    beforeEach(freshList);
    afterEach(() => sinon.restore());

    describe('format 0: create LIST', function () {
        it('unknown TYPE → invalid', async function () {
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 0, SOURCE });
            const params = ['0', '99', '', ADDR1];  // TYPE=99 is unknown

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
});

// ─── Type 1 (TICK) validation ────────────────────────────────────

describe('List @regression @tier3', function () {
    beforeEach(freshList);
    afterEach(() => sinon.restore());

    describe('type 1: TICK item validation', function () {

        it('unknown TICK in list → createListItemInvalid called', async function () {
            // Token not found for the item
            indexer.indexerDb.getTokenInfo.resolves(null);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 0, SOURCE });
            // TYPE=1 (tick), item UNKNOWN does not exist
            const params = ['0', '1', '', 'UNKNOWN'];

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
            const params = ['0', '1', '', 'TEST'];

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
            const params = ['0', '1', '', 'TEST', 'INVALID'];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createListItem.called);
            assert.ok(indexer.indexerDb.createListItemInvalid.called);
        });

    });
});

// ─── Type 2 (ADDRESS) validation ─────────────────────────────────

describe('List @regression @tier3', function () {
    beforeEach(freshList);
    afterEach(() => sinon.restore());

    describe('type 2: ADDRESS item validation', function () {

        it('invalid address format → createListItemInvalid called', async function () {
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 0, SOURCE });
            // TYPE=2, item is not a valid crypto address
            const params = ['0', '2', '', 'not-a-real-address'];

            await handler.parse(params, data, null);

            // List is valid overall; invalid address is flagged
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createListItemInvalid.called, 'createListItemInvalid for bad address');
        });

        it('valid address → createListItem called', async function () {
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 0, SOURCE });
            const params = ['0', '2', '', ADDR1];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createListItem.called);
        });

    });

    // ─── SOURCE sleeping ─────────────────────────────────────────────

    describe('SOURCE sleeping', function () {

        it('SOURCE sleeping → invalid', async function () {
            indexer.indexerDb.isActionAllowed.callsFake((address, tick, block) => {
                if (address && !tick) return Promise.resolve(false);
                return Promise.resolve(true);
            });

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 0, SOURCE });
            const params = ['0', '2', '', ADDR1];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

    });
});

// ─── Record creation ─────────────────────────────────────────────

describe('List @regression @tier3', function () {
    beforeEach(freshList);
    afterEach(() => sinon.restore());

    describe('record creation', function () {

        it('createList always called', async function () {
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 0, SOURCE });
            const params = ['0', '99', '', ADDR1];  // invalid TYPE

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.createList.called, 'createList should be called even on invalid');
        });

        it('mapper.createMappings called after parse', async function () {
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'LIST', FORMAT: 0, SOURCE });
            const params = ['0', '2', '', ADDR1];

            await handler.parse(params, data, null);

            assert.ok(indexer.mapper.createMappings.called);
        });

    });
});
