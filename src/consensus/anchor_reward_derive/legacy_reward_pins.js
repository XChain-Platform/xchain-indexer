/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_PINS_PATH = path.join(__dirname, 'legacy_reward_pins.json');

function tupleKey(tuple){
    if(tuple === null || typeof tuple !== 'object'){ return null; }
    let parts = [tuple.reward_type, tuple.round_reference, tuple.snapshot_block, tuple.publisher, tuple.txid];
    if(parts.some((p) => p === undefined || p === null || p === '')){ return null; }
    // JSON encoding quotes and escapes each field, so no field value can shift a boundary.
    return JSON.stringify(parts.map((p) => String(p)));
}

// Reads the default pin file. A missing file means no pins.
function loadDefaultPins(filePath = DEFAULT_PINS_PATH){
    let raw;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch(error) {
        if(error && error.code === 'ENOENT'){ return []; }
        throw error;
    }
    return JSON.parse(raw);
}

function loadLegacyRewardPins(pins){
    let list = pins === undefined ? loadDefaultPins() : pins;
    if(!Array.isArray(list)){
        throw new TypeError('legacy reward pins must be an array');
    }
    let keys = new Set();
    for(let pin of list){
        let key = tupleKey(pin);
        if(key === null){
            throw new TypeError('legacy reward pin is missing a tuple field');
        }
        keys.add(key);
    }
    return {
        size: keys.size,
        isPinned(tuple){
            let key = tupleKey(tuple);
            return key !== null && keys.has(key);
        }
    };
}

function isLegacyRewardPinned(tuple, pins){
    return loadLegacyRewardPins(pins).isPinned(tuple);
}

module.exports = {loadDefaultPins, loadLegacyRewardPins, isLegacyRewardPinned, tupleKey };
