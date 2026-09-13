/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * Binds the two native-fee CLASSIFIERS to the coin registry's
 * FEE_PAYMENT_MODE, for every ALLOWED_COINS entry.
 *
 * Which chains are native-fee-only is decided in two places, and neither
 * reads the registry field named for the property:
 *   - src/config.js  - the startup guard that makes FEE_DESTINATION
 *     mandatory, written as `coin === 'LTC' || coin === 'DOGE'`.
 *   - src/utility.js - detectFeePaymentMode, written as
 *     `coin === 'BTC' ? 'xchain' : 'rejected'`.
 * Adding a chain is documented as "drop a <COIN>.js data file and add it to
 * COIN_FILES" (src/coins/index.js), which touches neither list. A chain
 * onboarded that way is classified native-only by utility.js while config.js
 * does NOT require its FEE_DESTINATION; if that address is then absent or the
 * placeholder, detectFeePaymentMode short-circuits to 'xchain' for every
 * action on that node while a correctly-configured peer returns 'rejected'
 * - the acceptance divergence the config.js guard exists to prevent.
 *
 * These tests do not move the classification into the registry (that is a
 * consensus-pin question: FEE_PAYMENT_MODE is deliberately outside
 * consensusSubset(), so making it a runtime decider would let a divergent
 * bundle verify clean at boot). They make the two literal lists unable to
 * diverge from the registry without CI going red, so the onboarding trap
 * fires at build time on a developer's machine rather than at runtime on a
 * live node.
 ********************************************************************/

const assert = require('assert');

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const coins   = require('../../src/coins/index.js');
const config  = require('../../src/config.js');
const Utility = require('../../src/utility.js');

const PLACEHOLDER = 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const VALID_MODES = ['native', 'xchain'];

// A real (non-placeholder) address, so detectFeePaymentMode gets past its
// unset/placeholder short-circuit and reaches the per-coin classification.
const FEE_DEST = 'mfeesJdVLx23zhtsCveA8EEfmHX7qSV2Ls';

function declaredMode(tick){
    return coins.getCoinConfig(tick, 'regtest').FEE_PAYMENT_MODE;
}

describe('native-fee classification tracks the coin registry', () => {

    it('every ALLOWED_COINS entry declares a FEE_PAYMENT_MODE of native or xchain', () => {
        assert.ok(coins.ALLOWED_COINS.length > 0, 'ALLOWED_COINS is empty; the guard below would iterate nothing');
        for(const tick of coins.ALLOWED_COINS){
            assert.ok(VALID_MODES.includes(declaredMode(tick)),
                `${tick}: FEE_PAYMENT_MODE must be 'native' or 'xchain', got ${JSON.stringify(declaredMode(tick))}`);
        }
    });

    // Binds src/utility.js's `coin === 'BTC'` literal to the registry. A chain
    // declaring 'xchain' that the literal does not name reddens here.
    it('detectFeePaymentMode returns the mode the registry declares, on every coin', () => {
        for(const tick of coins.ALLOWED_COINS){
            const cfg  = config.getConfig(tick, 'regtest');
            cfg['ADDRESS']['FEE_DESTINATION'] = FEE_DEST;
            const util = new Utility(cfg);
            const mode = util.detectFeePaymentMode({ COIN: tick }, null, []);
            const want = declaredMode(tick) === 'xchain' ? 'xchain' : 'rejected';
            assert.strictEqual(mode, want,
                `${tick}: registry declares FEE_PAYMENT_MODE ${declaredMode(tick)}, so a transaction with no native fee output must resolve to '${want}', got '${mode}'`);
        }
    });

    // Binds src/config.js's `coin === 'LTC' || coin === 'DOGE'` literal to the
    // registry. A chain declaring 'native' that the literal does not name
    // reddens here, because its config resolves instead of failing closed.
    it('the startup FEE_DESTINATION guard fires on exactly the registry-declared native chains', () => {
        for(const tick of coins.ALLOWED_COINS){
            const key   = 'XCHAIN_FEE_DESTINATION_' + tick + '_REGTEST';
            const prior = process.env[key];
            process.env[key] = PLACEHOLDER;
            let threw = false;
            try {
                config.getConfig(tick, 'regtest');
            } catch(err){
                threw = true;
                assert.match(err.message, /FEE_DESTINATION is required on /,
                    `${tick}: expected the native-fee startup guard, got: ${err.message}`);
            } finally {
                if(prior === undefined) delete process.env[key];
                else process.env[key] = prior;
            }
            const wantThrow = declaredMode(tick) === 'native';
            assert.strictEqual(threw, wantThrow, wantThrow
                ? `${tick}: registry declares FEE_PAYMENT_MODE 'native', so a placeholder FEE_DESTINATION must fail closed at startup; config resolved instead`
                : `${tick}: registry declares FEE_PAYMENT_MODE 'xchain', so a placeholder FEE_DESTINATION must NOT fail closed at startup`);
        }
    });

});
