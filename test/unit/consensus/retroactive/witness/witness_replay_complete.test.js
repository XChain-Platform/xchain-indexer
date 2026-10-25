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
 * Completion and block gates for a retroactive replay witness.
 *
 *********************************************************************/

'use strict';

const assert = require('assert');
const {
    replayMayComplete,
    replayReachedTip,
} = require('../../../../../src/consensus/retroactive/replay_status.js');
const {
    witnessHoldsBlocks,
} = require('../../../../../src/consensus/retroactive/witness_status.js');

const marker = { state: 'replaying', target: 100, replay_to: 227 };

describe('retroactive witness replay gates @regression @tier1', function () {
    it('keeps legacy completion behavior when no witness phase exists', function () {
        assert.strictEqual(replayMayComplete(marker, 227, null), true);
        assert.strictEqual(replayMayComplete(marker, 227, undefined), true);
        assert.strictEqual(replayMayComplete(marker, 226, null), false);
    });

    it('completes only after a fully decoded final phase at the tip', function () {
        assert.strictEqual(replayMayComplete(marker, 227,
            { phase: 'final', changed: false }), true);
        assert.strictEqual(replayMayComplete(marker, 230,
            { phase: 'final', changed: true }), true);
        assert.strictEqual(replayMayComplete(marker, 227, { phase: 'final' }), false);
        assert.strictEqual(replayMayComplete(marker, 226,
            { phase: 'final', changed: true }), false);
        assert.strictEqual(replayMayComplete(Object.assign({}, marker, { state: 'replayed' }),
            230, { phase: 'final', changed: true }), false);
    });

    it('does not complete during non-final witness phases', function () {
        for(const phase of ['witness', 'witnessed', 'diverged'])
            assert.strictEqual(replayMayComplete(marker, 230,
                { phase, changed: true }), false);
    });

    it('rejects an invalid completion phase', function () {
        assert.throws(() => replayMayComplete(marker, 227, { phase: 'bogus' }),
            /invalid retroactive replay phase/);
    });

    it('holds blocks only for a diverged witness phase', function () {
        assert.strictEqual(witnessHoldsBlocks({ phase: 'diverged', changed: true }), true);
        assert.strictEqual(witnessHoldsBlocks(null), false);
        assert.strictEqual(witnessHoldsBlocks(undefined), false);
        for(const phase of ['witness', 'witnessed', 'final'])
            assert.strictEqual(witnessHoldsBlocks({ phase, changed: true }), false);
    });

    it('rejects an invalid block-hold phase without changing the tip rule', function () {
        assert.throws(() => witnessHoldsBlocks({ phase: 'bogus' }),
            /invalid retroactive replay phase/);
        assert.strictEqual(replayReachedTip(marker, 227), true);
    });
});
