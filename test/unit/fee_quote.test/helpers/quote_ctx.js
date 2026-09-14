// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// test/unit/fee_quote.test/helpers/quote_ctx.js
//
// The util, indexer-db stub and Actions-like context every fee_quote suite prices
// through, with the fixed fee destination and the BTC price pair they quote against.

// Utility loads coin config in its constructor from these env vars.
process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const Utility = require('../../../../src/utility.js');
const Actions = require('../../../../src/actions/index.js');

const FEE_DEST    = 'feeDestinationAddr111111111111111';
const PLACEHOLDER = 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

// Utility with a known fee destination, tolerance band, gas schedule + price.
function makeUtil(coin, feeDestination){
    let util = new Utility();
    util.config['COIN']                         = coin;
    util.config['ADDRESS']                      = Object.assign({}, util.config['ADDRESS'] || {}, { FEE_DESTINATION: feeDestination });
    util.config['FEE_TOLERANCE_MIN']            = '0.95';
    util.config['FEE_TOLERANCE_MAX']            = '1.10';
    util.config['ORACLE_MAX_PRICE_AGE_SECONDS'] = 1800;
    util.config['GAS_PRICE']                    = '0.00001';
    // Only the keys the static (no-VM) fee quote prices from; same values as coins/LTC.js.
    util.config['GAS_SCHEDULE']                 = Object.assign({}, util.config['GAS_SCHEDULE'] || {}, {
        VM_EXECUTE_BASE:    1000,
        VM_DEPLOY_BASE:     100000,
        VM_DEPLOY_PER_BYTE: 10
    });
    return util;
}

// Indexer DB stub. getLatestPrice ignores the staleness opts (mirrors native_coin_fee.test.js);
// a pair set to null models a missing/stale price.
function makeDb({ prices = {}, blockIndex = 100, blockTime = 1000 } = {}){
    return {
        getLatestBlockIndex: async () => blockIndex,
        getBlockTime:        async () => blockTime,
        getLatestPrice:      async (pair) => {
            if(prices[pair] == null) return null;
            return { price: prices[pair], roundNumber: 7, block_timestamp: 1000 };
        }
    };
}

// Actions-like context exposing the REAL computeFeeQuote/priceFeeQuote prototype methods
// with the dry-run engine stubbed (the engine itself is unit-tested in fee_quote_dry_run.test.js).
// dryRun defaults to a valid run whose handler staged a 1.0 XCHAIN fee.
function makeCtx(util, indexerDb, { dryRun, base64CodeEra = true, actions = Actions } = {}){
    let calls = { dryRunArgs: null, dryRuns: 0 };
    let ctx = {
        config:    util.config,
        util:      util,
        indexerDb: indexerDb,
        _calls:    calls,
        // DEPLOY_BASE64_CODE is the only flag-day the quote path reads (inline code decode).
        protocolChanges: { isEnabled: async (name) => (name === 'DEPLOY_BASE64_CODE' ? base64CodeEra : true) },
        nativeFeeMandatory:     actions.prototype.nativeFeeMandatory,
        decodeDeployCodeBytes:  actions.prototype.decodeDeployCodeBytes,
        staticProtocolFee:      actions.prototype.staticProtocolFee,
        staticFeeQuote:         actions.prototype.staticFeeQuote,
        dryRunAction: async (args) => {
            calls.dryRuns++;
            calls.dryRunArgs = args;
            if(dryRun && dryRun.throws) throw new Error('engine boom');
            return Object.assign({ blockIndex: 100, blockTime: 1000, status: 'valid', error: null, xchainFee: '1.00000000' }, dryRun || {});
        },
        priceFeeQuote:  actions.prototype.priceFeeQuote,
        computeFeeQuote: actions.prototype.computeFeeQuote
    };
    return { ctx, calls };
}

// 1.0 XCHAIN @ $1.00, BTC @ $50,000 => 0.00002 BTC (2000 sats); min 0.000019 (1900), max 0.000022 (2200).
const BTC_PRICES = { 'XCHAIN/USD': '1.00000000', 'BTC/USD': '50000.00000000' };

module.exports = { FEE_DEST, PLACEHOLDER, makeUtil, makeDb, makeCtx, BTC_PRICES };
