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
const Database  = require('../../src/db.js');

// The three hub-mirrored cross-chain tables are scoped by `network` alone, and on regtest
// one network name spans every Bitcoin chain a venue has ever had: a re-genesis that leaves
// the hub database in place keeps serving the dead chain's finalized matches and capability
// snapshots to every fresh indexer. `btc_chain_id` is the hash of BITCOIN BLOCK 1 on the
// chain the writing hub follows (block 0 is a chainparams constant on regtest and identical
// across re-genesises), and this suite drives the mirror's whole use of it: the apply-time
// refusal, where the expectation comes from, when it may change, and the purge that closes
// the window where rows landed before the identity was known.
describe('HubDbSync btc_chain_id chain fence @regression @tier2', function () {

    afterEach(function () { sinon.restore(); });

    // Two 64-hex chain ids, distinguishable at a glance in an assertion failure.
    const CHAIN_NEW = '1a2b3c4d5e6f' + '0'.repeat(52);
    const CHAIN_OLD = '9f8e7d6c5b4a' + 'f'.repeat(52);

    const MATCH_COLUMNS = ['id', 'match_id', 'network', 'a_chain', 'b_chain', 'effective_time',
                           'status', 'anchor_txid', 'btc_chain_id'];

    // A row shaped like a mirrored match, with whichever chain id the case is about.
    function matchRow(id, chainId) {
        return {
            id: id, match_id: 'm' + id, network: 'regtest', a_chain: 'BTC', b_chain: 'DOGE',
            effective_time: 1000 + id, status: 'finalized', anchor_txid: null, btc_chain_id: chainId
        };
    }

    // A HubDbSync over a fake hub DB that records every statement and answers the shapes the
    // paths under test issue. `deleted` is what a chain-id purge reports as removed.
    function makeSync(opts) {
        opts = opts || {};
        const seen = { sql: [] };
        const doQuery = sinon.stub().callsFake(async (sql, args) => {
            seen.sql.push({ sql: sql, args: args });
            if (/^DELETE FROM /.test(sql))        return { affectedRows: opts.deleted || 0 };
            if (/^SELECT MAX\(id\)/.test(sql))    return [{ max_id: null }];
            if (/^SELECT MAX\(effective_time\)/.test(sql)) return [{ ts: null }];
            return [];
        });
        const sync = new HubDbSync({ doQuery }, {
            hubUrl: 'http://hub.test', network: opts.network || 'regtest', coin: opts.coin || 'BTC'
        });
        sinon.stub(sync, '_localColumns').resolves(new Set(opts.columns || MATCH_COLUMNS));
        return { sync, seen, doQuery };
    }

    // Serve one snapshot page: the hub's rows plus the envelope's own chain-id statement.
    function stubHub(sync, rows, chainId, watermark) {
        return sinon.stub(sync, '_httpGet').callsFake(async () => ({
            rows: rows, btc_chain_id: chainId, watermark: (watermark === undefined ? 4242 : watermark)
        }));
    }

    // Both apply shapes: the cross-chain upsert (INSERT ... ON DUPLICATE KEY UPDATE) and
    // the default mirror apply (INSERT IGNORE INTO).
    const inserts   = (seen) => seen.sql.filter((q) => /^INSERT /.test(q.sql));
    const chainDels = (seen) => seen.sql.filter((q) => /btc_chain_id IS NOT NULL AND btc_chain_id <> \?$/.test(q.sql));
    const lines     = (spy)  => spy.getCalls().map((c) => c.args.map(String).join(' '));

    // ── The apply-time refusal ───────────────────────────────────────────────────

    it('refuses a row carrying another chain id, and applies NULL and matching rows', async function () {
        const { sync, seen } = makeSync({});
        await sync.setExpectedBtcChainId(CHAIN_NEW, 'local');

        assert.strictEqual(await sync._applyRow('cross_chain_matches', matchRow(1, CHAIN_OLD)), false,
            'a relic row must report that it was not applied');
        assert.strictEqual(inserts(seen).length, 0, 'a refused row must never reach the database');

        await sync._applyRow('cross_chain_matches', matchRow(2, null));
        await sync._applyRow('cross_chain_matches', matchRow(3, CHAIN_NEW));
        assert.strictEqual(inserts(seen).length, 2,
            'a NULL id (written before the column existed) and this chain\'s own id both apply');
    });

    it('applies every row while no expectation is known yet', async function () {
        const { sync, seen } = makeSync({});
        await sync._applyRow('cross_chain_matches', matchRow(1, CHAIN_OLD));
        assert.strictEqual(inserts(seen).length, 1,
            'the fence refuses only on positive evidence, never on ignorance of this chain');
    });

    it('fences only the three cross-chain tables', async function () {
        const { sync, seen } = makeSync({ columns: ['id', 'network', 'btc_chain_id'] });
        await sync.setExpectedBtcChainId(CHAIN_NEW, 'local');
        await sync._applyRow('state_checkpoints', { id: 1, network: 'regtest', btc_chain_id: CHAIN_OLD });
        assert.strictEqual(inserts(seen).length, 1, 'no other mirrored table carries this identity');
    });

    it('refuses relics through the drain, counts them in one line and still completes the page', async function () {
        const warn = sinon.stub(console, 'warn');
        const log  = sinon.stub(console, 'log');
        const { sync, seen } = makeSync({});
        await sync.setExpectedBtcChainId(CHAIN_NEW, 'local');
        stubHub(sync, [matchRow(1, CHAIN_OLD), matchRow(2, CHAIN_OLD), matchRow(3, null), matchRow(4, CHAIN_NEW)],
                CHAIN_NEW);

        const mark = await sync._bootstrapTable('cross_chain_matches');

        assert.strictEqual(mark, 4242, 'a relic is not a hole: the drain completes and the watermark stands');
        const applied = inserts(seen);
        assert.strictEqual(applied.length, 2, 'only the NULL row and this chain\'s row are mirrored');
        assert.ok(applied.every((q) => !q.args.includes(CHAIN_OLD)), 'no relic value reached the database');

        const refusal = lines(warn).filter((l) => /refused \d+ cross_chain_matches row/.test(l));
        assert.strictEqual(refusal.length, 1, 'one line per foreign chain, not one per row');
        assert.strictEqual(refusal[0],
            'HubDbSync: refused 2 cross_chain_matches row(s) carrying btc_chain_id ' + CHAIN_OLD +
            ' (this chain is ' + CHAIN_NEW + ')');
        assert.ok(lines(log).some((l) => /bootstrapped 2 rows into cross_chain_matches/.test(l)),
            'the drain must not count refused rows as mirrored');
    });

    it('keeps the three cross-chain tables off the batch path, which has no per-row verdict', async function () {
        const { sync } = makeSync({});
        await sync.setExpectedBtcChainId(CHAIN_NEW, 'local');
        for (const table of ['cross_chain_matches', 'cross_chain_calls', 'capability_snapshots']) {
            assert.strictEqual(await sync._applyRowsBatched(table, [matchRow(1, CHAIN_OLD), matchRow(2, CHAIN_OLD)]),
                false, table + ' must fall to the per-row path where the fence runs');
        }
    });

    // ── Where the expectation comes from ─────────────────────────────────────────

    it('learns the id from the snapshot envelope while bootstrapping each cross-chain table', async function () {
        sinon.stub(console, 'log');
        for (const table of ['cross_chain_matches', 'cross_chain_calls', 'capability_snapshots']) {
            const { sync } = makeSync({});
            stubHub(sync, [], CHAIN_NEW);
            await sync._bootstrapTable(table);
            assert.strictEqual(sync._expectedBtcChainId, CHAIN_NEW, table + ' envelope must arm the fence');
            assert.strictEqual(sync._btcChainIdSource, 'hub', 'an envelope value is second-hand, never local');
        }
    });

    it('ignores an envelope id on a table that carries no chain identity', async function () {
        sinon.stub(console, 'log');
        const { sync } = makeSync({ columns: ['id', 'network'] });
        stubHub(sync, [], CHAIN_NEW);
        await sync._bootstrapTable('state_checkpoints');
        assert.strictEqual(sync._expectedBtcChainId, null);
    });

    it('never lets a hub value replace this node\'s own measurement', async function () {
        const warn = sinon.stub(console, 'warn');
        sinon.stub(console, 'log');
        const { sync } = makeSync({});
        await sync.setExpectedBtcChainId(CHAIN_NEW, 'local');

        assert.strictEqual(await sync.setExpectedBtcChainId(CHAIN_OLD, 'hub'), false);
        assert.strictEqual(sync._expectedBtcChainId, CHAIN_NEW);
        assert.strictEqual(sync._btcChainIdSource, 'local');
        assert.ok(lines(warn).some((l) => /the hub follows a different chain/.test(l) && l.includes(CHAIN_OLD)),
            'the disagreement is the hub\'s to explain, and it must be said out loud');
    });

    it('ignores a null or malformed id rather than dropping the fence', async function () {
        const warn = sinon.stub(console, 'warn');
        sinon.stub(console, 'log');
        const { sync } = makeSync({});
        await sync.setExpectedBtcChainId(CHAIN_NEW, 'hub');

        assert.strictEqual(await sync.setExpectedBtcChainId(null, 'hub'), false,
            'a hub that has not been told its chain states nothing');
        assert.strictEqual(await sync.setExpectedBtcChainId('not-a-hash', 'hub'), false);
        assert.strictEqual(await sync.setExpectedBtcChainId(CHAIN_NEW, 'nonsense'), false);
        assert.strictEqual(sync._expectedBtcChainId, CHAIN_NEW, 'the fence stands through all three');
        assert.ok(lines(warn).some((l) => /malformed btc_chain_id/.test(l)));
    });

    // ── The live-row adoption path ───────────────────────────────────────────────

    it('adopts a new id for a live row when the hub now advertises it, then applies the row', async function () {
        sinon.stub(console, 'warn');
        sinon.stub(console, 'log');
        const { sync, seen } = makeSync({ deleted: 2 });
        await sync.setExpectedBtcChainId(CHAIN_OLD, 'hub');
        const httpGet = sinon.stub(sync, '_httpGet').resolves({ rows: [], btc_chain_id: CHAIN_NEW });
        seen.sql.length = 0;

        await sync._handleRowEvent({ type: 'row:inserted', table: 'cross_chain_matches', row: matchRow(7, CHAIN_NEW) });

        assert.strictEqual(httpGet.callCount, 1, 'exactly one envelope re-read');
        assert.match(httpGet.firstCall.args[0], /^\/hub-db\/snapshot\/capability_snapshots\?since_id=0&limit=1$/);
        assert.strictEqual(sync._expectedBtcChainId, CHAIN_NEW, 'the hub restated its identity; the mirror follows');
        assert.strictEqual(inserts(seen).length, 1, 'the row applies once the mirror is on its chain');
        assert.strictEqual(chainDels(seen).length, 3, 'adopting a new chain purges the previous chain\'s rows');
    });

    it('refuses a live row the hub does not vouch for, and re-probes only once per id', async function () {
        const warn = sinon.stub(console, 'warn');
        sinon.stub(console, 'log');
        const { sync, seen } = makeSync({});
        await sync.setExpectedBtcChainId(CHAIN_OLD, 'hub');
        const httpGet = sinon.stub(sync, '_httpGet').resolves({ rows: [], btc_chain_id: CHAIN_OLD });
        seen.sql.length = 0;

        await sync._handleRowEvent({ type: 'row:inserted', table: 'cross_chain_matches', row: matchRow(7, CHAIN_NEW) });
        await sync._handleRowEvent({ type: 'row:inserted', table: 'cross_chain_matches', row: matchRow(8, CHAIN_NEW) });

        assert.strictEqual(httpGet.callCount, 1, 'a stream of foreign rows must not storm the hub');
        assert.strictEqual(sync._expectedBtcChainId, CHAIN_OLD);
        assert.strictEqual(inserts(seen).length, 0, 'neither row is applied');
        assert.strictEqual(lines(warn).filter((l) => /refused 1 cross_chain_matches row/.test(l)).length, 2,
            'each refused live row is reported as it happens');
    });

    it('never re-reads the hub for a locally measured expectation', async function () {
        const warn = sinon.stub(console, 'warn');
        sinon.stub(console, 'log');
        const { sync, seen } = makeSync({});
        await sync.setExpectedBtcChainId(CHAIN_NEW, 'local');
        const httpGet = sinon.stub(sync, '_httpGet').resolves({ rows: [], btc_chain_id: CHAIN_OLD });
        seen.sql.length = 0;

        await sync._handleRowEvent({ type: 'row:inserted', table: 'cross_chain_matches', row: matchRow(9, CHAIN_OLD) });

        assert.strictEqual(httpGet.callCount, 0, 'this node read its own block 1; nothing the hub says can move it');
        assert.strictEqual(sync._expectedBtcChainId, CHAIN_NEW);
        assert.strictEqual(inserts(seen).length, 0);
        assert.ok(lines(warn).some((l) => /the hub follows a different chain/.test(l)));
    });

    // ── The purge on an expectation change ───────────────────────────────────────

    it('purges the previous chain\'s rows from all three tables and reports the counts', async function () {
        const warn = sinon.stub(console, 'warn');
        sinon.stub(console, 'log');
        const { sync, seen } = makeSync({ deleted: 3 });
        await sync.setExpectedBtcChainId(CHAIN_OLD, 'hub');
        seen.sql.length = 0;

        await sync.setExpectedBtcChainId(CHAIN_NEW, 'hub');

        const dels = chainDels(seen);
        assert.deepStrictEqual(dels.map((q) => q.sql), [
            'DELETE FROM cross_chain_matches WHERE btc_chain_id IS NOT NULL AND btc_chain_id <> ?',
            'DELETE FROM cross_chain_calls WHERE btc_chain_id IS NOT NULL AND btc_chain_id <> ?',
            'DELETE FROM capability_snapshots WHERE btc_chain_id IS NOT NULL AND btc_chain_id <> ?'
        ]);
        assert.ok(dels.every((q) => q.args[0] === CHAIN_NEW), 'the predicate keeps THIS chain, and NULLs stay');
        for (const table of ['cross_chain_matches', 'cross_chain_calls', 'capability_snapshots'])
            assert.ok(lines(warn).includes('HubDbSync: purged 3 ' + table + ' row(s) from chain ' + CHAIN_OLD),
                'the purge of ' + table + ' must be reported with its count and the chain it cleared');
        assert.strictEqual(seen.sql.filter((q) => /^SELECT MAX\(effective_time\) AS ts FROM cross_chain_matches/.test(q.sql)).length, 1,
            'a purge that removed the newest match must re-read the barrier the way a retraction does');
        assert.strictEqual(seen.sql.filter((q) => /^SELECT MAX\(effective_time\) AS ts FROM cross_chain_calls/.test(q.sql)).length, 1);
    });

    it('purges on the FIRST id it learns, which is the only reach into rows applied before it', async function () {
        sinon.stub(console, 'warn');
        sinon.stub(console, 'log');
        const { sync, seen } = makeSync({ deleted: 0 });

        await sync.setExpectedBtcChainId(CHAIN_NEW, 'local');

        assert.strictEqual(chainDels(seen).length, 3,
            'rows mirrored before block 1 existed carry a foreign id no later delivery re-offers');
    });

    it('does not re-purge when the same id is restated', async function () {
        sinon.stub(console, 'warn');
        sinon.stub(console, 'log');
        const { sync, seen } = makeSync({ deleted: 0 });
        await sync.setExpectedBtcChainId(CHAIN_NEW, 'hub');
        seen.sql.length = 0;

        assert.strictEqual(await sync.setExpectedBtcChainId(CHAIN_NEW, 'hub'), false);
        assert.strictEqual(chainDels(seen).length, 0);
    });

    // ── The identity read ────────────────────────────────────────────────────────

    it('reads a block hash from the decoder database by joining blocks to its hash row', async function () {
        const doQueryStrict = sinon.stub().resolves([{ hash: 'AB' + 'c'.repeat(62) }]);
        const hash = await Database.prototype.getDecoderBlockHash.call({ doQueryStrict: doQueryStrict }, 1);

        assert.strictEqual(doQueryStrict.callCount, 1);
        const sql = doQueryStrict.firstCall.args[0].replace(/\s+/g, ' ').trim();
        assert.strictEqual(sql, 'SELECT t.hash AS hash FROM blocks b JOIN index_transactions t ON t.id = ' +
            'b.block_hash_id WHERE b.block_index = ? LIMIT 1');
        assert.deepStrictEqual(doQueryStrict.firstCall.args[1], [1]);
        assert.strictEqual(hash, 'ab' + 'c'.repeat(62), 'the id is compared lowercase everywhere it is used');
    });

    it('answers null for a block the decoder does not hold, and for a failed read', async function () {
        assert.strictEqual(
            await Database.prototype.getDecoderBlockHash.call({ doQueryStrict: sinon.stub().resolves([]) }, 1), null,
            'a chain with no block 1 yet is "not known", so the caller retries on a later block');
        assert.strictEqual(
            await Database.prototype.getDecoderBlockHash.call(
                { doQueryStrict: sinon.stub().rejects(new Error('lock wait timeout')) }, 1), null,
            'the identity is transport, so a decoder fault must never reach the block loop');
    });
});
