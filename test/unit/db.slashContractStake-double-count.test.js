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
 * After UNSTAKE v1 a contract_stakes row keeps its `amount` intact (only a FUTURE
 * deactivation_block = block + ACTIVATION_DELAY_BLOCKS is set) while the same tokens are mirrored
 * into a contract_unstakes cooldown row that the block-end sweep refunds in full. Pass 1 must slash
 * ONLY never-unstaked rows (deactivation_block IS NULL); unstaked-but-cooling tokens are slashed by
 * Pass 2 (contract_unstakes). The historical bug filtered on `deactivation_block > blockIndex`,
 * which is TRUE throughout the [unstake, unstake+delay) window (the block is in the future), so a
 * slash landing in the window slashed the phantom contract_stakes copy (crediting the destination)
 * AND the sweep still refunded the contract_unstakes row: destination +X and staker +X against one
 * debit (silent supply inflation + total slash evasion).
 *
 * These tests EMULATE the SQL WHERE clause from the query text so they exercise the real block-height
 * arithmetic: a fixture contract_stakes row with a future deactivation_block is included by the buggy
 * `> ?` predicate but excluded by the correct `IS NULL` predicate. A stub that just returns [] (the
 * prior version of this test) could not tell the two filters apart and green-lit the bug.
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

// Emulate the contract_stakes Pass-1 SELECT against a fixture set of rows, honoring whichever
// deactivation predicate the query text actually carries. This is what makes the test sensitive
// to the inverted filter: with `deactivation_block IS NULL` a mid-cooldown row (future
// deactivation_block) is excluded; with `deactivation_block > ?` it is wrongly included in-window.
function selectStakes(sql, args, rows, slashBlock) {
    const windowed = /deactivation_block\s*>\s*\?/i.test(sql);         // the buggy `> ?` predicate
    const hasNull  = /deactivation_block\s+IS\s+NULL/i.test(sql);
    const nullOnly = hasNull && !windowed;                             // the correct `IS NULL`-only predicate
    return rows.filter((r) => {
        if (r.deactivation_block === null || r.deactivation_block === undefined) return true;
        if (nullOnly)  return false;                         // correct filter drops any deactivated row
        if (windowed)  return Number(r.deactivation_block) > Number(slashBlock); // buggy filter keeps it in-window
        return true;                                         // no filter at all (also a bug) => keep
    // source_address rides along: the deduction has to name whose escrow it is releasing, so
    // the real query joins index_addresses and the function halts on a row without one.
    }).map((r) => ({ action_index: r.action_index, amount: r.amount, source_address: 'staker1' }));
}

afterEach(function () { sinon.restore(); });

describe('Database.slashContractStake() mid-cooldown double-count guard @regression @tier1', function () {

    it('routes a mid-cooldown slash to contract_unstakes only (never the deactivated phantom)', async function () {
        const db = makeDb();
        sinon.stub(db, 'getStatusId').callsFake(async (s) => (s === 'valid' ? 1 : (s === 'pending' ? 2 : null)));
        const slashBlock = 306;
        // The staker unstaked at block 300 with ACTIVATION_DELAY_BLOCKS=6 => deactivation_block=306+... ;
        // model a still-future deactivation_block (312) so the slash at 306 lands inside the window.
        const stakeFixtures = [{ action_index: 7, amount: '100', deactivation_block: 312 }];
        const calls = [];
        sinon.stub(db, 'doQuery').callsFake(async (sql, args) => {
            calls.push({ sql, args });
            if (/SELECT[\s\S]*FROM\s+contract_stakes/i.test(sql))   return selectStakes(sql, args, stakeFixtures, slashBlock);
            if (/SELECT[\s\S]*FROM\s+contract_unstakes/i.test(sql)) return [{ action_index: 5, amount: '100', source_address: 'staker1' }]; // cooldown row holds the tokens
            return [];                                                                                          // UPDATEs
        });

        const slashed = await db.slashContractStake(1, 10, 1, '100', slashBlock);

        // Exactly 100 slashed, entirely from contract_unstakes (Pass 2). Not double-counted.
        assert.strictEqual(String(slashed.total), '100');
        assert.ok(!calls.some(c => /UPDATE\s+contract_stakes/i.test(c.sql)),
            'must NOT slash the deactivated contract_stakes phantom (that copy is refunded by the sweep)');
        assert.ok(calls.some(c => /UPDATE\s+contract_unstakes/i.test(c.sql)),
            'slash must hit the contract_unstakes cooldown row');

        const pass1 = calls.find(c => /SELECT[\s\S]*FROM\s+contract_stakes/i.test(c.sql));
        assert.ok(pass1, 'Pass 1 select ran');
        assert.ok(/deactivation_block\s+IS\s+NULL/i.test(pass1.sql) && !/deactivation_block\s*>\s*\?/i.test(pass1.sql),
            'Pass 1 must filter deactivation_block IS NULL (not the inverted future-block predicate)');
    });

    it('still slashes an active (never-unstaked) staker from contract_stakes (Pass 1)', async function () {
        const db = makeDb();
        sinon.stub(db, 'getStatusId').callsFake(async (s) => (s === 'valid' ? 1 : (s === 'pending' ? 2 : null)));
        const slashBlock = 306;
        const stakeFixtures = [{ action_index: 7, amount: '100', deactivation_block: null }]; // active, never unstaked
        const calls = [];
        sinon.stub(db, 'doQuery').callsFake(async (sql, args) => {
            calls.push({ sql, args });
            if (/SELECT[\s\S]*FROM\s+contract_stakes/i.test(sql))   return selectStakes(sql, args, stakeFixtures, slashBlock);
            if (/SELECT[\s\S]*FROM\s+contract_unstakes/i.test(sql)) return [];
            return [];
        });

        const slashed = await db.slashContractStake(1, 10, 1, '40', slashBlock);
        assert.strictEqual(String(slashed.total), '40');
        assert.ok(calls.some(c => /UPDATE\s+contract_stakes/i.test(c.sql)),
            'an active (non-cooldown) staker is slashed from contract_stakes');
    });
});
