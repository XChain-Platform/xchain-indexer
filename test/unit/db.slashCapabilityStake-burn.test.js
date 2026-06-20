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

function wire(db, { stakes = [], unstakes = [] }) {
    const calls = [];
    sinon.stub(db, 'doQuery').callsFake(async (sql, args) => {
        calls.push({ sql, args });
        if (/SELECT[\s\S]*FROM\s+stakes/i.test(sql))   return stakes;
        if (/SELECT[\s\S]*FROM\s+unstakes/i.test(sql)) return unstakes;
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
        assert.strictEqual(Number(burned), 1000);

        const upd = calls.find(c => /UPDATE\s+stakes\s+SET\s+amount/i.test(c.sql));
        assert.ok(upd, 'an active stake must be burned from stakes');
        assert.deepStrictEqual(upd.args, ['0', 7]);

        // Pass 1 carries the active-window guard and binds the slash block.
        const sel = calls.find(c => /SELECT[\s\S]*FROM\s+stakes/i.test(c.sql));
        assert.ok(/deactivation_block IS NULL OR deactivation_block > \?/.test(sel.sql),
            'Pass 1 must carry the deactivation-window guard');
        assert.ok(sel.args.includes(306) && sel.args.includes(42), 'binds blockIndex + pubkeyId');

        // The debit records the verbatim pre-slash amount for reorg restore.
        const d = debitInserts(calls);
        assert.strictEqual(d.length, 1);
        assert.strictEqual(d[0].args[1], 'stakes');      // target_table
        assert.strictEqual(d[0].args[2], 7);             // stake_action_index
        assert.strictEqual(d[0].args[3], '1000');        // prev_amount (verbatim)
    });

    it('mid-cooldown: a deactivated stakes row is excluded; the bond burns from unstakes only', async function () {
        const db = makeDb();
        // Pass 1 SELECT returns [] (the active-window filter excludes the deactivated phantom);
        // the tokens live in the cooldown unstakes row.
        const calls = wire(db, { stakes: [], unstakes: [{ action_index: 5, amount: '1000' }] });

        const burned = await db.slashCapabilityStake(42, 306, 999);
        assert.strictEqual(Number(burned), 1000);

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
        assert.strictEqual(Number(burned), 1250);

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
        assert.strictEqual(Number(burned), 0);
        assert.strictEqual(debitInserts(calls).length, 0);
    });
});
