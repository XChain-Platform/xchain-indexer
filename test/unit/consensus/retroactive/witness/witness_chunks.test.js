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
 * Boundary coverage for pure retroactive witness chunk comparisons.
 *
 *********************************************************************/

'use strict';

const assert = require('assert');
const {
    chunkClosingAt,
    chunkMatches,
    windowChanged,
} = require('../../../../../src/consensus/retroactive/witness_chunks.js');

const FIRST_DIGEST = 'a'.repeat(64);
const SECOND_DIGEST = 'b'.repeat(64);

function witnessWindows() {
    return [
        { target: 100, replay_to: 227, from: 100, to: '163', d: FIRST_DIGEST },
        { target: 100, replay_to: 227, from: 164, to: 227, d: SECOND_DIGEST },
    ];
}

describe('retroactive witness chunk comparisons @regression @tier1', function () {
    it('finds the chunk ending at a numeric height', function () {
        const windows = witnessWindows();

        assert.strictEqual(chunkClosingAt(windows, 163), windows[0]);
        assert.strictEqual(chunkClosingAt(windows, 227), windows[1]);
    });

    it('returns null when no chunk ends at the height', function () {
        const windows = witnessWindows();

        assert.strictEqual(chunkClosingAt(windows, 164), null);
        assert.strictEqual(chunkClosingAt(windows, '163'), null);
        assert.strictEqual(chunkClosingAt([], 163), null);
    });

    it('compares valid digests case-insensitively', function () {
        const window = witnessWindows()[0];

        assert.strictEqual(chunkMatches(window, FIRST_DIGEST.toUpperCase()), true);
        assert.strictEqual(chunkMatches(window, SECOND_DIGEST), false);
    });

    it('rejects digests outside the exact hexadecimal format', function () {
        const window = witnessWindows()[0];

        for(const digest of [undefined, null, 1, '', 'a'.repeat(63),
            'a'.repeat(65), 'z'.repeat(64)])
            assert.throws(() => chunkMatches(window, digest), TypeError);
    });

    it('reports unchanged windows when every observed digest matches', function () {
        assert.strictEqual(windowChanged(witnessWindows(), {
            163: FIRST_DIGEST.toUpperCase(),
            227: SECOND_DIGEST,
        }), false);
    });

    it('reports a changed window when any observed digest differs', function () {
        assert.strictEqual(windowChanged(witnessWindows(), {
            163: FIRST_DIGEST,
            227: FIRST_DIGEST,
        }), true);
    });

    it('rejects empty windows and absent observed digests', function () {
        assert.throws(() => windowChanged([], {}), TypeError);
        assert.throws(() => windowChanged(witnessWindows(), {
            163: FIRST_DIGEST,
        }), TypeError);
        assert.throws(() => windowChanged(witnessWindows(), {
            163: SECOND_DIGEST,
        }), TypeError);
        assert.throws(() => windowChanged(witnessWindows(), null), TypeError);

        const inherited = Object.create({ 163: FIRST_DIGEST, 227: SECOND_DIGEST });
        assert.throws(() => windowChanged(witnessWindows(), inherited), TypeError);
    });

    it('rejects malformed observed digests', function () {
        assert.throws(() => windowChanged(witnessWindows(), {
            163: FIRST_DIGEST,
            227: 'not-a-digest',
        }), TypeError);
    });
});
