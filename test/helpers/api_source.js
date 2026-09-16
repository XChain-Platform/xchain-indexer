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
 * The API entry and its parts as one source text, for the source-guard suites.
 *
 * src/api.js calls startApi() at load and cannot be required under mocha, so
 * a dozen suites pin its shape by reading the text: which methods sit in which
 * auth tier set, that every federation read resolves its DB through apiView(),
 * that a response literal carries a field the hub compares. The controller's
 * route families now live under src/api/rpc/ and the middleware, the API-key
 * gate and the status route beside them, so a guard that read the entry alone
 * would stop seeing a pinned line the moment it moved, and a negative pin
 * ("never X") would pass vacuously. This reads the entry followed by every
 * part, so a pin holds wherever in the module its line lives.
 *
 * Order is load-bearing. Several guards slice from a handler's header to the
 * next eight-space `async name(` member, so a handler that closes one file
 * runs into the preamble of the next. The route families follow the entry,
 * then the remaining src/api/ helpers: a family preamble holds no controller
 * member and no database read, whereas two helpers (status_route.js and
 * health/sync_fields.js) read the decoder handle bare, and a federation read
 * sliced into either would fail its isolation guard for a line it never held.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const { listSrcTreeFiles } = require('./src_tree_files.js');

const SRC_DIR   = path.join(__dirname, '..', '..', 'src');
const ENTRY     = path.join(SRC_DIR, 'api.js');
const PARTS_DIR = path.join(SRC_DIR, 'api');

// The entry, then the route families under api/rpc/, then every other part, each
// group in path order.
function apiSourcePaths() {
    const parts = listSrcTreeFiles(PARTS_DIR).map(rel => path.join(PARTS_DIR, rel));
    const families = parts.filter(p => p.startsWith(path.join(PARTS_DIR, 'rpc') + path.sep));
    const rest = parts.filter(p => !families.includes(p));
    return [ENTRY].concat(families, rest);
}

// The module's text, newline-joined in that order.
function readApiSource() {
    return apiSourcePaths().map(p => fs.readFileSync(p, 'utf8')).join('\n');
}

module.exports = { apiSourcePaths, readApiSource };
