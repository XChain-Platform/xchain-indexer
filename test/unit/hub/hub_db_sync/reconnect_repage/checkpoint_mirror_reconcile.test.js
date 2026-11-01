// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const HubDbSync = require('../../../../../src/hub/hub_db_sync.js');
const { HUB_SCHEMA_VERSION } = require('../../../../../src/hub/hub_schema_version');

function checkpoint(id, lineage) {
    const byte = lineage === 'A' ? 'a' : 'b';
    return {
        id: id,
        chain: 'BTC',
        network: 'regtest',
        checkpoint_seq: id,
        block_index: (lineage === 'A' ? 1000 : 2000) + id,
        block_hash: byte.repeat(62) + String(id).padStart(2, '0'),
        ledger_hash: byte.repeat(64),
        actions_hash: (lineage === 'A' ? 'c' : 'd').repeat(64),
        contract_hash: (lineage === 'A' ? 'e' : 'f').repeat(64),
        snapshot_block: 500 + id,
        validator_signatures: '[]'
    };
}

function key(row) {
    return [row.chain, row.network, row.checkpoint_seq].join('|');
}

function makeSync(localRows, hubRows, options) {
    const local = localRows.map(row => Object.assign({}, row));
    let nextId = local.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1;
    const writes = [];
    let fetches = 0;
    const hubDb = {
        doQuery: sinon.stub().callsFake(async (sql, args) => {
            if (/^SELECT \* FROM state_checkpoints/.test(sql)) return local.map(row => Object.assign({}, row));
            if (/^REPLACE INTO state_checkpoints/.test(sql)) {
                writes.push('replace');
                const columns = /\(([^)]*)\) VALUES/.exec(sql)[1].split(',')
                    .map(column => column.replace(/`/g, '').trim());
                const incoming = Object.fromEntries(columns.map((column, i) => [column, args[i]]));
                const at = local.findIndex(row => key(row) === key(incoming));
                if (at !== -1) local.splice(at, 1);
                local.push(Object.assign(incoming, { id: nextId++ }));
                return { affectedRows: 2 };
            }
            if (/^DELETE FROM state_checkpoints WHERE id IN/.test(sql)) {
                writes.push('delete');
                for (const id of args) {
                    const at = local.findIndex(row => Number(row.id) === Number(id));
                    if (at !== -1) local.splice(at, 1);
                }
                return { affectedRows: args.length };
            }
            return [];
        })
    };
    hubDb.doQueryStrict = hubDb.doQuery;
    const sync = new HubDbSync(hubDb, { hubUrl: 'http://hub.test', network: 'regtest' });
    sinon.stub(sync, 'localColumns').resolves(new Set(['id'].concat(Object.keys(checkpoint(1, 'A')))));
    sinon.stub(sync, 'mirrorNetworkScope').resolves('regtest');
    sinon.stub(sync, 'purgeForeignNetworkRows').resolves(0);
    sinon.stub(sync, 'applyRow').callsFake(async (table, row) => {
        const at = local.findIndex(existing => key(existing) === key(row));
        if (at === -1) local.push(Object.assign({}, row, { id: nextId++ }));
    });
    sinon.stub(sync, 'httpGet').callsFake(async path => {
        fetches++;
        if (options && options.incompleteReconcile && fetches > 1)
            return { schema_version: HUB_SCHEMA_VERSION };
        const since = Number(/since_id=(\d+)/.exec(path)[1]);
        return {
            schema_version: HUB_SCHEMA_VERSION,
            watermark: 9000,
            rows: hubRows.filter(row => Number(row.id) > since).map(row => Object.assign({}, row))
        };
    });
    return { sync, local, writes };
}

describe('HubDbSync checkpoint mirror lineage reconciliation @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('replaces a longer lineage A with exactly the complete lineage B re-page', async function () {
        const lineageA = [1, 2, 3, 4, 5].map(id => checkpoint(id, 'A'));
        const lineageB = [1, 2, 3].map(id => checkpoint(id, 'B'));
        const { sync, local } = makeSync(lineageA, lineageB);

        assert.strictEqual(await sync.bootstrapTable('state_checkpoints'), 9000);

        const actual = local.slice().sort((a, b) => a.checkpoint_seq - b.checkpoint_seq);
        assert.deepStrictEqual(actual.map(row => row.checkpoint_seq), [1, 2, 3]);
        assert.deepStrictEqual(actual.map(row => row.block_index), lineageB.map(row => row.block_index));
        assert.deepStrictEqual(actual.map(row => row.block_hash), lineageB.map(row => row.block_hash));
        assert.deepStrictEqual(actual.map(row => row.ledger_hash), lineageB.map(row => row.ledger_hash));
        assert.deepStrictEqual(actual.map(row => row.actions_hash), lineageB.map(row => row.actions_hash));
        assert.deepStrictEqual(actual.map(row => row.contract_hash), lineageB.map(row => row.contract_hash));
    });

    it('leaves lineage A untouched when the re-page is incomplete', async function () {
        const lineageA = [1, 2, 3, 4, 5].map(id => checkpoint(id, 'A'));
        const lineageB = [1, 2, 3].map(id => checkpoint(id, 'B'));
        const { sync, local, writes } = makeSync(lineageA, lineageB, { incompleteReconcile: true });
        const before = local.map(row => Object.assign({}, row));

        assert.strictEqual(await sync.bootstrapTable('state_checkpoints'), null);

        assert.deepStrictEqual(local, before);
        assert.deepStrictEqual(writes, []);
    });
});
