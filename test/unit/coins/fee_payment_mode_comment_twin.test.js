/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const DECLARATIONS = {
    BTC: "    FEE_PAYMENT_MODE:                 'xchain',   // declared mode; the indexer classifies by coin (BTC xchain) and a registry test pins the two together",
    LTC: "    FEE_PAYMENT_MODE:                 'native', // LTC: native-only; declared mode, classified by coin in the indexer and pinned by a registry test",
    DOGE: "    FEE_PAYMENT_MODE:                 'native', // DOGE: native-only; declared mode, classified by coin in the indexer and pinned by a registry test",
};

describe('FEE_PAYMENT_MODE source declarations', function () {
    for (const [coin, expected] of Object.entries(DECLARATIONS)) {
        it(coin + '.js keeps its declaration line byte for byte', function () {
            const source = fs.readFileSync(path.resolve(__dirname, '../../../src/coins/' + coin + '.js'), 'utf8');
            const declarations = source.split('\n').filter((line) => /^\s*FEE_PAYMENT_MODE:/.test(line));
            assert.deepStrictEqual(declarations, [expected],
                coin + '.js must contain exactly the pinned FEE_PAYMENT_MODE declaration');
        });
    }
});
