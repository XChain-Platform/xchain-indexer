/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/reorg-catchup-cursor.test.js
 *
 * Regression coverage for the mid-catch-up reorg-recheck cursor refresh in
 * XChainIndexer.start(). The outer loop reads lastProcessedReorgId once, processes
 * every unprocessed decoder reorg via createReorg() (which advances the durable
 * cursor), then re-checks for a mid-catch-up reorg via getReorgsSince() inside the
 * inner block loop. Previously the local lastProcessedReorgId was NOT refreshed after
 * createReorg(), so the recheck re-selected the just-processed reorgs (their decoder
 * event ids all exceed the stale cursor) and broke to the outer loop once per reorg -
 * correctness-neutral but a spurious inner-exit/outer-re-entry.
 *
 * The catch-up loop lives inside start() (not importable in isolation), so these
 * tests exercise the REAL db cursor primitives it composes - getReorgsSince,
 * getLastProcessedReorgId, createReorg - over an in-memory events store and assert
 * the two load-bearing properties:
 *   1. After refreshing the cursor to the newest recorded marker, the recheck no
 *      longer re-selects the just-processed reorgs (the spurious break is gone).
 *   2. A genuinely NEW reorg (higher decoder event id) is STILL selected against the
 *      refreshed cursor - so real reorgs are never missed. This is the invariant the
 *      fix must not regress.
 */

'use strict';

const assert   = require('assert');
const crypto   = require('crypto');
const Database = require('../../src/db');

// sha256 of a data payload, matching db._hashReorgData (the #2735 witness hash).
function reorgHash(data) {
    return crypto.createHash('sha256').update(String(data == null ? '' : data), 'utf8').digest('hex');
}

// Minimal indexer stub: db constructor only touches indexer.config + indexer.util.
function stubIndexer() {
    return {
        config: {},
        util: {
            isNull: (v) => v === null || v === undefined,
            logError: () => {}
        }
    };
}

// Build a Database whose doQuery/doQueryStrict run against an in-memory `events`
// table, faithfully emulating the exact query shapes the reorg primitives issue.
// `code` is always 'REORG' for these rows. Row = { id, data } where data is a JSON
// string (decoder side: array of orphaned blocks; indexer side: marker object).
function makeDb(seedRows) {
    const db = new Database('h', 0, 'd', 'u', 'p', stubIndexer());
    const rows = seedRows.map((r) => ({ id: r.id, data: r.data, time: r.time, witness_time: r.witness_time, witness_hash: r.witness_hash }));
    let nextId = rows.reduce((m, r) => Math.max(m, r.id), 0) + 1;

    const exec = (query, args) => {
        // getReorgsSince: bounded  -> id > ?
        if (/WHERE code='REORG' AND id > \?/.test(query)) {
            const after = Number(args[0]);
            return rows.filter((r) => r.id > after)
                       .sort((a, b) => a.id - b.id)
                       .map((r) => ({ id: r.id, data: r.data }));
        }
        // getReorgsSince: unbounded (null cursor) -> all, ascending
        if (/WHERE code='REORG' ORDER BY id ASC/.test(query)) {
            return rows.slice().sort((a, b) => a.id - b.id).map((r) => ({ id: r.id, data: r.data }));
        }
        // #2735 witness the cursor row / getReorgEventWitness -> the single REORG row at this id
        if (/SELECT time, data FROM events WHERE id = \? AND code='REORG'/.test(query)) {
            return rows.filter((r) => r.id === Number(args[0])).map((r) => ({ time: r.time, data: r.data }));
        }
        // #2735 getLastProcessedReorgWitness -> newest-first data + witness columns
        if (/SELECT data, witness_time, witness_hash FROM events WHERE code='REORG' ORDER BY id DESC/.test(query)) {
            return rows.slice().sort((a, b) => b.id - a.id)
                       .map((r) => ({ data: r.data, witness_time: r.witness_time == null ? null : r.witness_time, witness_hash: r.witness_hash == null ? null : r.witness_hash }));
        }
        // getLastProcessedReorgId / warnOnLegacyReorgCursor -> newest-first data scan
        if (/SELECT data FROM events WHERE code='REORG' ORDER BY id DESC/.test(query)) {
            return rows.slice().sort((a, b) => b.id - a.id).map((r) => ({ data: r.data }));
        }
        // RE-1 incarnation guard -> newest REORG event id
        if (/SELECT MAX\(id\) AS max_id FROM events WHERE code='REORG'/.test(query)) {
            return [{ max_id: rows.length ? rows.reduce((m, r) => Math.max(m, r.id), 0) : null }];
        }
        // createReorg -> INSERT a marker row (carrying the #2735 witness columns when supplied)
        if (/INSERT INTO events/.test(query)) {
            rows.push({ id: nextId++, data: args[0], witness_time: args[1] != null ? args[1] : null, witness_hash: args[2] != null ? args[2] : null });
            return { affectedRows: 1 };
        }
        throw new Error('unexpected query in test harness: ' + query);
    };

    db.doQuery       = async (q, a) => exec(q, a);
    db.doQueryStrict = async (q, a) => exec(q, a);
    return db;
}

// A decoder REORG event row: data is a JSON array of orphaned blocks.
function decoderReorg(id, blockIndex) {
    return { id, data: JSON.stringify([{ block_index: blockIndex, block_hash: 'a'.repeat(64) }]) };
}

describe('reorg catch-up cursor refresh (XChainIndexer.start REORG-6 recheck)', function () {

    it('re-selects just-processed reorgs when the cursor is NOT refreshed (the bug)', async function () {
        // Two decoder reorgs land between iterations (ids 10, 11). The indexer starts
        // with no recorded markers, so the pre-processing cursor is null.
        const decoderDb        = makeDb([decoderReorg(10, 6241887), decoderReorg(11, 6241890)]);
        const indexerReorgView = makeDb([]);

        let lastProcessedReorgId = await indexerReorgView.getLastProcessedReorgId();
        assert.strictEqual(lastProcessedReorgId, null, 'no markers yet -> null cursor');

        const unprocessed = await decoderDb.getReorgsSince(lastProcessedReorgId);
        assert.deepStrictEqual(unprocessed.map((r) => r.id), [10, 11]);

        // Process them (advances the durable cursor) but do NOT refresh the local var.
        for (const reorg of unprocessed)
            await indexerReorgView.createReorg(reorg.block_index, reorg.id);

        // Mid-catch-up recheck with the stale cursor re-selects both reorgs -> spurious break.
        const midReorgs = await decoderDb.getReorgsSince(lastProcessedReorgId);
        assert.strictEqual(midReorgs.length, 2, 'stale cursor re-selects the just-processed reorgs');
    });

    it('does NOT re-select just-processed reorgs once the cursor is refreshed (the fix)', async function () {
        const decoderDb        = makeDb([decoderReorg(10, 6241887), decoderReorg(11, 6241890)]);
        const indexerReorgView = makeDb([]);

        let lastProcessedReorgId = await indexerReorgView.getLastProcessedReorgId();
        const unprocessed = await decoderDb.getReorgsSince(lastProcessedReorgId);

        for (const reorg of unprocessed)
            await indexerReorgView.createReorg(reorg.block_index, reorg.id);

        // The fix: re-read the durable cursor after createReorg advances it.
        lastProcessedReorgId = await indexerReorgView.getLastProcessedReorgId();
        assert.strictEqual(lastProcessedReorgId, 11, 'refreshed cursor = newest recorded marker id');

        const midReorgs = await decoderDb.getReorgsSince(lastProcessedReorgId);
        assert.strictEqual(midReorgs.length, 0, 'refreshed cursor eliminates the spurious break');
    });

    it('STILL selects a genuinely new reorg against the refreshed cursor (real reorgs never missed)', async function () {
        const decoderDb        = makeDb([decoderReorg(10, 6241887), decoderReorg(11, 6241890)]);
        const indexerReorgView = makeDb([]);

        let lastProcessedReorgId = await indexerReorgView.getLastProcessedReorgId();
        const unprocessed = await decoderDb.getReorgsSince(lastProcessedReorgId);
        for (const reorg of unprocessed)
            await indexerReorgView.createReorg(reorg.block_index, reorg.id);
        lastProcessedReorgId = await indexerReorgView.getLastProcessedReorgId();

        // A real reorg lands mid-catch-up: decoder event id strictly greater than any
        // processed id (events.id is a monotonic autoincrement, so this always holds).
        const withNewReorg = makeDb([
            decoderReorg(10, 6241887), decoderReorg(11, 6241890), decoderReorg(12, 6241950)
        ]);
        const midReorgs = await withNewReorg.getReorgsSince(lastProcessedReorgId);
        assert.deepStrictEqual(midReorgs.map((r) => r.id), [12],
            'the new reorg (id 12 > cursor 11) is still detected; the refresh does not mask it');
        assert.strictEqual(midReorgs[0].block_index, 6241950);
    });
});

//  / RE-1: the cursor is a decoder events.id and the decoder never deletes
// events rows, so a cursor above the decoder's newest REORG id can only mean an
// out-of-band decoder rebuild/restore (AUTO_INCREMENT reset). getReorgsSince used
// to return [] forever in that state, silently disabling all future rollbacks.
describe('reorg cursor incarnation guard ( / RE-1)', function () {

    it('throws when the cursor exceeds the decoder\'s newest REORG event id (rebuilt decoder DB)', async function () {
        // Decoder rebuilt: its REORG history restarts at small ids (here: one event, id 3).
        const rebuiltDecoderDb = makeDb([decoderReorg(3, 100)]);
        await assert.rejects(() => rebuiltDecoderDb.getReorgsSince(50), /Reorg cursor incoherent \(RE-1\)/);
    });

    it('throws when the decoder has NO reorg history but the indexer has a cursor', async function () {
        const emptyDecoderDb = makeDb([]);
        await assert.rejects(() => emptyDecoderDb.getReorgsSince(50), /Reorg cursor incoherent \(RE-1\)/);
    });

    it('returns [] normally when the cursor equals the decoder\'s newest REORG id (steady state)', async function () {
        const decoderDb = makeDb([decoderReorg(10, 6241887), decoderReorg(11, 6241890)]);
        assert.deepStrictEqual(await decoderDb.getReorgsSince(11), []);
    });

    it('a null cursor (fresh indexer) never trips the guard', async function () {
        const emptyDecoderDb = makeDb([]);
        assert.deepStrictEqual(await emptyDecoderDb.getReorgsSince(null), []);
    });
});

// #2735: witness the cursor row to close the UNDER-cursor silent skip. A rebuilt decoder whose
// fresh AUTO_INCREMENT id space overtook a stranded cursor returns non-empty id>afterId results,
// so the over-cursor guard (RE-1 above) never sees it. The additive witness check catches it.
describe('reorg cursor under-cursor witness guard (#2735)', function () {
    // A decoder REORG event with an explicit time (so witness comparison is meaningful).
    function reorgRow(id, blockIndex, time) {
        return { id, time, data: JSON.stringify([{ block_index: blockIndex, block_hash: 'a'.repeat(64) }]) };
    }

    it('(a) witnessed marker whose cursor row is MISSING throws RE-1', async function () {
        // Decoder rebuilt: cursor id 50 no longer exists (only id 3 remains).
        const decoderDb = makeDb([reorgRow(3, 100, '2026-07-19 00:00:00')]);
        const witness   = { time: '2026-07-01 00:00:00', hash: reorgHash('whatever') };
        await assert.rejects(() => decoderDb.getReorgsSince(50, witness), /Reorg cursor incoherent \(RE-1\)/);
    });

    it('(b) witnessed marker whose live time/hash MISMATCHES throws RE-1', async function () {
        // The cursor id 10 still exists, but its live content differs from the recorded witness
        // (a new-incarnation event landed on the reused id).
        const row       = reorgRow(10, 100, '2026-07-19 12:00:00');
        const decoderDb = makeDb([row, reorgRow(11, 150, '2026-07-19 12:05:00')]);
        const staleWitness = { time: '2026-07-01 00:00:00', hash: reorgHash('a totally different payload') };
        await assert.rejects(() => decoderDb.getReorgsSince(10, staleWitness), /Reorg cursor incoherent \(RE-1\)/);
    });

    it('(b2) a MATCHING witness does not throw and returns the newer reorgs', async function () {
        const row       = reorgRow(10, 100, '2026-07-19 12:00:00');
        const decoderDb = makeDb([row, reorgRow(11, 150, '2026-07-19 12:05:00')]);
        const goodWitness = { time: row.time, hash: reorgHash(row.data) };
        const result = await decoderDb.getReorgsSince(10, goodWitness);
        assert.deepStrictEqual(result.map(r => r.id), [11]);
    });

    it('(c) a legacy null-witness marker falls back to the old guard (no throw at steady state)', async function () {
        const decoderDb = makeDb([reorgRow(10, 100, '2026-07-19 12:00:00'), reorgRow(11, 150, '2026-07-19 12:05:00')]);
        // Cursor row exists, no witness supplied -> no under-cursor comparison; old guard sees a
        // steady-state cursor (== newest id) and does not throw.
        assert.deepStrictEqual(await decoderDb.getReorgsSince(11, null), []);
    });

    it('(d) happy path: witnessed cursor still returns every newer reorg', async function () {
        const row       = reorgRow(5, 90, '2026-07-19 11:00:00');
        const decoderDb = makeDb([row, reorgRow(6, 200, '2026-07-19 11:05:00'), reorgRow(7, 150, '2026-07-19 11:06:00')]);
        const goodWitness = { time: row.time, hash: reorgHash(row.data) };
        const result = await decoderDb.getReorgsSince(5, goodWitness);
        assert.deepStrictEqual(result, [{ id: 6, block_index: 200 }, { id: 7, block_index: 150 }]);
    });

    it('createReorg persists the witness columns; getLastProcessedReorgWitness reads them back', async function () {
        const indexerView = makeDb([]);
        await indexerView.createReorg(200, 7, '2026-07-19 12:00:00', reorgHash('payload7'));
        const w = await indexerView.getLastProcessedReorgWitness();
        assert.deepStrictEqual(w, { time: '2026-07-19 12:00:00', hash: reorgHash('payload7') });
    });

    it('getLastProcessedReorgWitness returns null for a legacy marker with no witness columns', async function () {
        const indexerView = makeDb([]);
        await indexerView.createReorg(200, 7); // no witness args -> NULL columns
        assert.strictEqual(await indexerView.getLastProcessedReorgWitness(), null);
    });
});
