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

const ageSeconds = require('../../../src/db/prices/oracle_snapshot_age_seconds');
const { readAgeSeconds } = ageSeconds;

const BASE_QUERY = "SELECT MAX(block_timestamp) AS latest_time FROM price_snapshots"
                 + " WHERE status = 'finalized' AND reference_block <= ?";

// The preload window getOracleDataForVM builds: a block cap, plus a causality bound once armed.
const CAPPED   = { blockCap: 55, timeBound: '', timeArgs: [] };
const BOUNDED  = { blockCap: 55, timeBound: ' AND block_timestamp <= ?', timeArgs: [1700000012] };

function stubDb(rows, calls = []){
    return {
        async doQueryStrict(query, args){
            calls.push({ query, args });
            return rows;
        }
    };
}

describe('oracle snapshot age seconds query @regression @tier1', function () {
    it('reads under the block cap and returns elapsed seconds', async function () {
        const calls = [];
        const db = stubDb([{ latest_time: 1700000000 }], calls);
        assert.strictEqual(await readAgeSeconds(db, 55, 1700000012, CAPPED), 12);
        assert.deepStrictEqual(calls, [{ query: BASE_QUERY, args: [55] }]);
    });

    it('appends the causality bound and its bindings after the block cap', async function () {
        const calls = [];
        const db = stubDb([{ latest_time: 1700000000 }], calls);
        assert.strictEqual(await readAgeSeconds(db, 55, 1700000012, BOUNDED), 12);
        assert.deepStrictEqual(calls, [{ query: BASE_QUERY + BOUNDED.timeBound, args: [55, 1700000012] }]);
    });

    it('clamps a future-dated snapshot age to zero', async function () {
        const db = stubDb([{ latest_time: 1700000020 }]);
        assert.strictEqual(await readAgeSeconds(db, 55, 1700000012, CAPPED), 0);
    });

    it('returns the sentinel when the query returns no row', async function () {
        const db = stubDb([]);
        assert.strictEqual(await readAgeSeconds(db, 55, 1700000012, CAPPED), Number.MAX_SAFE_INTEGER);
    });

    it('returns the sentinel when the latest timestamp is null', async function () {
        const db = stubDb([{ latest_time: null }]);
        assert.strictEqual(await readAgeSeconds(db, 55, 1700000012, CAPPED), Number.MAX_SAFE_INTEGER);
    });

    it('returns the sentinel for a non-finite reference time', async function () {
        const db = stubDb([{ latest_time: 1700000000 }]);
        assert.strictEqual(await readAgeSeconds(db, 55, Infinity, CAPPED), Number.MAX_SAFE_INTEGER);
    });

    it('propagates a strict-query rejection', async function () {
        const failure = new Error('strict query failed');
        const db = { doQueryStrict: async () => { throw failure; } };
        await assert.rejects(readAgeSeconds(db, 55, 1700000012, CAPPED), error => error === failure);
    });

    // An uncapped reader here would let a future adopter skip both the block cap and the
    // price-barrier assert that getOracleDataForVM carries, so the module exports none.
    it('exports no snapshot-age reader other than the capped one', function () {
        const readers = Object.keys(ageSeconds).filter(name => typeof ageSeconds[name] === 'function' && /^read/.test(name));
        assert.deepStrictEqual(readers, ['readAgeSeconds']);
    });
});
