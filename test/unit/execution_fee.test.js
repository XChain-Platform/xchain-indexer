/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Execution-fee formula + gas-token-decimal masking
 *
 * EXECUTE charges the caller `fee = gasUsed * GAS_PRICE` computed to 8 dp
 * (xchain-indexer/src/actions/execute.js), debited in the gas tick. The balance
 * projection then sums ledger amounts and CASTs to DECIMAL(60, <token decimals>)
 * (src/db.js getTokenDecimalPrecision + the balance SELECT), so the amount a caller
 * ACTUALLY pays is that 8-dp fee rounded to the gas TOKEN's own decimals.
 *
 * Consequence (consensus/economic): with a 0-decimal gas token — which is exactly how
 * the e2e XCHAIN token is issued (initialCheck.test.js: decimals=0) — every fee below
 * 0.5 rounds to ZERO, so at GAS_PRICE=0.00001 any execution under ~50,000 gas is
 * effectively FREE. This was masking real gas accounting on regtest. A production gas
 * token with decimals>0 charges the fractional fee in full.
 *
 * This test pins (a) the fee formula + GAS_PRICE so neither drifts silently (both are
 * consensus values), and (b) the decimal-masking behavior so the "free execution on a
 * 0-decimal gas token" property can't reappear unnoticed. bcformat mirrors MariaDB's
 * half-up DECIMAL cast (verified: 0.5 -> 1), so it is a faithful proxy for the balance
 * projection's rounding.
 ********************************************************************/

const assert = require('assert');

// Utility loads coin config in its constructor — set before require (mirrors utility.test.js).
process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';
const Utility = require('../../src/utility.js');

describe('Execution fee — formula + token-decimal masking @regression @tier1', function () {
    let util;
    beforeEach(function () { util = new Utility(); });

    // Mirror execute.js exactly: fee = bcmul(gasUsed, GAS_PRICE, 8). bcmul returns a
    // bignumber object; .toString() gives the canonical decimal string execute.js debits.
    function fee(gasUsed) { return util.bcmul(String(gasUsed), util.config['GAS_PRICE'], 8).toString(); }
    // Mirror the balance projection: the fee as seen after the DECIMAL(60, decimals) cast.
    function paid(gasUsed, tokenDecimals) { return util.bcformat(fee(gasUsed), tokenDecimals); }

    it('GAS_PRICE is the expected consensus value (0.00001 XCHAIN/gas)', function () {
        assert.strictEqual(util.config['GAS_PRICE'], '0.00001');
    });

    it('fee = gasUsed * GAS_PRICE to 8 dp (golden values)', function () {
        assert.strictEqual(fee(0),       '0');
        assert.strictEqual(fee(1),       '0.00001');
        assert.strictEqual(fee(100),     '0.001');
        assert.strictEqual(fee(49999),   '0.49999');
        assert.strictEqual(fee(50000),   '0.5');
        assert.strictEqual(fee(100000),  '1');
        assert.strictEqual(fee(1000001), '10.00001'); // gas-ceiling / out-of-gas case
    });

    it('0-decimal gas token (e2e XCHAIN): sub-0.5 fees round to 0 — effectively free', function () {
        assert.strictEqual(paid(1,     0), '0'); // 0.00001 -> 0
        assert.strictEqual(paid(100,   0), '0'); // 0.001   -> 0
        assert.strictEqual(paid(49999, 0), '0'); // 0.49999 -> 0  (just under the threshold)
        // Threshold: the fee must reach 0.5 before the caller pays a single unit.
        assert.strictEqual(paid(50000,  0), '1');  // 0.5      -> 1
        assert.strictEqual(paid(100000, 0), '1');  // 1.0      -> 1
        assert.strictEqual(paid(1000001,0), '10'); // 10.00001 -> 10
    });

    it('8-decimal gas token: fractional fees are charged in full (no masking)', function () {
        assert.strictEqual(paid(1,       8), '0.00001000');
        assert.strictEqual(paid(100,     8), '0.00100000');
        assert.strictEqual(paid(49999,   8), '0.49999000');
        assert.strictEqual(paid(1000001, 8), '10.00001000');
    });
});
