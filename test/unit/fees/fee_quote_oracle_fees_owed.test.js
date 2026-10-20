// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// /feequote discloses the oracle usage fee a Mode B DISPENSER owes, as /preflight does.
//
// The probe exempts the dispenser's oracle-fee OUTPUT check (no transaction exists yet) and
// records what is owed instead. The pre-flight surfaced that record; the fee quote dropped
// it, so a valid quote for a Mode B create carried no sign that a second native output to
// the oracle operator is required, and the SDK's /feequote fallback had nothing to read.

const assert = require('assert');

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const Utility       = require('../../../src/utility.js');
const Actions       = require('../../../src/actions/index.js');
const PreflightMemo = require('../../../src/chain/preflight_memo.js');

const FEE_DEST = 'feeDestinationAddr111111111111111';
const OWED     = { oracleAddr1111111111111111111111: '0.00020000' };

function makeCtx(run){
    let util = new Utility();
    util.config['COIN']    = 'BTC';
    util.config['GAS']     = 'XCHAIN';
    util.config['ADDRESS'] = Object.assign({}, util.config['ADDRESS'] || {}, { FEE_DESTINATION: FEE_DEST });
    return {
        config:    util.config,
        util:      util,
        actionAliases: {},
        indexerDb: { getLatestBlockIndex: async () => 100, getBlockTime: async () => 1000 },
        _preflightMemo: new PreflightMemo(4),
        _feeQuotePending: 0,
        dryRunAction: async () => Object.assign({ blockIndex: 100, blockTime: 1000, status: 'valid', error: null,
                                                  xchainFee: '1', sourceFeeBalance: null,
                                                  subCommands: null, oracleFeesOwed: null }, run),
        // Pricing is not under test here; it answers a sized protocol-fee output.
        priceFeeQuote: async (base) => Object.assign(base, { valid: true, error: null, requiredFeeSats: 1000 }),
        nativeFeeMandatory: Actions.prototype.nativeFeeMandatory,
        batchProbeForbiddenSubAction: Actions.prototype.batchProbeForbiddenSubAction,
        staticFeeQuote:   Actions.prototype.staticFeeQuote,
        computeFeeQuote:  Actions.prototype.computeFeeQuote,
        computePreflight: Actions.prototype.computePreflight
    };
}

const DISPENSER = { action: 'DISPENSER', params: '0|AAA|1|1|0|1|USD|oracleAddr1111111111111111111111', source: 's' };

describe('fee quote discloses the oracle usage fee owed @regression @tier1', function () {

    it('a valid Mode B quote carries oracleFeesOwed beside the protocol-fee sizing', async function () {
        let r = await makeCtx({ oracleFeesOwed: OWED }).computeFeeQuote(DISPENSER);
        assert.strictEqual(r.valid, true);
        assert.strictEqual(r.requiredFeeSats, 1000);
        assert.deepStrictEqual(r.oracleFeesOwed, OWED, 'the separate oracle output the chain requires must be disclosed');
    });

    it('answers the same map the pre-flight answers for the same run', async function () {
        let quote = await makeCtx({ oracleFeesOwed: OWED }).computeFeeQuote(DISPENSER);
        let pre   = await makeCtx({ oracleFeesOwed: OWED }).computePreflight(DISPENSER);
        assert.deepStrictEqual(quote.oracleFeesOwed, pre.oracleFeesOwed);
    });

    it('omits the field when no oracle fee is owed', async function () {
        let r = await makeCtx({}).computeFeeQuote(DISPENSER);
        assert.strictEqual(r.valid, true);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(r, 'oracleFeesOwed'), false);
    });

    it('omits the field on a rejected run, which owes nothing', async function () {
        let r = await makeCtx({ status: 'invalid: GIVE_TICK (unknown)', xchainFee: null, oracleFeesOwed: OWED })
            .computeFeeQuote(DISPENSER);
        assert.strictEqual(r.valid, false);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(r, 'oracleFeesOwed'), false);
    });
});
