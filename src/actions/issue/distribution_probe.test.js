/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const sinon = require('sinon');

const ledgerChecks = require('../../db/database/ledger_checks.js');
const { createTokenInfo } = require('../../../test/fixtures/mocks');
const { makeData, LOW_BLOCK, buildIssue } = require('../../../test/unit/actions/token/issue.test/helpers/fixture.js');

const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';

describe('ISSUE distributed CALLBACK verdicts', function () {
    let indexer;
    let handler;

    beforeEach(function () {
        ({ indexer, handler } = buildIssue());
        indexer.indexerDb.isDistributed.resolves(true);
    });

    afterEach(function () {
        sinon.restore();
    });

    const cases = [
        {
            field: 'CALLBACK_BLOCK',
            previous: '500',
            changed: '600',
            params(value) { return ['4', 'MYTOKEN', value, '', '', '']; }
        },
        {
            field: 'CALLBACK_TICK',
            previous: 'OLDTOKEN',
            changed: 'NEWTOKEN',
            params(value) { return ['4', 'MYTOKEN', '', value, '', '']; }
        },
        {
            field: 'CALLBACK_AMOUNT',
            previous: '5',
            changed: '6',
            params(value) { return ['4', 'MYTOKEN', '', '', value, '']; }
        }
    ];

    for(const testCase of cases){
        it(`rejects a changed ${testCase.field} after supply distribution`, async function () {
            const tokenInfo = createTokenInfo({
                TICK: 'MYTOKEN',
                OWNER: SOURCE,
                [testCase.field]: testCase.previous
            });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            const data = makeData({ FORMAT: 4, BLOCK_INDEX: LOW_BLOCK, SOURCE });

            await handler.parse(testCase.params(testCase.changed), data, null);

            assert.strictEqual(data.STATUS, `invalid: ${testCase.field} (supply distributed)`);
            sinon.assert.calledOnce(indexer.indexerDb.isDistributed);
        });

        it(`accepts an unchanged ${testCase.field} after supply distribution`, async function () {
            const tokenInfo = createTokenInfo({
                TICK: 'MYTOKEN',
                OWNER: SOURCE,
                [testCase.field]: testCase.previous
            });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            const data = makeData({ FORMAT: 4, BLOCK_INDEX: LOW_BLOCK, SOURCE });

            await handler.parse(testCase.params(testCase.previous), data, null);

            assert.strictEqual(data.STATUS, 'valid');
            sinon.assert.notCalled(indexer.indexerDb.isDistributed);
        });
    }

    it('does not probe distribution for a description-only edit', async function () {
        const tokenInfo = createTokenInfo({ TICK: 'MYTOKEN', OWNER: SOURCE });
        indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
        const data = makeData({ FORMAT: 1, BLOCK_INDEX: LOW_BLOCK, SOURCE });

        await handler.parse(['1', 'MYTOKEN', 'New description', ''], data, null);

        assert.strictEqual(data.STATUS, 'valid');
        sinon.assert.notCalled(indexer.indexerDb.isDistributed);
    });
});

describe('Database.isDistributed holder verdicts', function () {
    async function isDistributed(holders) {
        const db = {
            getTokenInfo: sinon.stub().resolves({ OWNER: SOURCE }),
            getHolders: sinon.stub().resolves(holders)
        };
        return ledgerChecks.isDistributed.call(db, 'MYTOKEN', 100, 1);
    }

    afterEach(function () {
        sinon.restore();
    });

    it('returns false for an owner-only holder set', async function () {
        assert.strictEqual(await isDistributed({ [SOURCE]: '10' }), false);
    });

    it('returns true for one non-owner holder', async function () {
        assert.strictEqual(await isDistributed({ other: '10' }), true);
    });

    it('returns false when holder balances have netted to zero', async function () {
        assert.strictEqual(await isDistributed({}), false);
    });
});
