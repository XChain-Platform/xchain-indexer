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
// The snapshot barrier's scope filter, driven against a row set where a row's admission
// height and its effective time select DIFFERENT blocks. The fake mirror below evaluates the
// scope predicate the barrier sends (by reading the SQL and its bindings), so the inert and
// armed arms are told apart by which rows each one puts in scope, not by matching text.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const ARMED_MODULES = [
    '../../../../src/consensus/gates/mirror_admission_gate.js',
    '../../../../src/hub/hub_db_sync/watermarks.js',
    '../../../../src/hub/hub_db_sync.js'
];

function load(armed) {
    const paths    = ARMED_MODULES.map(m => require.resolve(m));
    const saved    = paths.map(p => [p, require.cache[p]]);
    const savedEnv = process.env.XC_MIRROR_ADMISSION_ACTIVATION;
    for (const p of paths) delete require.cache[p];
    if (armed) process.env.XC_MIRROR_ADMISSION_ACTIVATION = '0';
    else delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
    const HubDbSync = require('../../../../src/hub/hub_db_sync.js');
    function restore() {
        for (const [p, mod] of saved) {
            if (mod === undefined) delete require.cache[p]; else require.cache[p] = mod;
        }
        if (savedEnv === undefined) delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
        else process.env.XC_MIRROR_ADMISSION_ACTIVATION = savedEnv;
    }
    return { HubDbSync, restore };
}

// Rows in the mirror. `snap` says whether the row's capability snapshot is mirrored.
//   effective_time and admit_block_btc disagree on purpose:
//   early:  effective_time 500 (<= t) but admitted at 2000 (> B)   -> in scope only when inert
//   late:   effective_time 9000 (> t) but admitted at 900 (<= B)   -> in scope only when armed
//   legacy: effective_time 400, admit_block NULL                   -> in scope in both arms
const T = 1000;
const B = 1000;

function makeMirror(rows) {
    const queries = [];
    const doQuery = async (sql, args) => {
        queries.push({ sql, args });
        const table = sql.includes('cross_chain_matches') ? 'matches' : 'calls';
        const alias = table === 'matches' ? 'm' : 'c';
        const armedSql = sql.includes('admit_block_btc');
        const inScope = (r) => armedSql
            ? (r.admit_block_btc === null ? r.effective_time <= args[0] : r.admit_block_btc <= args[1])
            : r.effective_time <= args[0];
        const hit = rows[table].filter(r => r.status === 'finalized' && inScope(r) && !r.snap);
        assert.ok(sql.includes(alias + '.snapshot_block'));
        return hit.length ? [{ 1: 1 }] : [];
    };
    return { doQuery, queries };
}

function makeSync(HubDbSync, rows) {
    const mirror = makeMirror(rows);
    const sync = new HubDbSync({ doQuery: mirror.doQuery },
        { hubUrl: 'http://hub.test', coin: 'BTC', network: 'regtest' });
    return { sync, mirror };
}

const row = (effective_time, admit_block_btc, snap) =>
    ({ status: 'finalized', effective_time, admit_block_btc, snap });

// One missing-snapshot row per scenario; the row is missing its snapshot, so the barrier is
// unsatisfied exactly when that row is in scope.
const early  = { matches: [row(500, 2000, false)], calls: [] };
const late   = { matches: [row(9000, 900, false)], calls: [] };
const legacy = { matches: [row(400, null, false)], calls: [] };
const lateCall = { matches: [], calls: [row(9000, 900, false)] };

describe('snapshot barrier scope filter, admission height versus effective time', function () {
    describe('inert (no activation)', function () {
        let ctx;
        before(() => { ctx = load(false); });
        after(() => ctx.restore());

        it('scopes by effective_time and never names the admission column', async function () {
            const { sync, mirror } = makeSync(ctx.HubDbSync, early);
            assert.strictEqual(await sync.snapshotSyncSatisfied(T, B), false, 'early row in scope by time');
            assert.ok(!mirror.queries[0].sql.includes('admit_block'), mirror.queries[0].sql);
            assert.deepStrictEqual(mirror.queries[0].args.slice(0, 1), [T]);
        });

        it('a row admitted below B but effective after t(B) is NOT in scope', async function () {
            const { sync } = makeSync(ctx.HubDbSync, late);
            assert.strictEqual(await sync.snapshotSyncSatisfied(T, B), true);
        });
    });

    describe('armed (activation at height 0)', function () {
        let ctx;
        before(() => { ctx = load(true); });
        after(() => ctx.restore());

        it('a row effective before t(B) but admitted after B is NOT in scope', async function () {
            const { sync, mirror } = makeSync(ctx.HubDbSync, early);
            assert.strictEqual(await sync.snapshotSyncSatisfied(T, B), true);
            assert.ok(mirror.queries[0].sql.includes('admit_block_btc'), mirror.queries[0].sql);
        });

        it('a row admitted at or below B but effective after t(B) IS in scope, matches and calls', async function () {
            let r = makeSync(ctx.HubDbSync, late);
            assert.strictEqual(await r.sync.snapshotSyncSatisfied(T, B), false);
            r = makeSync(ctx.HubDbSync, lateCall);
            assert.strictEqual(await r.sync.snapshotSyncSatisfied(T, B), false);
        });

        it('a legacy row with a NULL admission column still binds by effective_time', async function () {
            const { sync } = makeSync(ctx.HubDbSync, legacy);
            assert.strictEqual(await sync.snapshotSyncSatisfied(T, B), false);
            assert.strictEqual(await sync.snapshotSyncSatisfied(100, B), true,
                'a legacy row after t(B) is out of scope');
        });

        it("an unreadable height reads as inert: the legacy time filter, not a coerced height", async function () {
            const { sync, mirror } = makeSync(ctx.HubDbSync, legacy);
            assert.strictEqual(await sync.snapshotSyncSatisfied(T, "nope"), false);
            assert.ok(!mirror.queries[0].sql.includes("admit_block"), mirror.queries[0].sql);
        });
    });

    describe('the same rows and the same (t, B) select different blocks per arm', function () {
        it('early and late flip between the arms', async function () {
            const inert = load(false);
            let inertEarly, inertLate;
            try {
                inertEarly = await makeSync(inert.HubDbSync, early).sync.snapshotSyncSatisfied(T, B);
                inertLate  = await makeSync(inert.HubDbSync, late).sync.snapshotSyncSatisfied(T, B);
            } finally { inert.restore(); }
            const armed = load(true);
            let armedEarly, armedLate;
            try {
                armedEarly = await makeSync(armed.HubDbSync, early).sync.snapshotSyncSatisfied(T, B);
                armedLate  = await makeSync(armed.HubDbSync, late).sync.snapshotSyncSatisfied(T, B);
            } finally { armed.restore(); }
            assert.deepStrictEqual([inertEarly, inertLate, armedEarly, armedLate], [false, true, true, false]);
        });
    });
});
