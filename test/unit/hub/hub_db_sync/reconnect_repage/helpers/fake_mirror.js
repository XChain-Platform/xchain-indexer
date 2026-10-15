// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The fake hub and fake local mirror the reconnect_repage tests drive HubDbSync against.

'use strict';

const sinon = require('sinon');

const HubDbSync = require('../../../../../../src/hub/hub_db_sync.js');
const { HUB_SCHEMA_VERSION } = require('../../../../../../src/hub/hub_schema_version');

const KEYS = {
    price_snapshots:   ['round_number', 'coin_pair'],
    oracle_prices:     ['source_chain', 'action_index'],
    cross_chain_calls: ['call_id', 'phase'],
    bridge_transfers:  ['transfer_id'],
    state_checkpoints: ['chain', 'checkpoint_seq'],
};

const FIXTURES = {
    price_snapshots: (i) => ({ round_number: i, coin_pair: 'DOGE/USD', price: '0.' + i, block_timestamp: 5000 + i,
                               status: 'finalized', source_chain: 'DOGE', source_action_index: 500 + i,
                               push_generation: 0, batch_block_time: 0 }),
    oracle_prices: (i) => ({ source_address: 'oaddr', source_chain: 'LTC', coin: 'DOGE', tick: 'PEPE', fiat: 'USD',
                             value: String(i), block_time: 6000 + i, effective_at: 6000 + i, action_index: 700 + i,
                             push_generation: 0 }),
    cross_chain_calls: (i) => ({ call_id: 'c' + i, phase: 'dispatch', network: 'regtest', source_chain: 'LTC',
                                 source_action_index: 1000 + i, effective_time: 7100 + i, status: 'finalized',
                                 push_generation: 0 }),
    bridge_transfers: (i) => ({ transfer_id: 't' + i, network: 'regtest', src_chain: 'LTC', src_action_index: 1100 + i,
                                effective_time: 7200 + i, status: 'finalized', push_generation: 0 }),
    state_checkpoints: (i) => ({ chain: 'LTC', network: 'regtest', checkpoint_seq: i, block_index: 10 * i }),
};

// A HubDbSync over a fake local mirror and a fake hub. Applied rows land in `local` on the
// table's natural key with a local id, last copy winning, which is what the shipped upserts
// do for every shape exercised here once the row is re-served at all.
function makeSync() {
    const hub = {};
    const local = {};
    const nextLocal = {};
    const seen = { deletes: [], applied: [], pages: [] };
    for (const t of Object.keys(FIXTURES)) { hub[t] = []; local[t] = []; nextLocal[t] = 1; }
    const doQuery = sinon.stub().callsFake(async (sql, args) => {
        let del = /^DELETE FROM (\w+) WHERE id IN/.exec(sql);
        if (del) {
            seen.deletes.push({ table: del[1], ids: args.slice() });
            local[del[1]] = local[del[1]].filter(r => args.indexOf(r.id) === -1);
            return { affectedRows: args.length };
        }
        if (/^SELECT id, source_chain, action_index FROM oracle_prices/.test(sql))
            return local.oracle_prices.map(r => ({ id: r.id, source_chain: r.source_chain, action_index: r.action_index }));
        if (/^SELECT id, round_number, coin_pair FROM price_snapshots WHERE status = 'finalized'/.test(sql))
            return local.price_snapshots.filter(r => r.status === 'finalized')
                .filter(r => !/block_timestamp >= \?/.test(sql) || Number(r.block_timestamp) >= Number(args[0]))
                .map(r => ({ id: r.id, round_number: r.round_number, coin_pair: r.coin_pair }));
        let max = /^SELECT MAX\(id\) AS max_id FROM (\w+)/.exec(sql);
        if (max) return [{ max_id: local[max[1]].reduce((m, r) => Math.max(m, r.id), 0) || null }];
        return [];
    });
    const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub-a.test', network: 'regtest' });
    sinon.stub(sync, 'localColumns').callsFake(async (t) => new Set(['id'].concat(Object.keys(FIXTURES[t](1)))));
    sinon.stub(sync, 'mirrorNetworkScope').resolves(null);
    sinon.stub(sync, 'applyRow').callsFake(async (t, row) => {
        seen.applied.push({ table: t, row: Object.assign({}, row) });
        const key = KEYS[t];
        const content = Object.assign({}, row); delete content.id;
        const at = local[t].findIndex(r => key.every(k => String(r[k]) === String(row[k])));
        if (at === -1) local[t].push(Object.assign(content, { id: nextLocal[t]++ }));
        else local[t][at] = Object.assign(content, { id: local[t][at].id });
    });
    sinon.stub(sync, 'httpGet').callsFake(async (path) => {
        const m = /^\/hub-db\/snapshot\/(\w+)\?since_id=(\d+)/.exec(path);
        seen.pages.push({ table: m[1], since: Number(m[2]) });
        return { schema_version: HUB_SCHEMA_VERSION, watermark: 9000,
                 rows: hub[m[1]].filter(r => r.id > Number(m[2])).map(r => Object.assign({}, r)) };
    });
    return { sync, hub, local, seen };
}

function seedHub(hub, table, n) {
    for (let i = 1; i <= n; i++) hub[table].push(Object.assign(FIXTURES[table](i), { id: i }));
}

function ready(sync) {
    sync.adoptReadyFrame({}, { type: 'ready', hub_instance_id: 'hub-a', max_ids: {} });
}

module.exports = { KEYS, FIXTURES, makeSync, seedHub, ready };
