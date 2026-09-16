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
 * Shared setup for the tier 2 balance mutation suite (../../tier2_balance_mutations.test.js
 * and the parts beside this directory): Database methods bound to a mock
 * doQuery context.
 */

'use strict';

const { sinon, Utility, getTestConfig } = require('../../../setup/harness');

const Database = require('../../../../../src/db');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a bound getTokenSupply method using a mock doQuery
 * that returns predetermined credits/debits/escrows values.
 */
function createSupplyTestContext(credits, debits, escrows) {
    const config = getTestConfig();
    const util = new Utility();
    let queryCount = 0;

    const ctx = {
        config,
        util,
        createTicker: sinon.stub().resolves(1),
        getTokenDecimalPrecision: sinon.stub().resolves(0),
        doQuery: sinon.stub().callsFake(async (query, args) => {
            queryCount++;
            if (queryCount === 1) return [{ credits: credits }];
            if (queryCount === 2) return [{ debits: debits }];
            if (queryCount === 3) return [{ escrows: escrows }];
            return [];
        }),
    };

    const getTokenSupply = Database.prototype.getTokenSupply.bind(ctx);
    return { ctx, getTokenSupply, util };
}

/**
 * Create a bound createLedgerChangeRecord method with mock doQuery
 */
function createLedgerTestContext() {
    const config = getTestConfig();
    const util = new Utility();
    const queries = [];

    // Stand the mock at block 0 on the harness's regtest config: createLedgerChangeRecord
    // quantizes through ledger_amount_precision_activation from the tick's decimals and the
    // block, so without these two members it throws before the whitelist or the INSERT.
    const ctx = {
        config,
        util,
        blockIndex: 0,
        createTicker: sinon.stub().resolves(1),
        createAddress: sinon.stub().resolves(1),
        getTokenDecimalPrecision: sinon.stub().resolves(8),
        doQuery: sinon.stub().callsFake(async (query, args) => {
            queries.push({ query, args: [...args] });
            if (query.trim().startsWith('SELECT')) return []; // No existing record
            return { insertId: 1 };
        }),
    };

    // Bind createLedgerChangeRecord to ctx first, then attach it
    ctx.createLedgerChangeRecord = Database.prototype.createLedgerChangeRecord.bind(ctx);
    const createCredit = Database.prototype.createCredit.bind(ctx);
    const createDebit = Database.prototype.createDebit.bind(ctx);
    const createEscrow = Database.prototype.createEscrow.bind(ctx);

    return { ctx, createLedgerChangeRecord: ctx.createLedgerChangeRecord, createCredit, createDebit, createEscrow, queries };
}

module.exports = { createSupplyTestContext, createLedgerTestContext };
