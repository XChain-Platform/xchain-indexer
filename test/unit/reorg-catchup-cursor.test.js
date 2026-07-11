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
const Database = require('../../src/db');

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
    const rows = seedRows.map((r) => ({ id: r.id, data: r.data }));
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
        // getLastProcessedReorgId / warnOnLegacyReorgCursor -> newest-first data scan
        if (/SELECT data FROM events WHERE code='REORG' ORDER BY id DESC/.test(query)) {
            return rows.slice().sort((a, b) => b.id - a.id).map((r) => ({ data: r.data }));
        }
        // createReorg -> INSERT a marker row
        if (/INSERT INTO events/.test(query)) {
            rows.push({ id: nextId++, data: args[0] });
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
