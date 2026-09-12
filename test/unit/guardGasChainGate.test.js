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
 * The controller-guard gas reservation is keyed on the CHAIN, not on whether
 * an XCHAIN row happens to exist on it (xchain-bridge.md section 9, D36).
 *
 * Today the reservation at utility._invokeController is skipped off BTC only
 * as an accident of state: getTokenInfo('XCHAIN') returns null on LTC and
 * DOGE, so every caller passes gasInfo = null and the balance comparison is
 * never reached. The bridge creates a real XCHAIN row on those chains the
 * first time a transfer settles, and from that block gasInfo is non-null: a
 * controller-guarded action from a source holding no XCHAIN would flip from
 * valid to 'invalid: insufficient funds (guard gas)' with no flag day naming
 * the change. utility.isGuardGasReserved makes the rule explicit and BTC-only
 * until milestone 2's XCHAIN_FEE_MODE_ALL_CHAINS flag day widens it.
 *
 * This file pins the predicate and the one reservation site that reads it.
 * The replay witness for the verdicts themselves (base AT9) is in
 * verdictWitnessGasRow.test.js.
 ********************************************************************/

'use strict';

const assert  = require('assert');
const Utility = require('../../src/utility.js');

// Build a real indexer config for one coin on regtest. config.getConfig() reads
// the env on every call and returns a fresh object, so this hands back an
// independent snapshot per coin rather than a shared, mutated one.
function configFor(coin){
    const prevCoin    = process.env.INDEXER_COIN;
    const prevNetwork = process.env.INDEXER_NETWORK;
    process.env.INDEXER_COIN    = coin;
    process.env.INDEXER_NETWORK = 'regtest';
    const cfg = require('../../src/config.js').getConfig();
    if(prevCoin === undefined) delete process.env.INDEXER_COIN; else process.env.INDEXER_COIN = prevCoin;
    if(prevNetwork === undefined) delete process.env.INDEXER_NETWORK; else process.env.INDEXER_NETWORK = prevNetwork;
    return cfg;
}

// Minimal stand-ins for the two collaborators _invokeController reaches: the
// flag-day reader and the VM guard runner. Both succeed, so the ONLY thing that
// can produce a refusal in these tests is the gas reservation under test.
function actionsStub(guard){
    return {
        protocolChanges: { isEnabled: async () => true },
        actionExecute:   { runControllerGuard: async () => guard },
    };
}

const GUARD_ALLOW = { allow: true, reason: null, gasBilled: 1000, payoutLegs: null };

// opts as maybeRunControllerGuard assembles them for a token handler.
function opts(overrides){
    return Object.assign({
        actionType:   'ORDER_CREATE',
        data:         { BLOCK_INDEX: 100, ACTION_INDEX: 1, SOURCE: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH' },
        tick:         'TOK',
        from:         'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
        to:           '',
        amount:       '100',
        price:        '100',
        proceedsTick: 'PAY',
        // The state the bridge changes: gasInfo null before the XCHAIN row exists
        // on this chain, a real row afterwards. gasBalances empty = a source that
        // holds no XCHAIN, the AT9 subject.
        gasInfo:      { TICK_ID: 7 },
        gasBalances:  {},
        seq:          0,
    }, overrides || {});
}

describe('guard gas reservation: keyed on the chain, not on the XCHAIN row @regression @tier1', function(){

    describe('isGuardGasReserved', function(){

        it('is true on BTC and false on the chains the bridge mints XCHAIN on', function(){
            assert.strictEqual(new Utility(configFor('BTC')).isGuardGasReserved({}),  true,  'BTC reserves');
            assert.strictEqual(new Utility(configFor('DOGE')).isGuardGasReserved({}), false, 'DOGE does not reserve');
            assert.strictEqual(new Utility(configFor('LTC')).isGuardGasReserved({}),  false, 'LTC does not reserve');
        });

        it('falls back to the action\'s own stamped COIN when the config carries none, as detectFeePaymentMode does', function(){
            // Same resolution order as detectFeePaymentMode: process config first, the
            // action's COIN second. A tool that built a Utility off a config without a
            // COIN must not silently read as "not BTC" and skip a BTC reservation.
            const cfg = Object.assign({}, configFor('BTC'));
            delete cfg['COIN'];
            const util = new Utility(cfg);
            assert.strictEqual(util.isGuardGasReserved({ COIN: 'BTC'  }), true);
            assert.strictEqual(util.isGuardGasReserved({ COIN: 'DOGE' }), false);
        });

        it('reads the chain, never the presence of a gas row', function(){
            // The predicate takes only the action data. Nothing about a token row can
            // reach it, which is the whole point: the row may appear at any block.
            const util = new Utility(configFor('DOGE'));
            assert.strictEqual(util.isGuardGasReserved({ GAS_ROW_EXISTS: true }), false);
        });

    });

    describe('the reservation site in _invokeController', function(){

        // db carries only what the reservation arithmetic reads.
        function dbFor(cfg){
            return { config: cfg };
        }

        it('refuses on BTC when the source cannot cover the guard gas ceiling', async function(){
            const cfg  = configFor('BTC');
            const util = new Utility(cfg);
            const res  = await util._invokeController(actionsStub(GUARD_ALLOW), dbFor(cfg), 5, opts(), { actionClass: 'trade', subject: 'token TOK' });
            assert.strictEqual(res.error, 'insufficient funds (guard gas)');
            assert.strictEqual(res.guardFee, 0);
        });

        it('does not refuse on DOGE once the XCHAIN row exists and the source holds none', async function(){
            const cfg  = configFor('DOGE');
            const util = new Utility(cfg);
            const res  = await util._invokeController(actionsStub(GUARD_ALLOW), dbFor(cfg), 5, opts(), { actionClass: 'trade', subject: 'token TOK' });
            assert.strictEqual(res.error, null, 'the reservation is BTC-only, so the DOGE guard still runs');
            // 1000 gas billed at the regtest GAS_PRICE of 0.00001. guardFee is a
            // bignumber (bcmul), so compare through the same arithmetic the handlers use.
            assert.strictEqual(util.bcstr(res.guardFee), '0.01', 'guard gas is still billed off BTC');
        });

        it('still refuses on BTC when the source holds less than the ceiling but more than zero', async function(){
            // Guards against a gate that accidentally keys on "has any balance".
            const cfg  = configFor('BTC');
            const util = new Utility(cfg);
            const ceiling  = util.resolveGuardGasCeiling(cfg);
            const maxFee   = util.bcmul(ceiling, cfg['GAS_PRICE'], 8);
            const justShy  = util.bcsub(maxFee, '0.00000001', 8);
            const res = await util._invokeController(actionsStub(GUARD_ALLOW), dbFor(cfg), 5,
                opts({ gasBalances: { 7: justShy } }), { actionClass: 'trade', subject: 'token TOK' });
            assert.strictEqual(res.error, 'insufficient funds (guard gas)');
        });

        it('allows on BTC when the source covers the ceiling exactly', async function(){
            const cfg  = configFor('BTC');
            const util = new Utility(cfg);
            const maxFee = util.bcmul(util.resolveGuardGasCeiling(cfg), cfg['GAS_PRICE'], 8);
            const res = await util._invokeController(actionsStub(GUARD_ALLOW), dbFor(cfg), 5,
                opts({ gasBalances: { 7: maxFee } }), { actionClass: 'trade', subject: 'token TOK' });
            assert.strictEqual(res.error, null);
        });

        it('leaves every other refusal in the shared tail alone on both chains', async function(){
            // The gate sits after the activation gate, the feequote probe refusal and the
            // guard-of-guard skip, and must not swallow a DENY from the guard itself.
            const deny = { allow: false, reason: 'denied by policy', gasBilled: 0, payoutLegs: null };
            for(const coin of ['BTC', 'DOGE']){
                const cfg  = configFor(coin);
                const util = new Utility(cfg);
                const res  = await util._invokeController(actionsStub(deny), dbFor(cfg), 5,
                    opts({ gasBalances: { 7: '999' } }), { actionClass: 'trade', subject: 'token TOK' });
                assert.strictEqual(res.error, 'denied by policy', coin + ': a guard DENY still refuses');
            }
        });

    });

});
