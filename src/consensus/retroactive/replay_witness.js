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
 * Compact, deterministic evidence for the chain segment a retroactive
 * replay is about to replace.
 *
 *********************************************************************/

'use strict';

const crypto = require('crypto');
const { canonical } = require('../../consensus_rules_digest.js');

const REPLAY_WITNESS_WINDOW_SIZE = 64;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const REPLAY_WITNESS_PHASES = Object.freeze(['witness', 'witnessed', 'diverged', 'final']);

function height(value, name){
    if(!Number.isSafeInteger(value) || value < 0)
        throw new TypeError(name + ' must be a non-negative safe integer');
    return value;
}

function digest(value){
    return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizedOptionalDigest(value){
    if(value === undefined || value === null) return null;
    const normalized = String(value).toLowerCase();
    if(!DIGEST_RE.test(normalized))
        throw new Error('replay witness block fields must be 64-character hashes or null');
    return normalized;
}

function normalizedBlock(row, expectedHeight){
    const blockHeight = row && row.block_index !== undefined
        ? Number(row.block_index) : Number(row && row.height);
    const blockHash = String(row && (row.block_hash !== undefined ? row.block_hash : row.hash) || '')
        .toLowerCase();
    if(blockHeight !== expectedHeight || !DIGEST_RE.test(blockHash))
        throw new Error('replay witness blocks must be contiguous with 64-character hashes');
    return [
        blockHeight,
        blockHash,
        normalizedOptionalDigest(row.ledger_hash),
        normalizedOptionalDigest(row.actions_hash),
        normalizedOptionalDigest(row.contract_hash),
        normalizedOptionalDigest(row.state_root),
    ];
}

function replayWindowDigest(blocks){
    if(!Array.isArray(blocks) || blocks.length === 0 ||
       blocks.length > REPLAY_WITNESS_WINDOW_SIZE)
        throw new TypeError('replay witness window must contain 1 to 64 blocks');
    return digest(JSON.stringify(blocks));
}

function observedWindowDigest(rows, from, to){
    height(from, 'from');
    height(to, 'to');
    if(to < from) throw new RangeError('to must be at or above from');
    if(!Array.isArray(rows) || rows.length !== to - from + 1)
        throw new Error('replay witness blocks must be contiguous from from through to');
    return replayWindowDigest(rows.map((row, offset) => normalizedBlock(row, from + offset)));
}

function replayWitnessBatch(target, replayTo, rulesFrom, windows){
    return digest(JSON.stringify([target, replayTo, rulesFrom, windows]));
}

function nextWitnessPhase(phase, next, changed){
    if(!REPLAY_WITNESS_PHASES.includes(next))
        throw new Error('invalid replay witness phase');
    if(changed !== undefined && typeof changed !== 'boolean')
        throw new TypeError('replay witness changed must be a boolean');
    if(next === 'witness' && changed !== undefined)
        throw new Error('witness phase cannot include changed');

    const nextPhase = {
        phase: next,
        target: phase.target,
        replay_to: phase.replay_to,
        rules_from: phase.rules_from,
        window_count: phase.window_count,
        map_count: phase.map_count,
    };
    if(changed !== undefined) nextPhase.changed = changed;
    return nextPhase;
}

function decodeReplayWitnessPhase(data){
    const phase = typeof data === 'string' ? JSON.parse(data) : data;
    if(!phase || typeof phase !== 'object' || Array.isArray(phase) ||
       !REPLAY_WITNESS_PHASES.includes(phase.phase))
        throw new Error('invalid replay witness phase');
    height(phase.target, 'phase target');
    height(phase.replay_to, 'phase replay_to');
    height(phase.window_count, 'phase window_count');
    height(phase.map_count, 'phase map_count');
    if(phase.replay_to < phase.target || !DIGEST_RE.test(phase.rules_from))
        throw new Error('invalid replay witness phase');
    if(Object.prototype.hasOwnProperty.call(phase, 'changed') &&
       typeof phase.changed !== 'boolean')
        throw new Error('invalid replay witness phase changed');
    if(phase.phase === 'witness' &&
       Object.prototype.hasOwnProperty.call(phase, 'changed'))
        throw new Error('witness phase cannot include changed');
    return phase;
}

function decodeReplayWitnessWindow(data){
    const window = typeof data === 'string' ? JSON.parse(data) : data;
    if(!Array.isArray(window) || window.length !== 3 ||
       !Number.isSafeInteger(window[0]) || !Number.isSafeInteger(window[1]) ||
       window[0] < 0 || window[1] < window[0] ||
       window[1] - window[0] + 1 > REPLAY_WITNESS_WINDOW_SIZE ||
       !DIGEST_RE.test(window[2]))
        throw new Error('invalid replay witness window');
    return window;
}

function validateReplayWitnessWindows(windows, phase){
    if(!Array.isArray(windows) || windows.length !== phase.window_count)
        throw new Error('incomplete replay witness');
    let next = phase.target;
    for(const value of windows){
        const window = decodeReplayWitnessWindow(value);
        if(window[0] !== next) throw new Error('incomplete replay witness');
        next = window[1] + 1;
    }
    if(next !== phase.replay_to + 1) throw new Error('incomplete replay witness');
    return windows;
}

function buildReplayWitness({ target, replayTo, rulesFrom, gateHeights, blocks } = {}){
    height(target, 'target');
    height(replayTo, 'replayTo');
    if(replayTo < target) throw new RangeError('replayTo must be at or above target');
    if(!DIGEST_RE.test(rulesFrom))
        throw new TypeError('rulesFrom must be a 64-character lowercase hex digest');
    if(!gateHeights || typeof gateHeights !== 'object' || Array.isArray(gateHeights))
        throw new TypeError('gateHeights must be an object');
    if(!Array.isArray(blocks) || blocks.length !== replayTo - target + 1)
        throw new Error('replay witness must cover target through replayTo');

    const windows = [];
    for(let offset = 0; offset < blocks.length; offset += REPLAY_WITNESS_WINDOW_SIZE){
        const from = target + offset;
        const to = Math.min(from + REPLAY_WITNESS_WINDOW_SIZE - 1, replayTo);
        const window = blocks.slice(offset, offset + REPLAY_WITNESS_WINDOW_SIZE);
        windows.push([from, to, observedWindowDigest(window, from, to)]);
    }
    const map = Object.keys(gateHeights).sort().map(key => [key, gateHeights[key]]);
    const phase = {
        phase: 'witness',
        target,
        replay_to: replayTo,
        rules_from: rulesFrom,
        window_count: windows.length,
        map_count: map.length,
    };
    const batch = replayWitnessBatch(target, replayTo, rulesFrom, windows);
    return { batch, rulesFrom, windows, map, phase };
}

function rebuildWitnessMap(rows, rulesFrom){
    if(!DIGEST_RE.test(rulesFrom)) throw new Error('witness_map_mismatch');
    const rebuilt = {};
    try {
        for(const row of rows || []){
            const entry = typeof row === 'string' ? JSON.parse(row) :
                row && row.data !== undefined ? JSON.parse(String(row.data)) : row;
            if(!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' ||
               Object.prototype.hasOwnProperty.call(rebuilt, entry[0]))
                throw new Error('invalid witness map row');
            rebuilt[entry[0]] = entry[1];
        }
        if(digest(canonical(rebuilt)) !== rulesFrom) throw new Error('digest mismatch');
    } catch(e) {
        throw new Error('witness_map_mismatch');
    }
    return rebuilt;
}

module.exports = {
    REPLAY_WITNESS_WINDOW_SIZE,
    REPLAY_WITNESS_PHASES,
    replayWindowDigest,
    observedWindowDigest,
    replayWitnessBatch,
    nextWitnessPhase,
    decodeReplayWitnessPhase,
    decodeReplayWitnessWindow,
    validateReplayWitnessWindows,
    buildReplayWitness,
    rebuildWitnessMap,
};
