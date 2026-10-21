// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// getNetBalances reads every touched key's net in one strict statement per chunk,
// and each net equals what the single-key getNetBalance reports.

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const Utility = require('../../../src/utility.js');
const { getNetBalance, getNetBalances } = require('../../../src/db/state_commitment/ledger_reads.js');

// A db whose strict read answers from a table of nets, for both query shapes.
function fakeDb(nets) {
    const seen = [];
    return {
        seen,
        util: new Utility(),
        doQueryStrict: async (sql, params) => {
            seen.push({ sql, params });
            if (/FROM \(SELECT 0 AS i/.test(sql)) {
                const rows = [];
                for (let i = 0; i < params.length / 2; i++) {
                    const net = nets[params[2 * i] + '\t' + params[2 * i + 1]];
                    rows.push(net === undefined ? { i, cr: 0, dr: 0 } : { i, cr: net[0], dr: net[1] });
                }
                return rows;
            }
            const net = nets[params[0] + '\t' + params[1]] || ['0', '0'];
            return [{ cr: net[0], dr: net[1] }];
        },
    };
}

describe('getNetBalances batched read @regression @tier1', function () {
    const nets = { 'a1\tT': ['5.5', '1.25'], 'a2\tT': ['1', '1'], 'a3\tU': ['0.00000001', '0'] };

    it('answers every key in one statement and matches getNetBalance', async function () {
        const db = fakeDb(nets);
        const keys = [['a1', 'T'], ['a2', 'T'], ['a3', 'U'], ['none', 'T']];
        const got = await getNetBalances(db, keys);
        assert.strictEqual(db.seen.length, 1);
        for (const [a, t] of keys)
            assert.strictEqual(got.get(a + '\t' + t), await getNetBalance(db, a, t), a);
        assert.strictEqual(got.get('a1\tT'), '4.25');
        assert.strictEqual(got.get('a3\tU'), '0.00000001');
        assert.strictEqual(got.get('none\tT'), '0');
    });

    it('dedupes keys, chunks large sets, and reads nothing for an empty set', async function () {
        const db = fakeDb({});
        assert.strictEqual((await getNetBalances(db, [])).size, 0);
        assert.strictEqual(db.seen.length, 0);
        const keys = [];
        for (let i = 0; i < 1201; i++) keys.push(['a' + i, 'T']);
        keys.push(['a0', 'T']);
        const got = await getNetBalances(db, keys);
        assert.strictEqual(db.seen.length, 3);
        assert.strictEqual(got.size, 1201);
    });

    it('is the read threadBalancesRoot uses instead of a per-key loop', function () {
        const src = fs.readFileSync(path.resolve(__dirname, '../../../src/state_commitment/index.js'), 'utf8');
        const body = src.slice(src.indexOf('async function threadBalancesRoot'), src.indexOf('// Assemble state_root'));
        assert.ok(/getNetBalances\(db,/.test(body));
        assert.ok(!/await getNetBalance\(/.test(body));
    });
});
