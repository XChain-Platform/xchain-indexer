/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * The Rollback module as one source text, for the source-guard suites.
 *
 * The class lives in src/rollback/index.js plus the method groups beside it
 * that the entry installs onto its prototype, and the statements those
 * methods run live under src/db/rollback/. A guard that reads one file stops
 * seeing a pinned statement the moment a split moves it, and a negative pin
 * ("exactly once", "never X") then passes vacuously. This reads the entry,
 * then every part, then every statement file, so a pin holds wherever in the
 * module its text lives.
 *
 * Order is load-bearing for the guards that scan in sequence (the commit
 * before the cache clears, the roll-call absences before the verdicts), so
 * parts follow in the order the entry requires them, which is the order the
 * entry installs them, and a part the entry does not require is appended after
 * them, sorted, rather than dropped. The statement files follow, sorted. A
 * directory that does not exist yet reads as empty, so the same helper serves
 * a tree where the entry has moved but not yet split.
 *
 * xchain-sync's rollback_coverage suite reads the same three places, in the
 * same groups, to compare the source's statements against the replica's.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const SRC_DIR   = path.join(__dirname, '..', '..', 'src');
const ENTRY     = path.join(SRC_DIR, 'rollback', 'index.js');
const PARTS_DIR = path.join(SRC_DIR, 'rollback');
const SQL_DIR   = path.join(SRC_DIR, 'db', 'rollback');

// The .js files directly inside a directory, sorted; none when it is absent.
function jsFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort();
}

// Part basenames in the order the entry's require calls name them.
function requiredPartOrder(entrySource) {
    const order = [];
    const re = /require\('\.\/([a-z0-9_]+\.js)'\)/g;
    let m;
    while ((m = re.exec(entrySource)) !== null) {
        if (!order.includes(m[1])) order.push(m[1]);
    }
    return order;
}

// The entry, each part in require order, any unrequired part sorted, then the
// statement files sorted, as absolute paths.
function rollbackSourcePaths() {
    const entry = fs.readFileSync(ENTRY, 'utf8');
    const onDisk = jsFiles(PARTS_DIR).filter(f => f !== 'index.js');
    const required = requiredPartOrder(entry).filter(f => onDisk.includes(f));
    const rest = onDisk.filter(f => !required.includes(f));
    return [ENTRY]
        .concat(required.concat(rest).map(f => path.join(PARTS_DIR, f)))
        .concat(jsFiles(SQL_DIR).map(f => path.join(SQL_DIR, f)));
}

// The module's text, newline-joined in that order.
function readRollbackSource() {
    return rollbackSourcePaths().map(p => fs.readFileSync(p, 'utf8')).join('\n');
}

module.exports = { rollbackSourcePaths, readRollbackSource, requiredPartOrder };
