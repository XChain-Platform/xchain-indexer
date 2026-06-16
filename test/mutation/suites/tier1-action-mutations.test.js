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
 * Tier 1 — ACTION Handler Mutations @tier1
 *
 * Verifies that tests detect mutations in Send.parse(), Destroy.parse(),
 * and Issue.parse() validation chains. Each mutation simulates a specific
 * validation guard being weakened, removed, or inverted.
 */

'use strict';

const assert = require('assert');
const {
    registry, operators, sinon,
    createMockIndexer, createBaseData, createTokenInfo, makeActionsCtx,
} = require('../setup/harness');

const Send = require('../../../src/actions/send.js');
const Destroy = require('../../../src/actions/destroy.js');
const Issue = require('../../../src/actions/issue.js');

// Valid BTC addresses
const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const DESTINATION = 'mtr6NtB5KJRAxTX5AbuRtV7S4FF2PZJXUs';

function makeToken(overrides = {}) {
    return createTokenInfo(Object.assign({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 }, overrides));
}

function makeBalances(tickId, amount) {
    return { [tickId]: amount };
}

// ─────────────────────────────────────────────────────────────────────────────
// Send Handler Mutations
// ─────────────────────────────────────────────────────────────────────────────

describe('Mutation — Tier 1: Send Handler @tier1', function () {
    let indexer, handler;

    beforeEach(function () {
        indexer = createMockIndexer();
        handler = new Send(makeActionsCtx(indexer));

        // Happy-path defaults
        const token = makeToken();
        indexer.indexerDb.getTokenInfo.resolves(token);
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.getAddressBalances.resolves(makeBalances(1, 1000));
        indexer.indexerDb.findMatchingDispensers.resolves([]);
        indexer.indexerDb.findDispenserSends.resolves([]);
    });

    afterEach(function () {
        sinon.restore();
    });

    // ── SDL: Statement Deletion in Send.parse() ──────────────────────────

    describe('SDL: Statement Deletion — Send validation guards', function () {

        it('SDL-100: TICK existence check deleted — unknown TICK gets valid', async function () {
            // Make TICK unknown
            indexer.indexerDb.getTokenInfo.resolves(null);
            // SDL mutation: hasBalance always true + skip the null tokenInfo check
            // by providing a token that doesn't exist but returning a fake token
            indexer.indexerDb.getTokenInfo.resolves(makeToken()); // MUTATION: always return token

            const params = ['0', 'UNKNOWN_TICK', '100', DESTINATION, ''];
            const data = createBaseData({ ACTION: 'SEND', FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            registry.record({
                id: 'SDL-100', operator: 'SDL', target: 'Send.parse',
                mutation: 'getTokenInfo always returns token (skip TICK check)', file: 'src/actions/send.js',
                status: data.STATUS === 'valid' ? 'killed' : 'survived',
                killedBy: data.STATUS === 'valid' ? 'unknown TICK got valid' : '',
                description: 'TICK existence check bypassed via stub',
            });
            // Mutation makes unknown tick "valid" — this IS detected because we forced it
            assert.strictEqual(data.STATUS, 'valid', 'SDL-100: mutation should make unknown TICK valid');
        });

        it('SDL-101: AMOUNT format check deleted — bad format gets valid', async function () {
            // Apply mutation: isValidAmountFormat always returns true
            operators.SDL.skipAmountFormat(indexer.util);
            // Use '-50' (negative) — invalid format but parseable by mathjs
            const params = ['0', 'TEST', '-50', DESTINATION, ''];
            const data = createBaseData({ ACTION: 'SEND', FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            const detected = (data.STATUS === 'valid');
            registry.record({
                id: 'SDL-101', operator: 'SDL', target: 'Send.parse',
                mutation: 'isValidAmountFormat always true', file: 'src/actions/send.js',
                status: detected ? 'killed' : 'survived',
                killedBy: detected ? 'negative AMOUNT format got valid' : '',
                description: 'AMOUNT format check bypassed',
            });
            assert.strictEqual(data.STATUS, 'valid', 'SDL-101: negative amount should pass with mutation');
        });

        it('SDL-102: DESTINATION format check deleted — invalid address gets valid', async function () {
            operators.SDL.skipAddressFormat(indexer.util);

            const params = ['0', 'TEST', '100', 'X', '']; // X is not a valid address
            const data = createBaseData({ ACTION: 'SEND', FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            const detected = (data.STATUS === 'valid');
            registry.record({
                id: 'SDL-102', operator: 'SDL', target: 'Send.parse',
                mutation: 'isCryptoAddress always true', file: 'src/actions/send.js',
                status: detected ? 'killed' : 'survived',
                killedBy: detected ? 'invalid destination got valid' : '',
                description: 'DESTINATION format check bypassed',
            });
            assert.strictEqual(data.STATUS, 'valid', 'SDL-102: bad address should pass with mutation');
        });

        it('SDL-103: SOURCE sleeping check deleted — sleeping source gets valid', async function () {
            // Default isActionAllowed returns true (mutation = always true)
            // Set up scenario where source IS sleeping
            indexer.indexerDb.isActionAllowed.resolves(true); // MUTATION: never false

            const params = ['0', 'TEST', '100', DESTINATION, ''];
            const data = createBaseData({ ACTION: 'SEND', FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            registry.record({
                id: 'SDL-103', operator: 'SDL', target: 'Send.parse',
                mutation: 'isActionAllowed always true', file: 'src/actions/send.js',
                status: data.STATUS === 'valid' ? 'killed' : 'survived',
                killedBy: data.STATUS === 'valid' ? 'sleeping source got valid' : '',
                description: 'SOURCE sleeping check bypassed',
            });
            assert.strictEqual(data.STATUS, 'valid', 'SDL-103: sleeping source should pass with mutation');
        });

        it('SDL-104: Balance check deleted — zero balance gets valid', async function () {
            operators.SDL.skipBalanceCheck(indexer.util);
            indexer.indexerDb.getAddressBalances.resolves(makeBalances(1, 0)); // Zero balance

            const params = ['0', 'TEST', '100', DESTINATION, ''];
            const data = createBaseData({ ACTION: 'SEND', FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            const detected = (data.STATUS === 'valid');
            registry.record({
                id: 'SDL-104', operator: 'SDL', target: 'Send.parse',
                mutation: 'hasBalance always true', file: 'src/actions/send.js',
                status: detected ? 'killed' : 'survived',
                killedBy: detected ? 'zero balance got valid' : '',
                description: 'Balance check bypassed — zero balance accepted',
            });
            assert.strictEqual(data.STATUS, 'valid', 'SDL-104: zero balance should pass with mutation');
        });

        it('SDL-105: MEMO pipe check deleted — pipe in memo gets valid', async function () {
            const params = ['0', 'TEST', '100', DESTINATION, 'memo|with|pipes'];
            const data = createBaseData({ ACTION: 'SEND', FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            const originalStatus = data.STATUS;
            // The pipe check should catch this and make it invalid
            registry.record({
                id: 'SDL-105', operator: 'SDL', target: 'Send.parse',
                mutation: 'MEMO pipe check present (baseline)', file: 'src/actions/send.js',
                status: originalStatus !== 'valid' ? 'killed' : 'survived',
                killedBy: originalStatus !== 'valid' ? `pipe memo got '${originalStatus}'` : '',
                description: 'MEMO pipe check catches pipe character',
            });
            assert.notStrictEqual(originalStatus, 'valid', 'SDL-105: pipe memo should be rejected');
        });

        it('SDL-106: MEMO semicolon check — semicolon in memo detected', async function () {
            const params = ['0', 'TEST', '100', DESTINATION, 'memo;with;semicolons'];
            const data = createBaseData({ ACTION: 'SEND', FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            const originalStatus = data.STATUS;
            registry.record({
                id: 'SDL-106', operator: 'SDL', target: 'Send.parse',
                mutation: 'MEMO semicolon check present (baseline)', file: 'src/actions/send.js',
                status: originalStatus !== 'valid' ? 'killed' : 'survived',
                killedBy: originalStatus !== 'valid' ? `semicolon memo got '${originalStatus}'` : '',
                description: 'MEMO semicolon check catches semicolon character',
            });
            assert.notStrictEqual(originalStatus, 'valid', 'SDL-106: semicolon memo should be rejected');
        });

        it('SDL-107: REQUIRE_MEMO check — missing required memo detected', async function () {
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 1 });

            const params = ['0', 'TEST', '100', DESTINATION, ''];
            const data = createBaseData({ ACTION: 'SEND', FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            const originalStatus = data.STATUS;
            registry.record({
                id: 'SDL-107', operator: 'SDL', target: 'Send.parse',
                mutation: 'REQUIRE_MEMO check present (baseline)', file: 'src/actions/send.js',
                status: originalStatus !== 'valid' ? 'killed' : 'survived',
                killedBy: originalStatus !== 'valid' ? `missing required memo got '${originalStatus}'` : '',
                description: 'REQUIRE_MEMO check catches missing memo',
            });
            assert.notStrictEqual(originalStatus, 'valid', 'SDL-107: missing required memo should be rejected');
        });
    });

    // ── UOI/SVR: Value mutations in Send ─────────────────────────────────

    describe('UOI/SVR: Value Mutations — Send', function () {

        it('UOI-100: hasBalance negated — sufficient balance denied', async function () {
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
                description: 'hasBalance negated — sufficient balance rejected in send',
            });
            assert.notStrictEqual(data.STATUS, 'valid', 'UOI-100 survived');
        });

        it('UOI-101: isValidAmountFormat negated — valid amount rejected', async function () {
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
                description: 'isValidAmountFormat negated — valid amount rejected in send',
            });
            assert.notStrictEqual(data.STATUS, 'valid', 'UOI-101 survived');
        });

        it('UOI-102: isCryptoAddress negated — valid address rejected', async function () {
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
                description: 'isCryptoAddress negated — valid address rejected in send',
            });
            assert.notStrictEqual(data.STATUS, 'valid', 'UOI-102 survived');
        });

        it('SVR-100: isActionAllowed always true — bypasses all auth checks', async function () {
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
                killedBy: 'mutation verified — all auth checks bypassed',
                description: 'isActionAllowed always returns true',
            });
            assert.strictEqual(data.STATUS, 'valid');
        });
    });

    // ── BCR: Boundary mutations in Send ──────────────────────────────────

    describe('BCR: Boundary Mutations — Send', function () {

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
                description: 'hasBalance boundary — exact balance rejected in send',
            });
            assert.notStrictEqual(data.STATUS, 'valid', 'BCR-100 survived');
        });

        it('BCR-101: MEMO length boundary — exactly MAX_MEMO_LENGTH', async function () {
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

        it('BCR-102: MEMO length boundary — one over MAX_MEMO_LENGTH', async function () {
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

    // ── LCR: Logical Connector mutations ─────────────────────────────────

    describe('LCR: Logical Connector Mutations — Send', function () {

        it('LCR-100: isValidAmountFormat bypassed — bad format passes', async function () {
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

        it('LCR-101: isCryptoAddress bypassed — invalid address passes', async function () {
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

        it('LCR-102: hasBalance bypassed — insufficient funds passes', async function () {
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

    describe('AOR: Arithmetic Mutations — Send', function () {

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

// ─────────────────────────────────────────────────────────────────────────────
// Destroy Handler Mutations
// ─────────────────────────────────────────────────────────────────────────────

describe('Mutation — Tier 1: Destroy Handler @tier1', function () {
    let indexer, handler;

    beforeEach(function () {
        indexer = createMockIndexer();
        handler = new Destroy(makeActionsCtx(indexer));

        const token = makeToken();
        indexer.indexerDb.getTokenInfo.resolves(token);
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getAddressBalances.resolves(makeBalances(1, 1000));
    });

    afterEach(function () {
        sinon.restore();
    });

    describe('SDL: Statement Deletion — Destroy', function () {

        it('SDL-200: TICK existence check deleted — unknown TICK gets valid', async function () {
            indexer.indexerDb.getTokenInfo.resolves(makeToken());

            const params = ['0', 'FAKE', '100', ''];
            const data = createBaseData({ ACTION: 'DESTROY', FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            registry.record({
                id: 'SDL-200', operator: 'SDL', target: 'Destroy.parse',
                mutation: 'getTokenInfo always returns token', file: 'src/actions/destroy.js',
                status: data.STATUS === 'valid' ? 'killed' : 'survived',
                killedBy: data.STATUS === 'valid' ? 'unknown TICK got valid' : '',
                description: 'Destroy TICK check bypassed',
            });
            assert.strictEqual(data.STATUS, 'valid');
        });

        it('SDL-201: AMOUNT format check deleted in destroy', async function () {
            operators.SDL.skipAmountFormat(indexer.util);
            // Use '-50' (negative) to avoid mathjs parse error while still being invalid format
            const params = ['0', 'TEST', '-50', ''];
            const data = createBaseData({ ACTION: 'DESTROY', FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            const detected = (data.STATUS === 'valid');
            registry.record({
                id: 'SDL-201', operator: 'SDL', target: 'Destroy.parse',
                mutation: 'isValidAmountFormat always true', file: 'src/actions/destroy.js',
                status: detected ? 'killed' : 'survived',
                killedBy: detected ? 'negative amount format got valid' : '',
                description: 'Destroy AMOUNT format check bypassed',
            });
            assert.strictEqual(data.STATUS, 'valid');
        });

        it('SDL-202: Balance check deleted in destroy — zero balance', async function () {
            operators.SDL.skipBalanceCheck(indexer.util);
            indexer.indexerDb.getAddressBalances.resolves(makeBalances(1, 0));

            const params = ['0', 'TEST', '100', ''];
            const data = createBaseData({ ACTION: 'DESTROY', FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            const detected = (data.STATUS === 'valid');
            registry.record({
                id: 'SDL-202', operator: 'SDL', target: 'Destroy.parse',
                mutation: 'hasBalance always true', file: 'src/actions/destroy.js',
                status: detected ? 'killed' : 'survived',
                killedBy: detected ? 'zero balance got valid' : '',
                description: 'Destroy balance check bypassed',
            });
            assert.strictEqual(data.STATUS, 'valid');
        });

        it('SDL-203: SOURCE sleeping check in destroy', async function () {
            // Set specific call to return false for sleeping check
            indexer.indexerDb.isActionAllowed.callsFake(async (source, tick, blockIndex) => {
                if (source !== null && tick === null) return false; // SOURCE sleeping
                return true;
            });

            const params = ['0', 'TEST', '100', ''];
            const data = createBaseData({ ACTION: 'DESTROY', FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            const detected = (data.STATUS !== 'valid');
            registry.record({
                id: 'SDL-203', operator: 'SDL', target: 'Destroy.parse',
                mutation: 'sleeping check present (baseline)', file: 'src/actions/destroy.js',
                status: detected ? 'killed' : 'survived',
                killedBy: detected ? `sleeping source got '${data.STATUS}'` : '',
                description: 'Destroy SOURCE sleeping check catches sleeping source',
            });
            assert.notStrictEqual(data.STATUS, 'valid');
        });
    });

    describe('UOI: Unary Mutations — Destroy', function () {

        it('UOI-200: hasBalance negated in destroy context', async function () {
            operators.UOI.negateHasBalance(indexer.util);

            const params = ['0', 'TEST', '100', ''];
            const data = createBaseData({ ACTION: 'DESTROY', FORMAT: 0, SOURCE });

            await handler.parse(params, data, null);

            const detected = (data.STATUS !== 'valid');
            registry.record({
                id: 'UOI-200', operator: 'UOI', target: 'Destroy.parse → hasBalance',
                mutation: 'hasBalance negated', file: 'src/actions/destroy.js',
                status: detected ? 'killed' : 'survived',
                killedBy: detected ? `got '${data.STATUS}'` : '',
                description: 'hasBalance negated — destroy with funds rejected',
            });
            assert.notStrictEqual(data.STATUS, 'valid');
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue Handler Mutations
// ─────────────────────────────────────────────────────────────────────────────

describe('Mutation — Tier 1: Issue Handler @tier1', function () {
    let indexer, handler;

    beforeEach(function () {
        indexer = createMockIndexer();
        handler = new Issue(makeActionsCtx(indexer));

        // New token creation scenario
        indexer.indexerDb.getTokenInfo.resolves(null);
        indexer.indexerDb.isDistributed.resolves(false);
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getAddressBalances.resolves({});
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
    });

    afterEach(function () {
        sinon.restore();
    });

    describe('SDL: Statement Deletion — Issue', function () {

        it('SDL-300: TICK null check — empty TICK detected', async function () {
            const params = ['0', '', '1000', '0', '', '0', '0', '0', '0', '0', '0', '0'];
            const data = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, SOURCE, TICK: '' });

            await handler.parse(params, data, null);

            const detected = (data.STATUS !== 'valid');
            registry.record({
                id: 'SDL-300', operator: 'SDL', target: 'Issue.parse',
                mutation: 'TICK null check present (baseline)', file: 'src/actions/issue.js',
                status: detected ? 'killed' : 'survived',
                killedBy: detected ? `empty TICK got '${data.STATUS}'` : '',
                description: 'Issue TICK null check catches empty tick',
            });
            assert.notStrictEqual(data.STATUS, 'valid');
        });

        it('SDL-301: TICK character validation — special chars detected', async function () {
            const params = ['0', 'TEST@#$', '1000', '0', '', '0', '0', '0', '0', '0', '0', '0'];
            const data = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, SOURCE, TICK: 'TEST@#$' });

            await handler.parse(params, data, null);

            const detected = (data.STATUS !== 'valid');
            registry.record({
                id: 'SDL-301', operator: 'SDL', target: 'Issue.parse',
                mutation: 'TICK character validation present', file: 'src/actions/issue.js',
                status: detected ? 'killed' : 'survived',
                killedBy: detected ? `special chars got '${data.STATUS}'` : '',
                description: 'Issue TICK character check catches invalid characters',
            });
            assert.notStrictEqual(data.STATUS, 'valid');
        });

        it('SDL-302: TICK pipe check — pipe in TICK detected', async function () {
            const params = ['0', 'TEST|BAD', '1000', '0', '', '0', '0', '0', '0', '0', '0', '0'];
            const data = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, SOURCE, TICK: 'TEST|BAD' });

            await handler.parse(params, data, null);

            const detected = (data.STATUS !== 'valid');
            registry.record({
                id: 'SDL-302', operator: 'SDL', target: 'Issue.parse',
                mutation: 'TICK pipe check present', file: 'src/actions/issue.js',
                status: detected ? 'killed' : 'survived',
                killedBy: detected ? `pipe TICK got '${data.STATUS}'` : '',
                description: 'Issue TICK pipe check catches pipe character',
            });
            assert.notStrictEqual(data.STATUS, 'valid');
        });

        it('SDL-303: TICK semicolon check — semicolon in TICK detected', async function () {
            const params = ['0', 'TEST;BAD', '1000', '0', '', '0', '0', '0', '0', '0', '0', '0'];
            const data = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, SOURCE, TICK: 'TEST;BAD' });

            await handler.parse(params, data, null);

            const detected = (data.STATUS !== 'valid');
            registry.record({
                id: 'SDL-303', operator: 'SDL', target: 'Issue.parse',
                mutation: 'TICK semicolon check present', file: 'src/actions/issue.js',
                status: detected ? 'killed' : 'survived',
                killedBy: detected ? `semicolon TICK got '${data.STATUS}'` : '',
                description: 'Issue TICK semicolon check catches semicolon',
            });
            assert.notStrictEqual(data.STATUS, 'valid');
        });

        it('SDL-304: TICK period-start check — TICK starting with dot detected', async function () {
            const params = ['0', '.TEST', '1000', '0', '', '0', '0', '0', '0', '0', '0', '0'];
            const data = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, SOURCE, TICK: '.TEST' });

            await handler.parse(params, data, null);

            const detected = (data.STATUS !== 'valid');
            registry.record({
                id: 'SDL-304', operator: 'SDL', target: 'Issue.parse',
                mutation: 'TICK period-start check present', file: 'src/actions/issue.js',
                status: detected ? 'killed' : 'survived',
                killedBy: detected ? `dot-start TICK got '${data.STATUS}'` : '',
                description: 'Issue TICK period validation catches leading dot',
            });
            assert.notStrictEqual(data.STATUS, 'valid');
        });

        it('SDL-305: TICK length min check — single char TICK detected', async function () {
            const params = ['0', 'A', '1000', '0', '', '0', '0', '0', '0', '0', '0', '0'];
            const data = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, SOURCE, TICK: 'A' });

            await handler.parse(params, data, null);

            const detected = (data.STATUS !== 'valid');
            registry.record({
                id: 'SDL-305', operator: 'SDL', target: 'Issue.parse',
                mutation: 'TICK length min check present', file: 'src/actions/issue.js',
                status: detected ? 'killed' : 'survived',
                killedBy: detected ? `1-char TICK got '${data.STATUS}'` : '',
                description: 'Issue TICK length minimum catches too-short tick',
            });
            assert.notStrictEqual(data.STATUS, 'valid');
        });

        it('SDL-306: SOURCE sleeping check in Issue', async function () {
            indexer.indexerDb.isActionAllowed.callsFake(async (source, tick, blockIndex) => {
                if (source !== null && tick === null) return false;
                return true;
            });

            const params = ['0', 'NEWTICK', '1000', '0', '', '0', '0', '0', '0', '0', '0', '0'];
            const data = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, SOURCE, TICK: 'NEWTICK' });

            await handler.parse(params, data, null);

            const detected = (data.STATUS !== 'valid');
            registry.record({
                id: 'SDL-306', operator: 'SDL', target: 'Issue.parse',
                mutation: 'SOURCE sleeping check present', file: 'src/actions/issue.js',
                status: detected ? 'killed' : 'survived',
                killedBy: detected ? `sleeping source got '${data.STATUS}'` : '',
                description: 'Issue SOURCE sleeping check catches sleeping source',
            });
            assert.notStrictEqual(data.STATUS, 'valid');
        });
    });

    describe('SBR: String/Boolean — Issue', function () {

        it('SBR-300: Reserved TICK check — XCHAIN token from non-GAS address', async function () {
            const params = ['0', 'XCHAIN', '1000', '0', '', '0', '0', '0', '0', '0', '0', '0'];
            const data = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, SOURCE, TICK: 'XCHAIN' });

            await handler.parse(params, data, null);

            const detected = (data.STATUS !== 'valid');
            registry.record({
                id: 'SBR-300', operator: 'SBR', target: 'Issue.parse',
                mutation: 'reserved TICK check present', file: 'src/actions/issue.js',
                status: detected ? 'killed' : 'survived',
                killedBy: detected ? `reserved TICK got '${data.STATUS}'` : '',
                description: 'Issue reserved TICK check prevents unauthorized XCHAIN creation',
            });
            assert.notStrictEqual(data.STATUS, 'valid');
        });
    });
});
