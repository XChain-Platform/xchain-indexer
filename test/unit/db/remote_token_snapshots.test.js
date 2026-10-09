/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *********************************************************************/

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const HubDbSync = require('../../../src/hub/hub_db_sync.js');
const mirrorTables = require('../../../src/hub/hub_db_sync/mirror_tables.js');
const mixin = require('../../../src/db/list_share_mirrors/index.js');

const SQL_PATH = path.join(__dirname, '..', '..', '..', 'src', 'sql', 'remote_token_snapshots.sql');

function declaredColumns(sql){
    const out = [];
    for(const line of sql.split('\n')){
        const m = line.match(/^\s{4}([a-z_][a-z0-9_]*)\s+/i);
        if(m && !['unique', 'key', 'primary', 'constraint'].includes(m[1].toLowerCase())) out.push(m[1]);
    }
    return out;
}

function fixtureStore(){
    const rows = [];
    const calls = [];
    const run = async (sql, args) => {
        calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), args });
        const insert = /^INSERT IGNORE INTO remote_token_snapshots \(([^)]+)\) VALUES/i.exec(sql);
        if(insert){
            const cols = insert[1].split(',').map(c => c.trim().replace(/`/g, ''));
            rows.push(Object.fromEntries(cols.map((c, i) => [c, args[i]])));
            return { affectedRows: 1 };
        }
        if(/^DELETE FROM remote_token_snapshots /i.test(sql)){
            for(let i = rows.length - 1; i >= 0; i--){
                if(rows[i].coin === args[0] && Number(rows[i].source_action_index) >= Number(args[1])) rows.splice(i, 1);
            }
            return { affectedRows: 1 };
        }
        return rows.filter(row => row.status === 'finalized' && row.network === args[0] &&
            row.coin === args[1] && row.tick === args[2])
            .sort((a, b) => Number(b.snapshot_block) - Number(a.snapshot_block) ||
                Number(b.source_action_index) - Number(a.source_action_index) ||
                String(b.snapshot_id).localeCompare(String(a.snapshot_id)))
            .slice(0, 1);
    };
    return { rows, calls, doQuery: run, doQueryStrict: run };
}

describe('remote_token_snapshots mirror contract', function () {
    const sql = fs.readFileSync(SQL_PATH, 'utf8');

    it('declares the signed token facts and rollback fence', function () {
        const columns = new Set(declaredColumns(sql));
        for(const name of [
            'id', 'snapshot_id', 'snapshot_block', 'network', 'coin', 'tick', 'decimals',
            'owner', 'source_action_index', 'finalizing_view',
            'validator_signatures', 'status', 'btc_chain_id', 'created_at'
        ]) assert.ok(columns.has(name), 'missing column ' + name);
        assert.match(sql, /UNIQUE KEY snapshot_id \(snapshot_id\)/);
        assert.match(sql, /KEY pinned_remote_token \(network, coin, tick, snapshot_block\)/);
        assert.match(sql, /KEY idx_source_ref \(coin, source_action_index\)/);
    });

    it('is bootstrapped, globally watermarked, locally keyed, and retractable by its source action', function () {
        assert.ok(!mirrorTables.CROSS_CHAIN_TABLES.includes('remote_token_snapshots'));
        assert.ok(mirrorTables.HUB_STATE_TABLES.includes('remote_token_snapshots'));
        assert.ok(mirrorTables.MIRRORED_TABLES.includes('remote_token_snapshots'));
        assert.ok(mirrorTables.AUTO_INCREMENT_ID_TABLES.includes('remote_token_snapshots'));
        assert.strictEqual(mirrorTables.RETRACTION_COLUMNS.remote_token_snapshots, 'source_action_index');
        assert.strictEqual(mirrorTables.RETRACTION_CHAIN_COLUMNS.remote_token_snapshots, 'coin');
    });

    it('round trips a finalized fixture and removes it on a source-chain retraction', async function () {
        const store = fixtureStore();
        const columns = declaredColumns(sql).filter(c => c !== 'id');
        const sync = new HubDbSync(store, { hubUrl: 'http://hub.test' });
        sync.refuseForeignChainRow = () => false;
        sync.refuseForeignNetworkRow = async () => false;
        sync.localColumns = async () => new Set(columns);
        sync.cachedColumnType = () => '';
        const fixture = {
            id: 88,
            snapshot_id: 'a'.repeat(64),
            snapshot_block: 700,
            network: 'regtest',
            coin: 'DOGE',
            tick: 'FUFU',
            decimals: 8,
            owner: 'DRemoteOwner',
            source_action_index: 91,
            finalizing_view: 2,
            validator_signatures: '[]',
            status: 'finalized',
            btc_chain_id: 'c'.repeat(64),
            created_at: '2026-10-08 12:00:00'
        };

        await sync.applyRow('remote_token_snapshots', fixture);
        const reader = {
            doQueryStrict: store.doQueryStrict.bind(store),
            getPinnedRemoteToken: mixin.getPinnedRemoteToken
        };
        const pinned = await reader.getPinnedRemoteToken('regtest', 'DOGE', 'FUFU');
        const expected = { ...fixture };
        delete expected.id;
        assert.deepStrictEqual(pinned, expected);

        await sync.applyRetraction({
            table: 'remote_token_snapshots',
            source_chain: 'DOGE',
            from_action_index: 91
        });
        assert.strictEqual(await reader.getPinnedRemoteToken('regtest', 'DOGE', 'FUFU'), null);
        const deletion = store.calls.find(call => /^DELETE FROM remote_token_snapshots /.test(call.sql));
        assert.deepStrictEqual(deletion, {
            sql: 'DELETE FROM remote_token_snapshots WHERE coin = ? AND source_action_index >= ?',
            args: ['DOGE', 91]
        });
    });
});
