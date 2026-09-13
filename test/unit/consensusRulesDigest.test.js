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
 * test/unit/consensusRulesDigest.test.js
 *
 * The indexer half of the cross-repo consensus-rules digest. The alarm logic
 * lives on the hub (it is the side that gossips), so this file guards the two
 * things the indexer owns: that its copy resolves every shared gate, and that
 * the digest it publishes on /health is the one a hub would compare against.
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const crd    = require('../../src/consensus_rules_digest.js');

const HUB_COPY = path.resolve(__dirname, '../../../xchain-hub/src/consensus_rules_digest.js');

describe('consensus_rules_digest (indexer copy)', function () {

    it('resolves every shared gate in this repo, none absent', function () {
        const { gates } = crd.computeConsensusRulesDigest();
        const absent = Object.keys(gates).filter(k => gates[k] === crd.ABSENT);
        assert.deepStrictEqual(absent, [], 'unresolved gates: ' + absent.join(', '));
        const expected = crd.SHARED_GATES.reduce((n, g) => n + g[1].length, 0);
        assert.strictEqual(Object.keys(gates).length, expected);
    });

    // The point of a value-based digest rather than a file fingerprint: the hub and
    // the indexer share no source file, so armed_map_fingerprint can never match
    // between them, while this must.
    it('is identical to the hub copy gate for gate', function () {
        if (!fs.existsSync(HUB_COPY)) {
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                assert.fail('xchain-hub sibling checkout missing: ' + HUB_COPY);
            this.skip();
            return;
        }
        const hub = require(HUB_COPY);
        const mine = crd.computeConsensusRulesDigest();
        const theirs = hub.computeConsensusRulesDigest();
        assert.deepStrictEqual(crd.diffGates(mine.gates, theirs.gates), [],
            'gates disagreeing between indexer and hub');
        assert.strictEqual(theirs.digest, mine.digest);
        // And the two SHARED_GATES registries must list the same gates in the same
        // order: the order is part of the preimage, so a reordered copy would digest
        // differently even with every value equal.
        assert.deepStrictEqual(hub.SHARED_GATES, crd.SHARED_GATES);
    });

    it('publishes the digest on the health payload beside the file fingerprint', function () {
        const src = fs.readFileSync(path.resolve(__dirname, '../../src/health.js'), 'utf8');
        assert.ok(/consensus_rules_digest:\s*computeConsensusRulesDigest\(\)\.digest/.test(src),
            'health.js must publish consensus_rules_digest');
        assert.ok(/armed_map_fingerprint:/.test(src),
            'the file fingerprint must stay: the two answer different questions');
    });

    it('changes when a height changes and not when prose does', function () {
        const a = crd.canonical({ mainnet: null, testnet: 151200, regtest: 0 });
        const b = crd.canonical({ regtest: 0, testnet: 151200, mainnet: null });
        assert.strictEqual(a, b, 'key order must not matter');
        assert.notStrictEqual(a, crd.canonical({ mainnet: null, testnet: 151201, regtest: 0 }));
    });
});

// The zero-confirmation flip's three appended SHARED_GATES rows (§8), plus the two
// helpers a ROLLCALL v1 publisher and the rules-aware capability set filter both read.
// The hub copy carries the load-bearing knownGateKeys()/activeGatesAt() cases; this is
// the indexer's own instance of the same guard, so a one-sided edit here cannot pass by
// running only on the other repo.
describe('consensus_rules_digest: knownGateKeys() and activeGatesAt() (D88)', function () {

    it('is sorted, has 20 entries, and contains the three gates this train appends', function () {
        const keys = crd.knownGateKeys();
        assert.strictEqual(keys.length, 20, 'SHARED_GATES total entry count moved; re-derive this floor before changing it');
        assert.deepStrictEqual(keys, [...keys].sort());
        for (const k of [
            'attest_zero_conf_activation.ATTEST_ZERO_CONF_ACTIVATION',
            'attest_responsible_widening_activation.ATTEST_RESPONSIBLE_WIDENING_V2',
            'rollcall_gates_activation.ROLLCALL_GATES_ACTIVATION'
        ]) assert.ok(keys.includes(k), 'missing ' + k);
    });

    // The 2026-09-09 genesis-arm ruling left no SHIPPED gate on the far-future sentinel,
    // so the exclusion branch is driven against a stubbed gate module instead of riding
    // whichever map happened to be unarmed. PRICE_PAIR_WIDEN_ACTIVATION, the last live
    // example before the arm, is the map stubbed here.
    it('excludes a far-future sentinel height, however high the chain climbs', function () {
        const GATE  = require.resolve('../../src/price_pair_activation.js');
        const CRD   = require.resolve('../../src/consensus_rules_digest.js');
        const real  = require.cache[GATE];
        const realCrd = require.cache[CRD];
        try {
            const stub = Object.create(Object.getPrototypeOf(real));
            Object.assign(stub, real);
            stub.exports = Object.assign({}, real.exports, {
                PRICE_PAIR_WIDEN_ACTIVATION: { mainnet: crd.FAR_FUTURE_HEIGHT_SENTINEL, testnet: 0, regtest: 0 },
            });
            require.cache[GATE] = stub;
            delete require.cache[CRD];                       // clears the module-level value cache
            const fresh = require('../../src/consensus_rules_digest.js');
            const at = fresh.activeGatesAt(fresh.FAR_FUTURE_HEIGHT_SENTINEL, 'mainnet');
            assert.ok(!at.includes('price_pair_activation.PRICE_PAIR_WIDEN_ACTIVATION'),
                'a sentinel height must read as inactive even at the sentinel itself');
            assert.ok(fresh.activeGatesAt(0, 'testnet').includes('price_pair_activation.PRICE_PAIR_WIDEN_ACTIVATION'),
                'the same stub is active on testnet, so the exclusion is the sentinel and not the stub');
        } finally {
            require.cache[GATE] = real;
            require.cache[CRD]  = realCrd;
        }
    });

    it('includes the gates this wave armed at genesis on mainnet, from block 0', function () {
        // The 2026-09-09 ruling: identity on the indexed mainnet history.
        for (const k of [
            'price_pair_activation.PRICE_PAIR_WIDEN_ACTIVATION',
            'snapshot_reorg_buffer.SNAPSHOT_BURIAL_ACTIVATION',
        ]) assert.ok(crd.activeGatesAt(0, 'mainnet').includes(k), k + ' must be active at mainnet block 0');
    });

    it('excludes a null (unratified) entry at any height', function () {
        for (const h of [0, 1000000, crd.FAR_FUTURE_HEIGHT_SENTINEL - 1]) {
            assert.ok(!crd.activeGatesAt(h, 'mainnet').includes('attest_zero_conf_activation.ATTEST_ZERO_CONF_ACTIVATION'));
        }
    });

    it('excludes non-map exports (frozen ladder constants), never active in this sense', function () {
        for (const h of [0, 150780, 999999999]) {
            for (const net of ['mainnet', 'testnet', 'regtest']) {
                const at = crd.activeGatesAt(h, net);
                assert.ok(!at.includes('attest_responsible_widening_activation.ATTEST_RESPONSIBLE_WIDENING'));
                assert.ok(!at.includes('attest_responsible_widening_activation.ATTEST_RESPONSIBLE_WIDENING_V2'));
            }
        }
    });

    it('includes a gate exactly at its own activation height (<=, not <)', function () {
        assert.ok(crd.activeGatesAt(0, 'regtest').includes('attest_zero_conf_activation.ATTEST_ZERO_CONF_ACTIVATION'));
    });

    it('returns [] for a non-finite height', function () {
        assert.deepStrictEqual(crd.activeGatesAt(NaN, 'regtest'), []);
        assert.deepStrictEqual(crd.activeGatesAt(undefined, 'regtest'), []);
        assert.deepStrictEqual(crd.activeGatesAt(Infinity, 'regtest'), []);
    });
});

// XCHAIN_BRIDGE_ACTIVATION is the first COIN-KEYED gate in SHARED_GATES: it keys
// '<COIN>:<network>' with the bare network key as fallback, because one testnet height
// cannot serve TBTC, TLTC and TDOGE. That gives activeGatesAt two answers to get right,
// and both are load-bearing. The per-coin answer judges the chain a leg was mined on.
// The network-wide answer (no coin) is what the rules-aware capability filter reads from a
// height alone, and reading the bare network key there would report the gate inactive
// forever, because an arming train sizes one height per chain and leaves the bare fallback
// on the sentinel.
describe('consensus_rules_digest: the coin-keyed bridge gate', function () {

    const KEY  = 'xchain_bridge_activation.XCHAIN_BRIDGE_ACTIVATION';
    const GATE = require.resolve('../../src/xchain_bridge_activation.js');
    const CRD  = require.resolve('../../src/consensus_rules_digest.js');

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
            body(require('../../src/consensus_rules_digest.js'));
        } finally {
            require.cache[GATE] = real;
            require.cache[CRD]  = realCrd;
        }
    }

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
