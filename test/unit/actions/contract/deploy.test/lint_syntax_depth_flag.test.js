// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { VALID_CODE_B64, makeVm, deployData, freshDeploySuite } = require('./helpers/deploy_suite.js');

const Deploy = require('../../../../../src/actions/deploy/index.js');

let actionsCtx, handler;
function freshSuite() {
    ({ actionsCtx, handler } = freshDeploySuite());
}

async function optsFor(network, blockIndex) {
    actionsCtx.config['NETWORK'] = network;
    actionsCtx.config['COIN']    = 'BTC';
    const vm = makeVm();
    actionsCtx.vm = vm;
    handler = new Deploy(actionsCtx);
    const data = deployData({ FORMAT: 0, BLOCK_INDEX: blockIndex });
    await handler.parse(['0', VALID_CODE_B64, String(blockIndex || 100), ''], data, null);
    return vm.validateSyntax.firstCall.args[1];
}

describe('Deploy (DEPLOY) @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    describe('syntax-depth deploy-lint gate threading', function () {
        it('passes enforceLintSyntaxDepth true on regtest from genesis', async function () {
            assert.strictEqual((await optsFor('regtest', 0)).enforceLintSyntaxDepth, true);
        });

        it('passes enforceLintSyntaxDepth false on testnet and mainnet while the row is unarmed', async function () {
            assert.strictEqual((await optsFor('testnet', 9999999998)).enforceLintSyntaxDepth, false);
            assert.strictEqual((await optsFor('mainnet', 9999999998)).enforceLintSyntaxDepth, false);
        });
    });
});
