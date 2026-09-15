// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');

const SITES = [
    path.join('actions', 'index.js'),
    path.join('actions', 'deploy', 'index.js'),
    path.join('actions', 'deploy', 'deploy_chunk.js'),
    path.join('actions', 'execute', 'index.js')
];
const GAS_KEY = /VM_DEPLOY_BASE|VM_DEPLOY_PER_BYTE|VM_EXECUTE_BASE/;
function stripComments(src){
    return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

describe('static fee quote <-> handler acceptance fee parity @regression @tier1', function () {

    describe('no site recomputes the VM gas arithmetic', function () {
        // Every .js under src/, relative to it. The SITES list above is the set of files that
        // charge the fee TODAY; it cannot see a fifth handler added tomorrow, and a list that
        // silently covers less than the tree is the same green-by-omission this suite exists
        // to prevent. So the whole tree is scanned and the list stays as an anchor: each entry
        // must still resolve, so a move is reported rather than quietly narrowing the scan.
        function walkJs(dir) {
            const out = [];
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const abs = path.join(dir, entry.name);
                if (entry.isDirectory()) out.push(...walkJs(abs));
                else if (entry.name.endsWith('.js')) out.push(path.relative(SRC, abs));
            }
            return out;
        }

        // A coin schedule DECLARES the values (`VM_EXECUTE_BASE: 1000,`); it does no arithmetic
        // with them. Only the declaration LINE is exempt, never the file, so a coin that started
        // pricing gas itself is still caught.
        const DECLARATION = /^\s*(?:VM_DEPLOY_BASE|VM_DEPLOY_PER_BYTE|VM_EXECUTE_BASE)\s*:\s*[\d_]+\s*,?\s*$/;

        it('no other file under src/ prices VM gas either', function () {
            const files = walkJs(SRC);
            // The canonical is part of this comparison, not an assumption about it: if
            // utility.js stopped resolving the scan below would exempt a file that is not there.
            assert.ok(files.includes('utility.js'),
                'utility.js, the one arithmetic, no longer resolves under src/; repoint this guard');
            for (const site of SITES)
                assert.ok(files.includes(site),
                    site + ' no longer resolves under src/. Repoint SITES at where the fee is '
                    + 'charged now, so the named-site checks above keep covering it.');
            assert.ok(files.length > SITES.length + 1,
                'the walk found only the files already named; it is no longer scanning the tree');

            const offenders = [];
            for (const rel of files) {
                if (rel === 'utility.js') continue;
                const code = stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));
                const hits = code.split('\n').filter((l) => GAS_KEY.test(l) && !DECLARATION.test(l));
                if (hits.length) offenders.push(rel + ':\n  ' + hits.join('\n  '));
            }
            assert.deepStrictEqual(offenders, [],
                'these files price VM gas outside util.vmGasCost:\n' + offenders.join('\n')
                + '\n  Route it through this.util.vmGasCost so the static quote moves with it.');
        });

        it('utility.js is the single site that does', function () {
            const code = stripComments(fs.readFileSync(path.join(SRC, 'utility.js'), 'utf8'));
            assert.ok(GAS_KEY.test(code), 'util.vmGasCost is where the arithmetic lives; it went missing');
        });
    });
});
