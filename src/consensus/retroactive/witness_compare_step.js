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
 * Persistence boundary for retroactive replay witness comparisons.
 *
 *********************************************************************/

'use strict';

const {
    nextWitnessPhase,
    observedWindowDigest,
} = require('./replay_witness.js');
const {
    chunkClosingAt,
    planFinalCompare,
    planWitnessChunk,
    windowRows,
} = require('./witness_chunks.js');

function comparisonDeps(deps){
    if(!deps || typeof deps.readWitnessBlocks !== 'function' ||
       typeof deps.recordWitnessPhase !== 'function')
        throw new TypeError('readWitnessBlocks and recordWitnessPhase are required');
}

async function stepWitnessChunk(witness, height, deps){
    comparisonDeps(deps);
    if(!witness || witness.phase.phase !== 'witness') return null;

    const rows = windowRows(witness.phase, witness.windows);
    const chunk = chunkClosingAt(rows, height);
    if(!chunk) return null;

    const blocks = await deps.readWitnessBlocks(chunk.from, chunk.to);
    const digest = observedWindowDigest(blocks, chunk.from, chunk.to);
    const plan = planWitnessChunk({
        phase: witness.phase.phase,
        replayTo: witness.phase.replay_to,
        rows,
        height,
        digest,
    });
    const phase = plan.writePhase
        ? nextWitnessPhase(witness.phase, plan.writePhase) : null;
    if(phase) await deps.recordWitnessPhase(witness.batch, phase);
    return { ...plan, digest, phase };
}

async function stepWitnessFinal(witness, height, deps){
    comparisonDeps(deps);
    if(!witness || witness.phase.phase !== 'final' ||
       typeof witness.phase.changed === 'boolean' || height < witness.phase.replay_to)
        return null;

    const rows = windowRows(witness.phase, witness.windows);
    const blocks = await deps.readWitnessBlocks(
        witness.phase.target,
        witness.phase.replay_to
    );
    const plan = planFinalCompare({
        phase: witness.phase.phase,
        replayTo: witness.phase.replay_to,
        height,
        rows,
        blocks,
    });
    const phase = nextWitnessPhase(witness.phase, 'final', plan.changed);
    await deps.recordWitnessPhase(witness.batch, phase);
    return { ...plan, phase };
}

module.exports = { stepWitnessChunk, stepWitnessFinal };
