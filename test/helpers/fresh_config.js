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
 * Load a module against the environment as it is NOW.
 *
 * src/config.js captures every environment variable the service reads into one
 * frozen CONFIG_ENV object at module load, and each consumer destructures it at
 * its own load. A test that writes process.env after those modules are cached
 * is therefore invisible to them. Set the environment first, then load the
 * consumer through this helper: it re-evaluates config.js and the consumer
 * together, hands back the fresh exports, and puts the previous cache entries
 * back so the rest of the mocha process keeps the snapshot it already had.
 */

'use strict';

const CONFIG_PATH = require.resolve('../../src/config.js');

/**
 * Require `modulePath` (absolute, or resolvable from here) with a freshly
 * evaluated src/config.js. Returns the fresh module exports.
 */
function requireWithFreshConfig(modulePath) {
    const target = require.resolve(modulePath);
    const saved = [CONFIG_PATH, target].map((p) => [p, require.cache[p]]);
    for (const [p] of saved) delete require.cache[p];
    try {
        return require(target);
    } finally {
        for (const [p, entry] of saved) {
            if (entry === undefined) delete require.cache[p];
            else require.cache[p] = entry;
        }
    }
}

module.exports = { requireWithFreshConfig };
