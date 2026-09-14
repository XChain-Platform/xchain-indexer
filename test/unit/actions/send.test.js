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
// Send handler: the single-send field validations (format 0, VERSION and
// FORMAT, TICK, AMOUNT, DESTINATION and MEMO). The sleeping and multi-send
// cases, the conditional gated handoff and the caret-compacted handoff
// destination live beside it in send.test/, each opening the same describe
// title so every full test title is unchanged; the harness in
// send.test/helpers/send_harness.js holds the fixtures they share.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const {
    SOURCE, DESTINATION, makeData, makeToken, makeBalances, useSendHarness,
} = require('./send.test/helpers/send_harness.js');

// Each test gets a fresh harness from useSendHarness; bind() hands it to the
// names the test bodies use.
let indexer, handler;
const bind = (h) => { ({ indexer, handler } = h); };

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

// -----------------------------------------------------------------------
// Format 0: single send
// -----------------------------------------------------------------------
describe('Send handler @regression @tier1', function () {
    useSendHarness(bind);

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
});

// -----------------------------------------------------------------------
// VERSION / FORMAT validation
// -----------------------------------------------------------------------
describe('Send handler @regression @tier1', function () {
    useSendHarness(bind);

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
});

// -----------------------------------------------------------------------
// TICK validations
// -----------------------------------------------------------------------
describe('Send handler @regression @tier1', function () {
    useSendHarness(bind);

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
});

// -----------------------------------------------------------------------
// AMOUNT validations
// -----------------------------------------------------------------------
describe('Send handler @regression @tier1', function () {
    useSendHarness(bind);

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
});

// -----------------------------------------------------------------------
// DESTINATION validations
// -----------------------------------------------------------------------
describe('Send handler @regression @tier1', function () {
    useSendHarness(bind);

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
});

// -----------------------------------------------------------------------
// MEMO validations
// -----------------------------------------------------------------------
describe('Send handler @regression @tier1', function () {
    useSendHarness(bind);

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
    });
});

describe('Send handler @regression @tier1', function () {
    useSendHarness(bind);

    describe('MEMO validations', function () {

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
});
