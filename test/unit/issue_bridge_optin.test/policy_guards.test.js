'use strict';

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
 * test/unit/issue_bridge_optin.test.js
 *
 * ISSUE's half of the two bridge specs and the policy-inheritance activation:
 *
 *   - FORMAT 7, the issuer's bridge opt-in (BRIDGE_CHAINS, MIN_DEPTH, LOCK_BRIDGE),
 *     admitted only at/above TOKEN_BRIDGE_ACTIVATION and invisible below it;
 *   - the POLICY EXCLUSION in both directions, with the list half
 *     lifting at TOKEN_POLICY_INHERITANCE_ACTIVATION and the controller half never
 *     lifting here;
 *   - the ceiling on a bridgeable token's list membership;
 *   - the CASE-FOLDED reserved-tick guard with the regtest exemption narrowed to the
 *     GAS tick and a system-injected exemption;
 *   - the BRIDGE-OWNED closure: an XCHAIN ISSUE off BTC is refused unconditionally,
 *     with the same IS_GENESIS exemption the lazy off-BTC row creation needs.
 *
 * Both activation predicates are stubbed per case rather than driven by block
 * height, because both maps park at regtest 0 and the house sentinel everywhere
 * else: no real (network, height) pair produces "bridge armed, inheritance not",
 * which is precisely the milestone-1 state most of these verdicts describe.
 ********************************************************************/

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const { assert, sinon, STRANGER, GAS_ADDR, format7, format5, tokenRow, run } = require('./helpers/issue_fixtures.js');



describe('ISSUE token-bridge opt-in and policy exclusion @regression @consensus', function(){

    afterEach(function(){ sinon.restore(); });

    describe('milestone-1 policy exclusion, opt-in direction', function(){
        it('refuses opting a BLOCK_LIST-bound token in', async function(){
            const { status } = await run({ params: format7({ BRIDGE_CHAINS: 'DOGE' }), token: tokenRow({ BLOCK_LIST: 42 }) });
            assert.strictEqual(status, 'invalid: TICK (policy-bound tokens are not bridgeable yet)');
        });

        it('refuses opting an ALLOW_LIST-bound token in', async function(){
            const { status } = await run({ params: format7({ BRIDGE_CHAINS: 'DOGE' }), token: tokenRow({ ALLOW_LIST: 42 }) });
            assert.strictEqual(status, 'invalid: TICK (policy-bound tokens are not bridgeable yet)');
        });

        it('refuses opting a controller-bound token in', async function(){
            const { status } = await run({
                params:      format7({ BRIDGE_CHAINS: 'DOGE' }),
                token:       tokenRow(),
                controllers: new Map([['send', 11]])
            });
            assert.strictEqual(status, 'invalid: TICK (policy-bound tokens are not bridgeable yet)');
        });

        it('lets a listed token opt in once policy inheritance is armed', async function(){
            const { status } = await run({
                params: format7({ BRIDGE_CHAINS: 'DOGE' }),
                token:  tokenRow({ BLOCK_LIST: 42 }),
                list:   ['a', 'b'],
                policy: true
            });
            assert.strictEqual(status, 'valid');
        });

        it('KEEPS refusing a controller-bound token under policy inheritance (R1)', async function(){
            const { status } = await run({
                params:      format7({ BRIDGE_CHAINS: 'DOGE' }),
                token:       tokenRow(),
                controllers: new Map([['all', 11]]),
                policy:      true
            });
            assert.strictEqual(status, 'invalid: TICK (policy-bound tokens are not bridgeable yet)');
        });

        it('refuses a list larger than XPOLICY_MAX_MEMBERS (R2)', async function(){
            const { XPOLICY_MAX_MEMBERS } = require('../../../src/protocol/constants.js');
            const { status } = await run({
                params: format7({ BRIDGE_CHAINS: 'DOGE' }),
                token:  tokenRow({ ALLOW_LIST: 42 }),
                list:   new Array(XPOLICY_MAX_MEMBERS + 1).fill('x'),
                policy: true
            });
            assert.strictEqual(status, 'invalid: TICK (policy list exceeds XPOLICY_MAX_MEMBERS)');
        });
    });

});

describe('ISSUE token-bridge opt-in and policy exclusion @regression @consensus', function(){

    afterEach(function(){ sinon.restore(); });

    describe('milestone-1 policy exclusion, opt-in direction', function(){
        it('accepts a list exactly at the ceiling', async function(){
            const { XPOLICY_MAX_MEMBERS } = require('../../../src/protocol/constants.js');
            const { status } = await run({
                params: format7({ BRIDGE_CHAINS: 'DOGE' }),
                token:  tokenRow({ ALLOW_LIST: 42 }),
                list:   new Array(XPOLICY_MAX_MEMBERS).fill('x'),
                policy: true
            });
            assert.strictEqual(status, 'valid');
        });

        it('does not consult policy at all when the opt-in clears the chain list', async function(){
            const { status } = await run({
                params: format7({ BRIDGE_CHAINS: '-' }),
                token:  tokenRow({ BLOCK_LIST: 42, BRIDGE_CHAINS: 'DOGE' })
            });
            assert.strictEqual(status, 'valid');
        });
    });

});

describe('ISSUE token-bridge opt-in and policy exclusion @regression @consensus', function(){

    afterEach(function(){ sinon.restore(); });

    describe('milestone-1 policy exclusion, policy direction', function(){

        it('refuses a format 5 list edit on a bridgeable token', async function(){
            const { status } = await run({ params: format5({ BLOCK_LIST: '42' }), token: tokenRow({ BRIDGE_CHAINS: 'DOGE' }) });
            assert.strictEqual(status, 'invalid: TICK (bridged tokens cannot be policy-bound yet)');
        });

        it('refuses a format 5 list edit on a token that has already been bridged', async function(){
            const { status } = await run({ params: format5({ BLOCK_LIST: '42' }), token: tokenRow({ BRIDGED: 1 }) });
            assert.strictEqual(status, 'invalid: TICK (bridged tokens cannot be policy-bound yet)');
        });

        it('keeps refusing after BRIDGE_CHAINS is emptied, because the bridged bit stands', async function(){
            const { status } = await run({ params: format5({ ALLOW_LIST: '42' }), token: tokenRow({ BRIDGED: 1, BRIDGE_CHAINS: null }) });
            assert.strictEqual(status, 'invalid: TICK (bridged tokens cannot be policy-bound yet)');
        });

        it('allows a format 5 list edit once policy inheritance is armed', async function(){
            const { status } = await run({ params: format5({ BLOCK_LIST: '42' }), token: tokenRow({ BRIDGED: 1 }), policy: true });
            assert.notStrictEqual(status, 'invalid: TICK (bridged tokens cannot be policy-bound yet)');
        });

        it('is silent below TOKEN_BRIDGE_ACTIVATION', async function(){
            const { status } = await run({ params: format5({ BLOCK_LIST: '42' }), token: tokenRow({ BRIDGED: 1 }), bridge: false });
            assert.notStrictEqual(status, 'invalid: TICK (bridged tokens cannot be policy-bound yet)');
        });
    });

});

describe('ISSUE token-bridge opt-in and policy exclusion @regression @consensus', function(){

    afterEach(function(){ sinon.restore(); });

    describe('reserved-tick guard', function(){

        it('is case-folded, so a lower-case coin root is refused', async function(){
            const { status } = await run({ params: format5({ TICK: 'btc' }), token: null, coin: 'DOGE', network: 'mainnet', bridge: false });
            assert.strictEqual(status, 'invalid: TICK (reserved)');
        });

        it('binds on regtest instead of being skipped there', async function(){
            const { status } = await run({ params: format5({ TICK: 'BTC' }), token: null, coin: 'DOGE', network: 'regtest', bridge: false });
            assert.strictEqual(status, 'invalid: TICK (reserved)');
        });

        it('still exempts the GAS tick on regtest, the play-money self-seed', async function(){
            const { status } = await run({ params: format5({ TICK: 'XCHAIN' }), token: null, coin: 'BTC', network: 'regtest', bridge: false });
            assert.notStrictEqual(status, 'invalid: TICK (reserved)');
        });

        it('exempts a system-injected creation, which is how a bridge root row is made', async function(){
            const { status } = await run({
                params:  format5({ TICK: 'BTC' }),
                data:    { IS_GENESIS: true, SOURCE: STRANGER },
                token:   null, coin: 'DOGE', network: 'regtest', bridge: false
            });
            assert.notStrictEqual(status, 'invalid: TICK (reserved)');
        });
    });

});

describe('ISSUE token-bridge opt-in and policy exclusion @regression @consensus', function(){

    afterEach(function(){ sinon.restore(); });

    describe('bridge-owned XCHAIN closure off BTC', function(){

        it('exempts the system-injected creation of the off-BTC row', async function(){
            const { status } = await run({
                params:  format5({ TICK: 'XCHAIN' }),
                data:    { IS_GENESIS: true, SOURCE: GAS_ADDR.DOGE },
                token:   null, coin: 'DOGE', network: 'regtest', bridge: false
            });
            assert.notStrictEqual(status, 'invalid: TICK (BTC-only)');
        });
    });
});

