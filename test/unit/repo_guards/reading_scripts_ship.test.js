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

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { builtinModules } = require('node:module');

const ROOT = path.join(__dirname, '../../..');
const READING_SCRIPTS = [
    'bin/archive_heads_by_author.js',
    'bin/bench_net_balance.js',
    'bin/measure_vm_snapshot_bytes.js',
];

function copySources(dockerfile){
    return [...dockerfile.matchAll(/^COPY\s+\.\/(\S+)/gm)].map((match) => match[1]);
}

function isShipped(file, copies){
    return copies.some((source) =>
        file === source || file.startsWith(source.replace(/\/$/, '') + '/'));
}

function requiresIn(file){
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    return [...source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)]
        .map((match) => match[1]);
}

function resolvedRelative(from, request){
    return path.relative(ROOT, require.resolve(path.resolve(ROOT, path.dirname(from), request)))
        .split(path.sep).join('/');
}

function coverageIssues(dockerfile){
    const copies = copySources(dockerfile);
    const issues = [];
    for(const script of READING_SCRIPTS){
        if(!isShipped(script, copies)) issues.push(script + ' is not covered by a Dockerfile COPY source');
        for(const request of requiresIn(script).filter((name) => name.startsWith('.'))){
            const resolved = resolvedRelative(script, request);
            if(resolved.startsWith('../') || !isShipped(resolved, copies))
                issues.push(script + ' requires unshipped ' + request + ' at ' + resolved);
        }
    }
    return issues;
}

describe('operator reading scripts ship with their runtime dependencies @regression @tier1', function () {
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');

    it('covers each script and every relative require with a Dockerfile COPY source', function () {
        assert.deepStrictEqual(coverageIssues(dockerfile), []);
    });

    it('limits bare requires to Node builtins and declared production dependencies', function () {
        const dependencies = require(path.join(ROOT, 'package.json')).dependencies;
        const builtins = new Set(builtinModules.concat(builtinModules.map((name) => 'node:' + name)));
        for(const script of READING_SCRIPTS){
            for(const request of requiresIn(script).filter((name) => !name.startsWith('.'))){
                const packageName = request.startsWith('@')
                    ? request.split('/').slice(0, 2).join('/')
                    : request.split('/')[0];
                assert.ok(builtins.has(request) || Object.hasOwn(dependencies, packageName),
                    script + ' requires undeclared package ' + request);
            }
        }
    });

    it('reports a reading script when its COPY line is removed', function () {
        const omitted = 'bin/bench_net_balance.js';
        const withoutOne = dockerfile.replace(
            'COPY ./' + omitted + ' /XChainIndexer/' + omitted + '\n',
            ''
        );
        assert.notStrictEqual(withoutOne, dockerfile, 'the falsification must remove a real COPY line');
        assert.ok(coverageIssues(withoutOne).some((issue) => issue.includes(omitted)),
            'coverage did not report the omitted script');
    });
});
