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
 * Base AT9, the verdict witness (the base bridge spec section 15).
 *
 * "A controller-guarded ORDER, SEND and DISPENSER on DOGE regtest from a
 *  source with no XCHAIN carry the same verdict before and after the XCHAIN
 *  row exists on that chain."
 *
 * The XCHAIN row off BTC is created by the first XBRIDGE v2 in-leg on that
 * chain (section 9), at whatever block that lands. Nothing else about the
 * chain changes at that block, so no verdict may change at it either: a
 * verdict that moves without a flag day forks any node that mirrors the
 * transfer a block later than its peer.
 *
 * The one branch that would have moved is the controller-guard gas
 * reservation, which reads getTokenInfo(GAS) and today skips off BTC only
 * because that read returns null. This file drives both states of that read,
 * BEFORE (gasInfo null) and AFTER (a real row, source balance zero), and
 * asserts the verdict is byte-identical off BTC.
 *
 * Two layers, because AT9 names three action classes that share one
 * enforcement point:
 *   1. the shared chokepoint, utility.maybeRunControllerGuard, driven for the
 *      ORDER_CREATE, SEND (transfer) and DISPENSER_CREATE classes,
 *   2. the real SEND handler end to end on a DOGE regtest config.
 * The full three-action drive on the rail is Phase 3's, not a unit test's.
 *
 * The BTC control in each layer is what keeps the witness from being vacuous:
 * on BTC the same AFTER state DOES refuse, so an identity off BTC is the gate
 * working and not the check having disappeared.
 ********************************************************************/

'use strict';

const assert  = require('assert');
const sinon   = require('sinon');
const Utility = require('../../src/utility.js');

const { createMockIndexer, createBaseData, createTokenInfo } = require('../fixtures/mocks');
const Send = require('../../src/actions/send.js');

// DOGE and LTC regtest reuse Bitcoin-testnet base58 prefixes (utility ADDRESS_PARAMS),
// so one address pair is valid on every regtest chain this file drives.
const SOURCE      = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const DESTINATION = 'mtr6NtB5KJRAxTX5AbuRtV7S4FF2PZJXUs';

const GAS_TICK_ID = 7;

// A real indexer config for one coin on regtest; see guardGasChainGate.test.js.
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

describe('base AT9: the XCHAIN row appearing off BTC moves no verdict @regression @tier1', function(){

    describe('the shared controller-guard chokepoint, for all three AT9 action classes', function(){

        // maybeRunControllerGuard with a controller bound, the guard allowing, and the
        // source holding no GAS. `gasInfo` is the only thing that differs between the
        // BEFORE and AFTER worlds, which is exactly what the XCHAIN row's creation changes.
        async function runGuard(coin, gasInfo, actionType){
            const cfg  = configFor(coin);
            const util = new Utility(cfg);
            const db   = {
                config:                              cfg,
                getTickerId:                         async () => 1,
                getEffectiveTokenControllerForGuard: async () => ({ contract_index: 5 }),
            };
            const actions = {
                protocolChanges: { isEnabled: async () => true },
                actionExecute:   { runControllerGuard: async () => ({ allow: true, reason: null, gasBilled: 1000, payoutLegs: null }) },
            };
            const res = await util.maybeRunControllerGuard(actions, db, {
                actionType:   actionType,
                tick:         'TOK',
                from:         SOURCE,
                to:           '',
                amount:       '100',
                price:        '100',
                proceedsTick: 'PAY',
                data:         { BLOCK_INDEX: 100, ACTION_INDEX: 1, SOURCE: SOURCE, COIN: coin },
                gasInfo:      gasInfo,
                gasBalances:  {},   // the AT9 subject: a source holding no XCHAIN
            });
            // guardFee is a bignumber; normalize so the two worlds compare as values.
            return { error: res.error, guardFee: util.bcstr(res.guardFee), payoutLegs: res.payoutLegs };
        }

        const BEFORE = null;                                  // getTokenInfo('XCHAIN') off BTC today
        const AFTER  = { TICK_ID: GAS_TICK_ID, TICK: 'XCHAIN', DECIMALS: 8 };  // after the first in-leg

        for(const actionType of ['ORDER_CREATE', 'SEND', 'DISPENSER_CREATE']){
            it('DOGE ' + actionType + ': identical verdict before and after the row exists', async function(){
                const before = await runGuard('DOGE', BEFORE, actionType);
                const after  = await runGuard('DOGE', AFTER,  actionType);
                assert.deepStrictEqual(after, before, actionType + ' verdict moved when the XCHAIN row appeared on DOGE');
                assert.strictEqual(before.error, null, 'and the shared verdict is the pre-bridge one, not a refusal');
            });

            it('LTC ' + actionType + ': identical verdict before and after the row exists', async function(){
                const before = await runGuard('LTC', BEFORE, actionType);
                const after  = await runGuard('LTC', AFTER,  actionType);
                assert.deepStrictEqual(after, before, actionType + ' verdict moved when the XCHAIN row appeared on LTC');
            });

            it('BTC ' + actionType + ': the reservation is still live (the witness is not vacuous)', async function(){
                const after = await runGuard('BTC', AFTER, actionType);
                assert.strictEqual(after.error, 'insufficient funds (guard gas)',
                    'BTC must still refuse a guarded ' + actionType + ' from a source with no XCHAIN');
            });
        }

    });

    describe('the real SEND handler on DOGE regtest', function(){

        // SEND is the one AT9 action whose whole verdict is reachable in a unit test:
        // it charges no protocol fee, so no native-fee refusal masks the guard branch
        // the way it would on ORDER and DISPENSER off BTC (both validate the fee before
        // running the guard). Those two are witnessed at the chokepoint above and on the
        // rail in Phase 3.
        function buildHandler(coin, gasRowExists){
            const cfg     = configFor(coin);
            const indexer = createMockIndexer();
            const util    = new Utility(cfg);
            const db      = indexer.indexerDb;

            db.config = cfg;
            db.isActionAllowed.resolves(true);
            db.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            db.findMatchingDispensers.resolves([]);
            db.findDispenserSends.resolves([]);
            // A `transfer`-class controller on the sent token, so the guard actually runs.
            db.getEffectiveTokenControllerForGuard.resolves({ contract_index: 7 });
            db.getTickerId.resolves(1);

            const sendToken = createTokenInfo({ TICK: 'TOK', TICK_ID: 1, DECIMALS: 0, SUPPLY: '1000' });
            const gasToken  = createTokenInfo({ TICK: cfg['GAS'], TICK_ID: GAS_TICK_ID, DECIMALS: 8 });
            db.getTokenInfo
                .withArgs('TOK', sinon.match.any, sinon.match.any).resolves(sendToken)
                // BEFORE the bridge settles on this chain the GAS row does not exist, so the
                // read returns null; AFTER it, a real row. Nothing else differs.
                .withArgs(cfg['GAS'], sinon.match.any, sinon.match.any).resolves(gasRowExists ? gasToken : null);
            // The source holds 100 TOK and no XCHAIN at all.
            db.getAddressBalances.resolves({ 1: '100' });

            const actionsCtx = {
                config:          cfg,
                util:            util,
                mapper:          indexer.mapper,
                decoderDb:       indexer.decoderDb,
                indexerDb:       db,
                protocolChanges: { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) },
                actionExecute:   { runControllerGuard: sinon.stub().resolves({ allow: true, gasBilled: 100000, payoutLegs: null }) },
                processAction:   sinon.stub().resolves(),
            };
            return new Send(actionsCtx);
        }

        async function verdict(coin, gasRowExists){
            const handler = buildHandler(coin, gasRowExists);
            const data    = createBaseData({ ACTION: 'SEND', FORMAT: 0, SOURCE: SOURCE, COIN: coin });
            await handler.parse(['0', 'TOK', '10', DESTINATION, ''], data, null);
            return data.STATUS;
        }

        afterEach(function(){ sinon.restore(); });

        it('DOGE: a controller-guarded SEND from a source with no XCHAIN keeps its verdict across the row', async function(){
            const before = await verdict('DOGE', false);
            const after  = await verdict('DOGE', true);
            assert.strictEqual(after, before, 'SEND verdict moved when the XCHAIN row appeared on DOGE');
            assert.strictEqual(before, 'valid', 'and it is the pre-bridge verdict, not a shared refusal');
        });

        it('LTC: same, on the other non-BTC chain', async function(){
            const before = await verdict('LTC', false);
            const after  = await verdict('LTC', true);
            assert.strictEqual(after, before, 'SEND verdict moved when the XCHAIN row appeared on LTC');
            assert.strictEqual(before, 'valid');
        });

        it('BTC: the same AFTER state refuses, so the DOGE identity above is the gate and not a dead check', async function(){
            const after = await verdict('BTC', true);
            assert.strictEqual(after, 'invalid: insufficient funds (guard gas)');
        });
    });

    describe('the emission fee path, the other branch the row could have moved', function(){

        // detectFeePaymentMode returns 'xchain' for an IS_EMISSION action on EVERY chain
        // (a synthesized action has no transaction of its own and so can carry no native
        // fee output), which is the one fee path that reaches the XCHAIN-balance branch
        // off BTC. That branch does not read getTokenInfo at all: the tick id comes from
        // createFeesObject, which calls getTickerId. The bridge's row creation flips that
        // id from null to a real one, so this pins that the verdict for the AT9 subject,
        // a source with no XCHAIN, is the same on both sides of the flip.
        it('an emission fee refusal is identical whether the GAS ticker id exists or not', async function(){
            const cfg  = configFor('DOGE');
            const util = new Utility(cfg);

            assert.strictEqual(util.detectFeePaymentMode({ IS_EMISSION: 1, COIN: 'DOGE' }, null, []), 'xchain',
                'an emission pays from an XCHAIN balance on every chain');

            const noXchainHeld = {};
            // BEFORE: getTickerId('XCHAIN') is null off BTC, so the comparison is against
            // a tick the ledger does not carry. AFTER: a real id with a zero balance.
            assert.strictEqual(util.hasBalance(noXchainHeld, null, '1'), false);
            assert.strictEqual(util.hasBalance(noXchainHeld, GAS_TICK_ID, '1'), false);
            // A zero fee is covered either way, so a fee-free emission is unaffected too.
            assert.strictEqual(util.hasBalance(noXchainHeld, null, '0'), true);
            assert.strictEqual(util.hasBalance(noXchainHeld, GAS_TICK_ID, '0'), true);
        });

    });

});
