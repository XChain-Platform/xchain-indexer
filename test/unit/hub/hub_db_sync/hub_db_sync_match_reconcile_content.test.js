// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const HubDbSync = require('../../../../src/hub/hub_db_sync.js');

function match(id, matchId, effectiveTime) {
    return { id: id, match_id: matchId, effective_time: effectiveTime, status: 'finalized' };
}

function makeSync(initialRows) {
    const rows = initialRows.map(r => Object.assign({}, r));
    const updates = [];
    let nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1;
    const doQuery = sinon.stub().callsFake(async (sql, args) => {
        if (/^SELECT match_id, effective_time FROM cross_chain_matches/.test(sql))
            return rows.filter(r => r.status === 'finalized')
                .map(r => ({ match_id: r.match_id, effective_time: r.effective_time }));
        if (/^UPDATE cross_chain_matches SET status = 'retracted'/.test(sql)) {
            updates.push(args.slice());
            for (let i = 0; i < args.length; i += 2) {
                let row = rows.find(r => r.status === 'finalized' &&
                    String(r.match_id) === String(args[i]) && Number(r.effective_time) === Number(args[i + 1]));
                if (row) row.status = 'retracted';
            }
            return { affectedRows: args.length / 2 };
        }
        return [];
    });
    const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub-a.test', network: 'regtest' });
    sinon.stub(sync, 'localColumns').resolves(new Set(['id', 'match_id', 'effective_time', 'status']));
    sinon.stub(sync, 'applyRow').callsFake(async (table, incoming) => {
        let row = rows.find(r => String(r.match_id) === String(incoming.match_id));
        if (row) Object.assign(row, incoming, { id: row.id });
        else rows.push(Object.assign({}, incoming, { id: nextId++ }));
    });
    sinon.stub(sync, 'refreshMatchSyncTimestamp').resolves();
    sinon.stub(sync, 'releaseSnapshotWaiters').resolves();
    return { sync, rows, updates };
}

function serve(sync, pages, beforeFetch) {
    let call = 0;
    sinon.stub(sync, 'httpGet').callsFake(async () => {
        if (beforeFetch) beforeFetch(call);
        let page = pages[Math.min(call, pages.length - 1)];
        call++;
        return { rows: page.rows.map(r => Object.assign({}, r)), watermark: page.watermark };
    });
}

describe('HubDbSync match retraction content reconciliation @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('uses match content when local and hub ids are unrelated', async function () {
        const { sync, rows } = makeSync([match(9001, 'GONE', 40)]);
        serve(sync, [{ rows: [match(3, 'KEPT', 30)], watermark: 100 }]);

        await sync.bootstrapTable('cross_chain_matches');
        await sync.bootstrapTable('cross_chain_matches');

        assert.strictEqual(rows.find(r => r.match_id === 'GONE').status, 'retracted');
    });

    it('marks a pre-drain finalized match the hub did not serve', async function () {
        const { sync, rows, updates } = makeSync([match(17, 'GONE', 40)]);
        serve(sync, [{ rows: [], watermark: 100 }]);

        await sync.bootstrapTable('cross_chain_matches');
        await sync.bootstrapTable('cross_chain_matches');

        assert.strictEqual(rows[0].status, 'retracted');
        assert.deepStrictEqual(updates, [['GONE', 40]]);
    });

    it('does not mark a match the complete drain served', async function () {
        const { sync, rows, updates } = makeSync([match(17, 'KEPT', 40)]);
        serve(sync, [{ rows: [match(2, 'KEPT', 40)], watermark: 100 }]);

        await sync.bootstrapTable('cross_chain_matches');
        await sync.bootstrapTable('cross_chain_matches');

        assert.strictEqual(rows[0].status, 'finalized');
        assert.deepStrictEqual(updates, []);
    });

    it('does not mark a finalized match that arrives after the drain snapshot', async function () {
        const { sync, rows, updates } = makeSync([]);
        serve(sync, [{ rows: [], watermark: 100 }], call => {
            if (call === 1) rows.push(match(500, 'MID-DRAIN', 40));
        });

        await sync.bootstrapTable('cross_chain_matches');
        await sync.bootstrapTable('cross_chain_matches');

        assert.strictEqual(rows[0].status, 'finalized');
        assert.deepStrictEqual(updates, []);
    });

    it('does not mark on the first certified drain after the hub address moves', async function () {
        const { sync, rows, updates } = makeSync([match(17, 'GONE', 40)]);
        serve(sync, [{ rows: [], watermark: 100 }]);

        await sync.bootstrapTable('cross_chain_matches');
        sync.hubUrl = 'http://hub-b.test';
        await sync.bootstrapTable('cross_chain_matches');

        assert.strictEqual(rows[0].status, 'finalized');
        assert.deepStrictEqual(updates, []);

        await sync.bootstrapTable('cross_chain_matches');
        assert.strictEqual(rows[0].status, 'retracted', 'the next complete drain at hub B may judge it');
    });

    it('does not mark a match beyond the drain certified watermark', async function () {
        const { sync, rows, updates } = makeSync([match(17, 'TOO-NEW', 101)]);
        serve(sync, [{ rows: [], watermark: 100 }]);

        await sync.bootstrapTable('cross_chain_matches');
        await sync.bootstrapTable('cross_chain_matches');

        assert.strictEqual(rows[0].status, 'finalized');
        assert.deepStrictEqual(updates, []);
    });

    it('does not mark anything after an incomplete drain', async function () {
        const { sync, rows, updates } = makeSync([match(17, 'GONE', 40)]);
        serve(sync, [{ rows: [match(2, 'KEPT', 30)], watermark: 100 }]);
        await sync.bootstrapTable('cross_chain_matches');
        sync.applyRow.restore();
        sinon.stub(sync, 'applyRow').rejects(new Error('write failed'));

        assert.strictEqual(await sync.bootstrapTable('cross_chain_matches'), null);
        assert.strictEqual(rows.find(r => r.match_id === 'GONE').status, 'finalized');
        assert.deepStrictEqual(updates, []);
    });
});
