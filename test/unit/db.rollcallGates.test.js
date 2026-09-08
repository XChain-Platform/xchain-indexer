// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// test/unit/db.rollcallGates.test.js
//
// The three db.js helpers the rules-aware attestation filter rides on
// (attest-zero-confirmation-flip spec §7.3, §7.4, D85, D92): the
// getRollcallGatesForFilter read, the insertRollcallGates write, and the `gates`
// column insertRollcallSigners now carries.
//
// Mock-based (doQuery stubbed), on the pattern of db.rollcalls-public-reads.test.js:
// the unit tier cannot see a database, so the SQL shape and the bound arguments are
// asserted directly against the captured query. That is not a formality here: the
// filter is replay-deterministic ONLY because the epoch is selected by close_block
// rather than by epoch height alone, and that property lives entirely in this SQL.

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

// getTestConfig() returns the config module's single cached object, shared by every
// caller in the process; give each test a shallow copy so a mutation here cannot
// leak into another file run in the same mocha process.
function dbFor(responder) {
    const config = Object.assign({}, getTestConfig());
    config.NETWORK = 'regtest';
    config.COIN    = 'BTC';
    const util = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    const calls = [];
    sinon.stub(db, 'doQuery').callsFake((query, args) => {
        calls.push({ query, args });
        if (responder instanceof Error) return Promise.reject(responder);
        return Promise.resolve(typeof responder === 'function' ? responder(calls.length) : (responder || []));
    });
    db._calls = calls;
    return db;
}

// One epoch row for the first query, then the gate rows for the second.
function twoStep(epochRows, gateRows) {
    return (n) => (n === 1 ? epochRows : gateRows);
}

const PK_A = 'a'.repeat(64);
const PK_B = 'b'.repeat(64);

afterEach(function () { sinon.restore(); });

describe('db.getRollcallGatesForFilter (the rules filter read) @regression @tier1', function () {

    it('selects the rolled epoch by close_block <= and epoch_height >=, in that argument order', async function () {
        const db = dbFor(twoStep([], []));
        await db.getRollcallGatesForFilter(994, 900);
        const q = db._calls[0];
        assert.deepStrictEqual(q.args, [994, 900],
            'buried block first, then the arming height: swapping these silently selects a different epoch');
        assert.ok(/close_block\s*<=\s*\?/.test(q.query), 'the epoch must be bounded by its CLOSE block');
        assert.ok(/epoch_height\s*>=\s*\?/.test(q.query), 'epochs below the arming height must be excluded');
        assert.ok(q.query.indexOf('close_block <= ?') < q.query.indexOf('epoch_height >= ?'),
            'the placeholders must appear in the same order as the bound arguments');
    });

    it('reads only ROLLED epochs, most recent first, one row', async function () {
        const db = dbFor(twoStep([], []));
        await db.getRollcallGatesForFilter(994, 900);
        const q = db._calls[0].query;
        assert.ok(/rolled\s*=\s*1/.test(q),
            'an UNROLLED epoch decides nothing and must never be the filter comparand (spec §7.3)');
        assert.ok(/ORDER BY epoch_height DESC/.test(q));
        assert.ok(/LIMIT 1/.test(q));
        assert.ok(/FROM rollcalls/.test(q), 'the epoch verdict lives in rollcalls, not in rollcall_gates');
    });

    it('returns null and issues NO second query when no epoch qualifies', async function () {
        const db  = dbFor(twoStep([], []));
        const out = await db.getRollcallGatesForFilter(994, 900);
        assert.strictEqual(out, null, 'no rolled epoch means the filter has nothing to compare against');
        assert.strictEqual(db._calls.length, 1, 'the gate rows must not be fetched for an epoch that does not exist');
    });

    it('parses gates_json into a Map keyed by lower-cased pubkey', async function () {
        const db = dbFor(twoStep(
            [{ epoch_height: 960, close_block: 990 }],
            [{ pubkey: PK_A.toUpperCase(), gates_json: JSON.stringify(['m.A', 'm.B']) },
             { pubkey: PK_B,               gates_json: JSON.stringify(['m.A']) }]
        ));
        const out = await db.getRollcallGatesForFilter(994, 900);
        assert.strictEqual(out.epoch_height, 960);
        assert.strictEqual(out.close_block, 990);
        assert.deepStrictEqual(out.gates.get(PK_A), ['m.A', 'm.B'],
            'an upper-cased stored key must still be found by the filter, which lower-cases');
        assert.deepStrictEqual(out.gates.get(PK_B), ['m.A']);
        assert.strictEqual(out.gates.size, 2);
        // The gate rows are fetched for the epoch the FIRST query chose, never for the
        // caller's height: keying them on anything else would read another epoch's lists.
        assert.deepStrictEqual(db._calls[1].args, [960]);
        assert.ok(/FROM rollcall_gates/.test(db._calls[1].query));
    });

    it('a malformed or non-array gates_json reads as an empty list, which the filter drops', async function () {
        const db = dbFor(twoStep(
            [{ epoch_height: 960, close_block: 990 }],
            [{ pubkey: PK_A, gates_json: 'not json at all' },
             { pubkey: PK_B, gates_json: JSON.stringify({ a: 1 }) }]
        ));
        const out = await db.getRollcallGatesForFilter(994, 900);
        assert.deepStrictEqual(out.gates.get(PK_A), []);
        assert.deepStrictEqual(out.gates.get(PK_B), []);
    });

    it('rejects a non-numeric bound without querying at all', async function () {
        const db = dbFor(twoStep([{ epoch_height: 960, close_block: 990 }], []));
        assert.strictEqual(await db.getRollcallGatesForFilter('nope', 900), null);
        assert.strictEqual(await db.getRollcallGatesForFilter(994, null), null);
        assert.strictEqual(db._calls.length, 0);
    });
});

describe('db.insertRollcallGates (the epoch-close write) @regression @tier1', function () {

    it('writes one row per signer as (epoch_height, lower-cased pubkey, close_block, gates JSON array)', async function () {
        const db = dbFor([]);
        const n  = await db.insertRollcallGates(960, 990, [
            { pubkey: PK_A.toUpperCase(), gates: ['m.B', 'm.A'] },
            { pubkey: PK_B,               gates: [] },
        ]);
        assert.strictEqual(n, 2);
        const q = db._calls[0];
        assert.ok(/INSERT INTO rollcall_gates/.test(q.query));
        assert.deepStrictEqual(q.args, [
            960, PK_A, 990, JSON.stringify(['m.B', 'm.A']),
            960, PK_B, 990, JSON.stringify([]),
        ], 'the list is stored as a JSON ARRAY, verbatim and in the order the close verified it');
    });

    it('a missing or non-array gates value stores an empty JSON array, never null', async function () {
        // The filter reads an empty list as "knows no gate" and drops, which is the
        // fail-closed reading; a null would parse to [] anyway but would also break the
        // NOT NULL column contract.
        const db = dbFor([]);
        await db.insertRollcallGates(960, 990, [{ pubkey: PK_A }, { pubkey: PK_B, gates: 'nope' }]);
        assert.strictEqual(db._calls[0].args[3], JSON.stringify([]));
        assert.strictEqual(db._calls[0].args[7], JSON.stringify([]));
    });

    it('writes nothing for an empty or non-array row set, and for a non-numeric epoch', async function () {
        const db = dbFor([]);
        assert.strictEqual(await db.insertRollcallGates(960, 990, []), 0);
        assert.strictEqual(await db.insertRollcallGates(960, 990, null), 0);
        assert.strictEqual(await db.insertRollcallGates('x', 990, [{ pubkey: PK_A, gates: [] }]), 0);
        assert.strictEqual(db._calls.length, 0, 'an unrolled or v0 epoch must leave the table alone');
    });
});

describe('db.insertRollcallSigners carries the gates column @regression @tier1', function () {

    it('passes the signed GATES string as the 8th bound value', async function () {
        const db = dbFor([]);
        await db.insertRollcallSigners([{
            epoch_height: 960, pubkey: PK_A.toUpperCase(), sig: '1'.repeat(128),
            ledger_hash: 'F'.repeat(64), publisher: PK_B.toUpperCase(),
            action_index: 12, block_index: 990, gates: 'm.A,m.B'
        }]);
        const q = db._calls[0];
        assert.ok(/\(epoch_height, pubkey, sig, ledger_hash, publisher, action_index, block_index, gates\)/.test(q.query),
            'the column list must name gates last, matching the value order');
        assert.strictEqual(q.args.length, 8);
        assert.strictEqual(q.args[7], 'm.A,m.B', 'the wire GATES field is stored verbatim, not re-serialized');
        assert.strictEqual(q.args[1], PK_A, 'pubkeys are lower-cased on the way in');
    });

    it('stores NULL for a v0 roll call, which carries no gates field', async function () {
        const db = dbFor([]);
        await db.insertRollcallSigners([{
            epoch_height: 900, pubkey: PK_A, sig: '1'.repeat(128),
            ledger_hash: 'f'.repeat(64), publisher: PK_B, action_index: 3, block_index: 930
        }]);
        assert.strictEqual(db._calls[0].args[7], null,
            'a v0 signer said nothing about gates; an empty string would be a false claim');
    });
});
