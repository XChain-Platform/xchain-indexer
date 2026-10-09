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
