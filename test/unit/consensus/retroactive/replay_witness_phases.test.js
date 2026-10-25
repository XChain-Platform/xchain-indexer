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
        const h = harness('witness', 'replayed', { tip: 100 });
        const result = await run(h, h.durable.tip);
        const rollbackAt = h.calls.findIndex(call => call[0] === 'rollback');
        const witnessedAt = h.calls.findIndex(call => call[0] === 'phase' && call[1] === 'witnessed');
        const finalAt = h.calls.findIndex(call => call[0] === 'phase' && call[1] === 'final');

        assert.ok(rollbackAt >= 0 && rollbackAt < witnessedAt, JSON.stringify(h.calls));
        assert.ok(witnessedAt < finalAt, JSON.stringify(h.calls));
        assert.strictEqual(h.calls.filter(call => call[0] === 'rollback').length, 1);
        assert.deepStrictEqual(h.calls.find(call => call[0] === 'boot'), ['boot', C, 94]);
        assert.strictEqual(result.marker.state, 'replaying');
        assert.strictEqual(result.phase, 'final');
    });

    it('re-runs a mid-witness restart from the target under the recorded rules; final keeps current rules', async function(){
        const active = harness('witness', 'replaying', { tip: 97 });
        await run(active, 97);
        assert.deepStrictEqual(active.calls, [
            ['rules', 'recorded', R],
            ['hold'],
            ['rollback', 95],
            ['hold'],
            ['boot', R, 94],
        ]);

        const final = harness('final', 'replaying', { tip: 97, recorded: C });
        await run(final, 97);
        assert.deepStrictEqual(final.calls.filter(call => call[0] === 'rules'), [
            ['rules', 'current'],
        ]);
        assert.strictEqual(final.calls.some(call => call[0] === 'rollback'), false);
    });
});

// The same phases driven through the production boot, startup.recordConsensusGateBoot,
// against the process gate registry and an in-memory events table, so the overlay
// assertions fail if startup.js does not install or remove the recorded rules.
const changes = require('../../../../src/protocol_changes.js');
const { gateHeightMap } = require('../../../../src/consensus/retroactive/gate_heights.js');
const { buildReplayWitness } = require('../../../../src/consensus/retroactive/replay_witness.js');
const {
    REPLAY_WITNESS_PHASE_CODE,
    recordReplayWitness,
    recordReplayWitnessPhase,
} = require('../../../../src/db/events/retroactive_replay_witness.js');
const {
    readLatestReplayMarker,
    recordReplayMarker,
} = require('../../../../src/db/events/retroactive_replay_marker.js');

// A live registry key whose table holds a BTC:testnet entry beside the testnet one.
const LIVE_KEY = 'anchor_bundle_order_activation.ANCHOR_BUNDLE_ORDER_ACTIVATION';
const NETWORK = 'testnet';
const COIN = 'BTC';
const COIN_NETWORK = COIN + ':' + NETWORK;
const RECORDED_HEIGHT = 150000;

function windowBlocks(from, to){
    return Array.from({ length: to - from + 1 }, (_, offset) => ({
        block_index: from + offset,
        block_hash: (from + offset).toString(16).padStart(64, '0'),
    }));
}

// Durable state that survives a restart: the events table, the applied tip and the
// recorded gate map. Each boot() is one process start through the real startup method.
function startupIndexer(maps, { tip }){
    const events = [];
    const rollbacks = [];
    const boots = [];
    const state = { tip, recorded: { gateHeights: maps.recorded, appliedTip: tip, scope: 'registry' } };
    const db = {
        async doQueryStrict(sql, params = []){
            const text = String(sql);
            if(/^INSERT INTO events \(time, code, data\) VALUES \(NOW\(\), '([A-Z_]+)', \?\)/.test(text)){
                const code = /'([A-Z_]+)'/.exec(text)[1];
                events.push({ id: events.length + 1, code, data: params[0], witness_hash: null });
                return [];
            }
            if(/^INSERT INTO events \(time, code, data, witness_hash\)/.test(text)){
                events.push({ id: events.length + 1, code: params[0], data: params[1], witness_hash: params[2] });
                return [];
            }
            if(/^SELECT data FROM events WHERE code = '([A-Z_]+)' ORDER BY id DESC LIMIT 1$/.test(text)){
                const code = /'([A-Z_]+)'/.exec(text)[1];
                return events.filter(row => row.code === code).slice(-1);
            }
            if(/^SELECT id, data, witness_hash FROM events WHERE code = \? ORDER BY id DESC LIMIT 1$/.test(text))
                return events.filter(row => row.code === params[0]).slice(-1);
            if(/^SELECT data FROM events WHERE code = \? AND witness_hash = \? AND id < \?/.test(text)){
                const [code, batch, before, limit] = params;
                return events.filter(row => row.code === code && row.witness_hash === batch && row.id < before)
                    .reverse().slice(0, limit);
            }
            // The indexer blocks table carries only this node's digests; the chain hash
            // comes from the decoder double below.
            if(/FROM blocks b/.test(text))
                return windowBlocks(params[0], params[1]).map(row => ({ block_index: row.block_index }));
            throw new Error('unexpected query: ' + text);
        },
        getBlockIndex: async () => state.tip,
        consensusHeightGateMap: (network, coin) => gateHeightMap(changes.registry, network, coin),
        readConsensusGateBoot: async () => ({
            recorded: state.recorded,
            replayMarker: await readLatestReplayMarker(db),
        }),
        recordConsensusGateBoot: async (map, at) => {
            boots.push([map, at]);
            state.recorded = { gateHeights: map, appliedTip: at, scope: 'registry' };
        },
    };
    const indexer = {
        config: { NETWORK, COIN, RETROACTIVE_REPLAY_CAP_BLOCKS: 1728 },
        stallReason: null,
        stallClearsAt: 999,
        indexerDb: db,
        decoderDb: {
            getDecoderBlockHashRow: async (height) => windowBlocks(height, height)
                .map(row => ({ block_hash: row.block_hash })),
        },
        decoderReadView: startup.decoderReadView,
        rollback: { rollback: async (target) => {
            rollbacks.push(target);
            state.tip = target - 1;
        } },
        util: { throwError(message){ throw new Error(message); } },
        holdRetroactiveReplay: startup.holdRetroactiveReplay,
        holdRetroactiveReplayNeedsGo: startup.holdRetroactiveReplayNeedsGo,
        holdRetroactiveReplayDiverged: startup.holdRetroactiveReplayDiverged,
        recordConsensusGateBoot: startup.recordConsensusGateBoot,
    };
    const phases = () => events.filter(row => row.code === REPLAY_WITNESS_PHASE_CODE)
        .map(row => JSON.parse(row.data).phase);
    const markers = () => events.filter(row => row.code === 'CONSENSUS_RETRO_REPLAY')
        .map(row => JSON.parse(row.data).state);
    const boot = async () => {
        const restarted = Object.assign(Object.create(null), indexer, {
            stallReason: null, stallClearsAt: 999, replayMarker: null,
        });
        await indexer.recordConsensusGateBoot.call(restarted);
        return restarted;
    };
    return { db, state, events, rollbacks, boots, phases, markers, boot };
}

// Writes the witness rows, an optional later phase row and the marker, as the earlier
// boot and the block loop would have left them.
async function seedWitness(f, maps, { phase, markerState }){
    const rulesFrom = gateMapDigest(maps.recorded);
    const witness = buildReplayWitness({
        target: 95, replayTo: 100, rulesFrom, gateHeights: maps.recorded,
        blocks: windowBlocks(95, 100),
    });
    await recordReplayWitness(f.db, witness);
    if(phase !== 'witness')
        await recordReplayWitnessPhase(f.db, witness.batch, Object.assign({}, witness.phase, { phase }));
    let next = buildReplayMarker({
        target: 95, replayTo: 100, rulesFrom, rulesTo: gateMapDigest(maps.current),
    });
    if(markerState !== 'pending') next = advanceReplayMarker(next, 'replaying');
    if(markerState === 'replayed') next = advanceReplayMarker(next, 'replayed');
    await recordReplayMarker(f.db, next);
    return witness;
}

describe('retroactive replay witness boot phases through startup @regression @tier1', function(){
    let base;
    let maps;
    let baseTable;

    before(function(){
        base = changes.registry.getReadOverlay();
        baseTable = changes.registry.get(LIVE_KEY);
        assert.strictEqual(typeof baseTable[COIN_NETWORK], 'number');
        assert.notStrictEqual(baseTable[COIN_NETWORK], RECORDED_HEIGHT);
        const current = gateHeightMap(changes.registry, NETWORK, COIN);
        maps = { current, recorded: Object.assign({}, current, { [LIVE_KEY]: RECORDED_HEIGHT }) };
    });

    // The registry is shared by every suite in the process.
    afterEach(function(){
        changes.registry.setReadOverlay(base);
    });

    it('a witness boot with tip >= H rolls back first and replaces the COIN:network entry with the recorded value', async function(){
        const f = startupIndexer(maps, { tip: 100 });
        await seedWitness(f, maps, { phase: 'witness', markerState: 'pending' });
        const first = await f.boot();

        assert.deepStrictEqual(f.rollbacks, [95]);
        assert.deepStrictEqual(f.boots, [[maps.recorded, 94]]);
        assert.deepStrictEqual(f.markers(), ['pending', 'replaying']);
        assert.strictEqual(first.stallReason, 'retroactive_replay');
        assert.notStrictEqual(changes.registry.getReadOverlay(), base);
        assert.deepStrictEqual(changes.registry.get(LIVE_KEY),
            Object.assign({}, baseTable, { [COIN_NETWORK]: RECORDED_HEIGHT }));
        assert.strictEqual(gateHeightMap(changes.registry, NETWORK, COIN)[LIVE_KEY], RECORDED_HEIGHT);

        // A crash after the rollback commit: the tip is below H, so no second rollback.
        await f.boot();
        assert.deepStrictEqual(f.rollbacks, [95]);
        assert.strictEqual(changes.registry.get(LIVE_KEY)[COIN_NETWORK], RECORDED_HEIGHT);
    });

    it('a restart mid-witness at or above H re-runs the window from the target', async function(){
        const f = startupIndexer(maps, { tip: 98 });
        await seedWitness(f, maps, { phase: 'witness', markerState: 'replaying' });
        await f.boot();

        assert.deepStrictEqual(f.rollbacks, [95]);
        assert.deepStrictEqual(f.boots, [[maps.recorded, 94]]);
        assert.deepStrictEqual(f.markers(), ['replaying']);
        assert.strictEqual(changes.registry.get(LIVE_KEY)[COIN_NETWORK], RECORDED_HEIGHT);
    });

    it('witnessed rolls back a second time, writes final and removes the overlay for the new-rules pass', async function(){
        const f = startupIndexer(maps, { tip: 100 });
        const witness = await seedWitness(f, maps, { phase: 'witness', markerState: 'pending' });
        await f.boot();
        assert.strictEqual(changes.registry.get(LIVE_KEY)[COIN_NETWORK], RECORDED_HEIGHT);

        // The witness pass reaches replay_to and the block loop records 'witnessed'.
        f.state.tip = 100;
        await recordReplayWitnessPhase(f.db, witness.batch, Object.assign({}, witness.phase, { phase: 'witnessed' }));
        await f.boot();

        assert.deepStrictEqual(f.rollbacks, [95, 95]);
        assert.deepStrictEqual(f.boots[f.boots.length - 1], [maps.current, 94]);
        assert.deepStrictEqual(f.phases(), ['witness', 'witnessed', 'final']);
        assert.strictEqual(changes.registry.getReadOverlay(), base);
        assert.deepStrictEqual(changes.registry.get(LIVE_KEY), baseTable);

        // A crash after the final write resumes the open marker with no third rollback.
        await f.boot();
        assert.deepStrictEqual(f.rollbacks, [95, 95]);
        assert.deepStrictEqual(f.phases(), ['witness', 'witnessed', 'final']);
        assert.strictEqual(changes.registry.getReadOverlay(), base);
    });

    it('a crash after the second rollback commits writes final without rolling back again', async function(){
        const f = startupIndexer(maps, { tip: 94 });
        await seedWitness(f, maps, { phase: 'witnessed', markerState: 'replaying' });
        await f.boot();

        assert.deepStrictEqual(f.rollbacks, []);
        assert.deepStrictEqual(f.phases(), ['witness', 'witnessed', 'final']);
        assert.deepStrictEqual(f.markers(), ['replaying', 'pending', 'replaying']);
        assert.deepStrictEqual(f.boots, [[maps.current, 94]]);
        assert.strictEqual(changes.registry.getReadOverlay(), base);
    });

    it('a diverged witness holds the replay with no rollback and no overlay', async function(){
        const f = startupIndexer(maps, { tip: 98 });
        await seedWitness(f, maps, { phase: 'diverged', markerState: 'replaying' });
        const held = await f.boot();

        assert.deepStrictEqual(f.rollbacks, []);
        assert.deepStrictEqual(f.boots, []);
        assert.strictEqual(held.stallReason, 'retroactive_replay_diverged');
        assert.strictEqual(held.replayWitness.phase.phase, 'diverged');
        assert.strictEqual(held.stallClearsAt, null);
        assert.strictEqual(held.replayWitnessPhase, 'diverged');
        assert.strictEqual(changes.registry.getReadOverlay(), base);
    });

    it('a closed marker whose witness reached final compares maps again on the next boot', async function(){
        const f = startupIndexer(maps, { tip: 200000 });
        await seedWitness(f, maps, { phase: 'final', markerState: 'replayed' });

        // The recorded map still holds the pre-move value, so the boot must see the move.
        await assert.rejects(f.boot(), /moved at or below applied tip 200000/);
        assert.deepStrictEqual(f.rollbacks, []);

        f.state.recorded = { gateHeights: maps.current, appliedTip: 200000, scope: 'registry' };
        await f.boot();
        assert.deepStrictEqual(f.boots, [[maps.current, 200000]]);
        assert.deepStrictEqual(f.rollbacks, []);
    });
});
