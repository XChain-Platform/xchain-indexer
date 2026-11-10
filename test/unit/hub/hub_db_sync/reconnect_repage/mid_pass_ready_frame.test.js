// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A bootstrap pass can start with no socket open (a retry timer firing just after a
// close). When the next socket's ready frame lands part way through that pass, it owes
// the per-connection tables a fresh re-page, and the bootstrapAll the new connection
// calls finds the pass still running. That call must not be dropped: the running pass
// has to re-page the owed tables itself and certify on the new connection, rather than
// ending partial and leaving the recovery to the slow bootstrap retry.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const { makeSync } = require('./helpers/fake_mirror.js');
const { REPAGE_PER_CONNECTION_TABLES } = require('../../../../../src/hub/hub_db_sync/mirror_tables.js');

const EARLY_TABLES = ['oracle_prices', 'cross_chain_matches', 'cross_chain_calls'];

// Stand in for bootstrapTable with the two facts the verdict reads: the re-page mark a
// drain was opened under (taken at entry, as the real drain does) is the only one it can
// settle, and a full drain returns a mark. `beforeSettle` runs mid-drain of each table.
function scriptDrains(sync, beforeSettle) {
    const calls = [];
    sinon.stub(sync, 'bootstrapTable').callsFake(async (table) => {
        const repageSeq = sync.repageOwedSeq(table);
        calls.push(table);
        await Promise.resolve();
        if (beforeSettle) beforeSettle(table, calls);
        await Promise.resolve();
        sync.settleRepageOwed({ table, repageSeq });
        return 9000;
    });
    return calls;
}

function readyFrame(sync, socket) {
    sync.ws = socket;
    sync.adoptReadyFrame(socket, { type: 'ready', hub_instance_id: 'hub-a', max_ids: {} });
}

function socketlessSync() {
    const ctx = makeSync();
    const sync = ctx.sync;
    sync.running = true;
    // A prior connection closed: the epoch moved, no socket is open, and that close
    // left every per-connection table owed a re-page.
    readyFrame(sync, { id: 'old' });
    sync.resetOnSocketClose();
    const retry = sinon.stub(sync, 'scheduleBootstrapRetry');
    const certify = sinon.spy(sync, 'certifyFullDrain');
    return { ctx, sync, retry, certify };
}

async function newConnectionCertifies(track) {
    const h = socketlessSync();
    const sync = track(h.sync);
    const epoch = sync._wsEpoch;
    assert.strictEqual(sync.ws, null);

    let newConnectionCall = null;
    let delivered = false;
    const calls = scriptDrains(sync, (table) => {
        // Every early table has drained and settled; the socket opens before the
        // next table finishes, with no close in between.
        if (!delivered && table === 'price_snapshots') {
            delivered = true;
            readyFrame(sync, { id: 'new' });
            newConnectionCall = sync.bootstrapAll();
        }
    });

    await sync.bootstrapAll();
    await newConnectionCall;

    assert.ok(delivered, 'the ready frame landed mid-pass');
    assert.strictEqual(sync._wsEpoch, epoch, 'no close happened, so the connection epoch is unchanged');

    const owedRetries = h.retry.getCalls().filter(c =>
        (c.args[0] || []).some(entry => /re-page owed/.test(String(entry))));
    assert.deepStrictEqual(owedRetries.map(c => c.args[0]), [],
        'the pass must not end partial on tables re-marked by the new connection');
    assert.strictEqual(h.retry.callCount, 0, 'the slow bootstrap retry is not the recovery');

    assert.strictEqual(sync.repageOwedTables().length, 0, 'every owed re-page settled');
    assert.strictEqual(sync._bootstrapDrained, true, 'the mirror certifies on the new connection');
    assert.ok(h.certify.calledWith(sinon.match.array, epoch), 'certified under the new connection\'s epoch');

    // The re-marked tables are paged again after the ready frame, in the same logical pass.
    const firstPrice = calls.indexOf('price_snapshots');
    for (const table of REPAGE_PER_CONNECTION_TABLES) {
        assert.ok(calls.indexOf(table, firstPrice + 1) > firstPrice,
            table + ' re-paged after the ready frame');
    }
    for (const table of EARLY_TABLES)
        assert.ok(calls.indexOf(table) < firstPrice, table + ' first drained before the ready frame');
}

async function plainPassUnchanged(track) {
    const ctx = makeSync();
    const sync = track(ctx.sync);
    sync.running = true;
    readyFrame(sync, { id: 'only' });
    const retry = sinon.stub(sync, 'scheduleBootstrapRetry');
    const certify = sinon.spy(sync, 'certifyFullDrain');
    const calls = scriptDrains(sync, null);

    await sync.bootstrapAll();

    assert.strictEqual(retry.callCount, 0);
    assert.strictEqual(certify.callCount, 1);
    assert.strictEqual(sync._bootstrapDrained, true);
    assert.strictEqual(new Set(calls).size, calls.length, 'each table drained exactly once');
}

async function undrainablePassRetriesOnce(track) {
    const h = socketlessSync();
    const sync = track(h.sync);
    let delivered = false;
    sinon.stub(sync, 'bootstrapTable').callsFake(async (table) => {
        if (!delivered && table === 'price_snapshots') {
            delivered = true;
            readyFrame(sync, { id: 'new' });
            sync.bootstrapAll();
        }
        // price_snapshots never drains on this hub: the pass cannot certify.
        return table === 'price_snapshots' ? null : 9000;
    });

    await sync.bootstrapAll();

    assert.strictEqual(sync._bootstrapDrained, false);
    assert.strictEqual(h.retry.callCount, 1, 'exactly one retry is armed for the whole logical pass');
    assert.ok(h.retry.firstCall.args[0].indexOf('price_snapshots') !== -1);
    assert.strictEqual(sync._bootstrapping, false);
}

describe('HubDbSync ready frame during a socketless bootstrap pass @regression @tier1', function () {
    let sync = null;
    const track = (s) => (sync = s);
    afterEach(function () {
        if (sync) sync.stop();
        sync = null;
        sinon.restore();
    });

    it('does not drop the new connection\'s bootstrap; the pass re-pages the owed tables and certifies', () => newConnectionCertifies(track));
    it('leaves a pass with no mid-pass ready frame unchanged: one drain per table, certified, no retry', () => plainPassUnchanged(track));
    it('still ends partial and retries when the pass cannot drain, even with a rerun requested', () => undrainablePassRetriesOnce(track));
});
