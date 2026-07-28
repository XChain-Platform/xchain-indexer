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
 * test/unit/db.dispense-native-tick-match.test.js
 *
 * Native-coin DISPENSE trigger must only settle native-priced dispensers
 * (get_tick_id IS NULL). A bare native payment carries no COIN_TICK, so the
 * legacy native branch of findMatchingDispensers left its WHERE unbounded and
 * matched token-priced dispensers too, letting a native payment settle a
 * token-denominated dispenser's escrow against the wrong asset (review #2683).
 *
 * The corrected native predicate (`AND d1.get_tick_id IS NULL`) changes how
 * already-valid blocks evaluate, so it is time-gated on the coordinated 2.0.0
 * flag-day already used by the sibling correction in this same function
 * (dispense_cancelling_match_activation). These tests are mock-based (doQuery
 * stubbed) and lock:
 *   - the GATE: unbounded native branch below the mainnet flag-day (byte-identical
 *     replay), get_tick_id IS NULL predicate at/after;
 *   - testnet/regtest active from genesis (2.0.0-cohort semantics);
 *   - the token-priced path (COIN_TICK present) is unaffected either side.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');
const dcm               = require('../../src/dispense_cancelling_match_activation');

const FLAG_DAY = dcm.DISPENSE_CANCELLING_MATCH_ACTIVATION.mainnet; // 1786924800

// Build a Database with an injected config + a captured doQuery.
function dbFor(network) {
    const config   = getTestConfig();
    config.NETWORK = network;
    config.COIN    = 'BTC';
    const util     = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    const calls = [];
    sinon.stub(db, 'doQuery').callsFake((query, args) => { calls.push({ query, args }); return Promise.resolve([]); });
    // Interning helpers hit the DB to resolve/mint ids; under the stubbed doQuery they
    // would collapse to null. Stub them to isolate the branch-under-test: a real ticker
    // resolves to a non-null id (token path), a null ticker stays null (native path).
    sinon.stub(db, 'createTicker').callsFake((t) => Promise.resolve(util.isNull(t) ? null : 42));
    sinon.stub(db, 'createCoin').callsFake(() => Promise.resolve(1));
    sinon.stub(db, 'createAddress').callsFake(() => Promise.resolve(7));
    db._calls = calls;
    return db;
}

// The main dispenser-match query is the one that joins dispensers d1.
function matchCall(db) {
    const hit = db._calls.find(c => /FROM\s+dispensers d1/.test(c.query));
    assert.ok(hit, 'findMatchingDispensers did not emit its dispenser-match query');
    return { query: hit.query.replace(/\s+/g, ' '), args: hit.args };
}

// Native-coin trigger: no COIN_TICK.
function nativeData(blockTime) {
    return {
        COIN: 'BTC', COIN_TICK: null, COIN_DESTINATION: 'addr1',
        COIN_AMOUNT: '1', BLOCK_TIME: blockTime, BLOCK_INDEX: 100, ACTION_INDEX: 1
    };
}

// Token-SEND trigger: COIN_TICK present.
function tokenData(blockTime) {
    return {
        COIN: 'BTC', COIN_TICK: 'PEPECASH', COIN_DESTINATION: 'addr1',
        COIN_AMOUNT: '10000000', BLOCK_TIME: blockTime, BLOCK_INDEX: 100, ACTION_INDEX: 1
    };
}

afterEach(function () { sinon.restore(); });

describe('DISPENSE native-tick match gate (findMatchingDispensers wrong-asset settlement) @regression @tier1', function () {

    describe('gate: native branch predicate', function () {

        it('mainnet below the flag-day leaves the native branch unbounded (byte-identical replay)', async function () {
            const db = dbFor('mainnet');
            await db.findMatchingDispensers(nativeData(FLAG_DAY - 1));
            const { query, args } = matchCall(db);
            assert.doesNotMatch(query, /d1\.get_tick_id IS NULL/, 'IS NULL predicate must NOT leak below activation');
            assert.doesNotMatch(query, /d1\.get_tick_id=\?/, 'no equality ticker bound on the native path');
            // Legacy arg shape: only [coin_id, destination_id], no ticker arg appended.
            assert.strictEqual(args.length, 2, 'native branch below flag-day binds only coin_id + destination_id');
        });

        it('mainnet at/after the flag-day constrains the native branch to get_tick_id IS NULL', async function () {
            const db = dbFor('mainnet');
            await db.findMatchingDispensers(nativeData(FLAG_DAY));
            const { query, args } = matchCall(db);
            assert.match(query, /d1\.get_tick_id IS NULL/, 'native branch must exclude token-priced dispensers at/after activation');
            assert.doesNotMatch(query, /d1\.get_tick_id=\?/, 'IS NULL predicate takes no bound argument');
            assert.strictEqual(args.length, 2, 'IS NULL predicate adds no argument');
        });

        it('testnet is active from genesis (2.0.0 cohort): native branch constrained even at time 0', async function () {
            const db = dbFor('testnet');
            await db.findMatchingDispensers(nativeData(0));
            const { query } = matchCall(db);
            assert.match(query, /d1\.get_tick_id IS NULL/, 'testnet native branch constrained from genesis');
        });

        it('regtest is active from genesis: native branch constrained even at time 0', async function () {
            const db = dbFor('regtest');
            await db.findMatchingDispensers(nativeData(0));
            const { query } = matchCall(db);
            assert.match(query, /d1\.get_tick_id IS NULL/, 'regtest native branch constrained from genesis');
        });
    });

    describe('token-SEND path (COIN_TICK present) is unaffected by the gate', function () {

        it('mainnet below the flag-day still binds the ticker equality predicate', async function () {
            const db = dbFor('mainnet');
            await db.findMatchingDispensers(tokenData(FLAG_DAY - 1));
            const { query, args } = matchCall(db);
            assert.match(query, /d1\.get_tick_id=\?/, 'token path keeps the equality ticker predicate');
            assert.doesNotMatch(query, /d1\.get_tick_id IS NULL/, 'token path never uses the IS NULL branch');
            assert.strictEqual(args.length, 3, 'token path appends the ticker id argument');
        });

        it('mainnet at/after the flag-day still binds the ticker equality predicate', async function () {
            const db = dbFor('mainnet');
            await db.findMatchingDispensers(tokenData(FLAG_DAY));
            const { query, args } = matchCall(db);
            assert.match(query, /d1\.get_tick_id=\?/, 'token path unchanged at/after activation');
            assert.doesNotMatch(query, /d1\.get_tick_id IS NULL/, 'token path never uses the IS NULL branch');
            assert.strictEqual(args.length, 3, 'token path appends the ticker id argument');
        });
    });
});
