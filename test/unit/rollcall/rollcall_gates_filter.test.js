// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// test/unit/rollcall/rollcall_gates_filter.test.js
//
// The rules-aware attestation capability filter, part of the attest zero-confirmation flip,
// and the two call sites that use it:
// the v0 admission reason literal in actions/attest.js and the
// getcapabilityvalidators RPC's height reconstruction in api.js.
//
// ARMING. ROLLCALL_GATES_ACTIVATION resolves XC_ROLLCALL_GATES_REGTEST_ACTIVATION
// exactly ONCE, at require time, and mocha runs every suite in one process, so a
// file that loaded the inert copy first would pin it for us. The armed copy is
// therefore built in a busted require cache in `before` and the cache is put back
// to its inert shape in `after`, so nothing about this file's arming leaks
// sideways into another suite.

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const FILTER_PATH = require.resolve('../../../src/actions/attest/rollcall_gates_filter.js');
const ACTIV_PATH  = require.resolve('../../../src/consensus/gates/rollcall_gates_gate.js');
const ENV_KEY     = 'XC_ROLLCALL_GATES_REGTEST_ACTIVATION';

// The digest and burial seams are deliberately NOT busted: the armed filter must
// share the very instances used here, or `needed` in a test would not be the
// `needed` the filter compared against.
const { activeGatesAt } = require('../../../src/consensus_rules_digest.js');
const srb = require('../../../src/consensus/snapshot_reorg_buffer.js');

function reload(envValue){
    if(envValue === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = envValue;
    delete require.cache[FILTER_PATH];
    delete require.cache[ACTIV_PATH];
    return require(FILTER_PATH);
}

// A db double that records every getRollcallGatesForFilter call and answers with
// whatever the test set. Nothing else on it is reachable from the filter.
function dbDouble(answer){
    const calls = [];
    return {
        calls,
        getRollcallGatesForFilter: async (atOrBelowBlock, minEpochHeight) => {
            calls.push({ atOrBelowBlock, minEpochHeight });
            return (typeof answer === 'function') ? answer(calls.length) : answer;
        }
    };
}

function epochRow(epochHeight, closeBlock, pairs){
    return {
        epoch_height: epochHeight,
        close_block:  closeBlock,
        gates:        new Map(pairs.map(([k, v]) => [String(k).toLowerCase(), v]))
    };
}

const PK_A = 'a'.repeat(64);
const PK_B = 'b'.repeat(64);
const PK_C = 'c'.repeat(64);

// H is a regtest height well above the arming height and above the reorg buffer,
// so the burial arithmetic is the ordinary case rather than the clamp.
const H = 1000;
let armed, ENV_BEFORE, NEEDED;

// Arms the filter for one block of the suite and puts the process-wide cache back
// after it, so every block that asserts a drop runs against the armed copy.
function armFilter(){
    before(function () {
        ENV_BEFORE = process.env[ENV_KEY];
        armed = reload('armed');
        NEEDED = activeGatesAt(H, 'regtest');
        // Guard the whole file: with no gate active at H every subset test is
        // vacuously true and every "drops" assertion below would pass for the wrong
        // reason. regtest arms most of the canon at genesis, so this must hold.
        assert.ok(NEEDED.length > 0,
            'regtest must have at least one gate active at ' + H + ' or this suite proves nothing');
    });

    after(function () {
        // Put the process-wide cache back to the shape every other suite expects.
        reload(ENV_BEFORE);
    });
}

// The two call sites, the v0 admission literal and the getcapabilityvalidators
// source-scan, live beside this file in test/unit/rollcall_gates_filter.test/.
// Every block below repeats the suite title, so each full test title is unchanged.

describe('rollcall_gates_filter: the rules-aware attestation capability filter @regression @tier1', function () {
    armFilter();

    it('is armed for this suite: ROLLCALL_GATES_ACTIVATION.regtest is a finite height', function () {
        const { ROLLCALL_GATES_ACTIVATION } = require(ACTIV_PATH);
        assert.ok(Number.isFinite(ROLLCALL_GATES_ACTIVATION.regtest),
            'the armed reload did not take; every drop assertion below would be a no-op');
    });

    describe('the subset rule', function () {
        it('preserves input ORDER and the full row objects of the survivors', async function () {
            const db = dbDouble(epochRow(960, 990, [
                [PK_A, NEEDED.slice()],
                [PK_B, NEEDED.slice(1)],       // dropped
                [PK_C, NEEDED.slice()],
            ]));
            const rows = [
                { pubkey: PK_C, source: 'S3', weight: '30' },
                { pubkey: PK_B, source: 'S2', weight: '20' },
                { pubkey: PK_A, source: 'S1', weight: '10' },
            ];
            const out = await armed.filterByRolledGates({
                db, validators: rows, requestBlock: H, network: 'regtest' });
            assert.deepStrictEqual(out.map(v => v.pubkey), [PK_C, PK_A], 'order must be the input order');
            assert.deepStrictEqual(out[0], { pubkey: PK_C, source: 'S3', weight: '30' },
                'the whole capability row must survive, weight and source included');
        });
    });
});

describe('rollcall_gates_filter: the rules-aware attestation capability filter @regression @tier1', function () {
    armFilter();

    describe('the subset rule', function () {
        it('keeps a validator whose rolled list is exactly the active set', async function () {
            const db  = dbDouble(epochRow(960, 990, [[PK_A, NEEDED.slice()]]));
            const out = await armed.filterByRolledGates({
                db, validators: [{ pubkey: PK_A }], requestBlock: H, network: 'regtest' });
            assert.deepStrictEqual(out.map(v => v.pubkey), [PK_A]);
        });

        it('keeps a validator whose rolled list is a strict SUPERSET of the active set', async function () {
            // The whole point of the superset rule: a build that knows gates armed after the epoch
            // closed is still a build that knows every gate governing this request.
            const db  = dbDouble(epochRow(960, 990, [[PK_A, NEEDED.concat(['future_module.FUTURE_GATE'])]]));
            const out = await armed.filterByRolledGates({
                db, validators: [{ pubkey: PK_A }], requestBlock: H, network: 'regtest' });
            assert.deepStrictEqual(out.map(v => v.pubkey), [PK_A]);
        });

        it('DROPS a validator missing exactly one active gate', async function () {
            const missingOne = NEEDED.slice(1);
            const db  = dbDouble(epochRow(960, 990, [[PK_A, missingOne]]));
            const stats = {};
            const out = await armed.filterByRolledGates({
                db, validators: [{ pubkey: PK_A }], requestBlock: H, network: 'regtest', stats });
            assert.deepStrictEqual(out, [], 'a list short one active gate must not survive');
            assert.strictEqual(stats.dropped, 1);
            assert.strictEqual(stats.epochHeight, 960);
            assert.strictEqual(stats.closeBlock, 990);
            assert.strictEqual(stats.needed, NEEDED.length);
        });
    });
});

describe('rollcall_gates_filter: the rules-aware attestation capability filter @regression @tier1', function () {
    armFilter();

    describe('the subset rule', function () {
        it('keeps a validator with NO row in the rolled epoch', async function () {
            // Never-rolled and not-yet-rolled are the liveness-eviction rail's problem,
            // so the bootstrap epoch right after arming filters nobody.
            const db  = dbDouble(epochRow(960, 990, [[PK_A, NEEDED.slice()]]));
            const stats = {};
            const out = await armed.filterByRolledGates({
                db, validators: [{ pubkey: PK_B }, { pubkey: PK_C }], requestBlock: H, network: 'regtest', stats });
            assert.deepStrictEqual(out.map(v => v.pubkey), [PK_B, PK_C]);
            assert.strictEqual(stats.dropped, 0);
        });

        it('an EMPTY recorded list is "knows no gate" and is dropped', async function () {
            // db.getRollcallGatesForFilter maps a malformed gates_json to [], and that
            // must read as a drop, never as a pass: a row that exists and names nothing
            // is a positive statement, unlike an absent row.
            const db  = dbDouble(epochRow(960, 990, [[PK_A, []]]));
            const out = await armed.filterByRolledGates({
                db, validators: [{ pubkey: PK_A }], requestBlock: H, network: 'regtest' });
            assert.deepStrictEqual(out, []);
        });

        it('matches the pubkey case-insensitively (rows are stored lower-cased)', async function () {
            const db  = dbDouble(epochRow(960, 990, [[PK_A, NEEDED.slice(1)]]));
            const out = await armed.filterByRolledGates({
                db, validators: [{ pubkey: PK_A.toUpperCase() }], requestBlock: H, network: 'regtest' });
            assert.deepStrictEqual(out, [], 'an upper-cased key must still find its row');
        });
    });
});

describe('rollcall_gates_filter: the rules-aware attestation capability filter @regression @tier1', function () {
    armFilter();

    describe('the documented cost (spec §7.5): a gate armed after the epoch drops the fleet', function () {

        it('every validator with a row is dropped when a newly armed gate is in none of them', async function () {
            // This is the cost the spec states plainly and this row must not paper over:
            // a new gate cannot arm before every validator that should serve has rolled a
            // call naming it, so arming lags the fleet roll by one epoch close. Here the
            // rolled epoch predates the arming, every list is the active set MINUS the new
            // gate, and the whole rolled fleet goes.
            const beforeArming = NEEDED.slice(0, NEEDED.length - 1);
            const db = dbDouble(epochRow(960, 990, [
                [PK_A, beforeArming], [PK_B, beforeArming], [PK_C, beforeArming],
            ]));
            const stats = {};
            const out = await armed.filterByRolledGates({
                db, validators: [{ pubkey: PK_A }, { pubkey: PK_B }, { pubkey: PK_C }],
                requestBlock: H, network: 'regtest', stats });
            assert.deepStrictEqual(out, [], 'the spec §7.5 cost: the whole rolled fleet is dropped');
            assert.strictEqual(stats.dropped, 3);
            // And the operator gets exactly one line naming the count and the epoch.
            const line = armed.formatGatesFilterStats(stats);
            assert.ok(/dropped 3 validator\(s\)/.test(line), 'one summary line, got: ' + line);
            assert.ok(line.indexOf('960') !== -1 && line.indexOf('990') !== -1,
                'the line must name the epoch and its close block, got: ' + line);
        });

        it('formatGatesFilterStats says nothing when nothing was dropped', function () {
            assert.strictEqual(armed.formatGatesFilterStats({ dropped: 0, epochHeight: 960 }), null);
            assert.strictEqual(armed.formatGatesFilterStats(null), null);
        });
    });
});

describe('rollcall_gates_filter: the rules-aware attestation capability filter @regression @tier1', function () {
    armFilter();

    describe('the pass-through cases', function () {

        it('an INERT network never reads the database and returns the same array reference', async function () {
            // mainnet ships ROLLCALL_GATES_ACTIVATION null (testnet is sized at 152208 since
            // D106), and an un-armed network must be byte-for-byte the pre-filter indexer
            // INCLUDING its query count; the admission suite asserts one snapshot query per request.
            const db   = dbDouble(epochRow(960, 990, [[PK_A, []]]));
            const rows = [{ pubkey: PK_A }];
            for(const net of ['mainnet']){
                const out = await armed.filterByRolledGates({
                    db, validators: rows, requestBlock: H, network: net });
                assert.strictEqual(out, rows, net + ': the input array itself must come back');
            }
            assert.strictEqual(db.calls.length, 0, 'an inert network must issue NO query');
        });

        it('an unknown network is inert too', async function () {
            const db   = dbDouble(epochRow(960, 990, [[PK_A, []]]));
            const rows = [{ pubkey: PK_A }];
            const out  = await armed.filterByRolledGates({
                db, validators: rows, requestBlock: H, network: 'nosuchnet' });
            assert.strictEqual(out, rows);
            assert.strictEqual(db.calls.length, 0);
        });

        it('a null epoch (no rolled epoch closed at or below the buried block) keeps everyone', async function () {
            const db  = dbDouble(null);
            const rows = [{ pubkey: PK_A }, { pubkey: PK_B }];
            const out = await armed.filterByRolledGates({
                db, validators: rows, requestBlock: H, network: 'regtest' });
            assert.strictEqual(out, rows, 'the input reference survives so array side-properties do');
            assert.strictEqual(db.calls.length, 1, 'an armed network DOES ask');
        });

        it('an empty validator list short-circuits without a query', async function () {
            const db  = dbDouble(epochRow(960, 990, [[PK_A, []]]));
            const out = await armed.filterByRolledGates({
                db, validators: [], requestBlock: H, network: 'regtest' });
            assert.deepStrictEqual(out, []);
            assert.strictEqual(db.calls.length, 0);
        });

        it('a db without the read helper is a pass-through, not a throw', async function () {
            const rows = [{ pubkey: PK_A }];
            const out  = await armed.filterByRolledGates({
                db: {}, validators: rows, requestBlock: H, network: 'regtest' });
            assert.strictEqual(out, rows);
        });
    });
});

describe('rollcall_gates_filter: the rules-aware attestation capability filter @regression @tier1', function () {
    armFilter();

    describe('determinism and the burial plane', function () {

        it('reads the epoch at the SAME burial the capability snapshot resolves at', async function () {
            const db = dbDouble(null);
            await armed.filterByRolledGates({
                db, validators: [{ pubkey: PK_A }], requestBlock: H, network: 'regtest' });
            assert.strictEqual(db.calls[0].atOrBelowBlock, srb.buriedSnapshotBlock(H, 'regtest'),
                'the filter must bury the request block exactly as computeResponsibleSet does');
            assert.strictEqual(db.calls[0].atOrBelowBlock, H - srb.CANONICAL_REORG_BUFFER,
                'regtest arms burial at genesis, so the buried block is H - 6');
        });

        it('asks only for epochs at or above the arming height', async function () {
            const { ROLLCALL_GATES_ACTIVATION } = require(ACTIV_PATH);
            const db = dbDouble(null);
            await armed.filterByRolledGates({
                db, validators: [{ pubkey: PK_A }], requestBlock: H, network: 'regtest' });
            assert.strictEqual(db.calls[0].minEpochHeight, ROLLCALL_GATES_ACTIVATION.regtest);
        });

        it('is pure: the same inputs give the same answer and the input array is not mutated', async function () {
            const rows = [{ pubkey: PK_A }, { pubkey: PK_B }];
            const mk   = () => dbDouble(epochRow(960, 990, [[PK_A, NEEDED.slice(1)], [PK_B, NEEDED.slice()]]));
            const one  = await armed.filterByRolledGates({ db: mk(), validators: rows, requestBlock: H, network: 'regtest' });
            const two  = await armed.filterByRolledGates({ db: mk(), validators: rows, requestBlock: H, network: 'regtest' });
            assert.deepStrictEqual(one.map(v => v.pubkey), [PK_B]);
            assert.deepStrictEqual(two.map(v => v.pubkey), [PK_B]);
            assert.deepStrictEqual(rows.map(v => v.pubkey), [PK_A, PK_B], 'the caller\'s array must be untouched');
        });

        it('the RPC height reconstruction round-trips: block_index + buffer buries back to block_index', async function () {
            // What api.js getcapabilityvalidators relies on. The hub buries BEFORE it
            // calls, so the RPC's block_index is already buried; the filter buries its
            // own argument, so the RPC must hand it the raw height whose burial is that
            // block_index. If this arithmetic ever stops round-tripping, the hub and the
            // indexer judge the same request at two different heights.
            const buriedFromHub = 994;
            const db = dbDouble(null);
            await armed.filterByRolledGates({
                db, validators: [{ pubkey: PK_A }],
                requestBlock: buriedFromHub + srb.CANONICAL_REORG_BUFFER, network: 'regtest' });
            assert.strictEqual(db.calls[0].atOrBelowBlock, buriedFromHub,
                'the reconstructed height must bury back to exactly the block_index the hub sent');
        });
    });
});
