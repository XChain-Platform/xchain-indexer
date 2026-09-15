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
// DEPLOY unit suite: the per-coin deploy-lint height gates threaded into
// validateSyntax. One part of deploy.test.js; the shared fixtures are in
// helpers/deploy_suite.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { VALID_CODE_B64, makeVm, deployData, freshDeploySuite } = require('./helpers/deploy_suite.js');

const Deploy = require('../../../../../src/actions/deploy/index.js');

// The suite's fixtures. Every same-title block below runs freshSuite before
// each test, so each test starts from the same fixtures as the rest of the suite.
let actionsCtx, handler;
function freshSuite() {
    ({ actionsCtx, handler } = freshDeploySuite());
}

// deploy.js resolves the per-coin Pkg 3 height gate (vm_deploy_lint_pkg3_activation)
// and threads two flags into validateSyntax (enforceBannedGenerator /
// enforceBannedWasm). Below each coin's height both are false so the historical
// accepted verdict replays byte-identically; at/after it both are true so the deploy
// validator blocks. The vm is stubbed here, so this pins the WIRING (which flags,
// resolved from which height), not the rule logic (proven in
// xchain-vm/test/unit/lint_generator_wasm.test.js).

async function optsFor(network, coin, blockIndex) {
    actionsCtx.config['NETWORK'] = network;
    actionsCtx.config['COIN']    = coin;
    const vm = makeVm();
    actionsCtx.vm = vm;
    handler = new Deploy(actionsCtx);
    const data = deployData({ FORMAT: 0, BLOCK_INDEX: blockIndex });
    await handler.parse(['0', VALID_CODE_B64, String(blockIndex || 100), ''], data, null);
    return { data, opts: vm.validateSyntax.firstCall.args[1] };
}

describe('Deploy (DEPLOY) @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    describe('Pkg 3 deploy-lint gate threading (banned-generator + banned-wasm)', function () {
        it('below the BTC mainnet height (960999): both flags OFF, contract still accepted', async function () {
            const { data, opts } = await optsFor('mainnet', 'BTC', 960999);
            assert.strictEqual(opts.enforceBannedGenerator, false);
            assert.strictEqual(opts.enforceBannedWasm, false);
            assert.strictEqual(data['STATUS'], 'valid', 'below-gate deploy verdict must be unchanged (accepted)');
        });

        it('at the BTC mainnet height (961000): both flags ON', async function () {
            const { opts } = await optsFor('mainnet', 'BTC', 961000);
            assert.strictEqual(opts.enforceBannedGenerator, true);
            assert.strictEqual(opts.enforceBannedWasm, true);
        });

        it('is per-coin: LTC and DOGE mainnet at the BTC height stay OFF', async function () {
            assert.strictEqual((await optsFor('mainnet', 'LTC', 961000)).opts.enforceBannedGenerator, false);
            assert.strictEqual((await optsFor('mainnet', 'DOGE', 961000)).opts.enforceBannedWasm, false);
        });

        it('LTC and DOGE flip ON at their own ratified heights', async function () {
            assert.strictEqual((await optsFor('mainnet', 'LTC', 3154250)).opts.enforceBannedGenerator, true);
            assert.strictEqual((await optsFor('mainnet', 'DOGE', 6319000)).opts.enforceBannedWasm, true);
        });

        it('regtest is genesis-armed (both flags ON from height 0)', async function () {
            const { opts } = await optsFor('regtest', 'BTC', 0);
            assert.strictEqual(opts.enforceBannedGenerator, true);
            assert.strictEqual(opts.enforceBannedWasm, true);
        });

        it('threads the new flags ALONGSIDE the existing async / lint-hardening flags (no regression)', async function () {
            const { opts } = await optsFor('regtest', 'BTC', 0);
            assert.ok('enforceBannedAsync' in opts, 'enforceBannedAsync must still be threaded');
            assert.ok('enforceLintHardening' in opts, 'enforceLintHardening must still be threaded');
            assert.ok('enforceBannedGenerator' in opts && 'enforceBannedWasm' in opts, 'new flags must be threaded');
        });

        // The global-alias refinement of banned-async + banned-wasm + banned-math (sloppy-mode
        // `this` and the globalThis self-reference chain both read the global binding) rides a
        // THIRD, separate per-coin height gate, one boolean for all three rules. It cannot ride
        // either gate above: VM_LINT_HARDENING
        // is already open on every network and the Pkg 3 heights are in the past, so reusing
        // either would retroactively reject contracts the chain already accepted. Mainnet is
        // ARMED AT GENESIS on this third gate by the 2026-09-09 ruling (0 contracts, 0 DEPLOY
        // on the indexed mainnet history, measured 2026-09-09), which is what these
        // assertions pin, along with the fact that it is still resolved SEPARATELY from the
        // Pkg 3 heights.

        it('threads enforceLintGlobalAlias as its own flag', async function () {
            const { opts } = await optsFor('regtest', 'BTC', 0);
            assert.ok('enforceLintGlobalAlias' in opts, 'enforceLintGlobalAlias must be threaded');
            assert.strictEqual(opts.enforceLintGlobalAlias, true, 'regtest is genesis-armed');
        });
    });
});

describe('Deploy (DEPLOY) @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    describe('Pkg 3 deploy-lint gate threading (banned-generator + banned-wasm)', function () {
        it('is ON on mainnet at every height, genesis included (armed by the 2026-09-09 ruling)', async function () {
            for (const [coin, height] of [['BTC', 0], ['BTC', 961000], ['LTC', 3154250], ['DOGE', 6319000]]) {
                const { data, opts } = await optsFor('mainnet', coin, height);
                assert.strictEqual(opts.enforceLintGlobalAlias, true,
                    coin + ' mainnet must be armed from genesis, height ' + height);
                assert.strictEqual(data['STATUS'], 'valid', 'the mainnet deploy verdict must be unchanged');
            }
        });

        it('does NOT track the Pkg 3 gate (a separate epoch, resolved separately)', async function () {
            // Both gates are open at the BTC Pkg 3 height now, so agreeing there no longer
            // separates them. What does is the height each opens at: the Pkg 3 flags ride
            // per-coin heights in the past (BTC 961000), the alias flag rides its own map
            // armed at 0, so at mainnet genesis the alias flag is ON while the Pkg 3 flags
            // are still OFF. If someone collapses the two gates, this is what reddens.
            const genesis = await optsFor('mainnet', 'BTC', 0);
            assert.strictEqual(genesis.opts.enforceBannedWasm, false);
            assert.strictEqual(genesis.opts.enforceBannedGenerator, false);
            assert.strictEqual(genesis.opts.enforceLintGlobalAlias, true);
            // And they agree at the Pkg 3 height, which is the other half of "separate":
            // two independent resolutions that happen to coincide, not one flag twice.
            const atPkg3 = await optsFor('mainnet', 'BTC', 961000);
            assert.strictEqual(atPkg3.opts.enforceBannedWasm, true);
            assert.strictEqual(atPkg3.opts.enforceLintGlobalAlias, true);
        });
    });
});
