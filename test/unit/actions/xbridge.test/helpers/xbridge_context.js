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
// The addresses, tick ids and builders the XBRIDGE suite shares (xbridge.test.js
// plus the files in xbridge.test/). makeHandler builds a fresh handler over a real
// Utility and a stubbed database; makeData shapes one action the way
// actions/index.js hands it over; ledger reads back the debits or credits written.

const sinon  = require('sinon');

const { createMockDb, createBaseData } = require('../../../../fixtures/mocks');
const Utility  = require('../../../../../src/utility.js');
const configjs = require('../../../../../src/config.js');
const XBridge  = require('../../../../../src/actions/xbridge/index.js');

// Regtest p2pkh version byte is 0x6f on BTC, LTC and DOGE alike, so one regtest address
// validates on every chain the rail runs; the tests that care about a WRONG network use
// a mainnet config instead.
const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const DEST   = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';

// Placeholder keyless escrow / bridged-row-owner addresses. The real ones live
// in the coin bundles; the handler only ever reads them out of config, so the literal
// value is irrelevant to what is under test here.
const BRIDGE_DOGE = 'mxchainbridgedogeXXXXXXXXXXXXXXXXX';
const BRIDGE_LTC  = 'mxchainbridgeltcXXXXXXXXXXXXXXXXXX';
const BRIDGE_BTC  = 'mxchainbridgebtcXXXXXXXXXXXXXXXXXX';

const XCHAIN_TICK_ID = 1;   // the mock db's getTickerId default, so the fee and a v0 lock
const TOKEN_TICK_ID  = 7;   // share one balance exactly as they do on chain

// Build a handler over a real Utility and a stubbed database. The config is a FRESH
// object per call (config.getConfig builds one every time) and the same object is handed
// to Utility, so patching it here cannot leak into another test.
function makeHandler(opts){
    opts = opts || {};
    let coin    = opts.coin    || 'BTC';
    let network = opts.network || 'regtest';

    let config = configjs.getConfig(coin, network);

    // The coin-bundle entries, supplied here so this suite does not depend on them.
    config['ADDRESS']['BRIDGE_DOGE'] = BRIDGE_DOGE;
    config['ADDRESS']['BRIDGE_LTC']  = BRIDGE_LTC;
    config['ADDRESS']['BRIDGE_BTC']  = BRIDGE_BTC;
    config['GAS_SCHEDULE']['XBRIDGE_BASE'] = 5000;
    if(opts.noFeeDestination)
        config['ADDRESS']['FEE_DESTINATION'] = 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

    let util      = new Utility(config);
    let indexerDb = createMockDb();
    let mapper    = { createMappings: sinon.stub().resolves() };

    // The two database writers the handler calls (see its file header): the
    // xbridges action row in src/db/xbridges/index.js and the tokens.bridged setter in
    // src/db/tokens/index.js. Stubbed here so the payload each one receives is pinned by test.
    indexerDb.createXbridge    = sinon.stub().resolves();
    indexerDb.setTokenBridged  = sinon.stub().resolves();

    let actionsCtx = {
        config:    config,
        util:      util,
        mapper:    mapper,
        decoderDb: createMockDb(),
        indexerDb: indexerDb,
        protocolChanges: {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true)
        }
    };

    util.resetLists();

    return { handler: new XBridge(actionsCtx), indexerDb, config, util, mapper };
}

// One data object shaped the way actions/index.js hands it to a handler.
function makeData(format, coin, overrides){
    return createBaseData(Object.assign({
        ACTION:       'XBRIDGE',
        FORMAT:       format,
        COIN:         coin || 'BTC',
        SOURCE:       SOURCE,
        BLOCK_INDEX:  100,
        ACTION_INDEX: 42,
        TX_OUTPUTS:   []
    }, overrides || {}));
}

// Collect the [tick, amount, address] triples the handler actually wrote.
function ledger(indexerDb, kind){
    let stub = (kind === 'credit') ? indexerDb.createCredit : indexerDb.createDebit;
    return stub.getCalls().map(c => [c.args[1], String(c.args[2]), c.args[3]]);
}

module.exports = {
    SOURCE, DEST, BRIDGE_DOGE, BRIDGE_LTC, BRIDGE_BTC, XCHAIN_TICK_ID, TOKEN_TICK_ID,
    makeHandler, makeData, ledger,
};
