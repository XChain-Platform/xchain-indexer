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
// DEPLOY meta verdicts: which META_* values reach createContract. One part of
// deploy_contract_meta.test.js; the shared fixtures are in helpers/meta_suite.js.

// Contract meta: every verdict row of CONTRACT_META_REQUIRED driven through the real DEPLOY
// handler, plus the storage half (which META_* values reach createContract) and the

const assert = require('assert');
const sinon  = require('sinon');
const { createBaseData } = require('../../../fixtures/mocks');
const { VALID_CODE_B64, GOOD_META, SOURCE, manifestFor, makeVm, readOf, deployWith, metaArgs, freshMetaSuite } = require('./helpers/meta_suite.js');

const Deploy       = require('../../../../src/actions/deploy/index.js');
const contractMeta = require('../../../../src/actions/deploy/contract_meta.js');
const V            = contractMeta.VERDICTS;

// The suite's fixtures. Every same-title block below runs freshSuite before
// each test, so each test starts from the same fixtures as the rest of the suite.
let indexer, actionsCtx;
function freshSuite() {
    ({ indexer, actionsCtx } = freshMetaSuite());
}

describe('DEPLOY meta verdicts (CONTRACT_META_REQUIRED) @regression @tier1', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    describe('what reaches createContract (seam S3)', function () {

        it('a valid deploy with conforming meta passes all four META_* keys', async function () {
            const { status, createContract } = await deployWith(readOf(GOOD_META));
            assert.strictEqual(status, 'valid');
            assert.deepStrictEqual(metaArgs(createContract), {
                META_NAME:        'Escrow',
                META_DESCRIPTION: 'Two-party escrow with an arbiter',
                META_VERSION:     '1.0.0',
                META_JSON:        JSON.stringify(GOOD_META)
            });
        });

        it('META_JSON is the isolate bytes verbatim, unknown keys and all', async function () {
            const meta = { name: 'Escrow', description: 'Escrow', author: 'nobody', nested: { a: 1 } };
            const { createContract } = await deployWith(readOf(meta));
            assert.strictEqual(metaArgs(createContract).META_JSON, JSON.stringify(meta));
        });

        it('an INVALID deploy writes four NULLs even though its row is still created', async function () {
            const { status, createContract } = await deployWith(readOf(undefined));
            assert.strictEqual(status, V.REQUIRED);
            assert.deepStrictEqual(metaArgs(createContract), {
                META_NAME: null, META_DESCRIPTION: null, META_VERSION: null, META_JSON: null
            });
        });
    });
});

describe('DEPLOY meta verdicts (CONTRACT_META_REQUIRED) @regression @tier1', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    describe('what reaches createContract (seam S3)', function () {

        it('a deploy rejected for a NON-meta reason writes four NULLs even when its meta conforms', async function () {
            const read = { success: true, error: null, manifest: manifestFor(GOOD_META, {
                permissionsType: 'array', permissions: 'SEND'
            }) };
            const { status, createContract } = await deployWith(read);
            assert.strictEqual(status, 'invalid: CONTRACT_MANIFEST (permissions must be an array)');
            assert.deepStrictEqual(metaArgs(createContract), {
                META_NAME: null, META_DESCRIPTION: null, META_VERSION: null, META_JSON: null
            });
        });

        it('a deploy whose CONSTRUCTOR fails writes four NULLs (status is not valid)', async function () {
            const isEnabled = sinon.stub().resolves(true);
            actionsCtx.protocolChanges = { isEnabled };
            const vm = makeVm(readOf(GOOD_META));
            vm.execute = sinon.stub().resolves({
                success: false, error: 'revert: bad init', gasUsed: 100,
                stateChanges: [], stateDeletes: [], emittedActions: []
            });
            actionsCtx.vm = vm;
            const handler = new Deploy(actionsCtx);
            const data = createBaseData({ ACTION: 'DEPLOY', FORMAT: 0, SOURCE, BLOCK_INDEX: 100 });
            await handler.parse(['0', VALID_CODE_B64, '100000', 'initparam'], data, null);
            assert.notStrictEqual(data['STATUS'], 'valid');
            assert.deepStrictEqual(metaArgs(indexer.indexerDb.createContract), {
                META_NAME: null, META_DESCRIPTION: null, META_VERSION: null, META_JSON: null
            });
        });

    });
});
