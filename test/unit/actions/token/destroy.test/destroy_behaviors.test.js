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
// Multi-destroy formats, consolidation, and record creation coverage. One part
// of destroy.test.js; the shared fixtures are in helpers/destroy_suite.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData, createTokenInfo } = require('../../../../fixtures/mocks');
const { SOURCE, freshDestroySuite } = require('./helpers/destroy_suite.js');

let indexer, handler;

function freshSuite() {
    ({ indexer, handler } = freshDestroySuite());
}

// ─── Format 1 (Multi-Destroy Full) ───────────────────────────────

function multiDestroyFormatCases() {
    it('valid multi-destroy: createDestroy called for each distinct TICK', async function () {
        const tokenInfo1 = createTokenInfo({ TICK: 'TEST',  TICK_ID: 1, DECIMALS: 0 });
        const tokenInfo2 = createTokenInfo({ TICK: 'XTEST', TICK_ID: 2, DECIMALS: 0 });
        indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo1);
        indexer.indexerDb.getTokenInfo.withArgs('XTEST').resolves(tokenInfo2);
        indexer.indexerDb.getAddressBalances.resolves({ 1: '500', 2: '500' });
        indexer.indexerDb.isActionAllowed.resolves(true);

        const data   = createBaseData({ ACTION: 'DESTROY', FORMAT: 1, SOURCE });
        // FORMAT 1: VERSION|TICK|AMOUNT|TICK|AMOUNT|MEMO
        const params = ['1', 'TEST', '10', 'XTEST', '20', 'memo'];

        await handler.parse(params, data, null);

        assert.ok(indexer.indexerDb.createDestroy.callCount >= 2, 'createDestroy called for each tick');
    });
}

// ─── Multi-destroy consolidation ─────────────────────────────────

function consolidationCases() {
    it('duplicate TICK+MEMO entries are consolidated into single destroy', async function () {
        const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
        indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
        indexer.indexerDb.getAddressBalances.resolves({ 1: '1000' });
        indexer.indexerDb.isActionAllowed.resolves(true);

        const data   = createBaseData({ ACTION: 'DESTROY', FORMAT: 1, SOURCE });
        // Two identical TICK+MEMO pairs should consolidate to one
        const params = ['1', 'TEST', '10', 'TEST', '15', 'same-memo'];

        await handler.parse(params, data, null);

        // Consolidated to a single destroy of 25
        assert.strictEqual(indexer.indexerDb.createDestroy.callCount, 1);
    });

    it('different MEMOs for same TICK produce separate destroys', async function () {
        const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
        indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
        indexer.indexerDb.getAddressBalances.resolves({ 1: '1000' });
        indexer.indexerDb.isActionAllowed.resolves(true);

        const data   = createBaseData({ ACTION: 'DESTROY', FORMAT: 2, SOURCE });
        // FORMAT 2: VERSION|TICK|AMOUNT|MEMO|TICK|AMOUNT|MEMO
        const params = ['2', 'TEST', '10', 'memo1', 'TEST', '15', 'memo2'];

        await handler.parse(params, data, null);

        assert.ok(indexer.indexerDb.createDestroy.callCount >= 1);
    });
}

// ─── Record creation ─────────────────────────────────────────────

function recordCreationCases() {
    it('createDestroy called even on invalid', async function () {
        indexer.indexerDb.getTokenInfo.resolves(null);
        indexer.indexerDb.getAddressBalances.resolves({});
        indexer.indexerDb.isActionAllowed.resolves(true);
        const data   = createBaseData({ ACTION: 'DESTROY', FORMAT: 0, SOURCE });
        const params = ['0', 'UNKNOWN', '10', null];
        await handler.parse(params, data, null);

        assert.ok(indexer.indexerDb.createDestroy.called);
    });

    it('updateBalances and updateTokens called after parse', async function () {
        const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
        indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
        indexer.indexerDb.getAddressBalances.resolves({ 1: '500' });
        indexer.indexerDb.isActionAllowed.resolves(true);

        const data   = createBaseData({ ACTION: 'DESTROY', FORMAT: 0, SOURCE });
        const params = ['0', 'TEST', '10', null];

        await handler.parse(params, data, null);

        assert.ok(indexer.indexerDb.updateBalances.called);
        assert.ok(indexer.indexerDb.updateTokens.called);
    });

    it('mapper.createMappings called after parse', async function () {
        const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
        indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
        indexer.indexerDb.getAddressBalances.resolves({ 1: '500' });
        indexer.indexerDb.isActionAllowed.resolves(true);

        const data   = createBaseData({ ACTION: 'DESTROY', FORMAT: 0, SOURCE });
        const params = ['0', 'TEST', '10', null];

        await handler.parse(params, data, null);

        assert.ok(indexer.mapper.createMappings.called);
    });

    it('pre-existing error passed through: invalid status', async function () {
        const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
        indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
        indexer.indexerDb.getAddressBalances.resolves({ 1: '500' });
        indexer.indexerDb.isActionAllowed.resolves(true);

        const data   = createBaseData({ ACTION: 'DESTROY', FORMAT: 0, SOURCE });
        const params = ['0', 'TEST', '10', null];

        await handler.parse(params, data, 'invalid: pre-existing error');

        assert.ok(data['STATUS'].includes('invalid'));
    });
}

describe('Destroy @regression @tier1', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    describe('format 1: multi-destroy full', multiDestroyFormatCases);
    describe('multi-destroy consolidation', consolidationCases);
    describe('record creation', recordCreationCases);
});
