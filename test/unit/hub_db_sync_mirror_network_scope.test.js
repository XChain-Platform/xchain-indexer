// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const HubDbSync = require('../../src/hub_db_sync.js');

// The bootstrap cursor for a hub-mirrored table is since_id = MAX(local id), which is a
// position in the CURRENT hub's auto-increment space. Rows a different hub served share
// none of that space: their ids can sit above every id the current hub holds (so since_id
// asks for rows past the end of the hub's table and the drain reports zero rows on every
// attempt) and they occupy the ids the current hub's own rows carry (so the id-parity
// INSERT IGNORE apply drops the real row without an error). This suite drives that whole
// shape through _bootstrapTable.
describe('HubDbSync mirror network scope @regression @tier2', function () {

    afterEach(function () { sinon.restore(); });

    // A HubDbSync over a fake hub DB that answers only the two statements the bootstrap
    // cursor path issues, and records them. `local` is the simulated local mirror content:
    // foreign is the row count for a network other than `network`, scopedMax/unscopedMax
    // are what MAX(id) returns with and without the network predicate.
    function makeSync(opts) {
        const seen = { deletes: [], maxIds: [], order: [] };
        const doQuery = sinon.stub().callsFake(async (sql, args) => {
            if (/^DELETE FROM /.test(sql)) {
                seen.deletes.push({ sql: sql, args: args });
                seen.order.push('delete');
                return { affectedRows: opts.foreign || 0 };
            }
            if (/^SELECT MAX\(id\)/.test(sql)) {
                const scoped = / WHERE network = \?$/.test(sql);
                seen.maxIds.push({ sql: sql, args: args, scoped: scoped });
                seen.order.push('maxid');
                const v = scoped ? opts.scopedMax : opts.unscopedMax;
                return [{ max_id: (v === undefined ? null : v) }];
            }
            return [];
        });
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test', network: opts.network });
        sinon.stub(sync, '_localColumns').resolves(new Set(opts.columns || ['id', 'network', 'chain']));
        sinon.stub(sync, '_applyRow').resolves();
        return { sync, seen, doQuery };
    }

    // Serve the hub's table honestly: only rows whose id is above the requested since_id,
    // so a cursor pointing past the end of the hub's table yields nothing, exactly as the
    // live hub behaves.
    function stubHub(sync, ids, watermark) {
        const rows = ids.map((id) => ({ id: id, network: 'testnet' }));
        return sinon.stub(sync, '_httpGet').callsFake(async (path) => {
            const since = Number(/since_id=(\d+)/.exec(path)[1]);
            return { rows: rows.filter((r) => r.id > since), watermark: watermark };
        });
    }

    function sinceIds(httpGet) {
        return httpGet.getCalls().map((c) => Number(/since_id=(\d+)/.exec(c.args[0])[1]));
    }

    it('drains a hub whose ids all sit BELOW a block of foreign rows the mirror still holds', async function () {
        // The measured shape: 132 rows for another network occupy ids 1-132 locally while
        // the hub this mirror follows holds 66 rows at ids 1-66.
        const { sync, seen } = makeSync({ network: 'testnet', foreign: 132, unscopedMax: 132, scopedMax: null });
        const hubIds = Array.from({ length: 66 }, (_, i) => i + 1);
        const httpGet = stubHub(sync, hubIds, 4242);

        const mark = await sync._bootstrapTable('state_checkpoints');

        assert.strictEqual(seen.deletes.length, 1, 'the foreign rows must be cleared');
        assert.match(seen.deletes[0].sql, /^DELETE FROM state_checkpoints WHERE network <> \?$/);
        assert.deepStrictEqual(seen.deletes[0].args, ['testnet']);
        assert.deepStrictEqual(sinceIds(httpGet), [0], 'the cursor must not be seeded from a foreign id');
        assert.strictEqual(sync._applyRow.callCount, 66, 'every row the hub holds must be mirrored');
        assert.strictEqual(mark, 4242);
    });

    it('clears the foreign rows BEFORE reading the cursor', async function () {
        const { sync, seen } = makeSync({ network: 'testnet', foreign: 132, unscopedMax: 132, scopedMax: null });
        stubHub(sync, [1, 2], 7);
        await sync._bootstrapTable('state_checkpoints');
        assert.strictEqual(seen.order[0], 'delete', 'a cursor read before the purge reads the foreign rows');
    });

    it('resumes incrementally from the local cursor when no foreign rows are present', async function () {
        const { sync, seen } = makeSync({ network: 'testnet', foreign: 0, unscopedMax: 40, scopedMax: 40 });
        const httpGet = stubHub(sync, [10, 20, 40, 45, 50], 900);

        const mark = await sync._bootstrapTable('state_checkpoints');

        assert.deepStrictEqual(sinceIds(httpGet), [40], 'a clean mirror must still resume, not re-page');
        assert.strictEqual(sync._applyRow.callCount, 2, 'only rows above the cursor are fetched');
        assert.strictEqual(mark, 900);
        assert.ok(seen.maxIds.every((q) => q.scoped), 'the cursor read is network-scoped');
    });

    it('starts at 0 on an empty local table', async function () {
        const { sync } = makeSync({ network: 'testnet', foreign: 0, unscopedMax: null, scopedMax: null });
        const httpGet = stubHub(sync, [1, 2, 3], 11);

        assert.strictEqual(await sync._bootstrapTable('state_checkpoints'), 11);
        assert.deepStrictEqual(sinceIds(httpGet), [0]);
        assert.strictEqual(sync._applyRow.callCount, 3);
    });

    it('re-pages from 0 and keeps every local row when the hub holds fewer rows than the mirror', async function () {
        // Same network on both sides, so no row is provably foreign; the hub's advertised
        // ceiling is the only evidence that the local cursor is not in its id space.
        const { sync, seen } = makeSync({ network: 'testnet', foreign: 0, unscopedMax: 40, scopedMax: 40 });
        sync._readyMaxIds = { state_checkpoints: 20 };
        const httpGet = stubHub(sync, Array.from({ length: 20 }, (_, i) => i + 1), 55);

        const mark = await sync._bootstrapTable('state_checkpoints');

        assert.deepStrictEqual(sinceIds(httpGet), [0], 'a cursor above the hub ceiling must start over');
        assert.strictEqual(sync._applyRow.callCount, 20);
        assert.strictEqual(mark, 55);
        assert.strictEqual(seen.deletes.length, 1, 'only the network purge runs');
        assert.deepStrictEqual(seen.deletes[0].args, ['testnet'],
            'rows the hub does not carry are never deleted on that basis alone');
    });

    it('leaves the cursor alone when the local mirror sits at or below the hub ceiling', async function () {
        const { sync } = makeSync({ network: 'testnet', foreign: 0, unscopedMax: 20, scopedMax: 20 });
        sync._readyMaxIds = { state_checkpoints: 20 };
        const httpGet = stubHub(sync, [20, 21, 22], 60);

        await sync._bootstrapTable('state_checkpoints');
        assert.deepStrictEqual(sinceIds(httpGet), [20], 'an equal ceiling is a valid position, not a mismatch');
    });

    it('deletes nothing and stays unscoped when the consumer names no network', async function () {
        // The display mirror in the explorer constructs this client without a network, so
        // it cannot prove which rows are foreign and must behave exactly as before.
        const { sync, seen } = makeSync({ network: undefined, foreign: 0, unscopedMax: 132, scopedMax: null });
        const httpGet = stubHub(sync, [1, 2, 3], 5);

        await sync._bootstrapTable('state_checkpoints');

        assert.strictEqual(seen.deletes.length, 0, 'no network, no deletion');
        assert.ok(seen.maxIds.every((q) => !q.scoped), 'no network, no scoped read');
        assert.deepStrictEqual(sinceIds(httpGet), [132]);
    });

    it('deletes nothing and stays unscoped for a mirrored table with no network column', async function () {
        const { sync, seen } = makeSync({
            network: 'testnet', foreign: 0, unscopedMax: 7, scopedMax: null,
            columns: ['id', 'source_chain', 'action_index']
        });
        const httpGet = stubHub(sync, [7, 8], 3);

        await sync._bootstrapTable('oracle_prices');

        assert.strictEqual(seen.deletes.length, 0, 'a table without the column cannot be scoped');
        assert.ok(seen.maxIds.every((q) => !q.scoped));
        assert.deepStrictEqual(sinceIds(httpGet), [7]);
    });

    it('scopes the ready-message catch-up read to the same network', async function () {
        const { sync, seen } = makeSync({ network: 'testnet', foreign: 132, unscopedMax: 132, scopedMax: null });
        sync._readyMaxIds = { state_checkpoints: 66 };
        stubHub(sync, Array.from({ length: 66 }, (_, i) => i + 1), 8);

        await sync._bootstrapTable('state_checkpoints');

        assert.ok(seen.maxIds.length >= 2, 'the catch-up re-reads the local max');
        assert.ok(seen.maxIds.every((q) => q.scoped && q.args[0] === 'testnet'),
            'an unscoped catch-up read compares a foreign id against this hub ceiling');
    });

    it('keeps bootstrapping when the purge itself fails', async function () {
        const { sync } = makeSync({ network: 'testnet', foreign: 0, unscopedMax: null, scopedMax: null });
        sync.hubDb.doQuery = sinon.stub().callsFake(async (sql) => {
            if (/^DELETE FROM /.test(sql)) throw new Error('lock wait timeout');
            return [{ max_id: null }];
        });
        stubHub(sync, [1, 2], 12);
        assert.strictEqual(await sync._bootstrapTable('state_checkpoints'), 12);
        assert.strictEqual(sync._applyRow.callCount, 2);
    });
});
