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
// DEPLOY meta verdicts: which verdict wins when a contract is bad twice, and
// function-export contracts. One part of deploy_contract_meta.test.js; the shared
// fixtures are in helpers/meta_suite.js.

// Contract meta: every verdict row of CONTRACT_META_REQUIRED driven through the real DEPLOY
// handler, plus the storage half (which META_* values reach createContract) and the

const assert = require('assert');
const sinon  = require('sinon');
const { manifestFor, readOf, deployWith, metaArgs, freshMetaSuite } = require('./helpers/meta_suite.js');

const contractMeta = require('../../../../src/actions/deploy/contract_meta.js');
const V            = contractMeta.VERDICTS;

// Every same-title block below runs this before each test, so each test
// starts from the same fixtures as the rest of the suite.
function freshSuite() {
    freshMetaSuite();
}

describe('DEPLOY meta verdicts (CONTRACT_META_REQUIRED) @regression @tier1', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    describe('verdict precedence', function () {

        it('a contract bad on permissions AND meta reports the PERMISSIONS string (meta is judged after)', async function () {
            const read = { success: true, error: null, manifest: manifestFor(undefined, {
                permissionsType: 'array', permissions: 'SEND'      // declared array, is a string
            }) };
            const { status } = await deployWith(read);
            assert.strictEqual(status, 'invalid: CONTRACT_MANIFEST (permissions must be an array)');
        });

        it('a contract bad on maxTakeBps AND meta reports the MAX_TAKE_BPS string', async function () {
            const read = { success: true, error: null, manifest: manifestFor(undefined, {
                maxTakeBpsType: 'number', maxTakeBps: 99999
            }) };
            const { status } = await deployWith(read);
            assert.strictEqual(status, 'invalid: CONTRACT_MANIFEST (maxTakeBps must be an integer in [0, 10000])');
        });

        it('a vector bad on TWO meta rows reports the EARLIER row (name before description)', async function () {
            const { status } = await deployWith(readOf({ name: '', description: '' }));
            assert.strictEqual(status, V.NAME);
        });

        it('a vector bad on the description AND the version reports the DESCRIPTION row', async function () {
            const { status } = await deployWith(readOf({ name: 'Escrow', description: '', version: '' }));
            assert.strictEqual(status, V.DESCRIPTION);
        });

        it('an oversize meta whose name is also bad reports the OVERSIZE row', async function () {
            const { status } = await deployWith(readOf({ name: '', description: 'x', filler: 'y'.repeat(5000) }));
            assert.strictEqual(status, V.OVERSIZE);
        });

    });
});

describe('DEPLOY meta verdicts (CONTRACT_META_REQUIRED) @regression @tier1', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    describe('function-export contracts (R1)', function () {

        it('a function export WITHOUT f.meta reports metaType undefined and is (meta required)', async function () {
            // What a function export reports today: __ce is {} for a non-object, so nothing
            // is found. With the wrapper change, meta is read off the function itself.
            const { status } = await deployWith(readOf(undefined, { hasInitialize: true }));
            assert.strictEqual(status, V.REQUIRED);
        });

        it('a function export WITH f.meta reports metaType object and deploys valid with its columns', async function () {
            const meta = { name: 'Ping', description: 'Returns ok', version: '1.0.0' };
            const { status, createContract } = await deployWith(readOf(meta, { hasInitialize: false }));
            assert.strictEqual(status, 'valid');
            assert.deepStrictEqual(metaArgs(createContract), {
                META_NAME: 'Ping', META_DESCRIPTION: 'Returns ok', META_VERSION: '1.0.0',
                META_JSON: JSON.stringify(meta)
            });
        });

    });
});
