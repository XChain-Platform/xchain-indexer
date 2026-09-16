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
 * test/unit/db/db_queries.test/helpers/db_stub.js
 *
 * The prototype-borrowed Database every db_queries suite builds on: a real
 * Database whose pool never connects, optionally with doQuery and doQueryStrict
 * answering fixed rows. The suites set INDEXER_COIN and INDEXER_NETWORK before
 * requiring this, as the config it loads reads them.
 */

'use strict';

const sinon  = require('sinon');

const { getTestConfig } = require('../../../../fixtures/config');
const Utility           = require('../../../../../src/utility');
const Database          = require('../../../../../src/db');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeDb() {
    const config  = getTestConfig();
    const util    = new Utility();
    // Silence logError from polluting test output
    sinon.stub(util, 'logError');
    const indexer = { config, util };
    const db      = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
    // Replace the real pool so the constructor doesn't try to connect
    db.pool = { getConnection: sinon.stub().resolves({
        query:            sinon.stub().resolves([]),
        release:          sinon.stub().resolves(),
        beginTransaction: sinon.stub().resolves(),
        commit:           sinon.stub().resolves(),
        rollback:         sinon.stub().resolves()
    }) };
    return db;
}

// Build a fresh db with doQuery stubbed to return rows
function dbWithDoQuery(rows) {
    const db = makeDb();
    sinon.stub(db, 'doQuery').resolves(rows);
    // Consensus-input reads (e.g. getLatestPrice) route through doQueryStrict,
    // which throws instead of swallowing errors. Stub it identically so
    // helpers that assert on returned rows exercise either path.
    sinon.stub(db, 'doQueryStrict').resolves(rows);
    return db;
}

module.exports = { makeDb, dbWithDoQuery };
