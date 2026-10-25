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
 * Durable event-row helpers for retroactive-go authorization.
 *
 ********************************************************************/

'use strict';

const { RETRO_GO_CODE, goAuthorizes } = require('../../consensus/retroactive/go_binding.js');

const RULES_SHA = /^[0-9a-f]{64}$/;

function isGoRow(value){
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
        Number.isSafeInteger(value.target) && value.target >= 0 &&
        typeof value.rules === 'string' && RULES_SHA.test(value.rules);
}

async function recordRetroactiveGo(db, { target, rules }){
    const goRow = { target, rules };
    if(!isGoRow(goRow))
        throw new TypeError('retroactive go requires a non-negative safe target and 64 lowercase hex rules');

    await db.doQueryStrict(
        `INSERT INTO events (time, code, data) VALUES (NOW(), ?, ?)`,
        [RETRO_GO_CODE, JSON.stringify(goRow)]);
}

async function readRetroactiveGoRows(db){
    const rows = await db.doQueryStrict(
        `SELECT data FROM events WHERE code = 'CONSENSUS_RETRO_GO' ORDER BY id DESC LIMIT 100`);
    const goRows = [];
    for(const row of rows){
        try {
            const parsed = JSON.parse(row.data);
            if(isGoRow(parsed))
                goRows.push({ target: parsed.target, rules: parsed.rules });
        } catch(_){
            continue;
        }
    }
    return goRows;
}

function findMatchingGo(goRows, request){
    for(const goRow of goRows){
        if(goAuthorizes(goRow, request))
            return goRow;
    }
    return null;
}

module.exports = { recordRetroactiveGo, readRetroactiveGoRows, findMatchingGo };
