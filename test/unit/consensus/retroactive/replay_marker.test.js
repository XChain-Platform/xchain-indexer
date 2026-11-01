/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
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
 *
 * Unit coverage for the retroactive replay marker codec and state machine.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const {
    REPLAY_MARKER_CODE,
    REPLAY_STATES,
    buildReplayMarker,
    encodeReplayMarker,
    decodeReplayMarker,
    advanceReplayMarker,
    isReplayOpen,
} = require('../../../../src/consensus/retroactive/replay_marker.js');

const RULES_FROM = 'a'.repeat(64);
const RULES_TO = 'b'.repeat(64);

function marker() {
    return buildReplayMarker({
        target: 100,
        replayTo: 140,
        rulesFrom: RULES_FROM,
        rulesTo: RULES_TO,
    });
}

describe('retroactive replay marker codec @regression @tier1', function () {
    it('exports the event code and frozen ordered replay states', function () {
        assert.strictEqual(REPLAY_MARKER_CODE, 'CONSENSUS_RETRO_REPLAY');
        assert.deepStrictEqual(REPLAY_STATES, ['pending', 'replaying', 'replayed']);
        assert.strictEqual(Object.isFrozen(REPLAY_STATES), true);
    });

    it('builds a new pending marker with canonical field names and order', function () {
        const first = marker();
        const second = marker();

        assert.deepStrictEqual(first, {
            target: 100,
            replay_to: 140,
            rules_from: RULES_FROM,
            rules_to: RULES_TO,
            state: 'pending',
        });
        assert.deepStrictEqual(Object.keys(first),
            ['target', 'replay_to', 'rules_from', 'rules_to', 'state']);
        assert.notStrictEqual(first, second);
    });

    it('refuses an invalid target or replay end', function () {
        for(const target of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '100', NaN]){
            assert.throws(() => buildReplayMarker({
                target, replayTo: 140, rulesFrom: RULES_FROM, rulesTo: RULES_TO,
            }));
        }
        for(const replayTo of [99, 140.5, '140', Infinity]){
            assert.throws(() => buildReplayMarker({
                target: 100, replayTo, rulesFrom: RULES_FROM, rulesTo: RULES_TO,
            }));
        }
    });

    it('refuses a rules digest that is not exactly 64 lowercase hex characters', function () {
        for(const digest of ['a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64), 12, null]){
            assert.throws(() => buildReplayMarker({
                target: 100, replayTo: 140, rulesFrom: digest, rulesTo: RULES_TO,
            }));
            assert.throws(() => buildReplayMarker({
                target: 100, replayTo: 140, rulesFrom: RULES_FROM, rulesTo: digest,
            }));
        }
    });

    it('encodes keys in canonical order regardless of input insertion order', function () {
        const shuffled = {
            state: 'pending',
            rules_to: RULES_TO,
            target: 100,
            rules_from: RULES_FROM,
            replay_to: 140,
        };
        assert.strictEqual(encodeReplayMarker(shuffled), JSON.stringify({
            target: 100,
            replay_to: 140,
            rules_from: RULES_FROM,
            rules_to: RULES_TO,
            state: 'pending',
        }));
    });

    it('round trips a marker through JSON into a new canonical object', function () {
        const original = marker();
        const decoded = decodeReplayMarker(encodeReplayMarker(original));

        assert.deepStrictEqual(decoded, original);
        assert.notStrictEqual(decoded, original);
        assert.deepStrictEqual(Object.keys(decoded),
            ['target', 'replay_to', 'rules_from', 'rules_to', 'state']);
    });

    it('refuses malformed JSON, every missing field, and an unknown state', function () {
        assert.throws(() => decodeReplayMarker('{'));
        for(const field of ['target', 'replay_to', 'rules_from', 'rules_to', 'state']){
            const incomplete = marker();
            delete incomplete[field];
            assert.throws(() => decodeReplayMarker(JSON.stringify(incomplete)), field);
        }
        assert.throws(() => decodeReplayMarker(JSON.stringify(
            Object.assign(marker(), { state: 'done' }))));
    });

    it('advances pending to replaying and replaying to replayed without mutation', function () {
        const pending = marker();
        const pendingBefore = Object.assign({}, pending);
        const replaying = advanceReplayMarker(pending, 'replaying');
        const replayed = advanceReplayMarker(replaying, 'replayed');

        assert.deepStrictEqual(pending, pendingBefore);
        assert.notStrictEqual(replaying, pending);
        assert.strictEqual(pending.state, 'pending');
        assert.strictEqual(replaying.state, 'replaying');
        assert.strictEqual(replayed.state, 'replayed');
    });

    it('refuses skipped, reversed, repeated, and post-completion steps', function () {
        const pending = marker();
        const replaying = advanceReplayMarker(pending, 'replaying');
        const replayed = advanceReplayMarker(replaying, 'replayed');

        assert.throws(() => advanceReplayMarker(pending, 'replayed'));
        assert.throws(() => advanceReplayMarker(pending, 'pending'));
        assert.throws(() => advanceReplayMarker(replaying, 'pending'));
        assert.throws(() => advanceReplayMarker(replaying, 'replaying'));
        assert.throws(() => advanceReplayMarker(replayed, 'replayed'));
    });

    it('reports only pending and replaying markers as open', function () {
        const pending = marker();
        const replaying = advanceReplayMarker(pending, 'replaying');
        const replayed = advanceReplayMarker(replaying, 'replayed');

        assert.strictEqual(isReplayOpen(pending), true);
        assert.strictEqual(isReplayOpen(replaying), true);
        assert.strictEqual(isReplayOpen(replayed), false);
        assert.strictEqual(isReplayOpen(null), false);
    });
});
