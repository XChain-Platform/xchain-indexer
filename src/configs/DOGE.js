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
 * XChain Indexer - COIN Configuration - Dogecoin (DOGE)
 *
 * Thin adapter over the canonical coin definition in src/coins/DOGE.js. All
 * Dogecoin values live there; edit that file, not this one.
 *
 ********************************************************************/
const { toIndexerConfig } = require('./_adapter');

module.exports = {
    getConfig: function(network){
        return toIndexerConfig('DOGE', network);
    }
};
