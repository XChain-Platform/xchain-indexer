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
 * One sibling service module as a single source text, for the cross-repo
 * source guards.
 *
 * A service splits a long module without moving its require path: the entry
 * stays at `<name>.js` and its body moves into part files under a directory
 * spelled exactly as the entry, or a directory module keeps `<dir>/index.js`
 * and puts its parts beside it. Nothing about the sibling's require surface
 * changes, so a guard that reads the entry alone still finds the file and
 * stops finding the line, which reads as a pin the sibling dropped rather
 * than as a split. On a negative pin it is worse: the text the guard must not
 * find now sits in a file the guard never opens, and it passes vacuously.
 *
 * This reads the entry followed by every part, so a pin holds wherever in the
 * module its line lives. On a tree where the module was never split the
 * directory does not exist and the read is the entry alone, unchanged.
 *
 * It does NOT judge whether the sibling may be trusted; that is
 * helpers/sibling_checkout.js, and callers ask it first.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const { listSrcTreeFiles } = require('./src_tree_files.js');

/** The entry, then every `.js` file under its part directory, at any depth, sorted. */
function modulePaths(entry) {
    const dir = path.basename(entry) === 'index.js'
        ? path.dirname(entry)
        : entry.replace(/\.js$/, '');
    if (dir === entry) return [entry];
    // Exact spelling, checked by listing the parent, because a case-insensitive
    // filesystem would otherwise let `Governance.js` claim a `governance/` directory.
    const parent = path.dirname(dir);
    const named = fs.existsSync(parent) && fs.readdirSync(parent, { withFileTypes: true })
        .some(e => e.isDirectory() && e.name === path.basename(dir));
    if (!named) return [entry];
    return [entry].concat(listSrcTreeFiles(dir).map(rel => path.join(dir, rel)))
        .filter((p, i) => i === 0 || p !== entry);
}

/** The module's text, entry then parts, newline-joined. Throws as readFileSync does. */
function readSiblingModuleSource(entry) {
    return modulePaths(entry).map(p => fs.readFileSync(p, 'utf8')).join('\n');
}

module.exports = { modulePaths, readSiblingModuleSource };
