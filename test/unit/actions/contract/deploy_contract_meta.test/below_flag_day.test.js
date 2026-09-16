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
// DEPLOY meta verdicts below the CONTRACT_META_REQUIRED flag day: every verdict is
// today's, and only a conforming meta is stored. One part of
// deploy_contract_meta.test.js; the shared fixtures are in helpers/meta_suite.js.

// Contract meta: every verdict row of CONTRACT_META_REQUIRED driven through the real DEPLOY
// handler, plus the storage half (which META_* values reach createContract) and the

const assert = require('assert');
const sinon  = require('sinon');
const { createBaseData } = require('../../../../fixtures/mocks');
const { VALID_CODE_B64, GOOD_META, SOURCE, makeVm, readOf, deployWith, metaArgs, freshMetaSuite } = require('./helpers/meta_suite.js');

const Deploy       = require('../../../../../src/actions/deploy/index.js');

// The suite's fixtures. Every same-title block below runs freshSuite before
// each test, so each test starts from the same fixtures as the rest of the suite.
let actionsCtx;
function freshSuite() {
    ({ actionsCtx } = freshMetaSuite());
}

describe('DEPLOY meta verdicts (CONTRACT_META_REQUIRED) @regression @tier1', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    describe('BELOW the flag day', function () {

        const badVectors = [
            ['a module-level throw',       { success: false, manifest: null, error: 'boom' }],
            ['an unparseable report',      { success: true,  manifest: null, error: null }],
            ['no meta export',             readOf(undefined)],
            ['meta null',                  readOf(null)],
            ['meta as an array',           readOf(['x'])],
            ['a bidi name',                readOf({ name: 'Esc\u202Erow', description: 'Bidi' })],
            ["version ''",                 readOf({ name: 'Escrow', description: 'Escrow', version: '' })]
        ];

        for (const [label, read] of badVectors) {
            it(label + ' still deploys with TODAY\'s verdict (valid), so a from-genesis replay is unchanged', async function () {
                const { status } = await deployWith(read, false);
                assert.strictEqual(status, 'valid');
            });
        }

        it('a conforming meta is STILL handed to createContract below the flag day', async function () {
            const { status, createContract } = await deployWith(readOf(GOOD_META), false);
            assert.strictEqual(status, 'valid');
            assert.deepStrictEqual(metaArgs(createContract), {
                META_NAME:        'Escrow',
                META_DESCRIPTION: 'Two-party escrow with an arbiter',
                META_VERSION:     '1.0.0',
                META_JSON:        JSON.stringify(GOOD_META)
            });
        });
    });
});

describe('DEPLOY meta verdicts (CONTRACT_META_REQUIRED) @regression @tier1', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    describe('BELOW the flag day', function () {

        it('a NON-conforming meta hands four NULLs below the flag day (it deploys valid, but stores nothing)', async function () {
            const { status, createContract } = await deployWith(readOf({ name: '\u00A0Escrow', description: 'Leading NBSP' }), false);
            assert.strictEqual(status, 'valid');
            assert.deepStrictEqual(metaArgs(createContract), {
                META_NAME: null, META_DESCRIPTION: null, META_VERSION: null, META_JSON: null
            });
        });

        it('an absent meta hands four NULLs below the flag day', async function () {
            const { status, createContract } = await deployWith(readOf(undefined), false);
            assert.strictEqual(status, 'valid');
            assert.deepStrictEqual(metaArgs(createContract), {
                META_NAME: null, META_DESCRIPTION: null, META_VERSION: null, META_JSON: null
            });
        });

        it('the gate is consulted by NAME: only CONTRACT_META_REQUIRED turns the verdict off', async function () {
            const isEnabled = sinon.stub().resolves(true);
            isEnabled.withArgs('CONTRACT_META_REQUIRED', sinon.match.any).resolves(false);
            actionsCtx.protocolChanges = { isEnabled };
            actionsCtx.vm = makeVm(readOf(undefined));
            const handler = new Deploy(actionsCtx);
            const data = createBaseData({ ACTION: 'DEPLOY', FORMAT: 0, SOURCE, BLOCK_INDEX: 100 });
            await handler.parse(['0', VALID_CODE_B64, '100000', ''], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(isEnabled.calledWith('CONTRACT_META_REQUIRED', 100),
                'the verdict must resolve the gate on THIS deploy\'s block index');
        });

    });
});
