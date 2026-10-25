/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * Boot recovery for the recorded-rules witness pass and final replay.
 *
 *********************************************************************/

'use strict';

const assert = require('assert');
const { GateRegistry } = require('../../../../src/protocol_changes/core.js');
const {
    gateMapDigest,
    runBootReplay,
} = require('../../../../src/consensus/retroactive/boot_replay.js');
const {
    buildReplayMarker,
    advanceReplayMarker,
} = require('../../../../src/consensus/retroactive/replay_marker.js');
const { witnessReadOverlay } = require('../../../../src/consensus/retroactive/witness_overlay.js');
const startup = require('../../../../src/XChainIndexer/startup.js');

const KEY = 'movable_activation.MOVABLE_ACTIVATION';
const R = { [KEY]: 120 };
const C = { [KEY]: 95 };
const BATCH = 'b'.repeat(64);

function marker(state){
    const pending = buildReplayMarker({
        target: 95,
        replayTo: 100,
        rulesFrom: gateMapDigest(R),
        rulesTo: gateMapDigest(C),
    });
    if(state === 'pending') return pending;
    const replaying = advanceReplayMarker(pending, 'replaying');
    return state === 'replaying' ? replaying : advanceReplayMarker(replaying, 'replayed');
}

function witness(phase){
    return {
        batch: BATCH,
        gateHeights: R,
        phase: {
            phase,
            target: 95,
            replay_to: 100,
            rules_from: gateMapDigest(R),
            window_count: 1,
            map_count: 1,
        },
    };
}

function harness(phase, state, { tip = 94, recorded = R } = {}){
    const calls = [];
    let latest = witness(phase);
    const durable = {
        marker: marker(state),
        recorded: { gateHeights: recorded, appliedTip: tip, scope: 'registry' },
        tip,
    };
    const deps = {
        readBoot: async () => ({
            recorded: durable.recorded,
            replayMarker: durable.marker,
        }),
        readWitness: async () => latest,
        recordWitnessPhase: async (batch, next) => {
            calls.push(['phase', next.phase]);
            latest = Object.assign({}, latest, { phase: next });
        },
        useRecordedRules: values => calls.push(['rules', 'recorded', values]),
        useCurrentRules: () => calls.push(['rules', 'current']),
        recordBoot: async (map, nextTip) => {
            calls.push(['boot', map, nextTip]);
            durable.recorded = {
                gateHeights: map,
                appliedTip: nextTip,
                scope: 'registry',
            };
        },
        recordMarker: async next => {
            calls.push(['marker', next.state]);
            durable.marker = next;
        },
        rollback: async target => {
            calls.push(['rollback', target]);
            durable.tip = target - 1;
        },
        holdReplay: () => calls.push(['hold']),
        holdNeedsGo: () => {},
        refuse: message => { throw new Error(message); },
    };
    return { calls, deps, durable };
}

async function run(h, tip = h.durable.tip){
    return runBootReplay({
        tip,
        current: C,
        capBlocks: 10,
        movableGates: [KEY],
    }, h.deps);
}

describe('retroactive replay witness boot phases @regression @tier1', function(){
    it('composes the recorded map over the venue overlay and replaces COIN:network', function(){
        const registry = new GateRegistry();
        registry.addGate(KEY, 'height', {
            'BTC:regtest': 95,
            regtest: 44,
            mainnet: 500,
        });
        registry.setReadOverlay((key, value) => Object.assign({}, value, { mainnet: 501 }));
        const venue = registry.getReadOverlay();
        registry.setReadOverlay(witnessReadOverlay(venue, R, 'regtest', 'BTC'));

        assert.deepStrictEqual(registry.get(KEY), {
            'BTC:regtest': 120,
            regtest: 44,
            mainnet: 501,
        });
        registry.setReadOverlay(venue);
        assert.strictEqual(registry.get(KEY)['BTC:regtest'], 95);
    });

    it('resumes a witness-phase crash under recorded rules without a second rollback', async function(){
        const h = harness('witness', 'pending');
        const result = await run(h);

        assert.deepStrictEqual(h.calls, [
            ['rules', 'recorded', R],
            ['hold'],
            ['boot', R, 94],
            ['marker', 'replaying'],
        ]);
        assert.strictEqual(result.marker.state, 'replaying');
        assert.deepStrictEqual(h.durable.recorded.gateHeights, R);
    });

    it('resumes a witnessed-phase crash into final rules without a second rollback', async function(){
        const h = harness('witnessed', 'replayed');
        const result = await run(h);

        assert.deepStrictEqual(h.calls, [
            ['rules', 'current'],
            ['hold'],
            ['marker', 'pending'],
            ['boot', C, 94],
            ['phase', 'final'],
            ['marker', 'replaying'],
        ]);
        assert.strictEqual(result.marker.state, 'replaying');
        assert.deepStrictEqual(h.durable.recorded.gateHeights, C);
    });

    it('resumes a final-phase crash without a second rollback or phase rewrite', async function(){
        const h = harness('final', 'pending', { recorded: C });
        const result = await run(h);

        assert.deepStrictEqual(h.calls, [
            ['rules', 'current'],
            ['hold'],
            ['boot', C, 94],
            ['marker', 'replaying'],
        ]);
        assert.strictEqual(result.marker.state, 'replaying');
        assert.strictEqual(h.calls.some(call => call[0] === 'phase'), false);
    });

    it('a completed witness pass at or above H rolls back before advancing phases', async function(){
        const h = harness('witness', 'replaying', { tip: 100 });
        const indexer = {
            replayWitnessPhase: 'witness',
            completeRetroactiveReplay: async () => {
                h.durable.marker = advanceReplayMarker(h.durable.marker, 'replayed');
                return true;
            },
            recordConsensusGateBoot: async () => {
                const result = await run(h, h.durable.tip);
                indexer.replayWitnessPhase = result.phase;
                indexer.replayMarker = result.marker;
            },
        };
        startup.armReplayWitnessCompletion.call(indexer, 'witness');
        await indexer.completeRetroactiveReplay();
        const rollbackAt = h.calls.findIndex(call => call[0] === 'rollback');
        const witnessedAt = h.calls.findIndex(call => call[0] === 'phase' && call[1] === 'witnessed');
        const finalAt = h.calls.findIndex(call => call[0] === 'phase' && call[1] === 'final');

        assert.ok(rollbackAt >= 0 && rollbackAt < witnessedAt, JSON.stringify(h.calls));
        assert.ok(witnessedAt < finalAt, JSON.stringify(h.calls));
        assert.strictEqual(h.calls.filter(call => call[0] === 'rollback').length, 1);
        assert.deepStrictEqual(h.calls.find(call => call[0] === 'boot'), ['boot', C, 94]);
        assert.strictEqual(indexer.replayMarker.state, 'replaying');
        assert.strictEqual(indexer.replayWitnessPhase, 'final');
    });

    it('retries a failed runtime phase handoff before testing final replay completion', async function(){
        let completions = 0;
        let transitions = 0;
        const indexer = {
            completeRetroactiveReplay: async () => {
                completions++;
                return true;
            },
            recordConsensusGateBoot: async () => {
                transitions++;
                if(transitions === 1) throw new Error('phase handoff failed');
                indexer.replayWitnessPhase = 'final';
            },
        };
        startup.armReplayWitnessCompletion.call(indexer, 'witness');

        await assert.rejects(indexer.completeRetroactiveReplay(), /phase handoff failed/);
        await indexer.completeRetroactiveReplay();

        assert.strictEqual(completions, 1);
        assert.strictEqual(transitions, 2);
        assert.strictEqual(indexer.replayWitnessPhase, 'final');
        assert.strictEqual(indexer.replayWitnessTransitionPending, false);
    });

    it('keeps the recorded overlay through the witness pass and restores current rules for final', async function(){
        const active = harness('witness', 'replaying', { tip: 97 });
        await run(active, 97);
        assert.deepStrictEqual(active.calls.filter(call => call[0] === 'rules'), [
            ['rules', 'recorded', R],
        ]);
        assert.strictEqual(active.calls.some(call => call[0] === 'rollback'), false);

        const final = harness('final', 'replaying', { tip: 97, recorded: C });
        await run(final, 97);
        assert.deepStrictEqual(final.calls.filter(call => call[0] === 'rules'), [
            ['rules', 'current'],
        ]);
        assert.strictEqual(final.calls.some(call => call[0] === 'rollback'), false);
    });
});
