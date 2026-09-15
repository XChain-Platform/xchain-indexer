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
// The DEPLOY unit suite. This file holds format, code and syntax validation,
// source sleeping and record creation. The other behaviours are in the parts
// under deploy.test/, and the shared fixtures in deploy.test/helpers/deploy_suite.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { VALID_CODE_B64, makeVm, deployData, freshDeploySuite } = require('./deploy.test/helpers/deploy_suite.js');

const Deploy = require('../../../../src/actions/deploy/index.js');

// The suite's fixtures. Every same-title block below runs freshSuite before
// each test, so each test starts from the same fixtures as the rest of the suite.
let indexer, actionsCtx, handler;
function freshSuite() {
    ({ indexer, actionsCtx, handler } = freshDeploySuite());
}

describe('Deploy (DEPLOY) @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    // ─── Format validation ────────────────────────────────────────────────

    describe('format validation', function () {

        it('rejects an unknown VERSION', async function () {
            const data = deployData({ FORMAT: 9 });
            await handler.parse(['9', VALID_CODE_B64, '100000', ''], data, null);
            assert.ok(String(data['STATUS']).includes('VERSION'));
        });

        it('accepts FORMAT 0', async function () {
            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_B64, '100000', ''], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });

    });
});

describe('Deploy (DEPLOY) @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    // ─── Code validations ─────────────────────────────────────────────────

    describe('code validations', function () {

        it('rejects missing CODE_ENCODING', async function () {
            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', '', '100000', ''], data, null);
            assert.ok(String(data['STATUS']).includes('CODE_ENCODING'));
        });

        it('rejects code exceeding MAX_CODE_SIZE', async function () {
            // 64KiB + 1 byte
            const bigCode = 'a'.repeat(Deploy.MAX_CODE_SIZE + 1);
            const bigB64  = Buffer.from(bigCode, 'utf8').toString('base64');
            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', bigB64, '100000', ''], data, null);
            assert.ok(String(data['STATUS']).includes('CODE_ENCODING'));
        });

        it('VM-isolate maxCodeSize is single-sourced from the shared MAX_CODE_SIZE (no drift-prone literal)', function () {
            // The DEPLOY byte-length check and the actions/index.js VM-isolate limit must be the
            // same value or an oversized contract passes one gate and fails the other. Guard
            // that actions/index.js references the shared constant instead of a bare 65536 literal
            // that could silently drift from Deploy.MAX_CODE_SIZE.
            const fs  = require('fs');
            const src = fs.readFileSync(require('path').join(__dirname, '../../../../src/actions/index.js'), 'utf8');
            assert.ok(/maxCodeSize:\s*deploy\.MAX_CODE_SIZE/.test(src),
                'actions.js VM-isolate config must set maxCodeSize from deploy.MAX_CODE_SIZE');
            assert.ok(!/maxCodeSize:\s*\d/.test(src),
                'actions.js must not hard-code a numeric maxCodeSize literal');
            assert.strictEqual(Deploy.MAX_CODE_SIZE, 65536, 'canonical MAX_CODE_SIZE value pin');
        });

        it('rejects missing GAS_LIMIT', async function () {
            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_B64, '', ''], data, null);
            assert.ok(String(data['STATUS']).includes('GAS_LIMIT'));
        });

        it('rejects non-numeric GAS_LIMIT', async function () {
            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_B64, 'abc', ''], data, null);
            assert.ok(String(data['STATUS']).includes('GAS_LIMIT'));
        });

    });
});

describe('Deploy (DEPLOY) @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    // ─── VM syntax rejection ──────────────────────────────────────────────

    describe('VM syntax validation', function () {

        it('rejects code that fails syntax validation', async function () {
            actionsCtx.vm = makeVm({
                validateSyntax: sinon.stub().returns({ valid: false, error: 'SyntaxError: unexpected token' }),
            });
            handler = new Deploy(actionsCtx);

            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_B64, '100000', ''], data, null);
            assert.ok(String(data['STATUS']).includes('CODE_ENCODING'));
        });

        it('accepts code that passes syntax validation', async function () {
            actionsCtx.vm = makeVm();
            handler = new Deploy(actionsCtx);

            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_B64, '100000', ''], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });

    });

    // ─── SOURCE sleeping ──────────────────────────────────────────────────

    describe('source sleeping', function () {

        it('rejects when SOURCE is sleeping', async function () {
            indexer.indexerDb.isActionAllowed.resolves(false);
            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_B64, '100000', ''], data, null);
            assert.ok(String(data['STATUS']).includes('sleeping'));
        });

    });
});

describe('Deploy (DEPLOY) @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    // ─── DB record writes ─────────────────────────────────────────────────

    describe('record creation', function () {

        it('createContract called on valid deploy', async function () {
            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_B64, '100000', ''], data, null);
            assert.ok(indexer.indexerDb.createContract.calledOnce);
        });

        it('createContractExecution always called', async function () {
            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_B64, '100000', ''], data, null);
            assert.ok(indexer.indexerDb.createContractExecution.calledOnce);
        });

        it('updateBalances and updateTokens called after parse', async function () {
            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_B64, '100000', ''], data, null);
            assert.ok(indexer.indexerDb.updateBalances.calledOnce);
            assert.ok(indexer.indexerDb.updateTokens.calledOnce);
        });

        it('mapper.createMappings called after parse', async function () {
            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_B64, '100000', ''], data, null);
            assert.ok(indexer.mapper.createMappings.calledOnce);
        });

    });
});
