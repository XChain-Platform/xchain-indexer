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
 *
 * XChain Indexer - Database mixin: swaps
 * 
 * The queries over the swaps table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

const path    = require('path');

// The swaps mixin is cut into parts by behaviour under swaps/; this entry merges them
// back into the one method set db/index.js installs, in the order those methods held here.
const swapRows    = require('./swap_rows.js');
const swapInfo    = require('./swap_info.js');
const swapMatches = require('./swap_matches.js');

module.exports = {

    ...swapRows,

    ...swapInfo,

    ...swapMatches,

};
