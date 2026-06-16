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
 * Test configuration fixture — loads real BTC regtest config
 * without requiring any environment variables beyond INDEXER_COIN/INDEXER_NETWORK
 */

function getTestConfig() {
    // Set environment for config loading
    process.env.INDEXER_COIN = 'BTC';
    process.env.INDEXER_NETWORK = 'regtest';

    const config = require('../../src/config.js');
    return config.getConfig();
}

module.exports = { getTestConfig };
