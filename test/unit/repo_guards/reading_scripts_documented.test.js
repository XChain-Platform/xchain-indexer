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

const ROOT = path.join(__dirname, '../../..');
const README_PATH = path.join(ROOT, 'README.md');
const SCRIPT_PATH = path.join(ROOT, 'bin/archive_heads_by_author.js');
const README_ROW_START = '| `node bin/archive_heads_by_author.js';

function flagsIn(text){
    return [...new Set([...text.matchAll(/--[a-z][a-z-]*/g)].map((match) => match[0]))]
        .sort();
}

function usageFlags(source){
    const header = source.match(/^\s*\* Usage:[\s\S]*?^\s*\*+\//m);
    return header ? flagsIn(header[0]) : [];
}

function parseArgsFlags(source){
    return [...new Set([...source.matchAll(/\barg\s*===\s*['"](--[a-z][a-z-]*)['"]/g)]
        .map((match) => match[1]))].sort();
}

function readmeRows(readme){
    return readme.split(/\r?\n/).filter((line) => line.startsWith(README_ROW_START));
}

function missingFlags(expected, line){
    const documented = new Set(flagsIn(line));
    return expected.filter((flag) => !documented.has(flag));
}

describe('archive heads reading script documentation @regression @tier1', function () {
    const readme = fs.readFileSync(README_PATH, 'utf8');
    const source = fs.readFileSync(SCRIPT_PATH, 'utf8');
    const usage = usageFlags(source);

    it('keeps the Usage flags and parseArgs comparisons identical', function () {
        assert.deepStrictEqual(usage, parseArgsFlags(source));
    });

    it('has exactly one README row naming every Usage flag', function () {
        const rows = readmeRows(readme);
        assert.strictEqual(rows.length, 1);
        assert.deepStrictEqual(missingFlags(usage, rows[0]), []);
    });

    it('reports expect-conflict when that flag is removed from the README row', function () {
        const row = readmeRows(readme)[0];
        const withoutConflict = row.replaceAll('--expect-conflict', '');
        assert.notStrictEqual(withoutConflict, row);
        assert.deepStrictEqual(missingFlags(usage, withoutConflict), ['--expect-conflict']);
    });
});

module.exports = { flagsIn, usageFlags, parseArgsFlags, readmeRows, missingFlags };
