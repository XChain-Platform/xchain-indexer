// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// ledgerKeysForBlock filters each credits/debits branch by block INSIDE the UNION ALL,
// so the read touches only the block's own ledger rows. A block filter outside the
// derived table cannot be pushed into it and reads the whole ledger history per call.

'use strict';

const assert = require('assert');
const { ledgerKeysForBlock } = require('../../../src/db/state_commitment/ledger_reads.js');

// Capture the one strict read and answer it with the given rows.
function captureDb(rows) {
    const seen = [];
    return {
        seen,
        doQueryStrict: async (sql, params) => { seen.push({ sql, params }); return rows; },
    };
}

describe('ledgerKeysForBlock per-branch block filter @regression @tier1', function () {
    it('filters both the credits and the debits branch by block inside the derived table', async function () {
        const db = captureDb([]);
        await ledgerKeysForBlock(db, 812);
        assert.strictEqual(db.seen.length, 1);
        const { sql, params } = db.seen[0];
        const derived = sql.slice(sql.indexOf('FROM ('), sql.indexOf(') s'));
        const branches = derived.split('UNION ALL');
        assert.strictEqual(branches.length, 2, 'one credits branch and one debits branch');
        assert.ok(/FROM credits[\s\S]*WHERE a\.block_index = \?/.test(branches[0]), 'credits branch is block-filtered');
        assert.ok(/FROM debits[\s\S]*WHERE a\.block_index = \?/.test(branches[1]), 'debits branch is block-filtered');
        assert.ok(!/block_index/.test(sql.slice(sql.indexOf(') s'))), 'no block filter outside the derived table');
        assert.deepStrictEqual(params, [812, 812]);
    });

    it('returns the distinct non-empty keys as address<TAB>tick', async function () {
        const db = captureDb([{ address: 'a1', tick: 'T' }, { address: 'a2', tick: '' }, { address: null, tick: 'T' }]);
        const keys = await ledgerKeysForBlock(db, 9);
        assert.deepStrictEqual([...keys], ['a1\tT']);
    });
});
