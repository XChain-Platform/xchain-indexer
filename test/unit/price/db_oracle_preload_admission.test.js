/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 * A commercial license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 * test/unit/price/db_oracle_preload_admission.test.js
 *
 * The VM oracle preload and getLatestPrice time branch bind on a round's signed
 * admission height once the mirror-admission consumer gate is armed for the chain,
 * and on block_timestamp before it. Mainnet is null and BTC is carved out.
 ********************************************************************/

'use strict';

const assert = require('assert');
const sinon  = require('sinon');
const { getTestConfig } = require('../../fixtures/config');
const Utility           = require('../../../src/utility');
const Database          = require('../../../src/db');
const pca               = require('../../../src/db/prices/oracle_preload_causality_gate.js');
const { isMirrorAdmissionConsumerActive } = require('../../../src/consensus/gates/mirror_admission_gate.js');

// Block B is stamped EARLIER than its parent. Round 2 is stamped after B's own time but
// carries a signed admission height at or below B, so by height it is already readable.
// Round 3 is admitted above B. Round 1 is a legacy row with no admission height.
const B_TESTNET_LTC = 4903400;
const BLOCK_TIME    = 1700000300;
const ROWS = [
    { round_number: 1, coin_pair: 'BTC/USD', price: '100', reference_block: 961000, block_timestamp: 1700000000, admit_block_ltc: null,       admit_block_doge: null,        status: 'finalized' },
    { round_number: 2, coin_pair: 'BTC/USD', price: '200', reference_block: 961010, block_timestamp: 1700000600, admit_block_ltc: 4903390,    admit_block_doge: 67940000,    status: 'finalized' },
    { round_number: 3, coin_pair: 'BTC/USD', price: '300', reference_block: 961020, block_timestamp: 1700000100, admit_block_ltc: 4903450,    admit_block_doge: 67940500,    status: 'finalized' }
];

// Evaluate the SQL the way the database would for the columns the fixture models: plain
// `col <=/>= ?` terms in order, and the admission clause as one OR group.
function answer(query, args){
    const q = String(query).replace(/\s+/g, ' ');
    const list = Array.isArray(args) ? args.slice() : [];
    const rows = ROWS.filter(r => {
        let i = /WHERE coin_pair = \?/.test(q) ? 1 : 0;
        let ok = true;
        const re = /\(\((admit_block_\w+) IS NULL AND block_timestamp <= \?\) OR \(\1 IS NOT NULL AND \1 <= \?\)\)|(\w+)\s*(<=|>=)\s*\?/g;
        for(const m of q.matchAll(re)){
            if(m[1]){
                const t = list[i++], h = list[i++];
                const a = r[m[1]];
                if(!((a === null && r.block_timestamp <= t) || (a !== null && a <= h))) ok = false;
            } else {
                const v = list[i++];
                const c = r[m[3]];
                if(c === undefined) continue;
                if(m[4] === '<=' && !(c <= v)) ok = false;
                if(m[4] === '>=' && !(c >= v)) ok = false;
            }
        }
        return ok && r.status === 'finalized';
    });
    if(/INNER JOIN/i.test(q)){
        const best = new Map();
        for(const r of rows) if(!best.has(r.coin_pair) || r.round_number > best.get(r.coin_pair).round_number) best.set(r.coin_pair, r);
        return Promise.resolve([...best.values()]);
    }
    if(/SELECT DISTINCT round_number/i.test(q))
        return Promise.resolve([...new Set(rows.map(r => r.round_number))].sort((a, b) => b - a).map(round_number => ({ round_number })));
    if(/MAX\(reference_block\)/i.test(q))
        return Promise.resolve([{ latest_block: rows.reduce((a, r) => Math.max(a, r.reference_block), 0) || null }]);
    if(/FROM price_snapshots/i.test(q) && /LIMIT 1/.test(q) && !/INNER JOIN/i.test(q) && /ORDER BY round_number DESC LIMIT 1/.test(q) && !/round_number >= \?/.test(q))
        return Promise.resolve(rows.slice().sort((a, b) => b.round_number - a.round_number).slice(0, 1));
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
    sinon.stub(db, 'assertPriceBarrierNotSkipped');
    db._calls = calls;
    return db;
}

afterEach(function(){ sinon.restore(); });

describe('VM oracle preload binds on the signed admission height @regression @tier1', function(){
    describe('flag on: LTC testnet at or above the consumer activation', function(){
        it('a block stamped before its parent reads the round its height admits', async function(){
            const db  = dbFor('testnet', 'LTC');
            const out = await db.getOracleDataForVM(B_TESTNET_LTC, BLOCK_TIME, 0);
            assert.strictEqual(out.prices['BTC/USD'].roundNumber, 2,
                'round 2 is stamped after the block but admitted at a height below it');
            assert.ok(out.rounds['BTC/USD']['2']);
            assert.strictEqual(out.rounds['BTC/USD']['3'], undefined, 'a round admitted above B is excluded');
            assert.ok(out.rounds['BTC/USD']['1'], 'a legacy row with no admission height still binds by time');
        });

        it('the same height selects the same round whatever the block stamp', async function(){
            const a = await dbFor('testnet', 'LTC').getOracleDataForVM(B_TESTNET_LTC, BLOCK_TIME, 0);
            sinon.restore();
            const b = await dbFor('testnet', 'LTC').getOracleDataForVM(B_TESTNET_LTC, BLOCK_TIME - 5000, 0);
            assert.strictEqual(a.prices['BTC/USD'].roundNumber, b.prices['BTC/USD'].roundNumber);
        });

        it('all four preload reads carry the admission clause with the height bound', async function(){
            const db = dbFor('testnet', 'LTC');
            await db.getOracleDataForVM(B_TESTNET_LTC, BLOCK_TIME, 0);
            assert.strictEqual(db._calls.length, 4);
            for(const c of db._calls){
                assert.match(c.query.replace(/\s+/g, ' '),
                    /\(\(admit_block_ltc IS NULL AND block_timestamp <= \?\) OR \(admit_block_ltc IS NOT NULL AND admit_block_ltc <= \?\)\)/);
                assert.ok(c.args.includes(B_TESTNET_LTC) && c.args.includes(BLOCK_TIME));
            }
        });

        it('DOGE binds on its own column', async function(){
            const db = dbFor('testnet', 'DOGE');
            await db.getOracleDataForVM(67940100, BLOCK_TIME, 0);
            for(const c of db._calls) assert.match(c.query, /admit_block_doge IS NOT NULL/);
        });

        it('getLatestPrice time branch binds on the admission height too', async function(){
            const db  = dbFor('testnet', 'LTC');
            const out = await db.getLatestPrice('BTC/USD', B_TESTNET_LTC, { selectByTime: true, blockTime: BLOCK_TIME });
            assert.strictEqual(out.roundNumber, 2);
            assert.deepStrictEqual(db._calls[0].args, ['BTC/USD', BLOCK_TIME, B_TESTNET_LTC]);
            assert.match(db._calls[0].query, /AND \(\(admit_block_ltc IS NULL/);
        });
    });

    describe('flag off: legacy before the activation, null on mainnet, BTC carved out', function(){
        it('below the consumer activation the preload binds on block_timestamp alone', async function(){
            assert.strictEqual(isMirrorAdmissionConsumerActive('LTC', 'testnet', 4903290), false);
            const db  = dbFor('testnet', 'LTC');
            const out = await db.getOracleDataForVM(4903290, BLOCK_TIME, 0);
            assert.strictEqual(out.prices['BTC/USD'].roundNumber, 3,
                'legacy time bound: round 3 is stamped before the block');
            for(const c of db._calls){
                assert.doesNotMatch(c.query, /admit_block/);
                assert.match(c.query, /block_timestamp <= \?/);
            }
        });

        it('mainnet is null: the legacy time bound holds at any height', async function(){
            assert.strictEqual(pca.isOraclePreloadAdmissionActive(999999999, 'mainnet', 'LTC'), false);
            assert.strictEqual(pca.isOraclePreloadAdmissionActive(999999999, 'mainnet', 'DOGE'), false);
            const db = dbFor('mainnet', 'LTC');
            await db.getOracleDataForVM(3154250, BLOCK_TIME, 0);
            for(const c of db._calls) assert.doesNotMatch(c.query, /admit_block/);
        });

        it('BTC never takes the admission clause', async function(){
            assert.strictEqual(pca.isOraclePreloadAdmissionActive(999999999, 'testnet', 'BTC'), false);
            const db = dbFor('testnet', 'BTC');
            await db.getOracleDataForVM(961005, BLOCK_TIME, 0);
            for(const c of db._calls) assert.doesNotMatch(c.query, /admit_block|block_timestamp <= \?/);
        });

        it('an unusable block time emits no bound at all', function(){
            assert.deepStrictEqual(pca.oraclePreloadBound(B_TESTNET_LTC, NaN, 'testnet', 'LTC'), { sql: '', args: [] });
        });
    });
});
