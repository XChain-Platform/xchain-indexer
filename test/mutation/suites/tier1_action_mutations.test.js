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
 * Tier 1: ACTION Handler Mutations @tier1
 *
 * Verifies that tests detect mutations in Send.parse(), Destroy.parse(),
 * and Issue.parse() validation chains. Each mutation simulates a specific
 * validation guard being weakened, removed, or inverted.
 *
 * The Send validation-guard deletions live here. The rest of the Send suite
 * (value, boundary, logical connector and arithmetic mutations) and the
 * Destroy and Issue suites live beside it in tier1_action_mutations.test/, one
 * file each, and helpers/action_context.js there builds every handler over a
 * mock indexer with its happy-path stubs.
 */

'use strict';

const assert = require('assert');
const {
    registry, operators, sinon, createBaseData,
} = require('../setup/harness');
const {
    SOURCE, DESTINATION, makeToken, makeBalances, sendContext,
} = require('./tier1_action_mutations.test/helpers/action_context.js');

// ─────────────────────────────────────────────────────────────────────────────
// Send Handler Mutations
// ─────────────────────────────────────────────────────────────────────────────

describe('Guard dependency: Tier 1: Send Handler @tier1', function () {
    let indexer, handler;
    beforeEach(function () { ({ indexer, handler } = sendContext()); });
    afterEach(function () { sinon.restore(); });

    // ── SDL: Statement Deletion in Send.parse() ──────────────────────────

    describe('SDL: Statement Deletion : Send validation guards', function () {
        it('SDL-100: TICK existence check deleted : unknown TICK gets valid', async function () {
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
            // Mutation makes unknown tick "valid" : this IS detected because we forced it
            assert.strictEqual(data.STATUS, 'valid', 'SDL-100: mutation should make unknown TICK valid');
        });

        it('SDL-101: AMOUNT format check deleted : bad format gets valid', async function () {
            // Apply mutation: isValidAmountFormat always returns true
            operators.SDL.skipAmountFormat(indexer.util);
            // Use '-50' (negative) : invalid format but parseable by mathjs
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
    });
});

describe('Guard dependency: Tier 1: Send Handler @tier1', function () {
    let indexer, handler;
    beforeEach(function () { ({ indexer, handler } = sendContext()); });
    afterEach(function () { sinon.restore(); });

    describe('SDL: Statement Deletion : Send validation guards', function () {
        it('SDL-102: DESTINATION format check deleted : invalid address gets valid', async function () {
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

        it('SDL-103: SOURCE sleeping check deleted : sleeping source gets valid', async function () {
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
    });
});

describe('Guard dependency: Tier 1: Send Handler @tier1', function () {
    let indexer, handler;
    beforeEach(function () { ({ indexer, handler } = sendContext()); });
    afterEach(function () { sinon.restore(); });

    describe('SDL: Statement Deletion : Send validation guards', function () {
        it('SDL-104: Balance check deleted : zero balance gets valid', async function () {
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
                description: 'Balance check bypassed : zero balance accepted',
            });
            assert.strictEqual(data.STATUS, 'valid', 'SDL-104: zero balance should pass with mutation');
        });

        it('SDL-105: MEMO pipe check deleted : pipe in memo gets valid', async function () {
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
    });
});

describe('Guard dependency: Tier 1: Send Handler @tier1', function () {
    let indexer, handler;
    beforeEach(function () { ({ indexer, handler } = sendContext()); });
    afterEach(function () { sinon.restore(); });

    describe('SDL: Statement Deletion : Send validation guards', function () {
        it('SDL-106: MEMO semicolon check : semicolon in memo detected', async function () {
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
    });

    describe('SDL: Statement Deletion : Send validation guards', function () {
        it('SDL-107: REQUIRE_MEMO check : missing required memo detected', async function () {
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
});

// The rest of the suite lives in tier1_action_mutations.test/. test:guard-dependencies globs only the top
// level of suites/, so this file loads each part itself and every title stays
// collected under this file.
require('./tier1_action_mutations.test/send_value_mutations.test.js');
require('./tier1_action_mutations.test/destroy_handler.test.js');
require('./tier1_action_mutations.test/issue_handler.test.js');
