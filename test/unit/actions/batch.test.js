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
        // R4's aggregate gas pre-check reads the SOURCE's gas balance, and the bare mock
        // returns {} (a source holding nothing), which would make every ISSUE batch below a
        // no-gas batch. Model the ordinary case - a funded source - so the assertions in this
        // file keep testing what they were written to test; the R4 block funds per test.
        // Keyed by the mock getTickerId's fixed id 1.
        indexer.indexerDb.getAddressBalances.resolves({ 1: '1000000' });
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

    describe('sub-action normalization (BATCH_SUBACTION_NORMALIZATION)', function () {

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

    describe('issuance limits v2 (BATCH_ISSUANCE_LIMITS)', function () {

        const ADDR = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';

        // Per-name isEnabled fake. Sub-action normalization is ON throughout (the v2 gate
        // is registered at or after it, asserted in test/unit/batchIssuanceLimitsGate), so
        // `limitsOn` is the only variable: every test below is run twice, once per verdict,
        // and the OFF runs pin the pre-flag consensus outcome byte-for-byte.
        function stubLimits(limitsOn) {
            const known = ['BATCH', 'SEND', 'MESSAGE', 'ADDRESS', 'AIRDROP', 'BROADCAST', 'ISSUE', 'MINT'];
            actionsCtx.protocolChanges.isEnabled = sinon.stub().callsFake(async (name) => {
                if (name === 'BATCH_SUBACTION_NORMALIZATION') return true;
                if (name === 'BATCH_ISSUANCE_LIMITS') return limitsOn;
                return known.includes(name);
            });
            handler = new Batch(actionsCtx);
        }

        // n distinct SEND sub-commands; SEND is uncapped, so only the global cap can reject.
        function sends(n) {
            const out = [];
            for (let i = 0; i < n; i++) out.push('SEND|0|TEST|' + (i + 1) + '|' + ADDR);
            return out;
        }

        function batchData(commands) {
            return createBaseData({
                ACTION:  'BATCH',
                FORMAT:  0,
                SOURCE,
                TX_DATA: 'BATCH|0|' + commands.join(';'),
            });
        }

        async function run(limitsOn, commands) {
            stubLimits(limitsOn);
            const data = batchData(commands);
            indexer.indexerDb.isActionAllowed.resolves(true);
            await handler.parse(['0'], data, null);
            return data;
        }

        describe('R2 global command cap', function () {

            it('gate ON: exactly 250 commands → valid, every command dispatched', async function () {
                const data = await run(true, sends(250));

                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(actionsCtx.processAction.callCount, 250);
            });

            it('gate ON: 251 commands → single invalid record, no sub-command runs', async function () {
                const data = await run(true, sends(251));

                assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
                assert.strictEqual(actionsCtx.processAction.callCount, 0);
                assert.strictEqual(indexer.indexerDb.createBatch.callCount, 1, 'one whole-batch record');
                assert.strictEqual(indexer.indexerDb.createActionIndex.callCount, 0);
            });

            it('gate ON: empty elements count, so a trailing ";" tips 250 over the cap', async function () {
                // 250 real commands plus the empty tail element = 251 counted commands. The
                // cap error rather than the empty element's ACTION error is what proves the
                // empty was counted AND that the cap runs before the activation scan.
                const data = await run(true, sends(250).concat(['']));

                assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
            });

            it('gate ON: cap error wins over the ISSUE limit error (precedence pinned)', async function () {
                const commands = ['ISSUE|0|AAA', 'ISSUE|0|BBB'].concat(sends(249));
                assert.strictEqual(commands.length, 251);

                const data = await run(true, commands);

                assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
                assert.ok(!String(data['STATUS']).includes('ISSUE'), 'cap error is distinguishable from the ISSUE limit error');
            });

            it('gate OFF: 251 commands stay valid and all dispatch (pre-flag verdict)', async function () {
                const data = await run(false, sends(251));

                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(actionsCtx.processAction.callCount, 251);
            });

            it('gate OFF: trailing ";" keeps the historic ACTION error, not a cap error', async function () {
                const data = await run(false, sends(250).concat(['']));

                assert.strictEqual(data['STATUS'], 'invalid: ACTION (unknown)');
            });

            it('gate OFF: 251 commands with two undotted ISSUEs report the ISSUE limit', async function () {
                const data = await run(false, ['ISSUE|0|AAA', 'ISSUE|0|BBB'].concat(sends(249)));

                assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
            });

        });

        describe('R1 dotted-TICK exemption', function () {

            // One parent plus n children, the headline shape: ISSUE JDOG; ISSUE JDOG.<n>.
            function parentPlusChildren(n) {
                const out = ['ISSUE|0|JDOG'];
                for (let i = 1; i <= n; i++) out.push('ISSUE|0|JDOG.' + i);
                return out;
            }

            it('gate ON: one undotted ISSUE plus 50 dotted children → valid, all 51 dispatched', async function () {
                const data = await run(true, parentPlusChildren(50));

                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(actionsCtx.processAction.callCount, 51);
            });

            it('gate ON: two undotted ISSUEs → invalid: ISSUE (limit)', async function () {
                const data = await run(true, ['ISSUE|0|JDOG', 'ISSUE|0|OTHER']);

                assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
                assert.strictEqual(actionsCtx.processAction.callCount, 0);
            });

            it('gate ON: caret TICKs are NEVER exempt even when they contain a dot', async function () {
                const data = await run(true, ['ISSUE|0|^1.5', 'ISSUE|0|^1.6']);

                assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
            });

            it('gate ON: a caret-dot TICK consumes the single top-level slot', async function () {
                const data = await run(true, ['ISSUE|0|JDOG', 'ISSUE|0|^1.5']);

                assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
            });

            it('gate ON: a lone caret-dot ISSUE is still within the top-level limit', async function () {
                const data = await run(true, ['ISSUE|0|^1.5']);

                assert.strictEqual(data['STATUS'], 'valid');
            });

            it('gate ON: malformed ISSUE with no TICK is not exempt', async function () {
                const data = await run(true, ['ISSUE|0', 'ISSUE|0']);

                assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
            });

            it('gate ON: legacy (no VERSION) dotted ISSUEs classify off the NORMALIZED params', async function () {
                // The classifier must inject the implied VERSION 0 exactly as the dispatch
                // loop does, or TICK would be read at params[0] and JDOG.1 would count as a
                // second top-level issuance.
                const seen = [];
                actionsCtx.processAction = sinon.stub().callsFake(async (action, params) => {
                    seen.push({ action, params: params.slice() });
                });
                const data = await run(true, ['ISSUE|0|JDOG', 'ISSUE|JDOG.1', 'ISSUE|JDOG.2']);

                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(seen.length, 3);
                // The classifier works on its own split copy, so the dispatch loop's params
                // are untouched by it and still carry exactly one injected VERSION.
                assert.deepStrictEqual(seen[1].params, [0, 'JDOG.1']);
                assert.deepStrictEqual(seen[2].params, [0, 'JDOG.2']);
            });

            it('gate ON: MINT is never child-exempt; a dotted TICK counts like any other', async function () {
                // The dotted-TICK exemption is an ISSUE rule (one parent plus its children),
                // never a MINT rule. Two MINTs of ONE dotted tick are still two MINTs of one
                // token; two MINTs of DIFFERENT dotted tokens are two distinct tokens under D7,
                // and it is the resolved id that says so, not the dot.
                indexer.indexerDb.getTickerId.callsFake(async (tick) =>
                    (String(tick) === 'JDOG.1') ? 11 : (String(tick) === 'JDOG.2') ? 12 : null);

                const same = await run(true, ['MINT|0|JDOG.1|10', 'MINT|0|JDOG.1|10']);
                assert.strictEqual(same['STATUS'], 'invalid: MINT (limit)');

                const distinct = await run(true, ['MINT|0|JDOG.1|10', 'MINT|0|JDOG.2|10']);
                assert.strictEqual(distinct['STATUS'], 'valid');
            });

            it('gate OFF: one undotted plus dotted children keeps the pre-flag reject', async function () {
                const data = await run(false, parentPlusChildren(50));

                assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
                assert.strictEqual(actionsCtx.processAction.callCount, 0);
            });

            it('gate OFF: two undotted ISSUEs keep the pre-flag reject', async function () {
                const data = await run(false, ['ISSUE|0|JDOG', 'ISSUE|0|OTHER']);

                assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
            });

            it('gate OFF: caret pair keeps the pre-flag reject', async function () {
                const data = await run(false, ['ISSUE|0|^1.5', 'ISSUE|0|^1.6']);

                assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
            });

            it('gate OFF: malformed no-TICK pair keeps the pre-flag reject', async function () {
                const data = await run(false, ['ISSUE|0', 'ISSUE|0']);

                assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
            });

            it('gate OFF: legacy dotted ISSUEs keep the pre-flag reject', async function () {
                const data = await run(false, ['ISSUE|0|JDOG', 'ISSUE|JDOG.1', 'ISSUE|JDOG.2']);

                assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
            });

            it('gate OFF: a lone dotted ISSUE stays valid (unchanged either side of the flag)', async function () {
                const data = await run(false, ['ISSUE|0|JDOG.1']);

                assert.strictEqual(data['STATUS'], 'valid');
            });

        });

    });

    describe('R4 aggregate gas pre-check (BATCH_ISSUANCE_LIMITS)', function () {

        const ADDR = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';

        // Nominal new-tick issuance fees under the BTC regtest gas schedule:
        // ISSUE 100000 gas and ISSUE_SUBTOKEN 50000 gas, both at GAS_PRICE 0.00001 XCHAIN.
        // Written out rather than recomputed so a schedule change reddens these tests instead
        // of silently re-deriving whatever the code now believes.
        const TOP_FEE   = '1.00000000';
        const CHILD_FEE = '0.50000000';

        // Per-name gate. Sub-action normalization is ON throughout; ISSUANCE_FEE and
        // UNIFIED_FEES are ON because those are the activations under which an ISSUE has a
        // knowable nominal price at all. `limitsOn` is the only variable, so every OFF run
        // below pins the pre-flag verdict for the identical input.
        function stubGates(limitsOn) {
            const known = ['BATCH', 'SEND', 'ISSUE', 'MINT', 'ISSUANCE_FEE', 'UNIFIED_FEES'];
            actionsCtx.protocolChanges.isEnabled = sinon.stub().callsFake(async (name) => {
                if (name === 'BATCH_SUBACTION_NORMALIZATION') return true;
                if (name === 'BATCH_ISSUANCE_LIMITS') return limitsOn;
                return known.includes(name);
            });
            handler = new Batch(actionsCtx);
        }

        // n distinct child issuances under one parent: the spam shape R4 collapses.
        function children(n) {
            const out = [];
            for (let i = 1; i <= n; i++) out.push('ISSUE|0|JDOG.' + i);
            return out;
        }

        // `balance` is the SOURCE's XCHAIN holding, keyed by the mock getTickerId's fixed id 1.
        async function run(limitsOn, commands, balance) {
            stubGates(limitsOn);
            const data = createBaseData({
                ACTION:  'BATCH',
                FORMAT:  0,
                SOURCE,
                TX_DATA: 'BATCH|0|' + commands.join(';'),
            });
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getAddressBalances.resolves(balance === null ? {} : { 1: balance });
            await handler.parse(['0'], data, null);
            return data;
        }

        it('gate ON: a batch the source can afford proceeds and every sub-command still bills itself', async function () {
            // One parent (1.0) plus three children (0.5 each) = 2.5 nominal, exactly covered.
            const data = await run(true, ['ISSUE|0|JDOG'].concat(children(3)), '2.50000000');

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(actionsCtx.processAction.callCount, 4, 'all four sub-commands dispatched');
            assert.strictEqual(indexer.indexerDb.createActionIndex.callCount, 4, 'each still gets its own ACTION_INDEX');
            // The pre-check reads the budget once and bills nobody: per-command billing stays
            // in the handlers, which re-read balances as of their own ACTION_INDEX.
            assert.strictEqual(indexer.indexerDb.getAddressBalances.callCount, 1, 'one read, no per-command billing here');
        });

        it('gate ON: a batch the source provably cannot afford is ONE invalid record, no sub-command runs', async function () {
            const data = await run(true, children(250), '0.00000000');

            assert.strictEqual(data['STATUS'], 'invalid: GAS (insufficient)');
            assert.strictEqual(actionsCtx.processAction.callCount, 0);
            assert.strictEqual(indexer.indexerDb.createBatch.callCount, 1, 'one whole-batch record, not 250 invalid rows');
            assert.strictEqual(indexer.indexerDb.createActionIndex.callCount, 0);
        });

        it('gate ON: the 250-command cap error still wins when both apply', async function () {
            const data = await run(true, children(251), '0.00000000');

            assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
            assert.ok(!String(data['STATUS']).includes('GAS'), 'cap error is distinguishable from the gas error');
        });

        it('gate ON: exactly the cheapest sub-command\'s worth is accepted (boundary)', async function () {
            const data = await run(true, children(3), CHILD_FEE);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(actionsCtx.processAction.callCount, 3, 'the handlers decide which of the three can pay');
        });

        it('gate ON: one satoshi under the cheapest sub-command is rejected (no off-by-one)', async function () {
            const data = await run(true, children(3), '0.49999999');

            assert.strictEqual(data['STATUS'], 'invalid: GAS (insufficient)');
        });

        it('gate ON: the cheapest sub-command sets the bar, not the sum', async function () {
            // A parent plus one child needs 1.5 in total but only 0.5 to land the cheaper of
            // the two. A sum-based predicate would reject this batch and destroy work that
            // really would have succeeded; acceptance test A6 (K affordable => K valid) is the
            // same invariant stated on-chain.
            const data = await run(true, ['ISSUE|0|JDOG', 'ISSUE|0|JDOG.1'], CHILD_FEE);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(actionsCtx.processAction.callCount, 2);
        });

        it('gate ON: a single undotted ISSUE is judged at the top-level price, not the child price', async function () {
            const belowTop = '0.99999999';
            const data = await run(true, ['ISSUE|0|JDOG'], belowTop);

            assert.strictEqual(data['STATUS'], 'invalid: GAS (insufficient)');

            const funded = await run(true, ['ISSUE|0|JDOG'], TOP_FEE);
            assert.strictEqual(funded['STATUS'], 'valid');
        });

        it('gate ON: one non-ISSUE sub-command exempts the whole batch (cost not knowable here)', async function () {
            // SEND's fee is db_hits-derived inside its own handler, so the batch has no
            // provable floor and must proceed even on a zero balance.
            const data = await run(true, children(3).concat(['SEND|0|TEST|1|' + ADDR]), '0.00000000');

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(actionsCtx.processAction.callCount, 4);
        });

        it('gate ON: an existing TICK is a FREE re-issue, so the batch proceeds on a zero balance', async function () {
            indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: 'JDOG.1' }));

            const data = await run(true, children(3), '0.00000000');

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(actionsCtx.processAction.callCount, 3);
        });

        it('gate ON: caret TICKs carry no provable price, so they never trigger the reject', async function () {
            const data = await run(true, ['ISSUE|0|^12'], '0.00000000');

            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('gate ON: the GAS tick is fee-exempt, so its issuance never triggers the reject', async function () {
            const data = await run(true, ['ISSUE|0|' + indexer.config['GAS']], '0.00000000');

            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('gate ON: native-coin fee mode is out of scope (the fee never touches this balance)', async function () {
            stubGates(true);
            const data = createBaseData({
                ACTION:     'BATCH',
                FORMAT:     0,
                SOURCE,
                TX_DATA:    'BATCH|0|' + children(3).join(';'),
                TX_OUTPUTS: [{ address: indexer.config['ADDRESS']['FEE_DESTINATION'], value: '0.001' }],
            });
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getAddressBalances.resolves({});

            await handler.parse(['0'], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(indexer.indexerDb.getAddressBalances.callCount, 0, 'no gas read at all in native mode');
        });

        it('gate ON: ISSUANCE_FEE inactive means no fee to be short of', async function () {
            actionsCtx.protocolChanges.isEnabled = sinon.stub().callsFake(async (name) => {
                if (name === 'ISSUANCE_FEE') return false;
                if (name === 'UNKNOWNACTION') return false;
                return true;
            });
            handler = new Batch(actionsCtx);
            const data = createBaseData({
                ACTION:  'BATCH',
                FORMAT:  0,
                SOURCE,
                TX_DATA: 'BATCH|0|' + children(3).join(';'),
            });
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getAddressBalances.resolves({});

            await handler.parse(['0'], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('gate ON: the TICK probe never interns, and restores the suppression flag', async function () {
            const seen = [];
            indexer.indexerDb.suppressIndexIdCreation = false;
            indexer.indexerDb.getTokenInfo.callsFake(async () => {
                seen.push(indexer.indexerDb.suppressIndexIdCreation);
                return null;
            });

            await run(true, children(2), '5.00000000');

            assert.deepStrictEqual(seen, [true, true], 'every probe ran resolve-only');
            assert.strictEqual(indexer.indexerDb.suppressIndexIdCreation, false, 'prior value restored');
        });

        it('gate ON: a repeated TICK costs one probe, and repeats do not become free', async function () {
            const data = await run(true, ['ISSUE|0|JDOG.1', 'ISSUE|0|JDOG.1', 'ISSUE|0|JDOG.1'], '0.00000000');

            assert.strictEqual(data['STATUS'], 'invalid: GAS (insufficient)');
            assert.strictEqual(indexer.indexerDb.getTokenInfo.callCount, 1, 'memoized per TICK');
        });

        it('gate ON: an earlier verdict short-circuits the check before it reads anything', async function () {
            const data = await run(true, ['ISSUE|0|JDOG', 'ISSUE|0|OTHER'], '0.00000000');

            assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
            assert.strictEqual(indexer.indexerDb.getAddressBalances.callCount, 0, 'no gas read on an already-invalid batch');
            assert.strictEqual(indexer.indexerDb.getTokenInfo.callCount, 0, 'no TICK probes either');
        });

        it('gate OFF: the 250-child no-gas batch keeps the pre-flag verdict', async function () {
            const data = await run(false, children(250), '0.00000000');

            assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
        });

        it('gate OFF: a lone unaffordable child ISSUE stays valid (pre-flag verdict)', async function () {
            const data = await run(false, ['ISSUE|0|JDOG.1'], '0.00000000');

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(actionsCtx.processAction.callCount, 1);
            assert.strictEqual(indexer.indexerDb.getAddressBalances.callCount, 0, 'the pre-check does not run below the flag');
        });

        it('gate OFF: the one-satoshi-under batch keeps the pre-flag verdict', async function () {
            const data = await run(false, children(3), '0.49999999');

            assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
        });

        it('gate OFF: the affordable parent-plus-children batch keeps the pre-flag reject', async function () {
            const data = await run(false, ['ISSUE|0|JDOG'].concat(children(3)), '2.50000000');

            assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
        });

        it('gate OFF: 251 children report the ISSUE limit, not the cap and not gas', async function () {
            const data = await run(false, children(251), '0.00000000');

            assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
        });

    });

    describe('D5 DEPLOY cap and D7 per-token MINT cap (BATCH_ISSUANCE_LIMITS)', function () {

        const ADDR = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';

        // Per-name gate. Normalization is ON throughout (the v2 gate is registered at or after
        // it); `limitsOn` is the only variable, so every OFF run pins the pre-flag verdict for
        // the identical input. DEPLOY is a known ACTION here, which is what makes the pre-flag
        // "unlimited DEPLOYs are accepted" runs below real rather than an activation artefact.
        function stubGates(limitsOn) {
            const known = ['BATCH', 'SEND', 'ISSUE', 'MINT', 'DEPLOY', 'ISSUANCE_FEE', 'UNIFIED_FEES'];
            actionsCtx.protocolChanges.isEnabled = sinon.stub().callsFake(async (name) => {
                if (name === 'BATCH_SUBACTION_NORMALIZATION') return true;
                if (name === 'BATCH_ISSUANCE_LIMITS') return limitsOn;
                return known.includes(name);
            });
            handler = new Batch(actionsCtx);
        }

        // Stand in for db.js getTickerId over a fixed ticker table: NAME lookups are
        // case-insensitive, and a ^<id> reference resolves to that id only when a row backs it,
        // which is what makes `JDOG` and `^614` two spellings of ONE token here.
        function stubTickerTable(table) {
            const ids = Object.values(table);
            indexer.indexerDb.getTickerId.callsFake(async (tick) => {
                const str = String(tick);
                if (str.charAt(0) === '^') {
                    const id = Number(str.substring(1));
                    return ids.includes(id) ? id : null;
                }
                const hit = table[str.toUpperCase()];
                return (hit === undefined) ? null : hit;
            });
        }

        function mints(ticks) {
            return ticks.map((t) => 'MINT|0|' + t + '|10');
        }

        function deploys(n) {
            const out = [];
            for (let i = 0; i < n; i++) out.push('DEPLOY|0|base64|100000|' + i);
            return out;
        }

        function sends(n) {
            const out = [];
            for (let i = 0; i < n; i++) out.push('SEND|0|TEST|' + (i + 1) + '|' + ADDR);
            return out;
        }

        async function run(limitsOn, commands) {
            stubGates(limitsOn);
            const data = createBaseData({
                ACTION:  'BATCH',
                FORMAT:  0,
                SOURCE,
                TX_DATA: 'BATCH|0|' + commands.join(';'),
            });
            indexer.indexerDb.isActionAllowed.resolves(true);
            await handler.parse(['0'], data, null);
            return data;
        }

        describe('D5: DEPLOY capped at 1', function () {

            it('gate ON: one DEPLOY in a batch is accepted', async function () {
                const data = await run(true, deploys(1).concat(sends(2)));

                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(actionsCtx.processAction.callCount, 3);
            });

            it('gate ON: two DEPLOYs → invalid: DEPLOY (limit), no sub-command runs', async function () {
                const data = await run(true, deploys(2));

                assert.strictEqual(data['STATUS'], 'invalid: DEPLOY (limit)');
                assert.strictEqual(actionsCtx.processAction.callCount, 0);
                assert.strictEqual(indexer.indexerDb.createBatch.callCount, 1, 'one whole-batch record');
                assert.strictEqual(indexer.indexerDb.createActionIndex.callCount, 0);
            });

            it('gate ON: the cap is a VM-cost rule, so even 250 DEPLOYs (within the command cap) reject', async function () {
                const data = await run(true, deploys(250));

                assert.strictEqual(data['STATUS'], 'invalid: DEPLOY (limit)');
            });

            it('gate ON: the 250-command cap still wins over the DEPLOY limit', async function () {
                const data = await run(true, deploys(251));

                assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
            });

            it('gate ON: the gated cap is merged into a COPY, never into the stored table', async function () {
                // A cap written into this.actionLimits would apply below the flag too and fork
                // a replay, so the pre-flag table must still be free of DEPLOY afterwards.
                await run(true, deploys(2));

                assert.strictEqual(handler.actionLimits['DEPLOY'], undefined, 'pre-flag table untouched');
                assert.strictEqual(handler.gatedActionLimits['DEPLOY'], 1, 'gated table carries the cap');
            });

            it('gate OFF: unlimited DEPLOYs are accepted and all dispatch (pre-flag verdict)', async function () {
                const data = await run(false, deploys(50));

                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(actionsCtx.processAction.callCount, 50);
            });

            it('gate OFF: two DEPLOYs stay valid (pre-flag verdict)', async function () {
                const data = await run(false, deploys(2));

                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(actionsCtx.processAction.callCount, 2);
            });

        });

        describe('D7: one MINT per DISTINCT token', function () {

            // Twelve real tokens, plus JDOG at id 614 for the caret-alias tests.
            const TABLE = { JDOG: 614 };
            const TWELVE = [];
            for (let i = 1; i <= 12; i++) {
                TABLE['TKN' + i] = 100 + i;
                TWELVE.push('TKN' + i);
            }

            beforeEach(function () {
                stubTickerTable(TABLE);
            });

            it('gate ON: twelve DISTINCT ticks are accepted and all dispatch', async function () {
                const data = await run(true, mints(TWELVE));

                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(actionsCtx.processAction.callCount, 12);
                assert.strictEqual(indexer.indexerDb.getTickerId.callCount, 12, 'one resolution per distinct tick');
            });

            it('gate ON: two MINTs of the SAME tick → invalid: MINT (limit)', async function () {
                const data = await run(true, mints(['TKN1', 'TKN1']));

                assert.strictEqual(data['STATUS'], 'invalid: MINT (limit)');
                assert.strictEqual(actionsCtx.processAction.callCount, 0);
            });

            it('gate ON: eleven distinct ticks plus ONE repeat still reject', async function () {
                const data = await run(true, mints(TWELVE.concat(['TKN7'])));

                assert.strictEqual(data['STATUS'], 'invalid: MINT (limit)');
            });

            it('gate ON: THE CARET ALIAS - JDOG and ^614 are one token, so the pair rejects', async function () {
                // The bypass this rule exists to stop: spell one scarce tick both ways and take
                // two bites at it. Judged on the RESOLVED id, the two spellings are one token.
                const data = await run(true, mints(['JDOG', '^614']));

                assert.strictEqual(data['STATUS'], 'invalid: MINT (limit)');
                assert.strictEqual(actionsCtx.processAction.callCount, 0);
            });

            it('gate ON: the caret alias rejects in either order and in either case', async function () {
                const reversed = await run(true, mints(['^614', 'JDOG']));
                assert.strictEqual(reversed['STATUS'], 'invalid: MINT (limit)');

                const cased = await run(true, mints(['jdog', '^614']));
                assert.strictEqual(cased['STATUS'], 'invalid: MINT (limit)');
            });

            it('gate ON: a caret naming a DIFFERENT token is genuinely distinct', async function () {
                const data = await run(true, mints(['JDOG', '^101']));

                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(actionsCtx.processAction.callCount, 2);
            });

            it('gate ON: one MINT of an UNRESOLVABLE tick is accepted', async function () {
                const data = await run(true, mints(['NOSUCHTICK']));

                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(actionsCtx.processAction.callCount, 1);
            });

            it('gate ON: unresolvable ticks share ONE bucket, so two of them reject', async function () {
                // No id means no evidence of distinctness. Both MINTs are invalid at execution
                // anyway, so nothing that could have landed is lost, and the bucket is what
                // stops two spellings of one REAL token slipping through when neither resolves.
                const data = await run(true, mints(['NOSUCHTICK', 'ALSOUNKNOWN']));

                assert.strictEqual(data['STATUS'], 'invalid: MINT (limit)');
            });

            it('gate ON: the intra-batch alias case (mint a tick this batch is about to ISSUE) rejects', async function () {
                // Resolution is as-of the state BEFORE the first sub-command, so FOO and the id
                // its ISSUE is about to take both resolve to nothing here, yet they would name
                // ONE token by execution time. The shared unresolved bucket is what catches it.
                const data = await run(true, ['ISSUE|0|FOO'].concat(mints(['FOO', '^9001'])));

                assert.strictEqual(data['STATUS'], 'invalid: MINT (limit)');
            });

            it('gate ON: a TICK-less MINT falls in the unresolved bucket without a read', async function () {
                const one = await run(true, ['MINT|0']);
                assert.strictEqual(one['STATUS'], 'valid');
                assert.strictEqual(indexer.indexerDb.getTickerId.callCount, 0, 'no tick, no resolution');

                const two = await run(true, ['MINT|0', 'MINT|0']);
                assert.strictEqual(two['STATUS'], 'invalid: MINT (limit)');
            });

            it('gate ON: legacy (no VERSION) MINT params resolve TICK off the NORMALIZED shape', async function () {
                // MINT's single format is VERSION|TICK|AMOUNT|DESTINATION|MEMO, so an
                // un-normalized legacy MINT carries TICK at params[0]. Reading the raw shape
                // would compare the AMOUNT instead and let one token be minted twice.
                const data = await run(true, ['MINT|JDOG|10', 'MINT|0|^614|10']);

                assert.strictEqual(data['STATUS'], 'invalid: MINT (limit)');
            });

            it('gate ON: 250 MINTs of ONE tick cost exactly ONE resolution (memoized)', async function () {
                const data = await run(true, mints(new Array(250).fill('TKN1')));

                assert.strictEqual(data['STATUS'], 'invalid: MINT (limit)');
                assert.strictEqual(indexer.indexerDb.getTickerId.callCount, 1, 'memoized per tick string');
            });

            it('gate ON: resolution runs intern-suppressed and restores the prior value', async function () {
                const seen = [];
                indexer.indexerDb.suppressIndexIdCreation = false;
                indexer.indexerDb.getTickerId.callsFake(async () => {
                    seen.push(indexer.indexerDb.suppressIndexIdCreation);
                    return null;
                });

                await run(true, mints(['AAA', 'BBB']));

                assert.deepStrictEqual(seen, [true, true], 'every resolution ran resolve-only');
                assert.strictEqual(indexer.indexerDb.suppressIndexIdCreation, false, 'prior value restored');
            });

            it('gate ON: the 250-command cap wins, and costs no resolutions at all', async function () {
                const data = await run(true, mints(new Array(251).fill('TKN1')));

                assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
                assert.strictEqual(indexer.indexerDb.getTickerId.callCount, 0, 'no reads behind an earlier verdict');
            });

            it('gate ON: an earlier ISSUE verdict short-circuits the MINT resolution', async function () {
                const data = await run(true, ['ISSUE|0|AAA', 'ISSUE|0|BBB'].concat(mints(['TKN1', 'TKN1'])));

                assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
                assert.strictEqual(indexer.indexerDb.getTickerId.callCount, 0, 'no reads behind an earlier verdict');
            });

            it('gate OFF: twelve distinct ticks keep the pre-flag reject', async function () {
                const data = await run(false, mints(TWELVE));

                assert.strictEqual(data['STATUS'], 'invalid: MINT (limit)');
                assert.strictEqual(actionsCtx.processAction.callCount, 0);
                assert.strictEqual(indexer.indexerDb.getTickerId.callCount, 0, 'no resolution below the flag');
            });

            it('gate OFF: the caret pair keeps the pre-flag reject', async function () {
                const data = await run(false, mints(['JDOG', '^614']));

                assert.strictEqual(data['STATUS'], 'invalid: MINT (limit)');
            });

            it('gate OFF: two unresolvable ticks keep the pre-flag reject', async function () {
                const data = await run(false, mints(['NOSUCHTICK', 'ALSOUNKNOWN']));

                assert.strictEqual(data['STATUS'], 'invalid: MINT (limit)');
            });

            it('gate OFF: a lone MINT stays valid, resolvable or not (unchanged either side)', async function () {
                const known = await run(false, mints(['TKN1']));
                assert.strictEqual(known['STATUS'], 'valid');

                const unknown = await run(false, mints(['NOSUCHTICK']));
                assert.strictEqual(unknown['STATUS'], 'valid');

                const none = await run(false, ['MINT|0']);
                assert.strictEqual(none['STATUS'], 'valid');
            });

            it('gate OFF: the intra-batch alias batch reports the pre-flag verdict', async function () {
                const data = await run(false, ['ISSUE|0|FOO'].concat(mints(['FOO', '^9001'])));

                assert.strictEqual(data['STATUS'], 'invalid: MINT (limit)');
            });

        });

        describe('composition of the ISSUE, MINT and DEPLOY limits', function () {

            const TABLE = { JDOG: 614 };
            const TWELVE = [];
            for (let i = 1; i <= 12; i++) {
                TABLE['TKN' + i] = 100 + i;
                TWELVE.push('TKN' + i);
            }

            // The operator's stated use case: one top-level ISSUE, 100 children, one DEPLOY and
            // twelve distinct MINTs, 114 commands, every limit satisfied at once.
            function useCase() {
                const out = ['ISSUE|0|JDOG'];
                for (let i = 1; i <= 100; i++) out.push('ISSUE|0|JDOG.' + i);
                out.push('DEPLOY|0|base64|100000|x');
                for (const t of TWELVE) out.push('MINT|0|' + t + '|10');
                return out;
            }

            beforeEach(function () {
                stubTickerTable(TABLE);
                // Fund the source so R4's aggregate gas pre-check is not what decides these.
                indexer.indexerDb.getAddressBalances.resolves({ 1: '1000000' });
            });

            it('gate ON: 1 parent + 100 children + 1 DEPLOY + 12 distinct MINTs is VALID', async function () {
                const commands = useCase();
                assert.strictEqual(commands.length, 114);

                const data = await run(true, commands);

                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(actionsCtx.processAction.callCount, 114);
            });

            it('gate ON: the same batch with a SECOND DEPLOY reports the DEPLOY limit', async function () {
                const data = await run(true, useCase().concat(['DEPLOY|0|base64|100000|y']));

                assert.strictEqual(data['STATUS'], 'invalid: DEPLOY (limit)');
            });

            it('gate ON: the same batch with a REPEATED MINT reports the MINT limit', async function () {
                const data = await run(true, useCase().concat(['MINT|0|TKN3|10']));

                assert.strictEqual(data['STATUS'], 'invalid: MINT (limit)');
            });

            it('gate ON: the same batch with a second UNDOTTED ISSUE reports the ISSUE limit', async function () {
                const data = await run(true, useCase().concat(['ISSUE|0|OTHER']));

                assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
            });

            it('gate ON: padded past 250 commands, the cap beats all three', async function () {
                const commands = useCase().concat(sends(137));
                assert.strictEqual(commands.length, 251);

                const data = await run(true, commands);

                assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
            });

            it('gate OFF: the use-case batch keeps the pre-flag reject (children are not exempt)', async function () {
                const data = await run(false, useCase());

                assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
                assert.strictEqual(actionsCtx.processAction.callCount, 0);
            });

            it('gate OFF: the 251-command padded batch is still just the pre-flag ISSUE reject', async function () {
                const data = await run(false, useCase().concat(sends(137)));

                assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
            });

        });

        /*
         * R2b: among per-ACTION caps, the error names the action whose FIRST sub-command appears
         * EARLIEST in the command list.
         *
         * The status string is consensus, so which of two broken caps names it is a rule and not
         * a formatting choice. It used to be settled by whatever order `for...in` handed back the
         * tally, which happened to be first appearance; these tests own it, so a future refactor
         * to a Map, a sort, or a second counting pass fails HERE instead of forking a chain.
         *
         * Every pair is stated in BOTH directions on purpose. One direction alone is satisfied
         * just as well by alphabetical order, by descending count, or by key insertion, so a
         * one-sided test would go on passing under any of the wrong rules.
         */
        describe('R2b: per-ACTION error precedence is FIRST APPEARANCE', function () {

            const TABLE = { JDOG: 614, PEPE: 700 };

            beforeEach(function () {
                stubTickerTable(TABLE);
                indexer.indexerDb.getAddressBalances.resolves({ 1: '1000000' });
            });

            const issues = ['ISSUE|0|AAA', 'ISSUE|0|BBB'];
            const repeatMints = mints(['JDOG', 'JDOG']);

            it('DEPLOY first, ISSUE second → the DEPLOY limit', async function () {
                const data = await run(true, deploys(2).concat(issues));

                assert.strictEqual(data['STATUS'], 'invalid: DEPLOY (limit)');
            });

            it('ISSUE first, DEPLOY second → the ISSUE limit', async function () {
                const data = await run(true, issues.concat(deploys(2)));

                assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
            });

            it('INTERLEAVED: the action that appears first wins, not the cap completed first', async function () {
                // DEPLOY's second command is LAST in the list, so a rule keyed on which cap was
                // completed first would report ISSUE here.
                const d = deploys(2);
                const onDeploy = await run(true, [d[0], issues[0], issues[1], d[1]]);
                assert.strictEqual(onDeploy['STATUS'], 'invalid: DEPLOY (limit)');

                const onIssue = await run(true, [issues[0], d[0], d[1], issues[1]]);
                assert.strictEqual(onIssue['STATUS'], 'invalid: ISSUE (limit)');
            });

            it('a LARGER overage does not jump the queue', async function () {
                // DEPLOY exceeds its cap by two and ISSUE by one; ISSUE leads, so ISSUE reports.
                const data = await run(true, issues.concat(deploys(3)));

                assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
            });

            it('MINT takes its turn by first appearance despite its substituted count', async function () {
                // MINT is the one cap compared against a per-DISTINCT-TOKEN maximum rather than
                // the raw occurrence count (D7); the substitution must not move its place.
                const onMint = await run(true, repeatMints.concat(issues));
                assert.strictEqual(onMint['STATUS'], 'invalid: MINT (limit)');

                const onIssue = await run(true, issues.concat(repeatMints));
                assert.strictEqual(onIssue['STATUS'], 'invalid: ISSUE (limit)');
            });

            it('MINT before DEPLOY reports MINT, which alphabetical order would reverse', async function () {
                const onMint = await run(true, repeatMints.concat(deploys(2)));
                assert.strictEqual(onMint['STATUS'], 'invalid: MINT (limit)');

                const onDeploy = await run(true, deploys(2).concat(repeatMints));
                assert.strictEqual(onDeploy['STATUS'], 'invalid: DEPLOY (limit)');
            });

            it('uncapped and child-exempt commands take no turn in the queue', async function () {
                const d = deploys(2);
                const data = await run(true, [sends(1)[0], 'ISSUE|0|JDOG.1']
                    .concat([d[0], issues[0], issues[1], d[1]]));

                assert.strictEqual(data['STATUS'], 'invalid: DEPLOY (limit)');
            });

            it('three broken caps: the leader names the error, both directions', async function () {
                const first = await run(true, repeatMints.concat(deploys(2), issues));
                assert.strictEqual(first['STATUS'], 'invalid: MINT (limit)');

                const second = await run(true, issues.concat(deploys(2), repeatMints));
                assert.strictEqual(second['STATUS'], 'invalid: ISSUE (limit)');
            });

            it('an unknown ACTION still outranks the leading per-action cap (R2/F7 unchanged)', async function () {
                const data = await run(true, issues.concat(deploys(2), ['NOPE|0|x']));

                assert.strictEqual(data['STATUS'], 'invalid: ACTION (unknown)');
            });

            it('the 250-command cap still outranks the leading per-action cap', async function () {
                const data = await run(true, issues.concat(deploys(2), sends(247)));
                assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
            });

            it('gate OFF: the same ordering rule decides the pre-flag caps', async function () {
                // Below the flag DEPLOY is uncapped, so the pair that can still collide is
                // MINT against ISSUE. The ordering code is shared across the flag and this is
                // what says so.
                const onMint = await run(false, repeatMints.concat(issues));
                assert.strictEqual(onMint['STATUS'], 'invalid: MINT (limit)');

                const onIssue = await run(false, issues.concat(repeatMints));
                assert.strictEqual(onIssue['STATUS'], 'invalid: ISSUE (limit)');
            });

        });

    });

    describe('R7 weighted cost budget (BATCH_COST_WEIGHTING)', function () {

        const ADDR = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';

        // BATCH_COST_WEIGHTING is registered at or after BATCH_ISSUANCE_LIMITS (asserted in
        // test/unit/batchCostWeightingGate.test.js), so the reachable states are both off,
        // limits only, and both on. `weightsOn` implying `limitsOn` mirrors that ordering
        // rather than testing a window the gate registration forbids.
        function stubGates(limitsOn, weightsOn) {
            const known = ['BATCH', 'SEND', 'MESSAGE', 'ADDRESS', 'AIRDROP', 'BROADCAST', 'ISSUE', 'MINT', 'DEPLOY'];
            actionsCtx.protocolChanges.isEnabled = sinon.stub().callsFake(async (name) => {
                if (name === 'BATCH_SUBACTION_NORMALIZATION') return true;
                if (name === 'BATCH_ISSUANCE_LIMITS') return limitsOn;
                if (name === 'BATCH_COST_WEIGHTING') return weightsOn;
                return known.includes(name);
            });
            handler = new Batch(actionsCtx);
        }

        // SEND is uncapped by every per-ACTION rule, so only the global bound can reject these.
        function sends(n) {
            const out = [];
            for (let i = 0; i < n; i++) out.push('SEND|0|TEST|' + (i + 1) + '|' + ADDR);
            return out;
        }

        async function run(limitsOn, weightsOn, commands, weights) {
            stubGates(limitsOn, weightsOn);
            // Weights are assigned by later rows, one class at a time. Injecting them here is
            // how this suite exercises the ARITHMETIC without depending on which classes have
            // been ratified yet, so it keeps testing the same property as the table fills in.
            if (weights) Object.assign(handler.commandWeights, weights);
            const data = createBaseData({
                ACTION:  'BATCH',
                FORMAT:  0,
                SOURCE,
                TX_DATA: 'BATCH|0|' + commands.join(';'),
            });
            indexer.indexerDb.isActionAllowed.resolves(true);
            await handler.parse(['0'], data, null);
            return data;
        }

        describe('the empty table is arithmetically the count cap it replaces', function () {

            // This is the design's own proof and acceptance test A1 in unit form: with every
            // weight at the default 1, the SUM over a batch IS its command count, so the budget
            // check cannot decide any ordinary batch differently from the cap it replaces.

            it('exactly 250 commands: valid, every command dispatched', async function () {
                const data = await run(true, true, sends(250));

                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(actionsCtx.processAction.callCount, 250);
            });

            it('251 commands: one invalid record, no sub-command runs', async function () {
                const data = await run(true, true, sends(251));

                assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
                assert.strictEqual(actionsCtx.processAction.callCount, 0);
                assert.strictEqual(indexer.indexerDb.createBatch.callCount, 1, 'one whole-batch record');
                assert.strictEqual(indexer.indexerDb.createActionIndex.callCount, 0);
            });

            it('empty elements still count, so a trailing ";" tips 250 over', async function () {
                const data = await run(true, true, sends(250).concat(['']));

                assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
            });

            it('the verdict AND the error string are identical with the budget on and off', async function () {
                // The stronger form of the same claim: not "both reject" but "both reject
                // identically". A weighting that changed the string would break every client
                // that reads it, and the string is consensus.
                for (const commands of [sends(1), sends(249), sends(250), sends(251), sends(400)]) {
                    const off = await run(true, false, commands);
                    const on  = await run(true, true,  commands);
                    assert.strictEqual(on['STATUS'], off['STATUS'],
                        commands.length + ' commands decided differently by the budget');
                }
            });

            it('below BATCH_ISSUANCE_LIMITS nothing bounds the batch, budget or not', async function () {
                // The pre-flag path must stay byte-identical: an unbounded batch was legal then
                // and a replay of that era has to reproduce it.
                const data = await run(false, false, sends(400));

                assert.strictEqual(data['STATUS'], 'valid');
            });
        });

        describe('a weighted action spends the budget faster', function () {

            it('10 sub-commands at weight 25 exactly fill the budget', async function () {
                const data = await run(true, true, sends(10), { SEND: 25 });

                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(actionsCtx.processAction.callCount, 10);
            });

            it('11 sub-commands at weight 25 exceed it, as one record', async function () {
                const data = await run(true, true, sends(11), { SEND: 25 });

                assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
                assert.strictEqual(actionsCtx.processAction.callCount, 0);
                assert.strictEqual(indexer.indexerDb.createBatch.callCount, 1);
            });

            it('the same batch is fine when the weight is not in force', async function () {
                // Pins that the rejection above comes from the WEIGHT and not from the count:
                // 11 commands is far under the cap, so without the table entry it is valid.
                const data = await run(true, true, sends(11));

                assert.strictEqual(data['STATUS'], 'valid');
            });

            it('weights are summed across mixed classes, not taken per class', async function () {
                // 5 at weight 25 plus 126 at the default is 251, one over. Neither class
                // breaches anything on its own, which is the point of a BUDGET.
                const commands = sends(5).concat(
                    Array.from({ length: 126 }, (_, i) => 'MESSAGE|0|m' + i));
                const data = await run(true, true, commands, { SEND: 25 });

                assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
            });
        });

        describe('the weight >= 1 invariant, which the count pre-filter depends on', function () {

            it('an action absent from the table weighs the default 1', async function () {
                stubGates(true, true);
                assert.strictEqual(await handler.subCommandWeight('SEND', 'SEND|0|T|1|' + ADDR, {}, true), 1);
                assert.strictEqual(await handler.subCommandWeight('NOSUCHACTION', 'NOSUCHACTION|0', {}, true), 1);
            });

            it('a nonsense table entry falls back to 1 rather than admitting free work', async function () {
                // A weight of 0 or a negative would let a batch carry unbounded sub-commands of
                // that action, which is the exact failure the budget exists to prevent, and a
                // fractional one would make the sum depend on float arithmetic across nodes.
                stubGates(true, true);
                for (const bad of [0, -5, 1.5, '25', null, NaN, Infinity]) {
                    handler.commandWeights['SEND'] = bad;
                    assert.strictEqual(
                        await handler.subCommandWeight('SEND', 'SEND|0|T|1|' + ADDR, {}, true), 1,
                        'weight ' + String(bad) + ' must fall back to 1');
                }
            });

            it('an oversized batch is refused WITHOUT weighing anything', async function () {
                // Not an optimization: weighing the fan-out classes costs an as-of read per
                // sub-command, so without this filter the envelope lane's ~35,000 sub-commands
                // would each buy a database read before anything bounded them.
                stubGates(true, true);
                const spy = sinon.spy(handler, 'batchWeight');
                const data = createBaseData({
                    ACTION: 'BATCH', FORMAT: 0, SOURCE,
                    TX_DATA: 'BATCH|0|' + sends(5000).join(';'),
                });
                indexer.indexerDb.isActionAllowed.resolves(true);
                await handler.parse(['0'], data, null);

                assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
                assert.strictEqual(spy.callCount, 0, 'the batch was weighed despite failing the count pre-filter');
            });

            it('a batch inside the count is weighed exactly once', async function () {
                stubGates(true, true);
                const spy = sinon.spy(handler, 'batchWeight');
                const data = createBaseData({
                    ACTION: 'BATCH', FORMAT: 0, SOURCE,
                    TX_DATA: 'BATCH|0|' + sends(10).join(';'),
                });
                indexer.indexerDb.isActionAllowed.resolves(true);
                await handler.parse(['0'], data, null);

                assert.strictEqual(spy.callCount, 1);
            });
        });
    });
});
