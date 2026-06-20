'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');

const Send = require('../../../src/actions/send.js');

function makeActionsCtx(indexer) {
    return {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: {
            isDefined:  sinon.stub().returns(true),
            isEnabled:  sinon.stub().resolves(true),
        },
        processAction: sinon.stub().resolves(),
    };
}

function makeData(overrides = {}) {
    return createBaseData(Object.assign({ ACTION: 'SEND', FORMAT: 0 }, overrides));
}

const SOURCE      = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const DESTINATION = 'mtr6NtB5KJRAxTX5AbuRtV7S4FF2PZJXUs';
const DEST2       = 'n2j7X44Gm6P4E9cs2H13EkBAotYbjPZW17';

// A tokenInfo with TICK_ID = 1 so hasBalance checks work
function makeToken(overrides = {}) {
    return createTokenInfo(Object.assign({
        TICK:     'TEST',
        TICK_ID:  1,
        DECIMALS: 0,
    }, overrides));
}

function makeBalances(tickId, amount) {
    return { [tickId]: amount };
}

describe('Send handler @regression @tier1', function () {
    let indexer, actionsCtx, handler;

    beforeEach(function () {
        indexer    = createMockIndexer();
        actionsCtx = makeActionsCtx(indexer);
        handler    = new Send(actionsCtx);

        const token = makeToken();
        indexer.indexerDb.getTokenInfo.resolves(token);
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        // Sufficient balance: 1000 of TICK_ID=1
        indexer.indexerDb.getAddressBalances.resolves(makeBalances(1, 1000));
        // Dispenser integration: no matching dispensers
        indexer.indexerDb.findMatchingDispensers.resolves([]);
        indexer.indexerDb.findDispenserSends.resolves([]);
    });

    afterEach(function () {
        sinon.restore();
    });

    describe('format 0: single send', function () {

        it('valid single send → STATUS valid, createSend called', async function () {
            // params after ACTION stripped: [VERSION, TICK, AMOUNT, DESTINATION, MEMO]
            const params = ['0', 'TEST', '100', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
            assert.ok(indexer.indexerDb.createSend.calledOnce, 'createSend should be called');
        });

        it('valid send → mapper.createMappings called', async function () {
            const params = ['0', 'TEST', '100', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(indexer.mapper.createMappings.calledOnce);
        });

        it('valid send → updateBalances called', async function () {
            const params = ['0', 'TEST', '100', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.updateBalances.calledOnce);
        });

        it('valid send → processDispenserSends invoked', async function () {
            const dispSpy = sinon.spy(indexer.util, 'processDispenserSends');

            const params = ['0', 'TEST', '100', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(dispSpy.calledOnce, 'processDispenserSends should be called after sends');
        });
    });

    describe('VERSION / FORMAT validation', function () {

        it('unknown format version → invalid', async function () {
            const params = ['99', 'TEST', '100', DESTINATION, ''];
            const data   = makeData({ FORMAT: 99, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('null format → invalid', async function () {
            const params = ['', 'TEST', '100', DESTINATION, ''];
            const data   = makeData({ FORMAT: null, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('pre-existing error is preserved', async function () {
            const params = ['0', 'TEST', '100', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, 'invalid: pre-existing');

            assert.ok(data.STATUS.startsWith('invalid'));
        });
    });

    describe('TICK validations', function () {

        it('TICK not found → invalid', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);

            const params = ['0', 'UNKNOWN', '100', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('createSend still called even when TICK unknown', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);

            const params = ['0', 'UNKNOWN', '100', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            // createSend is always called to record the attempt
            assert.ok(indexer.indexerDb.createSend.calledOnce);
        });
    });

    describe('AMOUNT validations', function () {

        it('insufficient balance → invalid', async function () {
            // Only 50 tokens in balance, trying to send 100
            indexer.indexerDb.getAddressBalances.resolves(makeBalances(1, 50));

            const params = ['0', 'TEST', '100', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('AMOUNT with wrong decimal format (too many decimals for token) → invalid', async function () {
            // Token has 0 decimals: fractional amount invalid
            const params = ['0', 'TEST', '1.5', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('valid AMOUNT respecting token decimals → valid', async function () {
            const token = makeToken({ DECIMALS: 8 });
            indexer.indexerDb.getTokenInfo.resolves(token);

            const params = ['0', 'TEST', '1.50000000', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });

    describe('DESTINATION validations', function () {

        it('invalid DESTINATION address → invalid', async function () {
            const params = ['0', 'TEST', '100', 'not-a-valid-address', ''];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('valid DESTINATION address → valid', async function () {
            const params = ['0', 'TEST', '100', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });

    describe('MEMO validations', function () {

        it('MEMO with pipe → invalid', async function () {
            const params = ['0', 'TEST', '100', DESTINATION, 'bad|memo'];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('MEMO with semicolon → invalid', async function () {
            const params = ['0', 'TEST', '100', DESTINATION, 'bad;memo'];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('MEMO over max length → invalid', async function () {
            const params = ['0', 'TEST', '100', DESTINATION, 'A'.repeat(251)];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('MEMO at max length (250) → valid', async function () {
            const params = ['0', 'TEST', '100', DESTINATION, 'A'.repeat(250)];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });

        it('MEMO required by destination preferences but missing → invalid', async function () {
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 1 });

            const params = ['0', 'TEST', '100', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('MEMO required and provided → valid', async function () {
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 1 });

            const params = ['0', 'TEST', '100', DESTINATION, 'here is my memo'];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });

    describe('address and tick sleeping', function () {

        it('SOURCE sleeping → invalid', async function () {
            // First isActionAllowed call is SOURCE check
            indexer.indexerDb.isActionAllowed
                .onFirstCall().resolves(false)  // SOURCE sleeping
                .resolves(true);

            const params = ['0', 'TEST', '100', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('TICK sleeping → invalid', async function () {
            indexer.indexerDb.isActionAllowed
                .onFirstCall().resolves(true)   // SOURCE ok
                .onSecondCall().resolves(false)  // TICK sleeping
                .resolves(true);

            const params = ['0', 'TEST', '100', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('SOURCE not authorized by token allow/block list → invalid', async function () {
            indexer.indexerDb.isActionAllowed
                .onFirstCall().resolves(true)   // SOURCE sleeping check
                .onSecondCall().resolves(true)   // TICK sleeping check
                .onThirdCall().resolves(false)   // SOURCE authorization check
                .resolves(true);

            const params = ['0', 'TEST', '100', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('DESTINATION not authorized → invalid', async function () {
            indexer.indexerDb.isActionAllowed
                .onFirstCall().resolves(true)   // SOURCE sleeping
                .onSecondCall().resolves(true)   // TICK sleeping
                .onThirdCall().resolves(true)    // SOURCE authorization
                .onCall(3).resolves(false)        // DESTINATION authorization
                .resolves(true);

            const params = ['0', 'TEST', '100', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });
    });

    describe('format 1: multi-send brief', function () {

        it('valid multi-send brief (two destinations) → two createSend calls', async function () {
            // Format 1: VERSION|TICK|AMOUNT|DEST|AMOUNT|DEST|MEMO
            const params = ['1', 'TEST', '50', DESTINATION, '30', DEST2, ''];
            const data   = makeData({ FORMAT: 1, SOURCE });

            await handler.parse(params, data, null);

            // Both sends should produce records; last status is what's set on data
            assert.ok(indexer.indexerDb.createSend.calledTwice, 'createSend should be called twice');
        });

        it('insufficient balance for total multi-send → second send invalid', async function () {
            // Only 60 tokens; first send 50 leaves 10; second send of 30 fails
            indexer.indexerDb.getAddressBalances.resolves(makeBalances(1, 60));

            const params = ['1', 'TEST', '50', DESTINATION, '30', DEST2, ''];
            const data   = makeData({ FORMAT: 1, SOURCE });

            await handler.parse(params, data, null);

            // At least one send was invalid
            assert.ok(data.STATUS.startsWith('invalid'));
        });
    });

    describe('format 2: multi-send full', function () {

        it('valid multi-send full with two different ticks → two createSend calls', async function () {
            const token2 = makeToken({ TICK: 'OTHER', TICK_ID: 2, DECIMALS: 0 });

            // Return tokens by tick name
            indexer.indexerDb.getTokenInfo
                .withArgs('TEST', sinon.match.any, sinon.match.any).resolves(makeToken())
                .withArgs('OTHER', sinon.match.any, sinon.match.any).resolves(token2);

            // Balance for both tokens
            indexer.indexerDb.getAddressBalances.resolves({ 1: 1000, 2: 1000 });

            // Format 2: VERSION|TICK|AMOUNT|DEST|TICK|AMOUNT|DEST|MEMO
            const params = ['2', 'TEST', '50', DESTINATION, 'OTHER', '30', DEST2, ''];
            const data   = makeData({ FORMAT: 2, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.createSend.calledTwice);
        });
    });

    describe('format 3: multi-send with memos', function () {

        it('valid format 3 with two sends and separate memos → two createSend calls', async function () {
            // Format 3: VERSION|TICK|AMOUNT|DEST|MEMO|TICK|AMOUNT|DEST|MEMO
            const params = ['3', 'TEST', '50', DESTINATION, 'memo1', 'TEST', '30', DEST2, 'memo2'];
            const data   = makeData({ FORMAT: 3, SOURCE });

            await handler.parse(params, data, null);

            // The two sends to different destinations should result in two records
            assert.ok(indexer.indexerDb.createSend.calledTwice);
        });
    });

    describe('multi-send consolidation', function () {

        it('same TICK+DESTINATION across multiple sends are consolidated', async function () {
            // Format 1 with two entries going to the same destination
            // They should be consolidated into a single send
            const params = ['1', 'TEST', '50', DESTINATION, '30', DESTINATION, ''];
            const data   = makeData({ FORMAT: 1, SOURCE });

            await handler.parse(params, data, null);

            // After consolidation, only ONE createSend call for the merged 80-token send
            assert.ok(indexer.indexerDb.createSend.calledOnce, 'consolidated sends should produce one record');
        });

        it('consolidated amount is sum of individual amounts', async function () {
            const params = ['1', 'TEST', '50', DESTINATION, '30', DESTINATION, ''];
            const data   = makeData({ FORMAT: 1, SOURCE });

            await handler.parse(params, data, null);

            const callArg = indexer.indexerDb.createSend.firstCall.args[0];
            // The util merges them so AMOUNT should reflect the combined total
            const util   = indexer.util;
            assert.strictEqual(util.bcformat(callArg.AMOUNT, 0), '80');
        });
    });

    describe('createSend is always called', function () {

        it('createSend is called even on invalid send', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null); // TICK unknown

            const params = ['0', 'UNKNOWN', '100', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
            assert.ok(indexer.indexerDb.createSend.calledOnce);
        });
    });
});
