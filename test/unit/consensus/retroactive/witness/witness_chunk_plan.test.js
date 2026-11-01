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
 * Boundary coverage for retroactive witness chunk planning.
 *
 *********************************************************************/

'use strict';

const assert = require('assert');
const {
    planWitnessChunk,
    windowRows,
} = require('../../../../../src/consensus/retroactive/witness_chunks.js');

const FIRST_DIGEST = 'a'.repeat(64);
const SECOND_DIGEST = 'b'.repeat(64);

function witnessRows() {
    return windowRows({ target: 100, replay_to: 227 }, [
        [100, 163, FIRST_DIGEST],
        [164, 227, SECOND_DIGEST],
    ]);
}

describe('retroactive witness chunk plan @regression @tier1', function () {
    it('maps decoded windows to witness rows', function () {
        assert.deepStrictEqual(witnessRows(), [
            {
                target: 100,
                replay_to: 227,
                from: 100,
                to: 163,
                d: FIRST_DIGEST,
            },
            {
                target: 100,
                replay_to: 227,
                from: 164,
                to: 227,
                d: SECOND_DIGEST,
            },
        ]);
    });

    it('rejects malformed decoded window shapes', function () {
        for(const window of [null, {}, 'window', [], [1, 2], [1, 2, FIRST_DIGEST, 3]]){
            assert.throws(() => windowRows({ target: 1, replay_to: 2 }, [window]),
                /witness window must be a three-element array/);
        }
    });

    it('continues after a matching intermediate chunk', function () {
        const rows = witnessRows();

        assert.deepStrictEqual(planWitnessChunk({
            phase: 'witness', replayTo: 227, rows, height: 163, digest: FIRST_DIGEST,
        }), {
            writePhase: null,
            stallReason: null,
            exit: false,
            chunk: rows[0],
        });
    });

    it('marks a matching final chunk witnessed and exits', function () {
        const rows = witnessRows();

        assert.deepStrictEqual(planWitnessChunk({
            phase: 'witness', replayTo: 227, rows, height: 227,
            digest: SECOND_DIGEST.toUpperCase(),
        }), {
            writePhase: 'witnessed',
            stallReason: null,
            exit: true,
            chunk: rows[1],
        });
    });

    it('marks a mismatching closing chunk diverged without exiting', function () {
        const rows = witnessRows();

        assert.deepStrictEqual(planWitnessChunk({
            phase: 'witness', replayTo: 227, rows, height: 163, digest: SECOND_DIGEST,
        }), {
            writePhase: 'diverged',
            stallReason: 'retroactive_replay_diverged',
            exit: false,
            chunk: rows[0],
        });
    });

    it('does no work outside witness phase or away from a chunk boundary', function () {
        const rows = witnessRows();

        assert.strictEqual(planWitnessChunk({
            phase: 'final', replayTo: 227, rows, height: 163, digest: FIRST_DIGEST,
        }), null);
        assert.strictEqual(planWitnessChunk({
            phase: 'witness', replayTo: 227, rows, height: 150, digest: FIRST_DIGEST,
        }), null);
    });
});
