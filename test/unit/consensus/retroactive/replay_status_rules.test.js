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
 * Boundary coverage for the pure retroactive replay status rules.
 *
 *********************************************************************/

'use strict';

const assert = require('assert');
const {
    replayReachedTip,
    heightIsFinal,
    rulesStatusBody
} = require('../../../../src/consensus/retroactive/replay_status.js');

const digest = 'c'.repeat(64);
const marker = { state: 'replaying', target: 10, replay_to: 20 };

describe('retroactive replay status rules @regression @tier1', function () {
    it('replayReachedTip changes at replay_to only for a replaying marker', function () {
        assert.strictEqual(replayReachedTip(marker, marker.target - 1), false);
        assert.strictEqual(replayReachedTip(marker, marker.target), false);
        assert.strictEqual(replayReachedTip(marker, marker.replay_to - 1), false);
        assert.strictEqual(replayReachedTip(marker, marker.replay_to), true);
        assert.strictEqual(
            replayReachedTip(Object.assign({}, marker, { state: 'pending' }), marker.replay_to),
            false
        );
    });

    it('heightIsFinal excludes the open replay range starting at target', function () {
        assert.strictEqual(heightIsFinal(marker.target - 1, marker), true);
        assert.strictEqual(heightIsFinal(marker.target, marker), false);
        assert.strictEqual(heightIsFinal(marker.replay_to - 1, marker), false);
        assert.strictEqual(heightIsFinal(marker.replay_to, marker), false);
        assert.strictEqual(heightIsFinal(marker.target, null), true);
        assert.strictEqual(
            heightIsFinal(marker.target, Object.assign({}, marker, { state: 'replayed' })),
            true
        );
    });

    it('rulesStatusBody returns only the public marker fields', function () {
        const body = rulesStatusBody(digest, Object.assign({ extra: 'private' }, marker));

        assert.deepStrictEqual(Object.keys(body).sort(), ['digest', 'replay']);
        assert.strictEqual(body.digest, digest);
        assert.deepStrictEqual(Object.keys(body.replay).sort(), ['replay_to', 'state', 'target']);
        assert.deepStrictEqual(body.replay, marker);
        assert.deepStrictEqual(rulesStatusBody(digest, null), { digest, replay: null });
    });

    it('rulesStatusBody rejects a digest outside 64 lowercase hex characters', function () {
        assert.throws(() => rulesStatusBody('nothex', marker), /invalid consensus rules digest/);
        assert.throws(() => rulesStatusBody('C'.repeat(64), marker), /invalid consensus rules digest/);
    });
});
