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
 * test/unit/db.slashContractStake-double-count.test.js
 *
 * ECONOMIC REGRESSION GUARD for slashContractStake() mid-cooldown double-count.
 *
 * After UNSTAKE v1 a contract_stakes row keeps its `amount` intact (only deactivation_block is set)
 * while the same tokens are mirrored into a contract_unstakes cooldown row. Pass 1 used to select
 * contract_stakes with no deactivation filter, so it slashed that phantom copy AND credited the
 * destination, while the cooldown sweep still refunded the full contract_unstakes row — destination
 * +X and staker +X against one debit (supply inflation → fatal supply-sanity halt or silent mint).
 *
 * Fix: Pass 1 filters `deactivation_block IS NULL OR deactivation_block > blockIndex`, so a slash of a
 * mid-cooldown staker hits ONLY contract_unstakes (Pass 2). Each token is slashed exactly once.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

function makeDb() {
    const config  = getTestConfig();
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

afterEach(function () { sinon.restore(); });

describe('Database.slashContractStake() mid-cooldown double-count guard @regression @tier1', function () {

    it('Pass 1 filters out deactivated (post-unstake) contract_stakes rows by block height', async function () {
        const db = makeDb();
        sinon.stub(db, 'getStatusId').callsFake(async (s) => (s === 'valid' ? 1 : (s === 'pending' ? 2 : null)));
        const calls = [];
        sinon.stub(db, 'doQuery').callsFake(async (sql, args) => {
            calls.push({ sql, args });
            if (/SELECT[\s\S]*FROM\s+contract_stakes/i.test(sql))   return [];                                  // active filter excludes the phantom row
            if (/SELECT[\s\S]*FROM\s+contract_unstakes/i.test(sql)) return [{ action_index: 5, amount: '100' }]; // cooldown row holds the tokens
            return [];                                                                                          // UPDATEs
        });

        const slashed = await db.slashContractStake(1, 10, 1, '100', 306);

        // The whole 100 is slashed — but from contract_unstakes (Pass 2), not the phantom stake row.
        assert.strictEqual(String(slashed), '100');

        const pass1 = calls.find(c => /SELECT[\s\S]*FROM\s+contract_stakes/i.test(c.sql));
        assert.ok(pass1, 'Pass 1 select ran');
        assert.ok(/deactivation_block IS NULL OR deactivation_block > \?/.test(pass1.sql),
            'Pass 1 must carry the active-window filter');
        assert.ok(pass1.args.includes(306), 'Pass 1 must bind the current blockIndex');

        // No UPDATE to contract_stakes (the phantom copy is never touched); the cooldown row is.
        assert.ok(!calls.some(c => /UPDATE\s+contract_stakes/i.test(c.sql)),
            'must NOT slash the deactivated contract_stakes phantom');
        assert.ok(calls.some(c => /UPDATE\s+contract_unstakes/i.test(c.sql)),
            'slash must hit the contract_unstakes cooldown row');
    });

    it('still slashes an active staker from contract_stakes (Pass 1) when not in cooldown', async function () {
        const db = makeDb();
        sinon.stub(db, 'getStatusId').callsFake(async (s) => (s === 'valid' ? 1 : (s === 'pending' ? 2 : null)));
        const calls = [];
        sinon.stub(db, 'doQuery').callsFake(async (sql, args) => {
            calls.push({ sql, args });
            if (/SELECT[\s\S]*FROM\s+contract_stakes/i.test(sql))   return [{ action_index: 7, amount: '100' }]; // active row
            if (/SELECT[\s\S]*FROM\s+contract_unstakes/i.test(sql)) return [];
            return [];
        });

        const slashed = await db.slashContractStake(1, 10, 1, '40', 306);
        assert.strictEqual(String(slashed), '40');
        assert.ok(calls.some(c => /UPDATE\s+contract_stakes/i.test(c.sql)),
            'an active (non-cooldown) staker is slashed from contract_stakes');
    });
});
