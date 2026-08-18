/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/db.ledger-amount-precision.test.js
 *
 * CONSENSUS REGRESSION GUARD for the exact-ledger flag-day.
 *
 * db.createLedgerChangeRecord quantized every credit/debit/escrow row to the
 * TICK's own decimals on the way in. Fees are computed at 8 dp, so wherever the
 * gas tick carries fewer decimals the row was rounded half-up while the `fees`
 * table kept the true figure: measured on BTC regtest 2026-08-13, a 0.5 XCHAIN
 * ISSUE_SUBTOKEN fee against a decimals=0 XCHAIN recorded as 0.5 in `fees` and
 * DEBITED as 1, and a one-parent-plus-50-children batch spent 51 XCHAIN instead
 * of the 25.5 the fee schedule charges.
 *
 * The fix stores the amount exactly (18 dp) once the flag is live, and moves
 * every projection to "sum exactly, round ONCE at the tick's scale". These tests
 * pin all four halves of that:
 *   1. the flag itself (regtest armed, mainnet/testnet deliberately unpinned),
 *   2. the write side (exact row when live, legacy quantized row when not),
 *   3. the read side (sum exactly, round once) - unconditional, because it is a
 *      no-op on rows already sitting on the tick's grid,
 *   4. the arithmetic identity that makes the SanityError impossible:
 *      round(C) - round(D) + round(E) is NOT round(C - D + E).
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');
const ledgerPrecision   = require('../../src/ledger_amount_precision_activation');

function makeDb(network, coin) {
    const config = getTestConfig();
    config['NETWORK'] = network || 'regtest';
    config['COIN']    = coin    || 'BTC';
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const indexer = { config, util };
    const db      = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
    db.pool = { getConnection: sinon.stub().resolves({
        query:   sinon.stub().resolves([]),
        release: sinon.stub().resolves()
    }) };
    return db;
}

// Wire up createLedgerChangeRecord's dependencies and capture the INSERT it issues.
// Returns { db, inserted() } where inserted() is the amount string actually written.
function stubLedgerWrite(db, tickDecimals) {
    sinon.stub(db, 'createTicker').resolves(11);
    sinon.stub(db, 'createAddress').resolves(22);
    sinon.stub(db, 'getTokenDecimalPrecision').resolves(tickDecimals);
    const writes = [];
    sinon.stub(db, 'doQuery').callsFake(async (sql, args) => {
        if (/^\s*SELECT/i.test(sql)) return [];          // no existing row -> INSERT branch
        writes.push({ sql, args });
        return [];
    });
    return () => (writes.length ? String(writes[writes.length - 1].args[0]) : null);
}

afterEach(function () { sinon.restore(); });

describe('Exact-ledger flag-day: activation map @regression @tier1', function () {

    it('regtest is armed from genesis (fresh stacks exercise the exact fee path)', function () {
        assert.strictEqual(ledgerPrecision.isLedgerAmountPrecisionActive(0, 'regtest', 'BTC'), true);
        assert.strictEqual(ledgerPrecision.isLedgerAmountPrecisionActive(500000, 'regtest', 'LTC'), true);
    });

    it('mainnet is UNPINNED, so the rule is inert there', function () {
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            assert.strictEqual(
                ledgerPrecision.LEDGER_AMOUNT_PRECISION_ACTIVATION[coin + ':mainnet'], null,
                coin + ':mainnet must stay unpinned until its flag day is measured');
            assert.strictEqual(
                ledgerPrecision.isLedgerAmountPrecisionActive(99999999, 'mainnet', coin), false,
                coin + ':mainnet must not activate at any height while unpinned');
        }
    });

    it('testnet is armed from genesis (ratified 2026-08-18 for the launch)', function () {
        // Safe at 0 only because testnet indexer state is rebuilt from the chain before
        // launch, so no row written under the legacy per-row quantization survives.
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            assert.strictEqual(
                ledgerPrecision.LEDGER_AMOUNT_PRECISION_ACTIVATION[coin + ':testnet'], 0,
                coin + ':testnet must be armed at genesis for the testnet launch');
            assert.strictEqual(
                ledgerPrecision.isLedgerAmountPrecisionActive(0, 'testnet', coin), true,
                coin + ':testnet must activate from the first block');
        }
    });

    it('an absent or unparseable block_index is inert (out-of-band and API callers)', function () {
        assert.strictEqual(ledgerPrecision.isLedgerAmountPrecisionActive(null, 'regtest', 'BTC'), false);
        assert.strictEqual(ledgerPrecision.isLedgerAmountPrecisionActive(undefined, 'regtest', 'BTC'), false);
        assert.strictEqual(ledgerPrecision.isLedgerAmountPrecisionActive('abc', 'regtest', 'BTC'), false);
    });

    it('an unknown network is inert (safe side)', function () {
        assert.strictEqual(ledgerPrecision.isLedgerAmountPrecisionActive(10, 'devnet', 'BTC'), false);
    });

    it('ledgerWriteScale returns the tick scale when inert and 18 when live', function () {
        assert.strictEqual(ledgerPrecision.ledgerWriteScale(0, 100, 'mainnet', 'BTC'), 0);
        assert.strictEqual(ledgerPrecision.ledgerWriteScale(8, 100, 'mainnet', 'BTC'), 8);
        assert.strictEqual(ledgerPrecision.ledgerWriteScale(0, 100, 'regtest', 'BTC'), 18);
        assert.strictEqual(ledgerPrecision.LEDGER_AMOUNT_PRECISION, 18);
    });
});

describe('createLedgerChangeRecord amount quantization @money @regression @tier1', function () {

    it('LIVE: a 0.5 fee against a decimals=0 gas tick is DEBITED as 0.5, not 1', async function () {
        const db = makeDb('regtest', 'BTC');
        const inserted = stubLedgerWrite(db, 0);
        db.blockIndex = 500;
        await db.createLedgerChangeRecord('debits', 900, 'XCHAIN', '0.5', 'bcrt1qpayer');
        assert.strictEqual(inserted(), '0.5',
            'the debited amount must equal the amount recorded in `fees`');
    });

    it('LIVE: 51 batch sub-command fees debit 25.5 in total, not 51', async function () {
        const db = makeDb('regtest', 'BTC');
        const inserted = stubLedgerWrite(db, 0);
        db.blockIndex = 500;
        const util = db.util;
        let total = '0';
        for (let i = 0; i < 51; i++) {
            await db.createLedgerChangeRecord('debits', 900 + i, 'XCHAIN', '0.5', 'bcrt1qpayer');
            total = util.bcstr(util.bcadd(total, inserted(), ledgerPrecision.LEDGER_AMOUNT_PRECISION));
        }
        assert.strictEqual(total, '25.5',
            'one parent plus 50 children costs 25.5 XCHAIN, not 51 (the measured overcharge)');
    });

    it('LEGACY: the same fee on an unpinned chain still rounds to the tick scale', async function () {
        const db = makeDb('mainnet', 'BTC');
        const inserted = stubLedgerWrite(db, 0);
        db.blockIndex = 963000;
        await db.createLedgerChangeRecord('debits', 900, 'XCHAIN', '0.5', 'bc1qpayer');
        assert.strictEqual(inserted(), '1',
            'historical replay must stay byte-identical until the flag day is pinned');
    });

    it('LEGACY: no block context at all falls back to the legacy scale', async function () {
        const db = makeDb('regtest', 'BTC');
        const inserted = stubLedgerWrite(db, 0);
        db.blockIndex = null;
        await db.createLedgerChangeRecord('debits', 900, 'XCHAIN', '0.5', 'bcrt1qpayer');
        assert.strictEqual(inserted(), '1');
    });

    it('LIVE: an amount already on the tick grid is written unchanged (no drift for whole units)', async function () {
        const db = makeDb('regtest', 'BTC');
        const inserted = stubLedgerWrite(db, 0);
        db.blockIndex = 500;
        await db.createLedgerChangeRecord('credits', 900, 'XCHAIN', '600', 'bcrt1qholder');
        assert.strictEqual(inserted(), '600');
    });

    it('LIVE: sub-1e-7 amounts still render in normal notation (the SMT leaf encoder rejects "3e-8")', async function () {
        const db = makeDb('regtest', 'BTC');
        const inserted = stubLedgerWrite(db, 18);
        db.blockIndex = 500;
        await db.createLedgerChangeRecord('credits', 900, 'DEEP', '0.00000003', 'bcrt1qholder');
        assert.strictEqual(inserted(), '0.00000003');
    });
});

describe('Ledger projections: sum exactly, round once @money @regression @tier1', function () {

    it('getAddressCreditDebit accumulates at the exact scale, not the tick scale', async function () {
        const db = makeDb('regtest', 'BTC');
        sinon.stub(db, 'createAddress').resolves(22);
        // 51 debit rows of 0.5 against a decimals=0 tick. The legacy accumulator
        // rounded the RUNNING TOTAL per row and answered 51.
        const rows = [];
        for (let i = 0; i < 51; i++) rows.push({ tick_id: 11, amount: '0.5', decimals: 0 });
        sinon.stub(db, 'doQuery').resolves(rows);
        const out = await db.getAddressCreditDebit('debits', 22);
        assert.strictEqual(db.util.bcstr(out[11]), '25.5');
    });

    it('getAddressCreditDebit is unchanged for rows already on the tick grid', async function () {
        const db = makeDb('regtest', 'BTC');
        sinon.stub(db, 'createAddress').resolves(22);
        sinon.stub(db, 'doQuery').resolves([
            { tick_id: 11, amount: '600', decimals: 0 },
            { tick_id: 11, amount: '1',   decimals: 0 },
            { tick_id: 11, amount: '399', decimals: 0 }
        ]);
        const out = await db.getAddressCreditDebit('credits', 22);
        assert.strictEqual(db.util.bcstr(out[11]), '1000');
    });

    it('getTokenSupply sums at DECIMAL(60,18) and rounds once at the tick scale', async function () {
        const db = makeDb('regtest', 'BTC');
        sinon.stub(db, 'createTicker').resolves(11);
        sinon.stub(db, 'getTokenDecimalPrecision').resolves(0);
        const seen = [];
        const dq = sinon.stub(db, 'doQuery').callsFake(async (sql) => {
            seen.push(sql);
            if (/FROM\s+credits/i.test(sql)) return [{ credits: '1000.5' }];
            if (/FROM\s+debits/i.test(sql))  return [{ debits:  '25.5'   }];
            return [{ escrows: '0' }];
        });
        const supply = await db.getTokenSupply('XCHAIN', null, null);
        assert.strictEqual(String(supply), '975',
            'round(1000.5) - round(25.5) = 975 by luck; the rule is round(1000.5 - 25.5) = 975');
        for (const sql of seen)
            assert.ok(/DECIMAL\(60,18\)/.test(sql), 'every component sum must be taken at the exact scale');
        assert.ok(dq.callCount === 3);
    });

    it('getTokenSupply: per-component rounding would fork the projection, netting first does not', async function () {
        const db = makeDb('regtest', 'BTC');
        sinon.stub(db, 'createTicker').resolves(11);
        sinon.stub(db, 'getTokenDecimalPrecision').resolves(0);
        sinon.stub(db, 'doQuery').callsFake(async (sql) => {
            if (/FROM\s+credits/i.test(sql)) return [{ credits: '1000.4' }];
            if (/FROM\s+debits/i.test(sql))  return [{ debits:  '25.5'   }];
            return [{ escrows: '0' }];
        });
        // Legacy shape: round(1000.4) - round(25.5) = 1000 - 26 = 974.
        // Exact shape:  round(1000.4  -      25.5) = round(974.9) = 975, which is what
        // the balances side (a single exact 974.9 row, rounded once) also reports. The
        // one-unit gap between the two shapes is precisely the SanityError this fixes.
        const supply = await db.getTokenSupply('XCHAIN', null, null);
        assert.strictEqual(String(supply), '975');
        assert.notStrictEqual(String(supply), '974');
    });

    it('getHolders nets each holder at the exact scale', async function () {
        const db = makeDb('regtest', 'BTC');
        sinon.stub(db, 'createTicker').resolves(11);
        sinon.stub(db, 'doQuery').callsFake(async (sql) => {
            if (/FROM\s+credits/i.test(sql)) return [{ address: 'bcrt1qpayer', credits: '1000' }];
            if (/FROM\s+debits/i.test(sql))  return [{ address: 'bcrt1qpayer', debits:  '25.5' }];
            return [];
        });
        const holders = await db.getHolders('XCHAIN', null, null);
        assert.strictEqual(db.util.bcstr(holders['bcrt1qpayer']), '974.5',
            'a holder keeps the fractional remainder rather than losing (or gaining) a whole unit');
    });

    it('getHolders no longer spends a round-trip on the tick decimals it does not use', async function () {
        const db = makeDb('regtest', 'BTC');
        sinon.stub(db, 'createTicker').resolves(11);
        const dec = sinon.stub(db, 'getTokenDecimalPrecision').resolves(0);
        sinon.stub(db, 'doQuery').resolves([]);
        await db.getHolders('XCHAIN', null, null);
        assert.strictEqual(dec.callCount, 0);
    });
});

describe('Exact-ledger projections agree (no SanityError) @money @regression @tier1', function () {

    // The three projections sanityCheck compares, computed the way db.js computes
    // them, over a ledger that carries fee amounts finer than the tick.
    function project(util, creditRows, debitRows, escrowRows, balanceRows, decimals) {
        const exact = ledgerPrecision.LEDGER_AMOUNT_PRECISION;
        const sum = (rows) => rows.reduce((acc, a) => util.bcadd(acc, a, exact), '0');
        const C = sum(creditRows), D = sum(debitRows), E = sum(escrowRows), B = sum(balanceRows);
        return {
            ledger: util.bcstr(util.bcadd(util.bcsub(C, D, exact), E, decimals)),
            total:  util.bcstr(util.bcadd(B, E, decimals))
        };
    }

    it('ledger and balances+escrows agree on a 51-fee batch against a decimals=0 tick', function () {
        const util = new Utility();
        // Payer funded with 1000, charged 51 fees of 0.5 that are BURNED (no credit back),
        // which is the shape that actually moves supply.
        const credits = ['1000'];
        const debits  = new Array(51).fill('0.5');
        const escrows = [];
        // The single surviving balance row is the exact net the ledger implies.
        const balances = [util.bcstr(util.bcsub('1000', util.bcmul('0.5', '51', 18), 18))];
        const p = project(util, credits, debits, escrows, balances, 0);
        assert.strictEqual(p.ledger, p.total, 'ledger and balances+escrows must project identically');
        assert.strictEqual(p.ledger, '975', 'round(1000 - 25.5) = 975, one rounding, once');
    });

    it('the legacy per-component rounding is what breaks the agreement', function () {
        const util = new Utility();
        // Same ledger, but rounded per component the way the code used to.
        const C = '1000.4', D = '25.5', E = '0';
        const legacy = util.bcstr(util.bcadd(util.bcsub(util.bcadd(C, 0, 0), util.bcadd(D, 0, 0), 0), E, 0));
        const exact  = util.bcstr(util.bcadd(util.bcsub(C, D, 18), E, 0));
        assert.strictEqual(legacy, '974');
        assert.strictEqual(exact,  '975');
        assert.notStrictEqual(legacy, exact,
            'round(C) - round(D) + round(E) is NOT round(C - D + E); only the second shape ships');
    });
});
