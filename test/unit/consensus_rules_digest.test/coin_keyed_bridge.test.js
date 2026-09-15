/*
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 */

// test/unit/consensus_rules_digest.test/coin_keyed_bridge.test.js
//
// Covers coin-specific bridge activation and the network-wide fallback view.

'use strict';

const { assert, crd } = require('./helpers/consensus_rules_digest.js');

const KEY  = 'xchain_bridge_activation.XCHAIN_BRIDGE_ACTIVATION';
const GATE = require.resolve('../../../src/xchain_bridge_activation.js');
const CRD  = require.resolve('../../../src/consensus_rules_digest.js');

// Re-require the digest over a stubbed activation map. The digest memoizes gate values,
// so its module cache entry must be dropped for the stub to be seen.
function withMap(map, body) {
    const real    = require.cache[GATE];
    const realCrd = require.cache[CRD];
    try {
        const stub = Object.create(Object.getPrototypeOf(real));
        Object.assign(stub, real);
        stub.exports = Object.assign({}, real.exports, { XCHAIN_BRIDGE_ACTIVATION: map });
        require.cache[GATE] = stub;
        delete require.cache[CRD];
        body(require('../../../src/consensus_rules_digest.js'));
    } finally {
        require.cache[GATE] = real;
        require.cache[CRD]  = realCrd;
    }
}

// XCHAIN_BRIDGE_ACTIVATION is the first COIN-KEYED gate in SHARED_GATES: it keys
// '<COIN>:<network>' with the bare network key as fallback, because one testnet height
// cannot serve TBTC, TLTC and TDOGE. That gives activeGatesAt two answers to get right,
// and both are load-bearing. The per-coin answer judges the chain a leg was mined on.
// The network-wide answer (no coin) is what the rules-aware capability filter reads from a
// height alone, and reading the bare network key there would report the gate inactive
// forever, because an arming train sizes one height per chain and leaves the bare fallback
// on the sentinel.
describe('consensus_rules_digest: the coin-keyed bridge gate', function () {
    it('is a shared gate the ROLLCALL GATES field carries, and resolves to a value', function () {
        assert.ok(crd.knownGateKeys().includes(KEY), 'the bridge flag day must be on the wire');
        assert.notStrictEqual(crd.computeConsensusRulesDigest().gates[KEY], crd.ABSENT);
    });

    // As SHIPPED: regtest 0, every other slot on the far-future sentinel.
    it('is active on regtest from block 0 on every coin, and dark on testnet and mainnet', function () {
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            assert.ok(crd.activeGatesAt(0, 'regtest', coin).includes(KEY), 'regtest ' + coin);
            for (const net of ['testnet', 'mainnet']) {
                assert.ok(!crd.activeGatesAt(crd.FAR_FUTURE_HEIGHT_SENTINEL, net, coin).includes(KEY),
                    'an unsized slot must stay dark however high ' + net + ' climbs: ' + coin);
            }
        }
        assert.ok(crd.activeGatesAt(0, 'regtest').includes(KEY), 'and with no coin named');
        assert.ok(!crd.activeGatesAt(crd.FAR_FUTURE_HEIGHT_SENTINEL, 'testnet').includes(KEY));
    });

    // One chain armed, another not: the shape the arming train writes.
    it('reports per coin once a chain is armed, on two coins and at the <= boundary', function () {
        withMap({
            'BTC:testnet':  100,
            'DOGE:testnet': 5000000,
            testnet:        9999999999,
            regtest:        0,
        }, function (fresh) {
            assert.ok(fresh.activeGatesAt(100, 'testnet', 'BTC').includes(KEY),
                'active exactly at its own height (<=, not <)');
            assert.ok(!fresh.activeGatesAt(99, 'testnet', 'BTC').includes(KEY));
            // The same height, the other coin: 150 is far past TBTC and far short of TDOGE.
            assert.ok(fresh.activeGatesAt(150, 'testnet', 'BTC').includes(KEY));
            assert.ok(!fresh.activeGatesAt(150, 'testnet', 'DOGE').includes(KEY),
                'a height from another chain must not arm this one');
            assert.ok(fresh.activeGatesAt(5000000, 'testnet', 'DOGE').includes(KEY));
            // A coin with no key of its own inherits the bare network key, still a sentinel.
            assert.ok(!fresh.activeGatesAt(150, 'testnet', 'LTC').includes(KEY),
                'an unlisted chain inherits the fallback and stays inert');
        });
    });
});

describe('consensus_rules_digest: the coin-keyed bridge gate', function () {
    // The DANGEROUS direction, and the one shape the cases above cannot reach: a coin whose
    // own slot is still the far-future SENTINEL while a sibling chain on the same network has
    // armed. The arming train sizes one dated instant per chain, so this is the live state of
    // the map between two of those sizings, and reporting the gate active for the unarmed
    // chain would drop a validator for failing a rule that chain is not running yet. The
    // finite-height case at 150/DOGE above cannot catch a resolver that treats a sentinel
    // coin slot as "undeclared" and falls through to the network-wide earliest.
    it('keeps a coin inert while its own slot is a sentinel, however early a sibling chain armed', function () {
        withMap({
            'BTC:testnet':  100,
            'DOGE:testnet': 9999999999,
            testnet:        9999999999,
            regtest:        0,
        }, function (fresh) {
            assert.ok(fresh.activeGatesAt(150, 'testnet', 'BTC').includes(KEY),
                'the armed chain still reports active');
            assert.ok(!fresh.activeGatesAt(150, 'testnet', 'DOGE').includes(KEY),
                'a sentinel slot of its own must not inherit a sibling chain height');
            assert.ok(!fresh.activeGatesAt(crd.FAR_FUTURE_HEIGHT_SENTINEL, 'testnet', 'DOGE').includes(KEY),
                'and stays inert however high that chain climbs');
        });
    });

    it('reports the gate to a caller holding only a height and a network, once any chain arms', function () {
        withMap({
            'BTC:testnet':  100,
            'DOGE:testnet': 5000000,
            testnet:        9999999999,
            regtest:        0,
        }, function (fresh) {
            // The bare testnet key is still the sentinel: resolving it alone would hide an
            // armed chain from the capability filter, which reads activeGatesAt(H, network).
            assert.ok(fresh.activeGatesAt(150, 'testnet').includes(KEY),
                'the earliest armed chain must make the gate needed network-wide');
            assert.ok(!fresh.activeGatesAt(99, 'testnet').includes(KEY),
                'and not before any chain has armed');
        });
    });

    it('leaves every network-keyed gate answering the same with a coin named as without', function () {
        for (const net of ['mainnet', 'testnet', 'regtest']) {
            for (const h of [0, 150780, 999999999]) {
                const bare = crd.activeGatesAt(h, net).filter(k => k !== KEY);
                for (const coin of ['BTC', 'LTC', 'DOGE']) {
                    assert.deepStrictEqual(crd.activeGatesAt(h, net, coin).filter(k => k !== KEY), bare,
                        'the coin argument must only move the coin-keyed gate: ' + net + ' ' + h + ' ' + coin);
                }
            }
        }
    });
});
