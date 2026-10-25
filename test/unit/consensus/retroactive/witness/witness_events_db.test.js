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
 * Shared in-memory persistence for replay witness integration tests.
 *
 *********************************************************************/

'use strict';

const assert = require('assert');
const { gateMapDigest } = require('../../../../../src/consensus/retroactive/boot_replay.js');
const { buildReplayWitness } = require('../../../../../src/consensus/retroactive/replay_witness.js');
const {
    recordReplayWitness,
    recordReplayWitnessPhase,
    readLatestReplayWitness,
    readReplayWitnessBlocks,
} = require('../../../../../src/db/events/retroactive_replay_witness.js');
const { makeWitnessEventsDb } = require('./helpers/witness_events_db.js');

const GATE_HEIGHTS = {
    'fixed_activation.FIXED_ACTIVATION': 5,
    'movable_activation.MOVABLE_ACTIVATION': 200,
};

function block(height){
    return { block_index: height, block_hash: height.toString(16).padStart(64, '0') };
}

function blocks(from, to){
    return Array.from({ length: to - from + 1 }, (_, offset) => block(from + offset));
}

function witness(replayTo){
    return buildReplayWitness({
        target: 100,
        replayTo,
        rulesFrom: gateMapDigest(GATE_HEIGHTS),
        gateHeights: GATE_HEIGHTS,
        blocks: blocks(100, replayTo),
    });
}

describe('replay witness events database fixture @regression @tier1', function(){
    it('round-trips witness rows and a later phase through the real event code', async function(){
        const db = makeWitnessEventsDb({ blocks: blocks(100, 611) });
        const recorded = witness(227);

        await recordReplayWitness(db, recorded);
        const initial = await readLatestReplayWitness(db);
        assert.deepStrictEqual(initial, {
            batch: recorded.batch,
            phase: recorded.phase,
            windows: recorded.windows,
            gateHeights: GATE_HEIGHTS,
        });

        const diverged = { ...recorded.phase, phase: 'diverged', changed: true };
        await recordReplayWitnessPhase(db, recorded.batch, diverged);
        const latest = await readLatestReplayWitness(db);
        assert.deepStrictEqual(latest.phase, diverged);
        assert.deepStrictEqual(latest.windows, recorded.windows);
        assert.deepStrictEqual(latest.gateHeights, GATE_HEIGHTS);
        assert.strictEqual(db.events.length, recorded.windows.length + 4);
        assert.deepStrictEqual(db.events.map(event => event.id), [1, 2, 3, 4, 5, 6]);
    });

    it('returns an inclusive block chunk in ascending height order', async function(){
        const seeded = blocks(100, 611).reverse();
        const db = makeWitnessEventsDb({ blocks: seeded });

        const rows = await readReplayWitnessBlocks(db, 164, 227);

        assert.strictEqual(rows.length, 64);
        assert.strictEqual(rows[0].block_index, 164);
        assert.strictEqual(rows[63].block_index, 227);
    });

    it('uses three reads for both two-window and eight-window witnesses', async function(){
        for(const replayTo of [227, 611]){
            const db = makeWitnessEventsDb({ blocks: blocks(100, replayTo) });
            const recorded = witness(replayTo);
            await recordReplayWitness(db, recorded);
            const before = db.queries.length;

            const restored = await readLatestReplayWitness(db);

            assert.strictEqual(db.queries.length - before, 3);
            assert.strictEqual(restored.windows.length, replayTo === 227 ? 2 : 8);
            assert.strictEqual(restored.batch, recorded.batch);
        }
    });

    it('records and rejects unsupported statements', async function(){
        const db = makeWitnessEventsDb({ blocks: [] });

        await assert.rejects(db.doQueryStrict('SELECT 1', []),
            /unsupported witness events query/);
        assert.deepStrictEqual(db.queries, [{ sql: 'SELECT 1', params: [] }]);
    });
});
