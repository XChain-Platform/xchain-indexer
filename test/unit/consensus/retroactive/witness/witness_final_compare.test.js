/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 *
 **********************************************************************
 *
 * Boundary coverage for final retroactive witness comparisons.
 *
 *********************************************************************/

'use strict';

const assert = require('assert');
const {
    observedWindowDigests,
    planFinalCompare,
    windowRows,
} = require('../../../../../src/consensus/retroactive/witness_chunks.js');
const {
    observedWindowDigest,
} = require('../../../../../src/consensus/retroactive/replay_witness.js');

function hash(value) {
    return value.toString(16).padStart(64, '0');
}

function blocks(from, to) {
    const rows = [];
    for(let height = from; height <= to; height++){
        rows.push({
            block_index: height,
            block_hash: hash(height),
            ledger_hash: hash(height + 1),
        });
    }
    return rows;
}

function fixture() {
    const committed = blocks(100, 227);
    const first = observedWindowDigest(committed.slice(0, 64), 100, 163);
    const second = observedWindowDigest(committed.slice(64), 164, 227);
    const rows = windowRows({ target: 100, replay_to: 227 }, [
        [100, 163, first],
        [164, 227, second],
    ]);
    return { committed, first, rows, second };
}

describe('final retroactive witness comparison @regression @tier1', function () {
    it('derives one observed digest per witness window', function () {
        const { committed, first, rows, second } = fixture();

        assert.deepStrictEqual(observedWindowDigests(rows, committed), {
            163: first,
            227: second,
        });
    });

    it('rejects empty windows and bulk reads that do not exactly cover the span', function () {
        const { committed, rows } = fixture();

        assert.throws(() => observedWindowDigests([], committed), TypeError);
        assert.throws(() => observedWindowDigests(rows, committed.slice(1)), /cover/);
        assert.throws(() => observedWindowDigests(rows, [
            ...committed,
            { block_index: 228, block_hash: hash(228) },
        ]), /cover/);
    });

    it('rejects noncontiguous blocks within an exact-length bulk read', function () {
        const { committed, rows } = fixture();
        const noncontiguous = committed.map((block, offset) => offset === 70
            ? { ...block, block_index: block.block_index + 1 }
            : block);

        assert.throws(() => observedWindowDigests(rows, noncontiguous), /contiguous/);
    });

    it('reports unchanged windows at and beyond the final replay height', function () {
        const { committed, rows } = fixture();

        for(const height of [227, 230]){
            assert.deepStrictEqual(planFinalCompare({
                phase: 'final', replayTo: 227, height, rows, blocks: committed,
            }), { changed: false });
        }
    });

    it('reports a changed window through the recorded digest path', function () {
        const { committed, rows } = fixture();
        const changed = committed.map((block, offset) => offset === 70
            ? { ...block, ledger_hash: 'c'.repeat(64) }
            : block);

        assert.deepStrictEqual(planFinalCompare({
            phase: 'final', replayTo: 227, height: 227, rows, blocks: changed,
        }), { changed: true });
    });

    it('does no work before the final comparison boundary', function () {
        const { committed, rows } = fixture();

        assert.strictEqual(planFinalCompare({
            phase: 'final', replayTo: 227, height: 226, rows, blocks: committed,
        }), null);
        assert.strictEqual(planFinalCompare({
            phase: 'witness', replayTo: 227, height: 227, rows, blocks: committed,
        }), null);
    });
});
