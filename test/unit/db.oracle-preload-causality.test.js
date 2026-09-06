/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * test/unit/db.oracle-preload-causality.test.js
 *
 * VM oracle preload causality flag-day (see
 * src/oracle_preload_causality_activation.js). Every read in
 * db.getOracleDataForVM bounds itself on `reference_block <= blockCap` with
 * blockCap taken from the PROCESSING chain's height, while reference_block is a
 * BTC anchor on every row. On LTC and DOGE the local height sits far above any
 * anchor, so the bound matches the whole table and a contract observes rounds
 * the hub finalized AFTER the block it executes in. At/after the activation
 * height each read carries an additional `block_timestamp <= ?` bound; the
 * reference chain is carved out at every height because its own height cap is
 * exact.
 *
 * The gate arm and the inert arm are both driven against the same fake rows:
 * the fake reads the PREDICATES OUT OF THE SQL TEXT and applies the bound
 * arguments positionally, so a read that loses its bound keeps the future round
 * and fails the test rather than being graded against an assumption.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');
const pca               = require('../../src/oracle_preload_causality_activation');

// Two finalized rounds for one pair. Round 2 is anchored 10 BTC blocks later and
// carries a consensus timestamp AFTER the block under test: it is the future
// round the bound exists to exclude.
const BLOCK_TIME  = 1700000300;
const ROWS = [
    { round_number: 1, coin_pair: 'BTC/USD', price: '100', reference_block: 961000, block_timestamp: 1700000000, status: 'finalized' },
    { round_number: 2, coin_pair: 'BTC/USD', price: '200', reference_block: 961010, block_timestamp: 1700000600, status: 'finalized' }
];

// Read `<column> <= ?` / `<column> >= ?` out of the query IN ORDER and zip them
// with the bound arguments, so the fake enforces exactly the predicates the SQL
// carries and nothing the test wishes were there.
function predicatesOf(query, args){
    const bound = [];
    const list  = Array.isArray(args) ? args : [];
    let i = 0;
    for(const m of String(query).matchAll(/(\w+)\s*(<=|>=)\s*\?/g)){
        bound.push({ column: m[1], op: m[2], value: list[i] });
        i++;
    }
    return bound;
}

function matches(row, preds){
    for(const p of preds){
        const v = row[p.column];
        if(v === undefined) continue;                 // column the fixture does not model
        if(p.op === '<=' && !(Number(v) <= Number(p.value))) return false;
        if(p.op === '>=' && !(Number(v) >= Number(p.value))) return false;
    }
    return true;
}

// Answer the four preload reads from ROWS, honouring whatever bounds the SQL
// actually carries.
function answer(query, args){
    const q     = String(query).replace(/\s+/g, ' ');
    const preds = predicatesOf(query, args);
    const rows  = ROWS.filter(r => r.status === 'finalized' && matches(r, preds));

    if(/MAX\(reference_block\) AS latest_block/i.test(q)){
        const max = rows.reduce((a, r) => Math.max(a, r.reference_block), 0);
        return Promise.resolve([{ latest_block: max > 0 ? max : null }]);
    }
    if(/INNER JOIN/i.test(q)){
        const best = new Map();
        for(const r of rows)
            if(!best.has(r.coin_pair) || r.round_number > best.get(r.coin_pair).round_number)
                best.set(r.coin_pair, r);
        return Promise.resolve([...best.values()]);
    }
    if(/SELECT DISTINCT round_number/i.test(q)){
        const seen = [...new Set(rows.map(r => r.round_number))].sort((a, b) => b - a);
        return Promise.resolve(seen.map(round_number => ({ round_number })));
    }
    return Promise.resolve(rows.slice().sort((a, b) => b.round_number - a.round_number));
}

function dbFor(network, coin){
    const config   = getTestConfig();
    config.NETWORK = network;
    config.COIN    = coin;
    const util     = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    const calls = [];
    const record = (query, args) => { calls.push({ query, args }); return answer(query, args); };
    sinon.stub(db, 'doQuery').callsFake(record);
    sinon.stub(db, 'doQueryStrict').callsFake(record);
    db._calls = calls;
    return db;
}

// The four reads of the preload, by the shape that identifies each.
const READS = {
    age:    /MAX\(reference_block\)\s+AS\s+latest_block/i,
    latest: /INNER JOIN/i,
    window: /SELECT DISTINCT round_number/i,
    rounds: /SELECT coin_pair, price, round_number, block_timestamp/i
};

function callFor(db, which){
    const hit = db._calls.find(c => READS[which].test(c.query));
    assert.ok(hit, 'getOracleDataForVM did not emit its ' + which + ' query');
    return hit;
}

afterEach(function(){ sinon.restore(); });

describe('VM oracle preload causality gate (getOracleDataForVM) @regression @tier1', function(){

    describe('behaviour: does the preload admit a round finalized after the block', function(){

        it('INERT arm (LTC mainnet, unarmed): the future round reaches the VM, which is the defect', async function(){
            const db  = dbFor('mainnet', 'LTC');
            // A local LTC height far above every BTC anchor, so `reference_block <= ?`
            // matches both rows and bounds nothing.
            const out = await db.getOracleDataForVM(3154250, BLOCK_TIME, 0);

            assert.strictEqual(out.prices['BTC/USD'].roundNumber, 2,
                'unarmed: getPrice() answers with the round finalized after this block');
            assert.ok(out.rounds['BTC/USD']['2'],
                'unarmed: getPriceAtRound() carries the future round too');
            assert.strictEqual(callFor(db, 'age').args[0], 3154250,
                'unarmed: the age query keeps its armed-but-vacuous height cap');
        });

        it('ARMED arm (LTC regtest, genesis-active): the future round is gone from every view', async function(){
            const db  = dbFor('regtest', 'LTC');
            const out = await db.getOracleDataForVM(3154250, BLOCK_TIME, 0);

            assert.strictEqual(out.prices['BTC/USD'].roundNumber, 1,
                'armed: getPrice() answers with the latest round at/before this block');
            assert.strictEqual(out.prices['BTC/USD'].price, '100');
            assert.ok(out.rounds['BTC/USD']['1'], 'armed: the past round stays readable');
            assert.strictEqual(out.rounds['BTC/USD']['2'], undefined,
                'armed: getPriceAtRound() no longer carries the future round');
            assert.strictEqual(out.snapshotAge, 3154250 - 961000,
                'armed: the age query anchors on the latest round at/before this block');
        });

        it('the age a future row produces is never negative once the bound is armed', async function(){
            const db  = dbFor('regtest', 'LTC');
            const out = await db.getOracleDataForVM(3154250, BLOCK_TIME, 60);
            // maxAge is 60s and round 1 is 300s old, so the tip is stale rather than
            // future-dated; the negative-age case cannot arise because the row that
            // would produce it is excluded before isStale ever sees it.
            assert.ok(out.prices['BTC/USD'] === undefined || out.prices['BTC/USD'].roundNumber === 1,
                'no future-stamped row survives to be measured as fresh');
        });

        it('BTC is unchanged: the exact height cap already excludes the later round', async function(){
            const db  = dbFor('regtest', 'BTC');
            // Reference chain: blockIndex IS a BTC height, so 961005 sits between the
            // two anchors and the height cap does the work with no time bound at all.
            const out = await db.getOracleDataForVM(961005, BLOCK_TIME, 0);

            assert.strictEqual(out.prices['BTC/USD'].roundNumber, 1);
            assert.strictEqual(out.rounds['BTC/USD']['2'], undefined);
            for(const which of Object.keys(READS))
                assert.doesNotMatch(callFor(db, which).query, /block_timestamp <= \?/,
                    which + ': the reference chain must never take the time bound');
        });
    });

    describe('gate: which SQL each of the four reads emits', function(){

        it('armed: ALL FOUR reads carry the time bound, with the block time bound to it', async function(){
            const db = dbFor('regtest', 'DOGE');
            await db.getOracleDataForVM(6319000, BLOCK_TIME, 0);

            for(const which of Object.keys(READS)){
                const c = callFor(db, which);
                assert.match(c.query.replace(/\s+/g, ' '), /block_timestamp <= \?/,
                    which + ': read must carry the consensus-time bound when the gate is armed');
                assert.ok(c.args.includes(BLOCK_TIME),
                    which + ': the block time must be the bound argument');
            }
        });

        it('armed: the height cap is kept alongside the time bound, never swapped out', async function(){
            const db = dbFor('regtest', 'DOGE');
            await db.getOracleDataForVM(6319000, BLOCK_TIME, 0);

            for(const which of ['latest', 'window', 'rounds'])
                assert.match(callFor(db, which).query.replace(/\s+/g, ' '), /reference_block <= \?/,
                    which + ': adding the bound must not remove the existing one (the row set may only shrink)');
        });

        it('inert: every read is byte-identical to the pre-gate call', async function(){
            const db = dbFor('mainnet', 'DOGE');
            await db.getOracleDataForVM(6319000, BLOCK_TIME, 0);

            for(const which of Object.keys(READS)){
                const c = callFor(db, which);
                assert.doesNotMatch(c.query, /block_timestamp <= \?/,
                    which + ': below the height the query text must not change');
                assert.ok(!(c.args || []).includes(BLOCK_TIME),
                    which + ': below the height the arguments must not change');
            }
        });

        it('an unusable block time falls back to the height-capped path', async function(){
            const db = dbFor('regtest', 'LTC');
            await db.getOracleDataForVM(3154250, 'not-a-time', 0);
            for(const which of Object.keys(READS))
                assert.doesNotMatch(callFor(db, which).query, /block_timestamp <= \?/,
                    which + ': no bound is safer than a bound on NaN');
        });
    });

    describe('activation-module predicate', function(){

        it('the reference chain is off at every height on every network', function(){
            assert.strictEqual(pca.isOraclePreloadCausalityActive(0, 'regtest', 'BTC'), false);
            assert.strictEqual(pca.isOraclePreloadCausalityActive(999999999, 'testnet', 'BTC'), false);
            assert.strictEqual(pca.isOraclePreloadCausalityActive(999999999, 'mainnet', 'BTC'), false);
        });

        it('regtest and testnet are genesis-active off the reference chain', function(){
            assert.strictEqual(pca.isOraclePreloadCausalityActive(0, 'regtest', 'LTC'), true);
            assert.strictEqual(pca.isOraclePreloadCausalityActive(0, 'testnet', 'DOGE'), true);
            assert.strictEqual(pca.isOraclePreloadCausalityActive(999999, 'regtest', 'DOGE'), true);
        });

        it('mainnet is UNARMED: the sentinel keeps it inert at any reachable height', function(){
            assert.strictEqual(pca.ORACLE_PRELOAD_CAUSALITY_ACTIVATION.mainnet, 9999999999,
                'arming mainnet is an operator edit, and it changes what contracts read');
            assert.strictEqual(pca.isOraclePreloadCausalityActive(6319000, 'mainnet', 'DOGE'), false);
            assert.strictEqual(pca.isOraclePreloadCausalityActive(3154250, 'mainnet', 'LTC'), false);
            assert.strictEqual(pca.isOraclePreloadCausalityActive(9999999999, 'mainnet', 'LTC'), true,
                'the sentinel is a height, not a disablement: it arms at year 2286');
        });

        it('unknown network or unparseable height is off (keeps deployed behavior)', function(){
            assert.strictEqual(pca.isOraclePreloadCausalityActive(0, 'stagenet', 'LTC'), false);
            assert.strictEqual(pca.isOraclePreloadCausalityActive('nonsense', 'regtest', 'LTC'), false);
            assert.strictEqual(pca.isOraclePreloadCausalityActive(undefined, 'regtest', 'LTC'), false);
        });
    });
});
