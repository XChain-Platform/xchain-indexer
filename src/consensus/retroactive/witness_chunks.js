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
 * Pure comparisons for recorded retroactive witness chunks.
 *
 *********************************************************************/

'use strict';

const { observedWindowDigest } = require('./replay_witness.js');

const HEX_DIGEST = /^[0-9a-f]{64}$/i;

function windowRows(phase, windows) {
    return windows.map(window => {
        if(!Array.isArray(window) || window.length !== 3)
            throw new TypeError('witness window must be a three-element array');

        return {
            target: phase.target,
            replay_to: phase.replay_to,
            from: window[0],
            to: window[1],
            d: window[2],
        };
    });
}

function chunkClosingAt(windows, height) {
    return windows.find(window => Number(window.to) === height) || null;
}

function chunkMatches(window, digest) {
    if(typeof digest !== 'string' || !HEX_DIGEST.test(digest))
        throw new TypeError('digest must be a 64-character hex string');

    return digest.toLowerCase() === String(window.d).toLowerCase();
}

function windowChanged(windows, observed) {
    if(!Array.isArray(windows) || windows.length === 0)
        throw new TypeError('witness windows must not be empty');

    for(const window of windows){
        const key = String(window.to);
        if(!observed || !Object.prototype.hasOwnProperty.call(observed, key))
            throw new TypeError('observed digest is required for every witness window');
    }

    return windows.some(window => !chunkMatches(window, observed[String(window.to)]));
}

function observedWindowDigests(rows, blocks) {
    if(!Array.isArray(rows) || rows.length === 0)
        throw new TypeError('witness windows must not be empty');

    const first = rows[0].from;
    const last = rows[rows.length - 1].to;
    if(!Array.isArray(blocks) || blocks.length !== last - first + 1)
        throw new Error('replay witness blocks must cover the witness span exactly');

    const observed = {};
    for(const row of rows){
        const offset = row.from - first;
        const slice = blocks.slice(offset, offset + row.to - row.from + 1);
        observed[String(row.to)] = observedWindowDigest(slice, row.from, row.to);
    }
    return observed;
}

function planFinalCompare({ phase, replayTo, height, rows, blocks }) {
    if(phase !== 'final' || height < replayTo) return null;

    return { changed: windowChanged(rows, observedWindowDigests(rows, blocks)) };
}

function planWitnessChunk({ phase, replayTo, rows, height, digest }) {
    if(phase !== 'witness') return null;

    const chunk = chunkClosingAt(rows, height);
    if(!chunk) return null;

    if(!chunkMatches(chunk, digest)){
        return {
            writePhase: 'diverged',
            stallReason: 'retroactive_replay_diverged',
            exit: false,
            chunk,
        };
    }

    return {
        writePhase: height === replayTo ? 'witnessed' : null,
        stallReason: null,
        exit: height === replayTo,
        chunk,
    };
}

module.exports = {
    chunkClosingAt,
    chunkMatches,
    observedWindowDigests,
    planFinalCompare,
    planWitnessChunk,
    windowChanged,
    windowRows,
};
