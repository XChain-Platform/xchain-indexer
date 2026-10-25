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
 * Replay witness phase transitions retain the complete witness fence.
 *
 *********************************************************************/

'use strict';

const assert = require('assert');
const {
    decodeReplayWitnessPhase,
    nextWitnessPhase,
} = require('../../../../../src/consensus/retroactive/replay_witness.js');

const base = () => ({
    phase: 'witness',
    target: 100,
    replay_to: 227,
    rules_from: 'c'.repeat(64),
    window_count: 2,
    map_count: 1,
    extra: 'discarded',
});

describe('retroactive replay witness next phase @regression @tier1', function(){
    it('copies only the witness fence into a fresh phase object', function(){
        const phase = base();
        const next = nextWitnessPhase(phase, 'witnessed');

        assert.deepStrictEqual(next, {
            phase: 'witnessed',
            target: 100,
            replay_to: 227,
            rules_from: 'c'.repeat(64),
            window_count: 2,
            map_count: 1,
        });
        assert.notStrictEqual(next, phase);
        assert.deepStrictEqual(phase, base());
    });

    it('retains explicit boolean change results after witnessing', function(){
        for(const name of ['witnessed', 'diverged', 'final']){
            for(const changed of [false, true]){
                const next = nextWitnessPhase(base(), name, changed);
                assert.strictEqual(next.phase, name);
                assert.strictEqual(next.changed, changed);
                assert.strictEqual(decodeReplayWitnessPhase(next), next);
            }
        }
    });

    it('does not carry a prior change result when it is omitted', function(){
        const final = nextWitnessPhase(base(), 'final', true);
        const rewritten = nextWitnessPhase(final, 'final');

        assert.ok(!Object.prototype.hasOwnProperty.call(rewritten, 'changed'));
    });

    it('rejects invalid transitions and change results', function(){
        for(const next of ['bogus', '', null, false])
            assert.throws(() => nextWitnessPhase(base(), next), /invalid replay witness phase/);
        for(const changed of [null, 0, 1, 'true', {}, []])
            assert.throws(() => nextWitnessPhase(base(), 'final', changed),
                /changed must be a boolean/);
        for(const changed of [false, true])
            assert.throws(() => nextWitnessPhase(base(), 'witness', changed),
                /cannot include changed/);
    });

    it('decodes legacy rows and rejects invalid persisted change results', function(){
        for(const name of ['witness', 'witnessed', 'diverged', 'final']){
            const phase = { ...base(), phase: name };
            delete phase.extra;
            assert.strictEqual(decodeReplayWitnessPhase(phase), phase);
        }

        assert.throws(() => decodeReplayWitnessPhase({
            ...base(), changed: true,
        }), /cannot include changed/);
        for(const changed of [undefined, null, 0, 1, 'true', {}, []])
            assert.throws(() => decodeReplayWitnessPhase({
                ...base(), phase: 'final', changed,
            }), /invalid replay witness phase changed/);
    });
});
