// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// Sub-command-level BATCH pre-flight (spec row 46).
//
// A wallet composing a BATCH could get no chain-side verdict at all: BATCH is in
// FEE_QUOTE_DENYLIST, so both public read-only surfaces refused it, and the SDK's Tier 1
// mirrored that refusal client-side. Every batch-only rule (the per-payee COINPAY resolution
// row 30 fixed, the cumulative fee ledger, the 250-command cap) was therefore unreachable from
// a client. The door built here is per-sub-command refusal, NOT a lifted denylist: the batch is
// pre-flighted only when nothing it carries can enter the VM, so the unauthenticated
// compute-under-the-block-loop-mutex primitive the denylist exists to close stays closed.
//
// Three layers, tested separately because only the third is impossible to spell around:
//   1. the policy predicate itself (isBatchProbeForbiddenSubAction)
//   2. computePreflight's wire-string pre-scan, which refuses before the mutex is taken
//   3. batch.js's dispatch-loop guard, on the exact name handed to processAction

const Utility       = require('../../../src/utility.js');
const PreflightMemo = require('../../../src/chain/preflight_memo.js');
const { assert, Actions } = require('./batch_probe_preflight.test/helpers/preflight.js');

const FEE_DEST = 'feeDestinationAddr111111111111111';

function makeUtil(){
    let util = new Utility();
    util.config['COIN']    = 'BTC';
    util.config['ADDRESS'] = Object.assign({}, util.config['ADDRESS'] || {}, { FEE_DESTINATION: FEE_DEST });
    return util;
}

// Same shape preflight.test.js uses: the REAL computePreflight prototype over a stubbed
// dry-run engine, so what is under test is the gate and not the engine.
function makeCtx({ dryRun } = {}){
    let util  = makeUtil();
    let calls = { dryRuns: 0, lastArgs: null };
    let ctx = {
        config:    util.config,
        util:      util,
        indexerDb: { getLatestBlockIndex: async () => 100, getBlockTime: async () => 1000 },
        actionAliases: { TRANSFER: 'SEND', ADDR: 'ADDRESS', DROP: 'AIRDROP', CAST: 'BROADCAST', MSG: 'MESSAGE' },
        _preflightMemo: new PreflightMemo(4),
        _feeQuotePending: 0,
        _calls: calls,
        dryRunAction: async (args) => {
            calls.dryRuns++;
            calls.lastArgs = args;
            return Object.assign({ blockIndex: 100, blockTime: 1000, status: 'valid', error: null,
                                   xchainFee: '0', sourceFeeBalance: null,
                                   subCommands: null, oracleFeesOwed: null }, dryRun || {});
        },
        nativeFeeMandatory: Actions.prototype.nativeFeeMandatory,
        batchProbeForbiddenSubAction: Actions.prototype.batchProbeForbiddenSubAction,
        computePreflight: Actions.prototype.computePreflight,
        computeFeeQuote:  Actions.prototype.computeFeeQuote,
        staticFeeQuote:  Actions.prototype.staticFeeQuote
    };
    return { ctx, calls };
}

describe('BATCH sub-command pre-flight (spec row 46) @regression @tier1', function () {

    describe('probe-forbidden sub-action policy', function () {

        it('refuses every FEE_QUOTE_DENYLIST action, nested BATCH included', function () {
            for(const a of ['DEPLOY', 'EXECUTE', 'XEXEC', 'BATCH'])
                assert.strictEqual(Actions.isBatchProbeForbiddenSubAction(a), true, a + ' must be refused');
        });
        it('refuses the VM-reaching actions the top-level gate does NOT deny', function () {
            // ATTEST and XCALL are 'exempt' and VOTE is 'quotable', so the denylist alone is
            // not a wide enough net for a surface that dispatches real sub-handlers. VOTE's
            // reach is additionally gated by vote.js's IS_SYNTHETIC refusal (measured, not
            // assumed), so its entry here is defence in depth; see the note in src/actions/index.js.
            for(const a of ['ATTEST', 'VOTE', 'XCALL']){
                assert.notStrictEqual(Actions.classifyFeeQuoteAction(a), 'denied',
                    a + ' is expected NOT to be denylisted; if that changed, this test is now vacuous');
                assert.strictEqual(Actions.isBatchProbeForbiddenSubAction(a), true, a + ' must be refused');
            }
        });

        it('allows the ordinary composable sub-actions a batch exists for', function () {
            for(const a of ['SEND', 'ISSUE', 'MINT', 'ORDER', 'COINPAY', 'DISPENSER', 'BROADCAST'])
                assert.strictEqual(Actions.isBatchProbeForbiddenSubAction(a), false, a + ' must be allowed');
        });

        it('normalizes case, whitespace and aliases before deciding', function () {
            for(const a of [' deploy ', 'DePlOy', 'execute'])
                assert.strictEqual(Actions.isBatchProbeForbiddenSubAction(a), true, JSON.stringify(a));
            // An alias must resolve to its canonical name, not be read literally.
            assert.strictEqual(Actions.isBatchProbeForbiddenSubAction('CAST'), false, 'CAST -> BROADCAST');
            assert.strictEqual(Actions.isBatchProbeForbiddenSubAction('msg'), false, 'msg -> MESSAGE');
        });
    });
});

describe('BATCH sub-command pre-flight (spec row 46) @regression @tier1', function () {

    describe('computePreflight wire pre-scan', function () {

        it('pre-flights a batch of ordinary sub-commands and runs the engine as a probe', async function () {
            let { ctx, calls } = makeCtx();
            let r = await ctx.computePreflight({
                action: 'BATCH',
                params: '0|SEND|0|JDOG|1|addr1;SEND|0|JDOG|2|addr2'
            });
            assert.strictEqual(r.supported, true);
            assert.strictEqual(r.denied, undefined);
            assert.strictEqual(r.valid, true);
            assert.strictEqual(calls.dryRuns, 1, 'a safe batch must reach the engine');
            assert.strictEqual(calls.lastArgs.feeProbe, true);
            assert.strictEqual(calls.lastArgs.guardInert, true);
        });

        it('refuses a batch carrying a VM sub-command WITHOUT taking the mutex', async function () {
            for(const sub of ['DEPLOY|0|code', 'EXECUTE|0|1|f', 'XEXEC|0|1', 'BATCH|0|SEND|0|J|1|a',
                              'ATTEST|1|1|x', 'VOTE|2|7', 'XCALL|0|1|f']){
                let { ctx, calls } = makeCtx();
                let r = await ctx.computePreflight({
                    action: 'BATCH',
                    params: '0|SEND|0|JDOG|1|addr1;' + sub
                });
                assert.strictEqual(r.supported, false, sub + ' supported');
                assert.strictEqual(r.denied, true, sub + ' denied');
                assert.strictEqual(r.valid, null, sub + ' valid');
                assert.strictEqual(r.deniedSubAction, String(sub).split('|')[0], sub + ' names the sub-action');
                assert.strictEqual(calls.dryRuns, 0, sub + ' must never reach the engine');
            }
        });

    });
});

describe('BATCH sub-command pre-flight (spec row 46) @regression @tier1', function () {

    describe('computePreflight wire pre-scan', function () {

        it('refuses a VM sub-command however it is spelled', async function () {
            for(const sub of ['deploy|0|code', ' DEPLOY|0|code', 'ExEcUtE|0|1|f']){
                let { ctx, calls } = makeCtx();
                let r = await ctx.computePreflight({ action: 'BATCH', params: '0|' + sub });
                assert.strictEqual(r.denied, true, JSON.stringify(sub));
                assert.strictEqual(calls.dryRuns, 0, JSON.stringify(sub));
            }
        });

        it('refuses when the first sub-command is the VM one (prefix strip still applies)', async function () {
            let { ctx, calls } = makeCtx();
            let r = await ctx.computePreflight({ action: 'BATCH', params: '0|DEPLOY|0|code;SEND|0|J|1|a' });
            assert.strictEqual(r.denied, true);
            assert.strictEqual(r.deniedSubAction, 'DEPLOY');
            assert.strictEqual(calls.dryRuns, 0);
        });

        it('fails CLOSED on an unrecognized VERSION, because the prefix cannot be stripped', async function () {
            // getFormatVersion cannot resolve a non-numeric version, so `BATCH|<fmt>|` does not
            // match and element 0 still reads as BATCH - which is itself forbidden. Refusing a
            // batch the loop would have found harmless is the safe direction.
            let { ctx, calls } = makeCtx();
            let r = await ctx.computePreflight({ action: 'BATCH', params: 'zz|SEND|0|J|1|a' });
            assert.strictEqual(r.denied, true);
            assert.strictEqual(r.deniedSubAction, 'BATCH');
            assert.strictEqual(calls.dryRuns, 0);
        });
    });
});

describe('BATCH sub-command pre-flight (spec row 46) @regression @tier1', function () {

    describe('computePreflight wire pre-scan', function () {

        it('leaves the OTHER denylisted actions flatly refused at top level', async function () {
            for(const a of ['DEPLOY', 'EXECUTE', 'XEXEC']){
                let { ctx, calls } = makeCtx();
                let r = await ctx.computePreflight({ action: a, params: '0|x' });
                assert.strictEqual(r.denied, true, a);
                assert.strictEqual(r.deniedSubAction, undefined, a + ' is not a batch');
                assert.strictEqual(calls.dryRuns, 0, a);
            }
        });

        it('computeFeeQuote still refuses BATCH: this door answers validity, never pricing', async function () {
            // The fee-quote refusal has its own reason - a batch's native fee is the SUM of its
            // sub-actions' state-dependent fees, and a partial quote UNDER-SIZES the output.
            // Opening the validity door must not open the funds-burning one.
            let { ctx, calls } = makeCtx();
            let r = await ctx.computeFeeQuote({ action: 'BATCH', params: '0|SEND|0|J|1|a' });
            assert.strictEqual(r.supported, false);
            assert.strictEqual(r.denied, true);
            assert.strictEqual(calls.dryRuns, 0);
        });

        it('surfaces per-sub-command verdicts and oracle fees owed when the engine reports them', async function () {
            let { ctx } = makeCtx({ dryRun: {
                subCommands: [{ position: 0, action: 'SEND', status: 'valid', refused: null }],
                oracleFeesOwed: { oracleAddr: '0.00002000' }
            }});
            let r = await ctx.computePreflight({ action: 'BATCH', params: '0|SEND|0|J|1|a' });
            assert.deepStrictEqual(r.subCommands, [{ position: 0, action: 'SEND', status: 'valid', refused: null }]);
            assert.deepStrictEqual(r.oracleFeesOwed, { oracleAddr: '0.00002000' });
        });

        it('omits both fields entirely for a non-batch action', async function () {
            let { ctx } = makeCtx();
            let r = await ctx.computePreflight({ action: 'SEND', params: '0|J|1|a' });
            assert.strictEqual(r.subCommands, undefined);
            assert.strictEqual(r.oracleFeesOwed, undefined);
        });
    });
});
