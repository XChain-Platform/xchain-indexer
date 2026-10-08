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
 ********************************************************************/

'use strict';

const assert = require('assert');

const { readSnapshotAgeSeconds } = require('../../../src/db/prices/oracle_snapshot_age_seconds');

const QUERY = "SELECT MAX(block_timestamp) AS latest_time FROM price_snapshots WHERE status = 'finalized' AND block_timestamp <= ?";

function stubDb(rows, calls = []){
    return {
        async doQueryStrict(query, args){
            calls.push({ query, args });
            return rows;
        }
    };
}

describe('oracle snapshot age seconds query @regression @tier1', function () {
    it('uses the exact finalized timestamp query and returns elapsed seconds', async function () {
        const calls = [];
        const db = stubDb([{ latest_time: 1700000000 }], calls);
        assert.strictEqual(await readSnapshotAgeSeconds(db, 55, 1700000012), 12);
        assert.deepStrictEqual(calls, [{ query: QUERY, args: [1700000012] }]);
    });

    it('clamps a future-dated snapshot age to zero', async function () {
        const db = stubDb([{ latest_time: 1700000020 }]);
        assert.strictEqual(await readSnapshotAgeSeconds(db, 55, 1700000012), 0);
    });

    it('returns the sentinel when the query returns no row', async function () {
        const db = stubDb([]);
        assert.strictEqual(await readSnapshotAgeSeconds(db, 55, 1700000012), Number.MAX_SAFE_INTEGER);
    });

    it('returns the sentinel when the latest timestamp is null', async function () {
        const db = stubDb([{ latest_time: null }]);
        assert.strictEqual(await readSnapshotAgeSeconds(db, 55, 1700000012), Number.MAX_SAFE_INTEGER);
    });

    it('returns the sentinel without querying for a non-finite reference time', async function () {
        const calls = [];
        const db = stubDb([{ latest_time: 1700000000 }], calls);
        assert.strictEqual(await readSnapshotAgeSeconds(db, 55, Infinity), Number.MAX_SAFE_INTEGER);
        assert.deepStrictEqual(calls, []);
    });

    it('propagates a strict-query rejection', async function () {
        const failure = new Error('strict query failed');
        const db = { doQueryStrict: async () => { throw failure; } };
        await assert.rejects(readSnapshotAgeSeconds(db, 55, 1700000012), error => error === failure);
    });
});
