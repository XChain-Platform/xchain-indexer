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
 * test/regression/ledger_amount_precision_activation.test.js
 *
 * INCIDENT: XC-1459, the exact-ledger flag-day.
 *
 * db.createLedgerChangeRecord quantized every credit / debit / escrow row to
 * the TICK's own decimals on the way in. Fees are computed at 8 dp, so on a
 * gas tick issued with fewer decimals the ROW rounded half-up while the `fees`
 * table kept the true figure. Measured on BTC regtest 2026-08-13: a 0.5 XCHAIN
 * ISSUE_SUBTOKEN fee against a decimals=0 XCHAIN was recorded as 0.5 and
 * DEBITED as 1, and one parent plus 50 children spent 51 XCHAIN instead of the
 * 25.5 the fee schedule charges.
 *
 * `test/unit/db.ledger-amount-precision.test.js` guards the db.js call sites.
 * THIS file guards the flag module itself: the three values a silent edit
 * could move without any db test noticing, because db.js reads all three from
 * here rather than restating them.
 *
 *   1. LEDGER_AMOUNT_PRECISION = 18. It is the scale ledger rows are stored at
 *      once the rule is live AND the scale getNetBalance / getAddressBalances
 *      net in. Lowering it re-introduces the overcharge at a finer tick;
 *      raising it puts rows past DECIMAL(60,18) and past MAX_TOKEN_DECIMALS.
 *   2. The SQL `exactSumSql` emits, byte for byte. Its DECIMAL(60,18) is what
 *      makes the read side "sum exactly, round once"; a scale drift there is a
 *      consensus-visible change to every supply and holder projection.
 *   3. The activation map's UNPINNED nulls. mainnet and testnet carry a
 *      DEFINED null on purpose: below any threshold, inert, historical replay
 *      byte-identical. Turning any of them into a number arms a fee-arithmetic
 *      flag day on a live chain and moves balances_root.
 *
 * Every assertion below pins a literal value or a threshold edge; none of them
 * re-derives its expectation from the module it is guarding.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const Utility         = require('../../src/utility');
const ledgerPrecision = require('../../src/ledger_amount_precision_activation');

describe('[regression:p0] XC-1459 exact-ledger flag module @money @regression @tier1', function () {

    describe('the exact scale is a pinned constant, not a tunable', function () {
        it('LEDGER_AMOUNT_PRECISION is exactly 18', function () {
            assert.strictEqual(ledgerPrecision.LEDGER_AMOUNT_PRECISION, 18);
        });
    });

    describe('exactSumSql emits the read-side projection SQL byte for byte', function () {
        it('wraps the column in SUM(CAST(... AS DECIMAL(60,18)))', function () {
            assert.strictEqual(
                ledgerPrecision.exactSumSql('m.amount'),
                'SUM(CAST(m.amount AS DECIMAL(60,18)))');
        });

        it('carries the scale for any column name, including the bare ones db.js passes', function () {
            assert.strictEqual(
                ledgerPrecision.exactSumSql('amount'),
                'SUM(CAST(amount AS DECIMAL(60,18)))');
        });
    });

    describe('activation map: the unpinned chains stay unpinned', function () {
        it('has exactly the six coin-qualified live keys plus the bare regtest key', function () {
            // The bare `regtest` key is load-bearing: regtest carries no
            // coin-qualified entry, so it is reached through the network-key
            // fallback. A coin-qualified regtest key added here would shadow it
            // per-coin and silently disarm the chains it was not added for.
            assert.deepStrictEqual(
                Object.keys(ledgerPrecision.LEDGER_AMOUNT_PRECISION_ACTIVATION).sort(),
                ['BTC:mainnet', 'BTC:testnet', 'DOGE:mainnet', 'DOGE:testnet',
                 'LTC:mainnet', 'LTC:testnet', 'regtest']);
        });

        it('every mainnet and testnet entry is a DEFINED null (present, deliberately inert)', function () {
            for (const key of ['BTC:mainnet', 'LTC:mainnet', 'DOGE:mainnet',
                               'BTC:testnet', 'LTC:testnet', 'DOGE:testnet']) {
                assert.ok(key in ledgerPrecision.LEDGER_AMOUNT_PRECISION_ACTIVATION,
                    key + ' must stay in the map so its null shadows the bare network key');
                assert.strictEqual(ledgerPrecision.LEDGER_AMOUNT_PRECISION_ACTIVATION[key], null,
                    key + ' must stay unpinned until its flag day is measured and ratified');
            }
        });

        it('regtest is armed at height 0', function () {
            assert.strictEqual(ledgerPrecision.LEDGER_AMOUNT_PRECISION_ACTIVATION.regtest, 0);
        });
    });

    describe('threshold edges', function () {
        it('regtest is inert one block BELOW its threshold and live AT it', function () {
            assert.strictEqual(ledgerPrecision.isLedgerAmountPrecisionActive(-1, 'regtest', 'BTC'), false);
            assert.strictEqual(ledgerPrecision.isLedgerAmountPrecisionActive(0, 'regtest', 'BTC'), true,
                'the gate is inclusive at the flag-day height');
        });

        it('a coin with no map entry falls through to the bare network key, and mainnet has none', function () {
            // The fallback must not invent an activation for a coin nobody pinned:
            // ZEC:mainnet is absent, the bare `mainnet` key is absent too, so the
            // answer is inert at any height rather than "whatever regtest says".
            assert.strictEqual(ledgerPrecision.isLedgerAmountPrecisionActive(99999999, 'mainnet', 'ZEC'), false);
            assert.strictEqual(ledgerPrecision.isLedgerAmountPrecisionActive(99999999, 'mainnet'), false);
        });
    });

    describe('ledgerWriteScale is what actually carried the overcharge', function () {
        it('hands back the tick scale while inert and 18 once live', function () {
            assert.strictEqual(ledgerPrecision.ledgerWriteScale(0, 963000, 'mainnet', 'BTC'), 0);
            assert.strictEqual(ledgerPrecision.ledgerWriteScale(8, 963000, 'mainnet', 'BTC'), 8);
            assert.strictEqual(ledgerPrecision.ledgerWriteScale(0, 0, 'regtest', 'BTC'), 18);
            assert.strictEqual(ledgerPrecision.ledgerWriteScale(0, 500, 'regtest', 'BTC'), 18);
        });

        it('quantizing the measured 0.5 XCHAIN fee at each scale reproduces 1 vs 0.5', function () {
            // The scale this module returns is fed straight into the same bcadd
            // quantization db.createLedgerChangeRecord performs. At the legacy
            // decimals=0 scale the fee rounds half-up to a whole XCHAIN, which is
            // the defect; at the exact scale it survives as 0.5.
            const util   = new Utility();
            const legacy = ledgerPrecision.ledgerWriteScale(0, 963000, 'mainnet', 'BTC');
            const live   = ledgerPrecision.ledgerWriteScale(0, 500, 'regtest', 'BTC');
            assert.strictEqual(util.bcstr(util.bcadd('0.5', 0, legacy)), '1');
            assert.strictEqual(util.bcstr(util.bcadd('0.5', 0, live)),   '0.5');
        });

        it('the measured batch: 51 fees of 0.5 total 25.5 live and 51 under the legacy scale', function () {
            // The XC-1459 field measurement, in numbers: one parent plus 50
            // children. 51 is the overcharge, 25.5 is the fee schedule.
            const util   = new Utility();
            const exact  = ledgerPrecision.LEDGER_AMOUNT_PRECISION;
            const legacy = ledgerPrecision.ledgerWriteScale(0, 963000, 'mainnet', 'BTC');
            const live   = ledgerPrecision.ledgerWriteScale(0, 500, 'regtest', 'BTC');

            const charge = (scale) => {
                let total = '0';
                for (let i = 0; i < 51; i++)
                    total = util.bcstr(util.bcadd(total, util.bcstr(util.bcadd('0.5', 0, scale)), exact));
                return total;
            };

            assert.strictEqual(charge(live),   '25.5');
            assert.strictEqual(charge(legacy), '51');
        });
    });
});
