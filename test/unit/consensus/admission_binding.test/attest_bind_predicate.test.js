/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * The attest-response bind predicate (utility.selectApplicableAttestationResponses)
 * under the mirror-admission flag day: a row binds by admit_block_btc above the
 * activation and by effective_time below it, with every other clause untouched, and the
 * applier passes thread the block index and the coin into both halves of the read.
 * Part of the suite whose entry is test/unit/admission_binding.test.js.
 *
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN || 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { NETWORK, ADMIT_AT, LEGACY_AT, load, ARMS } = require('./helpers/arms.js');

const REQ_ID = 'd'.repeat(64);
const T      = 1700000000;
const request = (extra) => Object.assign({ request_id: REQ_ID, request_status: 'pending', deadline_block: 900000,
                                           block_index: 90, action_index: 11 }, extra || {});
const mirror  = (extra) => Object.assign({ request_id: REQ_ID, effective_time: T, response_hash: 'a'.repeat(64) }, extra || {});

describe('admission binding: the attest-response bind predicate', function () {

    for (const arm of ARMS) {
        describe(arm.name, function () {
            let h, util;
            before(function () { h = load(arm.activation); util = new h.Utility({ COIN: 'BTC', NETWORK: NETWORK }); });
            after(function () { if (h) h.restore(); h = null; });

            const sel = (rows, B, t, coin) => util.selectApplicableAttestationResponses(rows, [request()], B, t, NETWORK, coin);

            const legacyHeights = arm.activation === null ? [0, LEGACY_AT, ADMIT_AT] : (arm.legacyBlock !== null ? [arm.legacyBlock] : []);
            for (const B of legacyHeights) {
                it('below the activation at B=' + B + ' a row binds by effective_time <= t(B) and the column is ignored', function () {
                    assert.strictEqual(sel([mirror()], B, T).length, 1);
                    assert.strictEqual(sel([mirror()], B, T - 1).length, 0, 'one second short of the effective time');
                    // A column that would refuse above the activation changes nothing below it.
                    assert.strictEqual(sel([mirror({ admit_block_btc: B + 1 })], B, T).length, 1);
                    assert.strictEqual(sel([mirror({ admit_block_btc: B - 1 })], B, T - 1).length, 0);
                });
            }

            if (arm.modernBlock !== null) {
                const B = arm.modernBlock;

                it('above the activation at B=' + B + ' a row with a height binds by admit_block_btc <= B, not by the clock', function () {
                    assert.strictEqual(sel([mirror({ admit_block_btc: B })], B, T - 1).length, 1, 'the clock no longer holds a row whose height has arrived');
                    assert.strictEqual(sel([mirror({ admit_block_btc: B + 1 })], B, T + 100).length, 0, 'the clock no longer admits a row whose height has not');
                    assert.strictEqual(sel([mirror({ admit_block_btc: B + 1 })], B + 1, T - 1).length, 1);
                });

                it('above the activation a row with NO height binds by the legacy clock rule (C38)', function () {
                    assert.strictEqual(sel([mirror()], B, T).length, 1);
                    assert.strictEqual(sel([mirror({ admit_block_btc: null })], B, T).length, 1);
                    assert.strictEqual(sel([mirror({ admit_block_btc: null })], B, T - 1).length, 0);
                });
            }
        });
    }
});

describe('admission binding: the attest-response bind predicate', function () {

    for (const arm of ARMS) {
        describe(arm.name, function () {
            let h, util;
            before(function () { h = load(arm.activation); util = new h.Utility({ COIN: 'BTC', NETWORK: NETWORK }); });
            after(function () { if (h) h.restore(); h = null; });

            const sel = (rows, B, t, coin) => util.selectApplicableAttestationResponses(rows, [request()], B, t, NETWORK, coin);

            if (arm.modernBlock !== null) {
                const B = arm.modernBlock;

                it('above the activation the deadline, pending and mirror-era clauses still hold', function () {
                    const past = [request({ deadline_block: B - 1 })];
                    assert.strictEqual(util.selectApplicableAttestationResponses([mirror({ admit_block_btc: B })], past, B, T, NETWORK, 'BTC').length, 0);
                    const done = [request({ request_status: 'fulfilled' })];
                    assert.strictEqual(util.selectApplicableAttestationResponses([mirror({ admit_block_btc: B })], done, B, T, NETWORK, 'BTC').length, 0);
                });

                it('above the activation the tie-break still picks the smaller signed effective_time', function () {
                    const items = sel([mirror({ admit_block_btc: B, effective_time: T + 5, response_hash: 'b'.repeat(64) }),
                                       mirror({ admit_block_btc: B, effective_time: T + 1, response_hash: 'c'.repeat(64) })], B, T - 1);
                    assert.strictEqual(items.length, 1);
                    assert.strictEqual(items[0].response.effective_time, T + 1);
                });

                it('the activation is keyed on (coin, network): a coin the map does not know reads inert', function () {
                    // regtest arms every known coin from one env, so the negative case is a
                    // coin the map has no key for, which must read inert rather than armed.
                    assert.strictEqual(sel([mirror({ admit_block_btc: B + 1 })], B, T, 'XYZ').length, 1,
                        'an unknown coin is inert: the clock rule binds and the column is ignored');
                    assert.strictEqual(util.selectApplicableAttestationResponses([mirror({ admit_block_btc: B + 1 })], [request()], B, T, 'mainnet', 'BTC').length, 0,
                        'mainnet is inert at every height in this train, and the mirror-era clause refuses the request there');
                });

                it('a null block index is not height 0: it reads inert, never armed', function () {
                    // Number(null) is 0 and 0 is above an activation armed at 0. The predicate
                    // keys the era on the RAW block index, so null cannot arm it.
                    assert.strictEqual(util.selectApplicableAttestationResponses([mirror({ admit_block_btc: 5 })], [request({ deadline_block: 10 })], null, T - 1, NETWORK, 'BTC').length, 0,
                        'inert at a null height means the clock rule, which T-1 fails');
                });
            }
        });
    }
});

describe('admission binding: the attest-response bind predicate', function () {

    describe('the applier pass threads the block index and the coin into both halves of the read', function () {
        let h;
        before(function () { h = load(null); });
        after(function () { if (h) h.restore(); h = null; });

        it('passes block_index to the mirror read and the coin to the selector', async function () {
            const util = new h.Utility({ COIN: 'BTC', NETWORK: NETWORK });
            const db = {
                config: { COIN: 'BTC', NETWORK: NETWORK },
                getAttestationRequestsAwaitingMirrorResponse: sinon.stub().resolves([request()]),
                getMirroredAttestationResponses: sinon.stub().resolves([mirror()])
            };
            const select = sinon.spy(util, 'selectApplicableAttestationResponses');
            const actions = { processAction: sinon.stub().resolves() };
            await util.processAttestationResponses(actions, db, 100, T);
            assert.deepStrictEqual(db.getMirroredAttestationResponses.firstCall.args, [NETWORK, [REQ_ID], T, 100]);
            assert.strictEqual(select.firstCall.args[2], 100);
            assert.strictEqual(select.firstCall.args[5], 'BTC');
        });

        it('the settle and call passes pass block_index to their reads', async function () {
            const util = new h.Utility({ COIN: 'BTC', NETWORK: NETWORK });
            const db = {
                config: { COIN: 'BTC', NETWORK: NETWORK },
                getEffectiveUnsettledMatches: sinon.stub().resolves([]),
                getEffectiveUndispatchedCalls: sinon.stub().resolves([]),
                getExpiredCrossChainCallRequests: sinon.stub().resolves([]),
                getEffectiveUnprocessedCallResults: sinon.stub().resolves([])
            };
            const actions = { protocolChanges: { isEnabled: async () => true }, processAction: sinon.stub().resolves(),
                              actionXcall: { processResult: sinon.stub().resolves() } };
            await util.processCrossChainSettlements(actions, db, 4242, T);
            assert.strictEqual(db.getEffectiveUnsettledMatches.firstCall.args[3], 4242);
            await util.processCrossChainCalls(actions, db, 4242, T);
            assert.strictEqual(db.getEffectiveUndispatchedCalls.firstCall.args[4], 4242);
            assert.strictEqual(db.getEffectiveUnprocessedCallResults.firstCall.args[4], 4242);
        });
    });
});
