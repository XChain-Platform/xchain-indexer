// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// The indexer builder and the per-test cleanup the hub config overlay suite shares
// (config.test/hub_overlay*.test.js and config.test/env_overrides.test.js).

const sinon = require('sinon');

// An XChainIndexer over dummy connection settings, its config then reloaded for BTC on
// regtest, the order the overlay suite has always built it in.
function makeIndexer(){
    const XChainIndexer = require('../../../../src/XChainIndexer.js');
    let inst = new XChainIndexer(
        'dhost', 3306, 'ddb', 'duser', 'dpass',
        'ihost', 3306, 'idb', 'iuser', 'ipass',
        null, null, null, null, null,
        null, null
    );
    process.env.INDEXER_COIN    = 'BTC';
    process.env.INDEXER_NETWORK = 'regtest';
    delete require.cache[require.resolve('../../../../src/config.js')];
    inst.config = require('../../../../src/config.js').getConfig();
    return inst;
}

// The cleanup every overlay block runs after each test: drop every sinon stub and fake
// clock, and purge XChainIndexer.js from the require cache so the next test requires it
// fresh.
function restoreOverlay() {
    sinon.restore();
    delete require.cache[require.resolve('../../../../src/XChainIndexer.js')];
}

module.exports = { makeIndexer, restoreOverlay };
