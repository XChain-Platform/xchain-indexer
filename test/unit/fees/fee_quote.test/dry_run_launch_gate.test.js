// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The read-only quote surfaces apply the mainnet launch gate the block loop applies.
//
// Before MAINNET_LAUNCH_ACTIVATION the block loop skips every mainnet transaction that is not
// a validator wire action or from a pinned seed source, so the chain gives it no verdict. A
// pre-flight that ran the handler anyway would answer valid for a transaction the chain drops.

const assert = require('assert');

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const Utility = require('../../../../src/utility.js');
const Actions = require('../../../../src/actions/index.js');
const gateRegistry = require('../../../../src/consensus/gate_registry.js');
const { NOT_ADMITTED_BEFORE_LAUNCH } = require('../../../../src/actions/actions_class/dry_run_support.js');

const LAUNCH = gateRegistry.get('mainnet_launch_activation.MAINNET_LAUNCH_ACTIVATION').mainnet;
const SOURCE = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const FEE_DESTINATION = '1CounterpartyXXXXXXXXXXXXXXXUWLpVr';

// A dry-run context on `network` whose tip block carries `tipTime`; it counts handler runs.
function makeCtx(network, tipTime){
    let util  = new Utility();
    let calls = { handler: 0, begin: 0, rollback: 0 };
    let ctx = {
        util,
        config: Object.assign({}, util.config, { NETWORK: network, COIN: 'BTC',
            ADDRESS: { FEE_DESTINATION: FEE_DESTINATION }, BLOCK_PROCESS_TIMEOUT: 300000 }),
        actionAliases: {},
        calls,
        indexerDb: {
            getLatestBlockIndex: async () => 100,
            getBlockTime:        async () => tipTime,
            beginTransaction:    async () => { calls.begin++; },
            rollbackTransaction: async () => { calls.rollback++; },
            currentTxEpoch:      () => 0,
            runInDryRunEpoch:    (epoch, fn) => fn(),
            getFeeRecord:        async () => null
        },
        processTransaction: async () => { calls.handler++; return { STATUS: 'valid', ACTION_INDEX: 7 }; }
    };
    return ctx;
}

function dryRun(ctx, action, params){
    return Actions.prototype.dryRunAction.call(ctx, { action, params, source: SOURCE, timeoutMs: 5000 });
}

describe('quote surfaces : the mainnet launch gate @regression @tier1', function () {

    it('refuses a pre-launch mainnet SEND without running the handler', async function () {
        const ctx = makeCtx('mainnet', LAUNCH - 600);
        const run = await dryRun(ctx, 'SEND', ['0', 'TEST', '1', SOURCE]);
        assert.strictEqual(run.status, NOT_ADMITTED_BEFORE_LAUNCH);
        assert.strictEqual(run.xchainFee, null, 'a dropped transaction owes no fee');
        assert.strictEqual(ctx.calls.handler, 0, 'the handler ran for a transaction the chain skips');
        assert.strictEqual(ctx.calls.rollback, ctx.calls.begin, 'the transaction must still be released');
    });

    it('runs the handler for a mainnet SEND at the launch time', async function () {
        const ctx = makeCtx('mainnet', LAUNCH);
        const run = await dryRun(ctx, 'SEND', ['0', 'TEST', '1', SOURCE]);
        assert.strictEqual(run.status, 'valid');
        assert.strictEqual(ctx.calls.handler, 1);
    });

    it('runs the handler for a pre-launch validator PRICE v0 on mainnet', async function () {
        const ctx = makeCtx('mainnet', LAUNCH - 600);
        await dryRun(ctx, 'PRICE', ['0', '1', '1', '100', '1']);
        assert.strictEqual(ctx.calls.handler, 1, 'a validator wire action is admitted before launch');
    });

    it('runs the handler on regtest whatever the block time', async function () {
        const ctx = makeCtx('regtest', 1000);
        await dryRun(ctx, 'SEND', ['0', 'TEST', '1', SOURCE]);
        assert.strictEqual(ctx.calls.handler, 1);
    });

    it('refuses a pre-launch mainnet fee-exempt quote instead of answering valid', async function () {
        const ctx = makeCtx('mainnet', LAUNCH - 600);
        const quote = await Actions.prototype.computeFeeQuote.call(ctx,
            { action: 'COINPAY', params: ['0', '42'], source: SOURCE });
        assert.strictEqual(quote.valid, false);
        assert.strictEqual(quote.error, NOT_ADMITTED_BEFORE_LAUNCH);
    });

    it('answers a fee-exempt quote as before on regtest', async function () {
        const ctx = makeCtx('regtest', 1000);
        const quote = await Actions.prototype.computeFeeQuote.call(ctx,
            { action: 'COINPAY', params: ['0', '42'], source: SOURCE });
        assert.strictEqual(quote.valid, true);
        assert.strictEqual(quote.feeExempt, true);
    });
});
