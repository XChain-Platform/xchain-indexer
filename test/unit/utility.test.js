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
const sinon = require('sinon');

// Set env before requiring Utility (it loads config in constructor)
process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const Utility = require('../../src/utility.js');

describe('Utility @regression @tier1', function () {
    let util;

    beforeEach(function () {
        util = new Utility();
    });

    // ─── DEX market refresh: touched-this-block + throttled 24h ageing sweep ──
    describe('processMarketUpdates()', function () {
        function fakeDb(touched, stale) {
            return {
                getMarkets: sinon.stub().resolves(touched),
                getStaleMarkets: sinon.stub().resolves(stale),
                createMarket: sinon.stub().callsFake(async (t1, t2) => Number(String(t1) + String(t2))),
                getMarketInfo: sinon.stub().callsFake(async (market_id) => ({ market_id })),
                updateMarketInfo: sinon.stub().resolves(),
            };
        }

        it('refreshes only the pairs touched this block (getMarkets called with update=false)', async function () {
            const db = fakeDb([{ tick1_id: 1, tick2_id: 2 }], []);
            await util.processMarketUpdates(db, 100, 1700000000);
            assert.ok(db.getMarkets.calledOnceWithExactly(100, false));
            assert.strictEqual(db.createMarket.callCount, 1);
            assert.ok(db.createMarket.calledWithExactly(1, 2));
            assert.strictEqual(db.updateMarketInfo.callCount, 1);
        });

        it('runs a bounded throttled ageing sweep over stale markets, using 24h-behind floor', async function () {
            const db = fakeDb([], [{ id: 11 }, { id: 12 }]);
            await util.processMarketUpdates(db, 100, 1700000000);
            // 24h floor passed to getStaleMarkets, bounded by MARKET_STALE_SWEEP_BATCH.
            assert.ok(db.getStaleMarkets.calledOnce);
            assert.strictEqual(String(db.getStaleMarkets.firstCall.args[0]), String(1700000000 - 86400));
            assert.strictEqual(db.getStaleMarkets.firstCall.args[1], Utility.MARKET_STALE_SWEEP_BATCH);
            // Each stale market is refreshed by market id (not re-created).
            assert.ok(db.getMarketInfo.calledWith(11));
            assert.ok(db.getMarketInfo.calledWith(12));
            assert.strictEqual(db.updateMarketInfo.callCount, 2);
            assert.ok(db.createMarket.notCalled);
        });

        it('skips the ageing sweep (without throwing) when block_time is the false sentinel', async function () {
            // getBlockTime returns false when the block row is unresolvable (older-schema
            // decoder DB); bcsub("false") used to throw and wedge block processing.
            const db = fakeDb([{ tick1_id: 1, tick2_id: 2 }], [{ id: 11 }]);
            await util.processMarketUpdates(db, 100, false);
            assert.ok(db.getStaleMarkets.notCalled);
        });

        it('sets last_updated to the current block_time on every refreshed row', async function () {
            const db = fakeDb([{ tick1_id: 1, tick2_id: 2 }], [{ id: 99 }]);
            await util.processMarketUpdates(db, 100, 1700000000);
            for (const call of db.updateMarketInfo.getCalls())
                assert.strictEqual(call.args[0].last_updated, 1700000000);
        });
    });

    // ─── Canonical consensus gas-key resolution (no silent magic-literal fallback) ──
    describe('resolveGuardGasCeiling()', function () {
        it('returns the validated positive integer from GAS_SCHEDULE', function () {
            assert.strictEqual(util.resolveGuardGasCeiling({ GAS_SCHEDULE: { VM_GUARD_GAS_CEILING: 200000 } }), 200000);
        });
        it('accepts a clean numeric string', function () {
            assert.strictEqual(util.resolveGuardGasCeiling({ GAS_SCHEDULE: { VM_GUARD_GAS_CEILING: '12345' } }), 12345);
        });
        it('throws (no silent default) when the key is missing: would otherwise fork a misconfigured node', function () {
            assert.throws(() => util.resolveGuardGasCeiling({ GAS_SCHEDULE: {} }), /VM_GUARD_GAS_CEILING/);
            assert.throws(() => util.resolveGuardGasCeiling({}), /VM_GUARD_GAS_CEILING/);
        });
        it('throws on mistyped / non-positive / non-integer values', function () {
            for (const v of ['200000abc', 0, -5, 200000.5, null]) {
                assert.throws(() => util.resolveGuardGasCeiling({ GAS_SCHEDULE: { VM_GUARD_GAS_CEILING: v } }),
                    /VM_GUARD_GAS_CEILING/, 'expected throw for ' + JSON.stringify(v));
            }
        });
    });

    // ─── Cross-chain call orchestration (the block loop's three deterministic passes) ──
    describe('processCrossChainCalls()', function () {
        const COIN = 'BTC', NETWORK = 'regtest';
        const CAP = require('../../src/actions/xcall.js').XCALL_MAX_CALLS_PER_BLOCK;
        let actions, db, processAction, processResult;

        let resultSuppressesExpiry;
        beforeEach(function () {
            processAction = sinon.stub().resolves();
            processResult = sinon.stub().resolves();
            // Default: a present result row is verified-deliverable (honest-majority path).
            resultSuppressesExpiry = sinon.stub().resolves(true);
            actions = { processAction, actionXcall: { processResult, resultSuppressesExpiry } };
            db = {
                config: { COIN, NETWORK },
                getEffectiveUndispatchedCalls:      sinon.stub().resolves([]),
                getEffectiveUnprocessedCallResults: sinon.stub().resolves([]),
                getExpiredCrossChainCallRequests:   sinon.stub().resolves([]),
            };
        });

        it('pass 1: injects an XEXEC for each dispatch targeting this chain', async function () {
            const call = { call_id: 'a'.repeat(64), target_chain: 'BTC' };
            db.getEffectiveUndispatchedCalls.resolves([call]);
            await util.processCrossChainCalls(actions, db, 100, 1700000000);
            assert.ok(processAction.calledOnceWith('XEXEC'));
            const data = processAction.firstCall.args[2];
            assert.strictEqual(data['ACTION'], 'XEXEC');
            assert.strictEqual(data['CALL'], call);
            assert.strictEqual(data['BLOCK_INDEX'], 100);
        });

        it('pass 2: delivers each result via actionXcall.processResult', async function () {
            const result = { call_id: 'b'.repeat(64) };
            db.getEffectiveUnprocessedCallResults.resolves([result]);
            await util.processCrossChainCalls(actions, db, 200, 1700000100);
            assert.ok(processResult.calledOnceWith(result));
            assert.strictEqual(processResult.firstCall.args[1]['BLOCK_INDEX'], 200);
        });

        it('pass 3: synthesizes an XCALL v2 expiry for each past-deadline request', async function () {
            db.getExpiredCrossChainCallRequests.resolves([{ call_id: 'c'.repeat(64) }]);
            await util.processCrossChainCalls(actions, db, 300, 1700000200);
            assert.ok(processAction.calledOnceWith('XCALL', [2, 'c'.repeat(64)]));
            const data = processAction.firstCall.args[2];
            assert.strictEqual(data['FORMAT'], 2);
            assert.strictEqual(data['IS_SYNTHETIC'], true);
        });

        it('caps dispatch injection at XCALL_MAX_CALLS_PER_BLOCK (query-level)', async function () {
            await util.processCrossChainCalls(actions, db, 100, 1700000000);
            assert.ok(db.getEffectiveUndispatchedCalls.calledWith(COIN, NETWORK, 1700000000, CAP));
        });

        it('caps the expiry pass at XCALL_MAX_CALLS_PER_BLOCK (query-level) so a deadline-aligned burst cannot wedge the chain', async function () {
            // deadline_block is caller-chosen; without a bound, an aligned burst would synthesize an
            // XCALL v2 + VM callback isolate per request in one block transaction and blow the block
            // timeout deterministically on every indexer. The expiry query must receive the cap.
            await util.processCrossChainCalls(actions, db, 100, 1700000000);
            assert.ok(db.getExpiredCrossChainCallRequests.calledWith(100, CAP),
                'expiry pass must bind the per-block cap (block_index, cap)');
        });

        it('fetches the full effective result set and delivers at most the cap', async function () {
            // Results are fetched uncapped (so the expiry pass can see requests that are
            // deliverable this block but deferred past the cap) and the per-block cap is then
            // applied as a deterministic slice on delivery.
            const many = Array.from({ length: CAP + 5 }, (_, i) => ({ call_id: String(i).padStart(64, '0') }));
            db.getEffectiveUnprocessedCallResults.resolves(many);
            await util.processCrossChainCalls(actions, db, 100, 1700000000);
            assert.ok(db.getEffectiveUnprocessedCallResults.getCall(0).args[3] > CAP, 'results fetched uncapped');
            assert.strictEqual(processResult.callCount, CAP, 'delivers exactly the per-block cap');
        });

        it('does NOT expire a past-deadline request whose result is deliverable this block (cap-deferred)', async function () {
            // The overflow request has both a quorum-signed result (beyond the cap slice) and a
            // past deadline. The effective result must win over expiry so the contract receives
            // the real outcome instead of a skipped:expired on the carried-over result.
            const OVER = 'd'.repeat(64);
            const many = Array.from({ length: CAP }, (_, i) => ({ call_id: String(i).padStart(64, '0') }));
            many.push({ call_id: OVER });                       // CAP+1th: deliverable but past the delivery slice
            db.getEffectiveUnprocessedCallResults.resolves(many);
            db.getExpiredCrossChainCallRequests.resolves([{ call_id: OVER }]);
            resultSuppressesExpiry.resolves(true);              // the result verifies (quorum-signed)
            await util.processCrossChainCalls(actions, db, 100, 1700000000);
            const expiryCalls = processAction.getCalls().filter(c => c.args[0] === 'XCALL');
            assert.strictEqual(expiryCalls.length, 0, 'no expiry injected when a deliverable result exists');
            // The suppression decision is made against the actual result row, not mere presence.
            assert.ok(resultSuppressesExpiry.calledWithMatch({ call_id: OVER }));
        });

        it('DOES expire when the only result row is finalized-but-unverifiable (Byzantine mirror cannot deadlock the callback)', async function () {
            // XRES-1: a hub mirror can hold a phase=result/status=finalized row with invalid
            // signatures. processResult rejects it every block and never records a callback, so it
            // is never pruned from the effective set. If mere presence suppressed expiry the request
            // would deadlock forever (and nodes mirroring different hubs would diverge on the v2
            // action). Expiry MUST still fire: suppression keys on verified deliverability, not row
            // presence.
            const BAD = 'f'.repeat(64);
            db.getEffectiveUnprocessedCallResults.resolves([{ call_id: BAD }]);
            db.getExpiredCrossChainCallRequests.resolves([{ call_id: BAD }]);
            resultSuppressesExpiry.resolves(false);            // sigs do not verify against the snapshot
            await util.processCrossChainCalls(actions, db, 100, 1700000000);
            assert.ok(processAction.calledWith('XCALL', [2, BAD]),
                'expiry must fire when the present result row does not verify');
        });

        it('still expires a past-deadline request that has no effective result', async function () {
            db.getEffectiveUnprocessedCallResults.resolves([]);   // nothing deliverable
            db.getExpiredCrossChainCallRequests.resolves([{ call_id: 'e'.repeat(64) }]);
            await util.processCrossChainCalls(actions, db, 100, 1700000000);
            assert.ok(processAction.calledWith('XCALL', [2, 'e'.repeat(64)]));
        });

        it('runs the three passes in order: inject → deliver → expire', async function () {
            db.getEffectiveUndispatchedCalls.resolves([{ call_id: 'a'.repeat(64) }]);
            db.getEffectiveUnprocessedCallResults.resolves([{ call_id: 'b'.repeat(64) }]);
            db.getExpiredCrossChainCallRequests.resolves([{ call_id: 'c'.repeat(64) }]);
            await util.processCrossChainCalls(actions, db, 100, 1700000000);
            assert.strictEqual(processAction.firstCall.args[0], 'XEXEC');   // pass 1
            assert.strictEqual(processAction.secondCall.args[0], 'XCALL');  // pass 3
            assert.ok(processResult.calledOnce);
            assert.ok(processResult.getCall(0).calledAfter(processAction.firstCall));   // pass 2 after pass 1
            assert.ok(processResult.getCall(0).calledBefore(processAction.secondCall)); // pass 2 before pass 3
        });
    });

    // ─── List Management ──────────────────────────────────────────

    describe('resetAddressesList()', function () {
        it('should clear the addresses object', function () {
            util.addresses = { addr1: ['TICK1'] };
            util.resetAddressesList();
            assert.deepStrictEqual(util.addresses, {});
        });
    });

    describe('resetTickersList()', function () {
        it('should clear the tickers array', function () {
            util.tickers = ['TICK1'];
            util.resetTickersList();
            assert.deepStrictEqual(util.tickers, []);
        });
    });

    describe('resetLists()', function () {
        it('should clear both addresses and tickers', function () {
            util.addresses = { addr1: ['TICK1'] };
            util.tickers = ['TICK1'];
            util.resetLists();
            assert.deepStrictEqual(util.addresses, {});
            assert.deepStrictEqual(util.tickers, []);
        });
    });

    describe('getAddressesList()', function () {
        it('should return current addresses object', function () {
            util.addresses = { a: ['T'] };
            assert.deepStrictEqual(util.getAddressesList(), { a: ['T'] });
        });
    });

    describe('getTickersList()', function () {
        it('should return current tickers array', function () {
            util.tickers = ['T'];
            assert.deepStrictEqual(util.getTickersList(), ['T']);
        });
    });

    // ─── isNumeric ────────────────────────────────────────────────

    describe('isNumeric()', function () {
        it('should return true for integers', function () {
            assert.strictEqual(util.isNumeric(42), true);
        });
        it('should return true for floats', function () {
            assert.strictEqual(util.isNumeric(3.14), true);
        });
        it('should return true for numeric strings', function () {
            assert.strictEqual(util.isNumeric('100'), true);
            assert.strictEqual(util.isNumeric('3.14'), true);
        });
        it('should return true for zero', function () {
            assert.strictEqual(util.isNumeric(0), true);
            assert.strictEqual(util.isNumeric('0'), true);
        });
        it('should return true for negative numbers', function () {
            assert.strictEqual(util.isNumeric(-5), true);
            assert.strictEqual(util.isNumeric('-5'), true);
        });
        it('should return true for BigInt', function () {
            assert.strictEqual(util.isNumeric(BigInt(100)), true);
        });
        it('should return false for non-numeric strings', function () {
            assert.strictEqual(util.isNumeric('abc'), false);
            assert.strictEqual(util.isNumeric('12abc'), false);
        });
        it('should return false for empty string', function () {
            assert.strictEqual(util.isNumeric(''), false);
        });
        it('should return false for null/undefined', function () {
            assert.strictEqual(util.isNumeric(null), false);
            assert.strictEqual(util.isNumeric(undefined), false);
        });
        it('should return false for Infinity', function () {
            assert.strictEqual(util.isNumeric(Infinity), false);
        });
        it('should return false for NaN', function () {
            assert.strictEqual(util.isNumeric(NaN), false);
        });
    });

    // ─── isFloat ──────────────────────────────────────────────────

    describe('isFloat()', function () {
        it('should return true for float values', function () {
            assert.strictEqual(util.isFloat(1.5), true);
        });
        it('should return false for integers', function () {
            assert.strictEqual(util.isFloat(1), false);
            assert.strictEqual(util.isFloat(0), false);
        });
        it('should return false for strings', function () {
            assert.strictEqual(util.isFloat('1.5'), false);
        });
    });

    // ─── isInteger ────────────────────────────────────────────────

    describe('isInteger()', function () {
        it('should return true for integers', function () {
            assert.strictEqual(util.isInteger(5), true);
            assert.strictEqual(util.isInteger(0), true);
        });
        it('should return true for integer strings', function () {
            assert.strictEqual(util.isInteger('5'), true);
        });
        it('should return false for floats', function () {
            assert.strictEqual(util.isInteger(1.5), false);
        });
        it('should return true for negative integers', function () {
            assert.strictEqual(util.isInteger(-3), true);
        });
    });

    // ─── isNull ───────────────────────────────────────────────────

    describe('isNull()', function () {
        it('should return true for null', function () {
            assert.strictEqual(util.isNull(null), true);
        });
        it('should return true for undefined', function () {
            assert.strictEqual(util.isNull(undefined), true);
        });
        it('should return true for empty string', function () {
            assert.strictEqual(util.isNull(''), true);
        });
        it('should return false for zero', function () {
            assert.strictEqual(util.isNull(0), false);
        });
        it('should return false for false', function () {
            assert.strictEqual(util.isNull(false), false);
        });
        it('should return false for non-empty string', function () {
            assert.strictEqual(util.isNull('hello'), false);
        });
    });

    // ─── BigNumber Arithmetic ─────────────────────────────────────

    describe('bcnum()', function () {
        it('should convert a string to bignumber', function () {
            const result = util.bcnum('123.456');
            assert.strictEqual(result.toString(), '123.456');
        });
        it('should convert an integer', function () {
            assert.strictEqual(util.bcnum(42).toString(), '42');
        });
        it('should handle zero', function () {
            assert.strictEqual(util.bcnum(0).toString(), '0');
        });
        it('should handle negative numbers', function () {
            assert.strictEqual(util.bcnum(-5).toString(), '-5');
        });
        it('should handle very large numbers', function () {
            const result = util.bcnum('1000000000000000000000');
            assert.strictEqual(util.bcformat(result, 0), '1000000000000000000000');
        });
        it('should handle very small numbers', function () {
            const result = util.bcnum('0.000000000000000001');
            assert.strictEqual(util.bcformat(result, 18), '0.000000000000000001');
        });
    });

    describe('bcformat()', function () {
        it('should format to 0 decimal places', function () {
            assert.strictEqual(util.bcformat('123.999', 0), '124');
        });
        it('should format to 8 decimal places', function () {
            assert.strictEqual(util.bcformat('1.5', 8), '1.50000000');
        });
        it('should format to 18 decimal places', function () {
            assert.strictEqual(util.bcformat('1', 18), '1.000000000000000000');
        });
        it('should default to 0 decimals when not specified', function () {
            assert.strictEqual(util.bcformat('5.9'), '6');
        });
        it('should handle null decimals', function () {
            assert.strictEqual(util.bcformat('5.9', null), '6');
        });
    });

    describe('bcadd()', function () {
        it('should add two numbers', function () {
            assert.strictEqual(util.bcadd(1, 2, 0).toString(), '3');
        });
        it('should add with decimal precision', function () {
            assert.strictEqual(util.bcformat(util.bcadd('0.1', '0.2', 8), 8), '0.30000000');
        });
        it('should handle null inputs as zero', function () {
            assert.strictEqual(util.bcadd(null, 5, 0).toString(), '5');
            assert.strictEqual(util.bcadd(5, null, 0).toString(), '5');
        });
        it('should add large numbers precisely', function () {
            const result = util.bcadd('999999999999999999999', '1', 0);
            assert.strictEqual(util.bcformat(result, 0), '1000000000000000000000');
        });
        it('should add very small numbers', function () {
            const result = util.bcadd('0.000000000000000001', '0.000000000000000001', 18);
            assert.strictEqual(util.bcformat(result, 18), '0.000000000000000002');
        });
    });

    describe('bcsub()', function () {
        it('should subtract two numbers', function () {
            assert.strictEqual(util.bcsub(5, 3, 0).toString(), '2');
        });
        it('should return negative results', function () {
            assert.strictEqual(util.bcsub(3, 5, 0).toString(), '-2');
        });
        it('should subtract with precision', function () {
            assert.strictEqual(util.bcformat(util.bcsub('1.00000000', '0.00000001', 8), 8), '0.99999999');
        });
        it('should handle null inputs as zero', function () {
            assert.strictEqual(util.bcsub(null, 5, 0).toString(), '-5');
            assert.strictEqual(util.bcsub(5, null, 0).toString(), '5');
        });
    });

    describe('bcmul()', function () {
        it('should multiply two numbers', function () {
            assert.strictEqual(util.bcmul(3, 4, 0).toString(), '12');
        });
        it('should multiply with precision', function () {
            assert.strictEqual(util.bcformat(util.bcmul('0.5', '0.5', 8), 8), '0.25000000');
        });
        it('should multiply by zero', function () {
            assert.strictEqual(util.bcmul(100, 0, 0).toString(), '0');
        });
        it('should handle null inputs as zero', function () {
            assert.strictEqual(util.bcmul(null, 5, 0).toString(), '0');
        });
        it('should handle large multiplications', function () {
            const result = util.bcmul('1000000000000', '1000000000000', 0);
            assert.strictEqual(util.bcformat(result, 0), '1000000000000000000000000');
        });
    });

    describe('bcmulfloor()', function () {
        it('should floor a midpoint fractional result rather than rounding up', function () {
            // holders balance = 3, dividend amount = 0.5, decimals = 0
            // full-precision product = 1.5: banker's rounding gives 2, floor gives 1
            assert.strictEqual(util.bcmulfloor('3', '0.5', 0).toString(), '1');
        });
        it('should floor a non-midpoint fractional result', function () {
            assert.strictEqual(util.bcmulfloor('2', '0.3', 0).toString(), '0');
        });
        it('should return exact integer results unchanged', function () {
            assert.strictEqual(util.bcmulfloor('3', '4', 0).toString(), '12');
        });
        it('should floor to the specified decimal places', function () {
            // 1.005 * 1 with 2 decimals: product = 1.005, floored to 2dp = 1.00
            assert.strictEqual(util.bcformat(util.bcmulfloor('1.005', '1', 2), 2), '1.00');
        });
        it('should handle null inputs as zero', function () {
            assert.strictEqual(util.bcmulfloor(null, 5, 0).toString(), '0');
        });
    });

    describe('bcround()', function () {
        it('recovers the true integer from a sub-ULP precision artifact (1 − 1e-18 → 1)', function () {
            // This is the NFT-indivisibility case: order_match derives 0.999999999999999999
            // for a 0-decimal tick; flooring would wrongly give 0, rounding gives 1.
            assert.strictEqual(util.bcround('0.999999999999999999', 0).toString(), '1');
        });
        it('rounds half-up at the tie', function () {
            assert.strictEqual(util.bcround('0.5', 0).toString(), '1');
            assert.strictEqual(util.bcround('2.5', 0).toString(), '3');
        });
        it('rounds down below the midpoint', function () {
            assert.strictEqual(util.bcround('0.4', 0).toString(), '0');
            assert.strictEqual(util.bcround('2.49', 0).toString(), '2');
        });
        it('snaps to the given decimal grid (8 dp)', function () {
            assert.strictEqual(util.bcformat(util.bcround('0.666666666666666667', 8), 8), '0.66666667');
        });
        it('leaves an on-grid value unchanged (numeric equality)', function () {
            assert.ok(!util.bcgt(util.bcround('1', 0), '1') && !util.bclt(util.bcround('1', 0), '1'));
            assert.ok(!util.bcgt(util.bcround('1', 8), '1') && !util.bclt(util.bcround('1', 8), '1'));
        });
        it('handles null input as zero', function () {
            assert.strictEqual(util.bcround(null, 0).toString(), '0');
        });
    });

    describe('bcdiv()', function () {
        it('should divide two numbers', function () {
            assert.strictEqual(util.bcdiv(10, 3, 8).toString(), '3.33333333');
        });
        it('should handle integer division', function () {
            assert.strictEqual(util.bcdiv(10, 2, 0).toString(), '5');
        });
        it('should handle null inputs as zero (numerator)', function () {
            assert.strictEqual(util.bcdiv(null, 5, 0).toString(), '0');
        });
    });

    describe('bcfloor()', function () {
        it('should floor a fractional bignumber', function () {
            assert.strictEqual(util.bcfloor(util.bcdiv('5.7', '1', 64)), 5);
        });
        it('should preserve exact integers', function () {
            assert.strictEqual(util.bcfloor(util.bcdiv('10', '1', 64)), 10);
        });
        it('should return 0 for sub-integer values', function () {
            assert.strictEqual(util.bcfloor(util.bcdiv('0.5', '1', 64)), 0);
        });
        it('should floor a value just below an integer (not round it up)', function () {
            // mathjs.floor() on this value returns 138 (rounds up due to internal
            // precision), but native bignumber.floor() correctly returns 137.
            assert.strictEqual(util.bcfloor(util.bcnum('137.99999999999')), 137);
        });
        it('should handle the sat-divisor case correctly', function () {
            assert.strictEqual(util.bcfloor(util.bcdiv('0.00000003', '0.00000001', 64)), 3);
        });
    });

    describe('bcgt()', function () {
        it('should return true when a > b', function () {
            assert.strictEqual(util.bcgt(5, 3), true);
        });
        it('should return false when a < b', function () {
            assert.strictEqual(util.bcgt(3, 5), false);
        });
        it('should return false when equal', function () {
            assert.strictEqual(util.bcgt(5, 5), false);
        });
        it('should compare large number strings', function () {
            assert.strictEqual(util.bcgt('100000000000', '99999999999'), true);
        });
    });

    describe('bclt()', function () {
        it('should return true when a < b', function () {
            assert.strictEqual(util.bclt(3, 5), true);
        });
        it('should return false when a > b', function () {
            assert.strictEqual(util.bclt(5, 3), false);
        });
        it('should return false when equal', function () {
            assert.strictEqual(util.bclt(5, 5), false);
        });
    });

    describe('bcgte()', function () {
        it('should return true when a > b', function () {
            assert.strictEqual(util.bcgte(5, 3), true);
        });
        it('should return true when equal', function () {
            assert.strictEqual(util.bcgte(5, 5), true);
        });
        it('should return false when a < b', function () {
            assert.strictEqual(util.bcgte(3, 5), false);
        });
    });

    describe('bclte()', function () {
        it('should return true when a < b', function () {
            assert.strictEqual(util.bclte(3, 5), true);
        });
        it('should return true when equal', function () {
            assert.strictEqual(util.bclte(5, 5), true);
        });
        it('should return false when a > b', function () {
            assert.strictEqual(util.bclte(5, 3), false);
        });
    });

    // ─── Validation Methods ───────────────────────────────────────

    describe('isValidValue()', function () {
        it('should match a string value in array', function () {
            assert.strictEqual(util.isValidValue('BTC', ['BTC', 'LTC', 'DOGE']), true);
        });
        it('should not match absent value', function () {
            assert.strictEqual(util.isValidValue('ETH', ['BTC', 'LTC', 'DOGE']), false);
        });
        it('should convert numeric string to integer for comparison', function () {
            assert.strictEqual(util.isValidValue('1', [1, 2, 3]), true);
        });
        it('should accept a single string as valid list', function () {
            assert.strictEqual(util.isValidValue('yes', 'yes'), true);
        });
    });

    describe('isValidAmountFormat()', function () {
        it('should accept integer for non-divisible (decimals=0)', function () {
            assert.strictEqual(util.isValidAmountFormat(0, '100'), true);
        });
        it('should reject decimal for non-divisible', function () {
            assert.strictEqual(util.isValidAmountFormat(0, '1.5'), false);
        });
        it('should accept decimal for divisible', function () {
            assert.strictEqual(util.isValidAmountFormat(8, '1.00000001'), true);
        });
        it('should accept integer for divisible', function () {
            assert.strictEqual(util.isValidAmountFormat(8, '100'), true);
        });
        it('should reject non-numeric', function () {
            assert.strictEqual(util.isValidAmountFormat(8, 'abc'), false);
        });
        // Fractional-precision cap (item 5346): an amount must not carry more decimal
        // places than the tick's decimals.
        it('should reject more fractional digits than decimals', function () {
            assert.strictEqual(util.isValidAmountFormat(8, '1.000000001'), false);
        });
        it('should accept exactly decimals fractional digits (boundary)', function () {
            assert.strictEqual(util.isValidAmountFormat(8, '1.00000001'), true);
        });
        it('should reject any fraction when decimals=0 via the cap path', function () {
            assert.strictEqual(util.isValidAmountFormat(2, '1.123'), false);
        });
        it('should accept fewer fractional digits than decimals', function () {
            assert.strictEqual(util.isValidAmountFormat(8, '1.5'), true);
        });
    });

    describe('isValidFiatFormat()', function () {
        it('should accept amount within decimal limit', function () {
            assert.strictEqual(util.isValidFiatFormat(2, '10.99'), true);
        });
        it('should reject amount exceeding decimal limit', function () {
            assert.strictEqual(util.isValidFiatFormat(2, '10.999'), false);
        });
        it('should accept integer amount', function () {
            assert.strictEqual(util.isValidFiatFormat(2, '10'), true);
        });
    });

    // The SDK<->indexer isValidAmountFormat fragment-parity drift guard (item
    // 5346) lives in test/integration/scenarios/15-sdk-parity.test.js: it needs
    // a real xchain-sdk checkout, which the unit tier's shared reusable CI
    // workflow does not have (the integration workflow checks the sdk out to
    // .xchain-sdk and sets XCHAIN_SDK_PATH).
    describe('isValidLockValue()', function () {
        it('should accept 0', function () {
            assert.strictEqual(util.isValidLockValue(0), true);
        });
        it('should accept 1', function () {
            assert.strictEqual(util.isValidLockValue(1), true);
        });
        it('should accept string "0"', function () {
            assert.strictEqual(util.isValidLockValue('0'), true);
        });
        it('should accept string "1"', function () {
            assert.strictEqual(util.isValidLockValue('1'), true);
        });
        it('should reject 2', function () {
            assert.strictEqual(util.isValidLockValue(2), false);
        });
        it('should reject null', function () {
            assert.strictEqual(util.isValidLockValue(null), false);
        });
        it('should reject non-numeric string', function () {
            assert.strictEqual(util.isValidLockValue('abc'), false);
        });
    });

    describe('isValidLock()', function () {
        it('should return true for new token (null tokenInfo)', function () {
            assert.strictEqual(util.isValidLock(null, { LOCK_SUPPLY: 1 }, 'LOCK_SUPPLY'), true);
        });
        it('should return true when lock value is empty string in tokenInfo', function () {
            const tokenInfo = { LOCK_SUPPLY: '' };
            assert.strictEqual(util.isValidLock(tokenInfo, { LOCK_SUPPLY: 1 }, 'LOCK_SUPPLY'), true);
        });
        it('should return true when lock value is not changing', function () {
            const tokenInfo = { LOCK_SUPPLY: 0 };
            assert.strictEqual(util.isValidLock(tokenInfo, { LOCK_SUPPLY: 0 }, 'LOCK_SUPPLY'), true);
        });
        it('should return true when locking (0 -> 1)', function () {
            const tokenInfo = { LOCK_SUPPLY: 0 };
            assert.strictEqual(util.isValidLock(tokenInfo, { LOCK_SUPPLY: 1 }, 'LOCK_SUPPLY'), true);
        });
        it('should return false when unlocking (1 -> 0)', function () {
            const tokenInfo = { LOCK_SUPPLY: 1 };
            assert.strictEqual(util.isValidLock(tokenInfo, { LOCK_SUPPLY: 0 }, 'LOCK_SUPPLY'), false);
        });
    });

    describe('isCryptoAddress()', function () {
        // Env at top of file is BTC/regtest: default validation context
        it('should accept a valid regtest P2PKH address', function () {
            assert.strictEqual(util.isCryptoAddress('mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH'), true);
        });
        it('should accept a valid regtest P2SH address', function () {
            assert.strictEqual(util.isCryptoAddress('2NETsvK6gpTRsvxt3z4oJJLVof6BkA9AHmQ'), true);
        });
        it('should accept a valid regtest bech32 segwit address', function () {
            assert.strictEqual(util.isCryptoAddress('bcrt1qe6l04hhwjg98fmggptdm0cemj6lm7hhwzahaul'), true);
        });
        it('should accept a valid regtest bech32m taproot address', function () {
            assert.strictEqual(util.isCryptoAddress('bcrt1pxqgcx65hqkd9c7y6wulyfv2wlwawqx62n3ufwxkjhjpas2jtqxmsglytaf'), true);
        });
        it('should reject address-length garbage strings', function () {
            assert.strictEqual(util.isCryptoAddress('a'.repeat(26)), false);
            assert.strictEqual(util.isCryptoAddress('a'.repeat(34)), false);
            assert.strictEqual(util.isCryptoAddress('a'.repeat(42)), false);
        });
        it('should reject a checksum-flipped address', function () {
            // Valid regtest P2PKH with last character changed
            assert.strictEqual(util.isCryptoAddress('mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxJ'), false);
        });
        it('should reject a wrong-network address (mainnet P2PKH on regtest)', function () {
            assert.strictEqual(util.isCryptoAddress('17Roegnpwqam4FwwXsM47bX3Tf1jFyyKMt'), false);
        });
        it('should reject a wrong-coin segwit address (ltc1 HRP on BTC)', function () {
            assert.strictEqual(util.isCryptoAddress('ltc1qerp5jqmc2nja6lrxw0w4e02uvk83aj89qwltym'), false);
        });
        it('should validate against an explicitly passed coin/network', function () {
            assert.strictEqual(util.isCryptoAddress('17Roegnpwqam4FwwXsM47bX3Tf1jFyyKMt', 'BTC', 'mainnet'), true);
            assert.strictEqual(util.isCryptoAddress('LYoDQ9vcZBq4hWBeiKMqVvhqs7FSQSk6ck', 'LTC', 'mainnet'), true);
            assert.strictEqual(util.isCryptoAddress('DKueiiiESH37vowsy4nQgri8u4GDtmQfqt', 'DOGE', 'mainnet'), true);
            assert.strictEqual(util.isCryptoAddress('DKueiiiESH37vowsy4nQgri8u4GDtmQfqt', 'BTC', 'mainnet'), false);
        });
        it('should reject segwit addresses on DOGE (no segwit support)', function () {
            assert.strictEqual(util.isCryptoAddress('bc1q8uuuk4vlqc0lhkskf8lhh9r2q89n2l566uhekf', 'DOGE', 'mainnet'), false);
        });
        it('should reject an unknown coin', function () {
            assert.strictEqual(util.isCryptoAddress('17Roegnpwqam4FwwXsM47bX3Tf1jFyyKMt', 'ETH', 'mainnet'), false);
        });
        it('should reject too short', function () {
            assert.strictEqual(util.isCryptoAddress('abc'), false);
        });
        it('should reject a contract address (not a real on-chain address)', function () {
            assert.strictEqual(util.isCryptoAddress('C:BTC:500'), false);
        });
    });

    describe('isContractAddress()', function () {
        it('should accept a well-formed contract address', function () {
            assert.strictEqual(util.isContractAddress('C:BTC:500'), true);
            assert.strictEqual(util.isContractAddress('C:LTC:1'), true);
            assert.strictEqual(util.isContractAddress('C:DOGE:99999'), true);
            assert.strictEqual(util.isContractAddress('C:TBTC:0'), true);
        });
        it('should reject a real crypto address', function () {
            assert.strictEqual(util.isContractAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'), false);
        });
        it('should reject malformed contract-ish strings', function () {
            assert.strictEqual(util.isContractAddress('C:BTC:'), false);      // no index
            assert.strictEqual(util.isContractAddress('C:BTC:1a'), false);    // non-numeric index
            assert.strictEqual(util.isContractAddress('C::500'), false);      // no chain
            assert.strictEqual(util.isContractAddress('C:btc:500'), false);   // lowercase chain
            assert.strictEqual(util.isContractAddress('X:BTC:500'), false);   // wrong prefix
            assert.strictEqual(util.isContractAddress('C:BTC:500:1'), false); // extra segment
        });
        it('should not throw on null/undefined', function () {
            assert.strictEqual(util.isContractAddress(null), false);
            assert.strictEqual(util.isContractAddress(undefined), false);
        });
    });

    describe('isValidTransactionHash()', function () {
        it('should return 1 for 64-char hash', function () {
            assert.strictEqual(util.isValidTransactionHash('a'.repeat(64)), 1);
        });
        it('should return 0 for wrong length', function () {
            assert.strictEqual(util.isValidTransactionHash('a'.repeat(63)), 0);
            assert.strictEqual(util.isValidTransactionHash('a'.repeat(65)), 0);
        });
        it('should return 0 for empty', function () {
            assert.strictEqual(util.isValidTransactionHash(''), 0);
        });
    });

    // ─── Format Parsing ───────────────────────────────────────────

    describe('isLegacyActionFormat()', function () {
        it('should return false for numeric version "0"', function () {
            assert.strictEqual(util.isLegacyActionFormat(['0', 'TEST']), false);
        });
        it('should return false for numeric version "99"', function () {
            assert.strictEqual(util.isLegacyActionFormat(['99', 'TEST']), false);
        });
        it('should return true for tick name > 2 chars', function () {
            assert.strictEqual(util.isLegacyActionFormat(['TOKENNAME', '1000']), true);
        });
        it('should return true for non-numeric string', function () {
            assert.strictEqual(util.isLegacyActionFormat(['AB', '1000']), true);
        });
    });

    describe('getFormatVersion()', function () {
        it('should return 0 for undefined', function () {
            assert.strictEqual(util.getFormatVersion(undefined), 0);
        });
        it('should return 0 for empty string', function () {
            assert.strictEqual(util.getFormatVersion(''), 0);
        });
        it('should return integer for number input', function () {
            assert.strictEqual(util.getFormatVersion(5), 5);
        });
        it('should return integer for string number', function () {
            assert.strictEqual(util.getFormatVersion('3'), 3);
        });
        it('should accept 0', function () {
            assert.strictEqual(util.getFormatVersion(0), 0);
        });
        it('should accept 255', function () {
            assert.strictEqual(util.getFormatVersion(255), 255);
        });
        it('should return null for 256', function () {
            assert.strictEqual(util.getFormatVersion(256), null);
        });
        it('should return null for non-numeric string', function () {
            assert.strictEqual(util.getFormatVersion('abc'), null);
        });
        it('should return null for float', function () {
            assert.strictEqual(util.getFormatVersion(1.5), null);
        });
        it('should strip quotes from strings', function () {
            assert.strictEqual(util.getFormatVersion('"3"'), 3);
        });
    });

    describe('getFormatFieldList()', function () {
        it('should return unique list of fields from all formats', function () {
            const formats = {
                0: 'VERSION|TICK|AMOUNT',
                1: 'VERSION|TICK|DESCRIPTION',
            };
            const result = util.getFormatFieldList(formats);
            assert.deepStrictEqual(result, ['VERSION', 'TICK', 'AMOUNT', 'DESCRIPTION']);
        });
        it('should handle single format', function () {
            const formats = { 0: 'VERSION|TICK' };
            assert.deepStrictEqual(util.getFormatFieldList(formats), ['VERSION', 'TICK']);
        });
    });

    describe('setActionParams()', function () {
        it('should map params to fields based on format', function () {
            const formats = { 0: 'VERSION|TICK|AMOUNT' };
            const data = {};
            const result = util.setActionParams(data, ['0', 'TEST', '100'], formats, 0);
            assert.strictEqual(result.VERSION, '0');
            assert.strictEqual(result.TICK, 'TEST');
            assert.strictEqual(result.AMOUNT, '100');
        });
        it('should set missing params to null', function () {
            const formats = { 0: 'VERSION|TICK|AMOUNT|MEMO' };
            const data = {};
            const result = util.setActionParams(data, ['0', 'TEST'], formats, 0);
            assert.strictEqual(result.AMOUNT, null);
            assert.strictEqual(result.MEMO, null);
        });
        it('should set fields from other formats to null if not in current format', function () {
            const formats = {
                0: 'VERSION|TICK|AMOUNT',
                1: 'VERSION|TICK|DESCRIPTION',
            };
            const data = {};
            const result = util.setActionParams(data, ['0', 'TEST', '100'], formats, 0);
            assert.strictEqual(result.DESCRIPTION, null);
        });
        it('should trim param values', function () {
            const formats = { 0: 'VERSION|TICK' };
            const data = {};
            const result = util.setActionParams(data, ['0', '  TEST  '], formats, 0);
            assert.strictEqual(result.TICK, 'TEST');
        });
    });

    // ─── Balance & Ledger Helpers ─────────────────────────────────

    describe('hasBalance()', function () {
        it('should return true when balance >= amount', function () {
            assert.strictEqual(util.hasBalance({ 1: '100' }, 1, '50'), true);
        });
        it('should return true when balance == amount', function () {
            assert.strictEqual(util.hasBalance({ 1: '100' }, 1, '100'), true);
        });
        it('should return false when balance < amount', function () {
            assert.strictEqual(util.hasBalance({ 1: '50' }, 1, '100'), false);
        });
        it('should return false when tick_id not in balances', function () {
            assert.strictEqual(util.hasBalance({}, 1, '100'), false);
        });
        it('should handle high-precision amounts', function () {
            assert.strictEqual(util.hasBalance({ 1: '0.000000000000000001' }, 1, '0.000000000000000001'), true);
        });
    });

    describe('debitBalances()', function () {
        it('should subtract amount from balance', function () {
            const result = util.debitBalances({ 1: '100' }, 1, '30');
            assert.strictEqual(util.bcformat(result[1], 18), '70.000000000000000000');
        });
        it('should handle debit to zero', function () {
            const result = util.debitBalances({ 1: '100' }, 1, '100');
            assert.strictEqual(util.bcformat(result[1], 18), '0.000000000000000000');
        });
        it('should handle missing tick_id (treats as zero)', function () {
            const result = util.debitBalances({}, 1, '50');
            assert.strictEqual(util.bcformat(result[1], 18), '-50.000000000000000000');
        });
    });

    describe('consolidateLedgerRecords()', function () {
        it('should consolidate duplicate tick+address entries', function () {
            const records = [
                ['TICK1', '50', 'addr1'],
                ['TICK1', '30', 'addr1'],
            ];
            const result = util.consolidateLedgerRecords(records);
            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0][0], 'TICK1');
            assert.strictEqual(result[0][2], 'addr1');
            // 50 + 30 = 80
            assert.strictEqual(parseFloat(result[0][1].toString()), 80);
        });
        it('should keep different addresses separate', function () {
            const records = [
                ['TICK1', '50', 'addr1'],
                ['TICK1', '30', 'addr2'],
            ];
            const result = util.consolidateLedgerRecords(records);
            assert.strictEqual(result.length, 2);
        });
        it('should keep different ticks separate', function () {
            const records = [
                ['TICK1', '50', 'addr1'],
                ['TICK2', '30', 'addr1'],
            ];
            const result = util.consolidateLedgerRecords(records);
            assert.strictEqual(result.length, 2);
        });
        it('should return empty array for empty input', function () {
            assert.deepStrictEqual(util.consolidateLedgerRecords([]), []);
        });
        it('should return single record unchanged', function () {
            const records = [['TICK1', '50', 'addr1']];
            const result = util.consolidateLedgerRecords(records);
            assert.strictEqual(result.length, 1);
        });
    });

    // ─── Fee Calculation ──────────────────────────────────────────

    describe('getTransactionFee()', function () {
        it('should return 0 for 0 db hits', function () {
            const fee = util.getTransactionFee(0, 'BTC');
            assert.strictEqual(util.bcformat(fee, 8), '0.00000000');
        });
        it('should calculate fee for 1 db hit', function () {
            // 1 * 1000 sats * 0.00000001 = 0.00001000
            const fee = util.getTransactionFee(1, 'BTC');
            assert.strictEqual(util.bcformat(fee, 8), '0.00001000');
        });
        it('should calculate fee for 10 db hits', function () {
            // 10 * 1000 * 0.00000001 = 0.00010000
            const fee = util.getTransactionFee(10, 'BTC');
            assert.strictEqual(util.bcformat(fee, 8), '0.00010000');
        });
        it('should calculate fee for 100 db hits', function () {
            const fee = util.getTransactionFee(100, 'BTC');
            assert.strictEqual(util.bcformat(fee, 8), '0.00100000');
        });
    });

    describe('feeForAction()', function () {
        it('returns the fee unchanged for a normal on-wire action', function () {
            assert.strictEqual(util.feeForAction('0.00010000', { IS_EMISSION: false }), '0.00010000');
        });
        it('returns the fee unchanged when no emission flag is present', function () {
            assert.strictEqual(util.feeForAction('0.00010000', {}), '0.00010000');
            assert.strictEqual(util.feeForAction('0.00010000', null), '0.00010000');
        });
        it('returns 0 for a VM-emitted (IS_EMISSION) action', function () {
            assert.strictEqual(util.feeForAction('0.00010000', { IS_EMISSION: true }), '0');
        });
    });

    describe('getExpirationFee()', function () {
        it('should return 0 for format 0 within free days', function () {
            // 182 days free, expiration within free period
            const data = {
                FORMAT: 0,
                BLOCK_TIME: 1000000,
                EXPIRATION: 1000000 + (180 * 86400), // 180 days
            };
            const fee = util.getExpirationFee(data, null);
            assert.strictEqual(Number(fee), 0);
        });
        it('should calculate fee for format 0 beyond free days', function () {
            const data = {
                FORMAT: 0,
                BLOCK_TIME: 1000000,
                EXPIRATION: 1000000 + (365 * 86400), // 365 days
            };
            const fee = util.getExpirationFee(data, null);
            // 365 days > 182 free → fee = 365 * PER_DAY
            assert.ok(Number(fee.toString()) > 0);
        });
        it('should return 0 for format 2 when not extending expiration', function () {
            const data = {
                FORMAT: 2,
                EXPIRATION: 1000,
            };
            const info = {
                EXPIRATION: 2000,
                BLOCK_TIME: 100,
            };
            const fee = util.getExpirationFee(data, info);
            assert.strictEqual(Number(fee), 0);
        });
    });

    describe('getDefaultExpiration()', function () {
        it('should add EXPIRATION_FEE_DEFAULT_DAYS in seconds to block_time', function () {
            const result = util.getDefaultExpiration(1000000);
            // 90 days * 86400 = 7776000 seconds
            const expected = 1000000 + (90 * 86400);
            assert.strictEqual(result.toString(), String(expected));
        });
    });

    describe('getPrice()', function () {
        it('should calculate price as numerator / denominator', function () {
            const result = util.getPrice(100, 50);
            assert.strictEqual(parseFloat(result.toString()), 2);
        });
        it('should use custom precision', function () {
            const result = util.getPrice(1, 3, 8);
            assert.strictEqual(result.toString(), '0.33333333');
        });
    });

    // ─── Data Transformation ──────────────────────────────────────

    describe('setNumberFormats()', function () {
        it('leaves numeric STRING fields as strings (string is the canonical form)', function () {
            // setNumberFormats only coerces non-string numerics to bignumber
            // (guard: typeof value !== 'string'). Wire/amount values are strings
            // everywhere, so they pass through untouched: no float/bignumber drift.
            const data = { AMOUNT: '100', DECIMALS: '8' };
            const result = util.setNumberFormats(data);
            assert.strictEqual(typeof result.AMOUNT, 'string');
            assert.strictEqual(result.AMOUNT, '100');
        });
        it('coerces a non-string numeric field to bignumber', function () {
            const data = { AMOUNT: 100 };
            const result = util.setNumberFormats(data);
            assert.strictEqual(typeof result.AMOUNT, 'object'); // bignumber
            assert.strictEqual(result.AMOUNT.toString(), '100');
        });
        it('should leave non-number-field values unchanged', function () {
            const data = { TICK: 'TEST', AMOUNT: '100' };
            const result = util.setNumberFormats(data);
            assert.strictEqual(result.TICK, 'TEST');
        });
        it('should leave null values as null', function () {
            const data = { AMOUNT: null };
            const result = util.setNumberFormats(data);
            assert.strictEqual(result.AMOUNT, null);
        });
        it('should leave non-numeric values for validation to catch', function () {
            const data = { AMOUNT: 'abc' };
            const result = util.setNumberFormats(data);
            assert.strictEqual(result.AMOUNT, 'abc');
        });
    });

    describe('jsonStringify()', function () {
        it('should serialize normal objects', function () {
            assert.strictEqual(util.jsonStringify({ a: 1 }), '{"a":1}');
        });
        it('should handle BigInt', function () {
            const result = util.jsonStringify({ big: BigInt(123456789) });
            assert.strictEqual(result, '{"big":"123456789"}');
        });
    });

    describe('getDataHash()', function () {
        it('should return deterministic SHA256 hash', function () {
            const hash1 = util.getDataHash({ a: 1, b: 2 });
            const hash2 = util.getDataHash({ a: 1, b: 2 });
            assert.strictEqual(hash1, hash2);
            assert.strictEqual(hash1.length, 64);
        });
        it('should return different hash for different data', function () {
            const hash1 = util.getDataHash({ a: 1 });
            const hash2 = util.getDataHash({ a: 2 });
            assert.notStrictEqual(hash1, hash2);
        });
    });

    describe('ksort()', function () {
        it('should sort object keys alphabetically', function () {
            const result = util.ksort({ c: 3, a: 1, b: 2 });
            assert.deepStrictEqual(Object.keys(result), ['a', 'b', 'c']);
        });
        it('should handle empty object', function () {
            assert.deepStrictEqual(util.ksort({}), {});
        });
    });

    describe('sortPriceActionIndex()', function () {
        it('should sort by GET_PRICE descending, then ACTION_INDEX descending', function () {
            const data = [
                { GET_PRICE: '1', ACTION_INDEX: 2 },
                { GET_PRICE: '2', ACTION_INDEX: 1 },
                { GET_PRICE: '1', ACTION_INDEX: 1 },
            ];
            util.sortPriceActionIndex(data);
            assert.strictEqual(data[0].GET_PRICE, '2');
            assert.strictEqual(data[1].ACTION_INDEX, 2);
            assert.strictEqual(data[2].ACTION_INDEX, 1);
        });
    });

    // ─── Address/Ticker Tracking ──────────────────────────────────

    describe('addAddressTicker()', function () {
        it('should add a single ticker to an address', function () {
            util.addAddressTicker('addr1', 'TICK1');
            assert.deepStrictEqual(util.addresses['addr1'], ['TICK1']);
            assert.deepStrictEqual(util.tickers, ['TICK1']);
        });
        it('should add multiple tickers via array', function () {
            util.addAddressTicker('addr1', ['TICK1', 'TICK2']);
            assert.deepStrictEqual(util.addresses['addr1'], ['TICK1', 'TICK2']);
            assert.deepStrictEqual(util.tickers, ['TICK1', 'TICK2']);
        });
        it('should not duplicate tickers', function () {
            util.addAddressTicker('addr1', 'TICK1');
            util.addAddressTicker('addr1', 'TICK1');
            assert.deepStrictEqual(util.addresses['addr1'], ['TICK1']);
            assert.strictEqual(util.tickers.length, 1);
        });
        it('should track tickers across addresses', function () {
            util.addAddressTicker('addr1', 'TICK1');
            util.addAddressTicker('addr2', 'TICK1');
            assert.strictEqual(util.tickers.length, 1);
        });
        it('should handle undefined ticker without crashing', function () {
            util.addAddressTicker('addr1', undefined);
            assert.deepStrictEqual(util.addresses['addr1'], []);
        });
    });

    // ─── Timer ────────────────────────────────────────────────────

    describe('millisecondsToTimeString()', function () {
        it('should handle seconds', function () {
            const result = util.millisecondsToTimeString(5500);
            assert.ok(result.includes('05.5s'));
        });
        it('should handle minutes', function () {
            const result = util.millisecondsToTimeString(90000);
            assert.ok(result.includes('01m'));
        });
        it('should return empty for 0ms', function () {
            assert.strictEqual(util.millisecondsToTimeString(0), '');
        });
    });
});
