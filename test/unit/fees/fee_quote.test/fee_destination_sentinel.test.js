// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// One rule decides whether FEE_DESTINATION is usable: isUsableFeeDestination in
// src/config/fee_destination.js. The quote, pre-flight, fee-view and startup surfaces call it,
// and the chain's detectFeePaymentMode must agree with it, or a quote picks a fee mode the
// chain does not apply. The source scan keeps a new hand-written copy of the placeholder from
// appearing beside the helper.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const Utility = require('../../../../src/utility.js');
const Actions = require('../../../../src/actions/index.js');
const { FEE_DESTINATION_PLACEHOLDER, isUsableFeeDestination, usableFeeDestination } =
    require('../../../../src/config/fee_destination.js');

const SRC  = path.join(__dirname, '..', '..', '..', '..', 'src');
const REAL = '1CounterpartyXXXXXXXXXXXXXXXUWLpVr';
const DESTINATIONS = [
    ['a real FEE_DESTINATION', REAL],
    ['the placeholder FEE_DESTINATION', FEE_DESTINATION_PLACEHOLDER],
    ['no FEE_DESTINATION', null],
    ['an empty FEE_DESTINATION', '']
];

// The only files allowed to spell the placeholder: the helper's home, and the consensus-time
// rule the parity cases below bind to it. src/coins/ uses the same string as a REWARD/GAS
// placeholder address, a different job.
const ALLOWED = ['config/fee_destination.js', 'utility/fees.js'];

function jsFiles(dir, out = []){
    for(const e of fs.readdirSync(dir, { withFileTypes: true })){
        const p = path.join(dir, e.name);
        if(e.isDirectory()) jsFiles(p, out);
        else if(e.name.endsWith('.js')) out.push(path.relative(SRC, p).split(path.sep).join('/'));
    }
    return out;
}

function configFor(coin, destination){
    return { COIN: coin, NETWORK: 'regtest', ADDRESS: destination === null ? {} : { FEE_DESTINATION: destination } };
}

describe('fee destination sentinel : one usable-destination rule @regression @tier1', function () {
    for(let coin of ['BTC', 'LTC', 'DOGE']){
        for(let [label, destination] of DESTINATIONS){
            it(coin + ' with ' + label + ': usable exactly when the chain accepts a fee output paid to it', function () {
                const config = configFor(coin, destination);
                const mode = new Utility().detectFeePaymentMode.call({ config }, { COIN: coin }, null, [{ address: destination }]);
                assert.strictEqual(isUsableFeeDestination(destination), mode === 'native',
                    'helper says usable=' + isUsableFeeDestination(destination) + ' but the chain answers ' + mode);
                assert.strictEqual(usableFeeDestination(config), mode === 'native' ? destination : null);
                if(!isUsableFeeDestination(destination))
                    assert.strictEqual(Actions.prototype.nativeFeeMandatory.call({ config }), false);
            });
        }
    }

    it('no source file outside the allowed pair spells the placeholder', function () {
        const files = jsFiles(SRC).filter(f => !f.startsWith('coins/'));
        const hits  = files.filter(f => fs.readFileSync(path.join(SRC, f), 'utf8').includes(FEE_DESTINATION_PLACEHOLDER));
        assert.deepStrictEqual(hits.filter(f => !ALLOWED.includes(f)), [],
            'use isUsableFeeDestination / usableFeeDestination from src/config/fee_destination.js instead');
        // Non-vacuous: the scan does read the files and finds the copies it allows.
        assert.deepStrictEqual(hits.slice().sort(), ALLOWED.slice().sort());
    });
});

describe('fee destination sentinel : the fee views @regression @tier1', function () {
    function viewCtx(destination){
        const util = new Utility();
        const calls = { priced: 0 };
        const ctx = {
            util,
            config: Object.assign({}, util.config, configFor('BTC', destination)),
            actionAliases: {},
            calls,
            indexerDb: { getLatestBlockIndex: async () => 100, getBlockTime: async () => 1000 },
            dryRunAction: async () => ({ status: 'valid', xchainFee: '1', blockIndex: 100, blockTime: 1000 }),
            priceFeeQuote: async () => { calls.priced++; return { valid: true, requiredFeeSatsExact: '5' }; }
        };
        util.getFeeOraclePrices = async () => ({ error: 'no prices in this test' });
        return ctx;
    }

    it('getFeeSchedule reports native fees off for the placeholder and on for a real address', async function () {
        const off = await Actions.prototype.getFeeSchedule.call(viewCtx(FEE_DESTINATION_PLACEHOLDER));
        assert.strictEqual(off.nativeFeeEnabled, false);
        assert.strictEqual(off.feeDestination, null);
        const on = await Actions.prototype.getFeeSchedule.call(viewCtx(REAL));
        assert.strictEqual(on.nativeFeeEnabled, true);
        assert.strictEqual(on.feeDestination, REAL);
    });

    it('computeFeeQuoteDryRun sizes a native fee only for a real address', async function () {
        const offCtx = viewCtx(FEE_DESTINATION_PLACEHOLDER);
        const off = await Actions.prototype.computeFeeQuoteDryRun.call(offCtx, { action: 'SEND', params: [] });
        assert.strictEqual(off.feeSupported, false);
        assert.strictEqual(offCtx.calls.priced, 0, 'the placeholder must not reach native pricing');
        const onCtx = viewCtx(REAL);
        const on = await Actions.prototype.computeFeeQuoteDryRun.call(onCtx, { action: 'SEND', params: [] });
        assert.strictEqual(on.feeSupported, true);
        assert.strictEqual(onCtx.calls.priced, 1);
    });
});
