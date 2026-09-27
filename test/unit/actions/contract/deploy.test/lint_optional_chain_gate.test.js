// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
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
const gateRegistry = require('../../../../../src/consensus/gate_registry.js');

const OPTIONAL_CHAIN_GATE = 'vm_lint_optional_chain_heights.VM_LINT_OPTIONAL_CHAIN_ACTIVATION';

let actionsCtx, handler;
function freshSuite() {
    ({ actionsCtx, handler } = freshDeploySuite());
}

async function optsFor(network, coin, blockIndex) {
    actionsCtx.config['NETWORK'] = network;
    actionsCtx.config['COIN']    = coin;
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

    describe('optional-chain deploy-lint gate threading', function () {
        before(function () {
            const registered = gateRegistry.rows().some(([key]) => key === OPTIONAL_CHAIN_GATE);
            if (!registered) this.skip();
        });

        it('is ON for BTC regtest from genesis', async function () {
            const opts = await optsFor('regtest', 'BTC', 0);
            assert.strictEqual(opts.enforceLintOptionalChain, true);
        });

        it('stays OFF for BTC testnet at height 10000000', async function () {
            const opts = await optsFor('testnet', 'BTC', 10000000);
            assert.strictEqual(opts.enforceLintOptionalChain, false);
        });

        it('stays OFF for BTC mainnet at height 10000000', async function () {
            const opts = await optsFor('mainnet', 'BTC', 10000000);
            assert.strictEqual(opts.enforceLintOptionalChain, false);
        });
    });
});
