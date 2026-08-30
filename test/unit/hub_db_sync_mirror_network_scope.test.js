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

    // Two separate claims, and the delete is the one that needs justifying.
    //
    // _purgeForeignNetworkRows sets the bar: page contents may never justify a delete,
    // because a filtered endpoint, a paging hole or a partial drain can each make a valid
    // row LOOK unserved. The tests below hold that line, and nothing here relaxes it.
    //
    // An advertised ceiling is not page contents. It is the source's own MAX(id) for the
    // table, stated in the subscription ready frame, and none of those three hazards can
    // move it. It is also unfiltered for every table that reaches this comparison, since
    // the two ceilings computed with a status filter belong to FULL_REPAGE_TABLES, whose
    // cursor is already 0.
    //
    // Restarting the cursor alone leaves the mirror broken: the apply is id-parity
    // INSERT IGNORE, so the hub's real row 5 is silently dropped by a stale local row 5
    // that a rebuilt hub's id space now reuses. _applyRow is stubbed in this file, so a
    // callCount assertion proves rows were OFFERED and never that they landed; the
    // integration suite covers the collision against a real database.
    it('clears the scope and re-pages when the local cursor sits above the hub ceiling', async function () {
        // Same network on both sides, so no row is provably foreign; the hub's advertised
        // ceiling is the only evidence that the local cursor is not in its id space.
        const { sync, seen } = makeSync({ network: 'testnet', foreign: 0, unscopedMax: 40, scopedMax: 40 });
        sync._readyMaxIds = { state_checkpoints: 20 };
        const httpGet = stubHub(sync, Array.from({ length: 20 }, (_, i) => i + 1), 55);

        const mark = await sync._bootstrapTable('state_checkpoints');

        assert.deepStrictEqual(sinceIds(httpGet), [0], 'a cursor above the hub ceiling must start over');
        assert.strictEqual(sync._applyRow.callCount, 20);
        assert.strictEqual(mark, 55);
        const scopePurge = seen.deletes.filter((d) => / WHERE network = \?$/.test(d.sql));
        assert.strictEqual(scopePurge.length, 1,
            'the retired id space must be cleared, or INSERT IGNORE drops every row the re-page delivers');
        assert.deepStrictEqual(scopePurge[0].args, ['testnet'], 'the purge is scoped like the cursor that detected it');
    });

    // The rebuilt-hub case, which is the one the ceiling comparison exists for. A hub whose
    // database was dropped and recreated restarts its auto-increment at 1 and therefore
    // advertises max_id 0 until its first row lands, so 0 is the signature of a rebuild and
    // must be read as a measurement. HubDbBroadcaster omits the key entirely when its query
    // throws, which is what makes absent and zero distinguishable here; treating zero as
    // missing information leaves the mirror serving a chain history that no longer exists,
    // with nothing logged and every service reporting healthy.
    it('treats an advertised ceiling of ZERO as authoritative, not as missing information', async function () {
        const { sync, seen } = makeSync({ network: 'testnet', foreign: 0, unscopedMax: 11243, scopedMax: 11243 });
        sync._readyMaxIds = { state_checkpoints: 0 };
        const httpGet = stubHub(sync, [], 77);

        const mark = await sync._bootstrapTable('state_checkpoints');

        assert.deepStrictEqual(sinceIds(httpGet), [0], 'an empty source is still a position: start over');
        const scopePurge = seen.deletes.filter((d) => / WHERE network = \?$/.test(d.sql));
        assert.strictEqual(scopePurge.length, 1, 'a rebuilt hub must not leave the old id space behind');
        assert.deepStrictEqual(scopePurge[0].args, ['testnet']);
        assert.strictEqual(mark, 77);
    });

    // ABSENT is not ZERO. An older hub advertises no max_ids at all, and must keep the
    // fail-open behaviour: the field is additive, so a missing ceiling is no evidence of
    // anything and must never authorise a delete. This is the half of the original
    // decision that was right, kept explicit so it cannot be lost to the change above.
    it('never purges on the ceiling basis when the hub advertises no ceiling', async function () {
        const { sync, seen } = makeSync({ network: 'testnet', foreign: 0, unscopedMax: 40, scopedMax: 40 });
        sync._readyMaxIds = undefined;                        // an older hub, silent on max_ids
        const httpGet = stubHub(sync, [41, 42], 88);

        await sync._bootstrapTable('state_checkpoints');

        assert.deepStrictEqual(sinceIds(httpGet), [40], 'with no ceiling the cursor is all we have; resume');
        assert.strictEqual(seen.deletes.filter((d) => / WHERE network = \?$/.test(d.sql)).length, 0,
            'page contents must never justify deleting a mirrored row');
    });

    // The ceiling says the id space is retired; it does NOT say which rows belong to this
    // mirror. With no proven network the purge would be an unqualified DELETE FROM <table>,
    // which is a whole-table wipe on the strength of evidence about ids alone. The cursor
    // still restarts, so these consumers are left exactly as they were before the fence.
    it('re-pages but never deletes when the mirror has no proven network scope', async function () {
        const { sync, seen } = makeSync({ network: undefined, foreign: 0, unscopedMax: 40, scopedMax: 40 });
        sync._readyMaxIds = { state_checkpoints: 20 };
        const httpGet = stubHub(sync, [1, 2], 33);

        await sync._bootstrapTable('state_checkpoints');

        assert.deepStrictEqual(sinceIds(httpGet), [0], 'the cursor must still restart');
        assert.strictEqual(seen.deletes.length, 0, 'an unscoped delete would clear the whole table');
    });

    // The same guard for a hub that advertises other tables but not this one, which is how
    // a partially-upgraded hub presents. Reading a missing key as 0 would wipe the mirror.
    it('never purges when the hub advertises a ceiling for other tables but not this one', async function () {
        const { sync, seen } = makeSync({ network: 'testnet', foreign: 0, unscopedMax: 40, scopedMax: 40 });
        sync._readyMaxIds = { oracle_prices: 5 };
        const httpGet = stubHub(sync, [41], 99);

        await sync._bootstrapTable('state_checkpoints');

        assert.deepStrictEqual(sinceIds(httpGet), [40]);
        assert.strictEqual(seen.deletes.filter((d) => / WHERE network = \?$/.test(d.sql)).length, 0,
            'a key this hub never stated is absent, not zero');
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
