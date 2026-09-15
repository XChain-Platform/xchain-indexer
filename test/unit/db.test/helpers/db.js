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
 **********************************************************************/

// test/unit/db.test/helpers/db.js
//
// Shared Database bindings and normalization fixture for the split unit tests.

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert  = require('assert');
const sinon   = require('sinon');
const { getTestConfig } = require('../../../fixtures/config');
const Utility           = require('../../../../src/utility');
const Database          = require('../../../../src/db');

// ---------------------------------------------------------------------------
// Build a minimal object that has the method + dependencies, but no real DB
// ---------------------------------------------------------------------------
function makeDbLike() {
    const config = getTestConfig();
    const util   = new Utility();
    const obj    = {
        config,
        util,
        normalizeDataValues: Database.prototype.normalizeDataValues,
    };
    return { obj, config, util };
}

module.exports = { assert, sinon, getTestConfig, Utility, Database, makeDbLike };
