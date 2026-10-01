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
 *********************************************************************/

'use strict';

const assert = require('assert');
const mixin = require('../../../src/db/list_share_mirrors/index.js');

function normalized(sql){
    return sql.replace(/\s+/g, ' ').trim();
}

function bindMixin(responses){
    const calls = [];
    const queue = (responses || []).slice();
    const db = {
        doQuery: async (sql, args) => {
            calls.push({ sql: normalized(sql), args });
            return queue.length > 0 ? queue.shift() : [];
        }
    };
    for(const method of Reflect.ownKeys(mixin)) db[method] = mixin[method].bind(db);
    return { db, calls };
}

describe('db/list_share_mirrors SQL contract', function () {

    it('reads foreign finalized snapshot heads from the MIRROR database', async function () {
        const rows = [{ home_chain: 'DOGE', home_list_index: 41, max_seq: 3 }];
        const { db, calls } = bindMixin([rows]);
        assert.strictEqual(await db.getListSnapshotHeads('regtest', 'BTC'), rows);
        assert.deepStrictEqual(calls, [{
            sql: "SELECT home_chain, home_list_index, MAX(seq) AS max_seq FROM list_snapshots WHERE status = 'finalized' AND network = ? AND home_chain <> ? GROUP BY home_chain, home_list_index",
            args: ['regtest', 'BTC']
        }]);
    });

    it('reads a foreign list tail in unique seq order from the MIRROR database', async function () {
        const rows = [{ seq: 2 }, { seq: 3 }];
        const { db, calls } = bindMixin([rows]);
        assert.strictEqual(await db.getListSnapshotsAfter('regtest', 'DOGE', 41, 1), rows);
        assert.deepStrictEqual(calls, [{
            sql: "SELECT * FROM list_snapshots WHERE status = 'finalized' AND network = ? AND home_chain = ? AND home_list_index = ? AND seq > ? ORDER BY seq ASC",
            args: ['regtest', 'DOGE', 41, 1]
        }]);
    });

    it('reads one finalized sequence from the MIRROR database', async function () {
        const row = { snapshot_id: 'a'.repeat(64), seq: 2 };
        const { db, calls } = bindMixin([[row], []]);
        assert.strictEqual(await db.getListSnapshotAtSeq('regtest', 'DOGE', 41, 2), row);
        assert.strictEqual(await db.getListSnapshotAtSeq('regtest', 'DOGE', 41, 9), null);
        const expected = "SELECT * FROM list_snapshots WHERE status = 'finalized' AND network = ? AND home_chain = ? AND home_list_index = ? AND seq = ? LIMIT 1";
        assert.deepStrictEqual(calls, [
            { sql: expected, args: ['regtest', 'DOGE', 41, 2] },
            { sql: expected, args: ['regtest', 'DOGE', 41, 9] }
        ]);
    });

    it('reads LOCAL applied counts from list settlements', async function () {
        const rows = [{ src_chain: 'DOGE', src_action_index: 41, applied_seq: 2 }];
        const { db, calls } = bindMixin([rows, [{ applied_seq: '2' }], []]);
        assert.strictEqual(await db.getAppliedListShareCounts(), rows);
        assert.strictEqual(await db.countAppliedListShareVersions('DOGE', 41), 2);
        assert.strictEqual(await db.countAppliedListShareVersions('DOGE', 99), 0);
        assert.deepStrictEqual(calls, [
            {
                sql: "SELECT src_chain, src_action_index, COUNT(*) AS applied_seq FROM bridge_settlements WHERE kind = 'list' GROUP BY src_chain, src_action_index",
                args: []
            },
            {
                sql: "SELECT COUNT(*) AS applied_seq FROM bridge_settlements WHERE kind = 'list' AND src_chain = ? AND src_action_index = ?",
                args: ['DOGE', 41]
            },
            {
                sql: "SELECT COUNT(*) AS applied_seq FROM bridge_settlements WHERE kind = 'list' AND src_chain = ? AND src_action_index = ?",
                args: ['DOGE', 99]
            }
        ]);
    });

    it('reads both LOCAL mirror mapping keys', async function () {
        const row = { action_index: 900, home_chain: 'DOGE', home_list_index: 41 };
        const { db, calls } = bindMixin([[row], [row], []]);
        assert.strictEqual(await db.getListShareMirror('DOGE', 41), row);
        assert.strictEqual(await db.getListShareMirrorByIndex(900), row);
        assert.strictEqual(await db.getListShareMirrorByIndex(901), null);
        assert.deepStrictEqual(calls, [
            {
                sql: 'SELECT * FROM list_share_mirrors WHERE home_chain = ? AND home_list_index = ? LIMIT 1',
                args: ['DOGE', 41]
            },
            {
                sql: 'SELECT * FROM list_share_mirrors WHERE action_index = ? LIMIT 1',
                args: [900]
            },
            {
                sql: 'SELECT * FROM list_share_mirrors WHERE action_index = ? LIMIT 1',
                args: [901]
            }
        ]);
    });

    it('writes the LOCAL mirror mapping with its rollback keys', async function () {
        const row = { action_index: 900, home_chain: 'DOGE', home_list_index: 41, block_index: 700 };
        const { db, calls } = bindMixin();
        await db.createListShareMirror(row);
        assert.deepStrictEqual(calls, [{
            sql: 'INSERT INTO list_share_mirrors (action_index, home_chain, home_list_index, block_index) VALUES (?, ?, ?, ?)',
            args: [900, 'DOGE', 41, 700]
        }]);
    });

    it('never orders mirror reads by the per-hub id', async function () {
        const { db, calls } = bindMixin();
        await db.getListSnapshotHeads('regtest', 'BTC');
        await db.getListSnapshotsAfter('regtest', 'DOGE', 41, 0);
        await db.getListSnapshotAtSeq('regtest', 'DOGE', 41, 1);
        for(const call of calls){
            assert.doesNotMatch(call.sql, /ORDER BY\s+(?:[^,]+,\s*)?id\b/i);
        }
        assert.match(calls[1].sql, /ORDER BY seq ASC$/);
        assert.strictEqual(calls.filter(call => /ORDER BY/.test(call.sql)).length, 1);
    });

});
