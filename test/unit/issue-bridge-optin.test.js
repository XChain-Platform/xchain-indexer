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
 * test/unit/issue-bridge-optin.test.js
 *
 * ISSUE's half of the two bridge specs and the policy-inheritance milestone:
 *
 *   - FORMAT 7, the issuer's bridge opt-in (BRIDGE_CHAINS, MIN_DEPTH, LOCK_BRIDGE),
 *     admitted only at/above TOKEN_BRIDGE_ACTIVATION and invisible below it;
 *   - the MILESTONE-1 POLICY EXCLUSION in both directions, with the list half
 *     lifting at TOKEN_POLICY_INHERITANCE_ACTIVATION and the controller half never
 *     lifting here (policy spec R1);
 *   - the R2 ceiling on a bridgeable token's list membership;
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

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../fixtures/mocks');
const Issue                = require('../../src/actions/issue.js');
const tokenBridgeActivation = require('../../src/token_bridge_activation.js');
const tokenPolicyActivation = require('../../src/token_policy_activation.js');

const OWNER   = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const STRANGER = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';
const GAS_ADDR = { BTC: '1XChain3M4uRwcHqt4XuhVBUQ8cL4qQsA', DOGE: 'DGasfpttCnTijuuoAdiJ9sXJjG7vQ5pMkW' };

function makeActionsCtx(indexer){
    return {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: indexer.protocolChanges,
        processAction:   sinon.stub().resolves(),
    };
}

// ISSUE format 7: VERSION|TICK|BRIDGE_CHAINS|MIN_DEPTH|LOCK_BRIDGE|MEMO
function format7(o = {}){
    const d = Object.assign({ TICK: 'FUFU', BRIDGE_CHAINS: '', MIN_DEPTH: '', LOCK_BRIDGE: '', MEMO: '' }, o);
    return ['7', d.TICK, d.BRIDGE_CHAINS, d.MIN_DEPTH, d.LOCK_BRIDGE, d.MEMO];
}

// ISSUE format 5: VERSION|TICK|ALLOW_LIST|BLOCK_LIST|MEMO (the list-params edit)
function format5(o = {}){
    const d = Object.assign({ TICK: 'FUFU', ALLOW_LIST: '', BLOCK_LIST: '', MEMO: '' }, o);
    return ['5', d.TICK, d.ALLOW_LIST, d.BLOCK_LIST, d.MEMO];
}

// A native, unlisted, unbound token row owned by OWNER.
function tokenRow(o = {}){
    return Object.assign({
        TICK: 'FUFU', TICK_ID: 7, OWNER: OWNER, MAX_SUPPLY: '1000', MAX_MINT: '0',
        DECIMALS: 0, DESCRIPTION: 'test', SUPPLY: '100',
        LOCK_MAX_SUPPLY: 0, LOCK_MINT: 0, LOCK_MINT_SUPPLY: 0, LOCK_MAX_MINT: 0,
        LOCK_DESCRIPTION: 0, LOCK_SLEEP: 0, LOCK_CALLBACK: 0, LOCK_BRIDGE: 0,
        ALLOW_LIST: null, BLOCK_LIST: null, BRIDGE_CHAINS: null, MIN_DEPTH: null,
        BRIDGED: 0, MINT_START_BLOCK: 0, MINT_STOP_BLOCK: 0, MINT_ADDRESS_MAX: 0,
        CALLBACK_BLOCK: 0, CALLBACK_TICK: null, CALLBACK_AMOUNT: 0
    }, o);
}

// Drive one ISSUE. `bridge` / `policy` are the two activation predicates.
async function run({ params, data = {}, token = null, controllers = null, list = null,
                     coin = 'BTC', network = 'regtest', bridge = true, policy = false } = {}){
    const indexer = createMockIndexer();
    indexer.config.COIN    = coin;
    indexer.config.NETWORK = network;
    if(GAS_ADDR[coin])
        indexer.config.ADDRESS.GAS = GAS_ADDR[coin];

    indexer.indexerDb.getTokenInfo.resolves(token);
    indexer.indexerDb.getTokenControllers.resolves(controllers || new Map());
    // A token row's list indexes are back-filled into every later ISSUE by the
    // populate-empty-params merge, and the generic list-validity check runs BEFORE the
    // bridge guards, so the mock has to admit them or every listed case stops at
    // 'invalid: <FIELD> (bad list)' instead of reaching the verdict under test.
    indexer.indexerDb.isValidList.resolves(true);
    if(list)
        indexer.indexerDb.getList.resolves(list);

    sinon.stub(tokenBridgeActivation, 'isTokenBridgeActive').returns(bridge);
    sinon.stub(tokenPolicyActivation, 'isTokenPolicyInheritanceActive').returns(policy);

    const handler = new Issue(makeActionsCtx(indexer));
    const d = createBaseData(Object.assign({ ACTION: 'ISSUE', FORMAT: Number(params[0]), BLOCK_INDEX: 500, SOURCE: OWNER }, data));
    await handler.parse(params, d, null);
    return { status: d.STATUS, indexer, data: d };
}

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

        it('refuses unsetting LOCK_BRIDGE through the shared lock rule', async function(){
            const { status } = await run({
                params: format7({ LOCK_BRIDGE: '0' }),
                token:  tokenRow({ LOCK_BRIDGE: 1, BRIDGE_CHAINS: 'DOGE' })
            });
            assert.strictEqual(status, 'invalid: LOCK_BRIDGE (locked)');
        });
    });

    // Token spec section 3 and D15. A bridged row lives one level under its origin chain's
    // root (BTC.PEPECASH on DOGE), so a DOTTED native name would need a rooted copy of its
    // own parent and the bridge creates exactly one level. The opt-in is refused as well as
    // the v3 lock, so such a token is never advertised as bridgeable in the first place.
    describe('subassets are not bridgeable in milestone 1', function(){

        const SUBASSET = 'invalid: TICK (subassets are not bridgeable yet)';

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
        // a subasset rather than as policy-bound. The spec's own refusal order (section 5)
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
            const { XPOLICY_MAX_MEMBERS } = require('../../src/protocol/constants.js');
            const { status } = await run({
                params: format7({ BRIDGE_CHAINS: 'DOGE' }),
                token:  tokenRow({ ALLOW_LIST: 42 }),
                list:   new Array(XPOLICY_MAX_MEMBERS + 1).fill('x'),
                policy: true
            });
            assert.strictEqual(status, 'invalid: TICK (policy list exceeds XPOLICY_MAX_MEMBERS)');
        });

        it('accepts a list exactly at the ceiling', async function(){
            const { XPOLICY_MAX_MEMBERS } = require('../../src/protocol/constants.js');
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
