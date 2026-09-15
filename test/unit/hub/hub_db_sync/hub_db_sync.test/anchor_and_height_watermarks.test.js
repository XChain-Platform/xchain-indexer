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
const sinon = require('sinon');

const HubDbSync = require('../../../../../src/hub/hub_db_sync.js');

// Build a HubDbSync whose enabled flag is true (needs both a hub URL and a hub DB),
// backed by a stubbed doQuery we drive per-test to simulate the local price mirror.
function makeSync(maxReferenceBlock) {
    const doQuery = sinon.stub();
    doQuery.callsFake(async () => [{ h: maxReferenceBlock }]);
    const hubDb = { doQuery };
    const sync = new HubDbSync(hubDb, { hubUrl: 'http://hub.test' });
    return { sync, hubDb, doQuery };
}

// ── Anchor-reward attestation mirror-completeness barrier ──
//
// The BTC indexer mints COLLECT-spendable anchor rewards at a height fixed fleet-wide
// (snapshot_block + ANCHOR_REWARD_MIRROR_MATURITY). That fixed height is only safe when a
// node whose mirror has not caught up DECLINES to advance instead of committing a smaller
// reward set, so this barrier's whole job is to fail closed. It gates on the stream
// watermark alone: these rows carry no effective_time, and their arrival is governed by
// DOGE confirmation depth and hub failover, neither comparable to a BTC height or time.
describe('HubDbSync anchor-reward attestation barrier @regression @tier1', function () {

    it('resolves immediately when the stream watermark already covers the block plus its grace', async function () {
        const { sync } = makeSync(0);
        sync.streamWatermark = 1000 + sync.anchorAttestWatermarkGraceS;
        assert.strictEqual(await sync.waitForAnchorAttestationSync(1000, 500), sync.streamWatermark);
    });

    it('does NOT resolve on a watermark that is short by the grace margin', function () {
        const { sync } = makeSync(0);
        sync.streamWatermark = 1000 + sync.anchorAttestWatermarkGraceS - 1;
        assert.strictEqual(sync.anchorAttestSyncSatisfied(1000), false);
    });

    it('resolves once a later watermark advance covers the block', async function () {
        const { sync } = makeSync(0);
        sync.streamWatermark = 0;
        const pending = sync.waitForAnchorAttestationSync(1000, 2000);
        assert.strictEqual(sync._anchorAttestWaiters.length, 1, 'the block waits rather than deriving a partial set');
        sync.advanceWatermark(1000 + sync.anchorAttestWatermarkGraceS);
        await pending;
        assert.strictEqual(sync._anchorAttestWaiters.length, 0, 'waiter cleared on resolve');
    });

    it('rejects on timeout so the caller DEFERS the block instead of committing it', async function () {
        const { sync } = makeSync(0);
        sync.streamWatermark = 0;
        await assert.rejects(
            sync.waitForAnchorAttestationSync(1000, 50),
            /anchor-reward attestation mirror barrier timed out/);
        assert.strictEqual(sync._anchorAttestWaiters.length, 0, 'timed-out waiter removed');
    });

    // With no mirror the indexer reads the hub's MariaDB directly, so there is no delivery
    // lag to wait out and the barrier must not wedge a single-host / regtest stack.
    it('is satisfied by definition when sync is disabled', async function () {
        const sync = new HubDbSync({ doQuery: sinon.stub().resolves([]) }, { hubUrl: '' });
        assert.strictEqual(sync.enabled, false);
        assert.strictEqual(sync.anchorAttestSyncSatisfied(999999), true);
        await sync.waitForAnchorAttestationSync(999999, 10);
    });

    // Poll mode freezes the stream watermark on purpose (a REST poll cannot observe an
    // in-place upsert), so a poll-mode node can never certify completeness and must defer.
    // That is the correct outcome: it is exactly the node whose mirror might be stale.
    it('never certifies completeness in poll mode (frozen watermark defers the block)', async function () {
        const { sync } = makeSync(0);
        sync._pollMode = true;
        sync.streamWatermark = 0;
        await assert.rejects(sync.waitForAnchorAttestationSync(1000, 30),
            /anchor-reward attestation mirror barrier timed out/);
    });
});

// ── The anchor-attest barrier's MATURITY HORIZON bound ──
//
// The derive pass at B reads exactly the rows with snapshot_block <= B - 144, and the hub
// wrote every one of those no later than time(snapshot_block) + its measured write-lag
// envelope. So a watermark past time(B - 144) + ANCHOR_ATTEST_ARRIVAL_MARGIN_S certifies the
// same completeness the block's own stamp does, from a stamp roughly a day old that no miner
// of THIS block chose. The min() is what makes it safe to reason about: the target can only
// ever be EARLIER, so this is a strict relaxation and nothing that passes today starts
// deferring.
describe('HubDbSync anchor-attest maturity-horizon bound @regression @tier1', function () {
    // The whole point, in one case: the same block, the same watermark, and the horizon bound
    // is the difference between deferring and proceeding.
    it('a bound BELOW blockTime opens the barrier that the block\'s own stamp would hold', function () {
        const { sync } = makeSync(0);
        const grace = sync.anchorAttestWatermarkGraceS;
        sync.streamWatermark = 900 + grace;
        assert.strictEqual(sync.anchorAttestSyncSatisfied(1000), false,
            'without a bound the +7200-class block holds');
        assert.strictEqual(sync.anchorAttestSyncSatisfied(1000, 900), true,
            'with the horizon bound it proceeds');
    });

    it('a bound ABOVE blockTime cannot delay the barrier (min(), never max())', function () {
        const { sync } = makeSync(0);
        sync.streamWatermark = 1000 + sync.anchorAttestWatermarkGraceS;
        assert.strictEqual(sync.anchorAttestSyncSatisfied(1000, 999999), true,
            'the bound may only ever open EARLIER; a large one is simply ignored');
    });

    it('a null bound is today\'s predicate exactly', function () {
        const { sync } = makeSync(0);
        const grace = sync.anchorAttestWatermarkGraceS;
        sync.streamWatermark = 1000 + grace - 1;
        assert.strictEqual(sync.anchorAttestSyncSatisfied(1000, null), false);
        sync.streamWatermark = 1000 + grace;
        assert.strictEqual(sync.anchorAttestSyncSatisfied(1000, null), true);
    });

    // THE TRAP THIS GUARD EXISTS FOR. getBlockTime returns literal `false` for a block the
    // decoder cannot serve, and Number(false) is 0, so a coercing guard would hand the
    // predicate a bound of `0 + margin` and open this barrier at watermark >= margin + grace
    // on every decoder gap above height 144. `false` must be the LEGACY form, not height zero.
    it('the false sentinel and every other unusable bound fall back to the legacy form', function () {
        const { sync } = makeSync(0);
        const grace = sync.anchorAttestWatermarkGraceS;
        sync.streamWatermark = grace;          // enough for a bound of 0, nowhere near blockTime
        for (const bogus of [false, true, null, undefined, NaN, Infinity, '', '900', [], {}]) {
            assert.strictEqual(sync.anchorAttestSyncSatisfied(1000, bogus), false,
                'a bound of ' + JSON.stringify(bogus) + ' must not open the barrier');
        }
        // and the same watermark with a REAL bound of 0 does open it, so the case above is
        // rejecting the sentinel rather than the arithmetic.
        assert.strictEqual(sync.anchorAttestSyncSatisfied(1000, 0), true);
    });

    it('the waiter carries its bound, so a later advance releases it on the bound', async function () {
        const { sync } = makeSync(0);
        sync.streamWatermark = 0;
        const pending = sync.waitForAnchorAttestationSync(1000, 2000, 900);
        assert.strictEqual(sync._anchorAttestWaiters.length, 1);
        // Short of blockTime + grace, but past bound + grace: only a waiter that kept its
        // bound can be released here.
        sync.advanceWatermark(900 + sync.anchorAttestWatermarkGraceS);
        await pending;
        assert.strictEqual(sync._anchorAttestWaiters.length, 0);
    });
});

describe('HubDbSync anchor-attest maturity-horizon bound @regression @tier1', function () {
    it('the timeout message keeps its prefix and names the bound that applied', async function () {
        const { sync } = makeSync(0);
        sync.streamWatermark = 0;
        await assert.rejects(sync.waitForAnchorAttestationSync(1000, 30, 900), (err) => {
            assert.strictEqual(err.message,
                'anchor-reward attestation mirror barrier timed out after 30ms waiting for ' +
                'block_time 1000 (horizon bound 900, stream watermark at 0)');
            return true;
        });
    });

    it('with no bound the timeout message is byte-identical to the one it has always had', async function () {
        const { sync } = makeSync(0);
        sync.streamWatermark = 0;
        await assert.rejects(sync.waitForAnchorAttestationSync(1000, 30), (err) => {
            assert.strictEqual(err.message,
                'anchor-reward attestation mirror barrier timed out after 30ms waiting for ' +
                'block_time 1000 (stream watermark at 0)');
            return true;
        });
    });

    it('the six single-argument callers keep working under the optional parameters', function () {
        const { sync } = makeSync(0);
        sync.streamWatermark = 1000 + sync.anchorAttestWatermarkGraceS;
        assert.strictEqual(sync.anchorAttestSyncSatisfied(1000), true);
    });
});

// ── The per-table, per-chain height watermark: the wire contract ──
describe('HubDbSync height watermark wire contract @regression @tier1', function () {
    const { sanitizeHeights, heightsAdvanced } = require('../../../../../src/hub/hub_db_sync.js');

    it('sanitizeHeights keeps only non-negative safe integers, upper-casing the chain', function () {
        assert.deepStrictEqual(
            sanitizeHeights({ cross_chain_matches: { btc: 10, ltc: '5', doge: -1, xyz: 1.5 } }),
            { cross_chain_matches: { BTC: 10 } });
    });

    it('sanitizeHeights distinguishes "published and empty" from "never published"', function () {
        assert.deepStrictEqual(sanitizeHeights({}), {}, 'an empty map is a publication');
        assert.deepStrictEqual(sanitizeHeights({ oracle_prices: {} }), { oracle_prices: {} });
        for (const absent of [undefined, null, 42, 'x', [1, 2], true]) {
            assert.strictEqual(sanitizeHeights(absent), null, JSON.stringify(absent) + ' is not a map');
        }
    });

    it('heightsAdvanced is true only for a strictly higher entry', function () {
        assert.strictEqual(heightsAdvanced({ t: { BTC: 5 } }, { t: { BTC: 6 } }), true);
        assert.strictEqual(heightsAdvanced({ t: { BTC: 5 } }, { t: { BTC: 5 } }), false, 'a repeat is not progress');
        assert.strictEqual(heightsAdvanced({ t: { BTC: 5 } }, { t: { BTC: 4 } }), false, 'nor is a regression');
        assert.strictEqual(heightsAdvanced({ t: { BTC: 5 } }, { t: {} }), false, 'nor is losing the entry');
        assert.strictEqual(heightsAdvanced({}, { t: { BTC: 0 } }), true, 'a first entry is an advance');
    });

    it('a carrier with no usable map CLEARS the previous one rather than coasting on it', function () {
        const { sync } = makeSync(0);
        sync.noteHeights({ cross_chain_matches: { BTC: 10 } });
        assert.deepStrictEqual(sync.heightWatermarks, { cross_chain_matches: { BTC: 10 } });
        // An older hub, or one that stopped publishing: a v6 hub serving a v7 indexer above
        // the activation must make it DEFER, not run on a claim nobody is renewing.
        sync.noteHeights(undefined);
        assert.deepStrictEqual(sync.heightWatermarks, {});
    });

    it('the first install arms the height stall axis; a repeat does not restart its window', function () {
        const { sync } = makeSync(0);
        assert.strictEqual(sync._heightsLastAdvanceAt, null, 'cold start, not a stall');
        sync.noteHeights({ t: { BTC: 5 } });
        const first = sync._heightsLastAdvanceAt;
        assert.ok(first !== null);
        sync.noteHeights({ t: { BTC: 5 } });
        assert.strictEqual(sync._heightsLastAdvanceAt, first, 'a hub repeating itself has not advanced');
    });

    it('a full bootstrap drain installs the map the snapshot pages carried', async function () {
        const { sync } = makeSync(0);
        sync._pollMode = false;
        sync._bootstrapTable = async function () {
            this._pendingBootstrapHeights = { oracle_prices: { BTC: 77 } };
            return 12345;
        };
        await sync.bootstrapAll();
        assert.strictEqual(sync._bootstrapDrained, true);
        assert.deepStrictEqual(sync.heightWatermarks, { oracle_prices: { BTC: 77 } });
    });
});

describe('HubDbSync height watermark wire contract @regression @tier1', function () {
    it('poll mode installs NO height map, exactly as it advances no watermark', async function () {
        const { sync } = makeSync(0);
        sync._pollMode = true;
        sync._bootstrapTable = async function () {
            this._pendingBootstrapHeights = { oracle_prices: { BTC: 77 } };
            return 12345;
        };
        await sync.bootstrapAll();
        assert.deepStrictEqual(sync.heightWatermarks, {},
            'a poll-mode mirror cannot observe an upsert, so it certifies nothing on either axis');
    });

    it('the ready frame\'s map is the fallback when the snapshot pages carried none', async function () {
        const { sync } = makeSync(0);
        sync._pollMode = false;
        sync._readyHeights = { policy_snapshots: { DOGE: 9 } };
        sync._bootstrapTable = async function () { return 12345; };
        await sync.bootstrapAll();
        assert.deepStrictEqual(sync.heightWatermarks, { policy_snapshots: { DOGE: 9 } });
    });

    it('mirrorStatus on a disabled mirror reports an empty heights map, never a live-looking one', function () {
        const sync = new HubDbSync({ doQuery: sinon.stub().resolves([]) }, { hubUrl: '' });
        assert.deepStrictEqual(sync.mirrorStatus().heights, {});
    });

    // THE GATE, and it is the same gate the seconds watermark has always had. Both values are
    // certifications about what THIS mirror holds, and both are false until the REST bootstrap
    // has drained the rows produced before the subscription. A heights map installed early
    // certifies exactly that gap, and a barrier re-keyed onto it opens over it.
    it('a heartbeat frame installs NOTHING before the bootstrap has drained', function () {
        const { sync } = makeSync(0);
        sync._bootstrapDrained = false;
        sync.handleWatermarkFrame({ ts: 5000, heights: { oracle_prices: { BTC: 42 } } });
        assert.deepStrictEqual(sync.heightWatermarks, {}, 'no height evidence before the drain');
        assert.strictEqual(sync.streamWatermark, 0, 'and no seconds evidence either, as always');
    });

    it('a heartbeat frame installs BOTH once the bootstrap has drained', function () {
        const { sync } = makeSync(0);
        sync._bootstrapDrained = true;
        sync.handleWatermarkFrame({ ts: 5000, heights: { oracle_prices: { BTC: 42 } } });
        assert.deepStrictEqual(sync.heightWatermarks, { oracle_prices: { BTC: 42 } });
        assert.strictEqual(sync.streamWatermark, 5000);
    });

    it('an outstanding schema mismatch freezes the height map exactly as it freezes the watermark', function () {
        const { sync } = makeSync(0);
        sync._bootstrapDrained   = true;
        sync._schemaMismatchSeen = true;
        sync.handleWatermarkFrame({ ts: 5000, heights: { oracle_prices: { BTC: 42 } } });
        assert.deepStrictEqual(sync.heightWatermarks, {},
            'rows are being REFUSED under a mismatch, so certifying either axis would settle ' +
            'blocks against data this node did not apply');
        assert.strictEqual(sync.streamWatermark, 0);
    });
});

describe('HubDbSync height watermark wire contract @regression @tier1', function () {
    // The second gate, behind sanitizeHeights. Nothing on the wire path can reach it, which is
    // precisely why it needs a case of its own: an in-process writer that bypassed the
    // sanitizer would otherwise hand a barrier a string or a boolean to compare against B.
    it('_publishedHeight refuses anything that is not a real height, sanitizer or no sanitizer', function () {
        const { sync } = makeSync(0);
        sync.heightWatermarks = { t: { BTC: '900', LTC: true, DOGE: 900.5, XCP: -1, ZZZ: 900 } };
        assert.strictEqual(sync.publishedHeight('t', 'BTC'), null, 'a digit string is not a number');
        assert.strictEqual(sync.publishedHeight('t', 'LTC'), null, 'true is not height one');
        assert.strictEqual(sync.publishedHeight('t', 'DOGE'), null, 'a height is an integer');
        assert.strictEqual(sync.publishedHeight('t', 'XCP'), null, 'a height is not negative');
        assert.strictEqual(sync.publishedHeight('t', 'ZZZ'), 900);
        assert.strictEqual(sync.publishedHeight('missing', 'BTC'), null);
    });
});

// ── The stall detector's HEIGHT dimension ──
//
// watermarkStallVerdict compares two wall-clock seconds values and nothing height-shaped,
// so a hub whose heights map froze while its ts kept ticking reads 'ok' forever and only the
// block loop's 900 s ceiling would ever fire, which is delivery-side and cannot clear a
// producer-side freeze.
describe('watermarkStallVerdict height dimension @regression @tier1', function () {
    const { watermarkStallVerdict } = require('../../../../../src/hub/hub_db_sync.js');
    const BASE = { stallMs: 1000, exitMs: 2000, pollMode: false, schemaMismatch: false,
                   lastAdvanceAt: null, resyncAt: null, hubTipTs: 0, streamWatermark: 0,
                   heightsLastAdvanceAt: null, heightsShort: false };
    const st = (over) => Object.assign({}, BASE, over);

    it('a frozen heights map with a LIVE seconds watermark is now a stall', function () {
        // The exact state that read 'ok' forever: the hub's ts is level with ours (nothing
        // owed on the seconds axis) while the height watermark this node needs has not moved.
        const state = st({ lastAdvanceAt: 10000, hubTipTs: 5, streamWatermark: 5,
                           heightsLastAdvanceAt: 10000, heightsShort: true });
        assert.strictEqual(watermarkStallVerdict(state, 10999), 'ok', 'inside the window');
        assert.strictEqual(watermarkStallVerdict(state, 11000), 'resync', 'at the window');
    });

    it('a heights map that is short but has never been served is a cold start, not a stall', function () {
        const state = st({ lastAdvanceAt: 10000, hubTipTs: 5, streamWatermark: 5,
                           heightsLastAdvanceAt: null, heightsShort: true });
        assert.strictEqual(watermarkStallVerdict(state, 99999), 'ok');
    });

    it('a fresh heights advance keeps the verdict ok however short the entry is', function () {
        const state = st({ lastAdvanceAt: 10000, hubTipTs: 5, streamWatermark: 5,
                           heightsLastAdvanceAt: 10900, heightsShort: true });
        assert.strictEqual(watermarkStallVerdict(state, 11000), 'ok', 'the map is moving');
    });

    it('poll mode and a schema mismatch suppress the height axis too', function () {
        const base = { lastAdvanceAt: 10000, heightsLastAdvanceAt: 10000, heightsShort: true };
        assert.strictEqual(watermarkStallVerdict(st(Object.assign({ pollMode: true }, base)), 99999), 'ok');
        assert.strictEqual(watermarkStallVerdict(st(Object.assign({ schemaMismatch: true }, base)), 99999), 'ok');
    });

    it('with the height axis idle the verdict is today\'s rule, case for case', function () {
        // hub ahead + frozen watermark = the pre-existing stall
        assert.strictEqual(watermarkStallVerdict(
            st({ lastAdvanceAt: 10000, hubTipTs: 9, streamWatermark: 5 }), 11000), 'resync');
        // hub level = the ordinary quiet chain
        assert.strictEqual(watermarkStallVerdict(
            st({ lastAdvanceAt: 10000, hubTipTs: 5, streamWatermark: 5 }), 99999), 'ok');
        // never certified anything = a cold start
        assert.strictEqual(watermarkStallVerdict(
            st({ lastAdvanceAt: null, hubTipTs: 9, streamWatermark: 5 }), 99999), 'ok');
        // stage 2 still measures from the remedy
        assert.strictEqual(watermarkStallVerdict(
            st({ lastAdvanceAt: 10000, hubTipTs: 9, streamWatermark: 5, resyncAt: 11000 }), 12999), 'ok');
        assert.strictEqual(watermarkStallVerdict(
            st({ lastAdvanceAt: 10000, hubTipTs: 9, streamWatermark: 5, resyncAt: 11000 }), 13000), 'exit');
    });

    it('the shortfall record clears itself when the map catches up', function () {
        const { sync } = makeSync(0);
        sync._heightShortfalls = { 'cross_chain_matches|BTC': 996 };
        sync.noteHeights({ cross_chain_matches: { BTC: 995 } });
        assert.strictEqual(sync.heightsShort(), true, 'still one short');
        sync.noteHeights({ cross_chain_matches: { BTC: 996 } });
        assert.strictEqual(sync.heightsShort(), false, 'caught up, so no longer stalled');
    });
});
