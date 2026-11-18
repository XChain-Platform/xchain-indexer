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
 * test/unit/recovery/recovery_hub_local_ids.test.js
 *
 * An archived row's id is the publishing hub's own AUTO_INCREMENT value. Two hubs can
 * archive different rows under the same id, so recovery never binds it into a mirror
 * table's PRIMARY KEY: rows land on their natural UNIQUE key under a local surrogate id,
 * and a write that fails fails the batch instead of being counted.
 */

'use strict';

const assert = require('assert');

const checkpointPrice = require('../../../bin/recovery/checkpoint_price.js');
const bridgePolicy    = require('../../../bin/recovery/bridge_policy.js');
const listShare       = require('../../../bin/recovery/list_share.js');

// Two archive rows that share a hub id and differ in every natural key.
function pair(make) {
    return [make(1), make(2)].map(row => Object.assign(row, { id: 500 }));
}

const TABLES = [
    ['state_checkpoints', checkpointPrice, 'state_checkpoints', 'checkpoints',
        n => ({ chain: 'BTC', network: 'regtest', block_index: 100 + n, checkpoint_seq: n, snapshot_block: 100 })],
    ['price_snapshots', checkpointPrice, 'price_snapshots', 'prices',
        n => ({ round_number: n, coin_pair: 'BTC/USD', reference_block: 1, block_timestamp: 1 })],
    ['bridge_transfers', bridgePolicy, 'bridge_transfers', 'bridges',
        n => ({ transfer_id: 't' + n, snapshot_block: 1, src_action_index: n, decimals: 8, effective_time: 1 })],
    ['policy_snapshots', bridgePolicy, 'policy_snapshots', 'policies',
        n => ({ snapshot_id: 'p' + n, snapshot_block: 1, network: 'regtest', origin_chain: 'BTC', tick: 'X',
                policy_seq: n, origin_block: 1, sleeping: 0, effective_time: 1 })],
    ['list_snapshots', listShare, 'list_snapshots', 'lists',
        n => ({ snapshot_id: 'l' + n, snapshot_block: 1, network: 'regtest', home_chain: 'DOGE',
                home_list_index: 1, list_type: 1, seq: n, origin_block: 1 })]
];

function recordingDb(failInsert) {
    const inserts = [];
    return {
        inserts,
        doQuery: async (sql, params) => {
            if (/^\s*INSERT/i.test(sql)) {
                if (failInsert) throw new Error('duplicate key');
                inserts.push({ sql: String(sql), params });
            }
            return [];
        }
    };
}

function insertColumns(sql) {
    return /INTO\s+\w+\s*\(([^)]*)\)/.exec(sql)[1].split(',').map(column => column.trim());
}

describe('recovery never binds an archived hub id into a mirror key @regression @tier1', function () {
    for (const [table, mod, , counter, make] of TABLES) {
        it(`${table}: two rows sharing a hub id both land on their own keys, with no id column`, async function () {
            const db = recordingDb(false);
            const report = { bridges: 0, policies: 0, checkpoints: 0, prices: 0, tombstones: 0, lists: 0 };
            const archive = { [table]: pair(make) };
            await mod.writeArchive(db, archive, report);

            assert.strictEqual(db.inserts.length, 2);
            assert.strictEqual(report[counter], 2);
            for (const insert of db.inserts) {
                const columns = insertColumns(insert.sql);
                assert.ok(!columns.includes('id'), 'the hub id is not a bound column');
                assert.doesNotMatch(insert.sql, /INSERT\s+IGNORE/i, 'a dropped row must not read as written');
                assert.strictEqual(columns.length, insert.params.length);
                assert.ok(!insert.params.includes(500), 'the archived hub id is not a bind value');
            }
        });

        it(`${table}: a failed insert fails the write and leaves the counter untouched`, async function () {
            const db = recordingDb(true);
            const report = { bridges: 0, policies: 0, checkpoints: 0, prices: 0, tombstones: 0, lists: 0 };
            await assert.rejects(mod.writeArchive(db, { [table]: pair(make) }, report), /duplicate key/);
            assert.strictEqual(report[counter], 0);
        });
    }
});
