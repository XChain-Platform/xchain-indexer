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
 * The boot-time retroactive replay sequence: an open marker resumes first,
 * otherwise the recorded and current gate maps decide between serving,
 * refusing and a marked rollback to the target. Every read and write is an
 * injected dependency, so the order of the durable steps is testable without
 * a database and a crash between any two of them resumes cleanly.
 *
 *********************************************************************/

'use strict';

const crypto = require('crypto');
const { canonical } = require('../../consensus_rules_digest.js');
const { classifyGateMoves } = require('./gate_heights.js');
const { planRetroactiveBoot } = require('./boot_plan.js');
const { buildReplayMarker, advanceReplayMarker, isReplayOpen } = require('./replay_marker.js');
const { goRulesSha, goCommand } = require('./go_binding.js');
const { buildReplayWitness } = require('./replay_witness.js');

// Marks a gate boot record written over the full height and time registry. A record
// without it predates the widening and saw only the height keys it lists, so a key
// it lacks is unrecorded rather than moved.
const GATE_RECORD_SCOPE = 'registry';
const MIRROR_CHAINS = new Set(['BTC', 'LTC', 'DOGE']);

// sha256 of the canonical gate map, the applied-rules digest a replay marker carries.
function gateMapDigest(gateHeights){
    return crypto.createHash('sha256').update(canonical(gateHeights)).digest('hex');
}

// The current map restricted to what the recorded batch can be compared against.
function comparableGateMap(recorded, current){
    if(!recorded || recorded.scope === GATE_RECORD_SCOPE) return current;
    const out = {};
    for(const key of Object.keys(current)){
        if(Object.prototype.hasOwnProperty.call(recorded.gateHeights, key)) out[key] = current[key];
    }
    return out;
}

// The gate-move refusal text the boot record has always used, every moved key in order.
function movedGateMessage(moves, tip){
    const detail = [...moves].sort((a, b) => a.key.localeCompare(b.key))
        .map(move => move.key + ' (' + String(move.from) + ' -> ' + String(move.to) + ')').join(', ');
    return 'consensus gate height moved at or below applied tip ' + tip + ': ' + detail +
        '. Refusing to serve because committed blocks would be interpreted under different rules.';
}

// movableGates defaults to the production MOVABLE_GATES list inside classifyGateMoves.
function classifyAgainst(recorded, current, tip, movableGates){
    return classifyGateMoves({
        recorded: recorded.gateHeights,
        current: comparableGateMap(recorded, current),
        tip,
        movableGates,
    });
}

function nonNegativeHeight(value, name){
    if(value === null || value === undefined || value === '')
        throw new TypeError(name + ' must be a non-negative safe integer');
    const height = Number(value);
    if(!Number.isSafeInteger(height) || height < 0)
        throw new TypeError(name + ' must be a non-negative safe integer');
    return height;
}

function capabilityMirrorTarget(chain, target, coveringCheckpoint){
    const coin = String(chain || '').toUpperCase();
    if(!MIRROR_CHAINS.has(coin)) throw new TypeError('chain must be BTC, LTC, or DOGE');

    const localTarget = nonNegativeHeight(target, 'target');
    if(coin === 'BTC') return localTarget;
    if(!coveringCheckpoint || typeof coveringCheckpoint !== 'object') return null;
    if(coveringCheckpoint.chain !== undefined &&
       String(coveringCheckpoint.chain).toUpperCase() !== coin)
        throw new RangeError('covering checkpoint must belong to ' + coin);

    const coveredThrough = nonNegativeHeight(
        coveringCheckpoint.block_index,
        'covering checkpoint block_index'
    );
    if(coveredThrough < localTarget)
        throw new RangeError('covering checkpoint must cover the replay target');
    return nonNegativeHeight(
        coveringCheckpoint.snapshot_block,
        'covering checkpoint snapshot_block'
    );
}

// Off BTC, capability snapshots are keyed by the BTC height carried by the first
// state checkpoint covering the local replay target.
async function mirrorGapAtTarget(chain, target, deps){
    if(chain === undefined || chain === null) return deps.readMirrorGap(target);

    const coin = String(chain).toUpperCase();
    let checkpoint = null;
    if(coin !== 'BTC'){
        if(typeof deps.readCoveringCheckpoint !== 'function')
            throw new TypeError('readCoveringCheckpoint is required for an off-BTC replay');
        checkpoint = await deps.readCoveringCheckpoint(coin, target);
    }

    const mirrorTarget = capabilityMirrorTarget(coin, target, checkpoint);
    if(mirrorTarget === null)
        return 'capability_snapshot_target_missing:' + coin + ':' + String(target);
    return deps.readMirrorGap(target, mirrorTarget);
}

async function recordReplayWitnessBeforeRollback(plan, tip, recorded, rulesFrom, deps){
    const canRead = typeof deps.readWitnessBlocks === 'function';
    const canRecord = typeof deps.recordWitness === 'function';
    if(!canRead && !canRecord) return null;
    if(!canRead || !canRecord)
        throw new TypeError('readWitnessBlocks and recordWitness must be provided together');
    const blocks = await deps.readWitnessBlocks(plan.target, tip);
    const witness = buildReplayWitness({
        target: plan.target,
        replayTo: tip,
        rulesFrom,
        gateHeights: recorded.gateHeights,
        blocks,
    });
    await deps.recordWitness(witness);
    return witness;
}

function hasWitnessPhases(deps){
    return ['readWitness', 'recordWitnessPhase', 'useRecordedRules', 'useCurrentRules']
        .every(name => typeof deps[name] === 'function');
}

function witnessMatches(witness, marker){
    const phase = witness && witness.phase;
    const gateHeights = witness && witness.gateHeights;
    return !!phase && !!gateHeights && typeof gateHeights === 'object' &&
        !Array.isArray(gateHeights) && gateMapDigest(gateHeights) === marker.rules_from &&
        phase.target === marker.target && phase.replay_to === marker.replay_to &&
        phase.rules_from === marker.rules_from;
}

function witnessWithPhase(witness, phase){
    return Object.assign({}, witness, {
        phase: Object.assign({}, witness.phase, { phase }),
    });
}

async function recordWitnessPhase(witness, phase, deps){
    const next = witnessWithPhase(witness, phase);
    await deps.recordWitnessPhase(next.batch, next.phase);
    return next;
}

// An open marker: roll back only while the applied tip still reaches the target, so
// a crash after the rollback commit never rolls back twice, then record the current
// map below the target and advance pending to replaying.
async function resumeOpenMarker(marker, tip, current, deps){
    deps.holdReplay();
    if(marker.state !== 'pending') return { action: 'resume', marker };

    let recordTip = tip;
    if(tip !== null && tip >= marker.target){
        await deps.rollback(marker.target);
        deps.holdReplay();
        recordTip = marker.target - 1;
    }
    if(recordTip !== null) recordTip = Math.min(recordTip, marker.target - 1);
    await deps.recordBoot(current, recordTip);
    const replaying = advanceReplayMarker(marker, 'replaying');
    await deps.recordMarker(replaying);
    return { action: 'resume', marker: replaying };
}

async function startFinalReplay(marker, witness, tip, current, deps){
    deps.useCurrentRules();
    deps.holdReplay();

    let pending = marker;
    if(marker.state !== 'pending'){
        pending = buildReplayMarker({
            target: marker.target,
            replayTo: marker.replay_to,
            rulesFrom: marker.rules_from,
            rulesTo: marker.rules_to,
        });
        await deps.recordMarker(pending);
    }

    let recordTip = tip;
    let rolledBack = false;
    if(tip !== null && tip >= marker.target){
        await deps.rollback(marker.target);
        deps.holdReplay();
        recordTip = marker.target - 1;
        rolledBack = true;
    }
    if(recordTip !== null) recordTip = Math.min(recordTip, marker.target - 1);
    await deps.recordBoot(current, recordTip);
    await recordWitnessPhase(witness, 'final', deps);
    const replaying = advanceReplayMarker(pending, 'replaying');
    await deps.recordMarker(replaying);
    return { action: rolledBack ? 'rollback' : 'resume', marker: replaying, phase: 'final' };
}

async function resumePhasedReplay(marker, witness, tip, current, deps){
    if(!witnessMatches(witness, marker))
        throw new Error('replay witness does not match the replay marker');

    const phase = witness.phase.phase;
    if(phase === 'final'){
        deps.useCurrentRules();
        if(isReplayOpen(marker)){
            const result = await resumeOpenMarker(marker, tip, current, deps);
            return Object.assign(result, { phase: 'final' });
        }
        await deps.recordBoot(current, tip);
        return { action: 'serve', marker, phase: 'final' };
    }

    if(phase === 'witnessed')
        return startFinalReplay(marker, witness, tip, current, deps);

    deps.useRecordedRules(witness.gateHeights);
    deps.holdReplay();
    if(marker.state === 'replaying') return { action: 'resume', marker, phase: 'witness' };

    if(marker.state === 'pending'){
        let recordTip = tip;
        let rolledBack = false;
        if(tip !== null && tip >= marker.target){
            await deps.rollback(marker.target);
            deps.holdReplay();
            recordTip = marker.target - 1;
            rolledBack = true;
        }
        if(recordTip !== null) recordTip = Math.min(recordTip, marker.target - 1);
        await deps.recordBoot(witness.gateHeights, recordTip);
        const replaying = advanceReplayMarker(marker, 'replaying');
        await deps.recordMarker(replaying);
        return { action: rolledBack ? 'rollback' : 'resume', marker: replaying,
            phase: 'witness' };
    }

    let recordTip = tip;
    let rolledBack = false;
    if(tip !== null && tip >= marker.target){
        await deps.rollback(marker.target);
        deps.holdReplay();
        recordTip = marker.target - 1;
        rolledBack = true;
    }
    const witnessed = await recordWitnessPhase(witness, 'witnessed', deps);
    const result = await startFinalReplay(marker, witnessed, recordTip, current, deps);
    return { action: rolledBack || result.action === 'rollback' ? 'rollback' : result.action,
        marker: result.marker, phase: result.phase };
}

// Returns { action: serve | resume | rollback, marker, phase? }. deps.refuse must throw,
// and movableGates overrides MOVABLE_GATES only in tests.
async function runBootReplay({ tip, current, capBlocks, movableGates, chain }, deps){
    const boot = await deps.readBoot();
    const marker = boot ? boot.replayMarker : null;
    const phased = hasWitnessPhases(deps);
    const latestWitness = phased ? await deps.readWitness() : null;
    if(marker && latestWitness && witnessMatches(latestWitness, marker))
        return resumePhasedReplay(marker, latestWitness, tip, current, deps);
    if(isReplayOpen(marker)) return resumeOpenMarker(marker, tip, current, deps);

    const recorded = boot ? boot.recorded : null;
    if(!recorded || tip === null){
        await deps.recordBoot(current, tip);
        return { action: 'serve', marker };
    }

    const moves = classifyAgainst(recorded, current, tip, movableGates);
    const base = { openMarker: null, refusedKeys: moves.refused.map(move => move.key),
        target: moves.target, tip, capBlocks, goMatches: false, mirrorGap: null };
    let plan = planRetroactiveBoot(base);
    if(plan.action === 'refuse' && plan.reason === 'non_movable')
        return deps.refuse(movedGateMessage(moves.movable.concat(moves.refused), tip));
    if(plan.action === 'serve'){
        await deps.recordBoot(current, tip);
        return { action: 'serve', marker };
    }

    const canonicalMap = canonical(current);
    const goMatches = plan.action === 'refuse' && plan.reason === 'needs_go'
        ? await deps.goMatches(canonicalMap, moves.target) === true : false;
    plan = planRetroactiveBoot({ ...base, goMatches });
    if(plan.action === 'refuse' && plan.reason === 'needs_go'){
        deps.holdNeedsGo();
        return deps.refuse('retroactive replay refused: needs_go for target ' + plan.target +
            ' at distance ' + plan.distance + ' over the cap of ' + capBlocks +
            ' blocks. Authorize with: ' + goCommand(plan.target, goRulesSha(canonicalMap, plan.target)));
    }

    const mirrorGap = await mirrorGapAtTarget(chain, moves.target, deps);
    plan = planRetroactiveBoot({ ...base, goMatches, mirrorGap });
    if(plan.action === 'refuse')
        return deps.refuse('retroactive replay refused: mirror_gap: ' + plan.detail);

    // The old-chain witness and pending marker are durable before the rollback. The
    // new map is recorded at target - 1 only after the rollback commits.
    const rulesFrom = gateMapDigest(recorded.gateHeights);
    const pending = buildReplayMarker({
        target: plan.target,
        replayTo: tip,
        rulesFrom,
        rulesTo: gateMapDigest(current),
    });
    let witness = latestWitness;
    if(!witness || witness.phase.phase !== 'witness' ||
       witness.phase.target !== plan.target || witness.phase.replay_to !== tip ||
       witness.phase.rules_from !== rulesFrom)
        witness = await recordReplayWitnessBeforeRollback(plan, tip, recorded, rulesFrom, deps);
    await deps.recordMarker(pending);
    if(phased && witness){
        if(!witness.gateHeights)
            witness = Object.assign({}, witness, { gateHeights: recorded.gateHeights });
        return resumePhasedReplay(pending, witness, tip, current, deps);
    }
    deps.holdReplay();
    await deps.rollback(plan.target);
    deps.holdReplay();
    await deps.recordBoot(current, plan.target - 1);
    const replaying = advanceReplayMarker(pending, 'replaying');
    await deps.recordMarker(replaying);
    return { action: 'rollback', marker: replaying };
}

module.exports = {
    GATE_RECORD_SCOPE,
    gateMapDigest,
    comparableGateMap,
    movedGateMessage,
    classifyAgainst,
    capabilityMirrorTarget,
    mirrorGapAtTarget,
    recordReplayWitnessBeforeRollback,
    runBootReplay,
};
