/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/xchainBridgeActivationCoinKeys.test.js
 *
 * The XCHAIN bridge flag day is keyed '<COIN>:<network>' (spec section 14, row 28), not one
 * height per network. The bridge arms on three chains whose tips differ by orders of
 * magnitude (TBTC about 152,110, TLTC about 4,884,193, TDOGE about 67,889,993 measured
 * 2026-09-12), so a single testnet number is already passed on two of them at boot and
 * unreachable on the third: a network-keyed gate would open the bridge on LTC and DOGE
 * before the fleet ever deployed it, and never open it on BTC.
 *
 * WHAT THIS PINS THAT THE PARITY SUITE CANNOT. activationConstantsParity.test.js compares
 * the map to the canon and pins TOKEN >= XCHAIN; both of those still pass against a
 * predicate that takes the coin and ignores it. This file drives the predicate itself, so
 * the RESOLUTION (coin key wins, bare network key is the fallback) is asserted on behaviour,
 * with each coin's answer differing from the others at the same height, which is the only
 * shape a coin-blind lookup cannot fake.
 *
 * The live map parks every mainnet and testnet key on the same sentinel, so a case that only
 * read the shipped values could not tell a coin-keyed lookup from a coin-blind one: every
 * coin answers false. The resolution case therefore writes four DIFFERENT heights into the
 * shipped map's testnet slots for the length of the case, drives the real predicate against
 * them, and restores the sentinels in a finally (the restore is itself asserted, so a case
 * that threw mid-way cannot leave a live flag day mutated for the rest of the run). No
 * copy of the predicate is reimplemented here: a test that resolved the key itself would
 * pass against a module that had stopped doing so.
 ********************************************************************/

'use strict';

const assert = require('assert');
const path   = require('path');

const MODULE_PATH = path.resolve(__dirname, '../../src/xchain_bridge_activation.js');
const { XCHAIN_BRIDGE_ACTIVATION, isXchainBridgeActive } = require(MODULE_PATH);

const SENTINEL = 9999999999;
const COINS    = ['BTC', 'LTC', 'DOGE'];

describe('XCHAIN_BRIDGE_ACTIVATION coin-keyed flag day @regression', function () {

    describe('the shipped map', function () {

        it('declares a slot per coin for mainnet and for testnet, plus the bare fallback', function () {
            for (const net of ['mainnet', 'testnet']) {
                assert.ok(Object.prototype.hasOwnProperty.call(XCHAIN_BRIDGE_ACTIVATION, net),
                    'the bare ' + net + ' fallback is what an unlisted coin inherits; without it such a ' +
                    'chain resolves to undefined and the gate is undecided rather than inert');
                for (const coin of COINS)
                    assert.ok(Object.prototype.hasOwnProperty.call(XCHAIN_BRIDGE_ACTIVATION, coin + ':' + net),
                        coin + ':' + net + ' has no slot; the arming train has nowhere to write that ' +
                        'chain\'s instant and it would silently inherit another chain\'s height');
            }
        });

        it('parks every mainnet and testnet slot on the sentinel and keeps regtest genesis-active', function () {
            // Nothing in this row sizes a height. Mainnet waits on the D2 checkpoint
            // cross-check, testnet on the arming train, and regtest stays 0 so the e2e rail
            // exercises the armed rule from genesis and no regtest replay hash moves.
            for (const net of ['mainnet', 'testnet']) {
                assert.strictEqual(XCHAIN_BRIDGE_ACTIVATION[net], SENTINEL, net + ' fallback is not the sentinel');
                for (const coin of COINS)
                    assert.strictEqual(XCHAIN_BRIDGE_ACTIVATION[coin + ':' + net], SENTINEL,
                        coin + ':' + net + ' carries a height; sizing one is the arming train\'s act, not a build\'s');
            }
            assert.strictEqual(XCHAIN_BRIDGE_ACTIVATION.regtest, 0);
            for (const coin of COINS)
                assert.strictEqual(XCHAIN_BRIDGE_ACTIVATION[coin + ':regtest'], undefined,
                    'regtest is deliberately bare: one regtest number fits every chain');
        });
    });

    describe('resolution', function () {

        // The shipped map answers differently per network at one height, which is the
        // coarsest proof the lookup reads the key at all.
        it('reads the coin-keyed slot rather than the bare network key when both exist', function () {
            // A local map in the same shape, driven through the module's own resolver by
            // swapping the values the predicate reads. Each coin gets a DIFFERENT height and
            // the bare key a fourth, so a lookup that ignored the coin, or that always took
            // the bare key, would answer wrong for at least two of the four cases below.
            const saved = {};
            const local = { 'BTC:testnet': 100, 'LTC:testnet': 200, 'DOGE:testnet': 300, testnet: 400 };
            for (const k of Object.keys(local)) {
                saved[k] = XCHAIN_BRIDGE_ACTIVATION[k];
                XCHAIN_BRIDGE_ACTIVATION[k] = local[k];
            }
            try {
                assert.strictEqual(isXchainBridgeActive(100, 'testnet', 'BTC'), true,  'BTC at its own height');
                assert.strictEqual(isXchainBridgeActive(100, 'testnet', 'LTC'), false, 'LTC must not ride BTC\'s height');
                assert.strictEqual(isXchainBridgeActive(100, 'testnet', 'DOGE'), false, 'DOGE must not ride BTC\'s height');
                assert.strictEqual(isXchainBridgeActive(200, 'testnet', 'LTC'), true,  'LTC at its own height');
                assert.strictEqual(isXchainBridgeActive(300, 'testnet', 'DOGE'), true, 'DOGE at its own height');
                assert.strictEqual(isXchainBridgeActive(299, 'testnet', 'DOGE'), false, 'one block below is below');
                // A coin the map does not list falls back to the bare network key, not to
                // another coin's slot.
                assert.strictEqual(isXchainBridgeActive(300, 'testnet', 'BCH'), false, 'unlisted coin took a coin slot');
                assert.strictEqual(isXchainBridgeActive(400, 'testnet', 'BCH'), true,  'unlisted coin must use the fallback');
                // No coin at all is the same fallback, which is what keeps a caller that has
                // not been taught the coin from silently reading BTC's height.
                assert.strictEqual(isXchainBridgeActive(399, 'testnet', null), false);
                assert.strictEqual(isXchainBridgeActive(400, 'testnet', null), true);
            } finally {
                for (const k of Object.keys(saved)) XCHAIN_BRIDGE_ACTIVATION[k] = saved[k];
            }
            for (const k of Object.keys(local))
                assert.strictEqual(XCHAIN_BRIDGE_ACTIVATION[k], SENTINEL, 'the shipped map was not restored');
        });

        it('is armed at every regtest height for every coin, through the bare key', function () {
            for (const coin of COINS.concat([null, undefined, 'BCH'])) {
                assert.strictEqual(isXchainBridgeActive(0, 'regtest', coin), true, 'regtest genesis, coin ' + coin);
                assert.strictEqual(isXchainBridgeActive(1000000, 'regtest', coin), true, 'regtest tip, coin ' + coin);
            }
        });

        it('is dark on mainnet and testnet for every coin at any plausible height', function () {
            for (const net of ['mainnet', 'testnet'])
                for (const coin of COINS.concat([null, 'BCH']))
                    for (const block of [0, 152110, 4884193, 67889993, SENTINEL - 1])
                        assert.strictEqual(isXchainBridgeActive(block, net, coin), false,
                            net + ' ' + coin + ' at ' + block + ' is armed; no pre-activation verdict may move');
        });
    });

    describe('fail-closed', function () {

        it('refuses an unknown network whatever the coin', function () {
            assert.strictEqual(isXchainBridgeActive(0, 'devnet', 'BTC'), false);
            assert.strictEqual(isXchainBridgeActive(0, 'devnet', null), false);
            assert.strictEqual(isXchainBridgeActive(0, undefined, 'BTC'), false);
        });

        it('refuses an unusable height rather than admitting the action', function () {
            for (const bad of [null, undefined, '', 'abc', NaN, {}])
                assert.strictEqual(isXchainBridgeActive(bad, 'regtest', 'BTC'), false,
                    'height ' + JSON.stringify(bad) + ' was admitted on a genesis-armed network');
        });

        it('reads an inert null slot as off, never as height zero', function () {
            // `b >= null` coerces to `b >= 0`, so a sentinel written as null would arm the
            // gate on every block of an unratified chain if the null test were dropped.
            const saved = XCHAIN_BRIDGE_ACTIVATION['BTC:testnet'];
            XCHAIN_BRIDGE_ACTIVATION['BTC:testnet'] = null;
            try {
                assert.strictEqual(isXchainBridgeActive(0, 'testnet', 'BTC'), false);
                assert.strictEqual(isXchainBridgeActive(152110, 'testnet', 'BTC'), false);
            } finally {
                XCHAIN_BRIDGE_ACTIVATION['BTC:testnet'] = saved;
            }
            assert.strictEqual(XCHAIN_BRIDGE_ACTIVATION['BTC:testnet'], SENTINEL);
        });
    });
});
