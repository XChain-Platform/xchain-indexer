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
const { createBaseData, createTokenInfo } = require('../../../fixtures/mocks');
const { SOURCE, freshDestroySuite } = require('./destroy.test/helpers/destroy_suite.js');

let indexer, actionsCtx, handler;

function freshSuite() {
    ({ indexer, actionsCtx, handler } = freshDestroySuite());
}

// ─── Format 0 (Single Destroy) ────────────────────────────────────

function validSingleDestroyCases() {
    it('valid destroy: createDestroy called with valid status', async function () {
        const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
        indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
        indexer.indexerDb.getAddressBalances.resolves({ 1: '500' });
        indexer.indexerDb.isActionAllowed.resolves(true);

        const data   = createBaseData({ ACTION: 'DESTROY', FORMAT: 0, SOURCE });
        const params = ['0', 'TEST', '100', 'memo'];

        await handler.parse(params, data, null);

        assert.strictEqual(data['STATUS'], 'valid');
        assert.ok(indexer.indexerDb.createDestroy.called);
    });

    it('valid destroy: debit created, no credit created', async function () {
        const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
        indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
        indexer.indexerDb.getAddressBalances.resolves({ 1: '500' });
        indexer.indexerDb.isActionAllowed.resolves(true);

        const data   = createBaseData({ ACTION: 'DESTROY', FORMAT: 0, SOURCE });
        const params = ['0', 'TEST', '50', null];

        await handler.parse(params, data, null);

        assert.strictEqual(data['STATUS'], 'valid');
        // createCredit should NOT be called (destroy has no recipient)
        assert.ok(!indexer.indexerDb.createCredit.called, 'createCredit should not be called for destroy');
    });

    it('TICK not found → invalid', async function () {
        indexer.indexerDb.getTokenInfo.resolves(null);
        indexer.indexerDb.getAddressBalances.resolves({});
        indexer.indexerDb.isActionAllowed.resolves(true);

        const data   = createBaseData({ ACTION: 'DESTROY', FORMAT: 0, SOURCE });
        const params = ['0', 'UNKNOWN', '100', null];

        await handler.parse(params, data, null);

        assert.ok(data['STATUS'].includes('invalid'));
    });
}

function rejectedSingleDestroyCases() {
    it('insufficient balance → invalid', async function () {
        const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
        indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
        // Only 10 available, trying to destroy 100
        indexer.indexerDb.getAddressBalances.resolves({ 1: '10' });
        indexer.indexerDb.isActionAllowed.resolves(true);

        const data   = createBaseData({ ACTION: 'DESTROY', FORMAT: 0, SOURCE });
        const params = ['0', 'TEST', '100', null];

        await handler.parse(params, data, null);

        assert.ok(data['STATUS'].includes('invalid'));
    });

    it('MEMO with pipe → invalid', async function () {
        const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
        indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
        indexer.indexerDb.getAddressBalances.resolves({ 1: '500' });
        indexer.indexerDb.isActionAllowed.resolves(true);

        const data   = createBaseData({ ACTION: 'DESTROY', FORMAT: 0, SOURCE });
        const params = ['0', 'TEST', '10', 'bad|memo'];

        await handler.parse(params, data, null);

        assert.ok(data['STATUS'].includes('invalid'));
    });

    it('SOURCE sleeping → invalid', async function () {
        const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
        indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
        indexer.indexerDb.getAddressBalances.resolves({ 1: '500' });
        indexer.indexerDb.isActionAllowed.callsFake((address, tick, block) => {
            if (address && !tick) return Promise.resolve(false);
            return Promise.resolve(true);
        });

        const data   = createBaseData({ ACTION: 'DESTROY', FORMAT: 0, SOURCE });
        const params = ['0', 'TEST', '10', null];

        await handler.parse(params, data, null);

        assert.ok(data['STATUS'].includes('invalid'));
    });
}

function unknownFormatCase() {
    it('unknown format version → createDestroy still called', async function () {
        indexer.indexerDb.getTokenInfo.resolves(null);
        indexer.indexerDb.getAddressBalances.resolves({});
        indexer.indexerDb.isActionAllowed.resolves(true);

        const data   = createBaseData({ ACTION: 'DESTROY', FORMAT: 99, SOURCE });
        const params = ['99', 'TEST', '10', null];

        await handler.parse(params, data, null);

        // Invalid format but createDestroy should still be called (records invalid action)
        assert.ok(indexer.indexerDb.createDestroy.called);
    });
}

describe('Destroy @regression @tier1', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    describe('format 0: single destroy', validSingleDestroyCases);
    describe('format 0: single destroy', rejectedSingleDestroyCases);
    describe('format 0: single destroy', unknownFormatCase);
});
