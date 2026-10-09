// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const HubDbSync = require('../../../../src/hub/hub_db_sync.js');
const { AUTO_INCREMENT_ID_TABLES } = require('../../../../src/hub/hub_db_sync/mirror_tables.js');

const CASES = {
    price_snapshots: {
        key: ['round_number', 'coin_pair'],
        row: { round_number: 2, coin_pair: 'BTC/USD', status: 'skipped', price: null },
        upgrade: { status: 'finalized', price: '12.5' }
    },
    oracle_prices: {
        key: ['source_chain', 'action_index'],
        row: { source_chain: 'BTC', action_index: 2, push_generation: 1, value: '1' },
        upgrade: { push_generation: 2, value: '2' }
    },
    cross_chain_matches: {
        key: ['match_id'],
        row: { match_id: 'b'.repeat(64), anchor_txid: null, effective_time: 2, status: 'finalized' },
        upgrade: { anchor_txid: 'c'.repeat(64), effective_time: 3 }
    },
    cross_chain_calls: {
        key: ['call_id', 'phase'],
        row: { call_id: 'call-b', phase: 'request', status: 'pending', push_generation: 1, effective_time: 2 },
        upgrade: { status: 'finalized', push_generation: 2, effective_time: 3 }
    },
    capability_snapshots: {
        key: ['snapshot_block', 'capability', 'signing_pubkey', 'source'],
        row: { snapshot_block: 2, capability: 'cross_chain', signing_pubkey: 'b'.repeat(64), source: 'stake-b' }
    },
    bridge_transfers: {
        key: ['transfer_id'], row: { transfer_id: 'transfer-b', network: 'regtest', status: 'finalized' }
    },
    policy_snapshots: {
        key: ['network', 'origin_chain', 'tick', 'policy_seq'],
        row: { network: 'regtest', origin_chain: 'BTC', tick: 'TICK-B', policy_seq: 2, snapshot_id: 'policy-b' }
    },
    list_snapshots: {
        key: ['network', 'home_chain', 'home_list_index', 'seq'],
        row: { network: 'regtest', home_chain: 'BTC', home_list_index: 2, seq: 2, snapshot_id: 'list-b' }
    },
    remote_token_snapshots: {
        key: ['snapshot_id'],
        row: { snapshot_id: 'd'.repeat(64), network: 'regtest', coin: 'DOGE', tick: 'TICK-B',
               snapshot_block: 2, source_action_index: 3, status: 'finalized' }
    },
    state_checkpoints: {
        key: ['chain', 'network', 'checkpoint_seq'],
        row: { chain: 'BTC', network: 'regtest', checkpoint_seq: 2, block_index: 2 }
    },
    anchor_reward_attestations: {
        key: ['chain', 'network', 'reward_type', 'round_reference', 'snapshot_block', 'publisher'],
        row: { chain: 'BTC', network: 'regtest', reward_type: 'anchor_BTC', round_reference: 2,
               snapshot_block: 2, publisher: 'b'.repeat(64) }
    },
    attestation_responses: {
        key: ['network', 'request_id', 'effective_time'],
        row: { network: 'regtest', request_id: 'request-b', effective_time: 2, status: 'ok' }
    }
};

function keyOf(row, cols) {
    return cols.map(c => String(row[c])).join('|');
}

function differentRow(spec) {
    const row = Object.assign({}, spec.row);
    const col = spec.key[spec.key.length - 1];
    row[col] = typeof row[col] === 'number' ? row[col] + 100 : 'old-' + row[col];
    return row;
}

function makeSync(table, spec) {
    const local = [Object.assign({ id: 400, marker: 'old' }, differentRow(spec))];
    const writes = [];
    const hubDb = {
        doQuery: sinon.stub().resolves([]),
        doQueryStrict: sinon.stub().callsFake(async (sql, args) => {
            writes.push({ sql, args });
            const match = new RegExp('INSERT(?: IGNORE)? INTO ' + table + ' \\(([^)]*)\\)').exec(sql);
            assert.ok(match, 'expected an insert for ' + table + ': ' + sql);
            const cols = match[1].split(',').map(c => c.replace(/`/g, '').trim());
            const incoming = Object.fromEntries(cols.map((c, i) => [c, args[i]]));
            const found = local.find(r => keyOf(r, spec.key) === keyOf(incoming, spec.key));
            if (found) {
                if (/ON DUPLICATE KEY UPDATE/.test(sql)) Object.assign(found, incoming);
                return { affectedRows: /ON DUPLICATE KEY UPDATE/.test(sql) ? 2 : 0 };
            }
            incoming.id = Math.max(...local.map(r => r.id)) + 1;
            local.push(incoming);
            return { affectedRows: 1 };
        })
    };
    hubDb.doQuery = hubDb.doQueryStrict;
    const sync = new HubDbSync(hubDb, { hubUrl: 'http://hub.test', network: 'regtest' });
    sinon.stub(sync, 'localColumns').resolves(new Set(['id', 'marker'].concat(Object.keys(spec.row), Object.keys(spec.upgrade || {}))));
    sinon.stub(sync, 'refuseUnprovenCapabilitySnapshot').resolves(false);
    return { sync, local, writes };
}

describe('HubDbSync content-keyed apply @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    for (const [table, spec] of Object.entries(CASES)) {
        it(table + ' ignores a colliding wire id and dedupes or upgrades on content', async function () {
            const { sync, local, writes } = makeSync(table, spec);
            const incoming = Object.assign({ id: 400, marker: 'first' }, spec.row);
            await sync.applyRow(table, incoming);

            assert.strictEqual(local.length, 2, 'the unrelated old-id row must remain and the content-distinct row must land');
            assert.strictEqual(local[0].id, 400);
            assert.strictEqual(local[0].marker, 'old');
            assert.strictEqual(local[1].id, 401, 'an existing mirror with old ids must keep allocating local ids');
            assert.ok(writes.every(w => !/\bid\b/.test(/\(([^)]*)\) VALUES/.exec(w.sql)[1])),
                'no emitted INSERT may name the wire id');

            await sync.applyRow(table, Object.assign({}, incoming, spec.upgrade || {}, { id: 999, marker: 'second' }));
            assert.strictEqual(local.length, 2, 'the content key must dedupe the re-delivery regardless of wire id');
            if (/ON DUPLICATE KEY UPDATE/.test(writes[1].sql))
                assert.strictEqual(local[1].marker, 'second', 'the table upgrade path must still update content');
            else
                assert.strictEqual(local[1].marker, 'first', 'insert-only content must remain unchanged');
        });
    }

    it('the price batch path also strips every wire id', async function () {
        const spec = CASES.price_snapshots;
        const { sync, writes } = makeSync('price_snapshots', spec);
        const rows = [1, 2].map(id => Object.assign({ id }, spec.row, { round_number: id + 10 }));
        assert.strictEqual(await sync.applyRowsBatched('price_snapshots', rows), true);
        assert.ok(!/\bid\b/.test(/\(([^)]*)\) VALUES/.exec(writes[0].sql)[1]));
        assert.strictEqual(writes[0].args.length, Object.keys(spec.row).length * 2,
            'each tuple contains content columns, never id');
    });

    it('refuses startup when any legacy id column lacks AUTO_INCREMENT', async function () {
        const seen = [];
        const hubDb = { doQuery: sinon.stub().callsFake(async sql => {
            seen.push(sql);
            return [{ Field: 'id', Extra: /policy_snapshots/.test(sql) ? '' : 'auto_increment' }];
        }) };
        const sync = new HubDbSync(hubDb, { hubUrl: 'http://hub.test' });
        await assert.rejects(() => sync.assertAutoIncrementMirrorIds(), /policy_snapshots/);
        assert.strictEqual(seen.length, AUTO_INCREMENT_ID_TABLES.length);
    });
});
