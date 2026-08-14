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

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const Utility       = require('../../src/utility.js');
const Actions       = require('../../src/actions.js');
const PreflightMemo = require('../../src/preflightMemo.js');
const Batch         = require('../../src/actions/batch.js');
const Dispenser     = require('../../src/actions/dispenser.js');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../fixtures/mocks');

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
        _dryRunAction: async (args) => {
            calls.dryRuns++;
            calls.lastArgs = args;
            return Object.assign({ blockIndex: 100, blockTime: 1000, status: 'valid', error: null,
                                   xchainFee: '0', sourceFeeBalance: null,
                                   subCommands: null, oracleFeesOwed: null }, dryRun || {});
        },
        _nativeFeeMandatory: Actions.prototype._nativeFeeMandatory,
        _batchProbeForbiddenSubAction: Actions.prototype._batchProbeForbiddenSubAction,
        computePreflight: Actions.prototype.computePreflight,
        computeFeeQuote:  Actions.prototype.computeFeeQuote,
        _staticFeeQuote:  Actions.prototype._staticFeeQuote
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
            // assumed), so its entry here is defence in depth; see the note in src/actions.js.
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

    describe('batch.js dispatch-loop guard (the load-bearing one)', function () {
        let indexer, actionsCtx, handler;
        const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';

        beforeEach(function () {
            indexer    = createMockIndexer();
            actionsCtx = {
                config:          indexer.config,
                util:            indexer.util,
                mapper:          indexer.mapper,
                decoderDb:       indexer.decoderDb,
                indexerDb:       indexer.indexerDb,
                protocolChanges: { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) },
                // Model a handler: every dispatched sub-command records its own verdict on the
                // shared data object, which is what the loop reads back.
                processAction:   sinon.stub().callsFake(async (action, params, data) => {
                    data['STATUS'] = 'valid:' + action;
                }),
                actionAliases:   { TRANSFER: 'SEND', ADDR: 'ADDRESS', DROP: 'AIRDROP', CAST: 'BROADCAST', MSG: 'MESSAGE' }
            };
            handler = new Batch(actionsCtx);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1000000' });
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.util.resetLists();
        });

        afterEach(function () { sinon.restore(); });

        const WIRE = 'BATCH|0|SEND|0|TEST|10|mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM;DEPLOY|0|Y29kZQ==;SEND|0|TEST|5|mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';

        function probeData(){
            return createBaseData({ ACTION: 'BATCH', FORMAT: 0, SOURCE, TX_DATA: WIRE, FEE_PROBE: true });
        }

        it('never dispatches a VM sub-command on the probe path', async function () {
            const data = probeData();
            await handler.parse(['0'], data, null);

            const dispatched = actionsCtx.processAction.getCalls().map(c => c.args[0]);
            assert.deepStrictEqual(dispatched, ['SEND', 'SEND'],
                'DEPLOY reached processAction on a read-only probe');
        });

        it('reports the refusal in place rather than dropping the sub-command', async function () {
            const data = probeData();
            await handler.parse(['0'], data, null);

            assert.deepStrictEqual(data['PROBE_SUB_VERDICTS'].map(v => [v.position, v.action, v.status]),
                [[0, 'SEND', 'valid:SEND'], [1, 'DEPLOY', null], [2, 'SEND', 'valid:SEND']]);
            assert.ok(data['PROBE_SUB_VERDICTS'][1].refused, 'the DEPLOY row must say why it has no verdict');
            assert.strictEqual(data['PROBE_SUB_VERDICTS'][0].refused, null);
        });

        it('answers for the BATCH, not for whichever sub-command ran last', async function () {
            const data = createBaseData({
                ACTION: 'BATCH', FORMAT: 0, SOURCE, FEE_PROBE: true,
                TX_DATA: 'BATCH|0|SEND|0|TEST|10|mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM'
            });
            await handler.parse(['0'], data, null);
            assert.strictEqual(data['STATUS'], 'valid',
                'the top-level status must be the BATCH verdict, not the last handler\'s');
        });

        it('reports null for a sub-command whose handler recorded no verdict', async function () {
            // A settlement leg that early-exits (coinpay.js on an unmatched payee) writes no
            // STATUS. Without the per-command reset it would inherit its predecessor's.
            actionsCtx.processAction = sinon.stub().callsFake(async (action, params, data) => {
                if(action !== 'COINPAY') data['STATUS'] = 'valid:' + action;
            });
            handler = new Batch(actionsCtx);
            const data = createBaseData({
                ACTION: 'BATCH', FORMAT: 0, SOURCE, FEE_PROBE: true,
                TX_DATA: 'BATCH|0|SEND|0|TEST|10|mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM;COINPAY|0|42'
            });
            await handler.parse(['0'], data, null);
            assert.deepStrictEqual(data['PROBE_SUB_VERDICTS'].map(v => v.status), ['valid:SEND', null]);
        });

        it('BELOW-PROBE CONTROL: the identical batch off the probe path is untouched', async function () {
            // The guard is inert on every decoded transaction, because actions.js sources
            // FEE_PROBE from the synthetic tx only. Same wire, no probe flag.
            const data = createBaseData({ ACTION: 'BATCH', FORMAT: 0, SOURCE, TX_DATA: WIRE });
            await handler.parse(['0'], data, null);

            const dispatched = actionsCtx.processAction.getCalls().map(c => c.args[0]);
            assert.deepStrictEqual(dispatched, ['SEND', 'DEPLOY', 'SEND'],
                'consensus dispatch must be unchanged');
            assert.strictEqual(data['PROBE_SUB_VERDICTS'], undefined, 'no probe collector off the probe path');
            assert.strictEqual(data['PROBE_ORACLE_FEES'], undefined);
            assert.strictEqual(data['STATUS'], 'valid:SEND',
                'off the probe path STATUS keeps the last handler\'s value, exactly as before');
        });

        it('BELOW-PROBE CONTROL: the consensus value ledger is still seeded and never replaced', async function () {
            const data = createBaseData({ ACTION: 'BATCH', FORMAT: 0, SOURCE, TX_DATA: WIRE, FEE_PROBE: true });
            await handler.parse(['0'], data, null);
            // Row 30's seam: a probe IS inside a flagged batch, so the key is present for the
            // READ, and the probe collectors are separate objects that never write to it.
            assert.deepStrictEqual(data['BATCH_VALUE_LEDGER'],
                { nativeFeeConsumed: '0', coinAmountConsumed: '0', oracleFeeConsumed: {} });
        });
    });

    describe('probe-local oracle fee disclosure', function () {
        let indexer, actionsCtx, dispenser;
        const OWNER_ADDR  = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
        const ORACLE_ADDR = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';
        const BLOCK_TIME  = 1700000000;
        const EXPIRATION  = BLOCK_TIME + 86400 * 30;

        beforeEach(function () {
            indexer    = createMockIndexer();
            actionsCtx = {
                config:          indexer.config,
                util:            indexer.util,
                mapper:          indexer.mapper,
                decoderDb:       indexer.decoderDb,
                indexerDb:       indexer.indexerDb,
                protocolChanges: { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) },
                processAction:   sinon.stub().resolves()
            };
            dispenser = new Dispenser(actionsCtx);

            indexer.indexerDb.getTokenInfo.withArgs('JDOG', sinon.match.any, sinon.match.any)
                .resolves(createTokenInfo({ TICK: 'JDOG', TICK_ID: 10, DECIMALS: 0, ALLOW_LIST: null, BLOCK_LIST: null }));
            for(const empty of ['', null, undefined])
                indexer.indexerDb.getTokenInfo.withArgs(empty, sinon.match.any, sinon.match.any).resolves(null);
            indexer.indexerDb.getAddressBalances.resolves({ 10: '1000' });
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getTickerId.resolves(99);
            indexer.indexerDb.getOraclePrice = sinon.stub().resolves({ value: '0.05', fee: '0.01' });
            indexer.indexerDb.getPricesInTimeRange = sinon.stub().resolves([{ price: '50000' }]);
        });

        afterEach(function () { sinon.restore(); });

        const modeBParams = () => String(
            `0|BTC|JDOG|1||1000|BTC||0|${OWNER_ADDR}|USD||${ORACLE_ADDR}|${EXPIRATION}|||Mode B`).split('|');

        function probeData(shared){
            let d = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });
            d['FEE_PROBE'] = true;
            if(shared) d['PROBE_ORACLE_FEES'] = shared;
            return d;
        }

        it('a probe records the fee owed even with no oracle output to read', async function () {
            const data = probeData();          // no TX_OUTPUTS: a probe has no transaction
            await dispenser.parse(modeBParams(), data, false);

            assert.strictEqual(data['STATUS'], 'valid', 'the probe answers optimistically, as designed');
            const owed = data['PROBE_ORACLE_FEES'];
            assert.ok(owed && owed[ORACLE_ADDR], 'the fee owed must be disclosed');
            assert.ok(Number(owed[ORACLE_ADDR]) > 0);
        });

        it('SUMS across sibling sub-commands paying the same oracle', async function () {
            // This is the gap being disclosed: quoteOracleFee reads no output, so each
            // sub-command alone quotes the same single fee as covered. Only the running total
            // tells a composer the batch owes N times that.
            const shared = {};
            await dispenser.parse(modeBParams(), probeData(shared), false);
            const one = shared[ORACLE_ADDR];
            await dispenser.parse(modeBParams(), probeData(shared), false);
            const two = shared[ORACLE_ADDR];

            assert.ok(Number(one) > 0, 'first sub-command recorded nothing');
            assert.strictEqual(two, indexer.util.bcformat(indexer.util.bcmul(one, '2', 8), 8),
                'two DISPENSERs on one oracle must owe twice one fee');
        });

        it('records nothing when no fee is owed (belowDust / zero fee)', async function () {
            indexer.indexerDb.getOraclePrice = sinon.stub().resolves({ value: '0.05', fee: '0' });
            const data = probeData();
            await dispenser.parse(modeBParams(), data, false);
            assert.strictEqual(data['PROBE_ORACLE_FEES'], undefined,
                'a zero-fee oracle must tally nothing, matching validateOracleFee');
        });

        it('BELOW-PROBE CONTROL: a real transaction still needs the output and records nothing', async function () {
            const data = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });
            await dispenser.parse(modeBParams(), data, false);
            assert.strictEqual(data['STATUS'], 'invalid: ORACLE_ADDRESS (missing oracle fee output)');
            assert.strictEqual(data['PROBE_ORACLE_FEES'], undefined);
        });

        it('BELOW-PROBE CONTROL: a real transaction that PASSES the oracle check records nothing', async function () {
            // The control above is not enough on its own and was measured to be vacuous: with
            // no output the check fails, so the accumulate is skipped for a reason that has
            // nothing to do with FEE_PROBE. This one pays the oracle so validateOracleFee
            // genuinely returns valid, which is the only state in which the FEE_PROBE
            // condition is what stops a consensus path from writing a probe-only field.
            const data = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });
            data['TX_OUTPUTS'] = [{ address: ORACLE_ADDR, value: '0.00001' }];
            await dispenser.parse(modeBParams(), data, false);
            assert.strictEqual(data['STATUS'], 'valid', 'the oracle check must PASS for this control to bind');
            assert.strictEqual(data['PROBE_ORACLE_FEES'], undefined,
                'a decoded transaction must never carry the probe-only disclosure');
        });
    });
});
