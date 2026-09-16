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
// Utility, block loop: the per-block DEX market refresh and the three deterministic
// cross-chain call steps (inject, deliver, expire) with their per-block caps.
// Part of the Utility suite; see ../utility.test.js.

const assert = require('assert');
const sinon = require('sinon');

// Set env before requiring Utility (it loads config in constructor)
process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const Utility = require('../../../../src/utility.js');

// Every test gets a fresh Utility: the address and ticker lists it tracks live
// on the instance.
let util;
function freshUtil() { util = new Utility(); }

// The action entry points and hub queries one processCrossChainCalls() run reads,
// rebuilt before every test so no stub state leaks between cases.
const COIN = 'BTC', NETWORK = 'regtest';
const CAP = require('../../../../src/actions/xcall/index.js').XCALL_MAX_CALLS_PER_BLOCK;
let actions, db, processAction, processResult;
let resultSuppressesExpiry;

// Fresh stubs for each case: every hub query answers empty until a test says otherwise.
function stubCrossChainCalls() {
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
}

describe('Utility @regression @tier1', function () {
    beforeEach(freshUtil);

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
            const db = fakeDb([{ tick1_id: 1, tick2_id: 2, coin1_id: 3, coin2_id: 3 }], []);
            await util.processMarketUpdates(db, 100, 1700000000);
            assert.ok(db.getMarkets.calledOnceWithExactly(100, false));
            assert.strictEqual(db.createMarket.callCount, 1);
            // The coin ids ride along: they are what names a side that has no ticker.
            assert.ok(db.createMarket.calledWithExactly(1, 2, 3, 3));
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
            // decoder DB); handed to bcsub, "false" throws and would wedge block processing.
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
});

describe('Utility @regression @tier1', function () {
    beforeEach(freshUtil);

    // ─── Cross-chain call orchestration (the block loop's three deterministic passes) ──
    describe('processCrossChainCalls()', function () {
        beforeEach(stubCrossChainCalls);

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
    });
});

describe('Utility @regression @tier1', function () {
    beforeEach(freshUtil);

    describe('processCrossChainCalls()', function () {
        beforeEach(stubCrossChainCalls);

        it('fetches the full effective result set and delivers at most the cap', async function () {
            // Results are fetched uncapped (so the expiry pass can see requests that are
            // deliverable this block but deferred past the cap) and the per-block cap is then
            // applied as a deterministic slice on delivery. The uncapped fetch exists ONLY to
            // feed the expiry pass, so this block has something to expire.
            const many = Array.from({ length: CAP + 5 }, (_, i) => ({ call_id: String(i).padStart(64, '0') }));
            db.getEffectiveUnprocessedCallResults.resolves(many);
            db.getExpiredCrossChainCallRequests.resolves([{ call_id: many[CAP + 1].call_id }]);
            await util.processCrossChainCalls(actions, db, 100, 1700000000);
            assert.ok(db.getEffectiveUnprocessedCallResults.getCall(0).args[3] > CAP, 'results fetched uncapped');
            assert.strictEqual(processResult.callCount, CAP, 'delivers exactly the per-block cap');
        });

        it('a block with nothing to expire fetches results at the cap instead of dragging the backlog', async function () {
            // The uncapped fetch feeds a suppression map the expiry pass alone reads. With no
            // past-deadline pending request there is no expiry pass, so the whole finalized-
            // result backlog would be pulled across the (possibly remote hub) connection every
            // ~5s block to serve nothing. The LIMIT-1 probe asks the SAME query as the capped
            // expiry pass, whose set is a subset of the probe's, so an empty probe proves the
            // suppression map is dead this block.
            const many = Array.from({ length: CAP + 5 }, (_, i) => ({ call_id: String(i).padStart(64, '0') }));
            db.getEffectiveUnprocessedCallResults.resolves(many);
            db.getExpiredCrossChainCallRequests.resolves([]);
            await util.processCrossChainCalls(actions, db, 100, 1700000000);
            assert.strictEqual(db.getEffectiveUnprocessedCallResults.getCall(0).args[3], CAP,
                'a quiet block must bind the per-block cap, not an unbounded limit');
            assert.ok(db.getExpiredCrossChainCallRequests.calledWith(100, 1),
                'the probe must ask the expiry query itself, so the two can never disagree');
            assert.strictEqual(processResult.callCount, CAP, 'delivery is unchanged');
        });

        it('the probe never replaces the capped expiry query, so the expiry set is still cap-wide', async function () {
            // Bounding the probe at 1 must not bound the pass: step 3 still binds the full
            // XCALL_MAX_CALLS_PER_BLOCK, or an aligned deadline burst would expire one request
            // per block forever.
            const expired = Array.from({ length: 3 }, (_, i) => ({ call_id: String(i).padStart(64, 'a') }));
            db.getExpiredCrossChainCallRequests.resolves(expired);
            resultSuppressesExpiry.resolves(false);
            await util.processCrossChainCalls(actions, db, 100, 1700000000);
            assert.ok(db.getExpiredCrossChainCallRequests.calledWith(100, CAP),
                'the cap-wide expiry query must still run');
            assert.strictEqual(processAction.getCalls().filter(c => c.args[0] === 'XCALL').length, expired.length,
                'every expired request in the capped set must still be synthesized');
        });
    });
});

describe('Utility @regression @tier1', function () {
    beforeEach(freshUtil);

    describe('processCrossChainCalls()', function () {
        beforeEach(stubCrossChainCalls);

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
            // Result expiry: a hub mirror can hold a phase=result/status=finalized row with invalid
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
    });
});

describe('Utility @regression @tier1', function () {
    beforeEach(freshUtil);

    describe('processCrossChainCalls()', function () {
        beforeEach(stubCrossChainCalls);

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
});
