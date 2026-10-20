// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The quote side's nativeFeeMandatory agrees with the chain's detectFeePaymentMode.
//
// The pre-flight picks its default fee mode from nativeFeeMandatory, which restates the rule
// detectFeePaymentMode applies to a transaction with no fee output. If the chain rule moves
// (an XCHAIN-balance fee lane on another coin) and the quote copy does not, the pre-flight
// settles through a probe output and answers valid for a payer the chain rejects for FEE.

const assert = require('assert');

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const Utility = require('../../../../src/utility.js');
const Actions = require('../../../../src/actions/index.js');

const PLACEHOLDER = 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const DESTINATIONS = [
    ['a real FEE_DESTINATION', '1CounterpartyXXXXXXXXXXXXXXXUWLpVr'],
    ['the placeholder FEE_DESTINATION', PLACEHOLDER],
    ['no FEE_DESTINATION', null]
];

// Ask the chain before and after every flag day on every network (a widening ships gated, and a
// time gate can activate per network): the far-future input stands for the tip after activation.
const NETWORKS = ['mainnet', 'testnet', 'regtest'];
const HEIGHTS = [
    ['no height', {}],
    ['a far-future height', { BLOCK_INDEX: Number.MAX_SAFE_INTEGER, BLOCK_TIME: 32503680000 }]
];

// The chain's fee mode for a transaction carrying no fee output, under `config` and `at`.
function chainModeWithoutOutput(config, coin, at){
    const data = Object.assign({ COIN: coin }, at || {});
    const mode = new Utility().detectFeePaymentMode.call({ config }, data, null, []);
    assert.strictEqual(typeof mode, 'string', 'detectFeePaymentMode no longer answers synchronously');
    return mode;
}

describe('fee mode parity : nativeFeeMandatory and detectFeePaymentMode @regression @tier1', function () {
    for(let coin of ['BTC', 'LTC', 'DOGE']){
        for(let [label, destination] of DESTINATIONS){
            it(coin + ' with ' + label + ': mandatory native exactly when the chain rejects a missing output', function () {
                for(let network of NETWORKS){
                    const config = { COIN: coin, NETWORK: network, ADDRESS: destination === null ? {} : { FEE_DESTINATION: destination } };
                    const mandatory = Actions.prototype.nativeFeeMandatory.call({ config });
                    for(let [heightLabel, at] of HEIGHTS){
                        const mode = chainModeWithoutOutput(config, coin, at);
                        assert.strictEqual(mandatory, mode === 'rejected', 'on ' + network + ' at ' + heightLabel +
                            ' the quote says mandatory=' + mandatory + ' but the chain answers ' + mode);
                    }
                }
            });
        }
    }

    // A fee-lane flag handed in by the caller would reach the chain rule through a new parameter
    // that the cases above never pass, so a new parameter has to extend this file first.
    it('detectFeePaymentMode takes no input the parity cases leave out', function () {
        assert.strictEqual(Utility.prototype.detectFeePaymentMode.length, 3,
            'detectFeePaymentMode gained a parameter: pass it in the parity cases above');
    });

    it('covers both chain answers, so the parity is not vacuous', function () {
        const real = DESTINATIONS[0][1];
        assert.strictEqual(chainModeWithoutOutput({ COIN: 'BTC', ADDRESS: { FEE_DESTINATION: real } }, 'BTC'), 'xchain');
        assert.strictEqual(chainModeWithoutOutput({ COIN: 'LTC', ADDRESS: { FEE_DESTINATION: real } }, 'LTC'), 'rejected');
    });
});
