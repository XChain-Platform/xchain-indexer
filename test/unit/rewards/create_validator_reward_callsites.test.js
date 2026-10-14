/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/rewards/create_validator_reward_callsites.test.js
 *
 * Census of production createValidatorReward call sites.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const acorn  = require('acorn');
const fs     = require('fs');
const path   = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
// derive: 'stamped' writers earn before the block they write in and must pass deriveBlockIndex;
// 'none' writers earn and write in one block and must not (see the createValidatorReward doc).
const EXPECTED = {
    'actions/attest/settle.js':                   { calls: 2, bound: 0, derive: 'none' },
    'consensus/anchor_reward_derive/mint_row.js': { calls: 1, bound: 0, derive: 'stamped' },
    'consensus/rollcall_close.js':                { calls: 1, bound: 0, derive: 'stamped' },
};
const EXPECTED_COUNTS = Object.fromEntries(Object.entries(EXPECTED)
    .map(([file, e]) => [file, { calls: e.calls, bound: e.bound }]));

// True when an argument node is a literal null, the identifier undefined, or absent.
function isNullArgument(node) {
    return !node || (node.type === 'Literal' && node.value === null) ||
        (node.type === 'Identifier' && node.name === 'undefined');
}

function walk(dir, out) {
    for(const entry of fs.readdirSync(dir, { withFileTypes: true })){
        const file = path.join(dir, entry.name);
        if(entry.isDirectory()) walk(file, out);
        else if(entry.name.endsWith('.js')) out.push(file);
    }
    return out;
}

function walkSyntax(node, visit) {
    if(!node || typeof node !== 'object') return;
    visit(node);
    for(const value of Object.values(node)){
        if(Array.isArray(value)){
            for(const child of value) walkSyntax(child, visit);
        } else if(value && typeof value === 'object') {
            walkSyntax(value, visit);
        }
    }
}

function hasMemberName(node, name) {
    return node && node.type === 'MemberExpression' &&
        ((!node.computed && node.property.type === 'Identifier' && node.property.name === name) ||
         (node.computed && node.property.type === 'Literal' && node.property.value === name));
}

function findRewardCalls(source) {
    const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
    const found = [];
    walkSyntax(ast, (node) => {
        if(node.type !== 'CallExpression') return;
        if(hasMemberName(node.callee, 'createValidatorReward'))
            found.push({ kind: 'calls', node });
        else if(hasMemberName(node.callee, 'bind') &&
                hasMemberName(node.callee.object, 'createValidatorReward'))
            found.push({ kind: 'bound', node });
    });
    return found;
}

function isQualifierCall(node) {
    return !!node && node.type === 'CallExpression' &&
        (hasMemberName(node.callee, 'rewardRoundQualifier') ||
         (node.callee.type === 'Identifier' && node.callee.name === 'rewardRoundQualifier'));
}

// The body of the object-literal method `name` in `source`, or null.
function methodBody(source, name) {
    const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
    let body = null;
    walkSyntax(ast, (node) => {
        if(node.type === 'Property' && node.key && node.key.name === name) body = node.value;
    });
    return body;
}

function containsQualifierCall(node) {
    let hit = false;
    walkSyntax(node, (n) => { if(isQualifierCall(n)) hit = true; });
    return hit;
}

function isRollcallPublishWriter(call) {
    const args = call.node.arguments;
    return call.kind === 'calls' &&
        args[2] && args[2].type === 'Literal' && args[2].value === 'rollcall_publish' &&
        args[5] && args[5].type === 'Literal' && args[5].value === true &&
        args[6] && args[6].type === 'Identifier' && args[6].name === 'closeBlock';
}

describe('createValidatorReward call-site census @regression @tier1', function () {

    it('matches the known set of call sites', function () {
        const found = {};
        for(const file of walk(SRC, [])){
            const relative = path.relative(SRC, file).split(path.sep).join('/');
            if(relative === 'db/rewards/index.js') continue;
            const source = fs.readFileSync(file, 'utf8');
            const sites  = findRewardCalls(source);
            const calls  = sites.filter(site => site.kind === 'calls').length;
            const bound  = sites.filter(site => site.kind === 'bound').length;
            if(calls + bound > 0) found[relative] = { calls, bound };
        }
        assert.deepStrictEqual(found, EXPECTED_COUNTS);
    });

    it('names rollcall_publish as a derive_block_index writer', function () {
        const source = fs.readFileSync(path.join(SRC, 'consensus', 'rollcall_close.js'), 'utf8');
        const writers = findRewardCalls(source).filter(isRollcallPublishWriter);
        assert.strictEqual(writers.length, 1,
            'rollcall_publish must stamp derive_block_index with the close block');
    });

    it('keys round_qualifier through rewardRoundQualifier at both anchor-reward writers', function () {
        // The derive mint: the qualifier is createValidatorReward's 8th argument.
        const mint = fs.readFileSync(path.join(SRC, 'consensus', 'anchor_reward_derive', 'mint_row.js'), 'utf8');
        const calls = findRewardCalls(mint).filter(site => site.kind === 'calls');
        assert.strictEqual(calls.length, 1, 'mint_row.js holds exactly one createValidatorReward call');
        assert.ok(isQualifierCall(calls[0].node.arguments[7]),
            'the derive mint must pass rewardRoundQualifier(...) as round_qualifier');
        // Recovery's staged-reward writer builds its INSERT by hand, so look inside the method.
        const rewards = fs.readFileSync(path.join(SRC, 'db', 'rewards', 'index.js'), 'utf8');
        const body = methodBody(rewards, 'applyPendingRewardsForAddress');
        assert.ok(body, 'applyPendingRewardsForAddress must exist in db/rewards/index.js');
        assert.ok(containsQualifierCall(body),
            'recovery materialization must key round_qualifier through rewardRoundQualifier');
    });

    it('ignores call-like comments and strings', function () {
        const source = `
            // db.createValidatorReward(key, epoch, 'rollcall_publish', amount,
            //     epoch, true, closeBlock, 0);
            const text = "db.createValidatorReward(key, epoch, 'rollcall_publish', amount, epoch, true, closeBlock, 0)";
        `;
        assert.deepStrictEqual(findRewardCalls(source), []);
    });
});

// Assert one direct call site passes, or omits, deriveBlockIndex as its EXPECTED entry declares.
function assertDeriveClassification(relative, source, call, derive) {
    const where = relative + ':' + source.slice(0, call.node.start).split('\n').length;
    if(derive === 'stamped')
        assert.ok(!isNullArgument(call.node.arguments[6]), where + ' earns before the block it writes in, so it must ' +
            'pass deriveBlockIndex; classify writers by the rule in the createValidatorReward doc');
    else
        assert.ok(isNullArgument(call.node.arguments[6]), where + ' is declared same-block but passes deriveBlockIndex; ' +
            'reclassify it in EXPECTED by the rule in the createValidatorReward doc');
}

describe('createValidatorReward call-site census @regression @tier1', function () {

    it('holds every direct call site to its declared derive_block_index classification', function () {
        for(const [relative, expected] of Object.entries(EXPECTED)){
            const source = fs.readFileSync(path.join(SRC, ...relative.split('/')), 'utf8');
            for(const call of findRewardCalls(source).filter(site => site.kind === 'calls'))
                assertDeriveClassification(relative, source, call, expected.derive);
        }
    });
});
