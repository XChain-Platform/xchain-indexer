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

const HEX_DIGEST = /^[0-9a-f]{64}$/i;

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

module.exports = { chunkClosingAt, chunkMatches, windowChanged };
