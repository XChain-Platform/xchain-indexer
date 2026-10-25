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
 * Read overlay for gate thresholds recorded by a replay witness.
 *
 *********************************************************************/

'use strict';

const { ABSENT } = require('../../consensus_rules_digest.js');

function witnessThresholdTable(table, network, coin, value){
    const out = Object.assign({}, table);
    const coinKey = String(coin) + ':' + network;

    if(value === ABSENT){
        if(coin !== null && coin !== undefined) delete out[coinKey];
        delete out[network];
        return out;
    }

    if(coin !== null && coin !== undefined &&
       Object.prototype.hasOwnProperty.call(out, coinKey))
        out[coinKey] = value;
    else
        out[network] = value;

    return out;
}

function witnessReadOverlay(prior, values, network, coin){
    return function readWitnessValue(key, value){
        const table = typeof prior === 'function' ? prior(key, value) : value;
        if(!values || !Object.prototype.hasOwnProperty.call(values, key)) return table;
        return witnessThresholdTable(table, network, coin, values[key]);
    };
}

module.exports = {
    witnessThresholdTable,
    witnessReadOverlay,
};
