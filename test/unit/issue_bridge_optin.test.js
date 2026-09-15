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
const { assert, sinon, format7, tokenRow, run, SUBASSET } = require('./issue_bridge_optin.test/helpers/issue_fixtures.js');




describe('ISSUE token-bridge opt-in and policy exclusion @regression @consensus', function(){

    afterEach(function(){ sinon.restore(); });

    describe('format 7 admission', function(){
        it('does not exist below TOKEN_BRIDGE_ACTIVATION', async function(){
            const { status } = await run({ params: format7({ BRIDGE_CHAINS: 'DOGE' }), token: tokenRow(), bridge: false });
            assert.strictEqual(status, 'invalid: VERSION (unknown)');
        });

        it('is admitted at/above the flag and accepts a destination coin', async function(){
            const { status } = await run({ params: format7({ BRIDGE_CHAINS: 'DOGE' }), token: tokenRow() });
            assert.strictEqual(status, 'valid');
        });

        it('accepts the "-" sentinel, which is how a chain list is actually cleared', async function(){
            const { status } = await run({ params: format7({ BRIDGE_CHAINS: '-' }), token: tokenRow({ BRIDGE_CHAINS: 'DOGE' }) });
            assert.strictEqual(status, 'valid');
        });

        it('refuses an unknown tick instead of registering the name for free', async function(){
            const { status } = await run({ params: format7({ BRIDGE_CHAINS: 'DOGE' }), token: null });
            assert.strictEqual(status, 'invalid: TICK (unknown)');
        });

        it('refuses a destination that is not a supported coin', async function(){
            const { status } = await run({ params: format7({ BRIDGE_CHAINS: 'DOGE,XMR' }), token: tokenRow() });
            assert.strictEqual(status, 'invalid: BRIDGE_CHAINS');
        });

        it('refuses this chain as its own destination', async function(){
            const { status } = await run({ params: format7({ BRIDGE_CHAINS: 'BTC' }), token: tokenRow() });
            assert.strictEqual(status, 'invalid: BRIDGE_CHAINS');
        });

        it('refuses a non-integer MIN_DEPTH', async function(){
            const { status } = await run({ params: format7({ BRIDGE_CHAINS: 'DOGE', MIN_DEPTH: '3.5' }), token: tokenRow() });
            assert.strictEqual(status, 'invalid: MIN_DEPTH (format)');
        });

        it('accepts a raise-only MIN_DEPTH', async function(){
            const { status } = await run({ params: format7({ BRIDGE_CHAINS: 'DOGE', MIN_DEPTH: '3' }), token: tokenRow() });
            assert.strictEqual(status, 'valid');
        });
    });
});

describe('ISSUE token-bridge opt-in and policy exclusion @regression @consensus', function(){

    afterEach(function(){ sinon.restore(); });

    describe('format 7 admission', function(){

        it('refuses an edit of BRIDGE_CHAINS once LOCK_BRIDGE is set', async function(){
            const { status } = await run({
                params: format7({ BRIDGE_CHAINS: 'LTC' }),
                token:  tokenRow({ LOCK_BRIDGE: 1, BRIDGE_CHAINS: 'DOGE' })
            });
            assert.strictEqual(status, 'invalid: BRIDGE_CHAINS (locked)');
        });

        it('refuses an edit of MIN_DEPTH once LOCK_BRIDGE is set', async function(){
            const { status } = await run({
                params: format7({ MIN_DEPTH: '9' }),
                token:  tokenRow({ LOCK_BRIDGE: 1, BRIDGE_CHAINS: 'DOGE', MIN_DEPTH: '3' })
            });
            assert.strictEqual(status, 'invalid: MIN_DEPTH (locked)');
        });
    });
});

describe('ISSUE token-bridge opt-in and policy exclusion @regression @consensus', function(){

    afterEach(function(){ sinon.restore(); });

    describe('format 7 admission', function(){
        it('refuses unsetting LOCK_BRIDGE through the shared lock rule', async function(){
            const { status } = await run({
                params: format7({ LOCK_BRIDGE: '0' }),
                token:  tokenRow({ LOCK_BRIDGE: 1, BRIDGE_CHAINS: 'DOGE' })
            });
            assert.strictEqual(status, 'invalid: LOCK_BRIDGE (locked)');
        });
    });
});

    // Dotted native names are refused. A bridged row lives one level under its origin chain's
    // root (BTC.PEPECASH on DOGE), so a DOTTED native name would need a rooted copy of its
    // own parent and the bridge creates exactly one level. The opt-in is refused as well as
    // the v3 lock, so such a token is never advertised as bridgeable in the first place.

describe('ISSUE token-bridge opt-in and policy exclusion @regression @consensus', function(){

    afterEach(function(){ sinon.restore(); });

    describe('subassets are not bridgeable in milestone 1', function(){
        it('refuses the opt-in of a dotted native tick', async function(){
            const { status } = await run({
                params: format7({ TICK: 'FUFU.SUB', BRIDGE_CHAINS: 'DOGE', MEMO: 'memo' }),
                token:  tokenRow({ TICK: 'FUFU.SUB' })
            });
            assert.strictEqual(status, SUBASSET);
        });

        it('refuses a deeper name, the one the parent gate could never root', async function(){
            const { status } = await run({
                params: format7({ TICK: 'BTC.PEPE.CASH', BRIDGE_CHAINS: 'DOGE' }),
                token:  tokenRow({ TICK: 'BTC.PEPE.CASH' })
            });
            assert.strictEqual(status, SUBASSET);
        });

        // The refusal is on the whole format, not only on a non-empty BRIDGE_CHAINS: a
        // dotted row can never hold a value in these fields, so there is no shape of
        // format 7 a subasset answers to.
        // One case per shape rather than a loop: run() stubs both activation predicates and
        // afterEach restores them, so two runs inside one `it` re-wrap the same method.
        for(const shape of [ { label: 'an all-empty format 7', fields: {} },
                             { label: 'a "-" clear',           fields: { BRIDGE_CHAINS: '-' } },
                             { label: 'a MIN_DEPTH-only edit', fields: { MIN_DEPTH: '3' } },
                             { label: 'a LOCK_BRIDGE-only edit', fields: { LOCK_BRIDGE: '1' } } ]){
            it('refuses ' + shape.label + ' on a dotted tick', async function(){
                const { status } = await run({
                    params: format7(Object.assign({ TICK: 'FUFU.SUB' }, shape.fields)),
                    token:  tokenRow({ TICK: 'FUFU.SUB' })
                });
                assert.strictEqual(status, SUBASSET);
            });
        }

        // TICK also accepts the compact ^<id> form, which getTokenInfo resolves to the real
        // row. Judging the wire field alone would let ^12 opt a subasset in while the
        // spelled-out name was refused.
        it('refuses a ^<id> reference that resolves to a dotted row', async function(){
            const { status } = await run({
                params: format7({ TICK: '^7', BRIDGE_CHAINS: 'DOGE' }),
                token:  tokenRow({ TICK: 'FUFU.SUB' })
            });
            assert.strictEqual(status, SUBASSET);
        });

        it('leaves an undotted name alone', async function(){
            const { status } = await run({
                params: format7({ TICK: 'FUFU', BRIDGE_CHAINS: 'DOGE' }),
                token:  tokenRow({ TICK: 'FUFU' })
            });
            assert.strictEqual(status, 'valid');
        });
    });
});

describe('ISSUE token-bridge opt-in and policy exclusion @regression @consensus', function(){

    afterEach(function(){ sinon.restore(); });

    describe('subassets are not bridgeable in milestone 1', function(){
        // Inert below TOKEN_BRIDGE_ACTIVATION with every other format-7 verdict: the whole
        // format falls through to the string an unknown version has always produced.
        it('is inert below TOKEN_BRIDGE_ACTIVATION', async function(){
            const { status } = await run({
                params: format7({ TICK: 'FUFU.SUB', BRIDGE_CHAINS: 'DOGE' }),
                token:  tokenRow({ TICK: 'FUFU.SUB' }),
                bridge: false
            });
            assert.strictEqual(status, 'invalid: VERSION (unknown)');
        });

        // Precedence, pinned because a verdict string is consensus: the tick-shape refusal
        // is decided before the policy exclusion, so a dotted AND list-bound token reads as
        // a subasset rather than as policy-bound. The ISSUE refusal order
        // puts the tick-shape refusals ahead of everything the fields decide.
        it('outranks the policy exclusion on a token that is both', async function(){
            const { status } = await run({
                params: format7({ TICK: 'FUFU.SUB', BRIDGE_CHAINS: 'DOGE' }),
                token:  tokenRow({ TICK: 'FUFU.SUB', BLOCK_LIST: 42 })
            });
            assert.strictEqual(status, SUBASSET);
        });

        // A dotted name whose row does not exist never reaches the bridge block at all: the
        // parent gate, far earlier in the handler, already refuses it. The new guard adds no
        // verdict on that path, so nothing an existing chain could replay changes shape.
        it('yields to the parent gate when the row does not exist', async function(){
            const { status } = await run({ params: format7({ TICK: 'FUFU.SUB' }), token: null });
            assert.strictEqual(status, 'invalid: TICK (parent unknown)');
        });

        it('refuses on every chain, not only the one the drill runs on', async function(){
            const { status } = await run({
                params: format7({ TICK: 'FUFU.SUB', BRIDGE_CHAINS: 'BTC' }),
                token:  tokenRow({ TICK: 'FUFU.SUB' }),
                coin:   'DOGE'
            });
            assert.strictEqual(status, SUBASSET);
        });
    });
});
