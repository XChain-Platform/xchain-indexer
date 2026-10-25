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
 * Persistence-boundary coverage for retroactive witness comparisons.
 *
 *********************************************************************/

'use strict';

const assert = require('assert');
const { gateMapDigest } = require('../../../../../src/consensus/retroactive/boot_replay.js');
const {
    buildReplayWitness,
    nextWitnessPhase,
} = require('../../../../../src/consensus/retroactive/replay_witness.js');
const {
    stepWitnessChunk,
    stepWitnessFinal,
} = require('../../../../../src/consensus/retroactive/witness_compare_step.js');
const {
    readLatestReplayWitness,
    readReplayWitnessBlocks,
    recordReplayWitness,
    recordReplayWitnessPhase,
} = require('../../../../../src/db/events/retroactive_replay_witness.js');
const { makeWitnessEventsDb } = require('./helpers/witness_events_db.js');

const GATE_HEIGHTS = { 'fixed.A': 5, 'movable.B': 200 };

function blocks(from, to, changed){
    return Array.from({ length: to - from + 1 }, (_, offset) => {
        const height = from + offset;
        return height === changed
            ? { block_index: height, block_hash: hash(height), ledger_hash: 'c'.repeat(64) }
            : { block_index: height, block_hash: hash(height) };
    });
}

function hash(value){
    return value.toString(16).padStart(64, '0');
}

async function fixture(replayTo, changed){
    const original = blocks(100, replayTo);
    const db = makeWitnessEventsDb({ blocks: blocks(100, 611, changed) });
    const recorded = buildReplayWitness({
        target: 100,
        replayTo,
        rulesFrom: gateMapDigest(GATE_HEIGHTS),
        gateHeights: GATE_HEIGHTS,
        blocks: original,
    });
    await recordReplayWitness(db, recorded);
    const witness = await readLatestReplayWitness(db);
    const deps = {
        readWitnessBlocks: (from, to) => readReplayWitnessBlocks(db, from, to),
        recordWitnessPhase: (batch, phase) => recordReplayWitnessPhase(db, batch, phase),
    };
    return { db, deps, recorded, witness };
}

async function measured(db, action){
    const before = db.queries.length;
    const result = await action();
    return { result, queries: db.queries.slice(before) };
}

describe('retroactive witness comparison steps @regression @tier1', function(){
    it('reads a matching intermediate chunk once without writing a phase', async function(){
        const { db, deps, witness } = await fixture(227);

        const skipped = await measured(db, () => stepWitnessChunk(witness, 150, deps));
        const matched = await measured(db, () => stepWitnessChunk(witness, 163, deps));

        assert.deepStrictEqual(skipped, { result: null, queries: [] });
        assert.strictEqual(matched.queries.length, 1);
        assert.deepStrictEqual(matched.queries[0].params, [100, 163]);
        assert.strictEqual(matched.result.writePhase, null);
        assert.strictEqual(matched.result.exit, false);
        assert.strictEqual(matched.result.phase, null);
        assert.strictEqual(matched.result.digest, witness.windows[0][2]);
    });

    it('writes witnessed after the matching replay-to chunk', async function(){
        const { db, deps, witness } = await fixture(227);

        const completed = await measured(db, () => stepWitnessChunk(witness, 227, deps));
        const latest = await readLatestReplayWitness(db);

        assert.strictEqual(completed.queries.length, 2);
        assert.strictEqual(completed.result.writePhase, 'witnessed');
        assert.strictEqual(completed.result.exit, true);
        assert.strictEqual(completed.result.stallReason, null);
        assert.deepStrictEqual(completed.result.phase, latest.phase);
        assert.ok(!Object.prototype.hasOwnProperty.call(latest.phase, 'changed'));
    });

    it('writes diverged after a mismatching chunk', async function(){
        const { db, deps, witness } = await fixture(227, 170);

        const first = await stepWitnessChunk(witness, 163, deps);
        const diverged = await measured(db, () => stepWitnessChunk(witness, 227, deps));
        const latest = await readLatestReplayWitness(db);

        assert.strictEqual(first.writePhase, null);
        assert.strictEqual(diverged.queries.length, 2);
        assert.strictEqual(diverged.result.writePhase, 'diverged');
        assert.strictEqual(diverged.result.stallReason, 'retroactive_replay_diverged');
        assert.strictEqual(diverged.result.exit, false);
        assert.strictEqual(diverged.result.phase.phase, 'diverged');
        assert.deepStrictEqual(diverged.result.phase, latest.phase);
    });

    it('records unchanged and changed final comparisons exactly once', async function(){
        for(const changed of [undefined, 170]){
            const { db, deps, recorded, witness } = await fixture(227, changed);
            const final = nextWitnessPhase(witness.phase, 'final');
            await recordReplayWitnessPhase(db, recorded.batch, final);
            const ready = await readLatestReplayWitness(db);

            const early = await measured(db, () => stepWitnessFinal(ready, 226, deps));
            const compared = await measured(db, () => stepWitnessFinal(ready, 227, deps));
            const latest = await readLatestReplayWitness(db);
            const repeated = await measured(db, () => stepWitnessFinal(latest, 230, deps));

            assert.deepStrictEqual(early, { result: null, queries: [] });
            assert.strictEqual(compared.queries.length, 2);
            assert.strictEqual(compared.result.changed, changed !== undefined);
            assert.strictEqual(compared.result.phase.changed, changed !== undefined);
            assert.deepStrictEqual(latest.phase, compared.result.phase);
            assert.deepStrictEqual(repeated, { result: null, queries: [] });
        }
    });

    it('keeps comparison reads constant across two and eight windows', async function(){
        for(const replayTo of [227, 611]){
            const { db, deps, recorded, witness } = await fixture(replayTo);
            const chunk = await measured(db, () => stepWitnessChunk(witness, replayTo, deps));
            const final = nextWitnessPhase(recorded.phase, 'final');
            await recordReplayWitnessPhase(db, recorded.batch, final);
            const ready = await readLatestReplayWitness(db);
            const compared = await measured(db, () => stepWitnessFinal(ready, replayTo, deps));

            assert.strictEqual(chunk.queries.length, 2);
            assert.strictEqual(compared.queries.length, 2);
            assert.strictEqual(chunk.queries.filter(query => query.sql.startsWith('SELECT')).length, 1);
            assert.strictEqual(compared.queries.filter(query => query.sql.startsWith('SELECT')).length, 1);
        }
    });

    it('does no comparison outside active phases or without a witness', async function(){
        const { db, deps, witness } = await fixture(227);
        const witnessed = { ...witness, phase: nextWitnessPhase(witness.phase, 'witnessed') };

        for(const action of [
            () => stepWitnessChunk(null, 163, deps),
            () => stepWitnessChunk(witnessed, 163, deps),
            () => stepWitnessFinal(null, 227, deps),
            () => stepWitnessFinal(witness, 227, deps),
        ]){
            assert.deepStrictEqual(await measured(db, action), { result: null, queries: [] });
        }
    });

    it('rejects either missing dependency before reading', async function(){
        const { db, deps, witness } = await fixture(227);

        for(const invalid of [
            {},
            { readWitnessBlocks: deps.readWitnessBlocks },
            { recordWitnessPhase: deps.recordWitnessPhase },
        ]){
            const before = db.queries.length;
            await assert.rejects(stepWitnessChunk(witness, 163, invalid), TypeError);
            await assert.rejects(stepWitnessFinal({
                ...witness,
                phase: nextWitnessPhase(witness.phase, 'final'),
            }, 227, invalid), TypeError);
            assert.strictEqual(db.queries.length, before);
        }
    });
});
