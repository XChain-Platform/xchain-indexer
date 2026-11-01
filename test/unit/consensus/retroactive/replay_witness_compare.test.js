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
 * The replay witness compare in the real block loop: each recorded chunk is held
 * against the committed rows as its last block commits, a mismatch holds the replay
 * open, a full match ends the process at replay_to, and the final pass records
 * whether the window changed before the marker closes.
 *
 *********************************************************************/

'use strict';

const assert = require('assert');
const XChainIndexer = require('../../../../src/XChainIndexer.js');
const startup = require('../../../../src/XChainIndexer/startup.js');
const changes = require('../../../../src/protocol_changes.js');
const { gateMapDigest } = require('../../../../src/consensus/retroactive/boot_replay.js');
const { buildReplayWitness, nextWitnessPhase } =
    require('../../../../src/consensus/retroactive/replay_witness.js');
const { buildReplayMarker, advanceReplayMarker } =
    require('../../../../src/consensus/retroactive/replay_marker.js');
const { heightIsFinal } = require('../../../../src/consensus/retroactive/replay_status.js');
const {
    readLatestReplayWitness,
    recordReplayWitness,
    recordReplayWitnessPhase,
} = require('../../../../src/db/events/retroactive_replay_witness.js');
const { makeWitnessEventsDb } = require('./witness/helpers/witness_events_db.js');

const GATE_HEIGHTS = { 'fixed.A': 5, 'movable.B': 200 };
const TARGET = 100;
const REPLAY_TO = 227;          // two 64-block chunks: 100-163 and 164-227
const DECODER_TIP = 230;
const MARKER_INSERT = "INSERT INTO events (time, code, data) VALUES (NOW(), 'CONSENSUS_RETRO_REPLAY', ?)";
const LATEST_PHASE_READ = 'SELECT id, data, witness_hash FROM events WHERE code = ? ORDER BY id DESC LIMIT 1';

function hash(value){
    return value.toString(16).padStart(64, '0');
}

function block(height){
    return { block_index: height, block_hash: hash(height), ledger_hash: hash(height + 5000) };
}

function chainBlocks(){
    const out = [];
    for(let height = TARGET; height <= DECODER_TIP; height++) out.push(block(height));
    return out;
}

// Rewrites one committed block's ledger hash in place, as a replay that produced
// different state at that height would leave it.
function changeLedgerAt(f, height){
    const row = f.blocks.find(b => b.block_index === height);
    row.ledger_hash = 'c'.repeat(64);
    f.db.rewriteBlockDigests(height, { ledger_hash: row.ledger_hash });
}

// The durable rows a witness boot leaves (window, map and phase rows, then the
// replaying marker), and an indexer built on the real prototype whose block parse
// is a stand-in that commits every block it is handed.
async function fixture(){
    const blocks = chainBlocks();
    const db = makeWitnessEventsDb({ blocks });
    const markerWrites = [];
    const query = db.doQueryStrict;
    db.doQueryStrict = async (sql, params) => {
        if(sql === MARKER_INSERT){
            markerWrites.push(JSON.parse(params[0]));
            return { insertId: markerWrites.length, affectedRows: 1 };
        }
        return query(sql, params);
    };

    const recorded = buildReplayWitness({
        target: TARGET,
        replayTo: REPLAY_TO,
        rulesFrom: gateMapDigest(GATE_HEIGHTS),
        gateHeights: GATE_HEIGHTS,
        blocks: blocks.filter(b => b.block_index <= REPLAY_TO),
    });
    await recordReplayWitness(db, recorded);
    const marker = advanceReplayMarker(buildReplayMarker({
        target: TARGET,
        replayTo: REPLAY_TO,
        rulesFrom: recorded.rulesFrom,
        rulesTo: 'd'.repeat(64),
    }), 'replaying');

    const f = { blocks, db, markerWrites, marker, applied: [], exits: [], barrierHolds: 0, boots: 0 };
    f.indexer = (phase) => loopIndexer(f, phase);
    f.latestPhaseReads = () => db.queries.filter(q => q.sql === LATEST_PHASE_READ).length;
    return f;
}

// An indexer on the real prototype: the real poll pass, catch-up loop and witness hooks,
// with stand-ins only for the cursor read, the block parse and the process exit.
function loopIndexer(f, phase){
    const indexer = Object.create(XChainIndexer.prototype);
    Object.assign(indexer, {
        replayMarker: f.marker,
        replayWitnessPhase: phase,
        replayWitness: null,
        decoderDb: f.db.decoderDb,
        stallReason: 'retroactive_replay',
        stallClearsAt: 999,
        stallBlock: null,
        stopFlag: false,
        synced: false,
        decoderReorgHalted: false,
        util: {
            isNull: value => value === null || value === undefined,
            bclt: (left, right) => Number(left) < Number(right),
            bcadd: (left, right) => Number(left) + Number(right),
            bcsub: (left, right) => Number(left) - Number(right),
            startTimer: () => null,
        },
        cursor: TARGET - 1,
        readPollCursors: async () => ({
            lastProcessedReorgId: null, unprocessedReorgs: [],
            lastDecoderBlock: DECODER_TIP, lastIndexerBlock: indexer.cursor,
        }),
        reorgLandedMidCatchUp: async () => false,
        parseBlock: async (height, previous, decoderTip) => {
            f.applied.push(height);
            indexer.cursor = height;
            return { committed: true, stop: false, lastDecoderBlock: decoderTip };
        },
        noteBarrierHold: () => { f.barrierHolds++; },
        recordConsensusGateBoot: async () => { f.boots++; },
        exitAfterReplayWitness: (height) => { f.exits.push(height); },
    });
    return indexer;
}

describe('retroactive replay witness chunk compare in the block loop @regression @tier1', function(){

    it('a mismatched chunk stops block application with the marker still replaying and final false at or above target', async function(){
        const f = await fixture();
        changeLedgerAt(f, 170);
        const indexer = f.indexer('witness');

        await indexer.pollDecoderOnce(f.db, 50);

        // The first chunk matched and wrote nothing; the second stopped the loop at its close.
        assert.strictEqual(f.applied[0], TARGET);
        assert.strictEqual(f.applied[f.applied.length - 1], REPLAY_TO);
        assert.strictEqual(f.applied.includes(REPLAY_TO + 1), false);
        const witness = await readLatestReplayWitness(f.db);
        assert.strictEqual(witness.phase.phase, 'diverged');
        assert.strictEqual(witness.phase.changed, undefined);
        assert.strictEqual(indexer.replayMarker.state, 'replaying');
        assert.deepStrictEqual(f.markerWrites, []);
        assert.strictEqual(heightIsFinal(TARGET, indexer.replayMarker), false);
        assert.strictEqual(heightIsFinal(REPLAY_TO, indexer.replayMarker), false);
        assert.strictEqual(heightIsFinal(TARGET - 1, indexer.replayMarker), true);
        assert.deepStrictEqual(f.exits, []);
    });

    it('the diverged stall holds every later pass with stallClearsAt null and no barrier hold', async function(){
        const f = await fixture();
        changeLedgerAt(f, 170);
        const indexer = f.indexer('witness');

        await indexer.pollDecoderOnce(f.db, 50);
        assert.strictEqual(indexer.stallReason, 'retroactive_replay_diverged');
        assert.strictEqual(indexer.stallClearsAt, null);

        const applied = f.applied.length;
        indexer.stallClearsAt = 999;
        await indexer.pollDecoderOnce(f.db, 50);
        await indexer.pollDecoderOnce(f.db, 50);

        assert.strictEqual(f.applied.length, applied, 'no block applies while diverged');
        assert.strictEqual(indexer.stallReason, 'retroactive_replay_diverged');
        assert.strictEqual(indexer.stallClearsAt, null);
        assert.strictEqual(f.barrierHolds, 0, 'a data fault is never folded into the mirror-barrier ceiling');
        assert.strictEqual(indexer.replayMarker.state, 'replaying');
        assert.strictEqual(f.latestPhaseReads(), 1, 'the witness rows are read once, then kept current');
    });

});

describe('retroactive replay witness exit and final compare @regression @tier1', function(){

    it('a full match exits at replay_to with the witnessed phase written and the rules left to the next boot', async function(){
        const f = await fixture();
        const indexer = f.indexer('witness');
        const overlay = changes.registry.getReadOverlay();

        await indexer.pollDecoderOnce(f.db, 50);

        assert.strictEqual(f.applied[f.applied.length - 1], REPLAY_TO);
        assert.strictEqual(f.applied.includes(REPLAY_TO + 1), false);
        assert.strictEqual((await readLatestReplayWitness(f.db)).phase.phase, 'witnessed');
        assert.deepStrictEqual(f.exits, [REPLAY_TO]);
        assert.strictEqual(indexer.replayMarker.state, 'replaying');
        assert.deepStrictEqual(f.markerWrites, []);
        // Boot-only switch: the pass never re-runs the boot or touches the rules overlay.
        assert.strictEqual(f.boots, 0);
        assert.strictEqual(changes.registry.getReadOverlay(), overlay);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(indexer, 'completeRetroactiveReplay'), false);
        assert.strictEqual(indexer.stallReason === 'retroactive_replay_diverged', false);
    });

    it('the boot-only switch: no in-process handoff remains and the exit is a nonzero process exit', function(){
        assert.strictEqual(startup.armReplayWitnessCompletion, undefined);
        assert.strictEqual(typeof XChainIndexer.prototype.exitAfterReplayWitness, 'function');

        const exit = process.exit;
        const codes = [];
        process.exit = (code) => { codes.push(code); };
        try {
            XChainIndexer.prototype.exitAfterReplayWitness.call({}, REPLAY_TO);
        } finally {
            process.exit = exit;
        }
        assert.deepStrictEqual(codes, [1]);
    });

    for(const [label, changed] of [['unchanged', false], ['changed', true]]){
        it('a matched window reaching replayed with changed set (' + label + ' under the current rules)', async function(){
            const f = await fixture();
            await f.indexer('witness').pollDecoderOnce(f.db, 50);
            const witnessed = await readLatestReplayWitness(f.db);
            assert.strictEqual(witnessed.phase.phase, 'witnessed');

            // The next boot rolls back, writes 'final' and replays under the current rules.
            await recordReplayWitnessPhase(f.db, witnessed.batch, nextWitnessPhase(witnessed.phase, 'final'));
            if(changed) changeLedgerAt(f, 170);
            f.applied.length = 0;
            const indexer = f.indexer('final');

            await indexer.pollDecoderOnce(f.db, 50);

            const witness = await readLatestReplayWitness(f.db);
            assert.strictEqual(f.applied[f.applied.length - 1], DECODER_TIP, 'the final pass is not chunk-gated');
            assert.strictEqual(witness.phase.phase, 'final');
            assert.strictEqual(witness.phase.changed, changed);
            assert.strictEqual(indexer.replayMarker.state, 'replayed');
            assert.deepStrictEqual(f.markerWrites.map(m => m.state), ['replayed']);
            assert.strictEqual(heightIsFinal(REPLAY_TO, indexer.replayMarker), true);
            assert.strictEqual(indexer.stallReason, null);
            assert.deepStrictEqual(f.exits, [REPLAY_TO]);
        });
    }

    it('the marker stays open at replay_to until the final pass has recorded changed', async function(){
        const f = await fixture();
        const indexer = f.indexer('witness');
        indexer.cursor = REPLAY_TO;

        // A witness pass at replay_to never closes the replay, whatever the committed tip.
        assert.strictEqual(await indexer.completeRetroactiveReplay(f.db, REPLAY_TO), false);
        assert.strictEqual(indexer.replayMarker.state, 'replaying');
        assert.deepStrictEqual(f.markerWrites, []);
    });
});
