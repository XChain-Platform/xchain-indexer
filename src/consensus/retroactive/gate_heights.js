/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * Pure registry projection and retroactive gate-move classification.
 *
 *********************************************************************/

'use strict';

const {
    ABSENT,
    FAR_FUTURE_HEIGHT_SENTINEL,
    canonical,
} = require('../../consensus_rules_digest.js');
const { MOVABLE_GATES } = require('./movable_gates.js');

const RECORDED_UNITS = Object.freeze(['height', 'time']);

function resolvedThreshold(table, network, coin){
    if(table === null || typeof table !== 'object' || Array.isArray(table)) return ABSENT;
    const coinKey = String(coin) + ':' + network;
    if(coin !== null && coin !== undefined && Object.prototype.hasOwnProperty.call(table, coinKey))
        return table[coinKey];
    return Object.prototype.hasOwnProperty.call(table, network) ? table[network] : ABSENT;
}

function gateHeightMap(gateRegistry, network, coin){
    const registry = gateRegistry && gateRegistry.registry ? gateRegistry.registry : gateRegistry;
    if(!registry || typeof registry.keys !== 'function' || typeof registry.unitOf !== 'function' ||
       typeof registry.get !== 'function')
        throw new TypeError('gateRegistry must expose keys, unitOf and get');

    const out = {};
    for(const key of registry.keys()){
        if(!RECORDED_UNITS.includes(registry.unitOf(key))) continue;
        out[key] = resolvedThreshold(registry.get(key), network, coin);
    }
    return out;
}

function activeBoundary(value){
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 &&
        value < FAR_FUTURE_HEIGHT_SENTINEL ? value : null;
}

function classifyGateMoves({ recorded, current, tip, movableGates = MOVABLE_GATES } = {}){
    if(!Number.isSafeInteger(tip) || tip < 0)
        throw new TypeError('tip must be a non-negative safe integer');
    if(!recorded || typeof recorded !== 'object' || Array.isArray(recorded) ||
       !current || typeof current !== 'object' || Array.isArray(current))
        throw new TypeError('recorded and current must be gate maps');

    const movableSet = new Set(movableGates);
    const result = { target: null, movable: [], refused: [] };
    const keys = new Set([...Object.keys(recorded), ...Object.keys(current)]);

    for(const key of [...keys].sort()){
        const from = Object.prototype.hasOwnProperty.call(recorded, key) ? recorded[key] : ABSENT;
        const to = Object.prototype.hasOwnProperty.call(current, key) ? current[key] : ABSENT;
        if(canonical(from) === canonical(to)) continue;

        const boundaries = [activeBoundary(from), activeBoundary(to)].filter(value => value !== null);
        if(boundaries.length === 0) continue;
        const target = Math.min(...boundaries);
        if(target > tip) continue;

        const move = { key, from, to, target };
        const bucket = movableSet.has(key) ? result.movable : result.refused;
        bucket.push(move);
        result.target = result.target === null ? target : Math.min(result.target, target);
    }

    return result;
}

module.exports = {
    RECORDED_UNITS,
    gateHeightMap,
    classifyGateMoves,
};
