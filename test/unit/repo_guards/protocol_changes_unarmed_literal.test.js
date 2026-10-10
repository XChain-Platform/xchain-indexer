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

// Keep the unarmed-gate sentinel spelled as UNARMED in the time-table parts, so a
// search by that name finds every unarmed row (core.js: never write the bare literal).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PARTS_DIR = path.resolve(__dirname, '..', '..', '..', 'src', 'protocol_changes');
const BARE_SENTINEL = /\b9999999999\b/;

// Drop block and line comments so a comment may still quote the number.
function stripComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('protocol_changes time-table parts spell the unarmed sentinel by name @regression @tier1', function () {
    const parts = fs.readdirSync(PARTS_DIR).filter((file) => /^changes_\d+\.js$/.test(file)).sort();

    it('finds the time-table part files to scan', function () {
        assert.ok(parts.length >= 5, 'expected changes_1.js through changes_5.js, found ' + parts.join(', '));
    });

    it('writes no bare 9999999999 in any changes_N.js row', function () {
        const offenders = parts.filter((file) =>
            BARE_SENTINEL.test(stripComments(fs.readFileSync(path.join(PARTS_DIR, file), 'utf8'))));
        assert.deepStrictEqual(offenders, [],
            'use UNARMED from src/protocol_changes/core.js instead of the bare literal in: ' + offenders.join(', '));
    });
});

// Rows the arming and release tools still read by their literal text; each leaves this list when it is spelled UNARMED.
const LITERAL_ROWS = {
    'gates_3.js': ['tick_namespace_activation.TICK_NAMESPACE_ACTIVATION'],
    'shared_rows_4.js': ['token_bridge_activation.TOKEN_BRIDGE_ACTIVATION'],
    'shared_rows_5.js': ['token_policy_activation.TOKEN_POLICY_INHERITANCE_ACTIVATION', 'train_activation.TRAIN_ACTIVATION'],
};
const DEFINITION = 'const UNARMED = 9999999999;';
// Eight or more nines also catches a sentinel with a digit dropped, which would arm at a reachable height.
const NINES_RUN = /9{8,}/;

// Blank out one addGate block, keeping its line count so offender line numbers stay true.
function blankGate(source, key) {
    const start = source.indexOf("addGate('" + key + "'");
    assert.notStrictEqual(start, -1, 'missing literal-text row ' + key);
    const end = source.indexOf('\n});', start);
    assert.notStrictEqual(end, -1, 'unterminated literal-text row ' + key);
    return source.slice(0, start) + source.slice(start, end + 4).replace(/[^\n]/g, ' ') + source.slice(end + 4);
}

describe('protocol_changes gate and registry parts spell the unarmed sentinel by name @regression @tier1', function () {
    it('writes no run of eight or more nines outside the rows the tools read by literal text', function () {
        const offenders = [];
        for (const file of fs.readdirSync(PARTS_DIR).filter((name) => name.endsWith('.js')).sort()) {
            let code = fs.readFileSync(path.join(PARTS_DIR, file), 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
                .replace(/\/\/[^\n]*/g, '');
            for (const key of LITERAL_ROWS[file] || []) code = blankGate(code, key);
            code.split('\n').forEach((line, index) => {
                if (NINES_RUN.test(line) && !(file === 'core.js' && line.trim() === DEFINITION)) {
                    offenders.push(file + ':' + (index + 1) + ' ' + line.trim());
                }
            });
        }
        assert.deepStrictEqual(offenders, [],
            'use UNARMED from src/protocol_changes/core.js instead of a run of nines in: ' + offenders.join(', '));
    });
});
