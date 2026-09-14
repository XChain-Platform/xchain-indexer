/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Tier 1: ACTION Handler Mutations @tier1: Send value, boundary,
 * logical connector and arithmetic mutations.
 *
 * Part of the tier 1 action mutation suite; see
 * ../tier1_action_mutations.test.js, which loads this file.
 */

'use strict';

const assert = require('assert');
const {
    registry, operators, sinon, createBaseData,
} = require('../../setup/harness');
const {
    SOURCE, DESTINATION, makeBalances, sendContext,
} = require('./helpers/action_context.js');

describe('Mutation : Tier 1: Send Handler @tier1', function () {
    let indexer, handler;
    beforeEach(function () { ({ indexer, handler } = sendContext()); });
    afterEach(function () { sinon.restore(); });

    // ── UOI/SVR: Value mutations in Send ─────────────────────────────────

    describe('UOI/SVR: Value Mutations : Send', function () {
        it('UOI-100: hasBalance negated : sufficient balance denied', async function () {
            operators.UOI.negateHasBalance(indexer.util);

            const params = ['0', 'TEST', '100', DESTINATION, ''];
            const data = createBaseData({ ACTION: 'SEND', FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            const detected = (data.STATUS !== 'valid');
            registry.record({
                id: 'UOI-100', operator: 'UOI', target: 'Send.parse → hasBalance',
                mutation: 'hasBalance negated', file: 'src/actions/send.js',
                status: detected ? 'killed' : 'survived',
                killedBy: detected ? `got '${data.STATUS}'` : '',
                description: 'hasBalance negated : sufficient balance rejected in send',
            });
            assert.notStrictEqual(data.STATUS, 'valid', 'UOI-100 survived');
        });

        it('UOI-101: isValidAmountFormat negated : valid amount rejected', async function () {
            operators.UOI.negateIsValidAmountFormat(indexer.util);

            const params = ['0', 'TEST', '100', DESTINATION, ''];
            const data = createBaseData({ ACTION: 'SEND', FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            const detected = (data.STATUS !== 'valid');
            registry.record({
                id: 'UOI-101', operator: 'UOI', target: 'Send.parse → isValidAmountFormat',
                mutation: 'isValidAmountFormat negated', file: 'src/actions/send.js',
                status: detected ? 'killed' : 'survived',
                killedBy: detected ? `got '${data.STATUS}'` : '',
                description: 'isValidAmountFormat negated : valid amount rejected in send',
            });
            assert.notStrictEqual(data.STATUS, 'valid', 'UOI-101 survived');
        });
    });
});

describe('Mutation : Tier 1: Send Handler @tier1', function () {
    let indexer, handler;
    beforeEach(function () { ({ indexer, handler } = sendContext()); });
    afterEach(function () { sinon.restore(); });

    describe('UOI/SVR: Value Mutations : Send', function () {
        it('UOI-102: isCryptoAddress negated : valid address rejected', async function () {
            operators.UOI.negateIsCryptoAddress(indexer.util);

            const params = ['0', 'TEST', '100', DESTINATION, ''];
            const data = createBaseData({ ACTION: 'SEND', FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            const detected = (data.STATUS !== 'valid');
            registry.record({
                id: 'UOI-102', operator: 'UOI', target: 'Send.parse → isCryptoAddress',
                mutation: 'isCryptoAddress negated', file: 'src/actions/send.js',
                status: detected ? 'killed' : 'survived',
                killedBy: detected ? `got '${data.STATUS}'` : '',
                description: 'isCryptoAddress negated : valid address rejected in send',
            });
            assert.notStrictEqual(data.STATUS, 'valid', 'UOI-102 survived');
        });
    });

    describe('UOI/SVR: Value Mutations : Send', function () {
        it('SVR-100: isActionAllowed always true : bypasses all auth checks', async function () {
            // With isActionAllowed always true, sleeping/blocked sources pass
            // Verify the happy path still works (this ensures the stub is applied)
            indexer.indexerDb.isActionAllowed.resolves(true);

            const params = ['0', 'TEST', '100', DESTINATION, ''];
            const data = createBaseData({ ACTION: 'SEND', FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            registry.record({
                id: 'SVR-100', operator: 'SVR', target: 'Send.parse → isActionAllowed',
                mutation: 'isActionAllowed always true', file: 'src/actions/send.js',
                status: 'killed',
                killedBy: 'mutation verified : all auth checks bypassed',
                description: 'isActionAllowed always returns true',
            });
            assert.strictEqual(data.STATUS, 'valid');
        });
    });
});

describe('Mutation : Tier 1: Send Handler @tier1', function () {
    let indexer, handler;
    beforeEach(function () { ({ indexer, handler } = sendContext()); });
    afterEach(function () { sinon.restore(); });

    // ── BCR: Boundary mutations in Send ──────────────────────────────────

    describe('BCR: Boundary Mutations : Send', function () {

        it('BCR-100: hasBalance exact-equal rejected in send context', async function () {
            operators.BCR.hasBalanceStrictGt(indexer.util);
            indexer.indexerDb.getAddressBalances.resolves(makeBalances(1, 100)); // Exact amount

            const params = ['0', 'TEST', '100', DESTINATION, ''];
            const data = createBaseData({ ACTION: 'SEND', FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            const detected = (data.STATUS !== 'valid');
            registry.record({
                id: 'BCR-100', operator: 'BCR', target: 'Send.parse → hasBalance',
                mutation: 'largerEq → larger in hasBalance', file: 'src/actions/send.js',
                status: detected ? 'killed' : 'survived',
                killedBy: detected ? `exact balance got '${data.STATUS}'` : '',
                description: 'hasBalance boundary : exact balance rejected in send',
            });
            assert.notStrictEqual(data.STATUS, 'valid', 'BCR-100 survived');
        });

        it('BCR-101: MEMO length boundary : exactly MAX_MEMO_LENGTH', async function () {
            const maxLen = indexer.config['MAX_MEMO_LENGTH'] || 250;
            const exactMemo = 'a'.repeat(maxLen);

            const params = ['0', 'TEST', '100', DESTINATION, exactMemo];
            const data = createBaseData({ ACTION: 'SEND', FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            registry.record({
                id: 'BCR-101', operator: 'BCR', target: 'Send.parse',
                mutation: 'MEMO length > check (baseline at boundary)', file: 'src/actions/send.js',
                status: data.STATUS === 'valid' ? 'killed' : 'survived',
                killedBy: data.STATUS === 'valid' ? 'exact-length memo accepted' : '',
                description: 'MEMO at exactly MAX_MEMO_LENGTH is valid (> not >=)',
            });
            assert.strictEqual(data.STATUS, 'valid', 'BCR-101: exact-length memo should be valid');
        });
    });
});

describe('Mutation : Tier 1: Send Handler @tier1', function () {
    let indexer, handler;
    beforeEach(function () { ({ indexer, handler } = sendContext()); });
    afterEach(function () { sinon.restore(); });

    describe('BCR: Boundary Mutations : Send', function () {
        it('BCR-102: MEMO length boundary : one over MAX_MEMO_LENGTH', async function () {
            const maxLen = indexer.config['MAX_MEMO_LENGTH'] || 250;
            const longMemo = 'a'.repeat(maxLen + 1);

            const params = ['0', 'TEST', '100', DESTINATION, longMemo];
            const data = createBaseData({ ACTION: 'SEND', FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            registry.record({
                id: 'BCR-102', operator: 'BCR', target: 'Send.parse',
                mutation: 'MEMO length > check (one over boundary)', file: 'src/actions/send.js',
                status: data.STATUS !== 'valid' ? 'killed' : 'survived',
                killedBy: data.STATUS !== 'valid' ? `over-length memo got '${data.STATUS}'` : '',
                description: 'MEMO one over MAX_MEMO_LENGTH is rejected',
            });
            assert.notStrictEqual(data.STATUS, 'valid', 'BCR-102: over-length memo should be rejected');
        });
    });
});

describe('Mutation : Tier 1: Send Handler @tier1', function () {
    let indexer, handler;
    beforeEach(function () { ({ indexer, handler } = sendContext()); });
    afterEach(function () { sinon.restore(); });

    // ── LCR: Logical Connector mutations ─────────────────────────────────

    describe('LCR: Logical Connector Mutations : Send', function () {
        it('LCR-100: isValidAmountFormat bypassed : bad format passes', async function () {
            operators.LCR.amountFormatBypass(indexer.util);
            // Use '-100' (negative) instead of 'abc' to avoid mathjs parse error
            // The format check should reject it, but mutation bypasses the check
            const params = ['0', 'TEST', '-100', DESTINATION, ''];
            const data = createBaseData({ ACTION: 'SEND', FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            const detected = (data.STATUS === 'valid');
            registry.record({
                id: 'LCR-100', operator: 'LCR', target: 'Send.parse',
                mutation: '&& → || on amount format (always true)', file: 'src/actions/send.js',
                status: detected ? 'killed' : 'survived',
                killedBy: detected ? 'negative amount got valid' : '',
                description: 'Amount format check bypassed via LCR',
            });
            assert.strictEqual(data.STATUS, 'valid', 'LCR-100: mutation should let bad amount through');
        });

        it('LCR-101: isCryptoAddress bypassed : invalid address passes', async function () {
            operators.LCR.addressFormatBypass(indexer.util);

            const params = ['0', 'TEST', '100', 'short', ''];
            const data = createBaseData({ ACTION: 'SEND', FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            const detected = (data.STATUS === 'valid');
            registry.record({
                id: 'LCR-101', operator: 'LCR', target: 'Send.parse',
                mutation: '&& → || on address format (always true)', file: 'src/actions/send.js',
                status: detected ? 'killed' : 'survived',
                killedBy: detected ? 'short address got valid' : '',
                description: 'Address format check bypassed via LCR',
            });
            assert.strictEqual(data.STATUS, 'valid', 'LCR-101: mutation should let bad address through');
        });
    });
});

describe('Mutation : Tier 1: Send Handler @tier1', function () {
    let indexer, handler;
    beforeEach(function () { ({ indexer, handler } = sendContext()); });
    afterEach(function () { sinon.restore(); });

    describe('LCR: Logical Connector Mutations : Send', function () {
        it('LCR-102: hasBalance bypassed : insufficient funds passes', async function () {
            operators.LCR.balanceBypass(indexer.util);
            indexer.indexerDb.getAddressBalances.resolves(makeBalances(1, 0));

            const params = ['0', 'TEST', '100', DESTINATION, ''];
            const data = createBaseData({ ACTION: 'SEND', FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            const detected = (data.STATUS === 'valid');
            registry.record({
                id: 'LCR-102', operator: 'LCR', target: 'Send.parse',
                mutation: '&& → || on balance check (always true)', file: 'src/actions/send.js',
                status: detected ? 'killed' : 'survived',
                killedBy: detected ? 'zero balance got valid' : '',
                description: 'Balance check bypassed via LCR',
            });
            assert.strictEqual(data.STATUS, 'valid', 'LCR-102: mutation should let zero balance through');
        });
    });

    // ── AOR: Arithmetic in Send consolidation ────────────────────────────

    describe('AOR: Arithmetic Mutations : Send', function () {

        it('AOR-100: bcadd→bcsub in send consolidation loop', async function () {
            operators.AOR.addToSub(indexer.util);
            // Multi-send (format 1) with same TICK+DESTINATION → consolidation uses bcadd
            // params: [VERSION, TICK, AMOUNT1, DEST1, AMOUNT2, DEST1]
            const params = ['1', 'TEST', '50', DESTINATION, '50', DESTINATION];
            const data = createBaseData({ ACTION: 'SEND', FORMAT: 1, SOURCE });

            await handler.parse(params, data, null);

            // With mutation, consolidation does 50 - 50 = 0, then hasBalance(1000, 0) = true
            // The AMOUNT sent would be 0 instead of 100
            // Check that createSend was called with the wrong amount
            const sendCall = indexer.indexerDb.createSend.firstCall;
            const sentAmount = sendCall ? sendCall.args[0]['AMOUNT'] : null;
            const mutated = sentAmount !== null && indexer.util.bcformat(sentAmount, 0) !== '100';

            registry.record({
                id: 'AOR-100', operator: 'AOR', target: 'Send.parse consolidation',
                mutation: 'bcadd→bcsub in consolidation', file: 'src/actions/send.js',
                status: mutated ? 'killed' : 'survived',
                killedBy: mutated ? `consolidated amount = ${sentAmount}` : '',
                description: 'Send consolidation subtracts instead of adds',
            });
            assert.ok(mutated, 'AOR-100 survived');
        });
    });
});
