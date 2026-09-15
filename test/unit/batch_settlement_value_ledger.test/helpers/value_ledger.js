/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************/

// test/unit/batch_settlement_value_ledger.test/helpers/value_ledger.js
//
// Shared utility setup and ledger seed for the split settlement-value tests.

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert  = require('assert');
const Utility = require('../../../../src/utility.js');

// What batch.js seeds, verbatim, once BATCH_ISSUANCE_LIMITS is enabled.
function seedLedger(){
    return { nativeFeeConsumed: '0', coinAmountConsumed: '0', oracleFeeConsumed: {} };
}

function makeUtil(){
    let util = new Utility();
    util.config['COIN']              = 'BTC';
    util.config['NETWORK']           = 'regtest';
    util.config['FEE_TOLERANCE_MIN'] = '0.95';
    return util;
}

module.exports = { assert, seedLedger, makeUtil };
