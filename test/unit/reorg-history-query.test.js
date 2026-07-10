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
 * test/unit/reorg-history-query.test.js
 *
 * Unit coverage for the getreorghistory RPC's pure logic (api.js delegates to it;
 * startApi is not importable). This RPC is the evidence source for the hub's
 * REORG-OLDHASH-UNVERIFIED-1 fix, so the tests focus on the property the hub relies
 * on: `matched` is true ONLY when the exact (block_index, block_hash) pair was
 * really orphaned by a single reorg event. A false positive here re-opens the
 * fake-reorg rollback; a false negative breaks real reorg propagation.
 */

'use strict';

const assert = require('assert');
const { REORG_EVENTS_SQL, MAX_LIMIT, DEFAULT_LIMIT, validateReorgHistoryParams,
        parseReorgEvent, buildReorgHistoryResponse } = require('../../src/reorg-history-query');

const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const H3 = 'c'.repeat(64);

// A decoder REORG event row: data is a JSON array of orphaned blocks.
function event(id, blocks) {
    return { id, data: JSON.stringify(blocks) };
}

describe('reorg-history-query: validateReorgHistoryParams()', function () {
    it('defaults every filter and applies the default limit', function () {
        let v = validateReorgHistoryParams({});
        assert.deepStrictEqual(v, { ok: true, since_id: 0, block_index: null, block_hash: null, limit: DEFAULT_LIMIT });
    });

    it('accepts no argument at all', function () {
        assert.strictEqual(validateReorgHistoryParams().ok, true);
    });

    it('accepts and lowercases a 64-hex block_hash', function () {
        assert.strictEqual(validateReorgHistoryParams({ block_hash: 'AB'.repeat(32) }).block_hash, 'ab'.repeat(32));
    });

    it('rejects a malformed block_hash rather than silently dropping the filter', function () {
        for (const bad of ['zz'.repeat(32), 'ab'.repeat(31), 42, {}])
            assert.strictEqual(validateReorgHistoryParams({ block_hash: bad }).ok, false, String(bad));
    });

    it('rejects negative / non-integer since_id, block_index, limit', function () {
        assert.strictEqual(validateReorgHistoryParams({ since_id: -1 }).ok, false);
        assert.strictEqual(validateReorgHistoryParams({ since_id: 1.5 }).ok, false);
        assert.strictEqual(validateReorgHistoryParams({ block_index: -1 }).ok, false);
        assert.strictEqual(validateReorgHistoryParams({ block_index: 'abc' }).ok, false);
        assert.strictEqual(validateReorgHistoryParams({ limit: 0 }).ok, false);
        assert.strictEqual(validateReorgHistoryParams({ limit: -5 }).ok, false);
    });

    it('accepts block_index 0 and since_id 0', function () {
        let v = validateReorgHistoryParams({ block_index: 0, since_id: 0 });
        assert.strictEqual(v.ok, true);
        assert.strictEqual(v.block_index, 0);
    });

    it('clamps limit to MAX_LIMIT so a peer cannot force an unbounded scan', function () {
        assert.strictEqual(validateReorgHistoryParams({ limit: 10 * MAX_LIMIT }).limit, MAX_LIMIT);
    });
});

describe('reorg-history-query: parseReorgEvent()', function () {
    it('surfaces the orphaned block hashes getReorgsSince() discards', function () {
        let e = parseReorgEvent(event(7, [{ block_index: 100, block_hash: H1 }, { block_index: 101, block_hash: H2 }]));
        assert.strictEqual(e.id, 7);
        assert.deepStrictEqual(e.blocks, [
            { block_index: 100, block_hash: H1 },
            { block_index: 101, block_hash: H2 }
        ]);
        assert.strictEqual(e.min_block_index, 100, 'deepest orphaned block, matching getReorgsSince semantics');
    });

    it('lowercases hashes so comparison is case-insensitive', function () {
        let e = parseReorgEvent(event(1, [{ block_index: 5, block_hash: H1.toUpperCase() }]));
        assert.strictEqual(e.blocks[0].block_hash, H1);
    });

    it('reports block_hash null (not absent) for a legacy bare-index event', function () {
        let e = parseReorgEvent(event(2, [100, 101]));
        assert.deepStrictEqual(e.blocks, [
            { block_index: 100, block_hash: null },
            { block_index: 101, block_hash: null }
        ]);
        assert.strictEqual(e.min_block_index, 100);
    });

    it('yields no blocks for a corrupt event rather than throwing', function () {
        let e = parseReorgEvent({ id: 3, data: 'not json' });
        assert.deepStrictEqual(e.blocks, []);
        assert.strictEqual(e.min_block_index, null);
    });

    it('drops non-numeric block indexes', function () {
        let e = parseReorgEvent(event(4, [{ block_index: 'x', block_hash: H1 }, { block_index: 9, block_hash: H2 }]));
        assert.deepStrictEqual(e.blocks, [{ block_index: 9, block_hash: H2 }]);
    });
});

describe('reorg-history-query: buildReorgHistoryResponse()', function () {
    const rows = [
        event(20, [{ block_index: 200, block_hash: H1 }, { block_index: 201, block_hash: H2 }]),
        event(10, [{ block_index: 100, block_hash: H3 }])
    ];

    it('returns every event unfiltered, and matched:false with no filter', function () {
        let r = buildReorgHistoryResponse(rows, {});
        assert.strictEqual(r.count, 2);
        assert.strictEqual(r.latest_id, 20);
        assert.strictEqual(r.matched, false, 'no question asked, no positive evidence');
    });

    it('matches the exact (block_index, block_hash) pair the hub asks about', function () {
        let r = buildReorgHistoryResponse(rows, { block_index: 200, block_hash: H1 });
        assert.strictEqual(r.matched, true);
        assert.strictEqual(r.count, 1);
        assert.strictEqual(r.events[0].id, 20);
    });

    // The load-bearing case: a reorg orphaned (200,H1) and (201,H2). Asking about
    // (200,H2) must NOT match, or a Byzantine validator could pair a real height
    // with a real-but-different hash from the same event and forge a rollback.
    it('does NOT match a hash from a DIFFERENT block of the same event', function () {
        let r = buildReorgHistoryResponse(rows, { block_index: 200, block_hash: H2 });
        assert.strictEqual(r.matched, false, 'cross-block pairing must not count as evidence');
        assert.strictEqual(r.count, 0);
    });

    it('does not match a hash that was never orphaned (fabricated oldHash)', function () {
        assert.strictEqual(buildReorgHistoryResponse(rows, { block_index: 200, block_hash: 'f'.repeat(64) }).matched, false);
    });

    it('does not match a height that never reorged', function () {
        assert.strictEqual(buildReorgHistoryResponse(rows, { block_index: 999, block_hash: H1 }).matched, false);
    });

    it('supports a height-only or hash-only question', function () {
        assert.strictEqual(buildReorgHistoryResponse(rows, { block_index: 100 }).matched, true);
        assert.strictEqual(buildReorgHistoryResponse(rows, { block_hash: H3 }).matched, true);
        assert.strictEqual(buildReorgHistoryResponse(rows, { block_index: 201 }).matched, true);
        assert.strictEqual(buildReorgHistoryResponse(rows, { block_index: 101 }).matched, false, 'height never orphaned');
    });

    it('treats block_index 0 as a real filter, not as "no filter"', function () {
        let genesisRows = [event(1, [{ block_index: 0, block_hash: H1 }])];
        assert.strictEqual(buildReorgHistoryResponse(genesisRows, { block_index: 0 }).matched, true);
        assert.strictEqual(buildReorgHistoryResponse(rows, { block_index: 0 }).matched, false);
    });

    it('never matches a legacy hash-less event when a hash is asked for', function () {
        let legacy = [event(5, [200])];
        assert.strictEqual(buildReorgHistoryResponse(legacy, { block_index: 200, block_hash: H1 }).matched, false);
        assert.strictEqual(buildReorgHistoryResponse(legacy, { block_index: 200 }).matched, true);
    });

    it('handles empty / non-array input', function () {
        let r = buildReorgHistoryResponse([], { block_index: 1, block_hash: H1 });
        assert.strictEqual(r.count, 0);
        assert.strictEqual(r.latest_id, null);
        assert.strictEqual(r.matched, false);
        assert.strictEqual(buildReorgHistoryResponse(undefined, {}).count, 0);
    });
});

describe('reorg-history-query: REORG_EVENTS_SQL', function () {
    it('reads only REORG events, newest first, bounded', function () {
        assert.match(REORG_EVENTS_SQL, /code = 'REORG'/);
        assert.match(REORG_EVENTS_SQL, /ORDER BY id DESC/);
        assert.match(REORG_EVENTS_SQL, /LIMIT \?/);
    });

    it('parameterizes since_id and limit (no interpolation)', function () {
        assert.strictEqual((REORG_EVENTS_SQL.match(/\?/g) || []).length, 2);
    });
});
