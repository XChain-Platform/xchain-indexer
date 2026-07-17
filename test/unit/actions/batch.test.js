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

const Batch = require('../../../src/actions/batch.js');

describe('Batch @regression @tier3', function () {
    let indexer, actionsCtx, handler;

    const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';

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
            // Mirror the alias table actions.js defines; batch.js reads it via
            // this.actions.actionAliases for flag-day sub-action normalization.
            actionAliases:   { TRANSFER: 'SEND', ADDR: 'ADDRESS', DROP: 'AIRDROP', CAST: 'BROADCAST', MSG: 'MESSAGE' },
        };
        handler = new Batch(actionsCtx);
        indexer.util.resetLists();
    });

    afterEach(function () {
        sinon.restore();
    });

    describe('valid batch', function () {

        it('commands split by semicolon, processAction called for each', async function () {
            const data = createBaseData({
                ACTION:    'BATCH',
                FORMAT:    0,
                SOURCE,
                TX_DATA:   'BATCH|0|SEND|0|TEST|10|mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM;SEND|0|TEST|5|mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
            });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const params = ['0', 'SEND|0|TEST|10|mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM'];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(actionsCtx.processAction.callCount >= 2, 'processAction called for each command');
        });

        it('createBatch called with valid status', async function () {
            const data = createBaseData({
                ACTION:  'BATCH',
                FORMAT:  0,
                SOURCE,
                TX_DATA: 'BATCH|0|SEND|0|TEST|10|mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
            });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const params = ['0'];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createBatch.called);
        });

        it('single command batch, processAction called once', async function () {
            const data = createBaseData({
                ACTION:  'BATCH',
                FORMAT:  0,
                SOURCE,
                TX_DATA: 'BATCH|0|MINT|0|TEST|10',
            });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const params = ['0'];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(actionsCtx.processAction.callCount, 1);
        });

        it('createActionIndex called for each command', async function () {
            const data = createBaseData({
                ACTION:  'BATCH',
                FORMAT:  0,
                SOURCE,
                TX_DATA: 'BATCH|0|SEND|0|TEST|5|mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM;SEND|0|TEST|3|mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
            });
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.createActionIndex.resolves(50);

            const params = ['0'];

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.createActionIndex.callCount >= 2);
        });

    });

    describe('nested BATCH', function () {

        it('BATCH inside BATCH → invalid (limit exceeded)', async function () {
            const data = createBaseData({
                ACTION:  'BATCH',
                FORMAT:  0,
                SOURCE,
                TX_DATA: 'BATCH|0|BATCH|0|SEND|0|TEST|5|mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
            });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const params = ['0'];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'), 'nested BATCH should be invalid');
        });

    });

    describe('action limits', function () {

        it('more than 1 MINT in batch → invalid', async function () {
            const data = createBaseData({
                ACTION:  'BATCH',
                FORMAT:  0,
                SOURCE,
                TX_DATA: 'BATCH|0|MINT|0|TEST|10;MINT|0|TEST|10',
            });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const params = ['0'];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

        it('exactly 1 MINT in batch → valid', async function () {
            const data = createBaseData({
                ACTION:  'BATCH',
                FORMAT:  0,
                SOURCE,
                TX_DATA: 'BATCH|0|MINT|0|TEST|10',
            });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const params = ['0'];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('more than 1 ISSUE in batch → invalid', async function () {
            const data = createBaseData({
                ACTION:  'BATCH',
                FORMAT:  0,
                SOURCE,
                TX_DATA: 'BATCH|0|ISSUE|0|TEST;ISSUE|0|XTEST',
            });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const params = ['0'];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

        it('exactly 1 ISSUE in batch → valid', async function () {
            const data = createBaseData({
                ACTION:  'BATCH',
                FORMAT:  0,
                SOURCE,
                TX_DATA: 'BATCH|0|ISSUE|0|TEST',
            });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const params = ['0'];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
        });

    });

    describe('action availability', function () {

        it('disabled action in batch → invalid', async function () {
            const data = createBaseData({
                ACTION:  'BATCH',
                FORMAT:  0,
                SOURCE,
                TX_DATA: 'BATCH|0|UNKNOWNACTION|0',
            });
            indexer.indexerDb.isActionAllowed.resolves(true);
            actionsCtx.protocolChanges.isEnabled.resolves(false);

            const params = ['0'];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

        it('SOURCE sleeping → invalid', async function () {
            const data = createBaseData({
                ACTION:  'BATCH',
                FORMAT:  0,
                SOURCE,
                TX_DATA: 'BATCH|0|SEND|0|TEST|5|mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
            });
            indexer.indexerDb.isActionAllowed.callsFake((address, tick, block) => {
                if (address && !tick) return Promise.resolve(false);
                return Promise.resolve(true);
            });

            const params = ['0'];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

    });

    describe('sub-action normalization (BATCH_SUBACTION_NORMALIZATION, )', function () {

        const ADDR = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';

        // Per-name isEnabled fake: the normalization gate flips with `gateOn`;
        // canonical ACTION names are activated; anything else (raw alias names,
        // garbage) is unknown, matching the real registry.
        function stubGate(gateOn) {
            const known = ['BATCH', 'SEND', 'MESSAGE', 'ADDRESS', 'AIRDROP', 'BROADCAST', 'ISSUE', 'MINT'];
            actionsCtx.protocolChanges.isEnabled = sinon.stub().callsFake(async (name) => {
                if (name === 'BATCH_SUBACTION_NORMALIZATION') return gateOn;
                return known.includes(name);
            });
            handler = new Batch(actionsCtx);
        }

        it('gate ON: aliased sub-action (MSG) is rewritten and dispatched as MESSAGE', async function () {
            stubGate(true);
            const data = createBaseData({
                ACTION:  'BATCH',
                FORMAT:  0,
                SOURCE,
                TX_DATA: 'BATCH|0|MSG|2|' + ADDR + '|deadbeef',
            });
            indexer.indexerDb.isActionAllowed.resolves(true);

            await handler.parse(['0'], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(actionsCtx.processAction.callCount, 1);
            assert.strictEqual(actionsCtx.processAction.firstCall.args[0], 'MESSAGE');
            assert.strictEqual(data['SIBLING_ACTIONS'][0].action, 'MESSAGE');
        });

        it('gate ON: legacy SEND sub-action (no VERSION) gets VERSION 0 injected and FORMAT 0', async function () {
            stubGate(true);
            const data = createBaseData({
                ACTION:  'BATCH',
                FORMAT:  0,
                SOURCE,
                TX_DATA: 'BATCH|0|SEND|LEGACYTICK|10|' + ADDR,
            });
            indexer.indexerDb.isActionAllowed.resolves(true);

            let seen = null;
            actionsCtx.processAction = sinon.stub().callsFake(async (action, params, d) => {
                seen = { action, params: params.slice(), format: d['FORMAT'] };
            });
            handler = new Batch(actionsCtx);

            await handler.parse(['0'], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(seen.action, 'SEND');
            assert.strictEqual(String(seen.params[0]), '0', 'VERSION 0 injected as first param');
            assert.strictEqual(String(seen.params[1]), 'LEGACYTICK');
            assert.strictEqual(seen.format, 0, 'FORMAT derived from injected VERSION');
            assert.strictEqual(String(data['SIBLING_ACTIONS'][0].params[0]), '0', 'sibling pre-parse also injected');
        });

        it('gate ON: aliased TRANSFER counts toward SEND in the limit scan and dispatches as SEND', async function () {
            stubGate(true);
            const data = createBaseData({
                ACTION:  'BATCH',
                FORMAT:  0,
                SOURCE,
                TX_DATA: 'BATCH|0|TRANSFER|0|TEST|5|' + ADDR,
            });
            indexer.indexerDb.isActionAllowed.resolves(true);

            await handler.parse(['0'], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(actionsCtx.processAction.firstCall.args[0], 'SEND');
        });

        it('gate OFF: aliased sub-action keeps the historic reject (invalid: ACTION (unknown))', async function () {
            stubGate(false);
            const data = createBaseData({
                ACTION:  'BATCH',
                FORMAT:  0,
                SOURCE,
                TX_DATA: 'BATCH|0|MSG|2|' + ADDR + '|deadbeef',
            });
            indexer.indexerDb.isActionAllowed.resolves(true);

            await handler.parse(['0'], data, null);

            assert.ok(String(data['STATUS']).includes('invalid: ACTION (unknown)'));
            assert.strictEqual(actionsCtx.processAction.callCount, 0);
        });

        it('gate OFF: legacy SEND sub-action keeps the historic misparse (no VERSION injected)', async function () {
            stubGate(false);
            const data = createBaseData({
                ACTION:  'BATCH',
                FORMAT:  0,
                SOURCE,
                TX_DATA: 'BATCH|0|SEND|LEGACYTICK|10|' + ADDR,
            });
            indexer.indexerDb.isActionAllowed.resolves(true);

            let seen = null;
            actionsCtx.processAction = sinon.stub().callsFake(async (action, params) => {
                seen = { action, params: params.slice() };
            });
            handler = new Batch(actionsCtx);

            await handler.parse(['0'], data, null);

            assert.strictEqual(seen.action, 'SEND');
            assert.strictEqual(String(seen.params[0]), 'LEGACYTICK', 'pre-activation params untouched');
        });

    });

    describe('record creation', function () {

        it('createBatch called even on invalid', async function () {
            const data = createBaseData({
                ACTION:  'BATCH',
                FORMAT:  0,
                SOURCE,
                TX_DATA: 'BATCH|0|BATCH|0|SEND|0|TEST|5|mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
            });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const params = ['0'];

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.createBatch.called);
        });

        it('mapper.createMappings called after parse', async function () {
            const data = createBaseData({
                ACTION:  'BATCH',
                FORMAT:  0,
                SOURCE,
                TX_DATA: 'BATCH|0|SEND|0|TEST|5|mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
            });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const params = ['0'];

            await handler.parse(params, data, null);

            assert.ok(indexer.mapper.createMappings.called);
        });

        it('processAction not called when batch is invalid', async function () {
            const data = createBaseData({
                ACTION:  'BATCH',
                FORMAT:  0,
                SOURCE,
                TX_DATA: 'BATCH|0|MINT|0|TEST;MINT|0|TEST',
            });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const params = ['0'];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
            assert.strictEqual(actionsCtx.processAction.callCount, 0, 'processAction should not be called on invalid batch');
        });

    });
});
