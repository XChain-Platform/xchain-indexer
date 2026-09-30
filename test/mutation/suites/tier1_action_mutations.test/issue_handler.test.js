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
 * Tier 1: ACTION Handler Mutations @tier1: Issue.parse()
 * TICK, source and reserved-name validation mutations.
 *
 * Part of the tier 1 action mutation suite; see
 * ../tier1_action_mutations.test.js, which loads this file.
 */

'use strict';

const assert = require('assert');
const {
    registry, sinon, createBaseData,
} = require('../../setup/harness');
const {
    SOURCE, issueContext,
} = require('./helpers/action_context.js');

// ─────────────────────────────────────────────────────────────────────────────
// Issue Handler Mutations
// ─────────────────────────────────────────────────────────────────────────────

describe('Guard dependency: Tier 1: Issue Handler @tier1', function () {
    let indexer, handler;
    beforeEach(function () { ({ indexer, handler } = issueContext()); });
    afterEach(function () { sinon.restore(); });

    describe('SDL: Statement Deletion : Issue', function () {
        it('SDL-300: TICK null check : empty TICK detected', async function () {
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

        it('SDL-301: TICK character validation : special chars detected', async function () {
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

        it('SDL-302: TICK pipe check : pipe in TICK detected', async function () {
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
    });
});

describe('Guard dependency: Tier 1: Issue Handler @tier1', function () {
    let indexer, handler;
    beforeEach(function () { ({ indexer, handler } = issueContext()); });
    afterEach(function () { sinon.restore(); });

    describe('SDL: Statement Deletion : Issue', function () {
        it('SDL-303: TICK semicolon check : semicolon in TICK detected', async function () {
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

        it('SDL-304: TICK period-start check : TICK starting with dot detected', async function () {
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

        it('SDL-305: TICK length min check : single char TICK detected', async function () {
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
    });
});

describe('Guard dependency: Tier 1: Issue Handler @tier1', function () {
    let indexer, handler;
    beforeEach(function () { ({ indexer, handler } = issueContext()); });
    afterEach(function () { sinon.restore(); });

    describe('SDL: Statement Deletion : Issue', function () {
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

    describe('SBR: String/Boolean : Issue', function () {

        it('SBR-300: Reserved TICK check : XCHAIN token from non-GAS address', async function () {
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
