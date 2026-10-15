// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A reconnect to the same hub instance keeps the per-table wire positions, which only
// covers appends. Each shape below is a hub change made under an id the mirror had already
// paged past, or a deletion the hub never replays, while the mirror was away. Every one of
// them must reach the mirror on the next connection, and nothing may certify before the
// reconciliation passes have run.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const { HUB_SCHEMA_VERSION } = require('../../../../../src/hub/hub_schema_version');
const { mirrorUpsertSql } = require('../../../../../src/hub/hub_db_sync/row_upserts.js');
const { KEYS, FIXTURES, makeSync, seedHub, ready } = require('./helpers/fake_mirror.js');

// Connect, drain the table, drop the socket, let the hub change while away, then reconnect
// to the same instance and drain again.
async function awayAndBack(ctx, table, change) {
    ready(ctx.sync);
    await ctx.sync.bootstrapTable(table);
    ctx.sync.resetOnSocketClose();
    change(ctx.hub[table]);
    ctx.seen.applied.length = 0;
    ctx.seen.pages.length = 0;
    ready(ctx.sync);
    return ctx.sync.bootstrapTable(table);
}

describe('HubDbSync same-instance reconnect re-pages the in-place tables @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    const IN_PLACE = [
        ['price_snapshots', 'price batch_block_time stamp', (rows) => { rows[1].batch_block_time = 5500; }, 'batch_block_time', 5500],
        ['price_snapshots', 'price skipped to finalized', (rows) => { rows[1].price = '0.9'; rows[1].source_action_index = 599; }, 'price', '0.9'],
        ['cross_chain_calls', 'call re-finalized after a retraction', (rows) => { rows[1].push_generation = 1; rows[1].effective_time = 7190; }, 'effective_time', 7190],
        ['bridge_transfers', 'bridge revive', (rows) => { rows[1].push_generation = 1; rows[1].effective_time = 7290; }, 'effective_time', 7290],
        ['oracle_prices', 'oracle generation republish', (rows) => { rows[1].push_generation = 1; rows[1].value = '222'; }, 'value', '222'],
    ];
    for (const [table, shape, change, col, want] of IN_PLACE) {
        it('re-serves a ' + shape + ' made below the stored position', async function () {
            const ctx = makeSync();
            seedHub(ctx.hub, table, 3);
            const mark = await awayAndBack(ctx, table, change);
            assert.strictEqual(mark, 9000, table + ' drains in full');
            assert.strictEqual(ctx.seen.pages[0].since, 0, table + ' re-pages from zero');
            const row = ctx.local[table].find(r => KEYS[table].every(k => String(r[k]) === String(ctx.hub[table][1][k])));
            assert.strictEqual(String(row[col]), String(want), 'the in-place change reached the mirror');
        });
    }

    it('clears a price round the hub DELETEd while away (unsigned retraction)', async function () {
        const ctx = makeSync();
        seedHub(ctx.hub, 'price_snapshots', 3);
        await awayAndBack(ctx, 'price_snapshots', (rows) => { rows.splice(2, 1); });
        assert.deepStrictEqual(ctx.local.price_snapshots.map(r => r.round_number).sort(), [1, 2]);
    });

    it('clears an oracle row the hub DELETEd while away (F3, unsigned retraction)', async function () {
        const ctx = makeSync();
        seedHub(ctx.hub, 'oracle_prices', 3);
        await awayAndBack(ctx, 'oracle_prices', (rows) => { rows.splice(2, 1); });
        assert.deepStrictEqual(ctx.local.oracle_prices.map(r => r.action_index).sort(), [701, 702]);
        assert.strictEqual(ctx.seen.deletes.length, 1);
    });

    it('keeps the append-only tables on their stored position', async function () {
        const ctx = makeSync();
        seedHub(ctx.hub, 'state_checkpoints', 3);
        await awayAndBack(ctx, 'state_checkpoints', (rows) => { rows.push(Object.assign(FIXTURES.state_checkpoints(4), { id: 4 })); });
        assert.strictEqual(ctx.seen.pages[0].since, 3);
        assert.strictEqual(ctx.local.state_checkpoints.length, 4);
    });

    it('certifies nothing while a table is still owed its re-page', function () {
        const ctx = makeSync();
        ready(ctx.sync);
        assert.strictEqual(ctx.sync.certifyFullDrain([9000], ctx.sync._wsEpoch), false);
        assert.strictEqual(ctx.sync._bootstrapDrained, false);
    });
});

describe('HubDbSync oracle retraction reconciliation (F3) @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('spares a row that landed after the drain opened', async function () {
        const ctx = makeSync();
        seedHub(ctx.hub, 'oracle_prices', 2);
        ready(ctx.sync);
        await ctx.sync.bootstrapTable('oracle_prices');
        // A live row applied after the last page: local, never served by this drain.
        ctx.local.oracle_prices.push(Object.assign(FIXTURES.oracle_prices(9), { id: 50 }));
        const served = new Set(['ltc\u0000701', 'ltc\u0000702']);
        await ctx.sync.reconcileRetractedOracleRows(served, true, 2);
        assert.strictEqual(ctx.local.oracle_prices.length, 3);
        assert.strictEqual(ctx.seen.deletes.length, 0);
    });

    it('refuses when no local row matches a served key, and skips on a truncated key set', async function () {
        const ctx = makeSync();
        ctx.local.oracle_prices.push(Object.assign(FIXTURES.oracle_prices(1), { id: 1 }));
        await ctx.sync.reconcileRetractedOracleRows(new Set(['nope\u00001']), true, 1);
        await ctx.sync.reconcileRetractedOracleRows(new Set(), false, 1);
        assert.strictEqual(ctx.seen.deletes.length, 0);
        assert.strictEqual(ctx.local.oracle_prices.length, 1);
    });
});

describe('HubDbSync forced resync is a full drain @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('a terminate (close 1006) cannot resume a stored position', function () {
        const ctx = makeSync();
        ready(ctx.sync);
        ctx.sync._drainPositions.state_checkpoints = 12;
        ctx.sync.ws = { terminate() {} };
        ctx.sync.driveResync('test');
        ctx.sync.resetOnSocketClose();
        ready(ctx.sync);
        assert.strictEqual(ctx.sync._drainPositions.state_checkpoints, undefined);
    });

    it('with no socket the direct re-bootstrap starts every table from zero', async function () {
        const ctx = makeSync();
        ready(ctx.sync);
        ctx.sync._drainPositions.state_checkpoints = 12;
        ctx.sync.ws = null;
        sinon.stub(ctx.sync, 'bootstrapAll').resolves();
        ctx.sync.driveResync('test');
        const cursor = await ctx.sync.resolveDrainCursor('state_checkpoints', null);
        assert.strictEqual(cursor.lastId, 0);
    });
});

describe('HubDbSync schema-mismatch latch survives an incremental drain @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    function refused(sync) {
        return sync.handleRowEvent({ type: 'row:inserted', table: 'state_checkpoints', schema_version: HUB_SCHEMA_VERSION + 1,
                                     row: Object.assign(FIXTURES.state_checkpoints(2), { id: 2 }) });
    }

    it('stays set until every table re-paged from zero after the refusal', async function () {
        const ctx = makeSync();
        seedHub(ctx.hub, 'state_checkpoints', 3);
        ready(ctx.sync);
        await ctx.sync.bootstrapTable('state_checkpoints');
        await refused(ctx.sync);
        assert.strictEqual(ctx.sync._schemaMismatchSeen, true);
        // The table that carried the refused row re-pages from zero, not from its position.
        ctx.seen.pages.length = 0;
        await ctx.sync.bootstrapTable('state_checkpoints');
        assert.strictEqual(ctx.seen.pages[0].since, 0);
        // Other tables are still owed, so a certify now must not clear the latch.
        assert.strictEqual(ctx.sync.certifyFullDrain([9000], ctx.sync._wsEpoch), false);
        assert.strictEqual(ctx.sync._schemaMismatchSeen, true);
    });

    it('a drain opened before the refusal cannot settle it', async function () {
        const ctx = makeSync();
        ready(ctx.sync);
        // Owed first, so the drain opens under a real mark; the refusal then re-marks it.
        ctx.sync.markRepageOwed(['state_checkpoints']);
        const drain = { table: 'state_checkpoints', repageSeq: ctx.sync.repageOwedSeq('state_checkpoints') };
        assert.notStrictEqual(drain.repageSeq, undefined);
        await refused(ctx.sync);
        ctx.sync.settleRepageOwed(drain);
        assert.notStrictEqual(ctx.sync.repageOwedSeq('state_checkpoints'), undefined, 'the newer mark survives');
        // A drain opened under the newer mark does settle it.
        ctx.sync.settleRepageOwed({ table: 'state_checkpoints', repageSeq: ctx.sync.repageOwedSeq('state_checkpoints') });
        assert.strictEqual(ctx.sync.repageOwedSeq('state_checkpoints'), undefined);
    });
});

describe('HubDbSync bridge_transfers revive upsert @regression @tier1', function () {
    it('takes a finalized row at a strictly higher push_generation, fence last', function () {
        const cols = ['transfer_id', 'effective_time', 'validator_signatures', 'snapshot_block', 'finalizing_view',
                      'btc_chain_id', 'status', 'push_generation'];
        const sql = mirrorUpsertSql('bridge_transfers', cols);
        assert.match(sql, /^INSERT INTO bridge_transfers .* ON DUPLICATE KEY UPDATE /);
        assert.match(sql, /VALUES\(`status`\) = 'finalized' AND COALESCE\(VALUES\(`push_generation`\), 0\) > COALESCE\(`push_generation`, 0\)/);
        const sets = sql.split(' ON DUPLICATE KEY UPDATE ')[1];
        assert.match(sets, /, `push_generation` = GREATEST\(COALESCE\(`push_generation`, 0\), COALESCE\(VALUES\(`push_generation`\), 0\)\)$/,
            'the gate column is assigned last');
        assert.ok(!/`transfer_id` =|`amount` =/.test(sets), 'only the hub revive columns move');
    });
});
