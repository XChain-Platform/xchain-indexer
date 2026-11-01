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
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../../../');
const DOCKERFILE = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
const TOOLS = [
    'bench-escrow-arming-replay.js',
    'shadow-dryrun-escrow-leaf.js',
    'verify-escrow-arming-boundary.js',
];

function copyLine(name){
    return `COPY ./bin/${name} /XChainIndexer/bin/${name}`;
}

function shipsTool(dockerfile, name){
    return dockerfile.split('\n').includes(copyLine(name));
}

// Resolve the require() targets of a script: literal relative requires plus
// the path.join(SRC, ...) form used by the boundary verifier.
function localRequires(file){
    const text = fs.readFileSync(path.join(ROOT, 'bin', file), 'utf8');
    const out = [];
    for (const m of text.matchAll(/require\('(\.[^']+)'\)/g)) {
        out.push(path.resolve(ROOT, 'bin', m[1]));
    }
    for (const m of text.matchAll(/require\(path\.join\(SRC,\s*([^)]*)\)\)/g)) {
        const parts = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
        out.push(path.join(ROOT, 'src', ...parts));
    }
    return out;
}

function resolvable(target){
    return [target, target + '.js', path.join(target, 'index.js')].some((p) => {
        try { return fs.statSync(p).isFile(); } catch (e) { return false; }
    });
}

describe('escrow arming tools ship in the image @regression @tier1', function () {
    for (const tool of TOOLS) {
        it(`copies ${tool} into /XChainIndexer/bin`, function () {
            assert.ok(shipsTool(DOCKERFILE, tool));
        });
    }

    it('fails when the bench-escrow-arming-replay COPY is omitted', function () {
        const without = DOCKERFILE.replace(copyLine(TOOLS[0]) + '\n', '');
        assert.notStrictEqual(without, DOCKERFILE);
        assert.strictEqual(shipsTool(without, TOOLS[0]), false);
    });

    for (const tool of TOOLS) {
        it(`${tool} requires only files the image carries`, function () {
            const targets = localRequires(tool);
            assert.ok(targets.length > 0);
            for (const target of targets) {
                const rel = path.relative(ROOT, target);
                assert.ok(rel.startsWith('src' + path.sep), `${tool} requires outside src/: ${rel}`);
                assert.ok(resolvable(target), `${tool} requires missing file: ${rel}`);
            }
        });
    }
});
