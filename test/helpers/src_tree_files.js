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
 * Recursive source-tree scan for the flat-scan guard suites.
 *
 * Several suites treat a class-per-file directory (src/db/) as one logical
 * source by concatenating every file under it in a fixed order. A plain
 * `fs.readdirSync(dir)` only lists the directory's direct entries, so once a
 * split lane moves a method's body into a part subdirectory beside its entry
 * file (src/db/<module>/<part>.js), that call either throws EISDIR trying to
 * readFileSync the subdirectory itself, or - if it filtered directories out
 * instead - would silently stop scanning the part files the split just
 * created, defeating the guard it feeds without ever failing red. This walks
 * every subdirectory too, so a split is read in full either way.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Every .js file under dir, recursively, as paths relative to dir, sorted
// deterministically so callers that concatenate or hash the result are stable.
function listSrcTreeFiles(dir) {
    const out = [];
    (function walk(current, relPrefix) {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const rel = relPrefix ? relPrefix + '/' + entry.name : entry.name;
            if (entry.isDirectory()) {
                walk(path.join(current, entry.name), rel);
            } else if (entry.name.endsWith('.js')) {
                out.push(rel);
            }
        }
    })(dir, '');
    return out.sort();
}

// Same shape as the suites' original `readdirSync(dir).sort().map(f =>
// readFileSync(...)).join('\n')`, but recurses into any part subdirectory a
// split lane adds instead of crashing (EISDIR) or missing files silently.
function concatSrcTreeFiles(dir) {
    return listSrcTreeFiles(dir)
        .map(rel => fs.readFileSync(path.join(dir, rel), 'utf8'))
        .join('\n');
}

module.exports = { listSrcTreeFiles, concatSrcTreeFiles };
