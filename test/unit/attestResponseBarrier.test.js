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
const fs     = require('fs');
const path   = require('path');
const sinon  = require('sinon');

const HubDbSync = require('../../src/hub_db_sync.js');
const { stallClassOf } = require('../../src/XChainIndexer.js');

// A HubDbSync with enabled === true (needs both a hub URL and a hub DB). doQuery
// answers every content query with an EMPTY result set, which is the state this
// barrier must NOT treat as permission to proceed.
function makeSync() {
    const doQuery = sinon.stub().callsFake(async () => []);
    const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
    return { sync, doQuery };
}

// ── The barrier itself ─────────────────────────────────────────────────────────
//
// attestation_responses rows bind at the first block whose protocol time reaches
// their signed effective_time, and that block fires the callback and settles the
// fee. Missing the row is a permanent fork, not a lag, so the barrier is pure
// stream watermark and fails closed in every ambiguous case.
describe('HubDbSync attestation-response barrier @regression @tier1', function () {

    it('is NOT satisfied one second below blockTime + grace', function () {
        const { sync } = makeSync();
        sync.streamWatermark = 1000 + sync.attestResponseWatermarkGraceS - 1;
        assert.strictEqual(sync._attestResponseSyncSatisfied(1000), false);
    });

    it('is satisfied exactly at blockTime + grace', async function () {
        const { sync } = makeSync();
        sync.streamWatermark = 1000 + sync.attestResponseWatermarkGraceS;
        assert.strictEqual(sync._attestResponseSyncSatisfied(1000), true);
        assert.strictEqual(await sync.waitForAttestationResponseSync(1000, 500), sync.streamWatermark);
    });

    it('is satisfied above blockTime + grace', async function () {
        const { sync } = makeSync();
        sync.streamWatermark = 1000 + sync.attestResponseWatermarkGraceS + 5000;
        assert.strictEqual(sync._attestResponseSyncSatisfied(1000), true);
        assert.strictEqual(await sync.waitForAttestationResponseSync(1000, 500), sync.streamWatermark);
    });

    it('reads the grace off the resolved instance field, not a private constant', function () {
        const { sync } = makeSync();
        assert.strictEqual(typeof sync.attestResponseWatermarkGraceS, 'number');
        sync.attestResponseWatermarkGraceS = 900;
        sync.streamWatermark = 1000 + 899;
        assert.strictEqual(sync._attestResponseSyncSatisfied(1000), false);
        sync.streamWatermark = 1000 + 900;
        assert.strictEqual(sync._attestResponseSyncSatisfied(1000), true);
    });

    // The wake path, end to end and through the real release site. A barrier that only
    // adds a waitFor... method blocks every block until its own timeout, because nothing
    // re-evaluates the waiter when the watermark moves (spec decision D68).
    it('a pending waiter is woken by _advanceWatermark, not only by its timeout', async function () {
        this.timeout(3000);
        const { sync } = makeSync();
        sync.streamWatermark = 0;
        const pending = sync.waitForAttestationResponseSync(1000, 1000);
        assert.strictEqual(sync._attestResponseWaiters.length, 1, 'the block waits rather than proceeding');
        sync._advanceWatermark(1000 + sync.attestResponseWatermarkGraceS);
        const got = await pending;
        assert.strictEqual(got, 1000 + sync.attestResponseWatermarkGraceS);
        assert.strictEqual(sync._attestResponseWaiters.length, 0, 'waiter cleared on resolve');
    });

    it('a watermark advance that is still short of the grace leaves the waiter pending', function () {
        const { sync } = makeSync();
        sync.streamWatermark = 0;
        const pending = sync.waitForAttestationResponseSync(1000, 1000);
        pending.catch(() => {});                                  // the timeout rejection is expected here
        sync._advanceWatermark(1000 + sync.attestResponseWatermarkGraceS - 1);
        assert.strictEqual(sync._attestResponseWaiters.length, 1, 'a short advance must not release the block');
    });

    it('rejects on timeout when the watermark never moves, so the caller DEFERS', async function () {
        const { sync } = makeSync();
        sync.streamWatermark = 0;
        await assert.rejects(
            sync.waitForAttestationResponseSync(1000, 50),
            /attestation response mirror barrier timed out/);
        assert.strictEqual(sync._attestResponseWaiters.length, 0, 'timed-out waiter removed');
    });

    // No empty-mirror escape. _callSyncSatisfied admits a block when the mirror holds no
    // rows at all, because a missing relay row there is a latency question. Here an empty
    // mirror is indistinguishable from a mirror that has not yet been told about the row
    // binding at THIS block, and admitting the block would fork the ledger permanently.
    it('an ENABLED but empty mirror at watermark 0 does not admit the block', async function () {
        const { sync, doQuery } = makeSync();
        sync.enabled = true;
        sync.streamWatermark = 0;
        assert.strictEqual(sync._attestResponseSyncSatisfied(1000), false);
        await assert.rejects(
            sync.waitForAttestationResponseSync(1000, 50),
            /attestation response mirror barrier timed out/);
        assert.strictEqual(doQuery.called, false,
            'the barrier must gate on the stream watermark alone, never on row content');
    });

    // With no mirror the indexer reads the hub's MariaDB directly: no delivery lag exists
    // to wait out, so the barrier must not wedge a single-host / regtest stack.
    it('is satisfied by definition when sync is disabled', async function () {
        const sync = new HubDbSync({ doQuery: sinon.stub().resolves([]) }, { hubUrl: '' });
        assert.strictEqual(sync.enabled, false);
        assert.strictEqual(sync._attestResponseSyncSatisfied(999999), true);
        await sync.waitForAttestationResponseSync(999999, 10);
    });

    // Poll mode freezes the stream watermark on purpose (a REST poll cannot observe an
    // in-place upsert), so a poll-mode node can never certify completeness and defers.
    it('never certifies completeness in poll mode', async function () {
        const { sync } = makeSync();
        sync._pollMode = true;
        sync.streamWatermark = 0;
        await assert.rejects(sync.waitForAttestationResponseSync(1000, 30),
            /attestation response mirror barrier timed out/);
    });

    // The names collide by eye and mean different tables. anchorAttest is
    // anchor_reward_attestations; attestResponse is attestation_responses.
    it('does not share waiters with the anchor-reward attestation barrier', function () {
        const { sync } = makeSync();
        sync.streamWatermark = 0;
        const pending = sync.waitForAttestationResponseSync(1000, 200);
        pending.catch(() => {});
        assert.strictEqual(sync._attestResponseWaiters.length, 1);
        assert.strictEqual(sync._anchorAttestWaiters.length, 0);
    });
});

// ── The block-loop defer site ──────────────────────────────────────────────────
//
// The gate is one `if` inside a ~700-line block loop that cannot be stood up in a
// unit test. Rather than assert on source text (which cannot tell a live gate from
// a commented one), lift the real guarded region out of the file and EXECUTE it
// against a fake indexer. Deleting the coin gate, renaming the reason or borrowing
// another barrier's grace all change what these assertions observe.
describe('attest_response_sync_barrier defer site @regression @tier1', function () {
    const INDEXER_SRC = fs.readFileSync(
        path.resolve(__dirname, '../../src/XChainIndexer.js'), 'utf8');

    // Lift the whole `if(...){ ... }` that contains the barrier's stall reason: walk back
    // to the nearest preceding `if(` and brace-match forward from it.
    function extractBarrierBlock() {
        const marker = INDEXER_SRC.indexOf("this.stallReason = 'attest_response_sync_barrier';");
        assert.notStrictEqual(marker, -1, 'the attest_response_sync_barrier defer site is missing entirely');
        const ifStart = INDEXER_SRC.lastIndexOf('if(', marker);
        const open = INDEXER_SRC.indexOf('{', ifStart);
        let depth = 0, end = -1;
        for (let i = open; i < INDEXER_SRC.length; i++) {
            const c = INDEXER_SRC[i];
            if (c === '{') depth++;
            else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
        }
        assert.notStrictEqual(end, -1, 'unbalanced braces around the defer site');
        return INDEXER_SRC.slice(ifStart, end);
    }

    // Run the lifted block with `this` bound to a fake indexer. The trailing `break` in
    // the catch needs an enclosing loop, so the block is wrapped in a one-pass for.
    function runBarrier(fakeIndexer, blockTime, blockToParse) {
        const body = 'return (async function(blockTime, blockToParse){ for(;;){ ' +
                     extractBarrierBlock() + ' break; } }).call(this, blockTime, blockToParse);';
        // eslint-disable-next-line no-new-func
        const fn = new Function('blockTime', 'blockToParse', body);
        return fn.call(fakeIndexer, blockTime, blockToParse);
    }

    function makeIndexer(coin, barrierResult) {
        const calls = [];
        return {
            calls,
            config: { COIN: coin },
            priceSyncTimeoutMs: 4321,
            stallReason: null,
            stallClearsAt: null,
            clearsAtField: null,
            hubDbSync: {
                attestResponseWatermarkGraceS: 120,
                waitForAttestationResponseSync(blockTime, timeoutMs) {
                    calls.push({ blockTime, timeoutMs });
                    return barrierResult === 'reject'
                        ? Promise.reject(new Error('barrier timed out'))
                        : Promise.resolve(1);
                }
            },
            _barrierClearsAt(blockTime, graceField) {
                this.clearsAtField = graceField;
                const g = Number(this.hubDbSync[graceField]);
                return (blockTime + (Number.isFinite(g) ? g : 0)) * 1000;
            }
        };
    }

    let warn;
    beforeEach(function () { warn = sinon.stub(console, 'warn'); });
    afterEach(function () { warn.restore(); });

    it('consults the barrier on BTC, with the block time and the price-sync timeout', async function () {
        const ix = makeIndexer('BTC', 'resolve');
        await runBarrier(ix, 1700000000, 900);
        assert.deepStrictEqual(ix.calls, [{ blockTime: 1700000000, timeoutMs: 4321 }]);
        assert.strictEqual(ix.stallReason, null, 'a satisfied barrier does not stall the loop');
    });

    // AT0's second half: no attestation stake or request exists off BTC, so arming the
    // barrier there would wedge two live chains on a mirror they never read.
    it('does NOT consult the barrier on LTC', async function () {
        const ix = makeIndexer('LTC', 'reject');
        await runBarrier(ix, 1700000000, 900);
        assert.deepStrictEqual(ix.calls, [], 'the barrier must not arm off BTC');
        assert.strictEqual(ix.stallReason, null);
    });

    it('does NOT consult the barrier on DOGE', async function () {
        const ix = makeIndexer('DOGE', 'reject');
        await runBarrier(ix, 1700000000, 900);
        assert.deepStrictEqual(ix.calls, [], 'the barrier must not arm off BTC');
        assert.strictEqual(ix.stallReason, null);
    });

    it('does not consult the barrier when there is no mirror at all', async function () {
        const ix = makeIndexer('BTC', 'reject');
        ix.hubDbSync = null;
        await runBarrier(ix, 1700000000, 900);
        assert.deepStrictEqual(ix.calls, []);
    });

    // No transaction predicate: a time-bound row can bind at an empty block, so there is
    // nothing to scope the wait to. Driven by handing the block loop an empty block.
    it('arms on a block with no transactions', async function () {
        const ix = makeIndexer('BTC', 'resolve');
        ix.blockTransactions = [];
        await runBarrier(ix, 1700000000, 900);
        assert.strictEqual(ix.calls.length, 1, 'the barrier must arm on EVERY BTC block');
    });

    it('a rejected barrier stalls the loop with its own reason and its own grace field', async function () {
        const ix = makeIndexer('BTC', 'reject');
        await runBarrier(ix, 1700000000, 900);
        assert.strictEqual(ix.stallReason, 'attest_response_sync_barrier');
        assert.strictEqual(ix.clearsAtField, 'attestResponseWatermarkGraceS',
            'borrowing a sibling barrier\'s grace mis-times the /status wedge discriminator');
        assert.strictEqual(ix.stallClearsAt, (1700000000 + 120) * 1000);
    });

    // stallClassOf is reason-agnostic and only needs a truthy reason, but the reason has
    // to be the one operators and the dashboard alert are told to look for.
    it('the stall reason is classified rather than ignored by stallClassOf', function () {
        const NOW = 1000000;
        assert.strictEqual(
            stallClassOf('attest_response_sync_barrier', NOW - 900000, 120000, NOW, NOW + 960000),
            'future_block_wait');
        assert.strictEqual(
            stallClassOf('attest_response_sync_barrier', NOW - 900000, 120000, NOW, NOW - 1),
            'wedged');
    });
});
