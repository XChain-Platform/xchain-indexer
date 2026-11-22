// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const REQUIRED = new Map([
    ['bcadd', 3], ['bcsub', 3], ['bcmul', 3], ['bcdiv', 3],
    ['bcmulfloor', 3], ['bcmuldivfloor', 4], ['bcround', 2],
    ['bcsqrt', 2], ['bcformat', 2],
]);

function javascriptFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...javascriptFiles(full));
        else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

function parse(source, file) {
    const opts = { ecmaVersion: 'latest', allowHashBang: true, allowReturnOutsideFunction: true, locations: true };
    try { return acorn.parse(source, { ...opts, sourceType: 'script' }); }
    catch (scriptError) {
        try { return acorn.parse(source, { ...opts, sourceType: 'module' }); }
        catch (moduleError) {
            throw new SyntaxError(file + ': ' + moduleError.message + ' (script parse: ' + scriptError.message + ')');
        }
    }
}

function visit(node, inspect) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.type === 'string') inspect(node);
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach((child) => visit(child, inspect));
        else if (value && typeof value === 'object' && typeof value.type === 'string') visit(value, inspect);
    }
}

function calleeName(node) {
    if (node.type === 'Identifier') return node.name;
    if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier')
        return node.property.name;
    return null;
}

describe('@regression @tier1 explicit bcmath precision', function () {
    this.timeout(10000);

    it('requires every precision helper call under src to state its scale', function () {
        const root = path.resolve(__dirname, '../../..');
        const offenders = [];
        for (const file of javascriptFiles(path.join(root, 'src'))) {
            const source = fs.readFileSync(file, 'utf8');
            visit(parse(source, file), (node) => {
                if (node.type !== 'CallExpression') return;
                const name = calleeName(node.callee);
                const required = REQUIRED.get(name);
                if (!required) return;
                if (node.arguments.length >= required && !node.arguments.some((arg) => arg.type === 'SpreadElement')) return;
                offenders.push(path.relative(root, file) + ':' + node.loc.start.line + ':' + node.loc.start.column +
                    ' ' + name + '(' + node.arguments.length + ' args)');
            });
        }
        assert.deepStrictEqual(offenders, [], offenders.join('\n') +
            '\nPass precision explicitly: token decimals for amounts, or 0 for integer values. Omission rounds to 0 decimals.');
    });
});
