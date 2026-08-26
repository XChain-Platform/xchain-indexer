/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * test/unit/db.dispenser-send-amount-compare.test.js
 *
 * Token-SEND dispense trigger numeric-compare flag-day (see
 * src/dispenser_send_amount_compare_activation.js). findDispenserSends decided
 * affordability with `s1.amount >= d1.get_amount` over two VARCHAR(250)
 * columns, i.e. a lexicographic compare: get_amount '9' against a send of '10'
 * was FALSE, so a legal overpayment produced no DISPENSE at all and the
 * sender's tokens were stranded at the dispenser address. At/after the
 * activation both operands are CAST to DECIMAL(60,18) first.
 *
 * These are mock-based (doQuery stubbed) and lock:
 *   - the GATE: the legacy predicate is emitted BYTE-IDENTICALLY on every
 *     unpinned chain, and the CAST form only where the gate is armed;
 *   - that no caller without block context can be moved onto the new rule;
 *   - the activation-module predicate itself;
 *   - the frozen compare scale against config.MAX_TOKEN_DECIMALS, since a
 *     tick issued finer than the scale would compare lossily.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');
const dsc               = require('../../src/dispenser_send_amount_compare_activation');

// The exact predicate text that shipped before this gate existed, indentation
// included. Emitting anything else on an unpinned chain re-evaluates already
// valid blocks, so this is a byte pin and not a shape check: a reformat of the
// query, or the CAST form leaking below a threshold, fails here.
const LEGACY_PREDICATE_BYTES =
    '                            s1.tick_id=d1.get_tick_id AND\n' +
    '                            s1.amount >= d1.get_amount AND\n' +
    '                            s1.action_index=?';

function dbFor(network, coin) {
    const config   = getTestConfig();
    config.NETWORK = network;
    config.COIN    = coin === undefined ? 'BTC' : coin;
    const util     = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    const calls = [];
    sinon.stub(db, 'doQuery').callsFake((query, args) => { calls.push({ query, args }); return Promise.resolve([]); });
    db._calls = calls;
    return db;
}

function sendsQuery(db) {
    const hit = db._calls.find(c => /FROM\s+sends s1/.test(c.query));
    assert.ok(hit, 'findDispenserSends did not emit its sends query');
    return hit.query;
}

afterEach(function () { sinon.restore(); });

describe('token-SEND dispense affordability compare gate @regression @tier1', function () {

    describe('gate: which predicate is emitted', function () {

        it('BTC mainnet is unpinned, so the legacy predicate is emitted byte-identically', async function () {
            const db = dbFor('mainnet');
            await db.findDispenserSends(1, 5000000);
            const q = sendsQuery(db);
            assert.ok(q.includes(LEGACY_PREDICATE_BYTES),
                'the unpinned chain must emit the pre-gate predicate byte-for-byte');
            assert.doesNotMatch(q, /CAST\(/, 'no CAST may leak onto an unpinned chain');
        });

        it('every mainnet and testnet chain is unpinned today (the gate ships inert)', async function () {
            for (const network of ['mainnet', 'testnet']) {
                for (const coin of ['BTC', 'LTC', 'DOGE']) {
                    const db = dbFor(network, coin);
                    await db.findDispenserSends(1, 999999999);
                    assert.doesNotMatch(sendsQuery(db), /CAST\(/,
                        coin + ':' + network + ' emitted the corrected predicate; this gate must ship inert ' +
                        'on every chain with history, and arming one is a separate coordinated release step');
                    sinon.restore();
                }
            }
        });

        it('regtest is armed at genesis and casts both operands to DECIMAL(60,18)', async function () {
            const db = dbFor('regtest');
            await db.findDispenserSends(1, 0);
            const q = sendsQuery(db).replace(/\s+/g, ' ');
            assert.match(q, /CAST\(s1\.amount AS DECIMAL\(60,18\)\) >= CAST\(d1\.get_amount AS DECIMAL\(60,18\)\)/,
                'the armed chain must compare both operands numerically');
            assert.doesNotMatch(q, /s1\.amount >= d1\.get_amount/,
                'the lexicographic predicate must be gone where the gate is armed');
        });

        it('an absent block index keeps the legacy predicate even on an armed chain', async function () {
            const db = dbFor('regtest');
            await db.findDispenserSends(1);
            assert.ok(sendsQuery(db).includes(LEGACY_PREDICATE_BYTES),
                'a caller with no block context (out-of-band write, API reader) must stay on the legacy rule');
        });

        it('a non-numeric block index keeps the legacy predicate even on an armed chain', async function () {
            const db = dbFor('regtest');
            await db.findDispenserSends(1, 'not-a-height');
            assert.ok(sendsQuery(db).includes(LEGACY_PREDICATE_BYTES));
        });

        it('the rest of the query is untouched on both sides of the gate', async function () {
            const legacy = dbFor('mainnet');
            await legacy.findDispenserSends(7, 5000000);
            const legacyQ = sendsQuery(legacy);
            sinon.restore();
            const armed = dbFor('regtest');
            await armed.findDispenserSends(7, 0);
            const armedQ = sendsQuery(armed);
            // Everything except the one predicate must be identical; if the two
            // differ anywhere else, this splice has widened past its blast radius.
            const normalize = s => s.replace(
                /CAST\(s1\.amount AS DECIMAL\(60,18\)\) >= CAST\(d1\.get_amount AS DECIMAL\(60,18\)\)/,
                's1.amount >= d1.get_amount');
            assert.strictEqual(normalize(armedQ), legacyQ,
                'the gate changed something other than the affordability predicate');
        });
    });

    describe('activation-module predicate', function () {

        it('regtest is active from genesis', function () {
            assert.strictEqual(dsc.isDispenserSendAmountCompareActive(0, 'regtest', 'BTC'), true);
            assert.strictEqual(dsc.isDispenserSendAmountCompareActive(1, 'regtest', null), true);
        });

        it('a null (unpinned) height is inert at every block index', function () {
            for (const height of [0, 1, 963000, Number.MAX_SAFE_INTEGER]) {
                assert.strictEqual(dsc.isDispenserSendAmountCompareActive(height, 'mainnet', 'BTC'), false);
                assert.strictEqual(dsc.isDispenserSendAmountCompareActive(height, 'testnet', 'DOGE'), false);
            }
        });

        it('an unknown network is inert', function () {
            assert.strictEqual(dsc.isDispenserSendAmountCompareActive(0, 'devnet', 'BTC'), false);
            assert.strictEqual(dsc.isDispenserSendAmountCompareActive(0, undefined, undefined), false);
        });

        it('an unparseable block index is inert on an armed chain', function () {
            for (const bad of [null, undefined, '', 'abc', NaN, {}]) {
                assert.strictEqual(dsc.isDispenserSendAmountCompareActive(bad, 'regtest', 'BTC'), false,
                    'block index ' + String(bad) + ' must not arm the gate');
            }
        });

        it('the coin-qualified key wins over the bare network key', function () {
            // regtest is armed by its bare key; a coin-qualified mainnet key is
            // pinned null and must not fall through to it.
            assert.strictEqual(dsc.isDispenserSendAmountCompareActive(0, 'mainnet', 'BTC'), false);
            assert.strictEqual(dsc.isDispenserSendAmountCompareActive(0, 'regtest', 'BTC'), true);
        });

        it('no mainnet or testnet height is pinned in the shipped map', function () {
            for (const [key, height] of Object.entries(dsc.DISPENSER_SEND_AMOUNT_COMPARE_ACTIVATION)) {
                if (key === 'regtest') { assert.strictEqual(height, 0); continue; }
                assert.strictEqual(height, null,
                    key + ' carries a pinned height; arming a chain with history is a coordinated ' +
                    'release step with replay evidence, not a code change');
            }
        });

        it('does not ride an already-passed flag-day', function () {
            // The dispense-cancelling gate armed 2026-08-07, in the past. Hanging this
            // correction on it would arm it retroactively over committed blocks.
            const dcm = require('../../src/dispense_cancelling_match_activation');
            const passed = dcm.DISPENSE_CANCELLING_MATCH_ACTIVATION.mainnet;
            assert.ok(passed, 'expected the sibling gate to carry a mainnet threshold');
            assert.notStrictEqual(dsc.DISPENSER_SEND_AMOUNT_COMPARE_ACTIVATION['BTC:mainnet'], passed);
        });
    });

    describe('frozen compare scale', function () {

        it('is at least the finest precision a tick can be issued with', function () {
            const config = getTestConfig();
            assert.ok(dsc.DISPENSER_SEND_COMPARE_SCALE >= config.MAX_TOKEN_DECIMALS,
                'a tick issued finer than the compare scale would have its amount truncated by the ' +
                'CAST, so two distinct amounts could compare equal on a money gate');
        });

        it('the emitted scale is the frozen constant, not a literal that can drift', function () {
            const armed = dsc.sendAmountComparePredicate(0, 'regtest', 'BTC');
            assert.ok(armed.includes('DECIMAL(60,' + dsc.DISPENSER_SEND_COMPARE_SCALE + ')'));
        });
    });
});
