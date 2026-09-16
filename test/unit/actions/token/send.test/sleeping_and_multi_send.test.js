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
//
// Send handler: address and tick sleeping, and the multi-send formats 1, 2
// and 3 with the consolidation of legs bound for one destination.
// Part of the Send suite; see ../send.test.js.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const {
    SOURCE, DESTINATION, DEST2, makeData, makeToken, makeBalances, useSendHarness,
} = require('./helpers/send_harness.js');

// Each test gets a fresh harness from useSendHarness; bind() hands it to the
// names the test bodies use.
let indexer, handler;
const bind = (h) => { ({ indexer, handler } = h); };

// -----------------------------------------------------------------------
// Address / tick sleeping
// -----------------------------------------------------------------------
describe('Send handler @regression @tier1', function () {
    useSendHarness(bind);

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
    });
});

describe('Send handler @regression @tier1', function () {
    useSendHarness(bind);

    describe('address and tick sleeping', function () {
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

    // -----------------------------------------------------------------------
    // Format 1: multi-send (brief): same TICK, multiple destinations
    // -----------------------------------------------------------------------

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
});

// -----------------------------------------------------------------------
// Format 2: multi-send full (different TICKs)
// -----------------------------------------------------------------------
describe('Send handler @regression @tier1', function () {
    useSendHarness(bind);

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

    // -----------------------------------------------------------------------
    // Format 3: multi-send with individual memos
    // -----------------------------------------------------------------------

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
});

// -----------------------------------------------------------------------
// Multi-send consolidation
// -----------------------------------------------------------------------
describe('Send handler @regression @tier1', function () {
    useSendHarness(bind);

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

    // -----------------------------------------------------------------------
    // createSend always called
    // -----------------------------------------------------------------------

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
