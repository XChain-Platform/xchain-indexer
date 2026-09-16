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
 * The XChainIndexer class as one source text, for the source-guard suites.
 *
 * The class lives in src/XChainIndexer.js plus the method groups under
 * src/XChainIndexer/ that the entry installs onto its prototype. A guard that
 * reads the entry file alone stops seeing a pinned line the moment a split
 * moves it into a part, and a negative pin ("never X") then passes vacuously.
 * This reads the entry followed by every part, so a pin holds wherever in the
 * class its line lives.
 *
 * Order is load-bearing: several guards scan in sequence (the stall-reason to
 * grace wiring, the price barrier slice that ends at the oracle barrier), so
 * parts follow in the order the entry requires them, which is block-loop
 * order. A part the entry does not require is appended after them, sorted,
 * rather than dropped, so a new file is never silently outside the scan.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const SRC_DIR   = path.join(__dirname, '..', '..', 'src');
const ENTRY     = path.join(SRC_DIR, 'XChainIndexer.js');
const PARTS_DIR = path.join(SRC_DIR, 'XChainIndexer');

// Part basenames in the order the entry's require calls name them.
function requiredPartOrder(entrySource) {
    const order = [];
    const re = /require\('\.\/XChainIndexer\/([a-z0-9_]+\.js)'\)/g;
    let m;
    while ((m = re.exec(entrySource)) !== null) {
        if (!order.includes(m[1])) order.push(m[1]);
    }
    return order;
}

// The entry, then each part in require order, then any unrequired part, sorted.
function readIndexerClassSource() {
    const entry = fs.readFileSync(ENTRY, 'utf8');
    const onDisk = fs.readdirSync(PARTS_DIR).filter(f => f.endsWith('.js')).sort();
    const required = requiredPartOrder(entry).filter(f => onDisk.includes(f));
    const rest = onDisk.filter(f => !required.includes(f));
    return [entry].concat(required.concat(rest)
        .map(f => fs.readFileSync(path.join(PARTS_DIR, f), 'utf8')))
        .join('\n');
}

module.exports = { readIndexerClassSource, requiredPartOrder };
