// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const HubDbSync = require('../../../../src/hub/hub_db_sync.js');
const { HUB_SCHEMA_VERSION } = require('../../../../src/hub/hub_schema_version');

const COLUMNS = ['id', 'source_address', 'source_chain', 'coin', 'tick', 'fiat', 'value',
                 'fee', 'memo', 'block_time', 'effective_at', 'action_index',
                 'push_generation', 'created_at'];

const HUB_ROW = {
    id: 7,
    source_address: 'oracle-address',
    source_chain: 'BTC',
    coin: 'BTC',
    tick: 'XCP',
    fiat: 'USD',
    value: '2.50',
    fee: '0.01',
    memo: 'generation 7',
    block_time: 1700000000,
    effective_at: 1700086400,
    action_index: 42,
    push_generation: 7,
    created_at: '2026-10-02 00:00:00',
};

function columnsFromInsert(sql) {
    const match = /^INSERT INTO oracle_prices \(([^)]+)\)/.exec(sql);
    assert.ok(match, 'oracle row must use the generation-aware upsert: ' + sql);
    return match[1].split(',').map(column => column.trim().replaceAll('`', ''));
}

function makeMirror(initialRow) {
    const state = { row: { ...initialRow }, paths: [], writes: [] };
    const doQuery = sinon.stub().callsFake(async (sql, args) => {
        if (/^SELECT MAX\(id\) AS max_id FROM oracle_prices/.test(sql)) return [{ max_id: state.row.id }];
        if (/^INSERT INTO oracle_prices/.test(sql)) {
            const columns = columnsFromInsert(sql);
            const incoming = Object.fromEntries(columns.map((column, index) => [column, args[index]]));
            state.writes.push(sql);
            if (incoming.push_generation >= state.row.push_generation) {
                for (const column of columns) {
                    if (!['id', 'source_chain', 'action_index'].includes(column)) state.row[column] = incoming[column];
                }
            }
            return { affectedRows: 2 };
        }
        return [];
    });
    const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
    sinon.stub(sync, 'localColumns').resolves(new Set(COLUMNS));
    sinon.stub(sync, 'refreshOracleSyncTimestamp').resolves();
    sinon.stub(sync, 'httpGet').callsFake(async path => {
        state.paths.push(path);
        const sinceId = Number(new URL(path, 'http://hub.test').searchParams.get('since_id'));
        return { schema_version: HUB_SCHEMA_VERSION, rows: HUB_ROW.id > sinceId ? [{ ...HUB_ROW }] : [], watermark: 1700086400 };
    });
    return { sync, state };
}

describe('HubDbSync oracle_prices generation convergence @regression @tier1', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('re-pages two mirrors from zero and converges both to the newer generation in one pass', async function () {
        const older = makeMirror({ ...HUB_ROW, value: '1.25', memo: 'generation 6', push_generation: 6 });
        const newer = makeMirror({ ...HUB_ROW });

        assert.notDeepStrictEqual(older.state.row, newer.state.row);
        assert.strictEqual(await older.sync.bootstrapTable('oracle_prices'), 1700086400);
        assert.strictEqual(await newer.sync.bootstrapTable('oracle_prices'), 1700086400);

        for (const mirror of [older, newer]) {
            assert.match(mirror.state.paths[0], /[?&]since_id=0(?:&|$)/);
            assert.deepStrictEqual(mirror.state.row, HUB_ROW);
            assert.strictEqual(mirror.state.writes.length, 1);

            const update = mirror.state.writes[0].split(' ON DUPLICATE KEY UPDATE ')[1];
            assert.ok(update, 'the re-paged row must take the incremental upsert path');
            for (const column of COLUMNS.filter(column =>
                !['id', 'source_chain', 'action_index', 'push_generation'].includes(column))) {
                assert.ok(update.includes('`' + column + '` = IF(VALUES(`push_generation`) >= `push_generation`, ' +
                    'VALUES(`' + column + '`), `' + column + '`)'), column + ' must follow the generation gate');
            }
            assert.ok(update.endsWith('push_generation = IF(VALUES(`push_generation`) >= `push_generation`, ' +
                'VALUES(`push_generation`), `push_generation`)'), 'the generation assignment must remain last');
        }
    });
});
