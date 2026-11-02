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
 * test/unit/db/index_tables/status_column_fit.test.js
 *
 * createStatus against a stub that behaves like the utf8mb3 VARCHAR(250) column: INSERT
 * cuts the value to 250 characters, and a bound parameter carrying a supplementary-plane
 * character fails with errno 1267. Unclipped, a 261-character lint verdict got a NULL id
 * and a 4-byte character threw, wedging the block on every retry.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../../../fixtures/config');
const Utility           = require('../../../../src/utility');
const Database          = require('../../../../src/db');

const COLUMN_CHARS = 250;

function makeDb() {
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', {
        config: getTestConfig(),
        util:   new Utility()
    });
    const rows = new Map();
    let nextId = 1;
    sinon.stub(db, 'doQuery').callsFake(async (sql, args) => {
        const value = String(args[0]);
        if([...value].some((c) => c.codePointAt(0) > 0xFFFF)){
            const err = new Error('Illegal mix of collations (utf8mb3_general_ci,IMPLICIT) and (utf8mb4_general_ci,COERCIBLE)');
            err.errno = 1267;
            throw err;
        }
        if(/^\s*INSERT/i.test(sql)){
            const stored = [...value].slice(0, COLUMN_CHARS).join('');
            if(!rows.has(stored)) rows.set(stored, nextId++);
            return {};
        }
        return rows.has(value) ? [{ id: rows.get(value) }] : [];
    });
    return { db, rows };
}

// The 261-character verdict lint gives a DEPLOY wrapping `var g = function*(){};`.
function longVerdict() {
    const head = 'invalid: CODE_ENCODING (banned generator surface: generator at line 1 (';
    const tail = '))';
    return head + 'x'.repeat(261 - head.length - tail.length) + tail;
}

afterEach(function () {
    sinon.restore();
});

describe('Database.createStatus() column fit @regression @tier1', function () {
    it('stores a verdict longer than the column as its first 250 characters and returns its id', async function () {
        const { db, rows } = makeDb();
        const verdict = longVerdict();
        assert.strictEqual(verdict.length, 261);

        const id = await db.createStatus(verdict);

        assert.notStrictEqual(id, null);
        assert.deepStrictEqual([...rows.keys()], [verdict.substring(0, COLUMN_CHARS)]);
        assert.strictEqual(rows.get(verdict.substring(0, COLUMN_CHARS)), id);
    });

    it('returns the same id for the same long verdict on a second call', async function () {
        const { db, rows } = makeDb();
        const first = await db.createStatus(longVerdict());
        assert.notStrictEqual(first, null);
        // Drop the id cache so the second call resolves through the table, as after a restart.
        db._statusActionIdCache.committed.status.clear();

        assert.strictEqual(await db.createStatus(longVerdict()), first);
        assert.strictEqual(rows.size, 1);
    });

    it('stores a verdict carrying a 4-byte character with U+FFFD in its place', async function () {
        const { db, rows } = makeDb();
        const verdict = "invalid: CODE_ENCODING (banned surface at line 1 ('\u{1F600}'))";

        const id = await db.createStatus(verdict);

        assert.notStrictEqual(id, null);
        assert.deepStrictEqual([...rows.keys()],
            ["invalid: CODE_ENCODING (banned surface at line 1 ('�'))"]);
    });

    it('counts a 4-byte character as one of the 250 characters', async function () {
        const { db, rows } = makeDb();
        const verdict = '\u{1F600}'.repeat(300);

        const id = await db.createStatus(verdict);

        assert.notStrictEqual(id, null);
        assert.deepStrictEqual([...rows.keys()], ['�'.repeat(COLUMN_CHARS)]);
    });

    it('stores a verdict that already fits unchanged', async function () {
        const { db, rows } = makeDb();
        const verdict = 'invalid: insufficient funds €'.padEnd(COLUMN_CHARS, '.');

        await db.createStatus(verdict);

        assert.deepStrictEqual([...rows.keys()], [verdict]);
    });
});
