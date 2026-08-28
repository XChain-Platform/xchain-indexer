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
 * test/unit/db.slashCapabilityStake-burn.test.js
 *
 * Capability-stake equivocation burn (WI-2 bump 2, Phase B). slashCapabilityStake
 * burns a validator's WHOLE XCHAIN bond on a proven equivocation: Pass 1 over active
 * `stakes`, Pass 2 over cooldown-locked `unstakes`. The same deactivation-window guard
 * as the contract path prevents the mid-cooldown double-count (a deactivated stakes
 * row whose tokens already mirrored into a cooldown unstakes row must be burned by
 * Pass 2 only (never both). Every in-place amount->0 logs a verbatim-prev_amount
 * debit for byte-exact reorg restore. DB is stubbed (no MariaDB); runs on any Node.
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
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
    db.pool = { getConnection: sinon.stub().resolves({
        query:   sinon.stub().resolves([]),
        release: sinon.stub().resolves()
    }) };
    sinon.stub(db, 'getStatusId').callsFake(async (s) => (s === 'valid' ? 1 : (s === 'pending' ? 2 : null)));
    return db;
}

// The real selects join index_addresses so the burn can name whose escrow it releases, and
// halt on a row without one. A fixture with no owner gets the default; one that sets
// source_address (null included, the dangling-join case) keeps what it set.
const withOwner = (r) => ('source_address' in r ? r.source_address : 'staker1');

// Emulate the Pass-1 `stakes` SELECT against fixture rows, honoring whichever deactivation predicate
// the query text carries, so the test exercises the real block-height arithmetic rather than assuming
// the filter works. slashBlock is the block the slash lands at (3rd arg to slashCapabilityStake).
function selectStakes(sql, rows, slashBlock) {
    const windowed = /deactivation_block\s*>\s*\?/i.test(sql);         // the buggy `> ?` predicate
    const hasNull  = /deactivation_block\s+IS\s+NULL/i.test(sql);
    const nullOnly = hasNull && !windowed;                             // the correct `IS NULL`-only predicate
    return rows.filter((r) => {
        if (r.deactivation_block === null || r.deactivation_block === undefined) return true;
        if (nullOnly)  return false;                                        // correct filter drops any deactivated row
        if (windowed)  return Number(r.deactivation_block) > Number(slashBlock); // buggy filter keeps it in-window
        return true;
    }).map((r) => ({ action_index: r.action_index, amount: r.amount, source_address: withOwner(r) }));
}

function wire(db, { stakes = [], unstakes = [], slashBlock = 306 }) {
    const calls = [];
    sinon.stub(db, 'doQuery').callsFake(async (sql, args) => {
        calls.push({ sql, args });
        if (/SELECT[\s\S]*FROM\s+stakes/i.test(sql))   return selectStakes(sql, stakes, slashBlock);
        if (/SELECT[\s\S]*FROM\s+unstakes/i.test(sql))
            return unstakes.map(r => ({ ...r, source_address: withOwner(r) }));
        return [];   // UPDATEs + the capability_slash_debits INSERTs
    });
    return calls;
}
const debitInserts = (calls) => calls.filter(c => /INSERT\s+INTO\s+capability_slash_debits/i.test(c.sql));

afterEach(function () { sinon.restore(); });

describe('Database.slashCapabilityStake() equivocation burn @regression @tier1', function () {

    it('Pass 1 burns an active staker from stakes (whole bond) and logs a verbatim debit', async function () {
        const db = makeDb();
        const calls = wire(db, { stakes: [{ action_index: 7, amount: '1000' }] });

        const burned = await db.slashCapabilityStake(42, 306, 999);
        assert.strictEqual(Number(burned.total), 1000);

        const upd = calls.find(c => /UPDATE\s+stakes\s+SET\s+amount/i.test(c.sql));
        assert.ok(upd, 'an active stake must be burned from stakes');
        assert.deepStrictEqual(upd.args, ['0', 7]);

        // Pass 1 only ever burns never-unstaked rows (deactivation_block IS NULL); a deactivated
        // row's tokens live in the cooldown unstakes row and are burned by Pass 2.
        const sel = calls.find(c => /SELECT[\s\S]*FROM\s+stakes/i.test(c.sql));
        assert.ok(/deactivation_block\s+IS\s+NULL/i.test(sel.sql) && !/deactivation_block\s*>\s*\?/i.test(sel.sql),
            'Pass 1 must filter deactivation_block IS NULL (not the inverted future-block predicate)');
        assert.ok(sel.args.includes(306) && sel.args.includes(42), 'binds blockIndex (activation gate) + pubkeyId');

        // The debit records the verbatim pre-slash amount for reorg restore.
        const d = debitInserts(calls);
        assert.strictEqual(d.length, 1);
        assert.strictEqual(d[0].args[1], 'stakes');      // target_table
        assert.strictEqual(d[0].args[2], 7);             // stake_action_index
        assert.strictEqual(d[0].args[3], '1000');        // prev_amount (verbatim)
    });

    it('mid-cooldown: a deactivated stakes row is excluded; the bond burns from unstakes only', async function () {
        const db = makeDb();
        // The validator unstaked; its stakes row keeps amount=1000 but carries a FUTURE
        // deactivation_block (312 > slash block 306), and the tokens are mirrored into the cooldown
        // unstakes row. The correct IS NULL filter must exclude the stakes phantom so the bond burns
        // once (Pass 2). The inverted `> ?` predicate would include it in-window and double-burn.
        const calls = wire(db, {
            stakes:   [{ action_index: 7, amount: '1000', deactivation_block: 312 }],
            unstakes: [{ action_index: 5, amount: '1000' }],
            slashBlock: 306,
        });

        const burned = await db.slashCapabilityStake(42, 306, 999);
        assert.strictEqual(Number(burned.total), 1000);

        assert.ok(!calls.some(c => /UPDATE\s+stakes\s+SET\s+amount/i.test(c.sql)),
            'must NOT burn the deactivated stakes phantom (double-count guard)');
        assert.ok(calls.some(c => /UPDATE\s+unstakes\s+SET\s+amount/i.test(c.sql)),
            'the cooldown unstakes row is burned (Pass 2)');
        const d = debitInserts(calls);
        assert.strictEqual(d.length, 1);
        assert.strictEqual(d[0].args[1], 'unstakes');
    });

    it('burns the WHOLE bond (active stakes AND cooldown unstakes together)', async function () {
        const db = makeDb();
        const calls = wire(db, {
            stakes:   [{ action_index: 7, amount: '1000' }],
            unstakes: [{ action_index: 5, amount: '250'  }],
        });

        const burned = await db.slashCapabilityStake(42, 306, 999);
        assert.strictEqual(Number(burned.total), 1250);

        assert.ok(calls.some(c => /UPDATE\s+stakes\s+SET\s+amount/i.test(c.sql)));
        assert.ok(calls.some(c => /UPDATE\s+unstakes\s+SET\s+amount/i.test(c.sql)));
        const d = debitInserts(calls);
        assert.strictEqual(d.length, 2, 'one debit per burned row');
        assert.deepStrictEqual(d.map(x => x.args[1]).sort(), ['stakes', 'unstakes']);
    });

    it('Pass 2 slashes cooldown unstakes in BOTH valid and pending status (closes R-4)', async function () {
        const db = makeDb();
        const calls = wire(db, { stakes: [], unstakes: [{ action_index: 5, amount: '500' }] });

        await db.slashCapabilityStake(42, 306, 999);

        const sel = calls.find(c => /SELECT[\s\S]*FROM\s+unstakes/i.test(c.sql));
        assert.ok(sel, 'Pass 2 select ran');
        assert.ok(/status_id\s+IN\s*\(/i.test(sel.sql), 'Pass 2 must filter unstakes by a status set');
        assert.ok(sel.args.includes(1) && sel.args.includes(2),
            'Pass 2 must bind BOTH the valid + pending status ids (cooldown rows are slashable, R-4)');
    });

    it('returns 0 and writes no debit when the validator has no bond', async function () {
        const db = makeDb();
        const calls = wire(db, { stakes: [], unstakes: [] });

        const burned = await db.slashCapabilityStake(42, 306, 999);
        assert.strictEqual(Number(burned.total), 0);
        assert.strictEqual(debitInserts(calls).length, 0);
        assert.deepStrictEqual(burned.releases, [], 'nothing burned releases no escrow');
    });

    // The bond is LOCKED in the staker's escrow, so slash.js releases it against whoever
    // holds the lock. A bare total cannot be attributed: a delegated key's rows resolve to
    // the OWNING source, so one burn can span two addresses.
    it('reports the escrow release PER OWNING ADDRESS, summing to the total', async function () {
        const db = makeDb();
        wire(db, {
            stakes: [
                { action_index: 9, amount: '600', source_address: 'ownerA' },
                { action_index: 7, amount: '400', source_address: 'ownerB' },
            ],
            unstakes: [{ action_index: 5, amount: '250', source_address: 'ownerA' }],
        });

        const burned = await db.slashCapabilityStake(42, 306, 999);
        assert.strictEqual(Number(burned.total), 1250);
        // ownerA's two rows fold into ONE release; order is the LIFO scan order, which is
        // deterministic, so every node writes the escrow rows in the same sequence.
        assert.deepStrictEqual(burned.releases, [
            { address: 'ownerA', amount: '850' },
            { address: 'ownerB', amount: '400' },
        ]);
        const sum = burned.releases.reduce((a, r) => a + Number(r.amount), 0);
        assert.strictEqual(sum, Number(burned.total), 'releases must account for the whole burn');
    });

    // Guessing would strand the lock: the tokens leave the stake tables with nothing
    // releasing them from escrow.
    it('HALTS on a burned row whose source address does not resolve', async function () {
        const db = makeDb();
        wire(db, { stakes: [{ action_index: 7, amount: '1000', source_address: null }] });

        await assert.rejects(
            () => db.slashCapabilityStake(42, 306, 999),
            /no source address/,
            'an unattributable bond must halt rather than burn without releasing its escrow');
    });
});
