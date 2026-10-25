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
 * Canonical binding shared by retroactive-go requests and authorization.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');

const RETRO_GO_CODE = 'CONSENSUS_RETRO_GO';
const RULES_SHA = /^[0-9a-f]{64}$/;
const TARGET = /^[0-9]+$/;

function goRulesSha(canonicalMap, target){
    return crypto.createHash('sha256')
        .update(canonicalMap + '\n' + String(target))
        .digest('hex');
}

function goCommand(target, rulesSha){
    return 'node bin/retroactive-go.js --target ' + target + ' --rules ' + rulesSha;
}

function parseGoArgs(argv){
    if(!Array.isArray(argv) || argv.length !== 4)
        throw new Error('expected exactly --target and --rules');

    const parsed = {};
    for(let i = 0; i < argv.length; i += 2){
        const flag = argv[i];
        const value = argv[i + 1];
        if(flag !== '--target' && flag !== '--rules')
            throw new Error('unknown go flag: ' + flag);
        if(Object.prototype.hasOwnProperty.call(parsed, flag))
            throw new Error('repeated go flag: ' + flag);
        parsed[flag] = value;
    }

    if(!TARGET.test(parsed['--target']))
        throw new Error('target must be a non-negative integer');
    const target = Number(parsed['--target']);
    if(!Number.isSafeInteger(target))
        throw new Error('target must be a safe integer');
    if(!RULES_SHA.test(parsed['--rules']))
        throw new Error('rules must be a lowercase sha256 digest');

    return { target, rules: parsed['--rules'] };
}

function goAuthorizes(goRow, { canonicalMap, target }){
    return Boolean(goRow) && goRow.target === target &&
        goRow.rules === goRulesSha(canonicalMap, target);
}

module.exports = { RETRO_GO_CODE, goRulesSha, goCommand, parseGoArgs, goAuthorizes };
