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
 * test/unit/db.sanityCheck-null-tick.test.js
 *
 * XC-1457, the halt question: a ledger row with a NULL tick_id - the residue a
 * caret-dot ISSUE ("^42.1") lands below the BATCH_ISSUANCE_LIMITS flag, because
 * createTicker hands any ^-led name to getTickerId and never interns it - must NOT
 * be able to trip the per-block balances-vs-ledger sanityCheck. A throw there is a
 * block-processing HALT (XChainIndexer.js calls sanityCheck inside the block
 * transaction), which would have made the caret hole a remote-halt vector rather
 * than a data-integrity wart.
 *
 * ANSWER (driven on the BTC regtest venue 2026-08-14, inside a rolled-back
 * transaction on the live regtest indexer DB): NO HALT. A credit written through
 * createCredit for tick "^42.1" lands with tick_id NULL, and sanityCheck for that
 * block returns cleanly; the same probe's control (an imbalanced real tick) threw
 * SanityError, so the observation is not vacuous.
 *
 * The MECHANISM is the two INNER JOINs in the touched-tick query: the UNION of
 * credits/debits/escrows tick_ids is joined to `tokens` and `index_tickers`, and
 * neither join can match a NULL, so a NULL-tick_id row never enters the tick set
 * that gets aggregated and compared. These tests lock that mechanism in place:
 * relaxing either join to a LEFT JOIN would admit a NULL-keyed "tick" into the
 * compare loop and re-open the halt this closed.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

const BLOCK = 500;

function makeDb() {
    const config = getTestConfig();
    const util   = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    db.pool = { getConnection: sinon.stub().resolves({
        query:   sinon.stub().resolves([]),
        release: sinon.stub().resolves()
    }) };
    return db;
}

// Route each of sanityCheck's queries to a canned result by matching its SQL, and
// record every statement it issued so the tests can assert on both.
function stubQueries(db, plan) {
    const seen = [];
    sinon.stub(db, 'doQuery').callsFake(async (sql, args) => {
        seen.push({ sql: String(sql), args: args || [] });
        const s = String(sql);
        if (s.includes('DISTINCT(x.tick_id)'))          return plan.touched || [];
        if (/FROM credits m/.test(s))                    return plan.credits  || [];
        if (/FROM debits m/.test(s))                     return plan.debits   || [];
        if (/FROM escrows m INNER JOIN actions/.test(s)) return plan.escrowsLedger || [];
        if (/FROM escrows m WHERE/.test(s))              return plan.escrowsTotal  || [];
        if (/FROM balances m/.test(s))                   return plan.balances || [];
        if (/SELECT tick_id, supply FROM tokens/.test(s))return plan.tokens   || [];
        return [];
    });
    return seen;
}

afterEach(function () {
    sinon.restore();
});

describe('Database.sanityCheck() is blind to NULL tick_id ledger rows (XC-1457 halt question) @regression @tier1', function () {

    it('joins the touched-tick set to tokens AND index_tickers with NULL-eliminating INNER JOINs', async function () {
        const db   = makeDb();
        const seen = stubQueries(db, { touched: [] });

        await db.sanityCheck(BLOCK);

        const touched = seen.find(q => q.sql.includes('DISTINCT(x.tick_id)'));
        assert.ok(touched, 'sanityCheck must issue the touched-tick query');
        // Both joins are what drop a NULL tick_id before anything is compared.
        assert.ok(/INNER JOIN\s+tokens\s+t1 ON \(t1\.tick_id=x\.tick_id\)/.test(touched.sql),
            'tokens must be joined with INNER JOIN on x.tick_id');
        assert.ok(/INNER JOIN\s+index_tickers\s+t2 ON \(t2\.id=x\.tick_id\)/.test(touched.sql),
            'index_tickers must be joined with INNER JOIN on x.tick_id');
        assert.ok(!/LEFT\s+JOIN/i.test(touched.sql),
            'no LEFT JOIN here: it would admit a NULL-keyed tick into the compare loop');
        // All three ledger tables feed the set, each scoped by the action's own block.
        for (const table of ['credits c', 'debits d', 'escrows e'])
            assert.ok(touched.sql.includes(table), table + ' must contribute to the touched-tick set');
        assert.deepStrictEqual(touched.args, [BLOCK, BLOCK, BLOCK]);
    });

    it('does no aggregate work and does NOT throw when the block\'s only ledger row has a NULL tick_id', async function () {
        const db = makeDb();
        // The NULL row is exactly what the INNER JOINs above eliminate, so the
        // touched-tick query comes back empty for such a block.
        const seen = stubQueries(db, { touched: [] });

        await db.sanityCheck(BLOCK);   // must not throw: a throw here halts block processing

        assert.strictEqual(seen.length, 1, 'an empty tick set must short-circuit before the aggregates');
    });

    it('still halts on a genuinely imbalanced tick, so the no-throw above is not vacuous', async function () {
        const db = makeDb();
        stubQueries(db, {
            touched:  [{ tick_id: 7, tick: 'JDOG', decimals: 8 }],
            credits:  [{ tick_id: 7, s: '100.00000000' }],
            balances: [{ tick_id: 7, s: '100.00000000' }],
            tokens:   [{ tick_id: 7, supply: '999' }]
        });
        sinon.stub(console, 'log');

        await assert.rejects(() => db.sanityCheck(BLOCK), /SanityError: ledger supply does not match token supply/);
    });

    it('passes a balanced tick that shares the block with the NULL-tick row', async function () {
        const db = makeDb();
        stubQueries(db, {
            touched:  [{ tick_id: 7, tick: 'JDOG', decimals: 8 }],
            credits:  [{ tick_id: 7, s: '100.00000000' }],
            balances: [{ tick_id: 7, s: '100.00000000' }],
            tokens:   [{ tick_id: 7, supply: '100' }]
        });

        await db.sanityCheck(BLOCK);   // the NULL row contributes nothing either way
    });
});
