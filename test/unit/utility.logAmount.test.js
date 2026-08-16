/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/utility.logAmount.test.js
 *
 * The action loggers interpolate amounts into a template, and by then
 * setNumberFormats has replaced the parsed string with a bignumber - whose
 * String() flips to exponential below 1e-7. A valid 0.00000003 ORDER therefore
 * printed "ORDER : 3e-8 BTC:..." in the indexer log, the operator-facing record
 * of what the chain did. Stored/hashed byte-forms were never affected (those go
 * through bcstr), so this pins the LOG rendering.
 *
 * The second half of the contract matters as much as the first: logAmount must
 * leave everything that was NOT exponential exactly as it was, so this change
 * cannot quietly re-render amounts ('1.50' -> '1.5') or turn a field an invalid
 * action never supplied into a real-looking "0".
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert  = require('assert');
const mathjs  = require('mathjs');
const Utility = require('../../src/utility');

describe('Utility.logAmount() @regression', function () {

    const util = new Utility();

    it('renders a sub-1e-7 bignumber in plain decimal, not exponential', function () {
        assert.strictEqual(String(mathjs.bignumber('0.00000003')), '3e-8', 'precondition: the raw render is exponential');
        assert.strictEqual(util.logAmount(mathjs.bignumber('0.00000003')), '0.00000003');
    });

    it('handles the smallest 18-decimal amounts the protocol allows', function () {
        assert.strictEqual(util.logAmount(mathjs.bignumber('0.000000000000000001')), '0.000000000000000001');
    });

    it('renders an exponential STRING amount in plain decimal too', function () {
        assert.strictEqual(util.logAmount('3e-8'), '0.00000003');
    });

    it('leaves a normal-range bignumber unchanged', function () {
        assert.strictEqual(util.logAmount(mathjs.bignumber('1.23456789')), '1.23456789');
        assert.strictEqual(util.logAmount(mathjs.bignumber('0.0000001')), '0.0000001');
    });

    it('passes plain string amounts through byte-identically, trailing zeros included', function () {
        for (const raw of ['1.50', '0.00000000', '10', '0', '000.5'])
            assert.strictEqual(util.logAmount(raw), raw, 'must not re-render ' + raw);
    });

    it('does not invent a zero for a field an invalid action never supplied', function () {
        assert.strictEqual(util.logAmount(undefined), 'undefined');
        assert.strictEqual(util.logAmount(null), 'null');
        assert.strictEqual(util.logAmount(''), '');
    });

    it('leaves non-numeric text alone rather than coercing it', function () {
        assert.strictEqual(util.logAmount('not-a-number'), 'not-a-number');
        // Carries an 'e' but is not numeric: must survive the exponential branch.
        assert.strictEqual(util.logAmount('one'), 'one');
    });
});
