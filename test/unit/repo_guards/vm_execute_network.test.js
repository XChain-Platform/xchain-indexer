'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const REPO = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(REPO, 'src');
const PINNED_CALL_SITES = [
    'src/actions/deploy/constructor_run.js',
    'src/actions/execute/controller_guard.js',
    'src/actions/execute/run_vm.js',
];

function javascriptFiles(dir) {
    const files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...javascriptFiles(absolute));
        else if (entry.isFile() && entry.name.endsWith('.js')) files.push(absolute);
    }
    return files.sort();
}

function walk(node, visit) {
    if (!node || typeof node !== 'object') return;
    visit(node);
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
            for (const child of value) walk(child, visit);
        } else if (value && typeof value === 'object') {
            walk(value, visit);
        }
    }
}

function propertyName(node) {
    if (!node) return null;
    if (!node.computed && node.property && node.property.type === 'Identifier') return node.property.name;
    if (node.computed && node.property && node.property.type === 'Literal') return node.property.value;
    if (node.type === 'Property' && !node.computed && node.key.type === 'Identifier') return node.key.name;
    if (node.type === 'Property' && node.computed && node.key.type === 'Literal') return node.key.value;
    return null;
}

function isVmExecuteCall(node) {
    const receiver = node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
        ? node.callee.object : null;
    return node.type === 'CallExpression'
        && node.callee.type === 'MemberExpression'
        && propertyName(node.callee) === 'execute'
        && receiver
        && ((receiver.type === 'Identifier' && receiver.name === 'vm')
            || (receiver.type === 'MemberExpression' && propertyName(receiver) === 'vm'));
}

function parseFile(file) {
    return acorn.parse(fs.readFileSync(file, 'utf8'), {
        ecmaVersion: 'latest', sourceType: 'script', locations: true,
    });
}

function namedFunctions(ast) {
    const functions = new Map();
    walk(ast, (node) => {
        if (node.type === 'FunctionDeclaration' && node.id) functions.set(node.id.name, node);
    });
    return functions;
}

function optionsObject(call, functions, label) {
    const argument = call.arguments[0];
    if (argument && argument.type === 'ObjectExpression') return argument;

    const builderCall = argument && argument.type === 'CallExpression' ? argument.callee : null;
    const builderName = builderCall && builderCall.type === 'MemberExpression'
        && propertyName(builderCall) === 'call' && builderCall.object.type === 'Identifier'
        ? builderCall.object.name : null;
    assert.ok(builderName, `${label} must pass an options object or a named builder's .call() result`);

    const builder = functions.get(builderName);
    assert.ok(builder, `${label} uses missing options builder ${builderName}`);
    const returns = [];
    walk(builder.body, (node) => {
        if (node.type === 'ReturnStatement' && node.argument && node.argument.type === 'ObjectExpression') {
            returns.push(node.argument);
        }
    });
    assert.strictEqual(returns.length, 1, `${label} options builder ${builderName} must return one object literal`);
    return returns[0];
}

function readsConfigNetwork(node) {
    return node && node.type === 'MemberExpression'
        && propertyName(node) === 'NETWORK'
        && node.object.type === 'MemberExpression'
        && propertyName(node.object) === 'config';
}

function findCallSites() {
    const sites = [];
    for (const file of javascriptFiles(SRC)) {
        const ast = parseFile(file);
        const functions = namedFunctions(ast);
        walk(ast, (node) => {
            if (!isVmExecuteCall(node)) return;
            const relative = path.relative(REPO, file).split(path.sep).join('/');
            sites.push({
                relative,
                label: `${relative}:${node.loc.start.line}`,
                call: node,
                functions,
            });
        });
    }
    return sites;
}

describe('vm.execute network options @tier1', function () {
    const callSites = findCallSites();

    it('matches the pinned set of VM entry points', function () {
        assert.deepStrictEqual(
            callSites.map((site) => site.relative).sort(),
            [...PINNED_CALL_SITES].sort(),
            'vm.execute call sites changed; review every entry point and update this pin'
        );
    });

    it('passes config NETWORK through every VM options object', function () {
        for (const site of callSites) {
            const options = optionsObject(site.call, site.functions, site.label);
            const networkProperties = options.properties.filter((property) => propertyName(property) === 'network');
            assert.strictEqual(networkProperties.length, 1, `${site.label} must pass exactly one network option`);
            assert.ok(readsConfigNetwork(networkProperties[0].value),
                `${site.label} network must read config['NETWORK']`);
        }
    });
});
