// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');

// Utility loads coin config in its constructor from these env vars.
process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const Utility = require('../../src/utility.js');
const Actions = require('../../src/actions.js');

const FEE_DEST = 'feeDestinationAddr111111111111111';

// Build a minimal Actions-like context exposing the real _dryRunAction /
// computeFeeQuoteDryRun prototype methods plus stubbed dependencies. processTransaction is
// stubbed so the test never touches a real DB or handler chain; the transaction-mutex calls
// (beginTransaction / rollbackTransaction) and the fee-row read are recorded IN ORDER so we
// can assert the dry-run opens exactly one transaction, reads the staged fee inside it, and
// always rolls back.
function makeCtx({ status = 'valid', actionIndex = 55, feeAmount = '1.00000000',
                   processThrows = false, processHangs = false, prices = {},
                   addressId = 7, tickId = 3, addressBalances = { 3: '19898' },
                   balanceThrows = false } = {}){
    let calls = { order: [], begin: 0, rollback: 0, processed: null, createdAddresses: 0 };
    let util  = new Utility();
    util.config['COIN']                         = 'BTC';
    util.config['ADDRESS']                      = Object.assign({}, util.config['ADDRESS'] || {}, { FEE_DESTINATION: FEE_DEST });
    util.config['FEE_TOLERANCE_MIN']            = '0.95';
    util.config['FEE_TOLERANCE_MAX']            = '1.10';
    util.config['ORACLE_MAX_PRICE_AGE_SECONDS'] = 1800;
    let ctx = {
        util,
        config: util.config,
        _calls: calls,
        indexerDb: {
            getLatestBlockIndex: async () => 100,
            getBlockTime:        async () => 1000,
            beginTransaction:    async () => { calls.begin++; calls.order.push('begin'); },
            rollbackTransaction: async () => { calls.rollback++; calls.order.push('rollback'); },
            // Watchdog-fence surface (M-16): the dry-run reads the epoch after
            // beginTransaction and runs processTransaction under it. The stub
            // mirrors the real Database contract (fixed epoch, pass-through run).
            // BOTH fence entry points are stubbed. _dryRunAction runs under
            // runInDryRunEpoch (the no-consensus-authority variant),
            // never runInTxEpoch; stubbing only the latter made every call here throw
            // `runInDryRunEpoch is not a function` inside the try, which the handler
            // reports as a dry-run error, so the whole file went red without naming the
            // missing surface. Keep runInTxEpoch too: it is the real Database's default
            // and a future caller that takes it must not silently lose its stub.
            currentTxEpoch:      () => 0,
            runInTxEpoch:        (epoch, fn) => fn(),
            runInDryRunEpoch:    (epoch, fn) => fn(),
            // Fee-balance surface. getAddressId is the READ-ONLY id lookup (null for
            // an address the ledger has never seen); createAddress is stubbed only so the test
            // can prove the balance read never reaches it.
            getAddressId:        async (addr) => { calls.order.push('getAddressId:' + addr); return addressId; },
            createAddress:       async () => { calls.createdAddresses++; return 999; },
            getTickerId:         async (tick) => { calls.order.push('getTickerId:' + tick); return tickId; },
            getAddressBalances:  async (id) => {
                calls.order.push('getAddressBalances:' + id);
                if(balanceThrows) throw new Error('balance read exploded');
                return addressBalances;
            },
            // The handler-staged fee row, readable only between begin and rollback.
            getFeeRecord:        async (ai) => {
                calls.order.push('getFeeRecord:' + ai);
                return (feeAmount == null) ? null : { amount: feeAmount, gas_cost: 0, gas_price: '0', xchain_amount: feeAmount, payment_mode: 1 };
            },
            getLatestPrice:      async (pair) => {
                if(prices[pair] == null) return null;
                return { price: prices[pair], roundNumber: 7, block_timestamp: 1000 };
            }
        },
        // Stubbed handler run: records the synthetic tx and stamps STATUS like a real handler.
        processTransaction: async (tx) => {
            calls.processed = tx;
            calls.order.push('process');
            if(processThrows) throw new Error('boom');
            if(processHangs) return new Promise(() => {});   // never resolves: the watchdog must fire
            return { STATUS: status, ACTION_INDEX: actionIndex };
        },
        _dryRunAction:         Actions.prototype._dryRunAction,
        _priceFeeQuote:        Actions.prototype._priceFeeQuote,
        computeFeeQuoteDryRun: Actions.prototype.computeFeeQuoteDryRun
    };
    ctx.config['BLOCK_PROCESS_TIMEOUT'] = 300000;
    return { ctx, calls };
}

const BTC_PRICES = { 'XCHAIN/USD': '1.00000000', 'BTC/USD': '50000.00000000' };

describe('_dryRunAction (shared dry-run engine)', () => {

    it('valid action: one balanced transaction, fee row read INSIDE it, handler fee extracted', async () => {
        let { ctx, calls } = makeCtx({ status: 'valid' });
        let r = await ctx._dryRunAction.call(ctx, { action: 'ISSUE', params: ['0', 'NEWTOK', '1000'], source: 'src1', timeoutMs: 300000 });
        assert.strictEqual(r.status, 'valid');
        assert.strictEqual(r.error, null);
        assert.strictEqual(r.xchainFee, '1.00000000', 'handler-staged fee extracted');
        assert.strictEqual(calls.begin, 1, 'one transaction opened');
        assert.strictEqual(calls.rollback, 1, 'one rollback (never persists)');
        assert.deepStrictEqual(calls.order, ['begin', 'process', 'getFeeRecord:55', 'rollback'],
            'fee row read after the handler, before rollback');
        assert.strictEqual(calls.processed.data, 'ISSUE|0|NEWTOK|1000', 'action string reassembled');
        assert.ok(String(calls.processed.tx_hash).startsWith('DRYRUN-'), 'tx_hash marked DRYRUN');
        assert.strictEqual(calls.processed.block_index, 100, 'synthetic tx anchored at tip');
    });

    it('injects an oversized probe fee output when none supplied and a destination is given', async () => {
        let { ctx, calls } = makeCtx({});
        await ctx._dryRunAction.call(ctx, { action: 'SEND', params: ['0', 'T', '1', 'd'], source: 's', probeFeeDestination: FEE_DEST, timeoutMs: 300000 });
        assert.strictEqual(calls.processed.tx_outputs.length, 1);
        assert.strictEqual(calls.processed.tx_outputs[0].address, FEE_DEST);
        assert.ok(Number(calls.processed.tx_outputs[0].value) >= 21000000, 'probe exceeds any band');
    });

    it('caller-supplied feeOutputs pass through untouched (no probe injection)', async () => {
        let { ctx, calls } = makeCtx({});
        let outs = [{ address: 'someAddr', value: '0.00001900' }];
        await ctx._dryRunAction.call(ctx, { action: 'SEND', params: ['0', 'T', '1', 'd'], source: 's', feeOutputs: outs, probeFeeDestination: FEE_DEST, timeoutMs: 300000 });
        assert.deepStrictEqual(calls.processed.tx_outputs, outs);
    });

    it('marks a probe run so output-matching fee checks know there is no transaction', async () => {
        // The oracle usage fee is checked by matching an OUTPUT, exactly like the
        // native fee - but it cannot be served by the probe output above, because
        // ORACLE_ADDRESS may be a ^id the handler only resolves later. So the run is
        // MARKED instead, and dispenser.js checks the knowable half only. Without this,
        // every Mode B dispenser quotes `invalid: ORACLE_ADDRESS (missing oracle fee
        // output)` - a refusal whose remedy is the amount the refused quote computes.
        let { ctx, calls } = makeCtx({});
        await ctx._dryRunAction.call(ctx, { action: 'DISPENSER', params: ['0'], source: 's',
            probeFeeDestination: FEE_DEST, feeProbe: true, timeoutMs: 300000 });
        assert.strictEqual(calls.processed.fee_probe, true);
    });

    it('a run that was NOT asked to probe is not marked (feequotedryrun keeps real behaviour)', async () => {
        // The raw regtest RPC exists to reproduce what a real broadcast would do with the
        // outputs it was handed, so it must keep failing on a missing oracle fee output.
        let { ctx, calls } = makeCtx({});
        await ctx._dryRunAction.call(ctx, { action: 'DISPENSER', params: ['0'], source: 's',
            feeOutputs: [], timeoutMs: 300000 });
        assert.strictEqual(calls.processed.fee_probe, false);
    });

    it('both public read-only surfaces ask for the probe marker', () => {
        // In xchain fee mode computePreflight passes NO probe output at all, so the marker
        // is the only thing standing between a Mode B dispenser and a false refusal there.
        // Source-shape pin: these two call sites are the whole wiring.
        const fs   = require('fs');
        const path = require('path');
        const src  = fs.readFileSync(path.resolve(__dirname, '../../src/actions.js'), 'utf8');
        for (const label of ['feequote', 'preflight']) {
            const at = src.indexOf(`label: '${label} ' + action`);
            assert.ok(at > 0, `the ${label} dry-run call site must exist`);
            assert.ok(/feeProbe:\s*true/.test(src.slice(at - 400, at + 400)),
                `the ${label} dry-run must set feeProbe`);
        }
    });

    it('no probe destination and no outputs: synthetic tx carries an empty output set', async () => {
        let { ctx, calls } = makeCtx({});
        await ctx._dryRunAction.call(ctx, { action: 'SEND', params: ['0', 'T', '1', 'd'], source: 's', timeoutMs: 300000 });
        assert.deepStrictEqual(calls.processed.tx_outputs, []);
    });

    it('class-B invalid: handler reason in status, fee null when no row was staged', async () => {
        let { ctx, calls } = makeCtx({ status: 'invalid: insufficient funds', feeAmount: null });
        let r = await ctx._dryRunAction.call(ctx, { action: 'SEND', params: ['0', 'TOK', '999', 'dest'], source: 'src1', timeoutMs: 300000 });
        assert.strictEqual(r.status, 'invalid: insufficient funds');
        assert.strictEqual(r.xchainFee, null, 'fee unknowable for a rejected action');
        assert.strictEqual(calls.rollback, 1, 'invalid action still rolls back');
    });

    it('valid zero-fee action (no fee row): xchainFee is "0"', async () => {
        let { ctx } = makeCtx({ status: 'valid', feeAmount: null });
        let r = await ctx._dryRunAction.call(ctx, { action: 'MINT', params: ['0', 'TOK'], source: 'src1', timeoutMs: 300000 });
        assert.strictEqual(r.xchainFee, '0');
    });

    it('fresh (never-indexed) source is dry-run normally: dense in-txn ids roll back cleanly', async () => {
        // No getAddressId gate exists any more; the engine must not require one.
        let { ctx, calls } = makeCtx({ status: 'invalid: insufficient funds', feeAmount: null });
        let r = await ctx._dryRunAction.call(ctx, { action: 'SEND', params: ['0', 'T', '1', 'd'], source: 'neverSeenAddr', timeoutMs: 300000 });
        assert.strictEqual(calls.begin, 1, 'transaction opened for a fresh source');
        assert.strictEqual(r.status, 'invalid: insufficient funds', 'handler judged it');
    });

    // The fee-token balance the pre-flight needs to tell a payer WHY an XCHAIN-settled
    // fee would fail. Read inside the same transaction as the handler, and read-only.
    describe('payer fee-token balance (feeBalanceTick)', () => {

        it('reads the balance inside the transaction, BEFORE the handler runs', async () => {
            let { ctx, calls } = makeCtx({ status: 'valid' });
            let r = await ctx._dryRunAction.call(ctx, { action: 'ISSUE', params: ['0', 'NEWTOK'], source: 'payer',
                                                        feeBalanceTick: 'XCHAIN', timeoutMs: 300000 });
            assert.strictEqual(r.sourceFeeBalance, '19898');
            assert.deepStrictEqual(calls.order,
                ['begin', 'getAddressId:payer', 'getTickerId:XCHAIN', 'getAddressBalances:7',
                 'process', 'getFeeRecord:55', 'rollback'],
                'pre-action snapshot, inside the one transaction, rolled back with it');
            assert.strictEqual(calls.createdAddresses, 0, 'the balance read must never WRITE an address row');
        });

        it('an address the ledger has never seen holds zero (no id, no balance query)', async () => {
            let { ctx, calls } = makeCtx({ status: 'valid', addressId: null });
            let r = await ctx._dryRunAction.call(ctx, { action: 'ISSUE', params: ['0', 'NEWTOK'], source: 'freshAddr',
                                                        feeBalanceTick: 'XCHAIN', timeoutMs: 300000 });
            assert.strictEqual(r.sourceFeeBalance, '0');
            assert.ok(calls.order.indexOf('getAddressBalances:7') === -1, 'nothing to look up');
            assert.strictEqual(calls.createdAddresses, 0);
        });

        it('an indexed address with no XCHAIN row reports 0, not null', async () => {
            let { ctx } = makeCtx({ status: 'valid', addressBalances: { 9: '5' } });
            let r = await ctx._dryRunAction.call(ctx, { action: 'ISSUE', params: ['0', 'NEWTOK'], source: 'payer',
                                                        feeBalanceTick: 'XCHAIN', timeoutMs: 300000 });
            assert.strictEqual(r.sourceFeeBalance, '0');
        });

        it('an unknown fee tick is null (unknown), never a fabricated zero', async () => {
            let { ctx } = makeCtx({ status: 'valid', tickId: null });
            let r = await ctx._dryRunAction.call(ctx, { action: 'ISSUE', params: ['0', 'NEWTOK'], source: 'payer',
                                                        feeBalanceTick: 'NOSUCH', timeoutMs: 300000 });
            assert.strictEqual(r.sourceFeeBalance, null);
        });

        it('is skipped entirely when the caller does not ask for it', async () => {
            let { ctx, calls } = makeCtx({ status: 'valid' });
            let r = await ctx._dryRunAction.call(ctx, { action: 'ISSUE', params: ['0', 'NEWTOK'], source: 'payer', timeoutMs: 300000 });
            assert.strictEqual(r.sourceFeeBalance, null);
            assert.deepStrictEqual(calls.order, ['begin', 'process', 'getFeeRecord:55', 'rollback'],
                'no extra reads on the fee-quote path');
        });

        it('a failing balance read degrades to null and leaves the verdict untouched', async () => {
            let { ctx, calls } = makeCtx({ status: 'valid', balanceThrows: true });
            let r = await ctx._dryRunAction.call(ctx, { action: 'ISSUE', params: ['0', 'NEWTOK'], source: 'payer',
                                                        feeBalanceTick: 'XCHAIN', timeoutMs: 300000 });
            assert.strictEqual(r.sourceFeeBalance, null, 'advisory field degrades');
            assert.strictEqual(r.status, 'valid', 'the handler verdict still stands');
            assert.strictEqual(r.xchainFee, '1.00000000');
            assert.strictEqual(calls.rollback, 1);
        });
    });

    it('bounds a hung handler with the caller timeout and releases the lock', async () => {
        let { ctx, calls } = makeCtx({ processHangs: true });
        let r = await ctx._dryRunAction.call(ctx, { action: 'ISSUE', params: ['0', 'NEWTOK'], source: 'src1', timeoutMs: 50, label: 'feequote ISSUE' });
        assert.ok(/timeout|exceeded/i.test(r.error), 'error reports the watchdog timeout: ' + r.error);
        assert.strictEqual(r.status, null);
        assert.strictEqual(calls.begin, 1);
        assert.strictEqual(calls.rollback, 1, 'lock released via rollback once the watchdog fires (no indefinite wedge)');
    });

    it('handler throws: rollback still runs in finally (no lock leak)', async () => {
        let { ctx, calls } = makeCtx({ processThrows: true });
        let r = await ctx._dryRunAction.call(ctx, { action: 'EXECUTE', params: ['0', 'c'], source: 'src1', timeoutMs: 300000 });
        assert.ok(/handler threw/.test(r.error), 'error reports the throw');
        assert.strictEqual(calls.begin, 1, 'transaction was opened');
        assert.strictEqual(calls.rollback, 1, 'rollback runs in finally even on throw');
    });
});

describe('computeFeeQuoteDryRun (raw regtest surface)', () => {

    it('valid run with prices: handler verdict + best-effort native sizing merged', async () => {
        let { ctx, calls } = makeCtx({ status: 'valid', prices: BTC_PRICES });
        let r = await ctx.computeFeeQuoteDryRun.call(ctx, { action: 'ISSUE', params: ['0', 'NEWTOK', '1000'], source: 'src1' });
        assert.strictEqual(r.dryRun, true);
        assert.strictEqual(r.valid, true);
        assert.strictEqual(r.status, 'valid');
        assert.strictEqual(r.error, null);
        assert.strictEqual(r.xchainFee, '1.00000000');
        assert.strictEqual(r.feeSupported, true);
        assert.strictEqual(r.requiredFeeNative, '0.00002000');
        assert.strictEqual(r.requiredFeeSats, 2000);
        assert.deepStrictEqual(calls.processed.tx_outputs, [], 'raw surface never injects a probe output');
    });

    it('valid run without prices: verdict stands, sizing degrades to feeSupported:false + feeError', async () => {
        let { ctx } = makeCtx({ status: 'valid', prices: {} });
        let r = await ctx.computeFeeQuoteDryRun.call(ctx, { action: 'ISSUE', params: ['0', 'NEWTOK'], source: 'src1' });
        assert.strictEqual(r.valid, true, 'pricing failure must not overwrite the handler verdict');
        assert.strictEqual(r.feeSupported, false);
        assert.ok(/missing or stale/.test(r.feeError), r.feeError);
        assert.strictEqual(r.requiredFeeNative, null);
    });

    it('class-B invalid: verdict + verbatim reason', async () => {
        let { ctx } = makeCtx({ status: 'invalid: TICK (unknown)', feeAmount: null, prices: BTC_PRICES });
        let r = await ctx.computeFeeQuoteDryRun.call(ctx, { action: 'SEND', params: ['0', 'NOPE', '1', 'd'], source: 'src1' });
        assert.strictEqual(r.valid, false);
        assert.strictEqual(r.error, 'invalid: TICK (unknown)');
        assert.strictEqual(r.feeSupported, false);
    });

    it('uses the full block watchdog as its timeout bound', async () => {
        let { ctx, calls } = makeCtx({ processHangs: true, prices: BTC_PRICES });
        ctx.config['BLOCK_PROCESS_TIMEOUT'] = 50;   // tiny so the watchdog fires fast
        let r = await ctx.computeFeeQuoteDryRun.call(ctx, { action: 'ISSUE', params: ['0', 'X'], source: 'src1' });
        assert.strictEqual(r.valid, false);
        assert.ok(/timeout|exceeded/i.test(r.error), r.error);
        assert.strictEqual(calls.rollback, 1);
    });
});
