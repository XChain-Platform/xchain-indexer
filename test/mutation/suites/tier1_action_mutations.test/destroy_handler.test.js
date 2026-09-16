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
 * Tier 1: ACTION Handler Mutations @tier1: Destroy.parse()
 * validation mutations.
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
    SOURCE, makeToken, makeBalances, destroyContext,
} = require('./helpers/action_context.js');

// ─────────────────────────────────────────────────────────────────────────────
// Destroy Handler Mutations
// ─────────────────────────────────────────────────────────────────────────────

describe('Mutation : Tier 1: Destroy Handler @tier1', function () {
    let indexer, handler;
    beforeEach(function () { ({ indexer, handler } = destroyContext()); });
    afterEach(function () { sinon.restore(); });

    describe('SDL: Statement Deletion : Destroy', function () {
        it('SDL-200: TICK existence check deleted : unknown TICK gets valid', async function () {
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
    });
});

describe('Mutation : Tier 1: Destroy Handler @tier1', function () {
    let indexer, handler;
    beforeEach(function () { ({ indexer, handler } = destroyContext()); });
    afterEach(function () { sinon.restore(); });

    describe('SDL: Statement Deletion : Destroy', function () {
        it('SDL-202: Balance check deleted in destroy : zero balance', async function () {
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
    });

    describe('SDL: Statement Deletion : Destroy', function () {
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
});

describe('Mutation : Tier 1: Destroy Handler @tier1', function () {
    let indexer, handler;
    beforeEach(function () { ({ indexer, handler } = destroyContext()); });
    afterEach(function () { sinon.restore(); });

    describe('UOI: Unary Mutations : Destroy', function () {

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
                description: 'hasBalance negated : destroy with funds rejected',
            });
            assert.notStrictEqual(data.STATUS, 'valid');
        });
    });
});
