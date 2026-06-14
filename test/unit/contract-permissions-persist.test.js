/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * createContractPermission — permissions array survives as JSON (Phase E).
 *
 * REGRESSION GUARD for a real bug an integration run caught that the mocked
 * guard/enforcement unit tests missed: db.normalizeDataValues() safeToString()s
 * every object-typed field, so an array PERMISSIONS was coerced to a comma-joined
 * string ('SEND,ISSUE') BEFORE JSON.stringify — persisting '"SEND,ISSUE"' instead
 * of '["SEND","ISSUE"]'. On read-back getContractPermissions' Array.isArray check
 * then fails, SILENTLY disabling the emission allowlist for every contract. This
 * pins the persisted JSON using the REAL normalizeDataValues. Pure (stubs doQuery);
 * runs on any Node.
 ********************************************************************/

const assert = require('assert');
const config = require('../../src/config.js');
const Utility = require('../../src/utility.js');
const Database = require('../../src/db.js');

describe('createContractPermission — permissions JSON integrity @regression @tier1', function () {

    function makeDb() {
        // Lazy-connecting Database (pool is created on first query, which we stub away).
        const db = new Database('127.0.0.1', 3306, 'x', 'u', 'p',
            { config: config.getConfig(), util: new Utility() });
        const calls = [];
        db.doQuery = async (q, args) => {
            calls.push({ q, args });
            return [];               // no existing row → INSERT branch
        };
        return { db, calls };
    }

    it('persists permissions as a JSON ARRAY string, not a comma-joined scalar', async function () {
        const { db, calls } = makeDb();
        await db.createContractPermission({
            ACTION_INDEX: 5, CONTRACT_INDEX: 5,
            PERMISSIONS: ['SEND', 'ISSUE'], MAX_TAKE_BPS: 300, BLOCK_INDEX: 100,
        });
        const insert = calls.find(c => /INSERT INTO contract_permissions/.test(c.q));
        assert.ok(insert, 'an INSERT was issued');
        // INSERT column order: (contract_index, permissions, max_take_bps, block_index, action_index)
        const permArg = insert.args[1];
        assert.strictEqual(permArg, '["SEND","ISSUE"]',
            'permissions stored as a JSON array (regression: normalizeDataValues coerced it to "SEND,ISSUE")');
        assert.deepStrictEqual(JSON.parse(permArg), ['SEND', 'ISSUE'],
            'round-trips back to the array getContractPermissions expects');
        assert.strictEqual(Number(insert.args[2]), 300, 'maxTakeBps persisted');
    });

    it('stores NULL permissions when none were declared (maxTakeBps-only manifest)', async function () {
        const { db, calls } = makeDb();
        await db.createContractPermission({
            ACTION_INDEX: 6, CONTRACT_INDEX: 6,
            PERMISSIONS: null, MAX_TAKE_BPS: 250, BLOCK_INDEX: 100,
        });
        const insert = calls.find(c => /INSERT INTO contract_permissions/.test(c.q));
        assert.strictEqual(insert.args[1], null, 'no permissions → NULL (unrestricted)');
        assert.strictEqual(Number(insert.args[2]), 250);
    });
});
