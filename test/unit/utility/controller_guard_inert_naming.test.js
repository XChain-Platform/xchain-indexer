'use strict';

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/utility/controller_guard_inert_naming.test.js
 ********************************************************************/

const assert = require('assert');

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const Utility = require('../../../src/utility.js');

const SENTINEL = 'FEE_QUOTE_CONTROLLER_UNSUPPORTED';

describe('Utility guardInertError() @regression @tier1', function () {
    let util;

    beforeEach(function () {
        util = new Utility();
    });

    it('names a token binding while preserving the inert sentinel', function () {
        const error = util.guardInertError(7,
            { actionClass: 'transfer', subject: 'token AAA' });

        assert.ok(error.includes('token AAA'));
        assert.ok(error.includes(SENTINEL));
    });

    it('names an address binding while preserving the inert sentinel', function () {
        const error = util.guardInertError(8,
            { actionClass: 'transfer', subject: 'address owner' });

        assert.ok(error.includes('address owner'));
        assert.ok(error.includes(SENTINEL));
    });
});
