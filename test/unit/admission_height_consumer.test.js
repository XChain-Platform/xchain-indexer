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
// ── The mirror barrier family, re-keyed onto admission HEIGHT ──
//
// The family's whole claim is one sentence: nothing in a re-keyed barrier's predicate reads
// t(B), so a block stamped 7200 s ahead of wall clock is height B like any other and stops
// holding the block loop for its full distance plus a grace. Every case below is aimed at
// that sentence or at the fail-closed rules that make it safe.
//
// BOTH ARMS RUN, in one default `npm test` invocation and with nothing pending. That is not a
// stylistic choice: every activation map in this train is deliberately INERT, so a default run
// drives only the legacy branch, and the armed branch, which is the one that changes what a
// node commits, would ship undriven. The arming seam is the established one: the activation
// resolver freezes at REQUIRE time (setting process.env afterwards arms nothing, measured),
// so the armed describe clears the require cache for the activation module and every module
// that closed over it, sets the env, re-requires, and restores both the cache and the env
// byte-exact afterwards.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const path   = require('path');

// Every module that closes over the activation resolver at require time.
const ARMED_MODULES = [
    '../../src/mirror_admission_activation.js',
    '../../src/anchor_reward_activation.js',
    '../../src/hub/hub_db_sync.js',
    '../../src/XChainIndexer.js'
];

const ARMED_AT = 0;                 // the regtest armed form resolves to height 0
const B        = 1000;              // the block being processed, on this indexer's own chain

function armModules() {
    const paths    = ARMED_MODULES.map(m => require.resolve(m));
    const saved    = paths.map(p => [p, require.cache[p]]);
    const savedEnv = process.env.XC_MIRROR_ADMISSION_ACTIVATION;
    for (const p of paths) delete require.cache[p];
    process.env.XC_MIRROR_ADMISSION_ACTIVATION = String(ARMED_AT);

    const act        = require('../../src/mirror_admission_activation.js');
    const HubDbSync  = require('../../src/hub/hub_db_sync.js');
    const Indexer    = require('../../src/XChainIndexer.js');

    // Put the process back exactly as it was found. The modules captured above keep the armed
    // activation they closed over, so arming is scoped to this file rather than to the run.
    function restore() {
        for (const [p, mod] of saved) {
            if (mod === undefined) delete require.cache[p]; else require.cache[p] = mod;
        }
        if (savedEnv === undefined) delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
        else process.env.XC_MIRROR_ADMISSION_ACTIVATION = savedEnv;
    }
    return { act, HubDbSync, Indexer, restore };
}

// A mirror with a hub URL and a hub DB, so `enabled` is true, on BTC regtest.
function makeSync(HubDbSync, opts) {
    const doQuery = sinon.stub().resolves([]);
    const sync = new HubDbSync({ doQuery }, Object.assign(
        { hubUrl: 'http://hub.test', coin: 'BTC', network: 'regtest' }, opts || {}));
    // Every barrier's bootstrapped flag: the empty-mirror escapes are a separate question and
    // are not what these cases are about.
    sync.priceBootstrapped = sync.oracleBootstrapped = sync.matchBootstrapped =
        sync.callBootstrapped = sync.bridgeBootstrapped = sync.policyBootstrapped = true;
    sync.oracleSyncTimestamp = 1;   // a non-null scalar, so the empty-mirror escape is closed
    sync.matchSyncTimestamp  = 1;
    sync.callSyncTimestamp   = 1;
    sync.bridgeSyncTimestamp = 1;
    sync.policySyncTimestamp = 1;
    return { sync, doQuery };
}

// Install one height map, the way a heartbeat frame delivers it.
function heights(sync, map) {
    sync.noteHeights(map);
}

let armed = null;

function setupArmedModules() { armed = armModules(); }
function restoreArmedModules() { if (armed) armed.restore(); armed = null; }
const ARMED_TITLE = 'mirror-admission height barriers: ARMED @regression @tier1';
function describeArmed(register) {
    describe(ARMED_TITLE, function () { before(setupArmedModules); after(restoreArmedModules); register(); });
}

describeArmed(function () {
    it('the arming seam actually arms (otherwise every case below is vacuous)', function () {
        assert.strictEqual(armed.act.isMirrorAdmissionConsumerActive('BTC', 'regtest', B), true);
        assert.strictEqual(armed.act.isMirrorAdmissionProducerActive('BTC', 'regtest', B), true);
        // and it is still INERT off regtest, which is what keeps testnet and mainnet on the
        // legacy rule until their heights are sized at the cut.
        assert.strictEqual(armed.act.isMirrorAdmissionConsumerActive('BTC', 'testnet', B), false);
        assert.strictEqual(armed.act.isMirrorAdmissionConsumerActive('BTC', 'mainnet', B), false);
    });

    // THE HEADLINE. This is the whole spec in one assertion: a block stamped two hours into
    // the future, a stream watermark that has not reached it and cannot for 7200 s, and a
    // barrier that opens anyway because the evidence it now reads is a HEIGHT.
    it('a +7200 future-stamped block does NOT hold when the height watermark covers it', function () {
        const { sync } = makeSync(armed.HubDbSync);
        const now = Math.floor(Date.now() / 1000);
        const futureStamp = now + 7200;
        sync.streamWatermark = now;                       // wall clock, 7200 s short of the stamp
        heights(sync, {
            price_snapshots:            { BTC: B - 4 },
            oracle_prices:              { BTC: B - 1 },
            cross_chain_matches:        { BTC: B - 4 },
            cross_chain_calls:          { BTC: B - 4 },
            bridge_transfers:           { BTC: B - 4 },
            policy_snapshots:           { BTC: B - 4 },
            attestation_responses:      { BTC: B - 1 },
            anchor_reward_attestations: { BTC: B - 144 }
        });
        assert.strictEqual(sync._priceSyncSatisfied(B, futureStamp), true, 'price height');
        assert.strictEqual(sync._priceTimeSyncSatisfied(futureStamp, B), true, 'price time');
        assert.strictEqual(sync.oracleSyncSatisfied(futureStamp, B), true, 'oracle');
        assert.strictEqual(sync.matchSyncSatisfied(futureStamp, B), true, 'match');
        assert.strictEqual(sync.callSyncSatisfied(futureStamp, B), true, 'call');
        assert.strictEqual(sync.bridgeSyncSatisfied(futureStamp, B), true, 'bridge');
        assert.strictEqual(sync.policySyncSatisfied(futureStamp, B), true, 'policy');
        assert.strictEqual(sync.attestResponseSyncSatisfied(futureStamp, B), true, 'attest response');
        assert.strictEqual(sync.anchorAttestSyncSatisfied(futureStamp, null, B), true, 'anchor attest');
    });
});

// The mirror image, and the one that proves the predicate is not simply permissive: the
// clock is IRRELEVANT, not merely insufficient. A watermark far past blockTime + every
// grace satisfies nothing while the height evidence is absent.
describeArmed(function () {
    it('a stream watermark past blockTime + grace no longer satisfies a re-keyed barrier', function () {
        const { sync } = makeSync(armed.HubDbSync);
        sync.streamWatermark = 10 ** 9;                   // decades past any grace
        heights(sync, {});                                 // published, and empty
        assert.strictEqual(sync._priceSyncSatisfied(B, 1000), false, 'price height');
        assert.strictEqual(sync._priceTimeSyncSatisfied(1000, B), false, 'price time');
        assert.strictEqual(sync.oracleSyncSatisfied(1000, B), false, 'oracle');
        assert.strictEqual(sync.matchSyncSatisfied(1000, B), false, 'match');
        assert.strictEqual(sync.callSyncSatisfied(1000, B), false, 'call');
        assert.strictEqual(sync.bridgeSyncSatisfied(1000, B), false, 'bridge');
        assert.strictEqual(sync.policySyncSatisfied(1000, B), false, 'policy');
        assert.strictEqual(sync.attestResponseSyncSatisfied(1000, B), false, 'attest response');
    });

    it('the per-table margin is the one the canon names, at the exact boundary', function () {
        const { sync } = makeSync(armed.HubDbSync);
        sync.streamWatermark = 0;
        // Each table's entry sits EXACTLY at B - margin: one less and the barrier holds.
        heights(sync, {
            cross_chain_matches:        { BTC: B - 4 },     // default margin
            oracle_prices:              { BTC: B - 1 },     // 1: effective_at stays the economic filter
            attestation_responses:      { BTC: B - 1 },     // 1: the forward margin is deliberately short
            anchor_reward_attestations: { BTC: B - 144 }    // 144: the frozen maturity
        });
        assert.strictEqual(sync.matchSyncSatisfied(1, B), true);
        assert.strictEqual(sync.oracleSyncSatisfied(1, B), true);
        assert.strictEqual(sync.attestResponseSyncSatisfied(1, B), true);
        assert.strictEqual(sync.anchorAttestSyncSatisfied(1, null, B), true);

        heights(sync, {
            cross_chain_matches:        { BTC: B - 5 },
            oracle_prices:              { BTC: B - 2 },
            attestation_responses:      { BTC: B - 2 },
            anchor_reward_attestations: { BTC: B - 145 }
        });
        assert.strictEqual(sync.matchSyncSatisfied(1, B), false, 'match margin is 4, not 5');
        assert.strictEqual(sync.oracleSyncSatisfied(1, B), false, 'oracle margin is 1, not 2');
        assert.strictEqual(sync.attestResponseSyncSatisfied(1, B), false, 'attest response margin is 1');
        assert.strictEqual(sync.anchorAttestSyncSatisfied(1, null, B), false, 'anchor margin is 144, not 145');
    });
});

// FAIL-CLOSED BY ABSENCE, at every granularity the seam names.
describeArmed(function () {
    it('every shape of missing evidence defers, and none of them reads as zero', function () {
        const { sync } = makeSync(armed.HubDbSync);
        sync.streamWatermark = 10 ** 9;
        const cases = [
            ['never served',        undefined],
            ['not an object',       42],
            ['an array',            [{ BTC: B }]],
            ['empty object',        {}],
            ['missing table key',   { cross_chain_calls: { BTC: B } }],
            ['missing chain key',   { cross_chain_matches: { DOGE: B } }],
            ['a string height',     { cross_chain_matches: { BTC: String(B) } }],
            ['a negative height',   { cross_chain_matches: { BTC: -1 } }],
            ['a non-finite height', { cross_chain_matches: { BTC: NaN } }],
            ['a fractional height', { cross_chain_matches: { BTC: 999.5 } }],
            ['boolean true',        { cross_chain_matches: { BTC: true } }],
            ['null',                { cross_chain_matches: { BTC: null } }]
        ];
        for (const [label, map] of cases) {
            heights(sync, map);
            assert.strictEqual(sync.matchSyncSatisfied(1, B), false, label + ' must defer');
        }
    });

    it('a chain key is matched case-insensitively but never coerced', function () {
        const { sync } = makeSync(armed.HubDbSync);
        heights(sync, { cross_chain_matches: { btc: B } });
        assert.strictEqual(sync.matchSyncSatisfied(1, B), true, 'a lower-case chain key is the same chain');
        assert.deepStrictEqual(sync.heightWatermarks.cross_chain_matches, { BTC: B });
    });
});

// The one member that keeps BOTH certificates, and the reason it must: its height
// watermark can be held for up to 6 h by one stuck DOGE anchor, which is WORSE than the
// clock it replaces, so the clock form stays as a floor and either one releases the block.
describeArmed(function () {
    describe('the anchor-attest member keeps both certificates', function () {
        it('the height rule releases a block the clock form would still hold', function () {
            const { sync } = makeSync(armed.HubDbSync);
            sync.streamWatermark = 0;                     // the clock certifies nothing at all
            heights(sync, { anchor_reward_attestations: { BTC: B - 144 } });
            assert.strictEqual(sync.anchorAttestSyncSatisfied(1000, null, B), true);
        });

        it('the clock form releases a block a stuck height watermark would still hold', function () {
            const { sync } = makeSync(armed.HubDbSync);
            sync.streamWatermark = 1000 + sync.anchorAttestWatermarkGraceS;
            heights(sync, { anchor_reward_attestations: { BTC: 0 } });   // frozen far behind
            assert.strictEqual(sync.heightSatisfied('anchor_reward_attestations', B), false,
                'the height half is genuinely unsatisfied');
            assert.strictEqual(sync.anchorAttestSyncSatisfied(1000, null, B), true,
                'a queued DOGE anchor must not make this barrier hold a block the clock released');
        });

        it('neither certificate means the block still defers', function () {
            const { sync } = makeSync(armed.HubDbSync);
            sync.streamWatermark = 0;
            heights(sync, { anchor_reward_attestations: { BTC: 0 } });
            assert.strictEqual(sync.anchorAttestSyncSatisfied(1000, null, B), false);
        });
    });
});

// The attest-response member is the opposite trade: no escape of any kind, so above the
// activation the height rule REPLACES the clock rather than joining it.
describeArmed(function () {
    it('the attest-response member is stricter above the activation, not looser', function () {
        const { sync } = makeSync(armed.HubDbSync);
        sync.streamWatermark = 1000 + sync.attestResponseWatermarkGraceS;   // clock satisfied
        heights(sync, { attestation_responses: { BTC: 0 } });
        assert.strictEqual(sync.attestResponseSyncSatisfied(1000, B), false,
            'the clock escape is retired for this member above the activation');
    });

    it('a height advance releases waiters without waiting for a seconds advance', async function () {
        const { sync } = makeSync(armed.HubDbSync);
        sync.streamWatermark = 0;
        heights(sync, { attestation_responses: { BTC: 0 } });
        const pending = sync.waitForAttestationResponseSync(1000, 2000, B);
        assert.strictEqual(sync._attestResponseWaiters.length, 1, 'the block waits');
        // A frame carrying only a height advance: streamWatermark never moves.
        sync.noteHeights({ attestation_responses: { BTC: B - 1 } });
        await pending;
        assert.strictEqual(sync._attestResponseWaiters.length, 0, 'waiter cleared by the height advance alone');
        assert.strictEqual(sync.streamWatermark, 0, 'and the seconds watermark never moved');
    });

    it('a timed-out barrier names the height it was short of', async function () {
        const { sync } = makeSync(armed.HubDbSync);
        sync.streamWatermark = 0;
        heights(sync, { attestation_responses: { BTC: 7 } });
        await assert.rejects(
            sync.waitForAttestationResponseSync(1000, 30, B),
            (err) => {
                // The prefix is byte-identical to what it has always been: an operator greps it.
                assert.ok(err.message.startsWith('attestation response mirror barrier timed out after 30ms ' +
                    'waiting for block_time 1000 (stream watermark at 0)'), err.message);
                assert.ok(err.message.includes('admission height attestation_responses.BTC at 7, needs 999'),
                    err.message);
                return true;
            });
    });
});

// The snapshot member never stalls on a stamp, but its SCOPE filter is t(B), and a
// node filtering snapshots by time while binding matches by height disagrees with its own
// match set. That is a fork, not a stall, which is why the filter moves in this change.
describeArmed(function () {
    describe('the snapshot barrier\'s scope filter moves with members 4 and 5', function () {
        it('uses the IS NULL OR form on the admission column, never a bare comparison', async function () {
            const { sync, doQuery } = makeSync(armed.HubDbSync);
            doQuery.resolves([]);
            heights(sync, {});
            await sync._snapshotSyncSatisfied(1000, B);
            const sql = doQuery.getCall(0).args[0];
            const args = doQuery.getCall(0).args[1];
            assert.ok(sql.includes('m.admit_block_btc IS NULL AND m.effective_time <= ?'), sql);
            assert.ok(sql.includes('m.admit_block_btc IS NOT NULL AND m.admit_block_btc <= ?'), sql);
            // The trap, stated as an assertion: a bare `admit_block_btc <= ?` evaluates to NULL
            // for every legacy row and silently drops it from the scope.
            assert.ok(!/WHERE m\.status = 'finalized' AND \(m\.admit_block_btc <= \?/.test(sql), sql);
            assert.deepStrictEqual(args.slice(0, 2), [1000, B],
                'the time bound binds the legacy leg and B binds the admission leg');
        });

        it('fails closed when B is unreadable rather than filtering on a coerced height', async function () {
            const { sync, doQuery } = makeSync(armed.HubDbSync);
            // Armed at height 0, so an unreadable B cannot even reach the predicate through the
            // activation; drive the guard directly with an armed-but-unreadable pair.
            assert.strictEqual(await sync._snapshotSyncSatisfied(1000, 'not-a-height'), true,
                'an unreadable B is INERT, which is the legacy rule, not an admission filter');
            const sql = doQuery.getCall(0).args[0];
            assert.ok(sql.includes("m.effective_time <= ?"), sql);
            assert.ok(!sql.includes('admit_block'), 'the legacy filter carries no admission column: ' + sql);
        });
    });
});

// The null is what makes the stall measurable: with a clear instant reported,
// nextBarrierHold() refuses to accumulate and the 900 s ceiling can never fire.
describeArmed(function () {
    it('a re-keyed barrier reports NO stallClearsAt, so a hold accumulates', function () {
        const idx = Object.create(armed.Indexer.prototype);
        idx.config = { COIN: 'BTC', NETWORK: 'regtest' };
        idx.hubDbSync = { matchWatermarkGraceS: 120, anchorAttestWatermarkGraceS: 120 };
        assert.strictEqual(idx.barrierClearsAtHeightAware(1000, 'matchWatermarkGraceS', B), null);
        assert.strictEqual(idx.anchorBarrierClearsAt(1000, 900, B, 'anchorAttestWatermarkGraceS'), null);
        // On a chain the map does not arm, the clock instant is reported exactly as before.
        idx.config = { COIN: 'BTC', NETWORK: 'mainnet' };
        assert.strictEqual(idx.barrierClearsAtHeightAware(1000, 'matchWatermarkGraceS', B), 1120000);
    });

    it('mirrorStatus reports the height watermark beside the seconds one', function () {
        const { sync } = makeSync(armed.HubDbSync);
        heights(sync, { cross_chain_matches: { BTC: 990 } });
        assert.strictEqual(sync.matchSyncSatisfied(1, B), false);     // records a shortfall
        const status = sync.mirrorStatus();
        assert.deepStrictEqual(status.heights, { cross_chain_matches: { BTC: 990 } });
        assert.deepStrictEqual(status.heightShortfalls, { 'cross_chain_matches|BTC': 996 });
        assert.ok(status.heightsFrozenMs !== null, 'a map has been installed, so the age is a number');
    });
});

describe('mirror-admission height barriers: UNARMED (today\'s rule, byte for byte) @regression @tier1', function () {
    const HubDbSync = require('../../src/hub/hub_db_sync.js');

    it('is INERT on every network in this train, so nothing below the cut changes', function () {
        const act = require('../../src/mirror_admission_activation.js');
        for (const net of ['mainnet', 'testnet', 'regtest']) {
            assert.strictEqual(act.isMirrorAdmissionConsumerActive('BTC', net, B), false, net);
        }
    });

    it('the clock escape still satisfies every member, with no height evidence at all', function () {
        const { sync } = makeSync(HubDbSync);
        sync.streamWatermark = 1000 + 4800;                 // past the largest grace
        assert.deepStrictEqual(sync.heightWatermarks, {}, 'no heights map, and none needed');
        assert.strictEqual(sync._priceSyncSatisfied(B, 1000), true);
        assert.strictEqual(sync._priceTimeSyncSatisfied(1000, B), true);
        assert.strictEqual(sync.oracleSyncSatisfied(1000, B), true);
        assert.strictEqual(sync.matchSyncSatisfied(1000, B), true);
        assert.strictEqual(sync.callSyncSatisfied(1000, B), true);
        assert.strictEqual(sync.bridgeSyncSatisfied(1000, B), true);
        assert.strictEqual(sync.policySyncSatisfied(1000, B), true);
        assert.strictEqual(sync.attestResponseSyncSatisfied(1000, B), true);
        assert.strictEqual(sync.anchorAttestSyncSatisfied(1000, null, B), true);
    });

    it('a height map that would satisfy nothing cannot make an unarmed barrier defer', function () {
        const { sync } = makeSync(HubDbSync);
        sync.streamWatermark = 1000 + 4800;
        sync.noteHeights({ cross_chain_matches: { BTC: 0 } });
        assert.strictEqual(sync.matchSyncSatisfied(1000, B), true,
            'below the activation the heights object is not read at all');
    });

    it('the snapshot filter is the byte-identical effective_time comparison', async function () {
        const { sync, doQuery } = makeSync(HubDbSync);
        doQuery.resolves([]);
        await sync._snapshotSyncSatisfied(1000, B);
        const sql = doQuery.getCall(0).args[0];
        assert.ok(sql.includes("WHERE m.status = 'finalized' AND (m.effective_time <= ?)"), sql);
        assert.ok(!sql.includes('admit_block'), sql);
        assert.deepStrictEqual(doQuery.getCall(0).args[1], [1000, 'BTC', 'BTC']);
    });

    it('stallClearsAt keeps naming the clock instant below the activation', function () {
        const Indexer = require('../../src/XChainIndexer.js');
        const idx = Object.create(Indexer.prototype);
        idx.config = { COIN: 'BTC', NETWORK: 'regtest' };
        idx.hubDbSync = { matchWatermarkGraceS: 120 };
        assert.strictEqual(idx.barrierClearsAtHeightAware(1000, 'matchWatermarkGraceS', B), 1120000);
    });
});
