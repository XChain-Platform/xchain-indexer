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
 *
 * The boot-time retroactive replay sequence: one marked rollback for a movable
 * in-cap move, a crash after the rollback commit resuming without a second
 * rollback, the over-cap, mirror-gap and non-movable refusals, and the boot
 * holds the indexer sets while it replays.
 *
 *********************************************************************/

'use strict';

const assert = require('assert');
const crypto = require('crypto');

const { canonical } = require('../../../../src/consensus_rules_digest.js');
const {
    GATE_RECORD_SCOPE,
    gateMapDigest,
    comparableGateMap,
    runBootReplay,
} = require('../../../../src/consensus/retroactive/boot_replay.js');
const { buildReplayMarker, advanceReplayMarker } = require('../../../../src/consensus/retroactive/replay_marker.js');
const { goRulesSha } = require('../../../../src/consensus/retroactive/go_binding.js');
const startup = require('../../../../src/XChainIndexer/startup.js');

const MOVABLE = 'movable_activation.MOVABLE_ACTIVATION';
const FIXED = 'fixed_activation.FIXED_ACTIVATION';
const R = { [MOVABLE]: 200, [FIXED]: 50 };
const C = { [MOVABLE]: 95, [FIXED]: 50 };

// A recorder of every dependency call in order, with the stall the indexer showed
// at the moment of each rollback.
function harness({ recorded, replayMarker = null, mirrorGap = null, go = false } = {}){
    const calls = [];
    const indexer = { stallReason: null, stallClearsAt: 12345 };
    const deps = {
        readBoot: async () => ({ recorded, replayMarker }),
        recordBoot: async (map, tip) => { calls.push(['recordBoot', map, tip]); },
        recordMarker: async (marker) => { calls.push(['recordMarker', marker]); },
        readMirrorGap: async (target) => { calls.push(['readMirrorGap', target]); return mirrorGap; },
        goMatches: async (canonicalMap, target) => { calls.push(['goMatches', canonicalMap, target]); return go; },
        rollback: async (target) => {
            calls.push(['rollback', target, indexer.stallReason, indexer.stallClearsAt]);
            indexer.stallReason = 'reorg_rollback';
        },
        holdReplay: () => startup.holdRetroactiveReplay.call(indexer),
        holdNeedsGo: () => startup.holdRetroactiveReplayNeedsGo.call(indexer),
        refuse: (message) => { throw new Error(message); },
    };
    return { calls, indexer, deps, names: () => calls.map(call => call[0]) };
}

function record(gateHeights, scope = GATE_RECORD_SCOPE){
    return { gateHeights, appliedTip: 100, scope };
}

function run(h, overrides = {}){
    return runBootReplay(Object.assign({
        tip: 100, current: C, capBlocks: 10, movableGates: [MOVABLE],
    }, overrides), h.deps);
}

describe('boot retroactive replay @regression @tier1', function(){

    it('rolls a movable in-cap move back once to the target, marker before and record after', async function(){
        const h = harness({ recorded: record(R) });
        const result = await run(h);

        assert.deepStrictEqual(h.names(),
            ['readMirrorGap', 'recordMarker', 'rollback', 'recordBoot', 'recordMarker']);
        assert.strictEqual(h.calls.filter(call => call[0] === 'rollback').length, 1);
        const [, target, stallDuringRollback, clearsAtDuringRollback] = h.calls[2];
        assert.strictEqual(target, 95);
        assert.strictEqual(stallDuringRollback, 'retroactive_replay');
        assert.strictEqual(clearsAtDuringRollback, null, 'the replay hold names no clock instant');

        const pending = h.calls[1][1];
        assert.deepStrictEqual(pending, {
            target: 95, replay_to: 100, rules_from: gateMapDigest(R), rules_to: gateMapDigest(C), state: 'pending',
        });
        assert.deepStrictEqual(h.calls[3].slice(1), [C, 94], 'the new map is recorded at target - 1');
        assert.strictEqual(h.calls[4][1].state, 'replaying');
        assert.strictEqual(result.action, 'rollback');
        assert.strictEqual(result.marker.state, 'replaying');
        assert.strictEqual(h.indexer.stallReason, 'retroactive_replay', 'the rollback reason never outlives it');
        assert.strictEqual(h.indexer.stallClearsAt, null);
    });

    it('a crash after the rollback commit resumes from the open marker with no second rollback', async function(){
        const pending = buildReplayMarker({ target: 95, replayTo: 100,
            rulesFrom: gateMapDigest(R), rulesTo: gateMapDigest(C) });
        const h = harness({ recorded: record(R), replayMarker: pending });
        const result = await run(h, { tip: 94 });

        assert.deepStrictEqual(h.names(), ['recordBoot', 'recordMarker']);
        assert.deepStrictEqual(h.calls[0].slice(1), [C, 94]);
        assert.strictEqual(h.calls[1][1].state, 'replaying');
        assert.strictEqual(result.action, 'resume');
        assert.strictEqual(result.marker.state, 'replaying');
        assert.strictEqual(pending.state, 'pending', 'the read marker is not mutated');
        assert.strictEqual(h.indexer.stallReason, 'retroactive_replay');
        assert.strictEqual(h.indexer.stallClearsAt, null);
    });

});

describe('boot retroactive replay @regression @tier1', function(){

    it('a crash before the rollback commit rolls back from the open marker without recomputing moves', async function(){
        const pending = buildReplayMarker({ target: 95, replayTo: 100,
            rulesFrom: gateMapDigest(R), rulesTo: gateMapDigest(C) });
        // A refused key in the maps would refuse a fresh boot; an open marker never reads them.
        const h = harness({ recorded: record({ [FIXED]: 1 }), replayMarker: pending });
        await run(h, { tip: 100, current: { [FIXED]: 2 } });

        assert.deepStrictEqual(h.names(), ['rollback', 'recordBoot', 'recordMarker']);
        assert.strictEqual(h.calls[0][1], 95);
        assert.strictEqual(h.calls[0][2], 'retroactive_replay');
        assert.strictEqual(h.calls[1][2], 94);
    });

    it('a replaying marker holds the replay and writes nothing', async function(){
        const replaying = advanceReplayMarker(buildReplayMarker({ target: 95, replayTo: 100,
            rulesFrom: gateMapDigest(R), rulesTo: gateMapDigest(C) }), 'replaying');
        const h = harness({ recorded: record(C), replayMarker: replaying });
        const result = await run(h, { tip: 97 });

        assert.deepStrictEqual(h.names(), []);
        assert.strictEqual(result.action, 'resume');
        assert.strictEqual(h.indexer.stallReason, 'retroactive_replay');
    });

});

describe('boot retroactive replay @regression @tier1', function(){

    it('an over-cap move refuses with needs_go and the go command, and a matching go replays', async function(){
        const h = harness({ recorded: record(R) });
        await assert.rejects(run(h, { capBlocks: 5 }), (error) => {
            assert.match(error.message, /retroactive replay refused: needs_go for target 95 at distance 6/);
            assert.ok(error.message.includes('node bin/retroactive-go.js --target 95 --rules ' +
                goRulesSha(canonical(C), 95)), error.message);
            return true;
        });
        assert.deepStrictEqual(h.names(), ['goMatches']);
        assert.strictEqual(h.indexer.stallReason, 'retroactive_replay_needs_go');
        assert.strictEqual(h.indexer.stallClearsAt, null, 'the go hold names no clock instant');

        const g = harness({ recorded: record(R), go: true });
        const result = await run(g, { capBlocks: 5 });
        assert.strictEqual(result.action, 'rollback');
        assert.strictEqual(g.calls.filter(call => call[0] === 'rollback').length, 1);
    });

    it('a mirror-gap move refuses with its reason and writes nothing', async function(){
        const h = harness({ recorded: record(R), mirrorGap: 'price_mirror_horizon:900>800' });
        await assert.rejects(run(h), /retroactive replay refused: mirror_gap: price_mirror_horizon:900>800/);
        assert.deepStrictEqual(h.names(), ['readMirrorGap']);
        assert.deepStrictEqual(h.calls[0], ['readMirrorGap', 95]);
    });

});

describe('boot retroactive replay @regression @tier1', function(){

    it('a non-movable move refuses with the gate-move message, naming every moved key', async function(){
        const h = harness({ recorded: record(R) });
        const current = { [MOVABLE]: 95, [FIXED]: 60 };
        await assert.rejects(run(h, { current }), (error) => {
            assert.strictEqual(error.message,
                'consensus gate height moved at or below applied tip 100: ' +
                FIXED + ' (50 -> 60), ' + MOVABLE + ' (200 -> 95). ' +
                'Refusing to serve because committed blocks would be interpreted under different rules.');
            return true;
        });
        assert.deepStrictEqual(h.names(), [], 'a refusal writes no marker, record or rollback');
        assert.strictEqual(h.indexer.stallReason, null);
    });

    it('serves and records the map when nothing moved at or below the tip', async function(){
        const h = harness({ recorded: record(R) });
        const result = await run(h, { current: { [MOVABLE]: 150, [FIXED]: 50 } });
        assert.strictEqual(result.action, 'serve');
        assert.deepStrictEqual(h.names(), ['recordBoot']);
        assert.strictEqual(h.calls[0][2], 100);
    });

    it('a record from before the registry widening compares only the keys it holds', async function(){
        const added = { [MOVABLE]: 200, [FIXED]: 50, 'added_activation.ADDED_ACTIVATION': 0 };
        assert.deepStrictEqual(comparableGateMap(record(R, null), added), R);
        assert.strictEqual(comparableGateMap(record(R), added), added);

        const h = harness({ recorded: record(R, null) });
        const result = await run(h, { current: added });
        assert.strictEqual(result.action, 'serve');

        const w = harness({ recorded: record(R) });
        await assert.rejects(run(w, { current: added }), /added_activation\.ADDED_ACTIVATION/);
    });
});

// A fake indexer carrying the startup methods, with every write it makes.
function indexerFor({ replayMarker, tip }){
    const markers = [];
    const records = [];
    const rollbacks = [];
    const indexer = {
        config: { NETWORK: 'regtest', COIN: 'LTC', RETROACTIVE_REPLAY_CAP_BLOCKS: 1728 },
        stallReason: null,
        stallClearsAt: 999,
        indexerDb: {
            getBlockIndex: async () => tip,
            consensusHeightGateMap: () => C,
            readConsensusGateBoot: async () => ({ recorded: record(R), replayMarker }),
            recordConsensusGateBoot: async (map, at) => { records.push(at); },
            doQueryStrict: async (sql, params) => {
                if(/INSERT INTO events/.test(sql)) markers.push(JSON.parse(params[0]));
                return [];
            },
        },
        rollback: { rollback: async (target) => {
            rollbacks.push([target, indexer.stallReason, indexer.stallClearsAt]);
            indexer.stallReason = 'reorg_rollback';
        } },
        util: { throwError(message){ throw new Error(message); } },
        holdRetroactiveReplay: startup.holdRetroactiveReplay,
        holdRetroactiveReplayNeedsGo: startup.holdRetroactiveReplayNeedsGo,
        recordConsensusGateBoot: startup.recordConsensusGateBoot,
    };
    return { indexer, markers, records, rollbacks };
}

describe('boot retroactive replay through startup @regression @tier1', function(){

    it('resumes a pending marker: one rollback under retroactive_replay with no clear instant', async function(){
        const pending = buildReplayMarker({ target: 95, replayTo: 100,
            rulesFrom: gateMapDigest(R), rulesTo: gateMapDigest(C) });
        const f = indexerFor({ replayMarker: pending, tip: 100 });
        await f.indexer.recordConsensusGateBoot();

        assert.deepStrictEqual(f.rollbacks, [[95, 'retroactive_replay', null]]);
        assert.deepStrictEqual(f.records, [94]);
        assert.deepStrictEqual(f.markers.map(m => m.state), ['replaying']);
        assert.strictEqual(f.indexer.stallReason, 'retroactive_replay');
        assert.strictEqual(f.indexer.stallClearsAt, null);
        assert.strictEqual(f.indexer.replayMarker.state, 'replaying');

        // The next boot after that commit finds the tip below the target: no second rollback.
        const again = indexerFor({ replayMarker: pending, tip: 94 });
        await again.indexer.recordConsensusGateBoot();
        assert.deepStrictEqual(again.rollbacks, []);
        assert.deepStrictEqual(again.markers.map(m => m.state), ['replaying']);
    });

    it('refuses a non-movable production move before any write', async function(){
        const f = indexerFor({ replayMarker: null, tip: 100 });
        await assert.rejects(f.indexer.recordConsensusGateBoot(), /moved at or below applied tip 100/);
        assert.deepStrictEqual(f.rollbacks, []);
        assert.deepStrictEqual(f.records, []);
        assert.deepStrictEqual(f.markers, []);
    });

    it('carries the marker digests as sha256 of the canonical maps', function(){
        assert.strictEqual(gateMapDigest(C), crypto.createHash('sha256').update(canonical(C)).digest('hex'));
    });
});
