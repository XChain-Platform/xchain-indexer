// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const rederiveSql = require('../../../../src/db/rollback/rederive.js');

// The ownership-escrow re-derive keeps a token locked while a GIVE_OWNERSHIP offer is
// live. Each offer kind lists the statuses its own handlers write: a dispenser is live
// in 'open' and 'cancelling' only, while an order parks in 'expiring' behind COINPay
// obligations. A status no handler writes for that kind would re-lock escrow the
// forward replay clears the moment a later feature reused the string.

// Run the re-derive against a recording db and return every statement it issued.
async function capturedStatements() {
    const statements = [];
    const db = {
        async doQuery(query) {
            statements.push(query);
            return statements.length === 1 ? [{ tick: 'TICK' }] : [];
        },
    };
    await rederiveSql.rederiveTokenEscrow(db);
    return statements;
}

// The live-status list of the arm that reads `fromClause`, one entry per statement.
function liveStatusLists(statements, fromClause) {
    const lists = [];
    for (const sql of statements) {
        for (const arm of sql.split('UNION ALL')) {
            if (!arm.includes(fromClause)) continue;
            const m = /si\.status IN \(([^)]*)\)/.exec(arm);
            assert.ok(m, `no status list in the ${fromClause} arm`);
            lists.push(m[1].replace(/\s+/g, '').replace(/'/g, ''));
        }
    }
    return lists;
}

describe('escrow re-derive live-status sets per offer kind @regression @tier1', function () {
    let statements;
    before(async function () { statements = await capturedStatements(); });

    it('reads the affected-ticker set and the open-offer lookup', function () {
        assert.ok(statements.length >= 2, `expected the two escrow selects, got ${statements.length}`);
    });

    it('lists only open and cancelling for dispenser offers in both statements', function () {
        const lists = liveStatusLists(statements, 'FROM dispensers d');
        assert.strictEqual(lists.length, 2, 'one dispenser arm in each of the two statements');
        for (const list of lists) assert.strictEqual(list, 'open,cancelling');
    });

    it('keeps expiring in the order arms of both statements', function () {
        const lists = liveStatusLists(statements, 'FROM orders o');
        assert.strictEqual(lists.length, 2, 'one order arm in each of the two statements');
        for (const list of lists) assert.strictEqual(list, 'open,cancelling,expiring');
    });
});
