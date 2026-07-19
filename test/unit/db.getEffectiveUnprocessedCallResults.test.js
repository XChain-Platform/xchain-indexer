/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/db.getEffectiveUnprocessedCallResults.test.js
 *
 * : the callback-delivery query had no SQL LIMIT and the caller passed
 * Number.MAX_SAFE_INTEGER, materializing the full effective result set every tick
 * and dropping already-delivered rows in JS. When the hub mirror IS the local DB
 * the exclusion, ordering, and cap now push into one SQL statement (NOT EXISTS +
 * ORDER BY + LIMIT); when the mirror is a SEPARATE hub connection the callbacks
 * table is unreachable from it, so the original two-query JS filter is preserved.
 * Both paths must return byte-identical selection + ordering.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

function makeDb(hubDb) {
    const config  = getTestConfig();
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const indexer = { config, util };
    if (hubDb) indexer.hubDb = hubDb;
    return new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
}

describe('getEffectiveUnprocessedCallResults ()', function () {

    afterEach(() => sinon.restore());

    it('same-DB deployment: one SQL statement pushes NOT EXISTS + ORDER BY + LIMIT', async function () {
        const db  = makeDb(null); // no hubDb -> _mirrorDb() === this
        const out = [{ call_id: 'a1', snapshot_block: 5 }];
        const doQuery = sinon.stub(db, 'doQuery').resolves(out);

        const res = await db.getEffectiveUnprocessedCallResults('BTC', 'regtest', 1700, 25);

        assert.strictEqual(doQuery.callCount, 1, 'single query: no separate callback lookup');
        const [sql, args] = doQuery.firstCall.args;
        assert.ok(/NOT EXISTS/i.test(sql), 'processed-row exclusion pushed into SQL');
        assert.ok(/cross_chain_call_callbacks/.test(sql), 'exclusion is against the callbacks table');
        assert.ok(/ORDER BY[\s\S]*snapshot_block ASC[\s\S]*call_id ASC/i.test(sql), 'deterministic ordering preserved');
        assert.ok(/LIMIT \?/.test(sql), 'cap pushed into SQL');
        assert.deepStrictEqual(args, ['regtest', 'BTC', 1700, 25]);
        assert.strictEqual(res, out, 'rows returned straight from SQL (already filtered/ordered/capped)');
    });

    it('same-DB deployment: MAX_SAFE_INTEGER cap threads through unchanged (caller needs full set)', async function () {
        const db = makeDb(null);
        const doQuery = sinon.stub(db, 'doQuery').resolves([]);
        await db.getEffectiveUnprocessedCallResults('BTC', 'regtest', 1700, Number.MAX_SAFE_INTEGER);
        assert.strictEqual(doQuery.firstCall.args[1][3], Number.MAX_SAFE_INTEGER);
    });

    it('separate hub mirror: keeps the two-query JS filter, excluding processed then slicing', async function () {
        const mirrorRows = [
            { call_id: 'a1', snapshot_block: 1 },
            { call_id: 'a2', snapshot_block: 2 }, // already has a callback -> must be dropped
            { call_id: 'a3', snapshot_block: 3 },
        ];
        const hubDoQuery = sinon.stub().resolves(mirrorRows);
        const db = makeDb({ doQuery: hubDoQuery });
        // Local callbacks lookup: a2 already processed
        const localDoQuery = sinon.stub(db, 'doQuery').resolves([{ call_id: 'a2' }]);

        const res = await db.getEffectiveUnprocessedCallResults('BTC', 'regtest', 1700, 25);

        assert.strictEqual(hubDoQuery.callCount, 1, 'mirror read on the hub connection');
        assert.strictEqual(localDoQuery.callCount, 1, 'callbacks lookup on the local connection');
        assert.deepStrictEqual(res.map(r => r.call_id), ['a1', 'a3'], 'processed a2 dropped, order preserved');
    });

    it('separate hub mirror: empty mirror short-circuits with no callbacks lookup', async function () {
        const hubDoQuery = sinon.stub().resolves([]);
        const db = makeDb({ doQuery: hubDoQuery });
        const localDoQuery = sinon.stub(db, 'doQuery').resolves([]);
        const res = await db.getEffectiveUnprocessedCallResults('BTC', 'regtest', 1700, 25);
        assert.deepStrictEqual(res, []);
        assert.strictEqual(localDoQuery.callCount, 0, 'no callback lookup when nothing effective');
    });
});
